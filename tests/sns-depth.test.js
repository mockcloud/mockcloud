// tests/sns-depth.test.js
// SNS messaging depth via @aws-sdk/client-sns + @aws-sdk/client-sqs:
// MessageAttributes carried in the SNS→SQS envelope, FilterPolicy match vs
// non-match, RawMessageDelivery (bare body), and PublishBatch fan-out.
// SNS fan-out is fire-and-forget, so assertions use bounded waits.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  CreateTopicCommand, SubscribeCommand, PublishCommand, PublishBatchCommand,
  SetSubscriptionAttributesCommand,
} from '@aws-sdk/client-sns';
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';

let server, sns, sqs;
beforeAll(async () => { server = await startServer(); ({ sns, sqs } = makeClients(server.endpoint)); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

async function waitFor(check, { timeout = 4000, interval = 25 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const v = await check(); if (v) return v; await new Promise(r => setTimeout(r, interval)); }
  return null;
}

// Collect every message body that lands on a queue over a short window.
async function drainBodies(QueueUrl, { window = 600 } = {}) {
  const bodies = [];
  const end = Date.now() + window;
  while (Date.now() < end) {
    const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, VisibilityTimeout: 0, WaitTimeSeconds: 0 }));
    for (const m of r.Messages || []) bodies.push(m.Body);
    await new Promise(r => setTimeout(r, 25));
  }
  return bodies;
}

async function makeQueue(name) {
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: name }));
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }));
  return { QueueUrl, QueueArn: Attributes.QueueArn };
}
const makeTopic = async name => (await sns.send(new CreateTopicCommand({ Name: name }))).TopicArn;

describe('SNS messaging depth', () => {
  it('carries MessageAttributes in the SNS→SQS envelope', async () => {
    const { QueueUrl, QueueArn } = await makeQueue('attr-q');
    const TopicArn = await makeTopic('attr-topic');
    await sns.send(new SubscribeCommand({ TopicArn, Protocol: 'sqs', Endpoint: QueueArn }));

    await sns.send(new PublishCommand({
      TopicArn, Message: 'with-attrs',
      MessageAttributes: { source: { DataType: 'String', StringValue: 'unit-test' } },
    }));

    const env = await waitFor(async () => {
      const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl, VisibilityTimeout: 0 }));
      const body = r.Messages?.[0]?.Body;
      return body ? JSON.parse(body) : null;
    });
    assert.ok(env, 'queue should receive the SNS envelope');
    assert.equal(env.Type, 'Notification');
    assert.equal(env.Message, 'with-attrs');
    assert.equal(env.MessageAttributes.source.Type, 'String');
    assert.equal(env.MessageAttributes.source.Value, 'unit-test');
  });

  it('FilterPolicy delivers matching messages and drops non-matching ones', async () => {
    const { QueueUrl, QueueArn } = await makeQueue('filter-q');
    const TopicArn = await makeTopic('filter-topic');
    await sns.send(new SubscribeCommand({
      TopicArn, Protocol: 'sqs', Endpoint: QueueArn,
      Attributes: { FilterPolicy: JSON.stringify({ eventType: ['order_placed'] }) },
    }));

    // Publish a non-matching message first, then a matching one.
    await sns.send(new PublishCommand({
      TopicArn, Message: 'cancel-payload',
      MessageAttributes: { eventType: { DataType: 'String', StringValue: 'order_cancelled' } },
    }));
    await sns.send(new PublishCommand({
      TopicArn, Message: 'placed-payload',
      MessageAttributes: { eventType: { DataType: 'String', StringValue: 'order_placed' } },
    }));

    const messages = (await drainBodies(QueueUrl)).map(b => JSON.parse(b).Message);
    assert.ok(messages.includes('placed-payload'), 'matching message should be delivered');
    assert.ok(!messages.includes('cancel-payload'), 'non-matching message should be filtered out');
  });

  it('RawMessageDelivery enqueues the bare message body', async () => {
    const { QueueUrl, QueueArn } = await makeQueue('raw-q');
    const TopicArn = await makeTopic('raw-topic');
    const { SubscriptionArn } = await sns.send(new SubscribeCommand({ TopicArn, Protocol: 'sqs', Endpoint: QueueArn }));
    await sns.send(new SetSubscriptionAttributesCommand({
      SubscriptionArn, AttributeName: 'RawMessageDelivery', AttributeValue: 'true',
    }));

    await sns.send(new PublishCommand({ TopicArn, Message: 'raw-body-here' }));

    const body = await waitFor(async () => {
      const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl, VisibilityTimeout: 0 }));
      return r.Messages?.[0]?.Body || null;
    });
    assert.equal(body, 'raw-body-here', 'raw delivery should bypass the JSON envelope');
  });

  it('PublishBatch fans every entry out to subscribers', async () => {
    const { QueueUrl, QueueArn } = await makeQueue('batch-q');
    const TopicArn = await makeTopic('batch-topic');
    await sns.send(new SubscribeCommand({ TopicArn, Protocol: 'sqs', Endpoint: QueueArn }));

    const res = await sns.send(new PublishBatchCommand({
      TopicArn,
      PublishBatchRequestEntries: [
        { Id: 'a', Message: 'first' },
        { Id: 'b', Message: 'second' },
        { Id: 'c', Message: 'third' },
      ],
    }));
    assert.equal(res.Successful.length, 3);

    const seen = new Set();
    await waitFor(async () => {
      for (const b of await drainBodies(QueueUrl, { window: 200 })) seen.add(JSON.parse(b).Message);
      return seen.size === 3;
    });
    assert.deepEqual([...seen].sort(), ['first', 'second', 'third']);
  });
});
