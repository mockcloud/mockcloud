// tests/control-plane.test.js — black-box coverage of the /mockcloud control
// plane (export / import / reset), replacing the retired direct-store unit
// tests from tests/store.test.js. Everything runs over HTTP against
// server.endpoint, so this file validates any conforming implementation
// (Node today, Go tomorrow).
//
// Covered here (formerly asserted directly on the store object):
//   - export emits a version-1 snapshot containing every service namespace
//   - export trims lambda function logs to 20 entries
//   - import REPLACES a service namespace present in the snapshot (regression:
//     the v1.2.1 shallow merge leaked pre-import state)
//   - namespaces absent from an imported snapshot keep their current state
//   - reset?service=<svc> resets only that service
//   - reset restores per-service config defaults (cloudwatch.maxPoints)
//   - the eventbridge default bus survives reset
//
// NOT re-covered (see tests/audit-fixes.test.js — already black-box there):
//   - export → import round-trip preserving data (queue + message)
//   - import rejecting garbage / malformed bodies
//
// RETIRED: the store.putMetric ring-buffer cap (at most cloudwatch.maxPoints
// samples per metric, oldest shifted off). putMetric is an internal write path
// with no cheap public surface for pumping >maxPoints samples deterministically
// — it moves to a Go-native unit test in the Go implementation.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { CreateQueueCommand, ListQueuesCommand } from '@aws-sdk/client-sqs';
import { CreateBucketCommand, ListBucketsCommand } from '@aws-sdk/client-s3';
import { CreateFunctionCommand, InvokeCommand } from '@aws-sdk/client-lambda';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';
import { awsJson } from './helpers/http.js';

let server, sqs, s3, lambda;
beforeAll(async () => { server = await startServer(); ({ sqs, s3, lambda } = makeClients(server.endpoint)); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

// ── control-plane + listing helpers ─────────────────────────────────────────
async function exportSnap() {
  const r = await fetch(server.endpoint + '/mockcloud/export');
  assert.equal(r.status, 200, 'export must succeed');
  return r.text();
}
function importSnap(body) {
  return fetch(server.endpoint + '/mockcloud/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const resetSvc = service => fetch(
  server.endpoint + '/mockcloud/reset' + (service ? `?service=${service}` : ''),
  { method: 'DELETE' });
const listQueueUrls   = async () => (await sqs.send(new ListQueuesCommand({}))).QueueUrls || [];
const listBucketNames = async () => ((await s3.send(new ListBucketsCommand({}))).Buckets || []).map(b => b.Name);
const eb = (op, payload) => awsJson(server.endpoint, `AmazonEventBridge.${op}`, payload);

describe('GET /mockcloud/export', () => {
  it('emits a version-1 JSON snapshot containing every registered service namespace', async () => {
    const snap = JSON.parse(await exportSnap());
    assert.equal(snap.version, 1);
    for (const k of [
      's3', 'dynamodb', 'lambda', 'iam', 'sns', 'sqs', 'secretsmanager', 'ec2',
      'eventbridge', 'dynamodbstreams', 'cloudwatch', 'logs', 'bedrock',
      'stepfunctions', 'ses',
    ]) {
      assert.ok(k in snap, `snapshot should include service "${k}"`);
    }
  });

  it('trims lambda function logs to 20 entries', async () => {
    // A non-Node runtime takes the synthetic invoke path (no child process),
    // so 11 invocations are cheap. Each invocation writes 2 log entries
    // (START + END) to the function's log buffer → 22 > the 20-entry cap.
    await lambda.send(new CreateFunctionCommand({
      FunctionName: 'noisy', Runtime: 'python3.12', Handler: 'index.handler',
      Role: 'arn:aws:iam::000000000000:role/x',
      Code: { ZipFile: Buffer.from('# synthetic runtime, code never executes') },
    }));
    for (let i = 0; i < 11; i++) {
      const out = await lambda.send(new InvokeCommand({ FunctionName: 'noisy' }));
      assert.equal(out.StatusCode, 200);
    }

    const snap = JSON.parse(await exportSnap());
    assert.equal(snap.lambda.functions['noisy'].logs.length, 20,
      '22 log entries were written; export must keep only 20');
  });
});

describe('POST /mockcloud/import', () => {
  it('replaces a service namespace present in the snapshot, not merges into it (regression: shallow merge leaked prior state)', async () => {
    await sqs.send(new CreateQueueCommand({ QueueName: 'cp-import-keep' }));
    const snapText = await exportSnap();

    // A queue created AFTER the export must NOT survive importing it back.
    await sqs.send(new CreateQueueCommand({ QueueName: 'cp-import-leftover' }));
    assert.equal((await listQueueUrls()).length, 2, 'premise: both queues exist pre-import');

    const imp = await importSnap(snapText);
    assert.equal(imp.status, 200);
    assert.equal((await imp.json()).imported, true);

    const urls = await listQueueUrls();
    assert.equal(urls.length, 1, 'pre-import state must be cleared when the service is in the snapshot');
    assert.ok(urls[0].includes('cp-import-keep'), 'the exported queue is the one restored');
  });

  it('namespaces missing from the snapshot keep their current state', async () => {
    await s3.send(new CreateBucketCommand({ Bucket: 'cp-import-keep-bucket' }));
    await sqs.send(new CreateQueueCommand({ QueueName: 'cp-import-doomed-q' }));

    // Snapshot names only sqs → sqs is replaced (emptied), s3 is untouched.
    const imp = await importSnap({ version: 1, sqs: { queues: {} } });
    assert.equal(imp.status, 200);

    assert.ok((await listBucketNames()).includes('cp-import-keep-bucket'),
      's3 is absent from the snapshot → keeps its current state');
    assert.equal((await listQueueUrls()).length, 0,
      'sqs is present in the snapshot → replaced by its (empty) contents');
  });
});

describe('DELETE /mockcloud/reset', () => {
  it('without ?service restores every service to factory defaults', async () => {
    await sqs.send(new CreateQueueCommand({ QueueName: 'cp-reset-all-q' }));
    await s3.send(new CreateBucketCommand({ Bucket: 'cp-reset-all-bucket' }));

    const r = await resetSvc();
    assert.equal(r.status, 200);
    assert.equal((await r.json()).reset, 'all');

    assert.equal((await listQueueUrls()).length, 0, 'queues cleared');
    assert.equal((await listBucketNames()).length, 0, 'buckets cleared');
  });

  it('?service=sqs resets only that service', async () => {
    await sqs.send(new CreateQueueCommand({ QueueName: 'cp-reset-q' }));
    await s3.send(new CreateBucketCommand({ Bucket: 'cp-reset-bucket' }));

    const r = await resetSvc('sqs');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).reset, 'sqs');

    assert.equal((await listQueueUrls()).length, 0, 'queue gone after scoped reset');
    assert.ok((await listBucketNames()).includes('cp-reset-bucket'), 'other services untouched');
  });

  it('restores per-service config defaults (cloudwatch.maxPoints back to 1440)', async () => {
    // Drive the store to a non-default maxPoints through the public import
    // surface, then verify a scoped reset restores the factory default
    // instead of blanking the config.
    const imp = await importSnap({ version: 1, cloudwatch: { metrics: {}, maxPoints: 10 } });
    assert.equal(imp.status, 200);
    assert.equal(JSON.parse(await exportSnap()).cloudwatch.maxPoints, 10, 'premise: import applied maxPoints=10');

    const r = await resetSvc('cloudwatch');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(await exportSnap()).cloudwatch.maxPoints, 1440);
  });

  it('eventbridge default bus survives reset', async () => {
    // Remove the default bus via the public import surface (an imported
    // eventbridge namespace with empty buses replaces the factory default).
    const imp = await importSnap({ version: 1, eventbridge: { buses: {}, events: [] } });
    assert.equal(imp.status, 200);
    assert.equal(JSON.parse(await exportSnap()).eventbridge.buses.default, undefined,
      'premise: default bus removed by the import');

    const r = await resetSvc('eventbridge');
    assert.equal(r.status, 200);

    const buses = JSON.parse(await exportSnap()).eventbridge.buses;
    assert.ok(buses.default, 'reset recreates the default bus');
    assert.equal(buses.default.name, 'default');

    // And it is functional: PutRule with no EventBusName lands on the default
    // bus and ListRules sees it there.
    const put = await eb('PutRule', { Name: 'cp-default-bus-rule', ScheduleExpression: 'rate(5 minutes)' });
    assert.equal(put.status, 200);
    assert.ok(put.body.RuleArn, 'PutRule on the default bus works after reset');
    const list = await eb('ListRules', {});
    assert.ok(list.body.Rules.some(x => x.Name === 'cp-default-bus-rule'),
      'rule listed on the default bus');
  });
});
