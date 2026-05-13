// routes/secrets.js — /mockcloud/secrets/* UI API
import { store, arn } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

const body = req => req.parsedBody || {};

export function registerSecretsRoutes(app) {

  app.get('/mockcloud/secrets', (req, res) => {
    jsonResponse(res, 200, {
      secrets: Object.values(store.secretsmanager.secrets).map(s => ({
        name:     s.name,
        arn:      s.arn,
        updated:  s.updated,
        rotation: s.rotation,
        versions: s.versions,
      })),
    });
  });

  app.get('/mockcloud/secrets/:name', (req, res) => {
    const s = store.secretsmanager.secrets[decodeURIComponent(req.params.name)];
    if (!s) return errorJson(res, 404, 'NotFound', 'Secret not found');
    jsonResponse(res, 200, s);
  });

  app.post('/mockcloud/secrets', (req, res) => {
    const { name, value, rotation } = body(req);
    if (!name || !value) return errorJson(res, 400, 'ValidationError', 'name and value required');
    if (store.secretsmanager.secrets[name]) return errorJson(res, 409, 'Conflict', 'Secret already exists');
    const a = arn('secretsmanager', `secret:${name}`);
    store.secretsmanager.secrets[name] = {
      name, arn: a, value,
      created:  Date.now(),
      updated:  Date.now(),
      rotation: rotation || 'never',
      versions: [{ id: 'v-1', stage: 'AWSCURRENT', created: Date.now() }],
    };
    store.addTrail({ method: 'POST', path: `/secretsmanager/${name}`, status: 201, latency: 4 });
    jsonResponse(res, 201, store.secretsmanager.secrets[name]);
  });

  app.delete('/mockcloud/secrets/:name', (req, res) => {
    const name = decodeURIComponent(req.params.name);
    if (!store.secretsmanager.secrets[name])
      return errorJson(res, 404, 'NotFound', 'Secret not found');
    delete store.secretsmanager.secrets[name];
    store.addTrail({ method: 'DELETE', path: `/secretsmanager/${name}`, status: 200, latency: 1 });
    jsonResponse(res, 200, { deleted: name });
  });
}
