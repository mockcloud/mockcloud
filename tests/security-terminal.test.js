// tests/security-terminal.test.js
// The ENABLED side of the terminal feature-flag gate (May 2026 review finding
// #5) — split out of security.test.js. The flag must be set BEFORE the server
// boots: in spawn mode (MOCKCLOUD_SERVER_CMD) the server child inherits
// process.env at spawn time, so flipping it mid-test can never reach the
// server. security.test.js keeps the disabled-by-default rejections.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';

process.env.MOCKCLOUD_ENABLE_TERMINAL = 'true';   // MUST be set before startServer

const { startServer } = await import('./helpers/server.js');

let server;
const allowedOrigin = 'http://localhost:4567';   // default UI_PORT — in the allowlist

beforeAll(async () => { server = await startServer(); });
afterAll(() => { server.close(); delete process.env.MOCKCLOUD_ENABLE_TERMINAL; });
beforeEach(() => server.resetStore());

describe('Terminal endpoint with MOCKCLOUD_ENABLE_TERMINAL=true', () => {
  it('allows an allowlisted Origin once explicitly enabled over loopback', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/terminal/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': allowedOrigin }, body: JSON.stringify({ type: 'cli' }),
    });
    assert.equal(res.status, 201);
  });

  it('still rejects without an Origin header (origin gate is independent of the flag)', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/terminal/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'cli' }),
    });
    assert.equal(res.status, 403);
  });
});
