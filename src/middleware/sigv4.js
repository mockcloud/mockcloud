// middleware/sigv4.js — opt-in AWS Signature V4 verification.
//
// OFF by default. Enable with MOCKCLOUD_VERIFY_SIGV4=true. When on, every
// request is checked before dispatch: the signature in the Authorization
// header (or the X-Amz-* presigned query) is recomputed from the secret stored
// in store.iam.accessKeys and compared. Mismatch → 403 SignatureDoesNotMatch;
// unknown key → 403 InvalidAccessKeyId; absent → 403 MissingAuthenticationToken.
//
// The reconstruction targets the canonical form the AWS SDK v3 clients produce
// for the requests MockCloud serves (simple paths + query strings). Exotic
// canonical-URI normalization (e.g. S3 keys needing double-encoding) is out of
// scope — this is a local dev aid, documented as such.
import crypto from 'crypto';
import { store } from '../store.js';
import { escapeXml } from './response.js';

export function sigv4Enabled() {
  return process.env.MOCKCLOUD_VERIFY_SIGV4 === 'true';
}

// Returns null when the request is authentic, or { code, message } to reject.
export function verifySigV4(req) {
  // CORS preflight isn't signed by AWS clients — let it through.
  if (req.method === 'OPTIONS') return null;
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.get('X-Amz-Algorithm')) return verifyPresigned(req, url);
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('AWS4-HMAC-SHA256')) return verifyHeaderAuth(req, url, auth);
  return { code: 'MissingAuthenticationToken', message: 'Request is missing Authentication Token' };
}

// Write a 403 in the shape the caller expects: JSON for the JSON-protocol
// services (x-amz-target / json content-type), XML otherwise (S3, query).
export function sendSigV4Error(req, res, err) {
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

function verifyHeaderAuth(req, url, auth) {
  const parsed = parseAuthHeader(auth);
  if (!parsed) return { code: 'IncompleteSignature', message: 'Authorization header requires Credential, SignedHeaders and Signature.' };
  const scope = parsed.credential.split('/');               // akid/date/region/service/aws4_request
  const [accessKeyId, dateStamp, region, service] = scope;
  const secret = lookupSecret(accessKeyId);
  if (!secret) return invalidKey(accessKeyId);

  const amzDate = req.headers['x-amz-date'] || '';
  const payloadHash = req.headers['x-amz-content-sha256'] || sha256hex(req.rawBuffer || Buffer.alloc(0));
  const canonicalRequest = buildCanonicalRequest({
    method: req.method, uri: url.pathname,
    query: canonicalQueryString(url.searchParams),
    headers: req, signedHeaders: parsed.signedHeaders, payloadHash,
  });
  const expected = computeSignature(secret, dateStamp, region, service, amzDate, canonicalRequest);
  return matches(expected, parsed.signature)
    ? null
    : { code: 'SignatureDoesNotMatch', message: 'The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.' };
}

function verifyPresigned(req, url) {
  const q = url.searchParams;
  const credential = q.get('X-Amz-Credential') || '';
  const [accessKeyId, dateStamp, region, service] = credential.split('/');
  const secret = lookupSecret(accessKeyId);
  if (!secret) return invalidKey(accessKeyId);

  // Honor expiry (same window the S3 handler enforces).
  const signedMs = parseAmzDate(q.get('X-Amz-Date'));
  const expires = parseInt(q.get('X-Amz-Expires') || '0', 10);
  if (!signedMs || expires <= 0) return { code: 'AuthorizationQueryParametersError', message: 'Invalid X-Amz-Date or X-Amz-Expires' };
  if (Date.now() > signedMs + expires * 1000) return { code: 'AccessDenied', message: 'Request has expired' };

  const signedHeaders = q.get('X-Amz-SignedHeaders') || 'host';
  const provided = q.get('X-Amz-Signature') || '';
  const canonicalRequest = buildCanonicalRequest({
    method: req.method, uri: url.pathname,
    query: canonicalQueryString(q, 'X-Amz-Signature'),
    headers: req, signedHeaders, payloadHash: 'UNSIGNED-PAYLOAD',
  });
  const expected = computeSignature(secret, dateStamp, region, service, q.get('X-Amz-Date'), canonicalRequest);
  return matches(expected, provided)
    ? null
    : { code: 'SignatureDoesNotMatch', message: 'The request signature we calculated does not match the signature you provided. Check your key and signing method.' };
}

// ── Canonicalization ────────────────────────────────────────────────────────
function buildCanonicalRequest({ method, uri, query, headers, signedHeaders, payloadHash }) {
  const names = signedHeaders.split(';');
  const canonicalHeaders = names.map(n => `${n}:${headerValue(headers, n)}\n`).join('');
  return [method, uri || '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
}

// Node lowercases header names; collapse internal whitespace per SigV4 rules.
function headerValue(req, name) {
  const v = req.headers[name];
  const raw = Array.isArray(v) ? v.join(',') : (v ?? '');
  return String(raw).trim().replace(/\s+/g, ' ');
}

function canonicalQueryString(params, exclude) {
  const pairs = [];
  for (const [k, v] of params.entries()) {
    if (exclude && k === exclude) continue;
    pairs.push([awsUriEncode(k), awsUriEncode(v)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

// RFC-3986 encoding AWS expects (encodeURIComponent leaves !'()* unescaped).
function awsUriEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// ── Signing ──────────────────────────────────────────────────────────────────
function computeSignature(secret, dateStamp, region, service, amzDate, canonicalRequest) {
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + secret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  return hmac(kSigning, stringToSign).toString('hex');
}

function hmac(key, data) { return crypto.createHmac('sha256', key).update(data, 'utf8').digest(); }
function sha256hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

// ── Helpers ──────────────────────────────────────────────────────────────────
function parseAuthHeader(auth) {
  const credential = /Credential=([^,\s]+)/.exec(auth)?.[1];
  const signedHeaders = /SignedHeaders=([^,\s]+)/.exec(auth)?.[1];
  const signature = /Signature=([0-9a-fA-F]+)/.exec(auth)?.[1];
  if (!credential || !signedHeaders || !signature) return null;
  return { credential, signedHeaders, signature };
}

function lookupSecret(accessKeyId) {
  return accessKeyId ? store.iam.accessKeys?.[accessKeyId] : undefined;
}

function invalidKey(accessKeyId) {
  return { code: 'InvalidAccessKeyId', message: `The AWS Access Key Id (${accessKeyId || ''}) you provided does not exist in our records.` };
}

function matches(expectedHex, providedHex) {
  if (!providedHex || expectedHex.length !== providedHex.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(providedHex, 'hex')); }
  catch { return false; }
}

// X-Amz-Date is ISO basic format: 20230101T000000Z
function parseAmzDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s || '');
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
