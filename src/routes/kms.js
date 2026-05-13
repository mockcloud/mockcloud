// routes/kms.js — /mockcloud/kms/* UI API
import { store, arn, randomId } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

const body = req => req.parsedBody || {};

export function registerKMSRoutes(app) {

  app.get('/mockcloud/kms/keys', (req, res) => {
    jsonResponse(res, 200, {
      keys: Object.values(store.kms.keys).map(k => ({
        id:          k.KeyId,
        arn:         k.Arn,
        description: k.Description,
        state:       k.KeyState,
        usage:       k.KeyUsage,
        spec:        k.KeySpec,
        created:     k.CreationDate,
      })),
    });
  });

  app.post('/mockcloud/kms/keys', (req, res) => {
    const { description, usage, spec } = body(req);
    const id = [randomId(8), randomId(4), randomId(4), randomId(4), randomId(12)].join('-');
    const key = {
      KeyId:        id,
      Arn:          arn('kms', `key/${id}`),
      Description:  description || '',
      KeyUsage:     usage || 'ENCRYPT_DECRYPT',
      KeySpec:      spec  || 'SYMMETRIC_DEFAULT',
      KeyState:     'Enabled',
      CreationDate: Date.now() / 1000,
      Enabled:      true,
    };
    store.kms.keys[id] = key;
    store.addTrail({ method: 'POST', path: '/kms/CreateKey', status: 200, latency: 3 });
    jsonResponse(res, 201, key);
  });

  app.delete('/mockcloud/kms/keys/:id', (req, res) => {
    const key = store.kms.keys[req.params.id];
    if (!key) return errorJson(res, 404, 'NotFound', 'Key not found');
    key.KeyState = 'PendingDeletion';
    key.DeletionDate = (Date.now() / 1000) + (7 * 86400);
    store.addTrail({ method: 'DELETE', path: `/kms/${req.params.id}`, status: 200, latency: 1 });
    jsonResponse(res, 200, { scheduled: key.DeletionDate });
  });
}
