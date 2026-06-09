// tests/logs.test.js — CloudWatch Logs via @aws-sdk/client-cloudwatch-logs,
// including Lambda execution logs routed to /aws/lambda/<fn>.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  CreateLogGroupCommand, CreateLogStreamCommand, PutLogEventsCommand,
  GetLogEventsCommand, FilterLogEventsCommand, DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { CreateFunctionCommand, InvokeCommand } from '@aws-sdk/client-lambda';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';

let server, logs, lambda;
beforeAll(async () => { server = await startServer(); ({ logs, lambda } = makeClients(server.endpoint)); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

describe('CloudWatch Logs', () => {
  it('put / get / filter / describe round-trip', async () => {
    await logs.send(new CreateLogGroupCommand({ logGroupName: '/app' }));
    await logs.send(new CreateLogStreamCommand({ logGroupName: '/app', logStreamName: 's1' }));
    const t = Date.now();
    await logs.send(new PutLogEventsCommand({ logGroupName: '/app', logStreamName: 's1', logEvents: [
      { timestamp: t, message: 'hello world' },
      { timestamp: t + 1, message: 'goodbye' },
    ] }));

    const got = await logs.send(new GetLogEventsCommand({ logGroupName: '/app', logStreamName: 's1' }));
    assert.equal(got.events.length, 2);
    assert.equal(got.events[0].message, 'hello world');   // ordered by timestamp

    const filtered = await logs.send(new FilterLogEventsCommand({ logGroupName: '/app', filterPattern: 'goodbye' }));
    assert.equal(filtered.events.length, 1);
    assert.equal(filtered.events[0].logStreamName, 's1');

    const groups = await logs.send(new DescribeLogGroupsCommand({}));
    assert.ok(groups.logGroups.some(g => g.logGroupName === '/app'));
  });

  it('routes Lambda execution logs to /aws/lambda/<fn>', async () => {
    await lambda.send(new CreateFunctionCommand({
      FunctionName: 'logged', Runtime: 'nodejs20.x', Role: 'arn:aws:iam::000000000000:role/x',
      Handler: 'index.handler', Code: { ZipFile: Buffer.from('exports.handler = async () => "ok";') },
    }));
    await lambda.send(new InvokeCommand({ FunctionName: 'logged' }));

    const filtered = await logs.send(new FilterLogEventsCommand({ logGroupName: '/aws/lambda/logged' }));
    assert.ok(filtered.events.some(e => /START RequestId/.test(e.message)), 'should log START');
    assert.ok(filtered.events.some(e => /END Duration/.test(e.message)), 'should log END');
  });
});
