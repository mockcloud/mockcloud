// tests/helpers/server.js
// Starts a MockCloud server for a test file and returns
//   { endpoint, port, resetStore(), close() }
// in one of two modes (the suite is now the Go server's conformance harness —
// the Node implementation was removed at the M11 cutover; see docs/MIGRATION.md):
//
//   spawn  (default / MOCKCLOUD_SERVER_CMD) — spawns ONE SERVER PER TEST FILE as
//          a child process and talks to it over HTTP only. `npm test` runs the
//          conformance runner, which builds the Go binary and sets the command;
//          a bare `vitest` run falls back to the locally-built ./bin/mockcloud.
//          The child inherits process.env, so per-file flags set at module top
//          (MOCKCLOUD_VERIFY_SIGV4, MOCKCLOUD_IAM, …) and the pid-keyed test
//          roots flow in for free.
//   attach (MOCKCLOUD_TEST_ENDPOINT) — debug only: use an already-running server.
//          Single-file runs only; parallel files would reset each other's state.
//
// test-env MUST be first — it sets MOCKCLOUD_S3_ROOT / MOCKCLOUD_DYNAMODB_ROOT
// (and MOCKCLOUD_TEST_ENDPOINTS), which the spawned server inherits.
import './test-env.js';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const READY_TIMEOUT_MS = 15_000;
const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));

export async function startServer() {
  if (process.env.MOCKCLOUD_TEST_ENDPOINT) return startAttached(process.env.MOCKCLOUD_TEST_ENDPOINT);
  return startSpawned(process.env.MOCKCLOUD_SERVER_CMD || defaultServerCmd());
}

// Locate the locally-built Go binary for a bare `vitest` run (the conformance
// runner sets MOCKCLOUD_SERVER_CMD explicitly and skips this).
function defaultServerCmd() {
  const exe = process.platform === 'win32' ? 'mockcloud.exe' : 'mockcloud';
  const bin = path.resolve(HELPERS_DIR, '../../bin', exe);
  if (!existsSync(bin)) {
    throw new Error(
      `MockCloud Go binary not found at ${bin}.\n` +
      `Build it (go build -o bin/${exe} ./cmd/mockcloud) or run \`npm test\` (which builds it),\n` +
      `or set MOCKCLOUD_SERVER_CMD / MOCKCLOUD_TEST_ENDPOINT.`);
  }
  return `"${bin}"`;
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
