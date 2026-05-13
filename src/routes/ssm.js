// routes/ssm.js — /mockcloud/ssm/* UI API
import { store } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

const body = req => req.parsedBody || {};

export function registerSSMRoutes(app) {

  app.get('/mockcloud/ssm/parameters', (req, res) => {
    const path = req.query?.path;
    const params = Object.values(store.ssm.parameters)
      .filter(p => !path || p.Name.startsWith(path))
      .map(p => ({ name: p.Name, type: p.Type, value: p.Value, version: p.Version, updated: p.LastModifiedDate }));
    jsonResponse(res, 200, { parameters: params });
  });

  app.post('/mockcloud/ssm/parameters', (req, res) => {
    const { name, value, type } = body(req);
    if (!name || !value) return errorJson(res, 400, 'ValidationError', 'name and value required');
    const existing = store.ssm.parameters[name];
    const version = (existing?.Version || 0) + 1;
    store.ssm.parameters[name] = {
      Name: name, Value: value,
      Type: type || 'String',
      Version: version,
      LastModifiedDate: Date.now() / 1000,
      ARN: `arn:aws:ssm:us-east-1:000000000000:parameter${name}`,
      DataType: 'text', Tier: 'Standard',
      history: [...(existing?.history || []), { Value: value, Version: version, LastModifiedDate: Date.now() / 1000 }],
    };
    store.addTrail({ method: 'POST', path: `/ssm${name}`, status: 200, latency: 2 });
    jsonResponse(res, 201, { name, version });
  });

  app.delete('/mockcloud/ssm/parameters/:name', (req, res) => {
    const name = decodeURIComponent(req.params.name);
    if (!store.ssm.parameters[name]) return errorJson(res, 404, 'NotFound', 'Parameter not found');
    delete store.ssm.parameters[name];
    store.addTrail({ method: 'DELETE', path: `/ssm${name}`, status: 200, latency: 1 });
    jsonResponse(res, 200, { deleted: name });
  });
}
