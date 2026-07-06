// api.js — MockCloud internal REST API client
//
// In Vite dev the app is served by the dev server (whatever port it picks),
// which proxies /mockcloud → :4566 (see vite.config.js). Using a RELATIVE base
// there keeps every call same-origin, so it works regardless of the dev port
// and needs no CORS. In a production build the UI is served by the daemon's UI
// server on :4567 and must call the API on :4566 directly — that cross-origin
// is allowlisted in src/middleware/http.js.
const BASE = import.meta.env.DEV
  ? '/mockcloud'
  : `http://${window.location.hostname}:4566/mockcloud`;

async function req(method, path, body) {
  const opts = { method, headers: {} };
  if (body) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + path, opts);
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    const err = new Error(e.message || e.error || `HTTP ${r.status}`);
    err.status = r.status;
    err.body = e;        // expose hint, platform, etc. to callers
    throw err;
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

const get = p => req('GET', p);
const post = (p, b) => req('POST', p, b);
const del = p => req('DELETE', p);

// Binary file upload — sends raw bytes (not JSON-stringified). The browser
// fills in Content-Type from the File object's type.
async function uploadObject(bucket, key, file) {
  const url = `${BASE}/s3/buckets/${encodeURIComponent(bucket)}/objects?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    throw new Error(e.message || e.error || `HTTP ${r.status}`);
  }
  return r.json();
}

export const api = {
  status: () => get('/status'),
  trail: () => get('/trail'),
  clearTrail: () => del('/trail'),
  reset: (s) => del(s ? `/reset?service=${s}` : '/reset'),

  s3: {
    buckets: () => get('/s3/buckets'),
    create: (n, r) => post('/s3/buckets', { name: n, region: r }),
    delete: (n) => del(`/s3/buckets/${n}`),
    objects: (b) => get(`/s3/buckets/${b}/objects`),
    upload: (b, k, file) => uploadObject(b, k, file),
    download: (b, k) => `${BASE}/s3/buckets/${encodeURIComponent(b)}/object?key=${encodeURIComponent(k)}`,
    deleteObject: (b, k) => del(`/s3/buckets/${encodeURIComponent(b)}/object?key=${encodeURIComponent(k)}`),
  },
  dynamo: {
    tables: () => get('/dynamodb/tables'),
    table: (n) => get(`/dynamodb/tables/${n}`),
    create: (b) => post('/dynamodb/tables', b),
    delete: (n) => del(`/dynamodb/tables/${n}`),
    putItem: (t, i) => post(`/dynamodb/tables/${t}/items`, i),
    deleteItem: (t, pk) => del(`/dynamodb/tables/${t}/items/${encodeURIComponent(pk)}`),
    createIndex: (t, b) => post(`/dynamodb/tables/${t}/indexes`, b),
    deleteIndex: (t, ix) => del(`/dynamodb/tables/${t}/indexes/${encodeURIComponent(ix)}`),
    metrics: (t) => get(`/dynamodb/tables/${t}/metrics`),
    query: (t, b) => post(`/dynamodb/tables/${t}/query`, b),
  },
  lambda: {
    functions: () => get('/lambda/functions'),
    fn: (n) => get(`/lambda/functions/${n}`),
    create: (b) => post('/lambda/functions', b),
    delete: (n) => del(`/lambda/functions/${n}`),
    invoke: (n, p) => post(`/lambda/functions/${n}/invoke`, p),
  },
  ec2: {
    instances: () => get('/ec2/instances'),
    launch: (b) => post('/ec2/instances', b),
    action: (id, a) => post(`/ec2/instances/${id}/action`, { action: a }),
  },
  sns: {
    topics: () => get('/sns/topics'),
    create: (n) => post('/sns/topics', { name: n }),
    delete: (a) => del(`/sns/topics/${encodeURIComponent(a)}`),
    publish: (n, m) => post(`/sns/topics/${n}/publish`, { message: m }),
  },
  sqs: {
    queues: () => get('/sqs/queues'),
    create: (n) => post('/sqs/queues', { name: n }),
    delete: (n) => del(`/sqs/queues/${n}`),
    send: (n, b) => post(`/sqs/queues/${n}/send`, { body: b }),
    messages: (n, limit = 50) => get(`/sqs/queues/${n}/messages?limit=${limit}`),
    receive: (n, max = 1) => post(`/sqs/queues/${n}/receive`, { max }),
    deleteMessage: (n, handle) => post(`/sqs/queues/${n}/delete-message`, { receiptHandle: handle }),
    purge: (n) => post(`/sqs/queues/${n}/purge`, {}),
  },
  secrets: {
    list: () => get('/secrets'),
    get: (n) => get(`/secrets/${encodeURIComponent(n)}`),
    create: (b) => post('/secrets', b),
    delete: (n) => del(`/secrets/${encodeURIComponent(n)}`),
  },
  iam: {
    users: () => get('/iam/users'),
    createUser: (b) => post('/iam/users', b),
    deleteUser: (n) => del(`/iam/users/${n}`),
    roles: () => get('/iam/roles'),
    createRole: (b) => post('/iam/roles', b),
    deleteRole: (n) => del(`/iam/roles/${n}`),
  },
  eventbridge: {
    buses: () => get('/eventbridge/buses'),
    rules: (bus) => get(`/eventbridge/buses/${bus}/rules`),
    events: () => get('/eventbridge/events'),
    deleteRule: (bus, n) => del(`/eventbridge/buses/${bus}/rules/${n}`),
  },
  cloudwatch: {
    dashboard: () => get('/cloudwatch/dashboard'),
  },
  terminal: {
    create: () => post('/terminal/sessions', { type: 'cli' }),
    exec: (s, cmd) => post(`/terminal/sessions/${s}/exec`, { command: cmd }),
    interrupt: (s) => post(`/terminal/sessions/${s}/interrupt`, {}),
    close: (s) => del(`/terminal/sessions/${s}`),
    streamUrl: (s) => `${BASE}/terminal/sessions/${s}/stream`,
  },
};
