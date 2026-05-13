// routes/sns.js — /mockcloud/sns/* UI API
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

const body = req => req.parsedBody || {};

export function registerSNSRoutes(app) {

  app.get('/mockcloud/sns/topics', (req, res) => {
    jsonResponse(res, 200, { topics: Object.values(store.sns.topics) });
  });

  app.post('/mockcloud/sns/topics', (req, res) => {
    const { name } = body(req);
    if (!name) return errorJson(res, 400, 'ValidationError', 'name required');
    const a = arn('sns', name);
    if (store.sns.topics[a]) return errorJson(res, 409, 'Conflict', 'Topic already exists');
    store.sns.topics[a] = { name, arn: a, created: Date.now(), published: 0, subscriptions: [] };
    store.addTrail({ method: 'POST', path: `/sns/${name}`, status: 201, latency: 2 });
    jsonResponse(res, 201, store.sns.topics[a]);
  });

  app.delete('/mockcloud/sns/topics/:arn', (req, res) => {
    const topicArn = decodeURIComponent(req.params.arn);
    delete store.sns.topics[topicArn];
    store.addTrail({ method: 'DELETE', path: '/sns/topic', status: 200, latency: 1 });
    jsonResponse(res, 200, { deleted: topicArn });
  });

  app.post('/mockcloud/sns/topics/:name/publish', (req, res) => {
    const { message } = body(req);
    const topic = Object.values(store.sns.topics).find(t => t.name === req.params.name);
    if (!topic) return errorJson(res, 404, 'NotFound', 'Topic not found');
    topic.published++;
    store.addTrail({ method: 'POST', path: `/sns/${req.params.name}/publish`, status: 200, latency: 4 });
    jsonResponse(res, 200, { messageId: randomId(36), topic: topic.name });
  });
}
