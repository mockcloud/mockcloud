// tests/s3-notifications.test.js
// S3 bucket notifications fan out to SQS, SNS, and Lambda. End-to-end: configure
// a notification, PUT an object, then observe the event arriving at the target
// through the AWS SDK. Delivery is async, so each test waits briefly first.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  CreateBucketCommand,
  PutObjectCommand,
  PutBucketNotificationConfigurationCommand,
  GetBucketNotificationConfigurationCommand,
} from '@aws-sdk/client-s3';
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { CreateTopicCommand, SubscribeCommand } from '@aws-sdk/client-sns';
import { CreateFunctionCommand } from '@aws-sdk/client-lambda';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';

let server, s3, sqs, sns, lambda;
let n = 0;
const freshBucket = () => `notif-bkt-${Date.now()}-${++n}`;
const wait = ms => new Promise(r => setTimeout(r, ms));

beforeAll(async () => {
  server = await startServer();
  ({ s3, sqs, sns, lambda } = makeClients(server.endpoint));
});
afterAll(() => server.close());
beforeEach(() => server.resetStore());

describe('S3 bucket notifications', () => {
  it('round-trips a notification configuration', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const queueArn = 'arn:aws:sqs:us-east-1:000000000000:rt-queue';
    await s3.send(new PutBucketNotificationConfigurationCommand({
      Bucket: bucket,
      NotificationConfiguration: { QueueConfigurations: [{ QueueArn: queueArn, Events: ['s3:ObjectCreated:*'] }] },
    }));
    const got = await s3.send(new GetBucketNotificationConfigurationCommand({ Bucket: bucket }));
    assert.equal(got.QueueConfigurations.length, 1);
    assert.equal(got.QueueConfigurations[0].QueueArn, queueArn);
    assert.deepEqual(got.QueueConfigurations[0].Events, ['s3:ObjectCreated:*']);
  });

  it('delivers an S3 event to SQS on object create', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: 'evt-q' }));
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }));

    await s3.send(new PutBucketNotificationConfigurationCommand({
      Bucket: bucket,
      NotificationConfiguration: { QueueConfigurations: [{ QueueArn: Attributes.QueueArn, Events: ['s3:ObjectCreated:*'] }] },
    }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'photo.jpg', Body: Buffer.from('data') }));
    await wait(120);

    const recv = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 }));
    assert.equal(recv.Messages?.length, 1);
    const event = JSON.parse(recv.Messages[0].Body);
    assert.equal(event.Records[0].eventName, 'ObjectCreated:Put');
    assert.equal(event.Records[0].s3.bucket.name, bucket);
    assert.equal(event.Records[0].s3.object.key, 'photo.jpg');
  });

  it('honors prefix/suffix filters', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: 'filt-q' }));
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }));
    await s3.send(new PutBucketNotificationConfigurationCommand({
      Bucket: bucket,
      NotificationConfiguration: { QueueConfigurations: [{
        QueueArn: Attributes.QueueArn,
        Events: ['s3:ObjectCreated:*'],
        Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'images/' }, { Name: 'suffix', Value: '.jpg' }] } },
      }] },
    }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'docs/readme.txt', Body: Buffer.from('x') })); // filtered out
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'images/cat.jpg', Body: Buffer.from('y') }));  // matches
    await wait(120);

    const recv = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 }));
    assert.equal(recv.Messages?.length, 1);
    assert.equal(JSON.parse(recv.Messages[0].Body).Records[0].s3.object.key, 'images/cat.jpg');
  });

  it('fans out to SNS (delivered to a subscribed SQS queue)', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: 'evt-topic' }));
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: 'sns-q' }));
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }));
    await sns.send(new SubscribeCommand({ TopicArn, Protocol: 'sqs', Endpoint: Attributes.QueueArn }));

    await s3.send(new PutBucketNotificationConfigurationCommand({
      Bucket: bucket,
      NotificationConfiguration: { TopicConfigurations: [{ TopicArn, Events: ['s3:ObjectCreated:*'] }] },
    }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'k', Body: Buffer.from('z') }));
    await wait(150);

    const recv = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 }));
    assert.equal(recv.Messages?.length, 1);
    const envelope = JSON.parse(recv.Messages[0].Body);
    assert.equal(envelope.Type, 'Notification');
    assert.equal(JSON.parse(envelope.Message).Records[0].s3.object.key, 'k');
  });

  it('invokes a Lambda function', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const { FunctionArn } = await lambda.send(new CreateFunctionCommand({
      FunctionName: 'evt-fn',
      Runtime: 'nodejs20.x',
      Role: 'arn:aws:iam::000000000000:role/x',
      Handler: 'index.handler',
      Code: { ZipFile: Buffer.from('exports.handler = async (e) => e;') },
    }));
    await s3.send(new PutBucketNotificationConfigurationCommand({
      Bucket: bucket,
      NotificationConfiguration: { LambdaFunctionConfigurations: [{ LambdaFunctionArn: FunctionArn, Events: ['s3:ObjectCreated:*'] }] },
    }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'k', Body: Buffer.from('z') }));
    await wait(150);

    const { functions } = await (await fetch(server.endpoint + '/mockcloud/lambda/functions')).json();
    const fn = functions.find(f => f.name === 'evt-fn');
    assert.ok(fn && fn.invocations >= 1, `expected evt-fn to be invoked, got ${fn?.invocations}`);
  });
});
