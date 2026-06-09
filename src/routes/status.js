// routes/status.js — health, status, trail, reset, export
import { store } from '../store.js';
import { jsonResponse } from '../middleware/response.js';
import { VERSION } from '../version.js';
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

    store.reset(service);

    // Wipe S3 disk so buckets don't resurrect on next restart
    if (!service || service === 's3') {
      try {
        if (existsSync(S3_ROOT)) rmSync(S3_ROOT, { recursive: true, force: true });
      } catch (e) {
        stats.s3DiskError = e.message;
      }
    }

    jsonResponse(res, 200, { reset: service || 'all', ...stats });
  });

  app.get('/mockcloud/export', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="mockcloud-snapshot.json"' });
    res.end(store.export());
  });
}
