// middleware/http.js — shared HTTP helpers for the MockCloud daemon.
//
// Owns four concerns that used to be duplicated across src/index.js and
// tests/helpers/server.js (and were the load-bearing cause of several
// cross-origin attacks reported against the project):
//
//   1. CORS gating — echo Access-Control-Allow-Origin only for allowlisted
//      Origin headers; reject cross-origin browser writes outright.
//   2. Body parsing — only auto-populate req.parsedBody when Content-Type is
//      JSON-family. text/plain bodies (the simple-CORS CSRF trick) are no
//      longer silently JSON-parsed.
//   3. Request body reader — drain the stream once.
//   4. safeJoin — path-containment helper so on-disk writes can't escape
//      their root via user-controlled segments (e.g. S3 bucket names).
//
// AWS SDKs / curl / Terraform / server-side proxies don't send an Origin
// header, so they're unaffected — the new gate fires only on actual browser
// cross-origin traffic.

import path from 'path';

const PORT    = parseInt(process.env.PORT    || '4566');
const UI_PORT = parseInt(process.env.UI_PORT || '4567');

const ENV_ORIGINS = (process.env.MOCKCLOUD_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const DEFAULT_ORIGINS = [];
for (const host of ['localhost', '127.0.0.1']) {
  for (const port of [PORT, UI_PORT]) {
    DEFAULT_ORIGINS.push(`http://${host}:${port}`);
  }
}

export const ALLOWED_ORIGINS = new Set([...DEFAULT_ORIGINS, ...ENV_ORIGINS]);

const JSON_CT_PREFIXES = [
  'application/json',
  'application/x-amz-json-1.0',
  'application/x-amz-json-1.1',
];

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

export async function attachBody(req) {
  req.rawBuffer  = await readBody(req);
  req.rawBody    = req.rawBuffer.toString();
  req.parsedBody = parseBodyForJson(req);
}

export function parseBodyForJson(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!JSON_CT_PREFIXES.some(p => ct.startsWith(p))) return {};
  try { return JSON.parse(req.rawBody || '{}'); } catch { return {}; }
}

export function originAllowed(origin) {
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}

export function detectScope(req) {
  const u = req.url || '';
  if (u.startsWith('/mockcloud/terminal/') || u === '/mockcloud/terminal') return 'terminal';
  if (u.startsWith('/mockcloud/'))                                         return 'ui';
  return 'aws';
}

// Apply CORS headers and gate the request.
// Returns true if the handler should continue; false if a response was
// already written (preflight, or rejection) and the caller should bail.
export function applyCors(req, res, scope = detectScope(req)) {
  const origin = req.headers.origin;
  const ok     = originAllowed(origin);

  if (origin) {
    res.setHeader('Vary', 'Origin');
    if (ok) res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Amz-Target, X-Amz-Date, X-Amz-Security-Token, X-Amz-Content-Sha256, X-Api-Key, X-Amz-User-Agent');
  res.setHeader('Access-Control-Expose-Headers',
    'ETag, x-amz-request-id, x-amz-id-2, x-amz-version-id');

  // UI / terminal preflight is answered here. S3 (aws scope) CORS preflight
  // must reach the S3 handler, which enforces per-bucket CORS rules — so let
  // aws-scope OPTIONS fall through. OPTIONS is non-mutating, so the
  // cross-origin write gate below doesn't apply to it regardless.
  if (req.method === 'OPTIONS' && scope !== 'aws') { res.writeHead(204); res.end(); return false; }

  // Terminal endpoints spawn shells. Only the local UI may call — require
  // Origin to be present AND in the allowlist.
  if (scope === 'terminal' && (!origin || !ok)) {
    return reject(res, 'cross-origin terminal access not allowed');
  }

  // Any state-changing request whose Origin is present and not allowlisted:
  // reject. Browser-initiated CSRF gets stopped here. CLI/SDK callers have
  // no Origin header so they pass through.
  if (MUTATING_METHODS.has(req.method) && origin && !ok) {
    return reject(res, 'cross-origin request not allowed');
  }

  // Defense in depth: Sec-Fetch-Site can't be forged by attacker JS and is
  // present in all modern browsers.
  if (MUTATING_METHODS.has(req.method) && req.headers['sec-fetch-site'] === 'cross-site') {
    return reject(res, 'cross-site request not allowed');
  }

  return true;
}

function reject(res, message) {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ __type: 'Forbidden', message }));
  return false;
}

// Resolve `...parts` under `root` and assert the result stays inside `root`.
// Throws Error('path escape') on traversal attempt. Works on Windows because
// path.sep is platform-aware and path.isAbsolute catches drive-letter and UNC
// escapes (`C:\foo`, `\\server\share`).
export function safeJoin(root, ...parts) {
  const absRoot   = path.resolve(root);
  const absTarget = path.resolve(absRoot, ...parts);
  if (absTarget === absRoot) return absTarget;
  const rel = path.relative(absRoot, absTarget);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error('path escape');
  }
  return absTarget;
}
