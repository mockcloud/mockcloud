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
  'sns', 'sqs', 'ses', 'secretsmanager', 'ec2', 'apigateway',
  'kms', 'ssm', 'events', 'cloudwatch',
  'states', 'cognito',
];

export function registerStatusRoutes(app) {

  app.get('/mockcloud/health', (req, res) => {
    jsonResponse(res, 200, {
      status: 'ok',
      version: VERSION,
      daemon: 'mockcloud',
      ec2Mode: store.ec2.mode || 'vmm',
      services: Object.fromEntries(SERVICES.map(s => [s, 'available'])),
    });
  });

  app.get('/mockcloud/status', async (req, res) => {
    const instances = Object.values(store.ec2.instances);
    const fns = Object.values(store.lambda.functions);
    const buckets = Object.values(store.s3.buckets);
    // Snapshot imports may produce buckets without `objects` — be defensive
    // so /mockcloud/status doesn't 500 the whole UI on a single bad entry.
    const objects = buckets.flatMap(b => b?.objects ? Object.values(b.objects) : []);

    // Probe Docker availability for the EC2 toggle. The helper caches
    // for 3s, so a 10s status poll triggers a real ping at most every
    // few polls — cheap enough to ride along on every status call.
    let dockerAvailable = null;
    try {
      const { pingDocker } = await import('../services/docker-health.js');
      const probe = await pingDocker();
      dockerAvailable = probe.ok;
    } catch {
      // helper missing or threw — leave as null, UI treats it as unknown
    }

    jsonResponse(res, 200, {
      healthy: true,
      uptime: process.uptime(),
      version: VERSION,
      ec2Mode: store.ec2.mode || 'vmm',
      dockerAvailable,
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
        kmsKeys: Object.keys(store.kms.keys).length,
        ssmParameters: Object.keys(store.ssm.parameters).length,
        ebRules: Object.values(store.eventbridge.buses).reduce((s, b) => s + Object.keys(b.rules).length, 0),
        cwMetrics: Object.keys(store.cloudwatch.metrics).length,
        sesEmails: store.ses.sent,
        sfnMachines: Object.keys(store.stepfunctions.stateMachines).length,
        cognitoPools: Object.keys(store.cognito.userPools).length,
        trailEvents: store.trail.length,
      },
    });
  });

  app.get('/mockcloud/trail', (req, res) => {
    const limit = parseInt(req.query?.limit || '500');
    jsonResponse(res, 200, { events: store.trail.slice(0, limit) });
  });
  app.delete('/mockcloud/trail', (req, res) => { store.trail = []; jsonResponse(res, 200, { cleared: true }); });
  app.delete('/mockcloud/reset', async (req, res) => {
    const service = req.query?.service;
    const stats = { resetService: service || 'all', dockerTerminated: 0, dockerErrors: 0 };

    // Before flushing the store, terminate any Docker containers MockCloud spawned
    // for EC2 instances — otherwise they'd be orphaned with no record in the store.
    // Skip if a non-EC2 service-specific reset was requested.
    if (!service || service === 'ec2') {
      try {
        const { dockerAction, listDockerEC2Containers } = await import('../services/docker.js');
        // First terminate anything we have a containerId for in the store
        const tracked = Object.values(store.ec2.instances).filter(i => i.containerId);
        for (const inst of tracked) {
          try { await dockerAction(inst.containerId, 'terminate'); stats.dockerTerminated++; }
          catch { stats.dockerErrors++; }
        }
        // Then sweep any leftover mockcloud-labeled containers (orphans from prior runs)
        try {
          const live = await listDockerEC2Containers();
          for (const c of live) {
            try { await dockerAction(c.id || c.Id, 'terminate'); stats.dockerTerminated++; }
            catch { stats.dockerErrors++; }
          }
        } catch { /* Docker not available — fine */ }
      } catch { /* docker.js not available — fine */ }
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

    jsonResponse(res, 200, { reset: service || 'all', ...stats });
  });

  app.get('/mockcloud/export', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="mockcloud-snapshot.json"' });
    res.end(store.export());
  });

  // EC2 mode toggle
  // EC2 mode toggle. Server-side guard: refuse to set vmm mode if Docker is
  // not reachable, even if the UI thought it was. Returns 409 + hint so
  // clients can render the same instructional popup.
  app.post('/mockcloud/ec2/mode', async (req, res) => {
    const { mode } = req.parsedBody || {};
    if (mode !== 'lite' && mode !== 'vmm') {
      return jsonResponse(res, 400, { error: 'mode must be simulated or docker (lite or vmm)' });
    }
    if (mode === 'vmm') {
      const { pingDocker, invalidateDockerCache } = await import('../services/docker-health.js');
      invalidateDockerCache();
      const probe = await pingDocker({ force: true });
      if (!probe.ok) {
        return jsonResponse(res, 409, {
          error: 'docker_unavailable',
          message: 'Docker daemon is not reachable.',
          hint: probe.hint,
          platform: probe.platform,
        });
      }
    }
    store.ec2.mode = mode;
    jsonResponse(res, 200, { ec2Mode: mode });
  });

  // Lightweight Docker availability probe for the UI.
  app.get('/mockcloud/ec2/docker-status', async (req, res) => {
    const { pingDocker } = await import('../services/docker-health.js');
    const probe = await pingDocker();
    jsonResponse(res, 200, {
      available: probe.ok,
      platform: probe.platform,
      hint: probe.hint,
    });
  });
}