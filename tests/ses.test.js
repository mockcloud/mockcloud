// tests/ses.test.js
// SES emulator: outbound SendEmail (query protocol — the ses SDK isn't a
// dev-dep, so we hit the wire) and control-plane-driven inbound receipt rules
// that fan an email out to S3, SNS→SQS, and Lambda.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { CreateBucketCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { CreateTopicCommand, SubscribeCommand } from '@aws-sdk/client-sns';
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { CreateFunctionCommand } from '@aws-sdk/client-lambda';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';
import { awsForm, xmlValue } from './helpers/http.js';

let server, s3, sns, sqs, lambda;
beforeAll(async () => { server = await startServer(); ({ s3, sns, sqs, lambda } = makeClients(server.endpoint)); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

async function waitFor(check, { timeout = 4000, interval = 25 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const v = await check(); if (v) return v; await new Promise(r => setTimeout(r, interval)); }
  return null;
}
const sesForm = (action, params) => awsForm(server.endpoint, action, params, { version: '2010-12-01' });
const control = (method, path, payload) => fetch(server.endpoint + path, {
  method, headers: { 'Content-Type': 'application/json' },
  body: payload === undefined ? undefined : JSON.stringify(payload),
});
const invocations = async name =>
  (await (await fetch(server.endpoint + '/mockcloud/lambda/functions')).json())
    .functions.find(f => f.name === name)?.invocations || 0;

describe('SES outbound', () => {
  it('SendEmail records the message and returns a MessageId', async () => {
    const res = await sesForm('SendEmail', {
      Source: 'sender@example.com',
      'Destination.ToAddresses.member.1': 'rcpt@example.com',
      'Message.Subject.Data': 'Hi',
      'Message.Body.Text.Data': 'Hello body',
    });
    assert.equal(res.status, 200);
    assert.ok(xmlValue(res.body, 'MessageId'));

    const list = await (await control('GET', '/mockcloud/ses/emails')).json();
    assert.equal(list.total, 1);
    assert.equal(list.emails[0].subject, 'Hi');
  });
});

describe('SES inbound receipt rules', () => {
  it('fans an inbound email out to S3, SNS→SQS, and Lambda', async () => {
    // Targets: an S3 bucket, an SNS topic with an SQS subscriber, a Lambda fn.
    await s3.send(new CreateBucketCommand({ Bucket: 'ses-inbound' }));

    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: 'ses-q' }));
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }));
    const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: 'ses-topic' }));
    await sns.send(new SubscribeCommand({ TopicArn, Protocol: 'sqs', Endpoint: Attributes.QueueArn }));

    await lambda.send(new CreateFunctionCommand({
      FunctionName: 'ses-fn', Runtime: 'nodejs20.x', Role: 'arn:aws:iam::000000000000:role/x',
      Handler: 'index.handler', Code: { ZipFile: Buffer.from('exports.handler = async (e) => e.Records.length;') },
    }));
    const functionArn = 'arn:aws:lambda:us-east-1:000000000000:function:ses-fn';

    // A receipt rule scoped to example.com running all three actions.
    const rule = await control('POST', '/mockcloud/ses/receipt-rules', {
      name: 'r1',
      recipients: ['example.com'],
      actions: [
        { type: 's3', bucket: 'ses-inbound', objectKeyPrefix: 'incoming/' },
        { type: 'sns', topicArn: TopicArn },
        { type: 'lambda', functionArn },
      ],
    });
    assert.equal(rule.status, 201);

    // Deliver an inbound message.
    const inbound = await (await control('POST', '/mockcloud/ses/inbound', {
      from: 'outsider@somewhere.com', to: ['user@example.com'], subject: 'Inbound!', body: 'hi there',
    })).json();
    assert.deepEqual(inbound.matched, ['r1']);

    // S3 action wrote the raw email under the prefix.
    const objs = await s3.send(new ListObjectsV2Command({ Bucket: 'ses-inbound', Prefix: 'incoming/' }));
    assert.equal(objs.KeyCount, 1);
    assert.equal(objs.Contents[0].Key, `incoming/${inbound.messageId}`);

    // SNS action fanned a Received notification out to the SQS subscriber.
    const env = await waitFor(async () => {
      const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl, VisibilityTimeout: 0 }));
      return r.Messages?.[0]?.Body ? JSON.parse(r.Messages[0].Body) : null;
    });
    assert.ok(env, 'SQS subscriber should receive the SNS envelope');
    assert.equal(JSON.parse(env.Message).notificationType, 'Received');

    // Lambda action invoked the function.
    assert.ok(await waitFor(async () => (await invocations('ses-fn')) >= 1), 'Lambda action should invoke the function');
  });

  it('does not deliver when the recipient does not match', async () => {
    await control('POST', '/mockcloud/ses/receipt-rules', {
      name: 'only-acme', recipients: ['acme.com'], actions: [],
    });
    const inbound = await (await control('POST', '/mockcloud/ses/inbound', {
      from: 'x@y.com', to: ['user@example.com'], subject: 's', body: 'b',
    })).json();
    assert.deepEqual(inbound.matched, []);
  });
});
