// tests/lambda-esm.test.js
// SQS → Lambda event-source-mapping: the background poller auto-invokes the
// function with queue messages, deletes on success, and redrives to a DLQ on
// repeated failure. Uses a bounded wait on the observable effect (the poller
// runs on a fast interval in tests) — no fixed sleeps.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand,
  SendMessageCommand, ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { CreateFunctionCommand, CreateEventSourceMappingCommand } from '@aws-sdk/client-lambda';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';

let server, sqs, lambda;
beforeAll(async () => { server = await startServer(); ({ sqs, lambda } = makeClients(server.endpoint)); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

async function waitFor(check, { timeout = 4000, interval = 25 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return true; await new Promise(r => setTimeout(r, interval)); }
  return false;
}
const invocations = async name =>
  (await (await fetch(server.endpoint + '/mockcloud/lambda/functions')).json())
    .functions.find(f => f.name === name)?.invocations || 0;
const createFn = (name, code) => lambda.send(new CreateFunctionCommand({
  FunctionName: name, Runtime: 'nodejs20.x', Role: 'arn:aws:iam::000000000000:role/x',
  Handler: 'index.handler', Code: { ZipFile: Buffer.from(code) },
}));

describe('SQS → Lambda event-source-mapping', () => {
  it('auto-invokes the function and deletes the message on success', async () => {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: 'esm-q' }));
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }));
    await createFn('esm-fn', 'exports.handler = async (e) => e.Records.length;');
    await lambda.send(new CreateEventSourceMappingCommand({ FunctionName: 'esm-fn', EventSourceArn: Attributes.QueueArn, BatchSize: 10 }));

    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'hello' }));

    assert.ok(await waitFor(async () => (await invocations('esm-fn')) >= 1), 'function should be auto-invoked');
    assert.ok(await waitFor(async () => {
      const left = await sqs.send(new ReceiveMessageCommand({ QueueUrl, VisibilityTimeout: 0 }));
      return !left.Messages || left.Messages.length === 0;
    }), 'message should be deleted after a successful invoke');
  });

  it('redrives to the DLQ when the function keeps failing', async () => {
    const { QueueUrl: dlq } = await sqs.send(new CreateQueueCommand({ QueueName: 'esm-dlq' }));
    const { Attributes: dlqA } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }));
    const { QueueUrl: src } = await sqs.send(new CreateQueueCommand({ QueueName: 'esm-src' }));
    const { Attributes: srcA } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: src, AttributeNames: ['QueueArn'] }));
    await sqs.send(new SetQueueAttributesCommand({
      QueueUrl: src,
      Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqA.QueueArn, maxReceiveCount: 1 }) },
    }));
    await createFn('bad-fn', 'exports.handler = async () => { throw new Error("boom"); };');
    await lambda.send(new CreateEventSourceMappingCommand({ FunctionName: 'bad-fn', EventSourceArn: srcA.QueueArn, BatchSize: 1 }));

    await sqs.send(new SendMessageCommand({ QueueUrl: src, MessageBody: 'poison' }));

    assert.ok(await waitFor(async () => {
      const onDlq = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, VisibilityTimeout: 0 }));
      return onDlq.Messages?.some(m => m.Body === 'poison');
    }), 'failing message should land in the DLQ');
  });
});
