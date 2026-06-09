// services/lambda.js — Lambda emulator
//
// Two surfaces:
//   1. handler(req, res)        — AWS API (POST /2015-03-31/functions/...)
//   2. invokeLambda(name, evt)  — internal helper called by SNS/EventBridge/
//                                 DynamoDB Streams/UI route. Single source
//                                 of truth for actually running code.
//
// All paths share runInNodeSandbox(), so a function uploaded via the AWS API
// runs the same way whether triggered by `aws lambda invoke`, the UI button,
// or a downstream service (SNS subscription, EventBridge target, DDB stream).
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson, getRawBody } from '../middleware/response.js';
import { putLogEvent } from './cloudwatchlogs.js';
import { execFile } from 'child_process';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import zlib from 'zlib';

export async function handler(req, res) {
  const url    = new URL(req.url, 'http://localhost');
  const parts  = url.pathname.split('/').filter(Boolean);
  const method = req.method;
  // /2015-03-31/functions[/:name[/invocations|code]]
  // /2015-03-31/event-source-mappings[/:uuid]
  const fnName = parts[2];
  const action = parts[3];

  const body = getRawBody(req);
  let payload = {};
  try { payload = JSON.parse(body); } catch {}

  // ── Event source mappings (route FIRST so /event-source-mappings doesn't
  //    fall into the no-fnName branches below) ──────────────────────────
  if (parts[1] === 'event-source-mappings') {
    return handleEventSourceMappings(req, res, parts, method, payload);
  }

  // ── List functions ─────────────────────────────────────────────────────
  if (method === 'GET' && !fnName) {
    return jsonResponse(res, 200, {
      Functions: Object.values(store.lambda.functions).map(fnConfig)
    });
  }

  // ── Create function ────────────────────────────────────────────────────
  if (method === 'POST' && !fnName) {
    const name = payload.FunctionName;
    if (!name) return errorJson(res, 400, 'ValidationException', 'FunctionName required');
    if (store.lambda.functions[name]) {
      return errorJson(res, 409, 'ResourceConflictException', `Function already exists: ${name}`);
    }
    // Honour Code.ZipFile (base64 zip OR raw base64 source). Most AWS SDKs
    // ship a real zip; some hand-rolled clients send a single source file
    // base64'd. Try zip first, fall back to treating it as plain bytes.
    const code = decodeUploadedCode(payload.Code);
    store.lambda.functions[name] = {
      name,
      runtime:     payload.Runtime || 'nodejs20.x',
      handler:     payload.Handler || 'index.handler',
      role:        payload.Role || '',
      memory:      payload.MemorySize || 128,
      timeout:     payload.Timeout || 3,
      env:         payload.Environment?.Variables || {},
      layers:      payload.Layers || [],
      code,
      invocations: 0,
      errors:      0,
      created:     Date.now(),
      lastInvoked: null,
      logs:        [],
    };
    return jsonResponse(res, 201, fnConfig(store.lambda.functions[name]));
  }

  // ── Get function ───────────────────────────────────────────────────────
  if (method === 'GET' && fnName && !action) {
    const fn = store.lambda.functions[fnName];
    if (!fn) return errorJson(res, 404, 'ResourceNotFoundException', `Function not found: ${fnName}`);
    // GetFunction wraps config in Configuration; CreateFunction returns it flat
    return jsonResponse(res, 200, {
      Configuration: fnConfig(fn),
      Code: { Location: `http://localhost:4566/lambda-code/${fn.name}.zip` },
      Tags: {},
    });
  }

  // ── Delete function ────────────────────────────────────────────────────
  if (method === 'DELETE' && fnName && !action) {
    if (!store.lambda.functions[fnName]) {
      return errorJson(res, 404, 'ResourceNotFoundException', `Function not found: ${fnName}`);
    }
    delete store.lambda.functions[fnName];
    res.writeHead(204); res.end(); return;
  }

  // ── Invoke ─────────────────────────────────────────────────────────────
  if (method === 'POST' && fnName && action === 'invocations') {
    const fn = store.lambda.functions[fnName];
    if (!fn) return errorJson(res, 404, 'ResourceNotFoundException', `Function not found: ${fnName}`);

    const invType   = req.headers['x-amz-invocation-type'] || 'RequestResponse';
    const requestId = randomId(36);
    let event = {};
    try { event = JSON.parse(body || '{}'); } catch { event = {}; }

    if (invType === 'Event') {
      // Async — fire and forget
      invokeLambda(fnName, event, { source: 'aws-api', requestId }).catch(()=>{});
      res.writeHead(202, { 'x-amzn-requestid': requestId });
      res.end(); return;
    }

    const outcome = await invokeLambda(fnName, event, { source: 'aws-api', requestId });
    if (outcome.error) {
      res.writeHead(200, {
        'Content-Type':            'application/json',
        'x-amzn-requestid':        requestId,
        'x-amz-function-error':    'Unhandled',
      });
      res.end(JSON.stringify({ errorMessage: outcome.error, errorType: 'Error' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type':            'application/json',
      'x-amzn-requestid':        requestId,
      'x-amz-executed-version':  '$LATEST',
      'x-amzn-trace-id':         `Root=1-${randomId(8)}-${randomId(24)}`,
    });
    res.end(outcome.result);
    return;
  }

  // ── Upload code (PUT /code) ────────────────────────────────────────────
  if (method === 'PUT' && fnName && action === 'code') {
    const fn = store.lambda.functions[fnName];
    if (!fn) return errorJson(res, 404, 'ResourceNotFoundException', `Function not found: ${fnName}`);
    fn.code = decodeUploadedCode(payload) || body.slice(0, 10240);
    return jsonResponse(res, 200, fnConfig(fn));
  }

  // ── Get function configuration ─────────────────────────────────────────
  if (method === 'GET' && fnName && action === 'configuration') {
    const fn = store.lambda.functions[fnName];
    if (!fn) return errorJson(res, 404, 'ResourceNotFoundException', `Function not found: ${fnName}`);
    return jsonResponse(res, 200, fnConfig(fn));
  }

  // ── Update function configuration (timeout / memory / env / layers) ─────
  if (method === 'PUT' && fnName && action === 'configuration') {
    const fn = store.lambda.functions[fnName];
    if (!fn) return errorJson(res, 404, 'ResourceNotFoundException', `Function not found: ${fnName}`);
    if (payload.MemorySize !== undefined) fn.memory  = payload.MemorySize;
    if (payload.Timeout    !== undefined) fn.timeout = payload.Timeout;
    if (payload.Handler    !== undefined) fn.handler = payload.Handler;
    if (payload.Runtime    !== undefined) fn.runtime = payload.Runtime;
    if (payload.Role       !== undefined) fn.role    = payload.Role;
    if (payload.Environment?.Variables)   fn.env     = payload.Environment.Variables;
    if (payload.Layers     !== undefined) fn.layers  = payload.Layers;
    return jsonResponse(res, 200, fnConfig(fn));
  }

  // ── List versions ──────────────────────────────────────────────────────
  if (method === 'GET' && fnName && action === 'versions') {
    const fn = store.lambda.functions[fnName];
    if (!fn) return errorJson(res, 404, 'ResourceNotFoundException', `Function not found: ${fnName}`);
    return jsonResponse(res, 200, { Versions: [{ ...fnConfig(fn), Version: '$LATEST' }], NextMarker: null });
  }

  // ── Code signing config — return 200 with empty ARN (provider crashes on 404) ──
  if (fnName && action === 'code-signing-config') {
    return jsonResponse(res, 200, { CodeSigningConfigArn: '', FunctionName: fnName });
  }

  // ── Concurrency / other sub-resources ─────────────────────────────────
  // These specific handlers must come BEFORE the broad GET catch-all below.
  if (method === 'GET' && fnName && action === 'concurrency') {
    return jsonResponse(res, 200, { ReservedConcurrentExecutions: -1 });
  }
  if (method === 'GET' && fnName && action === 'policy') {
    return errorJson(res, 404, 'ResourceNotFoundException', `No policy for function: ${fnName}`);
  }

  // Broad catch: any unknown GET sub-resource under a function → JSON 404
  if (method === 'GET' && fnName && action) {
    return errorJson(res, 404, 'ResourceNotFoundException', `Unsupported sub-resource: ${action}`);
  }

  errorJson(res, 400, 'UnknownOperation', `Unknown Lambda operation: ${method} ${url.pathname}`);
}

// ── Event source mappings ────────────────────────────────────────────────
function handleEventSourceMappings(req, res, parts, method, payload) {
  // POST /2015-03-31/event-source-mappings
  if (method === 'POST' && parts.length === 2) {
    const fnName    = (payload.FunctionName || '').split(':').pop();
    const sourceArn = payload.EventSourceArn || '';
    if (!fnName || !sourceArn) {
      return errorJson(res, 400, 'InvalidParameterValueException', 'FunctionName and EventSourceArn required');
    }
    const uuid = randomId(36);
    const mapping = {
      UUID:                  uuid,
      FunctionArn:           arn('lambda', `function:${fnName}`),
      EventSourceArn:        sourceArn,
      BatchSize:             payload.BatchSize || 10,
      State:                 'Enabled',
      StateTransitionReason: 'User action',
      LastModified:          Date.now() / 1000,
    };
    store.lambda.eventSourceMappings ||= {};
    store.lambda.eventSourceMappings[uuid] = mapping;

    // Wire DDB Streams trigger
    if (sourceArn.includes(':dynamodb:') && sourceArn.includes('/stream/')) {
      // arn:aws:dynamodb:us-east-1:000000000000:table/<name>/stream/<created>
      const tableName = sourceArn.split('table/')[1]?.split('/')[0];
      if (tableName) {
        store.dynamodbstreams.triggers[tableName] ||= [];
        if (!store.dynamodbstreams.triggers[tableName].includes(fnName)) {
          store.dynamodbstreams.triggers[tableName].push(fnName);
        }
      }
    }
    return jsonResponse(res, 202, mapping);
  }

  // GET /2015-03-31/event-source-mappings
  if (method === 'GET' && parts.length === 2) {
    const all = Object.values(store.lambda.eventSourceMappings || {});
    return jsonResponse(res, 200, { EventSourceMappings: all });
  }

  // DELETE /2015-03-31/event-source-mappings/:uuid
  if (method === 'DELETE' && parts.length === 3) {
    const uuid = parts[2];
    const mapping = store.lambda.eventSourceMappings?.[uuid];
    if (!mapping) return errorJson(res, 404, 'ResourceNotFoundException', 'Mapping not found');
    // Unwire DDB trigger if any
    if (mapping.EventSourceArn?.includes(':dynamodb:')) {
      const tableName = mapping.EventSourceArn.split('table/')[1]?.split('/')[0];
      const fnName    = mapping.FunctionArn.split(':').pop();
      if (tableName && store.dynamodbstreams.triggers[tableName]) {
        store.dynamodbstreams.triggers[tableName] = store.dynamodbstreams.triggers[tableName].filter(n => n !== fnName);
      }
    }
    delete store.lambda.eventSourceMappings[uuid];
    return jsonResponse(res, 202, mapping);
  }

  return errorJson(res, 400, 'UnknownOperation', `Unknown event-source-mapping operation`);
}

// ── Shared invocation entry point ─────────────────────────────────────────
// Called by:
//   - this file's POST /invocations handler
//   - routes/lambda.js (UI invoke button)
//   - services/sns.js  (Lambda subscription)
//   - services/eventbridge.js (Lambda target)
//   - services/dynamodbstreams.js (table trigger)
//
// Returns { result: string|null, duration: number, error: string|null, requestId }.
// Always resolves; never throws.
//
// Re-entrancy guard: internally-triggered invocations (S3 / SNS / EventBridge /
// Streams — any source other than a direct API Invoke) are capped per rolling
// window so a Lambda → S3 → Lambda style loop can't run unbounded. Configurable
// via MOCKCLOUD_MAX_INTERNAL_INVOKES (default 200 per 5s).
const REENTRY_CAP = Math.max(1, parseInt(process.env.MOCKCLOUD_MAX_INTERNAL_INVOKES || '200', 10) || 200);
let _reentryWindow = { start: 0, count: 0 };
function internalBudgetExceeded(source) {
  if (!source || source === 'aws-api') return false;   // direct user Invoke is never capped
  const now = Date.now();
  if (now - _reentryWindow.start > 5000) _reentryWindow = { start: now, count: 0 };
  return ++_reentryWindow.count > REENTRY_CAP;
}

export async function invokeLambda(fnName, event, opts = {}) {
  const requestId = opts.requestId || randomId(36);
  if (internalBudgetExceeded(opts.source)) {
    return { result: null, duration: 0, error: 'MockCloud re-entrancy guard: internal invocation budget exceeded (possible event loop)', requestId };
  }
  const fn = store.lambda.functions[fnName];
  if (!fn) return { result: null, duration: 0, error: `Function not found: ${fnName}`, requestId };

  const start  = Date.now();
  fn.invocations++;
  fn.lastInvoked = Date.now();

  // Stream execution logs to CloudWatch Logs at /aws/lambda/<fn> so
  // `aws logs tail` / FilterLogEvents work like real Lambda.
  const logGroup  = `/aws/lambda/${fn.name}`;
  const logStream = `${new Date().toISOString().slice(0, 10).replace(/-/g, '/')}/[$LATEST]${requestId}`;
  const log = (level, msg) => {
    fn.logs.unshift({ t: Date.now(), level, msg });
    if (fn.logs.length > 200) fn.logs.length = 200;
    try { putLogEvent(logGroup, logStream, `[${level}] ${msg}`); } catch {}
  };
  log('INFO', `START RequestId: ${requestId} Source: ${opts.source || 'unknown'}`);

  const eventStr = typeof event === 'string' ? event : JSON.stringify(event ?? {});
  let result, error;
  try {
    if (fn.runtime.startsWith('nodejs') && fn.code) {
      result = await runInNodeSandbox(fn, eventStr);
    } else {
      // Synthetic response when no code uploaded or non-Node runtime
      result = JSON.stringify({
        statusCode: 200,
        body: JSON.stringify({ message: 'invoked (synthetic — no code uploaded)', function: fn.name, runtime: fn.runtime, event: safeParse(eventStr) }),
      });
    }
  } catch (e) {
    error = e.message || String(e);
    fn.errors++;
    log('ERROR', `Invocation failed: ${error}`);
  }

  const duration = Date.now() - start;
  log('INFO', `END Duration: ${duration}ms Status: ${error ? 500 : 200}`);
  return { result: result || null, duration, error: error || null, requestId };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return s; } }

function decodeUploadedCode(codeField) {
  if (!codeField) return '';
  // Already a string — store directly (size-capped)
  if (typeof codeField === 'string') return codeField.slice(0, 256 * 1024);
  // { ZipFile: <base64> }
  if (codeField.ZipFile) {
    const buf = Buffer.from(codeField.ZipFile, 'base64');
    const fromZip = extractZip(buf);
    if (fromZip) return fromZip;
    // Treat as raw source if zip extraction failed
    return buf.toString('utf8').slice(0, 256 * 1024);
  }
  // { S3Bucket, S3Key } — not supported, return placeholder
  return '';
}

function extractZip(buf) {
  // Tiny zip parser — handles single-file zips with stored (method 0) or
  // DEFLATE (method 8) compression, which covers everything the AWS CLI
  // and most SDKs produce. Looks for `index.js` (or .mjs/.cjs) at root,
  // falls back to deepest-match if none at root.
  try {
    // Find End of Central Directory Record. Scan back from the end since
    // it's near the tail of the file.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;

    const cdEntries = buf.readUInt16LE(eocd + 10);
    const cdSize    = buf.readUInt32LE(eocd + 12);
    const cdOffset  = buf.readUInt32LE(eocd + 16);

    let candidates = [];
    let p = cdOffset;
    for (let n = 0; n < cdEntries && p < cdOffset + cdSize; n++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const method      = buf.readUInt16LE(p + 10);
      const compSize    = buf.readUInt32LE(p + 20);
      const uncompSize  = buf.readUInt32LE(p + 24);
      const nameLen     = buf.readUInt16LE(p + 28);
      const extraLen    = buf.readUInt16LE(p + 30);
      const commentLen  = buf.readUInt16LE(p + 32);
      const localOffset = buf.readUInt32LE(p + 42);
      const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
      candidates.push({ name, method, compSize, uncompSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }

    // Prefer index.{js,mjs,cjs} at shallowest depth
    const matches = candidates
      .filter(e => /(^|\/)index\.(js|mjs|cjs)$/.test(e.name))
      .sort((a, b) => a.name.split('/').length - b.name.split('/').length);
    const target = matches[0];
    if (!target) return null;

    // Read local file header to find data start
    const lh = target.localOffset;
    if (buf.readUInt32LE(lh) !== 0x04034b50) return null;
    const lhNameLen  = buf.readUInt16LE(lh + 26);
    const lhExtraLen = buf.readUInt16LE(lh + 28);
    const dataStart  = lh + 30 + lhNameLen + lhExtraLen;
    const dataEnd    = dataStart + target.compSize;
    const compressed = buf.slice(dataStart, dataEnd);

    let raw;
    if (target.method === 0) raw = compressed;
    else if (target.method === 8) raw = zlib.inflateRawSync(compressed);
    else return null;

    return raw.toString('utf8').slice(0, 256 * 1024);
  } catch {
    return null;
  }
}

// Minimal environment for the sandbox. We deliberately do NOT forward the full
// host process.env — that would leak the operator's AWS credentials, tokens and
// other secrets into arbitrary user code. Only OS essentials (so `node` can
// start) plus standard Lambda vars and the function's own Environment.Variables.
const OS_ENV_PASSTHROUGH = ['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL'];
function lambdaEnv(fn) {
  const env = {};
  for (const k of OS_ENV_PASSTHROUGH) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, {
    AWS_REGION:                      process.env.AWS_REGION || 'us-east-1',
    AWS_DEFAULT_REGION:              process.env.AWS_DEFAULT_REGION || 'us-east-1',
    AWS_LAMBDA_FUNCTION_NAME:        fn.name,
    AWS_LAMBDA_FUNCTION_VERSION:     '$LATEST',
    AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(fn.memory || 128),
    AWS_EXECUTION_ENV:               `AWS_Lambda_${fn.runtime || 'nodejs'}`,
    _HANDLER:                        fn.handler || 'index.handler',
  }, fn.env || {});
  return env;
}

function runInNodeSandbox(fn, payload) {
  return new Promise((resolve, reject) => {
    const tmpDir = path.join(tmpdir(), `mockcloud-lambda-${randomId(8)}`);
    try {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(path.join(tmpDir, 'index.js'), fn.code);
      const runner = `
const mod = require('./index');
const handlerName = ${JSON.stringify((fn.handler || 'index.handler').split('.').pop())};
const handler = mod[handlerName] || mod.handler || mod.default;
if (typeof handler !== 'function') {
  process.stderr.write('Handler "' + handlerName + '" not found in module.exports');
  process.exit(1);
}
const event = JSON.parse(process.argv[2] || '{}');
Promise.resolve(handler(event, {})).then(r => {
  process.stdout.write(JSON.stringify(r === undefined ? null : r));
}).catch(e => {
  process.stderr.write(e && e.message ? e.message : String(e));
  process.exit(1);
});
`;
      writeFileSync(path.join(tmpDir, 'runner.js'), runner);
      const timeoutMs = Math.max(1000, (fn.timeout || 3) * 1000);
      execFile('node', ['runner.js', payload], { cwd: tmpDir, timeout: timeoutMs, env: lambdaEnv(fn) }, (err, stdout, stderr) => {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout || 'null');
      });
    } catch (e) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      reject(e);
    }
  });
}

function fnConfig(fn) {
  return {
    FunctionName: fn.name,
    FunctionArn:  arn('lambda', `function:${fn.name}`),
    Runtime:      fn.runtime,
    Handler:      fn.handler,
    Role:         fn.role || arn('iam', `role/${fn.name}-role`),
    MemorySize:   fn.memory,
    Timeout:      fn.timeout,
    PackageType:  'Zip',
    Architectures: ['x86_64'],
    Environment:  { Variables: fn.env },
    Layers:       (fn.layers || []).map(a => ({ Arn: a, CodeSize: 0 })),
    TracingConfig: { Mode: 'PassThrough' },
    EphemeralStorage: { Size: 512 },
    LoggingConfig: { LogFormat: 'Text', LogGroup: `/aws/lambda/${fn.name}` },
    State:           'Active',
    StateReasonCode: 'Idle',
    LastModified:    new Date(fn.created).toISOString(),
    CodeSize:     fn.code?.length || 0,
    Version:      '$LATEST',
    // mockcloud extras
    _invocations: fn.invocations,
    _errors:      fn.errors,
    _lastInvoked: fn.lastInvoked,
    _logs:        fn.logs,
    _created:     fn.created,
  };
}
