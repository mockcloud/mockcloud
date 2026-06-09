// tests/eventbridge-schedule.test.js
// EventBridge scheduled rules fire on a timer; PutEvents routes matched events
// to targets. EventBridge control plane is driven at the wire level (no SDK
// client installed); SQS targets are asserted via the SDK.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';
import { awsJson } from './helpers/http.js';
import { fireDueSchedulesOnce } from '../src/services/eventbridge.js';

let server, sqs;
beforeAll(async () => { server = await startServer(); ({ sqs } = makeClients(server.endpoint)); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

const eb = (op, payload) => awsJson(server.endpoint, `AmazonEventBridge.${op}`, payload);
async function queueArn(QueueUrl) {
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }));
  return Attributes.QueueArn;
}
async function waitForMessage(QueueUrl, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, VisibilityTimeout: 0 }));
    if (r.Messages?.length) return r.Messages;
    await new Promise(res => setTimeout(res, 25));
  }
  return [];
}

describe('EventBridge scheduled rules', () => {
  it('fires a rate() schedule to its SQS target', async () => {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: 'sched-q' }));
    await eb('PutRule', { Name: 'tick', ScheduleExpression: 'rate(1 minute)' });
    await eb('PutTargets', { Rule: 'tick', Targets: [{ Id: '1', Arn: await queueArn(QueueUrl) }] });

    await fireDueSchedulesOnce(Date.now() + 61_000);  // jump past the 1-minute boundary

    const recv = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 }));
    assert.equal(recv.Messages?.length, 1);
    const evt = JSON.parse(recv.Messages[0].Body);
    assert.equal(evt.source, 'aws.events');
    assert.equal(evt['detail-type'], 'Scheduled Event');
  });

  it('does not fire a disabled schedule', async () => {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: 'sched-off' }));
    await eb('PutRule', { Name: 'off', ScheduleExpression: 'rate(1 minute)', State: 'DISABLED' });
    await eb('PutTargets', { Rule: 'off', Targets: [{ Id: '1', Arn: await queueArn(QueueUrl) }] });
    await fireDueSchedulesOnce(Date.now() + 61_000);
    const recv = await sqs.send(new ReceiveMessageCommand({ QueueUrl }));
    assert.ok(!recv.Messages || recv.Messages.length === 0);
  });

  it('routes a matched PutEvents to an SQS target', async () => {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: 'evt-q' }));
    await eb('PutRule', { Name: 'orders', EventPattern: JSON.stringify({ source: ['my.app'], 'detail-type': ['Order'] }) });
    await eb('PutTargets', { Rule: 'orders', Targets: [{ Id: '1', Arn: await queueArn(QueueUrl) }] });
    await eb('PutEvents', { Entries: [{ Source: 'my.app', 'detail-type': 'Order', Detail: JSON.stringify({ id: 1 }) }] });

    const msgs = await waitForMessage(QueueUrl);
    assert.equal(msgs.length, 1);
    const evt = JSON.parse(msgs[0].Body);
    assert.equal(evt.source, 'my.app');
    assert.equal(evt.detail.id, 1);
  });
});
