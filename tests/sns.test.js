// tests/sns.test.js
// SNS uses the form-encoded "query" protocol — the same shape as classic
// EC2/SQS. We assert on XML fragments to keep the test deps minimal.

import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { awsForm, xmlValue, xmlValues, unescapeXml } from './helpers/http.js';

let server;
const sns = (action, params) => awsForm(server.endpoint, action, params, { version: '2010-03-31' });

beforeAll(async () => { server = await startServer(); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

describe('Topic CRUD', () => {
  it('CreateTopic returns a TopicArn', async () => {
    const res = await sns('CreateTopic', { Name: 'orders' });
    assert.equal(res.status, 200);
    const arn = xmlValue(res.body, 'TopicArn');
    assert.match(arn, /:sns:.*:orders$/);
  });

  it('CreateTopic is idempotent (same name → same ARN)', async () => {
    const a = xmlValue((await sns('CreateTopic', { Name: 'idem' })).body, 'TopicArn');
    const b = xmlValue((await sns('CreateTopic', { Name: 'idem' })).body, 'TopicArn');
    assert.equal(a, b);
  });

  it('ListTopics returns created topics', async () => {
    await sns('CreateTopic', { Name: 't1' });
    await sns('CreateTopic', { Name: 't2' });
    const list = await sns('ListTopics', {});
    const arns = xmlValues(list.body, 'TopicArn');
    assert.ok(arns.find(a => a.endsWith(':t1')));
    assert.ok(arns.find(a => a.endsWith(':t2')));
  });

  it('DeleteTopic removes the topic', async () => {
    const arn = xmlValue((await sns('CreateTopic', { Name: 'gone' })).body, 'TopicArn');
    await sns('DeleteTopic', { TopicArn: arn });
    const list = await sns('ListTopics', {});
    const arns = xmlValues(list.body, 'TopicArn');
    assert.ok(!arns.includes(arn));
  });
});

describe('Subscriptions and Publish', () => {
  it('Subscribe returns a SubscriptionArn', async () => {
    const arn = xmlValue((await sns('CreateTopic', { Name: 'sub-test' })).body, 'TopicArn');
    const sub = await sns('Subscribe', { TopicArn: arn, Protocol: 'sqs', Endpoint: 'arn:aws:sqs:us-east-1:000000000000:q' });
    assert.equal(sub.status, 200);
    const subArn = xmlValue(sub.body, 'SubscriptionArn');
    assert.ok(subArn.startsWith(arn + ':'));
  });

  it('Publish on missing topic returns 404', async () => {
    const res = await sns('Publish', { TopicArn: 'arn:aws:sns:us-east-1:000000000000:nope', Message: 'x' });
    assert.equal(res.status, 404);
    assert.match(res.body, /NotFound/);
  });

  it('Publish returns a MessageId', async () => {
    const arn = xmlValue((await sns('CreateTopic', { Name: 'pub' })).body, 'TopicArn');
    const res = await sns('Publish', { TopicArn: arn, Message: 'hello' });
    assert.equal(res.status, 200);
    const msgId = xmlValue(res.body, 'MessageId');
    assert.ok(msgId);
  });

  it('Unsubscribe removes the subscription', async () => {
    const arn = xmlValue((await sns('CreateTopic', { Name: 'unsub' })).body, 'TopicArn');
    const subArn = xmlValue((await sns('Subscribe', { TopicArn: arn, Protocol: 'lambda', Endpoint: 'arn:aws:lambda:us-east-1:000000000000:function:f' })).body, 'SubscriptionArn');
    await sns('Unsubscribe', { SubscriptionArn: subArn });
    const list = await sns('ListSubscriptions', {});
    const subs = xmlValues(list.body, 'SubscriptionArn');
    assert.ok(!subs.includes(subArn));
  });
});

describe('SNS → SQS fan-out', () => {
  it('publishing on a topic with an SQS subscription enqueues a message', async () => {
    // Create the SQS queue first
    const createQ = await awsForm(server.endpoint, 'CreateQueue', { QueueName: 'sub-q' }, { version: '2012-11-05' });
    const queueUrl = xmlValue(createQ.body, 'QueueUrl');
    assert.ok(queueUrl);

    // Subscribe its ARN to a new topic
    const topicArn = xmlValue((await sns('CreateTopic', { Name: 'fanout' })).body, 'TopicArn');
    const queueArn = 'arn:aws:sqs:us-east-1:000000000000:sub-q';
    await sns('Subscribe', { TopicArn: topicArn, Protocol: 'sqs', Endpoint: queueArn });

    // Publish — fan-out is async (fire-and-forget), so wait briefly
    await sns('Publish', { TopicArn: topicArn, Message: 'fanout-payload' });
    await new Promise(r => setTimeout(r, 50));

    const recv = await awsForm(server.endpoint, 'ReceiveMessage', { QueueUrl: queueUrl }, { version: '2012-11-05' });
    const bodyEscaped = xmlValue(recv.body, 'Body');
    assert.ok(bodyEscaped, 'queue should have received an envelope');
    const envelope = JSON.parse(unescapeXml(bodyEscaped));
    assert.equal(envelope.Type, 'Notification');
    assert.equal(envelope.Message, 'fanout-payload');
    assert.equal(envelope.TopicArn, topicArn);
  });
});
