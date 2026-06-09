// services/cloudwatchlogs.js — CloudWatch Logs (awsJson1.1, X-Amz-Target:
// Logs_20140328.<Op>). Lambda execution logs are routed here under
// /aws/lambda/<fn> so `aws logs tail` / FilterLogEvents work like real AWS.
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

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
  ensureStream(b.logGroupName, b.logStreamName);
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

function getLogEvents(res, b) {
  const s = store.logs.groups[b.logGroupName]?.streams[b.logStreamName];
  if (!s) return errorJson(res, 400, 'ResourceNotFoundException', 'The specified log stream does not exist');
  let evs = s.events.filter(e =>
    (b.startTime == null || e.timestamp >= b.startTime) && (b.endTime == null || e.timestamp < b.endTime));
  evs = evs.slice(0, b.limit || 10000);
  return jsonResponse(res, 200, {
    events: evs.map(e => ({ timestamp: e.timestamp, message: e.message, ingestionTime: e.ingestionTime })),
    nextForwardToken: 'f/' + randomId(40), nextBackwardToken: 'b/' + randomId(40),
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
}
