// routes/dynamodb.js — /mockcloud/dynamodb/* UI API
import { store } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';
import { persist } from '../services/dynamodb/persistence.js';
import { runQuery, marshal } from '../services/dynamodb.js';

const body = req => req.parsedBody || {};

export function registerDynamoRoutes(app) {

  app.get('/mockcloud/dynamodb/tables', (req, res) => {
    const tables = Object.values(store.dynamodb.tables).map(t => ({
      name:        t.name,
      pk:          t.pk,
      sk:          t.sk,
      itemCount:   t.items.length,
      billingMode: t.billingMode,
      created:     t.created,
      sizeBytes:   JSON.stringify(t.items).length,
    }));
    jsonResponse(res, 200, { tables });
  });

  app.get('/mockcloud/dynamodb/tables/:name', (req, res) => {
    const t = store.dynamodb.tables[req.params.name];
    if (!t) return errorJson(res, 404, 'NotFound', 'Table not found');
    jsonResponse(res, 200, { ...t, itemCount: t.items.length, sizeBytes: JSON.stringify(t.items).length });
  });

  app.post('/mockcloud/dynamodb/tables', (req, res) => {
    const { name, pk, sk, billingMode } = body(req);
    if (!name || !pk) return errorJson(res, 400, 'ValidationError', 'name and pk required');
    if (store.dynamodb.tables[name]) return errorJson(res, 409, 'Conflict', 'Table already exists');
    store.dynamodb.tables[name] = {
      name, pk, sk: sk || null,
      billingMode: billingMode || 'PAY_PER_REQUEST',
      items: [], indexes: [], created: Date.now(),
    };
    store.addTrail({ method: 'POST', path: `/dynamodb/${name}`, status: 200, latency: 3 });
    persist();
    jsonResponse(res, 201, { ...store.dynamodb.tables[name], itemCount: 0, sizeBytes: 2 });
  });

  app.delete('/mockcloud/dynamodb/tables/:name', (req, res) => {
    if (!store.dynamodb.tables[req.params.name])
      return errorJson(res, 404, 'NotFound', 'Table not found');
    delete store.dynamodb.tables[req.params.name];
    store.addTrail({ method: 'DELETE', path: `/dynamodb/${req.params.name}`, status: 200, latency: 1 });
    persist();
    jsonResponse(res, 200, { deleted: req.params.name });
  });

  app.post('/mockcloud/dynamodb/tables/:name/items', (req, res) => {
    const t = store.dynamodb.tables[req.params.name];
    if (!t) return errorJson(res, 404, 'NotFound', 'Table not found');
    const item = body(req);
    if (item[t.pk] === undefined || item[t.pk] === '')
      return errorJson(res, 400, 'ValidationError', `Item must include partition key "${t.pk}"`);
    if (t.sk && (item[t.sk] === undefined || item[t.sk] === ''))
      return errorJson(res, 400, 'ValidationError', `Item must include sort key "${t.sk}"`);
    const idx  = t.items.findIndex(i => i[t.pk] === item[t.pk] && (!t.sk || i[t.sk] === item[t.sk]));
    if (idx >= 0) t.items[idx] = item; else t.items.push(item);
    store.recordDynamoOp(req.params.name, 'write', 1);
    store.addTrail({ method: 'POST', path: `/dynamodb/${req.params.name}/items`, status: 200, latency: 2 });
    persist();
    jsonResponse(res, 200, item);
  });

  app.delete('/mockcloud/dynamodb/tables/:name/items/:pk', (req, res) => {
    const t = store.dynamodb.tables[req.params.name];
    if (!t) return errorJson(res, 404, 'NotFound', 'Table not found');
    const pkVal = decodeURIComponent(req.params.pk);
    const before = t.items.length;
    t.items = t.items.filter(i => String(i[t.pk]) !== pkVal);
    if (t.items.length < before) store.recordDynamoOp(req.params.name, 'write', 1);
    store.addTrail({ method: 'DELETE', path: `/dynamodb/${req.params.name}/items/${pkVal}`, status: 200, latency: 1 });
    persist();
    jsonResponse(res, 200, { deleted: pkVal });
  });

  // ── Secondary indexes ─────────────────────────────────────────────────
  app.post('/mockcloud/dynamodb/tables/:name/indexes', (req, res) => {
    const t = store.dynamodb.tables[req.params.name];
    if (!t) return errorJson(res, 404, 'NotFound', 'Table not found');
    const { name, type, pk, sk, projection, nonKeyAttributes } = body(req);
    if (!name || !pk) return errorJson(res, 400, 'ValidationError', 'index name and pk required');
    if (!t.indexes) t.indexes = [];
    if (t.indexes.some(ix => ix.name === name))
      return errorJson(res, 409, 'Conflict', `Index "${name}" already exists`);
    const proj = projection || 'ALL';
    const index = {
      name,
      type:       type === 'LSI' ? 'LSI' : 'GSI',
      pk,
      sk:         sk || null,
      projection: proj,
      // Only meaningful for INCLUDE; normalize to a clean string array.
      nonKeyAttributes: proj === 'INCLUDE' && Array.isArray(nonKeyAttributes)
        ? nonKeyAttributes.map(a => String(a).trim()).filter(Boolean)
        : [],
      created:    Date.now(),
    };
    t.indexes.push(index);
    store.addTrail({ method: 'POST', path: `/dynamodb/${req.params.name}/indexes/${name}`, status: 200, latency: 2 });
    persist();
    jsonResponse(res, 201, index);
  });

  app.delete('/mockcloud/dynamodb/tables/:name/indexes/:index', (req, res) => {
    const t = store.dynamodb.tables[req.params.name];
    if (!t) return errorJson(res, 404, 'NotFound', 'Table not found');
    const idxName = decodeURIComponent(req.params.index);
    if (!t.indexes || !t.indexes.some(ix => ix.name === idxName))
      return errorJson(res, 404, 'NotFound', 'Index not found');
    t.indexes = t.indexes.filter(ix => ix.name !== idxName);
    store.addTrail({ method: 'DELETE', path: `/dynamodb/${req.params.name}/indexes/${idxName}`, status: 200, latency: 1 });
    persist();
    jsonResponse(res, 200, { deleted: idxName });
  });

  // ── Per-table metrics (real, activity-driven) ─────────────────────────
  app.get('/mockcloud/dynamodb/tables/:name/metrics', (req, res) => {
    const t = store.dynamodb.tables[req.params.name];
    if (!t) return errorJson(res, 404, 'NotFound', 'Table not found');
    const limit = parseInt(req.query?.limit || '30', 10);
    const series = (metric) =>
      (store.cloudwatch.metrics[`MockCloud/DynamoDB/${metric}/${t.name}`] || [])
        .slice(-limit)
        .map(p => ({ t: p.t, v: p.v }));
    const m = t.metrics || { reads: 0, writes: 0, consumedRead: 0, consumedWrite: 0, latencySum: 0, latencyCount: 0 };
    jsonResponse(res, 200, {
      name:          t.name,
      itemCount:     t.items.length,
      sizeBytes:     JSON.stringify(t.items).length,
      reads:         m.reads,
      writes:        m.writes,
      consumedRead:  m.consumedRead,
      consumedWrite: m.consumedWrite,
      avgLatency:    m.latencyCount ? +(m.latencySum / m.latencyCount).toFixed(2) : 0,
      readCapacity:  series('ConsumedReadCapacityUnits'),
      writeCapacity: series('ConsumedWriteCapacityUnits'),
      latency:       series('SuccessfulRequestLatency'),
    });
  });

  // ── Query runner (UI) ─────────────────────────────────────────────────
  // Runs a real Query against the same engine the AWS API uses, but takes a
  // friendlier plain-JSON body from the console and returns plain-JSON rows.
  //   { indexName?, keyConditionExpression?, filterExpression?,
  //     projectionExpression?, expressionAttributeNames?,
  //     expressionAttributeValues? (plain JSON), limit?, scanIndexForward? }
  app.post('/mockcloud/dynamodb/tables/:name/query', (req, res) => {
    const t = store.dynamodb.tables[req.params.name];
    if (!t) return errorJson(res, 404, 'NotFound', 'Table not found');
    const b = body(req);

    // Marshal plain attribute values into DynamoDB descriptors so the shared
    // expression engine sees the same shape the SDK would send.
    const ev = {};
    for (const [k, v] of Object.entries(b.expressionAttributeValues || {})) ev[k] = marshal(v);

    const payload = {
      IndexName:                 b.indexName || undefined,
      KeyConditionExpression:    b.keyConditionExpression || undefined,
      FilterExpression:          b.filterExpression || undefined,
      ProjectionExpression:      b.projectionExpression || undefined,
      ExpressionAttributeNames:  b.expressionAttributeNames || undefined,
      ExpressionAttributeValues: Object.keys(ev).length ? ev : undefined,
      Limit:                     b.limit && b.limit > 0 ? Number(b.limit) : undefined,
      ScanIndexForward:          b.scanIndexForward === false ? false : undefined,
    };

    const r = runQuery(t, payload);
    if (r.error) return errorJson(res, 400, 'ValidationError', r.error);
    store.recordDynamoOp(req.params.name, 'read', Math.max(1, Math.ceil(r.count / 2)));
    jsonResponse(res, 200, {
      items:            r.items,
      count:            r.count,
      scannedCount:     r.scannedCount,
      lastEvaluatedKey: r.lastKey || null,
    });
  });
}
