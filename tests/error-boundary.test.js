// tests/error-boundary.test.js
// The dispatch boundary must emit a proper AWS error shape (not a hung socket)
// so SDK retry logic engages on an unhandled handler error. Exercised black-box
// via GET /mockcloud/_test/boom, which throws through the production error
// boundary. Expect '[MockCloud] Unhandled error: ... boom (MOCKCLOUD_TEST_ENDPOINTS)'
// noise on stderr — that is the boundary logging, not a test failure.
//
// Retired: the old 'headersSent → no-op' unit test (sendInternalError called
// after headers were already written) is unobservable over HTTP; it will be
// re-covered as a Go unit test.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let server;
beforeAll(async () => { server = await startServer(); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

describe('error boundary', () => {
  it('emits JSON __type for JSON-protocol (x-amz-target) requests', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/_test/boom`, {
      headers: { 'x-amz-target': 'Anything.Op' },
    });
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type'), /application\/x-amz-json-1\.0/);
    const body = JSON.parse(await res.text());
    assert.equal(body.__type, 'InternalFailure');
    assert.equal(body.message, 'The request processing has failed because of an unknown error.');
  });

  it('emits an S3 <Error> document for non-JSON requests', async () => {
    const res = await fetch(`${server.endpoint}/mockcloud/_test/boom`);
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type'), /application\/xml/);
    const body = await res.text();
    assert.match(body, /<Code>InternalError<\/Code>/);
    assert.match(body, /<Message>We encountered an internal error\. Please try again\.<\/Message>/);
  });
});
