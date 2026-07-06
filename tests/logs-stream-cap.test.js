// tests/logs-stream-cap.test.js — audit item 9, moved out of audit-fixes.test.js:
// putLogEvent caps streams-per-group at MOCKCLOUD_MAX_LOG_STREAMS (default 200),
// evicting the oldest, never the stream just written. The cap is read from the
// environment at server startup, so this file lowers it at module top and gets
// its own per-file server (vitest's forks pool + one-server-per-file isolate it;
// in spawn mode the child inherits this env at startServer() time).
//
// Eviction runs only on the INTERNAL putLogEvent path (Lambda execution logs):
// streams created via the CreateLogStream API are marked userCreated and are
// never auto-evicted, and the PutLogEvents API doesn't evict at all. So the
// black-box driver is Lambda — every invocation creates exactly one auto
// stream `<date>/[$LATEST]<requestId>` under /aws/lambda/<fn>, and the
// requestId returned by each invoke maps it to its stream name. With the cap
// at 20, 25 invocations exercise eviction cheaply.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';

process.env.MOCKCLOUD_MAX_LOG_STREAMS = '20';   // MUST be set before startServer

const { startServer } = await import('./helpers/server.js');
const { makeClients } = await import('./helpers/aws.js');
const { lambdaJson } = await import('./helpers/http.js');
const { DescribeLogStreamsCommand } = await import('@aws-sdk/client-cloudwatch-logs');

let server, logs;
beforeAll(async () => { server = await startServer(); ({ logs } = makeClients(server.endpoint)); });
afterAll(() => { server.close(); delete process.env.MOCKCLOUD_MAX_LOG_STREAMS; });
beforeEach(() => server.resetStore());

// Internal (non-API) invocation path — the one that streams execution logs
// through putLogEvent. Returns { result, duration, error, requestId }.
async function invoke(functionName, payload) {
  const r = await fetch(server.endpoint + '/mockcloud/_test/lambda/internal-invoke', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ functionName, payload, source: 'test' }),
  });
  assert.equal(r.status, 200);
  return r.json();
}

describe('CloudWatch log-stream cap (MOCKCLOUD_MAX_LOG_STREAMS=20)', () => {
  it('evicts the oldest auto-created streams past the cap and never the one just written', async () => {
    const create = await lambdaJson(server.endpoint, 'POST', '/2015-03-31/functions',
      { FunctionName: 'cap-fn', Runtime: 'nodejs20.x' });
    assert.equal(create.status, 201);

    // 25 sequential invocations → 25 auto streams, in creation order.
    const requestIds = [];
    for (let i = 0; i < 25; i++) {
      const r = await invoke('cap-fn', { i });
      assert.equal(r.error, null, `invocation ${i} succeeded`);
      requestIds.push(r.requestId);
    }

    const desc = await logs.send(new DescribeLogStreamsCommand({ logGroupName: '/aws/lambda/cap-fn' }));
    const names = desc.logStreams.map(s => s.logStreamName);
    const has = rid => names.some(n => n.endsWith(`]${rid}`));   // <date>/[$LATEST]<requestId>

    assert.equal(names.length, 20, 'group holds exactly the cap');
    assert.ok(has(requestIds[24]), 'most recently written stream survived');
    for (let i = 0; i < 5; i++) assert.ok(!has(requestIds[i]), `oldest stream (invocation ${i}) evicted`);
    assert.ok(has(requestIds[5]), 'eviction stopped exactly at the cap boundary');
  });
});
