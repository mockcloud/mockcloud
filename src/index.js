// src/index.js — MockCloud daemon entry point
import http from 'http';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { Router } from './router.js';
import { dispatchAWS } from './dispatcher.js';
import { registerAllRoutes } from './routes/index.js';
import { sendInternalError } from './middleware/response.js';
import { sigv4Enabled, verifySigV4, sendSigV4Error } from './middleware/sigv4.js';
import { iamMode, enforceIam, sendIamError } from './iam/policy-eval.js';
import { startBackground, stopBackground } from './lifecycle.js';
import { VERSION } from './version.js';
import { applyCors, attachBody, safeJoin } from './middleware/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Re-exported for callers that historically imported VERSION from this module.
// New code should `import { VERSION } from './version.js'` to avoid pulling
// the entire HTTP daemon into the import graph (this module starts servers
// at module-load time, which is fatal for tests).
export { VERSION };

const PORT = parseInt(process.env.PORT || '4566');
const UI_PORT = parseInt(process.env.UI_PORT || '4567');
const HOST = process.env.HOST || '127.0.0.1';
// Headless mode: skip the dashboard server (CI / API-only callers don't need it).
const UI_ENABLED = !['true', '1', 'yes'].includes((process.env.MOCKCLOUD_DISABLE_UI || '').toLowerCase());

// ── Internal UI router ─────────────────────────────────────────────────────
const apiRouter = new Router();
registerAllRoutes(apiRouter);

// ── AWS API server (port 4566) ─────────────────────────────────────────────
// CORS, body parsing, and the cross-origin gate all live in the shared
// middleware/http.js so tests/helpers/server.js can use the exact same path.
const awsServer = http.createServer(async (req, res) => {
  // Shared CORS + cross-origin gate + body parsing (middleware/http.js).
  if (!applyCors(req, res)) return;
  await attachBody(req);

  // Try internal UI routes first, then AWS dispatch. A top-level boundary turns
  // any unhandled handler error into a proper AWS error shape instead of a hung
  // socket (which breaks SDK retry/timeout behaviour).
  try {
    const matched = await apiRouter.dispatch(req, res);
    if (!matched) {
      // Opt-in SigV4 verification (off by default). /mockcloud routes are
      // internal and exempt — they're handled by the router above.
      if (sigv4Enabled()) {
        const authErr = verifySigV4(req);
        if (authErr) return sendSigV4Error(req, res, authErr);
      }
      if (iamMode() !== 'off') {
        const iamErr = enforceIam(req);
        if (iamErr) return sendIamError(req, res, iamErr);
      }
      await dispatchAWS(req, res);
    }
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// ── UI server (port 4567) ──────────────────────────────────────────────────
const uiDistDir = path.resolve(__dirname, '../ui/dist');
const uiServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  // Containment via safeJoin: the old startsWith check ran on an un-normalised
  // path, so a request like `/../etc/passwd` could escape uiDistDir on Windows
  // because path.join collapses .. before the check ran. safeJoin resolves
  // both sides first and rejects via throw.
  let filePath;
  try {
    filePath = url.pathname === '/' ? path.join(uiDistDir, 'index.html')
                                    : safeJoin(uiDistDir, url.pathname.replace(/^\/+/, ''));
  } catch {
    filePath = path.join(uiDistDir, 'index.html');
  }
  if (!existsSync(filePath)) filePath = path.join(uiDistDir, 'index.html');

  try {
    const ext = path.extname(filePath);
    const mime = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.png': 'image/png',
      '.json': 'application/json',
      '.woff2': 'font/woff2',
    };
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(content);
  } catch { if (!res.headersSent) { res.writeHead(404); res.end('Not found'); } }
});

// ── Start ──────────────────────────────────────────────────────────────────
awsServer.listen(PORT, HOST, () => {
  // PORT=0 asks the OS for a free port — report the one actually bound.
  const boundPort = awsServer.address().port;
  console.log(`\n  ╭─────────────────────────────────────────────────╮`);
  console.log(`  │   ☁  MockCloud  v${VERSION.padEnd(30)}│`);
  console.log(`  │   AWS API  →  http://${HOST}:${boundPort}             │`);
  if (UI_ENABLED) console.log(`  │   Console  →  http://${HOST}:${UI_PORT}             │`);
  console.log(`  │   github.com/mockcloud/mockcloud                │`);
  console.log(`  ╰─────────────────────────────────────────────────╯\n`);
  // Machine-readable readiness line — the test harness (and any supervisor)
  // waits for this to learn the ephemeral port. Keep the format stable.
  console.log(`MOCKCLOUD_READY endpoint=http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${boundPort}`);
});

if (UI_ENABLED) uiServer.listen(UI_PORT, HOST);

// Background pollers / schedulers (SQS→Lambda, EventBridge schedules, …).
startBackground();

process.on('SIGTERM', () => { stopBackground(); awsServer.close(); if (UI_ENABLED) uiServer.close(); process.exit(0); });
process.on('SIGINT',  () => { stopBackground(); awsServer.close(); if (UI_ENABLED) uiServer.close(); process.exit(0); });

// Orphan protection for supervised runs (the test harness spawns one server
// per test file): when the parent's pipe closes, exit instead of lingering.
// Opt-in — a terminal user Ctrl+D'ing stdin must not kill the daemon.
if (process.env.MOCKCLOUD_EXIT_ON_STDIN_CLOSE === '1') {
  process.stdin.resume();
  process.stdin.on('end',   () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
}

// Belt-and-braces: log async throws / unhandled rejections from request
// handling but don't let them terminate the daemon. The router already wraps
// the known synchronous decode path; this catches anything new that surfaces.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
