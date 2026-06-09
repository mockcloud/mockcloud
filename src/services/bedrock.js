// services/bedrock.js — AWS Bedrock Runtime emulator
//
// Path-routed (the bedrock-runtime SDK uses REST-JSON, not X-Amz-Target):
//   POST /model/<modelId>/invoke
//   POST /model/<modelId>/invoke-with-response-stream   (vnd.amazon.eventstream)
//   POST /model/<modelId>/converse
//   POST /model/<modelId>/converse-stream               (vnd.amazon.eventstream)
//   POST /guardrail/<id>/version/<v>/apply              (stub)
//
// Responses are CANNED and CONFIGURABLE via store.bedrock + the
// /mockcloud/bedrock control plane (src/routes/bedrock.js): callers register
// rules that match on model + prompt substring and return a fixed completion
// or inject a fault. This makes Bedrock-backed code testable offline without a
// real model. Scope: InvokeModel + Converse (+ streaming) + a guardrail stub —
// not the full Bedrock surface.
import { store, randomId } from '../store.js';
import { jsonResponse, getParsedBody } from '../middleware/response.js';

const PATH_RE = /^\/model\/(.+)\/(invoke-with-response-stream|invoke|converse-stream|converse)$/;

export function handler(req, res) {
  const path = new URL(req.url, 'http://x').pathname;

  if (path.startsWith('/guardrail/')) return applyGuardrail(req, res);

  const m = PATH_RE.exec(path);
  if (!m) return jsonResponse(res, 404, { __type: 'ResourceNotFoundException', message: `Unknown Bedrock path: ${path}` });
  const modelId = decodeURIComponent(m[1]);
  const op = m[2];
  const body = getParsedBody(req);
  const prompt = extractPrompt(body);

  const resolved = resolveRule(modelId, prompt);
  recordInvocation(modelId, op, prompt, resolved);

  // Fault injection — return the configured error before producing output.
  if (resolved.fault) {
    const f = resolved.fault;
    return jsonResponse(res, f.statusCode || 400, { __type: f.type || 'ThrottlingException', message: f.message || 'Mock Bedrock fault' });
  }

  const text = resolved.response;
  const inputTokens = approxTokens(prompt);
  const outputTokens = approxTokens(text);

  switch (op) {
    case 'invoke':         return invokeModel(res, modelId, text, inputTokens, outputTokens);
    case 'converse':       return converse(res, modelId, text, inputTokens, outputTokens);
    case 'invoke-with-response-stream': return invokeModelStream(res, text, inputTokens, outputTokens);
    case 'converse-stream':             return converseStream(res, text, inputTokens, outputTokens);
  }
}

// ── Non-streaming ───────────────────────────────────────────────────────────
function invokeModel(res, modelId, text, inputTokens, outputTokens) {
  // bedrock-runtime InvokeModel returns the raw model body. Shape it per family.
  const body = modelId.startsWith('anthropic.')
    ? {
        id: `msg_${randomId(24)}`, type: 'message', role: 'assistant', model: modelId,
        content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      }
    : modelId.startsWith('amazon.titan')
    ? { inputTextTokenCount: inputTokens, results: [{ tokenCount: outputTokens, outputText: text, completionReason: 'FINISH' }] }
    : { outputText: text, completionReason: 'FINISH' };
  return jsonResponse(res, 200, body);
}

function converse(res, modelId, text, inputTokens, outputTokens) {
  return jsonResponse(res, 200, {
    output: { message: { role: 'assistant', content: [{ text }] } },
    stopReason: 'end_turn',
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    metrics: { latencyMs: 5 },
  });
}

// ── Streaming (vnd.amazon.eventstream) ───────────────────────────────────────
function startStream(res) {
  res.writeHead(200, { 'Content-Type': 'application/vnd.amazon.eventstream', 'x-amzn-RequestId': randomId(32) });
}

// InvokeModelWithResponseStream: a series of `chunk` events whose payload is
// { bytes: base64(<model streaming chunk JSON>) } — Anthropic message events.
function invokeModelStream(res, text, inputTokens, outputTokens) {
  startStream(res);
  const chunk = obj => res.write(eventFrame('chunk', { bytes: Buffer.from(JSON.stringify(obj)).toString('base64') }));
  chunk({ type: 'message_start', message: { role: 'assistant', usage: { input_tokens: inputTokens, output_tokens: 0 } } });
  chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const piece of splitForStream(text)) {
    chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
  }
  chunk({ type: 'content_block_stop', index: 0 });
  chunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } });
  chunk({ type: 'message_stop' });
  res.end();
}

// ConverseStream: typed events (messageStart / contentBlockDelta / ... / metadata).
function converseStream(res, text, inputTokens, outputTokens) {
  startStream(res);
  res.write(eventFrame('messageStart', { role: 'assistant' }));
  for (const piece of splitForStream(text)) {
    res.write(eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: piece } }));
  }
  res.write(eventFrame('contentBlockStop', { contentBlockIndex: 0 }));
  res.write(eventFrame('messageStop', { stopReason: 'end_turn' }));
  res.write(eventFrame('metadata', {
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    metrics: { latencyMs: 5 },
  }));
  res.end();
}

// Guardrail apply — minimal stub: never intervenes.
function applyGuardrail(req, res) {
  const body = getParsedBody(req);
  const outputs = body.content?.map(c => ({ text: c.text?.text ?? '' })) || [];
  return jsonResponse(res, 200, { usage: {}, action: 'NONE', outputs, assessments: [] });
}

// ── Rule resolution / config ──────────────────────────────────────────────
// A rule matches when (no model || modelId matches the model glob) AND
// (no promptContains || prompt includes it). First match wins; falls back to
// the configured defaultResponse.
function resolveRule(modelId, prompt) {
  const cfg = store.bedrock;
  for (const rule of cfg.rules || []) {
    if (rule.model && !globMatch(rule.model, modelId)) continue;
    if (rule.promptContains && !(prompt || '').includes(rule.promptContains)) continue;
    return { response: rule.response ?? cfg.defaultResponse, fault: rule.fault || null };
  }
  return { response: cfg.defaultResponse, fault: null };
}

function recordInvocation(modelId, op, prompt, resolved) {
  store.bedrock.invocations.unshift({
    id: randomId(16), t: Date.now(), modelId, op,
    prompt: (prompt || '').slice(0, 500),
    faulted: !!resolved.fault,
  });
  if (store.bedrock.invocations.length > 200) store.bedrock.invocations.pop();
  store.addTrail({ method: 'POST', path: `/bedrock/${op}/${modelId}`, status: resolved.fault ? (resolved.fault.statusCode || 400) : 200, latency: 5 });
}

// ── Helpers ────────────────────────────────────────────────────────────────
// Pull the user prompt out of whatever request shape arrived.
function extractPrompt(body) {
  if (!body || typeof body !== 'object') return '';
  if (Array.isArray(body.messages) && body.messages.length) {
    const last = body.messages[body.messages.length - 1];
    return contentToText(last?.content);
  }
  return body.inputText || body.prompt || '';
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (typeof c === 'string' ? c : c?.text ?? '')).join(' ').trim();
  return '';
}

// Rough token estimate (~4 chars/token) — enough for plausible usage numbers.
function approxTokens(s) { return Math.max(1, Math.ceil((s || '').length / 4)); }

// Split a canned response into a handful of streaming pieces (by word).
function splitForStream(text) {
  const words = String(text || '').split(/(\s+)/).filter(Boolean);
  return words.length ? words : [String(text || '')];
}

// Simple `*` glob: 'anthropic.*' matches 'anthropic.claude-...'; exact otherwise.
function globMatch(pattern, value) {
  if (pattern === value) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$');
  return re.test(value);
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── vnd.amazon.eventstream framing ──────────────────────────────────────────
// Frame: [totalLen u32][headerLen u32][preludeCRC u32][headers][payload][msgCRC u32]
// Header: [nameLen u8][name][valueType u8=7][valueLen u16][value]
function eventFrame(eventType, payloadObj) {
  return encodeMessage(
    { ':message-type': 'event', ':event-type': eventType, ':content-type': 'application/json' },
    Buffer.from(JSON.stringify(payloadObj)),
  );
}

function encodeMessage(headers, payloadBuf) {
  const headerBuf = Buffer.concat(Object.entries(headers).map(([k, v]) => encodeHeader(k, v)));
  const totalLen = 4 + 4 + 4 + headerBuf.length + payloadBuf.length + 4;
  const msg = Buffer.alloc(totalLen);
  let o = 0;
  msg.writeUInt32BE(totalLen, o); o += 4;
  msg.writeUInt32BE(headerBuf.length, o); o += 4;
  msg.writeUInt32BE(crc32(msg.subarray(0, 8)), o); o += 4;
  headerBuf.copy(msg, o); o += headerBuf.length;
  payloadBuf.copy(msg, o); o += payloadBuf.length;
  msg.writeUInt32BE(crc32(msg.subarray(0, o)), o);
  return msg;
}

function encodeHeader(name, value) {
  const nameBuf = Buffer.from(name, 'utf8');
  const valBuf = Buffer.from(String(value), 'utf8');
  const buf = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valBuf.length);
  let o = 0;
  buf.writeUInt8(nameBuf.length, o); o += 1;
  nameBuf.copy(buf, o); o += nameBuf.length;
  buf.writeUInt8(7, o); o += 1;                 // value type 7 = UTF-8 string
  buf.writeUInt16BE(valBuf.length, o); o += 2;
  valBuf.copy(buf, o);
  return buf;
}

// CRC32 (IEEE 802.3) — Node's zlib.crc32 only exists on v22+, so table it here.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
