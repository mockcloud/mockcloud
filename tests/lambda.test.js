// tests/lambda.test.js
// Hits the Lambda REST API directly. Also exercises the concurrency / policy
// sub-resources to lock in the regression where a broad GET catch-all was
// shadowing them and returning 404 for everything.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { lambdaJson } from './helpers/http.js';

let server;
const lambda = (method, path, payload, headers) => lambdaJson(server.endpoint, method, path, payload, headers);

before(async () => { server = await startServer(); });
after(() => server.close());
beforeEach(() => server.resetStore());

const FN_BASE = '/2015-03-31/functions';

describe('CreateFunction / GetFunction / DeleteFunction', () => {
  it('CreateFunction stores function and returns config', async () => {
    const res = await lambda('POST', FN_BASE, {
      FunctionName: 'fn1',
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Role: 'arn:aws:iam::000000000000:role/none',
      Code: { ZipFile: '' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.FunctionName, 'fn1');
    assert.equal(res.body.Runtime, 'nodejs20.x');
  });

  it('Duplicate CreateFunction conflicts (409)', async () => {
    await lambda('POST', FN_BASE, { FunctionName: 'dup' });
    const dup = await lambda('POST', FN_BASE, { FunctionName: 'dup' });
    assert.equal(dup.status, 409);
    assert.match(dup.body.__type, /ResourceConflictException/);
  });

  it('GetFunction wraps config in Configuration', async () => {
    await lambda('POST', FN_BASE, { FunctionName: 'g' });
    const get = await lambda('GET', `${FN_BASE}/g`);
    assert.equal(get.status, 200);
    assert.equal(get.body.Configuration.FunctionName, 'g');
    assert.ok(get.body.Code?.Location);
  });

  it('GetFunction 404 when missing', async () => {
    const res = await lambda('GET', `${FN_BASE}/nope`);
    assert.equal(res.status, 404);
    assert.match(res.body.__type, /ResourceNotFoundException/);
  });

  it('DeleteFunction removes the function', async () => {
    await lambda('POST', FN_BASE, { FunctionName: 'del' });
    const del = await lambda('DELETE', `${FN_BASE}/del`);
    assert.equal(del.status, 204);
    const after = await lambda('GET', `${FN_BASE}/del`);
    assert.equal(after.status, 404);
  });
});

describe('Sub-resource handlers (regression: GET catch-all used to shadow these)', () => {
  beforeEach(async () => {
    await lambda('POST', FN_BASE, { FunctionName: 'subs' });
  });

  it('GET /concurrency returns ReservedConcurrentExecutions', async () => {
    const res = await lambda('GET', `${FN_BASE}/subs/concurrency`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ReservedConcurrentExecutions, -1);
  });

  it('GET /policy returns 404 with ResourceNotFoundException (not the generic catch-all)', async () => {
    const res = await lambda('GET', `${FN_BASE}/subs/policy`);
    assert.equal(res.status, 404);
    assert.match(res.body.__type, /ResourceNotFoundException/);
    assert.match(res.body.message, /No policy for function/);
  });

  it('GET /code-signing-config returns 200 with empty arn (Terraform compat)', async () => {
    const res = await lambda('GET', `${FN_BASE}/subs/code-signing-config`);
    assert.equal(res.status, 200);
    assert.equal(res.body.CodeSigningConfigArn, '');
  });

  it('GET /versions returns $LATEST', async () => {
    const res = await lambda('GET', `${FN_BASE}/subs/versions`);
    assert.equal(res.status, 200);
    assert.ok(res.body.Versions?.length);
    assert.equal(res.body.Versions[0].Version, '$LATEST');
  });
});

describe('Synthetic invocation (no code uploaded)', () => {
  it('returns a 200 with synthetic body', async () => {
    await lambda('POST', FN_BASE, { FunctionName: 'inv' });
    const res = await lambda('POST', `${FN_BASE}/inv/invocations`, { hello: 'world' });
    assert.equal(res.status, 200);
    // Synthetic response is { statusCode: 200, body: ... }
    assert.equal(res.body.statusCode, 200);
  });

  it('Async invoke (Event) returns 202 immediately', async () => {
    await lambda('POST', FN_BASE, { FunctionName: 'async' });
    const res = await lambda('POST', `${FN_BASE}/async/invocations`, {}, { 'X-Amz-Invocation-Type': 'Event' });
    assert.equal(res.status, 202);
  });
});

describe('Event source mappings', () => {
  it('CreateMapping returns UUID and stores the mapping', async () => {
    await lambda('POST', FN_BASE, { FunctionName: 'esm-fn' });
    const res = await lambda('POST', '/2015-03-31/event-source-mappings', {
      FunctionName: 'esm-fn',
      EventSourceArn: 'arn:aws:dynamodb:us-east-1:000000000000:table/users/stream/2024-01-01T00-00-00',
      BatchSize: 5,
    });
    assert.equal(res.status, 202);
    assert.ok(res.body.UUID);
    assert.equal(res.body.BatchSize, 5);

    const list = await lambda('GET', '/2015-03-31/event-source-mappings');
    assert.equal(list.body.EventSourceMappings.length, 1);
  });

  it('CreateMapping rejects missing fields', async () => {
    const res = await lambda('POST', '/2015-03-31/event-source-mappings', {});
    assert.equal(res.status, 400);
    assert.match(res.body.__type, /InvalidParameterValueException/);
  });
});
