// tests/sqs-dlq.test.js
// Dead-letter redrive + ApproximateReceiveCount via @aws-sdk/client-sqs.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand,
  SendMessageCommand, ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';

let server, sqs;
beforeAll(async () => { server = await startServer(); ({ sqs } = makeClients(server.endpoint)); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

describe('SQS DLQ + ApproximateReceiveCount', () => {
  it('tracks receive count and redrives to the DLQ after maxReceiveCount', async () => {
    const { QueueUrl: dlq } = await sqs.send(new CreateQueueCommand({ QueueName: 'dlq' }));
    const { Attributes: dlqAttrs } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }));
    const { QueueUrl: src } = await sqs.send(new CreateQueueCommand({ QueueName: 'src' }));
    await sqs.send(new SetQueueAttributesCommand({
      QueueUrl: src,
      Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqAttrs.QueueArn, maxReceiveCount: 2 }) },
    }));

    await sqs.send(new SendMessageCommand({ QueueUrl: src, MessageBody: 'hi' }));

    // Receive twice (count 1, 2) with immediate re-visibility.
    const r1 = await sqs.send(new ReceiveMessageCommand({ QueueUrl: src, VisibilityTimeout: 0, MessageSystemAttributeNames: ['All'] }));
    assert.equal(r1.Messages?.length, 1);
    assert.equal(r1.Messages[0].Attributes.ApproximateReceiveCount, '1');
    const r2 = await sqs.send(new ReceiveMessageCommand({ QueueUrl: src, VisibilityTimeout: 0, MessageSystemAttributeNames: ['All'] }));
    assert.equal(r2.Messages[0].Attributes.ApproximateReceiveCount, '2');

    // Next receive → message has hit maxReceiveCount → moved to the DLQ.
    const r3 = await sqs.send(new ReceiveMessageCommand({ QueueUrl: src }));
    assert.ok(!r3.Messages || r3.Messages.length === 0);

    const onDlq = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq }));
    assert.equal(onDlq.Messages?.length, 1);
    assert.equal(onDlq.Messages[0].Body, 'hi');
  });
});
