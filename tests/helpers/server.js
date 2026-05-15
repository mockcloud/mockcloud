// tests/helpers/server.js
// Spins up MockCloud's AWS handler on an ephemeral port for tests.
// No UI server, no Docker probe, no banner — just the AWS dispatch layer.

import http from 'http';
import os from 'os';
import path from 'path';
import { mkdirSync, rmSync } from 'fs';
import { store } from '../../src/store.js';
import { Router } from '../../src/router.js';
import { dispatchAWS } from '../../src/dispatcher.js';
import { registerAllRoutes } from '../../src/routes/index.js';

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// Give tests their own isolated S3 root so disk hydration doesn't bleed between runs
const TEST_S3_ROOT = path.join(os.tmpdir(), `mockcloud-test-${process.pid}`);
process.env.MOCKCLOUD_S3_ROOT = TEST_S3_ROOT;
mkdirSync(TEST_S3_ROOT, { recursive: true });

export async function startServer() {
  // Force EC2 to lite/simulated mode — no Docker dependency in tests
  store.ec2.mode = 'lite';

  const apiRouter = new Router();
  registerAllRoutes(apiRouter);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Amz-Target, X-Amz-Date, X-Amz-Security-Token, X-Amz-Content-Sha256, X-Api-Key, X-Amz-User-Agent');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    req.rawBuffer = await readBody(req);
    req.rawBody = req.rawBuffer.toString();
    req.parsedBody = (() => { try { return JSON.parse(req.rawBody); } catch { return {}; } })();

    const matched = await apiRouter.dispatch(req, res);
    if (!matched) await dispatchAWS(req, res);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}`;

  return {
    endpoint,
    port,
    resetStore() {
      store.reset();
      store.ec2.mode = 'lite';
      // Wipe the test S3 disk dir so hydration sees a clean slate
      try { rmSync(TEST_S3_ROOT, { recursive: true, force: true }); } catch {}
      mkdirSync(TEST_S3_ROOT, { recursive: true });
    },
    close() { return new Promise(resolve => server.close(resolve)); },
  };
}
