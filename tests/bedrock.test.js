// tests/bedrock.test.js
// Bedrock Runtime emulator: canned/configurable InvokeModel + Converse,
// fault injection, and vnd.amazon.eventstream streaming. Exercised at the wire
// level (the bedrock-runtime SDK isn't a dev-dep) — including a decoder for the
// binary event-stream framing the streaming ops produce.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let server;
beforeAll(async () => { server = await startServer(); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

const MODEL = 'anthropic.claude-3-sonnet-20240229-v1:0';
const modelPath = (op, id = MODEL) => `/model/${encodeURIComponent(id)}/${op}`;

async function bedrock(op, payload, id) {
  const res = await fetch(server.endpoint + modelPath(op, id), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res;
}
async function bedrockJson(op, payload, id) {
  const res = await bedrock(op, payload, id);
  return { status: res.status, body: await res.json() };
}
const control = (method, path, payload) => fetch(server.endpoint + path, {
  method, headers: { 'Content-Type': 'application/json' },
  body: payload === undefined ? undefined : JSON.stringify(payload),
});

// Decode a vnd.amazon.eventstream buffer into [{ headers, payload(Buffer) }].
function decodeEventStream(buf) {
  const events = [];
  let o = 0;
  while (o + 12 <= buf.length) {
    const totalLen = buf.readUInt32BE(o);
    const headerLen = buf.readUInt32BE(o + 4);
    const headersStart = o + 12;
    const headersEnd = headersStart + headerLen;
    const payloadEnd = o + totalLen - 4;
    const headers = {};
    let h = headersStart;
    while (h < headersEnd) {
      const nameLen = buf.readUInt8(h); h += 1;
      const name = buf.toString('utf8', h, h + nameLen); h += nameLen;
      const type = buf.readUInt8(h); h += 1;          // 7 = string
      const valLen = buf.readUInt16BE(h); h += 2;
      headers[name] = buf.toString('utf8', h, h + valLen); h += valLen;
      void type;
    }
    events.push({ headers, payload: buf.subarray(headersEnd, payloadEnd) });
    o += totalLen;
  }
  return events;
}
async function streamEvents(op, payload, id) {
  const res = await bedrock(op, payload, id);
  assert.equal(res.headers.get('content-type'), 'application/vnd.amazon.eventstream');
  return decodeEventStream(Buffer.from(await res.arrayBuffer()));
}

const claudeReq = (text) => ({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, messages: [{ role: 'user', content: text }] });
const converseReq = (text) => ({ messages: [{ role: 'user', content: [{ text }] }] });

describe('Bedrock InvokeModel + Converse', () => {
  it('InvokeModel returns the canned default in an Anthropic body', async () => {
    const { status, body } = await bedrockJson('invoke', claudeReq('hello'));
    assert.equal(status, 200);
    assert.equal(body.type, 'message');
    assert.equal(body.content[0].text, 'This is a canned MockCloud Bedrock response.');
    assert.ok(body.usage.input_tokens > 0 && body.usage.output_tokens > 0);
  });

  it('Converse returns the normalized output shape', async () => {
    const { status, body } = await bedrockJson('converse', converseReq('hi there'));
    assert.equal(status, 200);
    assert.equal(body.output.message.role, 'assistant');
    assert.equal(body.output.message.content[0].text, 'This is a canned MockCloud Bedrock response.');
    assert.equal(body.stopReason, 'end_turn');
    assert.equal(body.usage.totalTokens, body.usage.inputTokens + body.usage.outputTokens);
  });

  it('a configured rule matches on prompt substring', async () => {
    const r = await control('POST', '/mockcloud/bedrock/rules', { model: 'anthropic.*', promptContains: 'weather', response: 'It is sunny.' });
    assert.equal(r.status, 201);
    const { body } = await bedrockJson('invoke', claudeReq('what is the weather today'));
    assert.equal(body.content[0].text, 'It is sunny.');
    // Non-matching prompt falls back to the default.
    const { body: other } = await bedrockJson('invoke', claudeReq('unrelated question'));
    assert.equal(other.content[0].text, 'This is a canned MockCloud Bedrock response.');
  });

  it('injects a configured fault', async () => {
    await control('POST', '/mockcloud/bedrock/rules', { promptContains: 'boom', fault: { type: 'ThrottlingException', message: 'slow down', statusCode: 429 } });
    const res = await bedrock('invoke', claudeReq('make it go boom'));
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.__type, 'ThrottlingException');
    assert.equal(body.message, 'slow down');
  });

  it('records invocations in the control plane', async () => {
    await bedrockJson('invoke', claudeReq('track me'));
    const cfg = await (await control('GET', '/mockcloud/bedrock')).json();
    assert.ok(cfg.invocations.length >= 1);
    assert.equal(cfg.invocations[0].modelId, MODEL);
    assert.equal(cfg.invocations[0].op, 'invoke');
  });
});

describe('Bedrock streaming (vnd.amazon.eventstream)', () => {
  it('invoke-with-response-stream emits Anthropic chunk events that reassemble the text', async () => {
    await control('PUT', '/mockcloud/bedrock', { defaultResponse: 'one two three' });
    const events = await streamEvents('invoke-with-response-stream', claudeReq('go'));
    assert.ok(events.every(e => e.headers[':event-type'] === 'chunk'));

    const decoded = events.map(e => JSON.parse(Buffer.from(JSON.parse(e.payload.toString()).bytes, 'base64').toString()));
    const text = decoded.filter(d => d.type === 'content_block_delta').map(d => d.delta.text).join('');
    assert.equal(text, 'one two three');
    assert.ok(decoded.some(d => d.type === 'message_stop'), 'should end with message_stop');
  });

  it('converse-stream emits typed events with deltas + metadata', async () => {
    await control('PUT', '/mockcloud/bedrock', { defaultResponse: 'alpha beta' });
    const events = await streamEvents('converse-stream', converseReq('go'));
    const byType = t => events.filter(e => e.headers[':event-type'] === t);

    assert.equal(byType('messageStart').length, 1);
    const text = byType('contentBlockDelta').map(e => JSON.parse(e.payload.toString()).delta.text).join('');
    assert.equal(text, 'alpha beta');
    assert.equal(byType('messageStop').length, 1);
    const meta = JSON.parse(byType('metadata')[0].payload.toString());
    assert.ok(meta.usage.totalTokens > 0);
  });
});
