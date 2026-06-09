// store.js — global in-memory state for MockCloud
//
// Single source of truth for service state, snapshot import/export,
// and per-service reset. To add a new service:
//   1. Add a factory in INITIAL_STATE
//   2. (optional) add a stat in routes/status.js
// reset/export/import will pick it up automatically.

// Per-service initial-state factories. Each must return a fresh object
// — never share references between calls (otherwise reset would mutate
// the template).
const INITIAL_STATE = {
  s3:              () => ({ buckets: {} }),
  dynamodb:        () => ({ tables: {} }),
  lambda:          () => ({ functions: {} }),
  // accessKeys maps accessKeyId → secretAccessKey for opt-in SigV4 verification
  // (MOCKCLOUD_VERIFY_SIGV4). Seeded with the dummy creds the CLI/SDKs use
  // locally; CreateAccessKey adds more. identityPolicies maps a principal
  // (username) → [policy documents] for opt-in IAM evaluation (MOCKCLOUD_IAM).
  iam:             () => ({ users: {}, roles: {}, policies: {}, accessKeys: { local: 'local', test: 'test' }, identityPolicies: {} }),
  sns:             () => ({ topics: {} }),
  sqs:             () => ({ queues: {} }),
  secretsmanager:  () => ({ secrets: {} }),
  ec2:             () => ({ instances: {}, keyPairs: {}, securityGroups: {} }),
  eventbridge:     () => ({ buses: { default: { name: 'default', rules: {} } }, events: [] }),
  dynamodbstreams: () => ({ shards: {}, triggers: {} }),
  cloudwatch:      () => ({ metrics: {}, alarms: {}, maxPoints: 1440 }),
  logs:            () => ({ groups: {} }),
  bedrock:         () => ({ defaultResponse: 'This is a canned MockCloud Bedrock response.', rules: [], invocations: [] }),
  stepfunctions:   () => ({ stateMachines: {}, executions: {} }),
  ses:             () => ({ emails: [], identities: {}, sent: 0, receiptRules: [] }),
};

const SERVICE_KEYS = Object.keys(INITIAL_STATE);

function buildInitial() {
  const s = {};
  for (const k of SERVICE_KEYS) s[k] = INITIAL_STATE[k]();
  return s;
}

export const store = {
  ...buildInitial(),
  trail: [],
  trailMax: 5000,

  // Reset a single service to its initial state, or everything if no
  // service is given. Re-applying the factory preserves all default
  // config that lives on the namespace (e.g. cloudwatch.maxPoints=1440,
  // the default eventbridge bus) instead of blindly typing each key by
  // typeof — which was the v1.2.0 bug.
  reset(service) {
    if (service) {
      if (INITIAL_STATE[service]) this[service] = INITIAL_STATE[service]();
      return;
    }
    for (const k of SERVICE_KEYS) this[k] = INITIAL_STATE[k]();
    this.trail = [];
  },

  addTrail(entry) {
    this.trail.unshift({ id: randomId(16), t: Date.now(), ...entry });
    if (this.trail.length > this.trailMax) this.trail.pop();
  },

  putMetric(namespace, metricName, value, unit = 'Count') {
    const key = `${namespace}/${metricName}`;
    if (!this.cloudwatch.metrics[key]) this.cloudwatch.metrics[key] = [];
    this.cloudwatch.metrics[key].push({ t: Date.now(), v: value, unit });
    if (this.cloudwatch.metrics[key].length > this.cloudwatch.maxPoints) this.cloudwatch.metrics[key].shift();
  },

  // Record a DynamoDB data-plane operation against a table. Maintains
  // cumulative per-table counters (for stat cards) AND pushes an
  // activity-driven point into the CloudWatch ring buffer (for the charts),
  // so the UI metrics reflect REAL traffic instead of canned arrays.
  //   kind:    'read' | 'write'
  //   units:   consumed capacity units for this op (RCU/WCU)
  //   latency: synthetic-but-plausible request latency in ms
  recordDynamoOp(tableName, kind, units = 1, latency = null) {
    const t = this.dynamodb.tables[tableName];
    if (!t) return;
    if (!t.metrics) {
      t.metrics = { reads: 0, writes: 0, consumedRead: 0, consumedWrite: 0, latencySum: 0, latencyCount: 0 };
    }
    const lat = latency == null
      ? +((kind === 'write' ? 2 : 1) + Math.random() * 3).toFixed(2)
      : latency;
    if (kind === 'read')  { t.metrics.reads++;  t.metrics.consumedRead  += units; }
    if (kind === 'write') { t.metrics.writes++; t.metrics.consumedWrite += units; }
    t.metrics.latencySum += lat;
    t.metrics.latencyCount++;

    const capName = kind === 'write' ? 'ConsumedWriteCapacityUnits' : 'ConsumedReadCapacityUnits';
    this.putMetric('MockCloud/DynamoDB', `${capName}/${tableName}`, units);
    this.putMetric('MockCloud/DynamoDB', `SuccessfulRequestLatency/${tableName}`, lat, 'Milliseconds');
  },

  // Full snapshot — every registered service plus the trail. Lambda
  // function logs are trimmed to keep snapshots small (they're noisy
  // and ephemeral).
  export() {
    const snap = { version: 1, exportedAt: Date.now() };
    for (const k of SERVICE_KEYS) snap[k] = this[k];
    snap.lambda = {
      ...this.lambda,
      functions: Object.fromEntries(
        Object.entries(this.lambda.functions).map(([n, f]) => [n, { ...f, logs: f.logs?.slice(0, 20) || [] }])
      ),
    };
    snap.trail = this.trail.slice(0, 500);
    return JSON.stringify(snap, null, 2);
  },

  // Restore from a snapshot. Unknown keys are ignored. Missing services
  // keep their current state, so older snapshots still load cleanly.
  // For services present in the snapshot, the namespace is reset to its
  // factory defaults first so leftover state from the previous session
  // (instances, queues, etc.) doesn't bleed into the imported state — the
  // shallow Object.assign in v1.2.1 left these in place.
  import(data) {
    const p = typeof data === 'string' ? JSON.parse(data) : data;
    for (const k of SERVICE_KEYS) {
      if (p[k]) {
        this[k] = INITIAL_STATE[k]();
        Object.assign(this[k], p[k]);
      }
    }
    if (Array.isArray(p.trail)) this.trail = p.trail.slice(0, this.trailMax);
  },
};

export function randomId(len = 16) {
  return Array.from({ length: len }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
}

export function arn(service, resource) {
  return `arn:aws:${service}:us-east-1:000000000000:${resource}`;
}

// Background CloudWatch collector — every 60s.
// Defensive accessors guard against snapshot imports that omit fields
// (e.g. a Lambda function without `invocations`, a bucket without `objects`).
// Without these guards a single malformed entry can crash the interval and
// silently break metrics for the rest of the session.
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const objCount = b => (b && b.objects ? Object.keys(b.objects).length : 0);
const objSizes = b => (b && b.objects ? Object.values(b.objects) : []);
const metricsTimer = setInterval(() => {
  try {
    store.putMetric('MockCloud/Lambda', 'Invocations', Object.values(store.lambda.functions).reduce((s,f)=>s+num(f.invocations),0));
    store.putMetric('MockCloud/Lambda', 'Errors', Object.values(store.lambda.functions).reduce((s,f)=>s+num(f.errors),0));
    store.putMetric('MockCloud/S3', 'NumberOfObjects', Object.values(store.s3.buckets).reduce((s,b)=>s+objCount(b),0));
    store.putMetric('MockCloud/S3', 'BucketSizeBytes', Object.values(store.s3.buckets).flatMap(objSizes).reduce((s,o)=>s+num(o?.size),0));
    store.putMetric('MockCloud/SQS', 'NumberOfMessagesSent', Object.values(store.sqs.queues).reduce((s,q)=>s+(q.messages?.length||0),0));
    store.putMetric('MockCloud/DynamoDB', 'SuccessfulRequestLatency', Math.random()*5+1);
    store.putMetric('MockCloud/EC2', 'RunningInstances', Object.values(store.ec2.instances).filter(i=>i.state==='running').length);
  } catch (e) {
    console.warn('[CloudWatch collector] tick failed:', e.message);
  }
}, 60_000);
// Don't keep the Node event loop alive solely for this interval — otherwise
// `node --test` (and any embedder) hangs after the work is done.
metricsTimer.unref?.();
