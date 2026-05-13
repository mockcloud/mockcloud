// services/apigateway.js
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson, getRawBody } from '../middleware/response.js';

export async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;
  const body = getRawBody(req);
  let payload = {};
  try { payload = JSON.parse(body); } catch {}

  // GET /restapis
  if (method === 'GET' && parts.length === 1 && parts[0] === 'restapis') {
    return jsonResponse(res, 200, { items: Object.values(store.apigateway.restApis) });
  }
  // POST /restapis
  if (method === 'POST' && parts.length === 1) {
    const id = randomId(10);
    store.apigateway.restApis[id] = { id, name: payload.name || 'api', description: payload.description || '', createdDate: Date.now()/1000 };
    return jsonResponse(res, 201, store.apigateway.restApis[id]);
  }
  // GET /restapis/:id
  if (method === 'GET' && parts.length === 2) {
    const api = store.apigateway.restApis[parts[1]];
    if (!api) return errorJson(res, 404, 'NotFoundException', 'REST API not found');
    return jsonResponse(res, 200, api);
  }
  // DELETE /restapis/:id
  if (method === 'DELETE' && parts.length === 2) {
    delete store.apigateway.restApis[parts[1]];
    res.writeHead(202); res.end(); return;
  }

  return jsonResponse(res, 200, { items: [] });
}
