// routes/_test.js — test-only control-plane endpoints.
//
// Registered ONLY when MOCKCLOUD_TEST_ENDPOINTS=1 (set by the test harness,
// never in production). These exist so the vitest suite can run fully
// black-box against an external server process: each endpoint replaces a
// direct src/ import a test file used to make. Any replacement server
// implementation must provide the same six endpoints under the same flag.
import { store } from '../store.js';
import { jsonResponse, errorJson, sendInternalError } from '../middleware/response.js';
import { persistNow, hydrateFromDisk } from '../services/dynamodb/persistence.js';
import { fireDueSchedulesOnce } from '../services/eventbridge.js';
import { invokeLambda } from '../services/lambda.js';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

const DDB_ROOT = process.env.MOCKCLOUD_DYNAMODB_ROOT || path.join(os.homedir(), '.mockcloud', 'dynamodb');

export function registerTestRoutes(app) {

  // Replaces: fireDueSchedulesOnce(Date.now() + advanceMs). The offset is
  // relative so the test and server clocks never need to agree.
  app.post('/mockcloud/_test/eventbridge/fire-schedules', async (req, res) => {
    const advanceMs = Number(req.parsedBody?.advanceMs) || 0;
    await fireDueSchedulesOnce(Date.now() + advanceMs);
    jsonResponse(res, 200, { ok: true });
  });

  // Replaces: persistNow()
  app.post('/mockcloud/_test/dynamodb/persist', (req, res) => {
    persistNow();
    jsonResponse(res, 200, { persisted: true });
  });

  // Replaces: existsSync(<DDB_ROOT>/tables.json)
  app.get('/mockcloud/_test/dynamodb/snapshot', (req, res) => {
    jsonResponse(res, 200, { exists: existsSync(path.join(DDB_ROOT, 'tables.json')) });
  });

  // Replaces: store.reset(); hydrateFromDisk(true) — simulates a server
  // restart: drop the in-memory DynamoDB namespace (disk snapshot untouched),
  // then force-rehydrate from disk.
  app.post('/mockcloud/_test/dynamodb/reload', (req, res) => {
    store.reset('dynamodb');
    hydrateFromDisk(true);
    jsonResponse(res, 200, { tables: Object.keys(store.dynamodb.tables) });
  });

  // Replaces: direct invokeLambda(name, payload, { source }) — the internal
  // (non-API) invocation path, used to drive the re-entrancy guard.
  app.post('/mockcloud/_test/lambda/internal-invoke', async (req, res) => {
    const { functionName, payload, source } = req.parsedBody || {};
    if (!functionName) return errorJson(res, 400, 'ValidationError', 'functionName is required');
    const result = await invokeLambda(functionName, payload ?? {}, { source: source || 'test' });
    jsonResponse(res, 200, result);
  });

  // Replaces: unit-testing sendInternalError with mock req/res. Exercises the
  // production error boundary black-box: JSON __type shape when the request
  // looks like a JSON-protocol call, S3 <Error> XML otherwise.
  app.get('/mockcloud/_test/boom', (req, res) => {
    sendInternalError(req, res, new Error('boom (MOCKCLOUD_TEST_ENDPOINTS)'));
  });
}
