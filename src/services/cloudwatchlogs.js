// services/cloudwatchlogs.js — CloudWatch Logs (awsJson1.1, X-Amz-Target:
// Logs_20140328.<Op>). Lambda execution logs are routed here under
// /aws/lambda/<fn> so `aws logs tail` / FilterLogEvents work like real AWS.
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

// Lambda creates one log stream per invocation, so recurring invokers
// (EventBridge schedules, the SQS ESM poller) would grow store.logs forever.
// putLogEvent evicts the oldest streams past this cap; client-created streams
// (CreateLogStream API) are deliberately never auto-evicted.
const MAX_STREAMS_PER_GROUP = Math.max(1, parseInt(process.env.MOCKCLOUD_MAX_LOG_STREAMS || '200', 10) || 200);

export function handler(req, res) {
  const op = (req.headers['x-amz-target'] || '').split('.')[1] || '';
  const b  = req.parsedBody || {};
  switch (op) {
    case 'CreateLogGroup':     return done(res, ensureGroupNew(res, b));
    case 'CreateLogStream':    return createLogStream(res, b);
    case 'PutLogEvents':       return putLogEventsOp(res, b);
    case 'GetLogEvents':       return getLogEvents(res, b);
    case 'FilterLogEvents':    return filterLogEvents(res, b);
    case 'DescribeLogGroups':  return describeLogGroups(res, b);
    case 'DescribeLogStreams': return describeLogStreams(res, b);
    case 'DeleteLogGroup':     { delete store.logs.groups[b.logGroupName]; return jsonResponse(res, 200, {}); }
    case 'DeleteLogStream':    { const g = store.logs.groups[b.logGroupName]; if (g) delete g.streams[b.logStreamName]; return jsonResponse(res, 200, {}); }
    default:                   return errorJson(res, 400, 'UnknownOperationException', `Unknown Logs op: ${op}`);
  }
}

function ensureGroup(name) {
  if (!store.logs.groups[name]) {
    store.logs.groups[name] = { name, arn: arn('logs', `log-group:${name}:*`), created: Date.now(), streams: {} };
  }
  return store.logs.groups[name];
}
function ensureStream(groupName, streamName) {
  const g = ensureGroup(groupName);
  if (!g.streams[streamName]) g.streams[streamName] = { name: streamName, created: Date.now(), lastEventTs: 0, events: [] };
  return g.streams[streamName];
}

function ensureGroupNew(res, b) {
  if (store.logs.groups[b.logGroupName]) { errorJson(res, 400, 'ResourceAlreadyExistsException', 'The specified log group already exists'); return false; }
  ensureGroup(b.logGroupName); return true;
}
function done(res, ok) { if (ok) jsonResponse(res, 200, {}); }

function createLogStream(res, b) {
  const g = store.logs.groups[b.logGroupName];
  if (!g) return errorJson(res, 400, 'ResourceNotFoundException', 'The specified log group does not exist');
  if (g.streams[b.logStreamName]) return errorJson(res, 400, 'ResourceAlreadyExistsException', 'The specified log stream already exists');
  // Mark API-created streams so putLogEvent's cap eviction skips them — a
  // client may be paginating one while Lambda churns auto-streams in the group.
  ensureStream(b.logGroupName, b.logStreamName).userCreated = true;
  return jsonResponse(res, 200, {});
}

function putLogEventsOp(res, b) {
  const s = store.logs.groups[b.logGroupName]?.streams[b.logStreamName];
  if (!s) return errorJson(res, 400, 'ResourceNotFoundException', 'The specified log stream does not exist');
  for (const e of b.logEvents || []) s.events.push({ timestamp: e.timestamp, message: e.message, ingestionTime: Date.now(), eventId: randomId(32) });
  s.events.sort((a, c) => a.timestamp - c.timestamp);
  if (s.events.length > 10000) s.events.splice(0, s.events.length - 10000);
  s.lastEventTs = s.events.at(-1)?.timestamp || 0;
  return jsonResponse(res, 200, { nextSequenceToken: randomId(56) });
}

// Tokens encode a position in the time-ordered event list as '<dir>/<ts>/<k>':
// skip every event with timestamp < ts, then skip k events with timestamp ==
// ts. 'f/...' is the next position reading forward, 'b/...' the boundary
// reading backward. Unlike the previous positional-index cursors these survive
// concurrent writes — out-of-order PutLogEvents insertions and trimming at the
// 10000-event cap shift array indices but not timestamps. Returning a token
// unchanged when a direction is exhausted is AWS's documented signal to stop,
// so a boundary call echoes the caller's token back byte-identical; fresh
// tokens are derived only from events actually returned. Legacy/unparseable
// tokens are treated as absent. Residual limitation (matching real AWS): an
// event written with a timestamp older than a forward cursor will never appear
// in forward pages — inherent to time-ordered cursors.
function parseToken(tok) {
  const m = typeof tok === 'string' && /^([fb])\/(\d+)\/(\d+)$/.exec(tok);
  return m ? { dir: m[1], ts: parseInt(m[2], 10), skip: parseInt(m[3], 10) } : null;
}

// Index of the first event with timestamp >= ts (evs is timestamp-sorted).
function firstAt(evs, ts) {
  let i = 0;
  while (i < evs.length && evs[i].timestamp < ts) i++;
  return i;
}

// Resolve a token to its boundary index. skip is clamped to the events that
// actually share ts, so trimmed equal-ts events can't push the cursor past
// later timestamps.
function tokenPos(evs, tok) {
  const i0 = firstAt(evs, tok.ts);
  let i1 = i0;
  while (i1 < evs.length && evs[i1].timestamp === tok.ts) i1++;
  return Math.min(i0 + tok.skip, i1);
}

function getLogEvents(res, b) {
  const s = store.logs.groups[b.logGroupName]?.streams[b.logStreamName];
  if (!s) return errorJson(res, 400, 'ResourceNotFoundException', 'The specified log stream does not exist');
  const evs = s.events.filter(e =>
    (b.startTime == null || e.timestamp >= b.startTime) && (b.endTime == null || e.timestamp < b.endTime));
  const n = evs.length;
  const limit = b.limit || 10000;

  const tok = parseToken(b.nextToken);
  let start, end;
  if (tok?.dir === 'b') {                      // page backward to older events
    end   = tokenPos(evs, tok);
    start = Math.max(end - limit, 0);
  } else if (tok?.dir === 'f') {               // page forward to newer events
    start = tokenPos(evs, tok);
    end   = Math.min(start + limit, n);
  } else if (b.startFromHead) {                // first call, oldest-first
    start = 0; end = Math.min(limit, n);
  } else {                                     // first call, newest window (AWS default)
    end = n; start = Math.max(n - limit, 0);
  }

  const page = evs.slice(start, end);
  // Non-empty page: tokens point just past the last / just before the first
  // event returned. Empty page: echo the caller's token byte-identical in its
  // own direction (the AWS stop signal) and mirror its position for the other.
  const fwd = page.length ? `f/${page.at(-1).timestamp}/${end - firstAt(evs, page.at(-1).timestamp)}`
    : tok?.dir === 'f' ? b.nextToken : `f/${tok?.ts ?? 0}/${tok?.skip ?? 0}`;
  const bwd = page.length ? `b/${page[0].timestamp}/${start - firstAt(evs, page[0].timestamp)}`
    : tok?.dir === 'b' ? b.nextToken : `b/${tok?.ts ?? 0}/${tok?.skip ?? 0}`;
  return jsonResponse(res, 200, {
    events: page.map(e => ({ timestamp: e.timestamp, message: e.message, ingestionTime: e.ingestionTime })),
    nextForwardToken:  fwd,
    nextBackwardToken: bwd,
  });
}

function filterLogEvents(res, b) {
  const g = store.logs.groups[b.logGroupName];
  if (!g) return errorJson(res, 400, 'ResourceNotFoundException', 'The specified log group does not exist');
  const streamNames = b.logStreamNames || Object.keys(g.streams);
  const out = [];
  for (const sn of streamNames) {
    const s = g.streams[sn];
    if (!s) continue;
    for (const e of s.events) {
      if (b.startTime != null && e.timestamp < b.startTime) continue;
      if (b.endTime != null && e.timestamp >= b.endTime) continue;
      if (b.filterPattern && !matchFilter(b.filterPattern, e.message)) continue;
      out.push({ logStreamName: sn, timestamp: e.timestamp, message: e.message, ingestionTime: e.ingestionTime, eventId: e.eventId });
    }
  }
  out.sort((a, c) => a.timestamp - c.timestamp);
  return jsonResponse(res, 200, { events: out, searchedLogStreams: streamNames.map(n => ({ logStreamName: n, searchedCompletely: true })) });
}

function describeLogGroups(res, b) {
  const prefix = b.logGroupNamePrefix || '';
  const logGroups = Object.values(store.logs.groups).filter(g => g.name.startsWith(prefix))
    .map(g => ({ logGroupName: g.name, arn: g.arn, creationTime: g.created, storedBytes: 0 }));
  return jsonResponse(res, 200, { logGroups });
}

function describeLogStreams(res, b) {
  const g = store.logs.groups[b.logGroupName];
  if (!g) return errorJson(res, 400, 'ResourceNotFoundException', 'The specified log group does not exist');
  const prefix = b.logStreamNamePrefix || '';
  const logStreams = Object.values(g.streams).filter(s => s.name.startsWith(prefix)).map(s => ({
    logStreamName: s.name, creationTime: s.created, lastEventTimestamp: s.lastEventTs, storedBytes: 0,
    arn: arn('logs', `log-group:${g.name}:log-stream:${s.name}`),
  }));
  return jsonResponse(res, 200, { logStreams });
}

// Minimal CloudWatch Logs filter-pattern support: a quoted "term" or bare term →
// substring match. (The full filter-pattern grammar is not implemented.)
function matchFilter(pattern, message) {
  const term = String(pattern).replace(/^"|"$/g, '').trim();
  return !term || String(message).includes(term);
}

// Entry point used by Lambda to stream execution logs into /aws/lambda/<fn>.
export function putLogEvent(groupName, streamName, message, timestamp = Date.now()) {
  const s = ensureStream(groupName, streamName);
  s.events.push({ timestamp, message, ingestionTime: Date.now(), eventId: randomId(32) });
  s.lastEventTs = timestamp;
  if (s.events.length > 10000) s.events.splice(0, s.events.length - 10000);
  // Evict the oldest streams (by last activity) past the cap — never the one
  // just written to, and never streams created via the CreateLogStream API.
  const streams = store.logs.groups[groupName].streams;
  const names = Object.keys(streams);
  if (names.length > MAX_STREAMS_PER_GROUP) {
    const oldest = names.filter(n => n !== streamName && !streams[n].userCreated)
      .sort((a, c) => (streams[a].lastEventTs || streams[a].created) - (streams[c].lastEventTs || streams[c].created));
    for (const n of oldest.slice(0, names.length - MAX_STREAMS_PER_GROUP)) delete streams[n];
  }
}
