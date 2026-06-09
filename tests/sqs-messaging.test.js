// tests/sqs-messaging.test.js
// SQS messaging depth via @aws-sdk/client-sqs: batch send/delete, message
// visibility changes, DelaySeconds, MessageAttributes round-trip + MD5, and
// WaitTimeSeconds long polling. Timing tests use bounded waits, not fixed
// sleeps, except the long-poll assertion which must observe the elapsed wait.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  CreateQueueCommand, SendMessageCommand, SendMessageBatchCommand,
  ReceiveMessageCommand, DeleteMessageBatchCommand, ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';

let server, sqs;
beforeAll(async () => { server = await startServer(); ({ sqs } = makeClients(server.endpoint)); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

async function waitFor(check, { timeout = 4000, interval = 25 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return true; await new Promise(r => setTimeout(r, interval)); }
  return false;
}
const makeQueue = async name => (await sqs.send(new CreateQueueCommand({ QueueName: name }))).QueueUrl;

describe('SQS messaging depth', () => {
  it('SendMessageBatch sends all entries successfully', async () => {
    const QueueUrl = await makeQueue('batch-send');
    const res = await sqs.send(new SendMessageBatchCommand({
      QueueUrl,
      Entries: [
        { Id: 'a', MessageBody: 'one' },
        { Id: 'b', MessageBody: 'two' },
        { Id: 'c', MessageBody: 'three' },
      ],
    }));
    assert.equal(res.Successful.length, 3);
    assert.ok(!res.Failed || res.Failed.length === 0);
    assert.ok(res.Successful.every(s => s.MessageId && s.MD5OfMessageBody));

    // All three are receivable.
    const bodies = new Set();
    await waitFor(async () => {
      const recv = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, VisibilityTimeout: 0 }));
      (recv.Messages || []).forEach(m => bodies.add(m.Body));
      return bodies.size === 3;
    });
    assert.deepEqual([...bodies].sort(), ['one', 'three', 'two']);
  });

  it('DeleteMessageBatch removes received messages', async () => {
    const QueueUrl = await makeQueue('batch-delete');
    await sqs.send(new SendMessageBatchCommand({
      QueueUrl,
      Entries: [{ Id: '1', MessageBody: 'x' }, { Id: '2', MessageBody: 'y' }],
    }));
    const recv = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 }));
    assert.equal(recv.Messages.length, 2);

    const del = await sqs.send(new DeleteMessageBatchCommand({
      QueueUrl,
      Entries: recv.Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
    }));
    assert.equal(del.Successful.length, 2);
    assert.ok(!del.Failed || del.Failed.length === 0);

    // Nothing left even with immediate re-visibility.
    const left = await sqs.send(new ReceiveMessageCommand({ QueueUrl, VisibilityTimeout: 0, MaxNumberOfMessages: 10 }));
    assert.ok(!left.Messages || left.Messages.length === 0);
  });

  it('ChangeMessageVisibility(0) makes an in-flight message visible again', async () => {
    const QueueUrl = await makeQueue('chvis');
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'hide-me' }));

    // Receive with the default 30s visibility → message goes in-flight.
    const r1 = await sqs.send(new ReceiveMessageCommand({ QueueUrl }));
    assert.equal(r1.Messages.length, 1);
    const handle = r1.Messages[0].ReceiptHandle;

    // While in-flight it should not be returned again.
    const hidden = await sqs.send(new ReceiveMessageCommand({ QueueUrl }));
    assert.ok(!hidden.Messages || hidden.Messages.length === 0);

    // Reset visibility to 0 → it reappears.
    await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle: handle, VisibilityTimeout: 0 }));
    const r2 = await sqs.send(new ReceiveMessageCommand({ QueueUrl }));
    assert.equal(r2.Messages.length, 1);
    assert.equal(r2.Messages[0].Body, 'hide-me');
  });

  it('DelaySeconds hides a message until the delay elapses', async () => {
    const QueueUrl = await makeQueue('delayed');
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'later', DelaySeconds: 1 }));

    // Immediately invisible.
    const now = await sqs.send(new ReceiveMessageCommand({ QueueUrl, VisibilityTimeout: 0 }));
    assert.ok(!now.Messages || now.Messages.length === 0, 'delayed message should not be visible yet');

    // Visible within a bounded wait once the delay passes.
    assert.ok(await waitFor(async () => {
      const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl, VisibilityTimeout: 0 }));
      return r.Messages?.some(m => m.Body === 'later');
    }, { timeout: 3000 }), 'delayed message should become visible after the delay');
  });

  it('MessageAttributes round-trip with MD5OfMessageAttributes', async () => {
    const QueueUrl = await makeQueue('attrs');
    const MessageAttributes = {
      author: { DataType: 'String', StringValue: 'ada' },
      count:  { DataType: 'Number', StringValue: '42' },
    };
    const send = await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'tagged', MessageAttributes }));
    assert.ok(send.MD5OfMessageAttributes, 'send should return MD5OfMessageAttributes');

    const recv = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MessageAttributeNames: ['All'] }));
    const m = recv.Messages[0];
    assert.equal(m.MessageAttributes.author.StringValue, 'ada');
    assert.equal(m.MessageAttributes.count.StringValue, '42');
    assert.equal(m.MessageAttributes.count.DataType, 'Number');
    assert.equal(m.MD5OfMessageAttributes, send.MD5OfMessageAttributes);
  });

  it('WaitTimeSeconds long-polls an empty queue for ~the wait duration', async () => {
    const QueueUrl = await makeQueue('longpoll');
    const start = Date.now();
    const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: 1 }));
    const elapsed = Date.now() - start;
    assert.ok(!res.Messages || res.Messages.length === 0, 'empty queue returns no messages');
    assert.ok(elapsed >= 900, `should wait ~1s, waited ${elapsed}ms`);
    assert.ok(elapsed < 4000, `should not wait far beyond the requested time, waited ${elapsed}ms`);
  });
});
