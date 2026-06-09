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

// ── Body reader ────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ── Internal UI router ─────────────────────────────────────────────────────
const apiRouter = new Router();
registerAllRoutes(apiRouter);

// ── AWS API server (port 4566) ─────────────────────────────────────────────
const awsServer = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Amz-Target, X-Amz-Date, X-Amz-Security-Token, X-Amz-Content-Sha256, X-Api-Key, X-Amz-User-Agent');
  res.setHeader('Access-Control-Expose-Headers', 'ETag, x-amz-request-id, x-amz-id-2, x-amz-version-id');
  // Short-circuit OPTIONS only for the UI control plane; S3 CORS preflight
  // (OPTIONS to a bucket/object) falls through to the S3 handler below.
  if (req.method === 'OPTIONS' && req.url.startsWith('/mockcloud')) { res.writeHead(204); res.end(); return; }

  // Parse body once — handlers read req.rawBody (string) / req.rawBuffer (Buffer) / req.parsedBody (JSON)
  req.rawBuffer = await readBody(req);
  req.rawBody = req.rawBuffer.toString();
  req.parsedBody = (() => { try { return JSON.parse(req.rawBody); } catch { return {}; } })();

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
  let filePath = path.join(uiDistDir, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!existsSync(filePath) || !filePath.startsWith(uiDistDir))
    filePath = path.join(uiDistDir, 'index.html');

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
  console.log(`\n  ╭─────────────────────────────────────────────────╮`);
  console.log(`  │   ☁  MockCloud  v${VERSION.padEnd(30)}│`);
  console.log(`  │   AWS API  →  http://${HOST}:${PORT}             │`);
  if (UI_ENABLED) console.log(`  │   Console  →  http://${HOST}:${UI_PORT}             │`);
  console.log(`  │   github.com/mockcloud/mockcloud                │`);
  console.log(`  ╰─────────────────────────────────────────────────╯\n`);
});

if (UI_ENABLED) uiServer.listen(UI_PORT, HOST);

// Background pollers / schedulers (SQS→Lambda, EventBridge schedules, …).
startBackground();

process.on('SIGTERM', () => { stopBackground(); awsServer.close(); if (UI_ENABLED) uiServer.close(); process.exit(0); });
process.on('SIGINT',  () => { stopBackground(); awsServer.close(); if (UI_ENABLED) uiServer.close(); process.exit(0); });
