// tests/audit-fixes.test.js — regression coverage for the May 2026 audit fixes:
//   1. CloudWatch Logs GetLogEvents pagination terminates (was: random tokens →
//      SDK paginators looped forever re-reading the same page), and an event
//      written with an OLDER timestamp mid-pagination can't resurrect already-
//      returned pages (timestamp cursors, not positional indexes).
//   2. IAM/STS actions that the dispatcher routes but the handler used to drop
//      into a fake 200 <UnknownResponse><ok/> stub now behave correctly, and a
//      genuinely-unknown action returns a proper error instead of a fake success.
//   3. DELETE /mockcloud/reset wipes the DynamoDB disk snapshot so reset tables
//      can't resurrect on hydrate.
//   4. GET /mockcloud/export → POST /mockcloud/import round-trips state, and
//      import rejects garbage / non-object bodies instead of silently no-oping.
//   5. STS GetSessionToken validates DurationSeconds (NaN used to 500).
//   6. SQS query-protocol batch ops (SendMessageBatch / DeleteMessageBatch /
//      ChangeMessageVisibility) work over form encoding, not just JSON.
//   7. SES query-protocol actions answer XML, not JSON.
//   8. Step Functions DeleteStateMachine purges its executions from the global
//      map (they used to be orphaned there forever).
//   9. putLogEvent caps streams-per-group at MOCKCLOUD_MAX_LOG_STREAMS (200),
//      evicting the oldest, never the stream just written.
//
// NOTE (audit item "EC2 unknown action"): the dispatcher's EC2_ACTIONS set and
// the ec2.js switch are in full parity (28/28 actions), so the handler's
// `default:` (400 InvalidAction) is unreachable through the public HTTP surface
// — an action outside the set falls through to the S3 handler instead. No test
// is written for it; it would only be reachable by calling the handler with a
// synthetic request, which tests nothing the dispatcher can produce.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  CreateLogGroupCommand, CreateLogStreamCommand, PutLogEventsCommand, GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { startServer } from './helpers/server.js';
import { TEST_DDB_ROOT } from './helpers/test-env.js';
import { makeClients } from './helpers/aws.js';
import { awsForm, awsJson, xmlValue, xmlValues } from './helpers/http.js';
// server.js (above) imports test-env.js first, so these src modules were
// evaluated with the test storage roots already in place — same instances the
// server uses.
import { store } from '../src/store.js';
import { persistNow, hydrateFromDisk } from '../src/services/dynamodb/persistence.js';
import { putLogEvent } from '../src/services/cloudwatchlogs.js';

let server, logs, dynamo;
beforeAll(async () => { server = await startServer(); ({ logs, dynamo } = makeClients(server.endpoint)); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

describe('GetLogEvents pagination terminates (no infinite loop)', () => {
  it('walks every event exactly once and stops when the forward token repeats', async () => {
    await logs.send(new CreateLogGroupCommand({ logGroupName: '/g' }));
    await logs.send(new CreateLogStreamCommand({ logGroupName: '/g', logStreamName: 's' }));
    const t0 = Date.now();
    await logs.send(new PutLogEventsCommand({ logGroupName: '/g', logStreamName: 's',
      logEvents: Array.from({ length: 5 }, (_, i) => ({ timestamp: t0 + i, message: `m${i}` })) }));

    const seen = [];
    let token, prev;
    for (let i = 0; i < 50; i++) {                 // 50 = generous infinite-loop guard
      const r = await logs.send(new GetLogEventsCommand({
        logGroupName: '/g', logStreamName: 's', startFromHead: true, limit: 2, nextToken: token,
      }));
      seen.push(...r.events.map(e => e.message));
      prev = token; token = r.nextForwardToken;
      if (token === prev) break;                   // AWS termination signal
    }
    assert.deepEqual(seen, ['m0', 'm1', 'm2', 'm3', 'm4'], 'each event returned exactly once, in order');
  });

  it('returns the same forward token when there is nothing new (idempotent at the tail)', async () => {
    await logs.send(new CreateLogGroupCommand({ logGroupName: '/g' }));
    await logs.send(new CreateLogStreamCommand({ logGroupName: '/g', logStreamName: 's' }));
    await logs.send(new PutLogEventsCommand({ logGroupName: '/g', logStreamName: 's',
      logEvents: [{ timestamp: Date.now(), message: 'only' }] }));

    const first = await logs.send(new GetLogEventsCommand({ logGroupName: '/g', logStreamName: 's', startFromHead: true }));
    assert.equal(first.events.length, 1);
    const again = await logs.send(new GetLogEventsCommand({
      logGroupName: '/g', logStreamName: 's', nextToken: first.nextForwardToken }));
    assert.equal(again.events.length, 0, 'no new events past the cursor');
    assert.equal(again.nextForwardToken, first.nextForwardToken, 'token is stable → loop terminates');
  });

  it('an older event written mid-pagination causes no duplicates and pagination still terminates', async () => {
    await logs.send(new CreateLogGroupCommand({ logGroupName: '/g' }));
    await logs.send(new CreateLogStreamCommand({ logGroupName: '/g', logStreamName: 's' }));
    const t0 = Date.now();
    await logs.send(new PutLogEventsCommand({ logGroupName: '/g', logStreamName: 's',
      logEvents: Array.from({ length: 6 }, (_, i) => ({ timestamp: t0 + 100 + i, message: `m${i}` })) }));

    const page1 = await logs.send(new GetLogEventsCommand({
      logGroupName: '/g', logStreamName: 's', startFromHead: true, limit: 2 }));
    assert.deepEqual(page1.events.map(e => e.message), ['m0', 'm1']);

    // Write an event OLDER than the cursor position. With the old positional-
    // index tokens this shifted the array and re-served already-seen events.
    await logs.send(new PutLogEventsCommand({ logGroupName: '/g', logStreamName: 's',
      logEvents: [{ timestamp: t0 + 50, message: 'late' }] }));

    const seen = page1.events.map(e => e.message);
    let token = page1.nextForwardToken, terminated = false;
    for (let i = 0; i < 50; i++) {                 // 50 = infinite-loop guard
      const r = await logs.send(new GetLogEventsCommand({
        logGroupName: '/g', logStreamName: 's', startFromHead: true, limit: 2, nextToken: token }));
      seen.push(...r.events.map(e => e.message));
      if (r.nextForwardToken === token) { terminated = true; break; }
      token = r.nextForwardToken;
    }
    assert.ok(terminated, 'forward token repeated → SDK paginators stop');
    assert.equal(new Set(seen).size, seen.length, 'no event was returned twice');
    // The late event lands behind the cursor and never reappears in forward
    // pages — matching real CloudWatch Logs' time-ordered cursor semantics.
    assert.deepEqual(seen, ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
  });
});

describe('IAM/STS actions no longer silently fake-succeed', () => {
  const iam = (action, params) => awsForm(server.endpoint, action, params, { version: '2010-05-08' });

  it('GetSessionToken returns real STS credentials', async () => {
    const r = await iam('GetSessionToken', {});
    assert.equal(r.status, 200);
    assert.ok(xmlValue(r.body, 'AccessKeyId'), 'has an AccessKeyId');
    assert.ok(xmlValue(r.body, 'SessionToken'), 'has a SessionToken');
    assert.ok(/GetSessionTokenResult/.test(r.body), 'correct response wrapper');
    assert.ok(!/UnknownResponse/.test(r.body), 'not the old stub');
  });

  it('CreatePolicy returns a Policy with an ARN', async () => {
    const r = await iam('CreatePolicy', { PolicyName: 'p1', PolicyDocument: '{}' });
    assert.equal(r.status, 200);
    assert.ok(/arn:aws:iam:[^:]*:\d+:policy\/p1$/.test(xmlValue(r.body, 'Arn') || ''), 'ARN points at the policy');
  });

  it('PutRolePolicy → ListRolePolicies → DeleteRolePolicy round-trips the inline policy', async () => {
    await iam('CreateRole', { RoleName: 'r1', AssumeRolePolicyDocument: '{}' });

    const put = await iam('PutRolePolicy', { RoleName: 'r1', PolicyName: 'inline1', PolicyDocument: '{"x":1}' });
    assert.equal(put.status, 200);

    const list = await iam('ListRolePolicies', { RoleName: 'r1' });
    assert.ok(/<member>inline1<\/member>/.test(list.body), 'List reflects the inline policy that was Put');

    await iam('DeleteRolePolicy', { RoleName: 'r1', PolicyName: 'inline1' });
    const after = await iam('ListRolePolicies', { RoleName: 'r1' });
    assert.ok(!/inline1/.test(after.body), 'inline policy gone after delete');
  });

  it('PutRolePolicy on a missing role returns NoSuchEntity, not a fake 200', async () => {
    const r = await iam('PutRolePolicy', { RoleName: 'ghost', PolicyName: 'x', PolicyDocument: '{}' });
    assert.equal(r.status, 404);
    assert.ok(/NoSuchEntity/.test(r.body));
  });
});

describe('STS GetSessionToken validates DurationSeconds', () => {
  const sts = params => awsForm(server.endpoint, 'GetSessionToken', params, { version: '2011-06-15' });

  it('non-numeric DurationSeconds → 400 ValidationError (used to 500 on toISOString(NaN))', async () => {
    const r = await sts({ DurationSeconds: 'abc' });
    assert.equal(r.status, 400);
    assert.ok(/ValidationError/.test(r.body));
    assert.ok(/DurationSeconds must be between 900 and 129600/.test(r.body));
  });

  it('out-of-range DurationSeconds=100 → 400 ValidationError', async () => {
    const r = await sts({ DurationSeconds: '100' });
    assert.equal(r.status, 400);
    assert.ok(/ValidationError/.test(r.body));
  });

  it('DurationSeconds=3600 → 200 with credentials expiring ~1h out', async () => {
    const before = Date.now();
    const r = await sts({ DurationSeconds: '3600' });
    assert.equal(r.status, 200);
    assert.ok(xmlValue(r.body, 'AccessKeyId'), 'has an AccessKeyId');
    assert.ok(xmlValue(r.body, 'SessionToken'), 'has a SessionToken');
    const exp = Date.parse(xmlValue(r.body, 'Expiration'));
    assert.ok(exp >= before + 3590_000 && exp <= Date.now() + 3610_000,
      'Expiration honors the requested 3600s duration');
  });
});

describe('DELETE /mockcloud/reset wipes the DynamoDB snapshot (no resurrection)', () => {
  it('a persisted table does not come back from hydrateFromDisk(true) after an HTTP reset', async () => {
    await dynamo.send(new CreateTableCommand({
      TableName: 'audit-reset-tbl',
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    }));
    persistNow();                                       // force the debounced write
    const snapshot = path.join(TEST_DDB_ROOT, 'tables.json');
    assert.ok(existsSync(snapshot), 'snapshot exists on disk before the reset');

    const r = await fetch(server.endpoint + '/mockcloud/reset', { method: 'DELETE' });
    assert.equal(r.status, 200);

    assert.ok(!existsSync(snapshot), 'reset removed the on-disk snapshot');
    assert.deepEqual(store.dynamodb.tables, {}, 'in-memory tables cleared');

    hydrateFromDisk(true);                              // simulate a server restart
    assert.deepEqual(store.dynamodb.tables, {}, 'nothing resurrects from disk');
  });
});

describe('snapshot export → import round-trip (/mockcloud/export, /mockcloud/import)', () => {
  it('a queue and its message survive export → reset → import', async () => {
    const create = await awsForm(server.endpoint, 'CreateQueue', { QueueName: 'snap-q' });
    const qurl = xmlValue(create.body, 'QueueUrl');
    assert.ok(qurl, 'queue created');
    await awsForm(server.endpoint, 'SendMessage', { QueueUrl: qurl, MessageBody: 'persist-me' });

    const exp = await fetch(server.endpoint + '/mockcloud/export');
    assert.equal(exp.status, 200);
    const snapText = await exp.text();

    await fetch(server.endpoint + '/mockcloud/reset', { method: 'DELETE' });
    const gone = await awsForm(server.endpoint, 'GetQueueUrl', { QueueName: 'snap-q' });
    assert.equal(gone.status, 400, 'queue is gone after reset');

    const imp = await fetch(server.endpoint + '/mockcloud/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: snapText });
    assert.equal(imp.status, 200);
    assert.equal((await imp.json()).imported, true);

    const back = await awsForm(server.endpoint, 'GetQueueUrl', { QueueName: 'snap-q' });
    assert.equal(back.status, 200);
    assert.equal(xmlValue(back.body, 'QueueUrl'), qurl, 'same queue URL restored');
    const attrs = await awsForm(server.endpoint, 'GetQueueAttributes', { QueueUrl: qurl });
    assert.ok(/<Name>ApproximateNumberOfMessages<\/Name><Value>1<\/Value>/.test(attrs.body),
      'queued message restored with the queue');
  });

  it('rejects garbage and non-object bodies with 400 instead of silently no-oping', async () => {
    const post = body => fetch(server.endpoint + '/mockcloud/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    for (const body of ['not-json{{{', '"just-a-string"', '[1,2,3]', '{}']) {
      const r = await post(body);
      assert.equal(r.status, 400, `body ${JSON.stringify(body)} must be rejected`);
      assert.equal((await r.json()).__type, 'ValidationError');
    }
  });

  it('rejects malformed nested service values with 400 and leaves the store usable', async () => {
    const post = body => fetch(server.endpoint + '/mockcloud/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    // null/array where the factory default is an object → validated BEFORE any
    // state is touched, so neither payload may poison the store.
    for (const body of [{ sqs: { queues: null } }, { sqs: { queues: [1] } }, { logs: { groups: 'x' } }]) {
      const r = await post(body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} must be rejected`);
    }
    // The recovery endpoint still works and SQS still answers.
    const reset = await fetch(server.endpoint + '/mockcloud/reset', { method: 'DELETE' });
    assert.equal(reset.status, 200, 'reset survives a rejected import');
    const create = await awsForm(server.endpoint, 'CreateQueue', { QueueName: 'post-poison-q' });
    assert.equal(create.status, 200, 'SQS unaffected by the rejected import');
  });

  it('export succeeds with a message in flight, and import surfaces it for redelivery', async () => {
    const create = await awsForm(server.endpoint, 'CreateQueue', { QueueName: 'flight-q' });
    const qurl = xmlValue(create.body, 'QueueUrl');
    await awsForm(server.endpoint, 'SendMessage', { QueueUrl: qurl, MessageBody: 'in-flight' });
    const recv = await awsForm(server.endpoint, 'ReceiveMessage', { QueueUrl: qurl, VisibilityTimeout: '300' });
    assert.ok(/in-flight/.test(recv.body), 'message received (now invisible, live timer attached)');

    // The live visibility Timeout handle is circular — export must not serialize it.
    const exp = await fetch(server.endpoint + '/mockcloud/export');
    assert.equal(exp.status, 200, 'export tolerates in-flight messages');
    const snapText = await exp.text();
    JSON.parse(snapText); // valid JSON
    assert.ok(!snapText.includes('_visTimer'), 'live timer handle never appears in the snapshot');

    await fetch(server.endpoint + '/mockcloud/reset', { method: 'DELETE' });
    const imp = await fetch(server.endpoint + '/mockcloud/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: snapText });
    assert.equal(imp.status, 200);

    // No timer survives a JSON round-trip, so the in-flight message must come
    // back visible (at-least-once delivery), not invisible forever.
    const again = await awsForm(server.endpoint, 'ReceiveMessage', { QueueUrl: qurl });
    assert.ok(/in-flight/.test(again.body), 'imported in-flight message is redeliverable');
  });

  it('a FIFO queue with dedupe state survives the round-trip (Map does not JSON-serialize)', async () => {
    const create = await awsForm(server.endpoint, 'CreateQueue', { QueueName: 'snap-q.fifo' });
    const qurl = xmlValue(create.body, 'QueueUrl');
    await awsForm(server.endpoint, 'SendMessage', {
      QueueUrl: qurl, MessageBody: 'a', MessageGroupId: 'g1', MessageDeduplicationId: 'd1' });

    const snapText = await (await fetch(server.endpoint + '/mockcloud/export')).text();
    // The Map would stringify as a misleading "{}" — export drops it instead
    // (import discards it anyway and enqueueMessage rebuilds it lazily).
    assert.ok(!snapText.includes('"dedupe"'), 'dedupe Map omitted from the snapshot');
    await fetch(server.endpoint + '/mockcloud/reset', { method: 'DELETE' });
    const imp = await fetch(server.endpoint + '/mockcloud/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: snapText });
    assert.equal(imp.status, 200);

    // The dedupe Map deserialized as {} would crash the next dedupe sweep —
    // import drops it, so sending again must work (fresh 5-min dedupe window).
    const send = await awsForm(server.endpoint, 'SendMessage', {
      QueueUrl: qurl, MessageBody: 'b', MessageGroupId: 'g1', MessageDeduplicationId: 'd2' });
    assert.equal(send.status, 200, 'FIFO send works after import');
  });

  it('export drops a stray enumerable _visTimer instead of crashing (defense in depth)', async () => {
    const create = await awsForm(server.endpoint, 'CreateQueue', { QueueName: 'stray-q' });
    const qurl = xmlValue(create.body, 'QueueUrl');
    await awsForm(server.endpoint, 'SendMessage', { QueueUrl: qurl, MessageBody: 'stray' });

    // setInvisible() keeps _visTimer non-enumerable, but that guard lives at a
    // single creation site. Simulate a future code path that plain-assigns the
    // timer: the stringify replacer in store.export() is the last line of
    // defense against the Timeout's circular _idlePrev/_idleNext links.
    const m = store.sqs.queues[qurl].messages[0];
    const timer = setTimeout(() => {}, 60_000);
    try {
      m._visTimer = timer;
      // Premise check: the message was never received/delayed, so setInvisible
      // never pre-defined the non-enumerable descriptor — the plain assignment
      // above must be enumerable or this test silently stops testing anything.
      assert.equal(Object.getOwnPropertyDescriptor(m, '_visTimer').enumerable, true,
        'stray assignment is enumerable');
      const snapText = store.export();
      const snap = JSON.parse(snapText);
      assert.ok(!snapText.includes('_visTimer'), 'timer key dropped from the snapshot');
      assert.equal(snap.sqs.queues[qurl].messages[0].body, 'stray', 'message itself survives');
    } finally {
      clearTimeout(timer);
    }
  });

});

describe('SQS query-protocol batch operations', () => {
  const sqs = (action, params) => awsForm(server.endpoint, action, params);

  it('SendMessageBatch enqueues both entries and DeleteMessageBatch removes them', async () => {
    const create = await sqs('CreateQueue', { QueueName: 'batch-q' });
    const qurl = xmlValue(create.body, 'QueueUrl');

    const send = await sqs('SendMessageBatch', {
      QueueUrl: qurl,
      'SendMessageBatchRequestEntry.1.Id': 'a', 'SendMessageBatchRequestEntry.1.MessageBody': 'one',
      'SendMessageBatchRequestEntry.2.Id': 'b', 'SendMessageBatchRequestEntry.2.MessageBody': 'two',
    });
    assert.equal(send.status, 200);
    assert.ok(/SendMessageBatchResponse/.test(send.body), 'XML response wrapper');
    assert.deepEqual(xmlValues(send.body, 'Id'), ['a', 'b'], 'both entry ids echoed');
    assert.equal(xmlValues(send.body, 'MessageId').length, 2, 'a MessageId per entry');

    const recv = await sqs('ReceiveMessage', { QueueUrl: qurl, MaxNumberOfMessages: '10' });
    const handles = xmlValues(recv.body, 'ReceiptHandle');
    assert.equal(handles.length, 2, 'both batch messages received');

    const del = await sqs('DeleteMessageBatch', {
      QueueUrl: qurl,
      'DeleteMessageBatchRequestEntry.1.Id': 'a', 'DeleteMessageBatchRequestEntry.1.ReceiptHandle': handles[0],
      'DeleteMessageBatchRequestEntry.2.Id': 'b', 'DeleteMessageBatchRequestEntry.2.ReceiptHandle': handles[1],
    });
    assert.equal(del.status, 200);
    assert.deepEqual(xmlValues(del.body, 'Id'), ['a', 'b'], 'both deletions succeeded');
    assert.ok(!/BatchResultErrorEntry/.test(del.body), 'no per-entry failures');

    const attrs = await sqs('GetQueueAttributes', { QueueUrl: qurl });
    assert.ok(/<Name>ApproximateNumberOfMessages<\/Name><Value>0<\/Value>/.test(attrs.body));
    assert.ok(/<Name>ApproximateNumberOfMessagesNotVisible<\/Name><Value>0<\/Value>/.test(attrs.body));
  });

  it('ChangeMessageVisibility(0) on a received message returns 200 and makes it receivable again', async () => {
    const create = await sqs('CreateQueue', { QueueName: 'cmv-q' });
    const qurl = xmlValue(create.body, 'QueueUrl');
    await sqs('SendMessage', { QueueUrl: qurl, MessageBody: 'peekaboo' });

    const first = await sqs('ReceiveMessage', { QueueUrl: qurl });
    const handle = xmlValue(first.body, 'ReceiptHandle');
    assert.ok(handle, 'message received');
    const hidden = await sqs('ReceiveMessage', { QueueUrl: qurl });
    assert.equal(xmlValues(hidden.body, 'Message').length, 0, 'in-flight message is invisible');

    const cmv = await sqs('ChangeMessageVisibility', { QueueUrl: qurl, ReceiptHandle: handle, VisibilityTimeout: '0' });
    assert.equal(cmv.status, 200);
    assert.ok(/ChangeMessageVisibilityResponse/.test(cmv.body), 'XML response wrapper');

    const again = await sqs('ReceiveMessage', { QueueUrl: qurl });
    assert.equal(xmlValue(again.body, 'Body'), 'peekaboo', 'visibility reset → message redelivered');
  });
});

describe('SES query protocol answers XML, not JSON', () => {
  const ses = (action, params) => awsForm(server.endpoint, action, params, { version: '2010-12-01' });

  it('SendRawEmail (form) → 200 SendRawEmailResponse with a MessageId', async () => {
    const r = await ses('SendRawEmail', { 'RawMessage.Data': 'From: a@b.c\r\n\r\nhello' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/xml');
    assert.ok(r.body.startsWith('<?xml'), 'XML body, not JSON');
    assert.ok(/<SendRawEmailResponse><SendRawEmailResult>/.test(r.body), 'correct response wrapper');
    assert.ok(xmlValue(r.body, 'MessageId'), 'has a MessageId');
  });

  it('GetIdentityVerificationAttributes (form) reports Success for verified, Pending otherwise', async () => {
    const v = await ses('VerifyEmailIdentity', { EmailAddress: 'dev@example.com' });
    assert.equal(v.status, 200);
    assert.ok(/<VerifyEmailIdentityResponse>/.test(v.body));

    const r = await ses('GetIdentityVerificationAttributes', {
      'Identities.member.1': 'dev@example.com',
      'Identities.member.2': 'ghost@example.com',
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/xml');
    assert.ok(/<GetIdentityVerificationAttributesResponse><GetIdentityVerificationAttributesResult>/.test(r.body),
      'correct response wrapper');
    assert.ok(/<key>dev@example\.com<\/key><value><VerificationStatus>Success<\/VerificationStatus>/.test(r.body),
      'verified identity reports Success');
    assert.ok(/<key>ghost@example\.com<\/key><value><VerificationStatus>Pending<\/VerificationStatus>/.test(r.body),
      'unverified identity reports Pending');
  });
});

describe('Step Functions: DeleteStateMachine purges its executions', () => {
  const sfn = (op, payload) => awsJson(server.endpoint, `AWSStepFunctions.${op}`, payload);
  const PASS_DEF = JSON.stringify({ StartAt: 'A', States: { A: { Type: 'Pass', End: true } } });

  it('DescribeExecution fails after the state machine is deleted (no orphans in the global map)', async () => {
    const { body: { stateMachineArn } } = await sfn('CreateStateMachine',
      { name: 'purge-sm', definition: PASS_DEF, roleArn: 'arn:aws:iam::000000000000:role/StatesRole' });
    const start = await sfn('StartExecution', { stateMachineArn, input: '{}' });
    assert.equal(start.status, 200);
    const executionArn = start.body.executionArn;

    const before = await sfn('DescribeExecution', { executionArn });
    assert.equal(before.status, 200, 'execution resolvable while the machine exists');

    const del = await sfn('DeleteStateMachine', { stateMachineArn });
    assert.equal(del.status, 200);

    const after = await sfn('DescribeExecution', { executionArn });
    assert.equal(after.status, 400);
    assert.match(after.body.__type, /ExecutionDoesNotExist/, 'execution purged with its machine');
  });
});

describe('CloudWatch log-stream cap (MOCKCLOUD_MAX_LOG_STREAMS, default 200)', () => {
  it('putLogEvent evicts the oldest streams past the cap and never the one just written', () => {
    const group = '/aws/lambda/cap-fn';
    const t0 = Date.now();
    for (let i = 0; i < 205; i++) putLogEvent(group, `stream-${i}`, `msg-${i}`, t0 + i);

    const streams = store.logs.groups[group].streams;
    assert.equal(Object.keys(streams).length, 200, 'group holds exactly the cap');
    assert.ok(streams['stream-204'], 'most recently written stream survived');
    for (let i = 0; i < 5; i++) assert.ok(!streams[`stream-${i}`], `oldest stream-${i} evicted`);
    assert.ok(streams['stream-5'], 'eviction stopped exactly at the cap boundary');
  });
});
