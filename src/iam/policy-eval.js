// iam/policy-eval.js — opt-in IAM policy evaluation.
//
// OFF by default. MOCKCLOUD_IAM=soft logs would-be denials but never blocks;
// MOCKCLOUD_IAM=strict returns 403 AccessDenied. Evaluation combines the
// caller's identity policies (store.iam.identityPolicies[principal]) with the
// target's resource policy (S3 bucket policy, SQS/SNS Policy attribute):
// explicit Deny wins, else any matching Allow grants, else implicit deny.
//
// Only s3 / sqs / sns / lambda / sts are enforced; other services pass through.
// Action/resource derivation + the condition-operator set are a documented
// subset aimed at everyday policies, not full IAM fidelity.
import { store } from '../store.js';
import { escapeXml } from '../middleware/response.js';
import crypto from 'crypto';

const ENFORCED = new Set(['s3', 'sqs', 'sns', 'lambda', 'sts']);

export function iamMode() {
  const m = (process.env.MOCKCLOUD_IAM || '').toLowerCase();
  return m === 'soft' || m === 'strict' ? m : 'off';
}

// null = allowed / not in scope; { code, message } = blocked (strict only).
export function enforceIam(req) {
  if (req.method === 'OPTIONS') return null;
  const ctx = deriveContext(req);
  if (!ctx || !ENFORCED.has(ctx.service)) return null;

  const decision = decide(ctx);
  if (decision.effect === 'Allow') return null;

  if (iamMode() === 'soft') {
    console.warn(`[IAM soft] would DENY ${ctx.principal} → ${ctx.action} on ${ctx.resource} (${decision.reason})`);
    return null;
  }
  return { code: 'AccessDenied', message: `User: ${ctx.principal} is not authorized to perform: ${ctx.action} on resource: ${ctx.resource}` };
}

export function sendIamError(req, res, err) {
  const isJson = !!req.headers['x-amz-target'] || (req.headers['content-type'] || '').includes('json');
  const reqId = crypto.randomBytes(8).toString('hex');
  if (isJson) {
    res.writeHead(403, { 'Content-Type': 'application/x-amz-json-1.0', 'x-amzn-RequestId': reqId });
    res.end(JSON.stringify({ __type: err.code, message: err.message }));
  } else {
    res.writeHead(403, { 'Content-Type': 'application/xml', 'x-amzn-RequestId': reqId });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><ErrorResponse><Error><Code>${err.code}</Code><Message>${escapeXml(err.message)}</Message></Error><RequestId>${reqId}</RequestId></ErrorResponse>`);
  }
}

// ── Decision ─────────────────────────────────────────────────────────────────
function decide(ctx) {
  const idEffect = evalStatements(identityStatements(ctx.principal), ctx);
  const resEffect = evalStatements(ctx.resourceStatements, ctx);
  if (idEffect === 'Deny' || resEffect === 'Deny') return { effect: 'Deny', reason: 'explicit Deny' };
  if (idEffect === 'Allow' || resEffect === 'Allow') return { effect: 'Allow' };
  return { effect: 'ImplicitDeny', reason: 'no matching Allow' };
}

function evalStatements(statements, ctx) {
  let allow = false;
  for (const st of statements) {
    if (!statementMatches(st, ctx)) continue;
    if (st.Effect === 'Deny') return 'Deny';
    if (st.Effect === 'Allow') allow = true;
  }
  return allow ? 'Allow' : 'NoMatch';
}

function statementMatches(st, ctx) {
  return matchAction(st, ctx.action) && matchResource(st, ctx.resource) && matchConditions(st.Condition, ctx.ctxKeys);
}

function matchAction(st, action) {
  const a = action.toLowerCase();
  if (st.Action != null)    return toArr(st.Action).some(p => glob(String(p).toLowerCase(), a));
  if (st.NotAction != null) return !toArr(st.NotAction).some(p => glob(String(p).toLowerCase(), a));
  return true;
}

function matchResource(st, resource) {
  if (st.Resource != null)    return toArr(st.Resource).some(p => glob(String(p), resource));
  if (st.NotResource != null) return !toArr(st.NotResource).some(p => glob(String(p), resource));
  return true;
}

function matchConditions(cond, keys) {
  if (!cond) return true;
  for (const [op, map] of Object.entries(cond)) {
    for (const [key, expected] of Object.entries(map)) {
      if (!conditionOp(op, keys[key], expected)) return false;
    }
  }
  return true;
}

function conditionOp(op, actual, expected) {
  const exp = toArr(expected).map(String);
  switch (op) {
    case 'StringEquals':         return actual != null && exp.includes(String(actual));
    case 'StringNotEquals':      return actual != null && !exp.includes(String(actual));
    case 'StringLike':           return actual != null && exp.some(p => glob(p, String(actual)));
    case 'StringNotLike':        return actual != null && !exp.some(p => glob(p, String(actual)));
    case 'Bool':                 return actual != null && exp.includes(String(actual));
    case 'IpAddress':            return exp.some(c => ipInCidr(actual, c));
    case 'NotIpAddress':         return !exp.some(c => ipInCidr(actual, c));
    case 'DateLessThan':         return actual != null && exp.some(d => Date.parse(actual) < Date.parse(d));
    case 'DateLessThanEquals':   return actual != null && exp.some(d => Date.parse(actual) <= Date.parse(d));
    case 'DateGreaterThan':      return actual != null && exp.some(d => Date.parse(actual) > Date.parse(d));
    case 'DateGreaterThanEquals':return actual != null && exp.some(d => Date.parse(actual) >= Date.parse(d));
    default:                     return true;   // unsupported operator → don't block on it
  }
}

// ── Context derivation ───────────────────────────────────────────────────────
function deriveContext(req) {
  const url = new URL(req.url, 'http://localhost');
  const principal = derivePrincipal(req, url);
  const ctxKeys = {
    'aws:username':    principal,
    'aws:SourceIp':    normalizeIp(req.socket?.remoteAddress),
    'aws:CurrentTime': new Date().toISOString(),
  };
  const base = { principal, ctxKeys, resourceStatements: [] };
  const target = req.headers['x-amz-target'] || '';
  const json = req.parsedBody || {};
  const form = new URLSearchParams(req.rawBody || '');
  const queryAction = url.searchParams.get('Action') || form.get('Action');

  // SQS (JSON target)
  if (target.startsWith('AmazonSQS.')) {
    const queueUrl = json.QueueUrl || form.get('QueueUrl') || '';
    const name = queueUrl.split('/').pop();
    const resource = name ? sqsArn(name) : '*';
    return { ...base, service: 'sqs', action: 'sqs:' + target.split('.')[1], resource,
      resourceStatements: normalizeStatements(store.sqs.queues[queueUrl]?.attributes?.Policy) };
  }
  // Lambda (REST paths or AWSLambda target)
  if (target.startsWith('AWSLambda') || url.pathname.includes('/functions')) {
    return deriveLambda(req, url, base);
  }
  // Query/form services: SNS, STS, (SES/EC2/IAM pass through, not enforced)
  if (queryAction) {
    if (STS_ACTIONS.has(queryAction)) return { ...base, service: 'sts', action: 'sts:' + queryAction, resource: '*' };
    if (SNS_ACTIONS.has(queryAction)) {
      const topicArn = json.TopicArn || form.get('TopicArn') || '*';
      return { ...base, service: 'sns', action: 'sns:' + queryAction, resource: topicArn,
        resourceStatements: normalizeStatements(store.sns.topics[topicArn]?.attributes?.Policy) };
    }
    return { ...base, service: serviceForAction(queryAction), action: queryAction, resource: '*' };
  }
  // Default: treat as S3 (path-style)
  return deriveS3(req, url, base);
}

function deriveS3(req, url, base) {
  const parts = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
  const bucket = parts[0];
  const key = parts.slice(1).join('/');
  let action = 's3:ListAllMyBuckets';
  let resource = 'arn:aws:s3:::';
  if (bucket && key) {
    resource = `arn:aws:s3:::${bucket}/${key}`;
    action = ({ GET: 's3:GetObject', HEAD: 's3:GetObject', PUT: 's3:PutObject', POST: 's3:PutObject', DELETE: 's3:DeleteObject' })[req.method] || 's3:GetObject';
  } else if (bucket) {
    resource = `arn:aws:s3:::${bucket}`;
    action = ({ GET: 's3:ListBucket', HEAD: 's3:ListBucket', PUT: 's3:CreateBucket', DELETE: 's3:DeleteBucket' })[req.method] || 's3:ListBucket';
  }
  const resourceStatements = bucket ? normalizeStatements(store.s3.buckets?.[bucket]?.policy) : [];
  return { ...base, service: 's3', action, resource, resourceStatements };
}

function deriveLambda(req, url, base) {
  const m = /\/functions\/([^/?]+)/.exec(url.pathname);
  const name = m ? decodeURIComponent(m[1]) : null;
  const resource = name ? `arn:aws:lambda:us-east-1:000000000000:function:${name}` : '*';
  let action = 'lambda:ListFunctions';
  if (url.pathname.endsWith('/invocations')) action = 'lambda:InvokeFunction';
  else if (name && req.method === 'GET') action = 'lambda:GetFunction';
  else if (name && req.method === 'DELETE') action = 'lambda:DeleteFunction';
  else if (req.method === 'POST') action = 'lambda:CreateFunction';
  return { ...base, service: 'lambda', action, resource };
}

// ── Policy gathering ─────────────────────────────────────────────────────────
function identityStatements(principal) {
  return (store.iam.identityPolicies?.[principal] || []).flatMap(normalizeStatements);
}

function normalizeStatements(doc) {
  if (!doc) return [];
  const d = typeof doc === 'string' ? safeJson(doc) : doc;
  const s = d?.Statement;
  return Array.isArray(s) ? s : s ? [s] : [];
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const STS_ACTIONS = new Set(['AssumeRole', 'GetCallerIdentity', 'GetSessionToken']);
const SNS_ACTIONS = new Set(['CreateTopic', 'DeleteTopic', 'Publish', 'PublishBatch', 'Subscribe', 'Unsubscribe', 'SetTopicAttributes', 'GetTopicAttributes', 'ListSubscriptionsByTopic']);

function serviceForAction(action) { return action.toLowerCase(); }   // unenforced fallthrough

function derivePrincipal(req, url) {
  const fromHeader = /Credential=([^/,\s]+)/.exec(req.headers['authorization'] || '')?.[1];
  const fromQuery = (url.searchParams.get('X-Amz-Credential') || '').split('/')[0];
  const akid = fromHeader || fromQuery;
  if (!akid) return 'anonymous';
  return store.iam.accessKeyOwners?.[akid] || akid;
}

function sqsArn(name) { return `arn:aws:sqs:us-east-1:000000000000:${name}`; }
function toArr(v) { return Array.isArray(v) ? v : [v]; }
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// Glob with `*` (any run) and `?` (one char); everything else literal.
function glob(pattern, value) {
  if (pattern === '*') return true;
  const re = new RegExp('^' + pattern.split('').map(c =>
    c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('') + '$');
  return re.test(value);
}

function normalizeIp(ip) {
  if (!ip) return undefined;
  if (ip === '::1') return '127.0.0.1';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function ipInCidr(ip, cidr) {
  if (!ip) return false;
  if (!cidr.includes('/')) return ip === cidr;
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const a = ipToInt(ip), b = ipToInt(range);
  if (a == null || b == null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function ipToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  return ((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | +p[3]) >>> 0;
}
