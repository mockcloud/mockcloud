// tests/helpers/server.js
// Spins up MockCloud's AWS handler on an ephemeral port for tests.
// No UI server, no Docker probe, no banner — just the AWS dispatch layer.
//
// Imports CORS + body parsing from src/middleware/http.js so tests run the
// same code path as production. Duplicating that logic here previously meant
// tests could pass while the production gate had a bug.

// test-env MUST be first — it sets MOCKCLOUD_S3_ROOT / MOCKCLOUD_DYNAMODB_ROOT
// before the service modules below capture them at load time.
import { TEST_S3_ROOT, TEST_DDB_ROOT } from './test-env.js';
import http from 'http';
import { mkdirSync, rmSync } from 'fs';
import { store } from '../../src/store.js';
import { wipeDisk } from '../../src/services/dynamodb/persistence.js';
import { Router } from '../../src/router.js';
import { dispatchAWS } from '../../src/dispatcher.js';
import { registerAllRoutes } from '../../src/routes/index.js';
import { sendInternalError } from '../../src/middleware/response.js';
import { applyCors, attachBody } from '../../src/middleware/http.js';
import { sigv4Enabled, verifySigV4, sendSigV4Error } from '../../src/middleware/sigv4.js';
import { iamMode, enforceIam, sendIamError } from '../../src/iam/policy-eval.js';
import { startBackground, stopBackground } from '../../src/lifecycle.js';

// Isolated storage roots (set in test-env.js) — create them up front.
mkdirSync(TEST_S3_ROOT, { recursive: true });
mkdirSync(TEST_DDB_ROOT, { recursive: true });

export async function startServer() {
  const apiRouter = new Router();
  registerAllRoutes(apiRouter);

  const server = http.createServer(async (req, res) => {
    // Shared CORS + cross-origin gate + body parsing (same path as production).
    if (!applyCors(req, res)) return;
    await attachBody(req);

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
      // wipeDisk targets the TEST_DDB_ROOT snapshot (test-env sets the env var
      // before persistence.js captures it) and ALSO clears the pending debounce
      // timer and the hydrate guard — the manual rmSync below can't do those.
      wipeDisk();
      // Wipe the test S3 + DynamoDB disk dirs so hydration sees a clean slate
      try { rmSync(TEST_S3_ROOT, { recursive: true, force: true }); } catch {}
      try { rmSync(TEST_DDB_ROOT, { recursive: true, force: true }); } catch {}
      mkdirSync(TEST_S3_ROOT, { recursive: true });
      mkdirSync(TEST_DDB_ROOT, { recursive: true });
    },
    close() { stopBackground(); return new Promise(resolve => server.close(resolve)); },
  };
}
