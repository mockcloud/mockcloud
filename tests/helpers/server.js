// tests/helpers/server.js
// Spins up MockCloud's AWS handler on an ephemeral port for tests.
// No UI server, no Docker probe, no banner — just the AWS dispatch layer.
//
// Imports CORS + body parsing from src/middleware/http.js so tests run the
// same code path as production. Duplicating that logic here previously meant
// tests could pass while the production gate had a bug.

import http from 'http';
import os from 'os';
import path from 'path';
import { mkdirSync, rmSync } from 'fs';
import { store } from '../../src/store.js';
import { Router } from '../../src/router.js';
import { dispatchAWS } from '../../src/dispatcher.js';
import { registerAllRoutes } from '../../src/routes/index.js';
import { applyCors, attachBody } from '../../src/middleware/http.js';

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
    if (!applyCors(req, res)) return;
    await attachBody(req);

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
