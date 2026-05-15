// tests/helpers/http.js
// Tiny HTTP helpers for tests that exercise services not covered by the
// installed AWS SDKs (DynamoDB, SQS, SNS, Lambda, KMS, SSM, etc.).
//
// Hitting MockCloud at the wire level keeps the dev-deps lean while still
// reproducing the exact request shape AWS SDKs send.

export async function awsJson(endpoint, target, payload) {
  const res = await fetch(endpoint + '/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.0',
      'X-Amz-Target': target,
    },
    body: JSON.stringify(payload || {}),
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

export async function awsForm(endpoint, action, params = {}, opts = {}) {
  const body = new URLSearchParams({ Action: action, Version: opts.version || '2012-11-05', ...params });
  const res = await fetch(endpoint + (opts.path || '/'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  return { status: res.status, body: text, headers: res.headers };
}

export async function lambdaJson(endpoint, method, path, payload, extraHeaders = {}) {
  const res = await fetch(endpoint + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

// Coarse XML extractor — pulls the first `<Tag>...</Tag>` value. Good enough
// for the values our tests need to assert on without dragging in an XML lib.
export function xmlValue(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const m = xml.match(re);
  return m ? m[1] : null;
}

export function xmlValues(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

// Reverse of escapeXml — needed when an XML response carries embedded JSON
// (e.g. SNS envelope inside <Body> in an SQS ReceiveMessage XML response).
export function unescapeXml(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g,  '<')
    .replace(/&gt;/g,  '>')
    .replace(/&amp;/g, '&');
}
