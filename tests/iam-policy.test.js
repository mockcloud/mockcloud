// tests/iam-policy.test.js
// Opt-in IAM policy evaluation (MOCKCLOUD_IAM=strict). Flips the flag for this
// (forked) process so other suites stay unenforced. Covers implicit deny,
// allow, Deny-beats-Allow, a condition key, a resource policy, and that `soft`
// mode never blocks. Identity policies are scripted via the exempt control
// plane; the principal is the SDK's access key id (`test`).
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';

process.env.MOCKCLOUD_IAM = 'strict';   // MUST be set before startServer

const { startServer } = await import('./helpers/server.js');
const { store } = await import('../src/store.js');
const { SQSClient, CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, ReceiveMessageCommand } =
  await import('@aws-sdk/client-sqs');

let server, sqs;
beforeAll(async () => {
  server = await startServer();
  sqs = new SQSClient({ endpoint: server.endpoint, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
});
afterAll(() => { server.close(); delete process.env.MOCKCLOUD_IAM; });
beforeEach(() => server.resetStore());

const setPolicy = (principal, policy) => fetch(server.endpoint + '/mockcloud/iam/identity-policies', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ principal, policy }),
});
const allow = (Action, extra = {}) => ({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action, Resource: '*', ...extra }] });
async function err(promise) { try { await promise; return null; } catch (e) { return e; } }

describe('IAM policy evaluation (strict)', () => {
  it('denies an action with no matching policy (implicit deny)', async () => {
    const e = await err(sqs.send(new CreateQueueCommand({ QueueName: 'no-policy' })));
    assert.ok(e, 'should be denied');
    assert.equal(e.$metadata?.httpStatusCode, 403);
    assert.match(e.name, /AccessDenied/);
  });

  it('allows an action covered by an Allow statement', async () => {
    await setPolicy('test', allow('sqs:*'));
    const out = await sqs.send(new CreateQueueCommand({ QueueName: 'allowed' }));
    assert.ok(out.QueueUrl);
  });

  it('Deny beats Allow', async () => {
    await setPolicy('test', {
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 'sqs:*', Resource: '*' },
        { Effect: 'Deny', Action: 'sqs:DeleteQueue', Resource: '*' },
      ],
    });
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: 'half' }));   // allowed
    const e = await err(sqs.send(new DeleteQueueCommand({ QueueUrl })));                  // denied
    assert.ok(e);
    assert.match(e.name, /AccessDenied/);
  });

  it('honors a condition key (aws:username)', async () => {
    // Condition requires a different username than the caller (`test`) → deny.
    await setPolicy('test', allow('sqs:*', { Condition: { StringEquals: { 'aws:username': 'someone-else' } } }));
    const denied = await err(sqs.send(new CreateQueueCommand({ QueueName: 'cond-no' })));
    assert.ok(denied, 'condition should not match → denied');
    assert.match(denied.name, /AccessDenied/);

    // Matching condition → allow.
    await fetch(server.endpoint + '/mockcloud/iam/identity-policies?principal=test', { method: 'DELETE' });
    await setPolicy('test', allow('sqs:*', { Condition: { StringEquals: { 'aws:username': 'test' } } }));
    const out = await sqs.send(new CreateQueueCommand({ QueueName: 'cond-yes' }));
    assert.ok(out.QueueUrl);
  });

  it('grants access via a resource policy with no identity policy', async () => {
    const url = 'http://localhost:4566/000000000000/rp-queue';
    const arn = 'arn:aws:sqs:us-east-1:000000000000:rp-queue';
    store.sqs.queues[url] = {
      name: 'rp-queue', url, arn, type: 'standard', messages: [], created: Date.now(),
      attributes: { Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: 'sqs:SendMessage', Resource: arn }] }) },
    };
    // No identity policy for `test`. SendMessage is allowed only by the queue policy.
    const out = await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: 'hi' }));
    assert.ok(out.MessageId, 'resource policy should grant SendMessage');
    // ReceiveMessage isn't in the resource policy → denied.
    const e = await err(sqs.send(new ReceiveMessageCommand({ QueueUrl: url })));
    assert.ok(e);
    assert.match(e.name, /AccessDenied/);
  });

  it('soft mode logs but never blocks', async () => {
    process.env.MOCKCLOUD_IAM = 'soft';
    try {
      const out = await sqs.send(new CreateQueueCommand({ QueueName: 'soft-ok' }));   // no policy, but soft
      assert.ok(out.QueueUrl, 'soft mode should allow despite no policy');
    } finally {
      process.env.MOCKCLOUD_IAM = 'strict';
    }
  });
});
