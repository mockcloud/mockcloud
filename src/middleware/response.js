// middleware/response.js — shared HTTP response helpers

// ── Body readers ──────────────────────────────────────────────────────────
// index.js drains the request stream once into req.rawBody (string) and
// req.rawBuffer (Buffer). Services MUST read from these fields — calling
// req.on('data')/'end' again will hang forever, since the stream is at EOF.

export function getRawBody(req) {
  return req.rawBody || '';
}

export function getRawBuffer(req) {
  return req.rawBuffer || Buffer.alloc(0);
}

export function getParsedBody(req) {
  if (req.parsedBody) return req.parsedBody;
  try { return JSON.parse(req.rawBody || '{}'); } catch { return {}; }
}

export function getFormBody(req) {
  return Object.fromEntries(new URLSearchParams(req.rawBody || '').entries());
}

export function xmlResponse(res, statusCode, xmlStr) {
  res.writeHead(statusCode, {
    'Content-Type':      'application/xml',
    'x-amzn-RequestId':  randomReqId(),
  });
  res.end(xmlStr);
}

export function jsonResponse(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type':     'application/json',
    'x-amzn-RequestId': randomReqId(),
  });
  res.end(body);
}

export function errorXml(res, statusCode, code, message) {
  xmlResponse(res, statusCode,
    `<?xml version="1.0"?><ErrorResponse><Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error></ErrorResponse>`
  );
}

export function errorJson(res, statusCode, code, message) {
  jsonResponse(res, statusCode, { __type: code, message });
}

export function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function randomReqId() {
  return Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
}

// Last-resort error boundary. Turns an unhandled handler error into a proper AWS
// error shape — JSON `__type` for the JSON-protocol services, an S3 `<Error>`
// document otherwise — so SDK retry logic engages instead of the client hanging
// on a never-completed socket.
export function sendInternalError(req, res, err) {
  if (err) console.error('[MockCloud] Unhandled error:', err.stack || err);
  if (res.headersSent) { try { res.end(); } catch {} return; }
  const isJson = !!req.headers['x-amz-target'] || (req.headers['content-type'] || '').includes('json');
  if (isJson) {
    res.writeHead(500, { 'Content-Type': 'application/x-amz-json-1.0' });
    res.end(JSON.stringify({ __type: 'InternalFailure', message: 'The request processing has failed because of an unknown error.' }));
  } else {
    res.writeHead(500, { 'Content-Type': 'application/xml' });
    res.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message></Error>');
  }
}
