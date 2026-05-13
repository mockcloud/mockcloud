// src/index.js — MockCloud daemon entry point
import http from 'http';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { store } from './store.js';
import { Router } from './router.js';
import { dispatchAWS } from './dispatcher.js';
import { registerAllRoutes } from './routes/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read version from package.json so banner / /health / Topbar stay in sync
const PKG = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
export const VERSION = PKG.version;

const PORT = parseInt(process.env.PORT || '4566');
const UI_PORT = parseInt(process.env.UI_PORT || '4567');
const HOST = process.env.HOST || '127.0.0.1';

// Parse --ec2=lite|vmm CLI flag  (node src/index.js --ec2=lite)
// Parse --ec2=simulated|docker (primary) or --ec2=lite|vmm (legacy aliases).
// Final mode is decided after the daemon starts so we can ping Docker; see
// the resolveEc2Mode call in the awsServer.listen callback below.
const ec2Flag = (process.argv.find(a => a.startsWith('--ec2=')) || '').split('=')[1];
const EC2_FLAG_MAP = {
  simulated: 'lite',
  docker: 'vmm',
  lite: 'lite',
  vmm: 'vmm',
};
const ec2Requested = ec2Flag ? EC2_FLAG_MAP[ec2Flag.toLowerCase()] : null;
if (ec2Flag && !ec2Requested) {
  console.error(`\n  ✗ Unknown --ec2 value: "${ec2Flag}". Use simulated|docker (or legacy lite|vmm).\n`);
  process.exit(1);
}

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
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Parse body once — handlers read req.rawBody (string) / req.rawBuffer (Buffer) / req.parsedBody (JSON)
  req.rawBuffer = await readBody(req);
  req.rawBody = req.rawBuffer.toString();
  req.parsedBody = (() => { try { return JSON.parse(req.rawBody); } catch { return {}; } })();

  // Try internal UI routes first, then AWS dispatch
  const matched = await apiRouter.dispatch(req, res);
  if (!matched) await dispatchAWS(req, res);
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
awsServer.listen(PORT, HOST, async () => {
  console.log(`\n  ╭─────────────────────────────────────────────────╮`);
  console.log(`  │   ☁  MockCloud  v${VERSION.padEnd(30)}│`);
  console.log(`  │   AWS API  →  http://${HOST}:${PORT}             │`);
  console.log(`  │   Console  →  http://${HOST}:${UI_PORT}             │`);
  console.log(`  │   github.com/mockcloud/mockcloud                │`);
  console.log(`  ╰─────────────────────────────────────────────────╯\n`);

  // Resolve EC2 execution mode now that we can ping Docker.
  // Rules:
  //   - explicit --ec2=docker  → require Docker, hard-fail with hint if down
  //   - explicit --ec2=simulated → use simulated, skip Docker check entirely
  //   - no flag                → auto-detect: docker if up, else simulated
  const { pingDocker } = await import('./services/docker-health.js');

  if (ec2Requested === 'lite') {
    store.ec2.mode = 'lite';
    console.log(`  EC2 mode: simulated (--ec2=simulated)\n`);
  } else if (ec2Requested === 'vmm') {
    const probe = await pingDocker({ force: true });
    if (!probe.ok) {
      console.error(`  ✗ --ec2=docker requested but Docker daemon is not reachable.`);
      console.error(`    ${probe.hint}`);
      if (probe.reason) console.error(`    (${probe.reason})`);
      process.exit(1);
    }
    store.ec2.mode = 'vmm';
    console.log(`  EC2 mode: docker (--ec2=docker, daemon reachable)\n`);
  } else {
    const probe = await pingDocker({ force: true });
    if (probe.ok) {
      store.ec2.mode = 'vmm';
      console.log(`  EC2 mode: docker (auto-detected; Docker daemon is up)\n`);
    } else {
      store.ec2.mode = 'lite';
      console.log(`  EC2 mode: simulated (Docker not detected — pass --ec2=docker to force)\n`);
    }
  }

  // Reconcile any Docker EC2 containers that survived a restart.
  // Only meaningful in vmm mode; harmless in lite mode (just no-ops).
  if (store.ec2.mode === 'vmm') {
    try {
      const { reconcileDockerInstances } = await import('./services/docker.js');
      await reconcileDockerInstances(store);
    } catch { }
  }
});

uiServer.listen(UI_PORT, HOST);

process.on('SIGTERM', () => { awsServer.close(); uiServer.close(); process.exit(0); });
process.on('SIGINT', () => { awsServer.close(); uiServer.close(); process.exit(0); });