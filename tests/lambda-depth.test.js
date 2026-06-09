// tests/lambda-depth.test.js
// Lambda configuration depth via @aws-sdk/client-lambda: Layers round-trip on
// create + update, Environment.Variables injected into the runtime, and Timeout
// enforced by the sandbox.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  CreateFunctionCommand,
  GetFunctionConfigurationCommand,
  UpdateFunctionConfigurationCommand,
  InvokeCommand,
} from '@aws-sdk/client-lambda';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';

let server, lambda;
beforeAll(async () => { server = await startServer(); ({ lambda } = makeClients(server.endpoint)); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

function createFn(name, code, extra = {}) {
  return lambda.send(new CreateFunctionCommand({
    FunctionName: name,
    Runtime: 'nodejs20.x',
    Role: 'arn:aws:iam::000000000000:role/x',
    Handler: 'index.handler',
    Code: { ZipFile: Buffer.from(code) },
    ...extra,
  }));
}
const payloadString = out => Buffer.from(out.Payload).toString();

describe('Lambda depth', () => {
  it('round-trips Layers on create and update', async () => {
    const layer = 'arn:aws:lambda:us-east-1:000000000000:layer:utils:3';
    await createFn('with-layers', 'exports.handler = async () => 1;', { Layers: [layer] });

    const cfg = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: 'with-layers' }));
    assert.equal(cfg.Layers.length, 1);
    assert.equal(cfg.Layers[0].Arn, layer);

    const layer2 = 'arn:aws:lambda:us-east-1:000000000000:layer:extra:1';
    await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: 'with-layers', Layers: [layer, layer2] }));
    const cfg2 = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: 'with-layers' }));
    assert.deepEqual(cfg2.Layers.map(l => l.Arn), [layer, layer2]);
  });

  it('injects Environment.Variables into the runtime', async () => {
    await createFn('env-fn', 'exports.handler = async () => process.env.GREETING;', {
      Environment: { Variables: { GREETING: 'hello-from-env' } },
    });
    const out = await lambda.send(new InvokeCommand({ FunctionName: 'env-fn' }));
    assert.equal(JSON.parse(payloadString(out)), 'hello-from-env');
  });

  it('enforces the configured Timeout', async () => {
    await createFn('slow-fn',
      'exports.handler = async () => { await new Promise(r => setTimeout(r, 3000)); return "done"; };',
      { Timeout: 1 });
    const out = await lambda.send(new InvokeCommand({ FunctionName: 'slow-fn' }));
    assert.ok(out.FunctionError, 'expected a FunctionError when the handler exceeds its timeout');
  });
});
