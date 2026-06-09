// tests/helpers/server.js
// Spins up MockCloud's AWS handler on an ephemeral port for tests.
// No UI server, no Docker probe, no banner — just the AWS dispatch layer.

// test-env MUST be first — it sets MOCKCLOUD_S3_ROOT / MOCKCLOUD_DYNAMODB_ROOT
// before the service modules below capture them at load time.
import { TEST_S3_ROOT, TEST_DDB_ROOT } from './test-env.js';
import http from 'http';
import { mkdirSync, rmSync } from 'fs';
import { store } from '../../src/store.js';
import { Router } from '../../src/router.js';
import { dispatchAWS } from '../../src/dispatcher.js';
import { registerAllRoutes } from '../../src/routes/index.js';
import { sendInternalError } from '../../src/middleware/response.js';
import { sigv4Enabled, verifySigV4, sendSigV4Error } from '../../src/middleware/sigv4.js';
import { iamMode, enforceIam, sendIamError } from '../../src/iam/policy-eval.js';
import { startBackground, stopBackground } from '../../src/lifecycle.js';

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// Isolated storage roots (set in test-env.js) — create them up front.
mkdirSync(TEST_S3_ROOT, { recursive: true });
mkdirSync(TEST_DDB_ROOT, { recursive: true });

export async function startServer() {
  const apiRouter = new Router();
  registerAllRoutes(apiRouter);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Amz-Target, X-Amz-Date, X-Amz-Security-Token, X-Amz-Content-Sha256, X-Api-Key, X-Amz-User-Agent');
    // Match the daemon: only short-circuit OPTIONS for the UI control plane so
    // S3 CORS preflight (OPTIONS to a bucket) reaches the S3 handler.
    if (req.method === 'OPTIONS' && req.url.startsWith('/mockcloud')) { res.writeHead(204); res.end(); return; }

    req.rawBuffer = await readBody(req);
    req.rawBody = req.rawBuffer.toString();
    req.parsedBody = (() => { try { return JSON.parse(req.rawBody); } catch { return {}; } })();

    try {
      const matched = await apiRouter.dispatch(req, res);
      if (!matched) {
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

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  startBackground();
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}`;

  return {
    endpoint,
    port,
    resetStore() {
      store.reset();
      // Wipe the test S3 + DynamoDB disk dirs so hydration sees a clean slate
      try { rmSync(TEST_S3_ROOT, { recursive: true, force: true }); } catch {}
      try { rmSync(TEST_DDB_ROOT, { recursive: true, force: true }); } catch {}
      mkdirSync(TEST_S3_ROOT, { recursive: true });
      mkdirSync(TEST_DDB_ROOT, { recursive: true });
    },
    close() { stopBackground(); return new Promise(resolve => server.close(resolve)); },
  };
}
