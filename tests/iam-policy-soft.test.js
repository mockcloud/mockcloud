// tests/iam-policy-soft.test.js
// Opt-in IAM policy evaluation, soft mode (MOCKCLOUD_IAM=soft): would-be
// denials are logged but requests are never blocked. Split out of
// iam-policy.test.js because the flag must be set at module top — a spawned
// server (MOCKCLOUD_SERVER_CMD) inherits env at startup, so flipping the mode
// mid-test can't work there. Each mode gets its own file and server.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';

process.env.MOCKCLOUD_IAM = 'soft';   // MUST be set before startServer

const { startServer } = await import('./helpers/server.js');
const { SQSClient, CreateQueueCommand } = await import('@aws-sdk/client-sqs');

let server, sqs;
beforeAll(async () => {
  server = await startServer();
  sqs = new SQSClient({ endpoint: server.endpoint, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
});
afterAll(() => { server.close(); delete process.env.MOCKCLOUD_IAM; });
beforeEach(() => server.resetStore());

describe('IAM policy evaluation (soft)', () => {
  it('soft mode logs but never blocks', async () => {
    // No identity policy for `test` — strict mode would 403 this (see
    // iam-policy.test.js "implicit deny"); soft mode must let it through.
    const out = await sqs.send(new CreateQueueCommand({ QueueName: 'soft-ok' }));
    assert.ok(out.QueueUrl, 'soft mode should allow despite no policy');
  });
});
