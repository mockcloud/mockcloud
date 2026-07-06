// routes/status.js — health, status, trail, reset, export, import
import { store } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';
import { VERSION } from '../version.js';
import { wipeDisk } from '../services/dynamodb/persistence.js';
import { cancelVisibilityTimer } from '../services/sqs.js';
import { rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

const S3_ROOT = process.env.MOCKCLOUD_S3_ROOT || path.join(os.homedir(), '.mockcloud', 's3');

const SERVICES = [
  's3', 'dynamodb', 'dynamodbstreams', 'lambda', 'iam', 'sts',
  'sns', 'sqs', 'secretsmanager', 'ec2',
  'events', 'cloudwatch',
];

export function registerStatusRoutes(app) {

  app.get('/mockcloud/health', (req, res) => {
    jsonResponse(res, 200, {
      status: 'ok',
      version: VERSION,
      daemon: 'mockcloud',
      services: Object.fromEntries(SERVICES.map(s => [s, 'available'])),
    });
  });

  app.get('/mockcloud/status', (req, res) => {
    const instances = Object.values(store.ec2.instances);
    const fns = Object.values(store.lambda.functions);
    const buckets = Object.values(store.s3.buckets);
    // Snapshot imports may produce buckets without `objects` — be defensive
    // so /mockcloud/status doesn't 500 the whole UI on a single bad entry.
    const objects = buckets.flatMap(b => b?.objects ? Object.values(b.objects) : []);

    jsonResponse(res, 200, {
      healthy: true,
      uptime: process.uptime(),
      version: VERSION,
      services: Object.fromEntries(SERVICES.map(s => [s, 'available'])),
      stats: {
        ec2Running: instances.filter(i => i.state === 'running').length,
        ec2Total: instances.length,
        lambdaFunctions: fns.length,
        lambdaInvocations: fns.reduce((s, f) => s + (Number.isFinite(f.invocations) ? f.invocations : 0), 0),
        s3Buckets: buckets.length,
        s3Objects: objects.length,
        s3Bytes: objects.reduce((s, o) => s + (Number.isFinite(o?.size) ? o.size : 0), 0),
        dynamoTables: Object.keys(store.dynamodb.tables).length,
        snsTopics: Object.keys(store.sns.topics).length,
        sqsQueues: Object.keys(store.sqs.queues).length,
        secrets: Object.keys(store.secretsmanager.secrets).length,
        ebRules: Object.values(store.eventbridge.buses).reduce((s, b) => s + Object.keys(b.rules).length, 0),
        cwMetrics: Object.keys(store.cloudwatch.metrics).length,
        trailEvents: store.trail.length,
      },
    });
  });

  app.get('/mockcloud/trail', (req, res) => {
    const limit = parseInt(req.query?.limit || '500');
    jsonResponse(res, 200, { events: store.trail.slice(0, limit) });
  });
  app.delete('/mockcloud/trail', (req, res) => { store.trail = []; jsonResponse(res, 200, { cleared: true }); });
  app.delete('/mockcloud/reset', (req, res) => {
    const service = req.query?.service;
    const stats = { resetService: service || 'all' };

    // Cancel in-flight SQS visibility timers before the queues are dropped —
    // otherwise the orphaned callbacks fire later against detached messages.
    // Defensive accessors: reset is the recovery endpoint, so it must not
    // depend on store invariants holding (e.g. after a bad snapshot import).
    if (!service || service === 'sqs') {
      for (const q of Object.values(store.sqs.queues || {})) {
        for (const m of q?.messages || []) cancelVisibilityTimer(m);
      }
    }

    store.reset(service);

    // Wipe S3 disk so buckets don't resurrect on next restart
    if (!service || service === 's3') {
      try {
        if (existsSync(S3_ROOT)) rmSync(S3_ROOT, { recursive: true, force: true });
      } catch (e) {
        stats.s3DiskError = e.message;
      }
    }

    // Wipe the DynamoDB snapshot so reset tables don't resurrect on next restart
    if (!service || service === 'dynamodb') {
      try {
        wipeDisk();
      } catch (e) {
        stats.dynamodbDiskError = e.message;
      }
    }

    jsonResponse(res, 200, { reset: service || 'all', ...stats });
  });

  app.get('/mockcloud/export', (req, res) => {
    // Build the snapshot BEFORE writeHead: once the 200 header is out, a
    // throw from export() can't be turned into an error response any more
    // (the router's catch sees headersSent and bails), so the client would
    // hang on a half-finished download instead of getting a clean 500.
    let snapshot;
    try {
      snapshot = store.export();
    } catch (e) {
      console.error('[MockCloud] export failed:', e);
      return errorJson(res, 500, 'ExportError', e.message);
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="mockcloud-snapshot.json"' });
    res.end(snapshot);
  });

  // Restore a snapshot produced by GET /mockcloud/export. parseBodyForJson
  // yields {} for missing/invalid JSON, which would make import a silent
  // no-op — reject those explicitly instead.
  app.post('/mockcloud/import', (req, res) => {
    const snap = req.parsedBody;
    if (!snap || typeof snap !== 'object' || Array.isArray(snap) || Object.keys(snap).length === 0) {
      return errorJson(res, 400, 'ValidationError', 'body must be a JSON snapshot as produced by GET /mockcloud/export');
    }
    try {
      // The snapshot replaces the SQS namespace wholesale — cancel the current
      // queues' in-flight visibility timers first or their callbacks would
      // fire later against detached messages (same sweep reset does above).
      if (snap.sqs) {
        for (const q of Object.values(store.sqs.queues || {})) {
          for (const m of q?.messages || []) cancelVisibilityTimer(m);
        }
      }
      store.import(snap);
    } catch (e) {
      return errorJson(res, 400, 'ValidationError', `invalid snapshot: ${e.message}`);
    }
    jsonResponse(res, 200, { imported: true });
  });
}
