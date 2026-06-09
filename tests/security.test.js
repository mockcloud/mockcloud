// tests/security.test.js
// Guards for the code-execution surfaces: the terminal endpoint is off by
// default, the Lambda sandbox doesn't inherit host secrets, and internal
// invocation loops are capped.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { CreateFunctionCommand, InvokeCommand } from '@aws-sdk/client-lambda';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';
import { invokeLambda } from '../src/services/lambda.js';

let server, lambda;
beforeAll(async () => { server = await startServer(); ({ lambda } = makeClients(server.endpoint)); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

const createFn = (name, code) => lambda.send(new CreateFunctionCommand({
  FunctionName: name, Runtime: 'nodejs20.x', Role: 'arn:aws:iam::000000000000:role/x',
  Handler: 'index.handler', Code: { ZipFile: Buffer.from(code) },
}));

describe('Terminal endpoint is gated', () => {
  it('is disabled by default (403)', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/terminal/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'cli' }),
    });
    assert.equal(res.status, 403);
  });

  it('can be opted into over loopback', async () => {
    const prev = { en: process.env.MOCKCLOUD_ENABLE_TERMINAL, host: process.env.HOST };
    process.env.MOCKCLOUD_ENABLE_TERMINAL = 'true';
    process.env.HOST = '127.0.0.1';
    try {
      const res = await fetch(`${server.endpoint}/mockcloud/terminal/sessions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'cli' }),
      });
      assert.equal(res.status, 201);
    } finally {
      if (prev.en === undefined) delete process.env.MOCKCLOUD_ENABLE_TERMINAL; else process.env.MOCKCLOUD_ENABLE_TERMINAL = prev.en;
      if (prev.host === undefined) delete process.env.HOST; else process.env.HOST = prev.host;
    }
  });
});

describe('Lambda runtime isolation', () => {
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

describe('Re-entrancy guard', () => {
  it('caps runaway internal invocations but never direct API invokes', async () => {
    // Internal-sourced invokes to a missing fn take the cheap not-found path
    // (no process spawned); the guard trips once the per-window budget is hit.
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
