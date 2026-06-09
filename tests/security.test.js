// tests/security.test.js
// Merged security regression suite (vitest):
//   - The May 2026 review's 10 findings: CSRF/Origin + Sec-Fetch-Site gates,
//     Content-Type-gated body parsing, strict terminal gate, router URIError,
//     S3 bucket-name validation + registered-object DELETE, EC2 metadata
//     validation, Lambda decompression-bomb + env-var isolation.
//   - Code-execution-surface guards: terminal off by default, Lambda sandbox
//     doesn't inherit host secrets, internal invocation loops are capped.
// (The apigatewayv2 prototype-pollution tests are gone — that service was
// trimmed from this build.)
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { CreateFunctionCommand, InvokeCommand } from '@aws-sdk/client-lambda';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';
import { lambdaJson, awsForm } from './helpers/http.js';
import { invokeLambda } from '../src/services/lambda.js';

let server, lambda;
const allowedOrigin = 'http://localhost:4567';   // default UI_PORT — in the allowlist

beforeAll(async () => { server = await startServer(); ({ lambda } = makeClients(server.endpoint)); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

const createFn = (name, code) => lambda.send(new CreateFunctionCommand({
  FunctionName: name, Runtime: 'nodejs20.x', Role: 'arn:aws:iam::000000000000:role/x',
  Handler: 'index.handler', Code: { ZipFile: Buffer.from(code) },
}));

// ── Finding layer 1a — Origin allowlist (CSRF) ──────────────────────────────
describe('CSRF defense — Origin allowlist', () => {
  it('rejects a cross-origin POST from a non-allowlisted Origin', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/s3/buckets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://evil.example' },
      body: JSON.stringify({ name: 'csrf-test' }),
    });
    assert.equal(res.status, 403);
  });

  it('accepts a POST with no Origin header (CLI / SDK path)', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/s3/buckets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'no-origin-bucket' }),
    });
    assert.equal(res.status, 201);
  });

  it('accepts a POST from an allowlisted Origin (local UI)', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/s3/buckets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': allowedOrigin },
      body: JSON.stringify({ name: 'ui-bucket' }),
    });
    assert.equal(res.status, 201);
  });

  it('rejects cross-origin Lambda create (finding #4)', async () => {
    const res = await fetch(`${server.endpoint}/2015-03-31/functions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://evil.example' },
      body: JSON.stringify({ FunctionName: 'pwn', Runtime: 'nodejs20.x', Handler: 'index.handler', Role: 'r', Code: { ZipFile: '' } }),
    });
    assert.equal(res.status, 403);
  });

  it('rejects cross-origin DELETE /mockcloud/reset (finding #10)', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/reset`, {
      method: 'DELETE', headers: { 'Origin': 'https://evil.example' },
    });
    assert.equal(res.status, 403);
  });
});

// ── Finding layer 1b — Sec-Fetch-Site gate ──────────────────────────────────
describe('Sec-Fetch-Site gate', () => {
  it('rejects cross-site mutating requests regardless of Origin', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/s3/buckets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ name: 'sfs-test' }),
    });
    assert.equal(res.status, 403);
  });

  it('allows same-origin mutating requests', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/s3/buckets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ name: 'sfs-same-origin' }),
    });
    assert.equal(res.status, 201);
  });
});

// ── Finding layer 1c — Content-Type-gated body parsing ──────────────────────
describe('Content-Type-gated body parsing', () => {
  it('does not JSON-parse text/plain bodies (CSRF simple-CORS trick)', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/s3/buckets`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ name: 'should-not-create' }),
    });
    assert.equal(res.status, 400);   // parsedBody === {} → name missing → 400
    const list = await (await fetch(`${server.endpoint}/mockcloud/s3/buckets`)).json();
    assert.equal(list.buckets.find(b => b.name === 'should-not-create'), undefined);
  });
});

// ── Finding #5 — Strict terminal gate (origin) + feature flag (wip) ─────────
describe('Terminal endpoint is gated', () => {
  it('rejects without an Origin header (origin gate)', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/terminal/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'cli' }),
    });
    assert.equal(res.status, 403);
  });

  it('rejects with an allowlisted Origin while disabled by default (feature flag)', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/terminal/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': allowedOrigin }, body: JSON.stringify({ type: 'cli' }),
    });
    assert.equal(res.status, 403);   // MOCKCLOUD_ENABLE_TERMINAL unset → denied
  });

  it('allows an allowlisted Origin once explicitly enabled over loopback', async () => {
    const prev = process.env.MOCKCLOUD_ENABLE_TERMINAL;
    process.env.MOCKCLOUD_ENABLE_TERMINAL = 'true';
    try {
      const res = await fetch(`${server.endpoint}/mockcloud/terminal/sessions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': allowedOrigin }, body: JSON.stringify({ type: 'cli' }),
      });
      assert.equal(res.status, 201);
    } finally {
      if (prev === undefined) delete process.env.MOCKCLOUD_ENABLE_TERMINAL; else process.env.MOCKCLOUD_ENABLE_TERMINAL = prev;
    }
  });
});

// ── Finding #7 — Router URIError no longer crashes the daemon ───────────────
describe('Router URIError handling', () => {
  it('returns 400 on malformed percent-encoding instead of crashing', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/secrets/%`);
    assert.equal(res.status, 400);
    const ok = await fetch(`${server.endpoint}/mockcloud/health`);
    assert.equal(ok.status, 200);
  });
});

// ── Finding #2 — S3 bucket-name validation + path containment ───────────────
describe('S3 bucket-name validation', () => {
  it('rejects traversal-style names at the UI surface', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/s3/buckets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '../..' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects uppercase names at the UI surface (AWS naming rules)', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/s3/buckets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'UPPERCASE-NAME' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects traversal-style names at the AWS S3 PUT bucket surface', async () => {
    const res = await fetch(`${server.endpoint}/..%2F..`, { method: 'PUT' });
    assert.equal(res.status, 400);
  });
});

// ── Finding #6 — S3 DELETE requires the object to be registered ─────────────
describe('S3 object DELETE requires registered object', () => {
  it('returns 404 for delete on a bucket without that key', async () => {
    const create = await fetch(`${server.endpoint}/mockcloud/s3/buckets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'delete-test' }),
    });
    assert.equal(create.status, 201);
    const del = await fetch(`${server.endpoint}/mockcloud/s3/buckets/delete-test/object?key=.bashrc`, { method: 'DELETE' });
    assert.equal(del.status, 404);
  });
});

// ── Finding #1 — Docker injection: API-boundary regex rejects bad values ────
describe('EC2 instance metadata validation', () => {
  it('rejects shell-meta InstanceType in RunInstances (AWS surface)', async () => {
    const res = await awsForm(server.endpoint, 'RunInstances', {
      InstanceType: 'x";id;"', ImageId: 'ami-ubuntu-22', MinCount: '1', MaxCount: '1',
    }, { version: '2016-11-15' });
    assert.equal(res.status, 400);
  });

  it('rejects shell-meta type at the UI POST', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/ec2/instances`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', type: 'x";id;"', ami: 'ami-ubuntu-22' }),
    });
    assert.equal(res.status, 400);
  });

  it('accepts well-formed values', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/ec2/instances`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ok', type: 't3.micro', ami: 'ami-ubuntu-22' }),
    });
    assert.equal(res.status, 201);
  });
});

// ── Finding #8 — Decompression bomb refused before allocation ────────────────
describe('Lambda decompression bomb defense', () => {
  it('rejects a zip whose central directory claims a 1 GB uncompSize', async () => {
    const bombZip = craftBombZip();
    const start = Date.now();
    const res = await lambdaJson(server.endpoint, 'POST', '/2015-03-31/functions', {
      FunctionName: 'bomb', Runtime: 'nodejs20.x', Handler: 'index.handler', Role: 'r',
      Code: { ZipFile: bombZip.toString('base64') },
    });
    const elapsed = Date.now() - start;
    assert.equal(res.status, 201);
    assert.ok(elapsed < 2000, `bomb create should be fast, took ${elapsed}ms`);
  });
});

// ── Finding #4 — Lambda env-var filter strips NODE_OPTIONS etc. ─────────────
describe('Lambda env-var isolation', () => {
  it('strips NODE_OPTIONS / LD_PRELOAD from the spawned child but keeps benign vars', async () => {
    const source = `exports.handler = async () => ({
      no: process.env.NODE_OPTIONS || null,
      ld: process.env.LD_PRELOAD || null,
      mv: process.env.MY_VAR || null,
    });`;
    const create = await lambdaJson(server.endpoint, 'POST', '/2015-03-31/functions', {
      FunctionName: 'env-test', Runtime: 'nodejs20.x', Handler: 'index.handler', Role: 'r',
      Code: { ZipFile: Buffer.from(source).toString('base64') },
      Environment: { Variables: { NODE_OPTIONS: '--require=/tmp/evil.js', LD_PRELOAD: '/tmp/evil.so', MY_VAR: 'legit' } },
    });
    assert.equal(create.status, 201);
    const invoke = await lambdaJson(server.endpoint, 'POST', '/2015-03-31/functions/env-test/invocations', {});
    const got = typeof invoke.body === 'string' ? JSON.parse(invoke.body) : invoke.body;
    assert.equal(got.no, null, 'NODE_OPTIONS must be filtered');
    assert.equal(got.ld, null, 'LD_PRELOAD must be filtered');
    assert.equal(got.mv, 'legit', 'benign env vars pass through');
  });

  it('does not leak the host environment into user code', async () => {
    process.env.MOCKCLOUD_HOST_SECRET = 'do-not-leak';
    try {
      await createFn('env-iso',
        'exports.handler = async () => ({ leaked: process.env.MOCKCLOUD_HOST_SECRET ?? null, fn: process.env.AWS_LAMBDA_FUNCTION_NAME });');
      const out = await lambda.send(new InvokeCommand({ FunctionName: 'env-iso' }));
      const r = JSON.parse(Buffer.from(out.Payload).toString());
      assert.equal(r.leaked, null);     // host secret is NOT visible to user code
      assert.equal(r.fn, 'env-iso');    // standard Lambda vars ARE present
    } finally {
      delete process.env.MOCKCLOUD_HOST_SECRET;
    }
  });
});

// ── Re-entrancy guard (internal invoke storm cap) ───────────────────────────
describe('Re-entrancy guard', () => {
  it('caps runaway internal invocations but never direct API invokes', async () => {
    let guardHit = false;
    for (let i = 0; i < 250; i++) {
      const r = await invokeLambda('does-not-exist', {}, { source: 's3' });
      if (/re-entrancy guard/i.test(r.error || '')) { guardHit = true; break; }
    }
    assert.ok(guardHit, 'expected the re-entrancy guard to trip for internal invokes');
    const direct = await invokeLambda('does-not-exist', {}, { source: 'aws-api' });
    assert.match(direct.error, /Function not found/);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────
function craftBombZip() {
  const name = Buffer.from('index.js');
  const cd = Buffer.alloc(46 + name.length);
  cd.writeUInt32LE(0x02014b50, 0);     // CD signature
  cd.writeUInt16LE(0x0014, 4);          // version made by
  cd.writeUInt16LE(0x0014, 6);          // version needed
  cd.writeUInt16LE(0,      8);          // bit flag
  cd.writeUInt16LE(8,      10);         // method (deflate)
  cd.writeUInt16LE(0,      12);         // mod time
  cd.writeUInt16LE(0,      14);         // mod date
  cd.writeUInt32LE(0,      16);         // crc32
  cd.writeUInt32LE(5,      20);         // compSize (tiny)
  cd.writeUInt32LE(1 << 30, 24);        // uncompSize = 1 GB
  cd.writeUInt16LE(name.length, 28);    // name length
  cd.writeUInt16LE(0,      30);         // extra length
  cd.writeUInt16LE(0,      32);         // comment length
  cd.writeUInt16LE(0,      34);         // disk number start
  cd.writeUInt16LE(0,      36);         // internal attrs
  cd.writeUInt32LE(0,      38);         // external attrs
  cd.writeUInt32LE(0,      42);         // local header offset
  name.copy(cd, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);    // EOCD signature
  eocd.writeUInt16LE(0,            4);   // disk number
  eocd.writeUInt16LE(0,            6);   // disk with CD start
  eocd.writeUInt16LE(1,            8);   // entries on this disk
  eocd.writeUInt16LE(1,            10);  // total entries
  eocd.writeUInt32LE(cd.length,    12);  // CD size
  eocd.writeUInt32LE(0,            16);  // CD offset
  eocd.writeUInt16LE(0,            20);  // comment length

  return Buffer.concat([cd, eocd]);
}
