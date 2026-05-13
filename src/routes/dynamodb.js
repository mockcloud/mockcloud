// routes/dynamodb.js — /mockcloud/dynamodb/* UI API
import { store } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

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
      items: [], created: Date.now(),
    };
    store.addTrail({ method: 'POST', path: `/dynamodb/${name}`, status: 200, latency: 3 });
    jsonResponse(res, 201, { ...store.dynamodb.tables[name], itemCount: 0, sizeBytes: 2 });
  });

  app.delete('/mockcloud/dynamodb/tables/:name', (req, res) => {
    if (!store.dynamodb.tables[req.params.name])
      return errorJson(res, 404, 'NotFound', 'Table not found');
    delete store.dynamodb.tables[req.params.name];
    store.addTrail({ method: 'DELETE', path: `/dynamodb/${req.params.name}`, status: 200, latency: 1 });
    jsonResponse(res, 200, { deleted: req.params.name });
  });

  app.post('/mockcloud/dynamodb/tables/:name/items', (req, res) => {
    const t = store.dynamodb.tables[req.params.name];
    if (!t) return errorJson(res, 404, 'NotFound', 'Table not found');
    const item = body(req);
    const idx  = t.items.findIndex(i => i[t.pk] === item[t.pk] && (!t.sk || i[t.sk] === item[t.sk]));
    if (idx >= 0) t.items[idx] = item; else t.items.push(item);
    store.addTrail({ method: 'POST', path: `/dynamodb/${req.params.name}/items`, status: 200, latency: 2 });
    jsonResponse(res, 200, item);
  });

  app.delete('/mockcloud/dynamodb/tables/:name/items/:pk', (req, res) => {
    const t = store.dynamodb.tables[req.params.name];
    if (!t) return errorJson(res, 404, 'NotFound', 'Table not found');
    const pkVal = decodeURIComponent(req.params.pk);
    t.items = t.items.filter(i => String(i[t.pk]) !== pkVal);
    store.addTrail({ method: 'DELETE', path: `/dynamodb/${req.params.name}/items/${pkVal}`, status: 200, latency: 1 });
    jsonResponse(res, 200, { deleted: pkVal });
  });
}
