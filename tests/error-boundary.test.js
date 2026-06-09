// tests/error-boundary.test.js
// The dispatch boundary must emit a proper AWS error shape (not a hung socket)
// so SDK retry logic engages on an unhandled handler error.
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { sendInternalError } from '../src/middleware/response.js';

function mockRes() {
  return {
    statusCode: 0, headers: {}, body: '', headersSent: false,
    writeHead(code, hdrs) { this.statusCode = code; Object.assign(this.headers, hdrs || {}); this.headersSent = true; },
    end(b) { if (b !== undefined) this.body += b; },
  };
}

describe('error boundary', () => {
  it('emits JSON __type for JSON-protocol (x-amz-target) requests', () => {
    const res = mockRes();
    sendInternalError({ headers: { 'x-amz-target': 'DynamoDB_20120810.Query' } }, res, null);
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.equal(body.__type, 'InternalFailure');
  });

  it('emits an S3 <Error> document for non-JSON requests', () => {
    const res = mockRes();
    sendInternalError({ headers: {} }, res, null);
    assert.equal(res.statusCode, 500);
    assert.match(res.body, /<Code>InternalError<\/Code>/);
  });

  it('is a no-op once headers are already sent', () => {
    const res = mockRes();
    res.writeHead(200, {});
    sendInternalError({ headers: {} }, res, null);
    assert.equal(res.statusCode, 200); // unchanged
  });
});
