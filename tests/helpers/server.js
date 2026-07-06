// tests/helpers/server.js
// Starts a MockCloud server for a test file and returns
//   { endpoint, port, resetStore(), close() }
// in one of three modes:
//
//   in-process (default)          — boots the AWS handler on an ephemeral port
//                                   inside this process. Fast; used by `npm test`.
//   spawn      (MOCKCLOUD_SERVER_CMD) — spawns ONE SERVER PER TEST FILE as a child
//                                   process and talks to it over HTTP only. This is
//                                   the conformance mode: the command can be
//                                   `node src/index.js` or a Go binary. The child
//                                   inherits process.env, so per-file flags set at
//                                   module top (MOCKCLOUD_VERIFY_SIGV4, MOCKCLOUD_IAM,
//                                   …) and the pid-keyed test roots flow in for free.
//   attach     (MOCKCLOUD_TEST_ENDPOINT) — debug only: use an already-running server.
//                                   Single-file runs only; parallel files would
//                                   reset each other's state.
//
// test-env MUST be first — it sets MOCKCLOUD_S3_ROOT / MOCKCLOUD_DYNAMODB_ROOT
// (and MOCKCLOUD_TEST_ENDPOINTS) before any src module captures them at load time.
import { TEST_S3_ROOT, TEST_DDB_ROOT } from './test-env.js';
import http from 'http';
import { spawn } from 'child_process';
import { mkdirSync, rmSync } from 'fs';

const READY_TIMEOUT_MS = 15_000;

export async function startServer() {
  if (process.env.MOCKCLOUD_SERVER_CMD) return startSpawned(process.env.MOCKCLOUD_SERVER_CMD);
  if (process.env.MOCKCLOUD_TEST_ENDPOINT) return startAttached(process.env.MOCKCLOUD_TEST_ENDPOINT);
  return startInProcess();
}

// ── spawn mode ─────────────────────────────────────────────────────────────

// Split a command line into argv, honouring double quotes so binary paths
// with spaces work: `"C:\some dir\mockcloud.exe" --flag` → 2 tokens.
function splitCommand(cmdline) {
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(cmdline))) tokens.push(m[1] ?? m[2]);
  return tokens;
}

async function startSpawned(cmdline) {
  const [cmd, ...args] = splitCommand(cmdline);
  const child = spawn(cmd, args, {
    env: {
      ...process.env,
      PORT: '0',                        // OS-assigned port, reported via READY line
      HOST: '127.0.0.1',
      MOCKCLOUD_DISABLE_UI: 'true',
      MOCKCLOUD_EXIT_ON_STDIN_CLOSE: '1', // orphan protection if this process dies hard
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const endpoint = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for MOCKCLOUD_READY from: ${cmdline}`)),
      READY_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', function onData(d) {
      buf += d;
      const m = buf.match(/MOCKCLOUD_READY endpoint=(\S+)/);
      if (m) { clearTimeout(timer); child.stdout.off('data', onData); resolve(m[1]); }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited before ready (code ${code}): ${cmdline}`)); });
  });
  child.stdout.resume(); // keep draining so the pipe buffer never fills

  const health = await fetch(`${endpoint}/mockcloud/health`);
  if (!health.ok) throw new Error(`spawned server failed health check: HTTP ${health.status}`);

  return {
    endpoint,
    port: Number(new URL(endpoint).port),
    resetStore: () => httpReset(endpoint),
    close() {
      return new Promise((resolve) => {
        child.once('exit', () => resolve());
        try { child.stdin.end(); } catch {}    // stdin-close watchdog exits the child
        const t = setTimeout(() => {           // hard-kill fallback
          if (process.platform === 'win32') {
            try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
          } else {
            try { child.kill('SIGKILL'); } catch {}
          }
        }, 3000);
        t.unref?.();
      });
    },
  };
}

// ── attach mode ────────────────────────────────────────────────────────────

async function startAttached(endpoint) {
  endpoint = endpoint.replace(/\/+$/, '');
  const health = await fetch(`${endpoint}/mockcloud/health`);
  if (!health.ok) throw new Error(`MOCKCLOUD_TEST_ENDPOINT failed health check: HTTP ${health.status}`);
  return {
    endpoint,
    port: Number(new URL(endpoint).port),
    resetStore: () => httpReset(endpoint),
    close() {}, // not ours to stop
  };
}

// Server owns its disk roots in spawn/attach mode: DELETE /mockcloud/reset
// clears the store, wipes S3_ROOT, and wipes the DynamoDB snapshot server-side
// (avoids Windows file-lock races between this process and the server's).
async function httpReset(endpoint) {
  const r = await fetch(`${endpoint}/mockcloud/reset`, { method: 'DELETE' });
  if (r.status !== 200) throw new Error(`resetStore failed: HTTP ${r.status}`);
}

// ── in-process mode ────────────────────────────────────────────────────────
// src modules are imported dynamically so spawn/attach runs stay black-box:
// importing them here would evaluate the whole Node implementation inside the
// test process and create a second, unrelated store instance.

async function startInProcess() {
  const [
    { store },
    { wipeDisk },
    { Router },
    { dispatchAWS },
    { registerAllRoutes },
    { sendInternalError },
    { applyCors, attachBody },
    { sigv4Enabled, verifySigV4, sendSigV4Error },
    { iamMode, enforceIam, sendIamError },
    { startBackground, stopBackground },
  ] = await Promise.all([
    import('../../src/store.js'),
    import('../../src/services/dynamodb/persistence.js'),
    import('../../src/router.js'),
    import('../../src/dispatcher.js'),
    import('../../src/routes/index.js'),
    import('../../src/middleware/response.js'),
    import('../../src/middleware/http.js'),
    import('../../src/middleware/sigv4.js'),
    import('../../src/iam/policy-eval.js'),
    import('../../src/lifecycle.js'),
  ]);

  // Isolated storage roots (set in test-env.js) — create them up front.
  mkdirSync(TEST_S3_ROOT, { recursive: true });
  mkdirSync(TEST_DDB_ROOT, { recursive: true });

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
