// tests/sqs-fifo.test.js
// FIFO queues via @aws-sdk/client-sqs: MessageGroupId requirement, sequence
// numbers, per-group ordered delivery, and content-based deduplication.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  CreateQueueCommand, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';

let server, sqs;
beforeAll(async () => { server = await startServer(); ({ sqs } = makeClients(server.endpoint)); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

async function makeFifo(name, attrs = {}) {
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({
    QueueName: name,
    Attributes: { FifoQueue: 'true', ...attrs },
  }));
  return QueueUrl;
}

describe('SQS FIFO', () => {
  it('requires MessageGroupId on send', async () => {
    const url = await makeFifo('orders.fifo');
    await assert.rejects(
      () => sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: 'x' })),
      err => { assert.ok(err.name === 'MissingParameter' || /MessageGroupId/.test(err.message || ''), `${err.name}: ${err.message}`); return true; }
    );
  });

  it('assigns increasing SequenceNumbers and preserves per-group order', async () => {
    const url = await makeFifo('orders.fifo');
    const s1 = await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: 'm1', MessageGroupId: 'g1', MessageDeduplicationId: 'd1' }));
    const s2 = await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: 'm2', MessageGroupId: 'g1', MessageDeduplicationId: 'd2' }));
    assert.ok(s1.SequenceNumber);
    assert.ok(BigInt(s2.SequenceNumber) > BigInt(s1.SequenceNumber));

    // The group is locked to one in-flight message: first receive yields only m1.
    const r1 = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10 }));
    assert.equal(r1.Messages.length, 1);
    assert.equal(r1.Messages[0].Body, 'm1');
    await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: r1.Messages[0].ReceiptHandle }));

    // Only after deleting m1 does m2 become available — in order.
    const r2 = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10 }));
    assert.equal(r2.Messages.length, 1);
    assert.equal(r2.Messages[0].Body, 'm2');
  });

  it('delivers different message groups in parallel', async () => {
    const url = await makeFifo('multi.fifo');
    await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: 'a1', MessageGroupId: 'A', MessageDeduplicationId: 'a1' }));
    await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: 'b1', MessageGroupId: 'B', MessageDeduplicationId: 'b1' }));
    const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10 }));
    assert.deepEqual(r.Messages.map(m => m.Body).sort(), ['a1', 'b1']);
  });

  it('deduplicates by content when ContentBasedDeduplication is enabled', async () => {
    const url = await makeFifo('dedup.fifo', { ContentBasedDeduplication: 'true' });
    const s1 = await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: 'same', MessageGroupId: 'g' }));
    const s2 = await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: 'same', MessageGroupId: 'g' }));
    assert.equal(s1.MessageId, s2.MessageId); // duplicate collapsed to the original
    const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10 }));
    assert.equal(r.Messages.length, 1);
  });
});
