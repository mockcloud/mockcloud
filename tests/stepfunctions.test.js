// tests/stepfunctions.test.js
// Step Functions emulator (JSON protocol, X-Amz-Target: AWSStepFunctions.*),
// exercised at the wire level (the sfn SDK isn't a dev-dep), plus the
// EventBridge → StartExecution target wiring. Async completion + event delivery
// are observed with bounded waits.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { awsJson } from './helpers/http.js';

let server;
const sfn = (op, payload) => awsJson(server.endpoint, `AWSStepFunctions.${op}`, payload);
const eb  = (op, payload) => awsJson(server.endpoint, `AmazonEventBridge.${op}`, payload);

beforeAll(async () => { server = await startServer(); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

async function waitFor(check, { timeout = 4000, interval = 25 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const v = await check(); if (v) return v; await new Promise(r => setTimeout(r, interval)); }
  return null;
}

const PASS_DEF = JSON.stringify({ Comment: 'x', StartAt: 'A', States: { A: { Type: 'Pass', End: true } } });

describe('Step Functions', () => {
  it('CreateStateMachine → StartExecution → completes', async () => {
    const create = await sfn('CreateStateMachine', { name: 'sm1', definition: PASS_DEF, roleArn: 'arn:aws:iam::000000000000:role/StatesRole' });
    assert.equal(create.status, 200);
    const smArn = create.body.stateMachineArn;
    assert.match(smArn, /:states:.*:stateMachine:sm1$/);

    const start = await sfn('StartExecution', { stateMachineArn: smArn, input: '{"k":1}' });
    assert.equal(start.status, 200);
    const execArn = start.body.executionArn;
    assert.ok(execArn);

    // Initially RUNNING, then SUCCEEDED after the simulated delay.
    const desc1 = await sfn('DescribeExecution', { executionArn: execArn });
    assert.equal(desc1.body.status, 'RUNNING');
    const done = await waitFor(async () => {
      const d = await sfn('DescribeExecution', { executionArn: execArn });
      return d.body.status === 'SUCCEEDED' ? d.body : null;
    });
    assert.ok(done, 'execution should reach SUCCEEDED');
    assert.equal(done.output, '{"k":1}');
  });

  it('ListStateMachines and ListExecutions reflect created resources', async () => {
    const { body: { stateMachineArn } } = await sfn('CreateStateMachine', { name: 'sm2', definition: PASS_DEF });
    await sfn('StartExecution', { stateMachineArn, input: '{}' });

    const list = await sfn('ListStateMachines', {});
    assert.ok(list.body.stateMachines.some(s => s.name === 'sm2'));
    const execs = await sfn('ListExecutions', { stateMachineArn });
    assert.equal(execs.body.executions.length, 1);
  });

  it('missing state machine 400s', async () => {
    const res = await sfn('StartExecution', { stateMachineArn: 'arn:aws:states:us-east-1:000000000000:stateMachine:nope', input: '{}' });
    assert.equal(res.status, 400);
    assert.match(res.body.__type, /StateMachineDoesNotExist/);
  });

  it('EventBridge rule with a state-machine target starts an execution', async () => {
    const { body: { stateMachineArn } } = await sfn('CreateStateMachine', { name: 'eb-sfn', definition: PASS_DEF });

    await eb('PutRule', { Name: 'to-sfn', EventPattern: JSON.stringify({ source: ['my.app'] }) });
    await eb('PutTargets', { Rule: 'to-sfn', Targets: [{ Id: '1', Arn: stateMachineArn }] });
    await eb('PutEvents', { Entries: [{ Source: 'my.app', DetailType: 'thing', Detail: JSON.stringify({ hi: true }) }] });

    const execs = await waitFor(async () => {
      const r = await sfn('ListExecutions', { stateMachineArn });
      return r.body.executions.length >= 1 ? r.body.executions : null;
    });
    assert.ok(execs, 'EventBridge should have started a state-machine execution');
    // The execution input is the EventBridge envelope carrying our detail.
    const desc = await sfn('DescribeExecution', { executionArn: execs[0].executionArn });
    const input = JSON.parse(desc.body.input);
    assert.equal(input.source, 'my.app');
    assert.deepEqual(input.detail, { hi: true });
  });
});
