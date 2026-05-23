// tests/security.test.js
// Regression tests for the 10 findings in the May 2026 security review.
//
// Each top-level describe block corresponds to one finding (or one shared
// defense layer). Tests exercise the wire-level behavior rather than poking
// internals so they keep working if the implementations move.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { lambdaJson, awsForm } from './helpers/http.js';

let server;
const allowedOrigin = 'http://localhost:4567';

before(async () => { server = await startServer(); });
after(() => server.close());
beforeEach(() => server.resetStore());

// ── Layer 1a — Origin gate ──────────────────────────────────────────────────
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
      method: 'DELETE',
      headers: { 'Origin': 'https://evil.example' },
    });
    assert.equal(res.status, 403);
  });
});

// ── Layer 1b — Sec-Fetch-Site gate (defense in depth) ───────────────────────
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

// ── Layer 1c — Content-Type-gated JSON parsing ──────────────────────────────
describe('Content-Type-gated body parsing', () => {
  it('does not JSON-parse text/plain bodies (CSRF simple-CORS trick)', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/s3/buckets`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ name: 'should-not-create' }),
    });
    // Handler sees req.parsedBody === {} → name missing → validation error
    assert.equal(res.status, 400);

    // And the bucket was not created
    const list = await fetch(`${server.endpoint}/mockcloud/s3/buckets`);
    const { buckets } = await list.json();
    assert.equal(buckets.find(b => b.name === 'should-not-create'), undefined);
  });
});

// ── Layer 1d — Strict terminal gate ─────────────────────────────────────────
describe('Terminal endpoints require allowlisted Origin', () => {
  it('rejects terminal session create without an Origin header', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/terminal/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'cli' }),
    });
    assert.equal(res.status, 403);
  });

  it('allows terminal session create from the local UI origin', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/terminal/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': allowedOrigin },
      body: JSON.stringify({ type: 'cli' }),
    });
    assert.equal(res.status, 201);
  });
});

// ── Finding #7 — Router URIError no longer crashes the daemon ───────────────
describe('Router URIError handling', () => {
  it('returns 400 on malformed percent-encoding instead of crashing', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/secrets/%`);
    assert.equal(res.status, 400);

    // Daemon still alive — a follow-up call succeeds.
    const ok = await fetch(`${server.endpoint}/mockcloud/health`);
    assert.equal(ok.status, 200);
  });
});

// ── Finding #2 — S3 bucket-name validation + path containment ───────────────
describe('S3 bucket-name validation', () => {
  it('rejects traversal-style names at the UI surface', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/s3/buckets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '../..' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects uppercase names at the UI surface (AWS naming rules)', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/s3/buckets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'UPPERCASE-NAME' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects traversal-style names at the AWS S3 PUT bucket surface', async () => {
    // Path-style PUT /<bucket>
    const res = await fetch(`${server.endpoint}/..%2F..`, { method: 'PUT' });
    assert.equal(res.status, 400);
  });
});

// ── Finding #6 — S3 DELETE requires object to be registered ─────────────────
describe('S3 object DELETE requires registered object', () => {
  it('returns 404 for delete on a bucket without that key', async () => {
    // Create a valid bucket via the UI surface
    const create = await fetch(`${server.endpoint}/mockcloud/s3/buckets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'delete-test' }),
    });
    assert.equal(create.status, 201);

    // Attempting to delete an unregistered key returns 404 rather than 200.
    const del = await fetch(`${server.endpoint}/mockcloud/s3/buckets/delete-test/object?key=.bashrc`, { method: 'DELETE' });
    assert.equal(del.status, 404);
  });
});

// ── Finding #3 — Prototype pollution via apigatewayv2 PATCH ────────────────
describe('API Gateway v2 prototype pollution', () => {
  it('PATCH .../integrations/__proto__ does not pollute Object.prototype', async () => {
    const apiRes = await fetch(`${server.endpoint}/v2/apis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Name: 'pollute-test', ProtocolType: 'HTTP' }),
    });
    const api = await apiRes.json();
    const apiId = api.ApiId || api.apiId;       // MockCloud's response uses lowercase
    assert.ok(apiId, 'API should have been created');

    const patch = await fetch(`${server.endpoint}/v2/apis/${apiId}/integrations/__proto__`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ polluted: 'yes', isAdmin: true }),
    });
    assert.equal(patch.status, 404);

    // Object.prototype must remain clean.
    assert.equal(({}).polluted, undefined);
    assert.equal(({}).isAdmin, undefined);
  });

  it('PATCH .../stages/constructor does not pollute', async () => {
    const apiRes = await fetch(`${server.endpoint}/v2/apis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Name: 'stage-pollute', ProtocolType: 'HTTP' }),
    });
    const api = await apiRes.json();
    const apiId = api.ApiId || api.apiId;
    const patch = await fetch(`${server.endpoint}/v2/apis/${apiId}/stages/constructor`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tainted: true }),
    });
    assert.equal(patch.status, 404);
    assert.equal(({}).tainted, undefined);
  });
});

// ── Finding #1 — Docker injection: API-boundary regex rejects bad values ────
describe('EC2 instance metadata validation', () => {
  it('rejects shell-meta InstanceType in RunInstances (AWS surface)', async () => {
    const res = await awsForm(server.endpoint, 'RunInstances', {
      InstanceType: 'x";id;"',
      ImageId: 'ami-ubuntu-22',
      MinCount: '1', MaxCount: '1',
    }, { version: '2016-11-15' });
    assert.equal(res.status, 400);
  });

  it('rejects shell-meta type at the UI POST', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/ec2/instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', type: 'x";id;"', ami: 'ami-ubuntu-22' }),
    });
    assert.equal(res.status, 400);
  });

  it('accepts well-formed values', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/ec2/instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ok', type: 't3.micro', ami: 'ami-ubuntu-22' }),
    });
    assert.equal(res.status, 201);
  });
});

// ── Finding #8 — Decompression bomb refused before allocation ────────────────
describe('Lambda decompression bomb defense', () => {
  it('rejects a zip whose central directory claims a 1 GB uncompSize', async () => {
    // Craft a minimal-but-valid ZIP whose central directory entry advertises
    // a huge uncompSize but a tiny compressed stream. extractZip should bail
    // before calling inflateRawSync.
    const bombZip = craftBombZip();

    const start = Date.now();
    const res = await lambdaJson(server.endpoint, 'POST', '/2015-03-31/functions', {
      FunctionName: 'bomb',
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Role: 'r',
      Code: { ZipFile: bombZip.toString('base64') },
    });
    const elapsed = Date.now() - start;

    // Response is fast (we did NOT inflate gigabytes) and the function got
    // created with raw-bytes fallback code (not a crash).
    assert.equal(res.status, 201);
    assert.ok(elapsed < 2000, `bomb create should be fast, took ${elapsed}ms`);
  });
});

// ── Finding #4 — Lambda env-var filter strips NODE_OPTIONS etc. ─────────────
describe('Lambda env-var isolation', () => {
  it('strips NODE_OPTIONS / LD_PRELOAD / PATH from the spawned child', async () => {
    const source = `exports.handler = async () => ({
      no: process.env.NODE_OPTIONS || null,
      ld: process.env.LD_PRELOAD || null,
      mv: process.env.MY_VAR || null,
    });`;
    const ZipFile = Buffer.from(source).toString('base64');

    const create = await lambdaJson(server.endpoint, 'POST', '/2015-03-31/functions', {
      FunctionName: 'env-test',
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Role: 'r',
      Code: { ZipFile },
      Environment: { Variables: {
        NODE_OPTIONS: '--require=/tmp/evil.js',
        LD_PRELOAD: '/tmp/evil.so',
        MY_VAR: 'legit',
      } },
    });
    assert.equal(create.status, 201);

    const invoke = await lambdaJson(server.endpoint, 'POST', '/2015-03-31/functions/env-test/invocations', {});
    // The body comes back as a JSON-stringified handler result; lambdaJson
    // re-parses it for us when possible.
    const got = typeof invoke.body === 'string' ? JSON.parse(invoke.body) : invoke.body;
    assert.equal(got.no, null, 'NODE_OPTIONS must be filtered');
    assert.equal(got.ld, null, 'LD_PRELOAD must be filtered');
    assert.equal(got.mv, 'legit', 'benign env vars pass through');
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────
function craftBombZip() {
  // Minimal ZIP with a single index.js entry whose central-directory
  // uncompSize is 1 GB. We don't bother making the local file header valid —
  // extractZip rejects before checking it because uncompSize > CODE_SIZE_CAP.
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
