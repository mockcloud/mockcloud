// tests/sqs.test.js
// Covers both wire formats SQS clients use:
//   - form-encoded (AWS SDK v2 / classic CLI)
//   - JSON with X-Amz-Target: AmazonSQS.<Op> (AWS SDK v3 / Terraform v5+)

import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { awsForm, awsJson, xmlValue } from './helpers/http.js';

let server;
const sqsForm = (action, params) => awsForm(server.endpoint, action, params, { version: '2012-11-05' });
const sqsJson = (op, payload) => awsJson(server.endpoint, `AmazonSQS.${op}`, payload);

beforeAll(async () => { server = await startServer(); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

describe('SQS form-encoded protocol', () => {
  it('CreateQueue returns a QueueUrl', async () => {
    const res = await sqsForm('CreateQueue', { QueueName: 'q1' });
    assert.equal(res.status, 200);
    const url = xmlValue(res.body, 'QueueUrl');
    assert.ok(url, 'should return a QueueUrl');
    assert.match(url, /q1$/);
  });

  it('SendMessage and ReceiveMessage round-trip', async () => {
    const create = await sqsForm('CreateQueue', { QueueName: 'rt' });
    const url = xmlValue(create.body, 'QueueUrl');

    await sqsForm('SendMessage', { QueueUrl: url, MessageBody: 'hello' });
    const recv = await sqsForm('ReceiveMessage', { QueueUrl: url });
    assert.equal(recv.status, 200);
    const body = xmlValue(recv.body, 'Body');
    assert.equal(body, 'hello');
  });

  it('Body is escaped for XML-unsafe chars', async () => {
    const create = await sqsForm('CreateQueue', { QueueName: 'esc' });
    const url = xmlValue(create.body, 'QueueUrl');
    await sqsForm('SendMessage', { QueueUrl: url, MessageBody: '<a>&"b"' });
    const recv = await sqsForm('ReceiveMessage', { QueueUrl: url });
    assert.match(recv.body, /&lt;a&gt;&amp;&quot;b&quot;/);
  });

  it('DeleteMessage drops the message', async () => {
    const create = await sqsForm('CreateQueue', { QueueName: 'd' });
    const url = xmlValue(create.body, 'QueueUrl');
    await sqsForm('SendMessage', { QueueUrl: url, MessageBody: 'x' });
    const recv = await sqsForm('ReceiveMessage', { QueueUrl: url });
    const handle = xmlValue(recv.body, 'ReceiptHandle');
    await sqsForm('DeleteMessage', { QueueUrl: url, ReceiptHandle: handle });

    // Without the visibility-timer cancellation fix, the deleted message could
    // resurface here as visible after 30s — but more importantly,
    // GetQueueAttributes should now report 0 messages.
    const attrs = await sqsForm('GetQueueAttributes', { QueueUrl: url });
    const visible = xmlValue(attrs.body, 'Value'); // first <Value> is QueueArn — so check by name
    assert.match(attrs.body, /<Name>ApproximateNumberOfMessages<\/Name><Value>0</);
    void visible;
  });

  it('PurgeQueue empties the queue', async () => {
    const create = await sqsForm('CreateQueue', { QueueName: 'pq' });
    const url = xmlValue(create.body, 'QueueUrl');
    await sqsForm('SendMessage', { QueueUrl: url, MessageBody: 'x' });
    await sqsForm('SendMessage', { QueueUrl: url, MessageBody: 'y' });
    await sqsForm('PurgeQueue', { QueueUrl: url });
    const attrs = await sqsForm('GetQueueAttributes', { QueueUrl: url });
    assert.match(attrs.body, /<Name>ApproximateNumberOfMessages<\/Name><Value>0</);
  });

  it('Operations on missing queue 400', async () => {
    const res = await sqsForm('SendMessage', { QueueUrl: 'http://localhost:4566/000000000000/nope', MessageBody: 'x' });
    assert.equal(res.status, 400);
    assert.match(res.body, /NonExistentQueue/);
  });
});

describe('SQS JSON protocol (AmazonSQS.*)', () => {
  it('CreateQueue → SendMessage → ReceiveMessage round-trip', async () => {
    const create = await sqsJson('CreateQueue', { QueueName: 'jq' });
    assert.equal(create.status, 200);
    assert.ok(create.body.QueueUrl);

    const send = await sqsJson('SendMessage', { QueueUrl: create.body.QueueUrl, MessageBody: 'json-hello' });
    assert.equal(send.status, 200);
    assert.ok(send.body.MessageId);

    const recv = await sqsJson('ReceiveMessage', { QueueUrl: create.body.QueueUrl });
    assert.equal(recv.status, 200);
    assert.equal(recv.body.Messages.length, 1);
    assert.equal(recv.body.Messages[0].Body, 'json-hello');
  });

  it('GetQueueAttributes returns SQS managed defaults', async () => {
    const create = await sqsJson('CreateQueue', { QueueName: 'attrs' });
    const attrs = await sqsJson('GetQueueAttributes', { QueueUrl: create.body.QueueUrl });
    assert.equal(attrs.body.Attributes.VisibilityTimeout, '30');
    assert.equal(attrs.body.Attributes.MaximumMessageSize, '262144');
    assert.ok(attrs.body.Attributes.QueueArn);
  });

  it('FIFO suffix is honored (queue type=fifo)', async () => {
    const create = await sqsJson('CreateQueue', { QueueName: 'orders.fifo' });
    assert.ok(create.body.QueueUrl.endsWith('orders.fifo'));
  });
});
