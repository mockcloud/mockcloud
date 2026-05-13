// routes/sqs.js — /mockcloud/sqs/* UI API
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';
import { enqueueMessage } from '../services/sqs.js';

const body = req => req.parsedBody || {};

export function registerSQSRoutes(app) {

  app.get('/mockcloud/sqs/queues', (req, res) => {
    jsonResponse(res, 200, {
      queues: Object.values(store.sqs.queues).map(q => ({
        name:              q.name,
        url:               q.url,
        arn:               q.arn,
        type:              q.type,
        messagesAvailable: q.messages.filter(m => m.visible).length,
        messagesInFlight:  q.messages.filter(m => !m.visible).length,
        created:           q.created,
      })),
    });
  });

  app.post('/mockcloud/sqs/queues', (req, res) => {
    const { name } = body(req);
    if (!name) return errorJson(res, 400, 'ValidationError', 'name required');
    const url = `http://localhost:4566/000000000000/${name}`;
    if (store.sqs.queues[url]) return errorJson(res, 409, 'Conflict', 'Queue already exists');
    store.sqs.queues[url] = {
      name, url,
      arn:      arn('sqs', name),
      type:     name.endsWith('.fifo') ? 'fifo' : 'standard',
      attributes: {},
      messages:   [],
      created:    Date.now(),
    };
    store.addTrail({ method: 'POST', path: `/sqs/${name}`, status: 201, latency: 2 });
    jsonResponse(res, 201, store.sqs.queues[url]);
  });

  app.delete('/mockcloud/sqs/queues/:name', (req, res) => {
    const url = `http://localhost:4566/000000000000/${req.params.name}`;
    delete store.sqs.queues[url];
    store.addTrail({ method: 'DELETE', path: `/sqs/${req.params.name}`, status: 200, latency: 1 });
    jsonResponse(res, 200, { deleted: req.params.name });
  });

  app.post('/mockcloud/sqs/queues/:name/send', (req, res) => {
    const { body: msgBody } = body(req);
    const url = `http://localhost:4566/000000000000/${req.params.name}`;
    if (!store.sqs.queues[url]) return errorJson(res, 404, 'NotFound', 'Queue not found');
    const msg = enqueueMessage(url, msgBody || '{}');
    store.addTrail({ method: 'POST', path: `/sqs/${req.params.name}/message`, status: 200, latency: 3 });
    jsonResponse(res, 200, { messageId: msg.id });
  });

  // ── Peek messages (UI inspector) ───────────────────────────────────────
  // Unlike AWS ReceiveMessage, this does NOT change visibility — it's a
  // read-only view of what's in the queue, including in-flight messages.
  app.get('/mockcloud/sqs/queues/:name/messages', (req, res) => {
    const url = `http://localhost:4566/000000000000/${req.params.name}`;
    const q = store.sqs.queues[url];
    if (!q) return errorJson(res, 404, 'NotFound', 'Queue not found');
    const limit = parseInt(req.query?.limit || '50');
    jsonResponse(res, 200, {
      queue: q.name,
      messages: q.messages.slice(0, limit).map(m => ({
        id:            m.id,
        body:          m.body,
        sent:          m.sent,
        visible:       m.visible,
        receiptHandle: m.receiptHandle,
      })),
      total: q.messages.length,
    });
  });

  // ── Receive (consume) — like AWS ReceiveMessage ────────────────────────
  // Hides messages for 30s. Use this to test consumer behaviour.
  app.post('/mockcloud/sqs/queues/:name/receive', (req, res) => {
    const url = `http://localhost:4566/000000000000/${req.params.name}`;
    const q = store.sqs.queues[url];
    if (!q) return errorJson(res, 404, 'NotFound', 'Queue not found');
    const max = parseInt((req.parsedBody?.max) || req.query?.max || '1');
    const msgs = q.messages.filter(m => m.visible).slice(0, max);
    msgs.forEach(m => {
      m.visible = false;
      setTimeout(() => { m.visible = true; }, 30000);
    });
    store.addTrail({ method: 'POST', path: `/sqs/${req.params.name}/receive`, status: 200, latency: 2 });
    jsonResponse(res, 200, {
      messages: msgs.map(m => ({ id: m.id, body: m.body, receiptHandle: m.receiptHandle, sent: m.sent })),
    });
  });

  // ── Delete message by receipt handle ────────────────────────────────────
  app.post('/mockcloud/sqs/queues/:name/delete-message', (req, res) => {
    const url = `http://localhost:4566/000000000000/${req.params.name}`;
    const q = store.sqs.queues[url];
    if (!q) return errorJson(res, 404, 'NotFound', 'Queue not found');
    const handle = req.parsedBody?.receiptHandle;
    if (!handle) return errorJson(res, 400, 'ValidationError', 'receiptHandle required');
    const before = q.messages.length;
    q.messages = q.messages.filter(m => m.receiptHandle !== handle);
    const removed = before - q.messages.length;
    store.addTrail({ method: 'POST', path: `/sqs/${req.params.name}/delete-message`, status: 200, latency: 1 });
    jsonResponse(res, 200, { removed });
  });

  // ── Purge — delete all messages, queue stays ───────────────────────────
  app.post('/mockcloud/sqs/queues/:name/purge', (req, res) => {
    const url = `http://localhost:4566/000000000000/${req.params.name}`;
    const q = store.sqs.queues[url];
    if (!q) return errorJson(res, 404, 'NotFound', 'Queue not found');
    const purged = q.messages.length;
    q.messages = [];
    store.addTrail({ method: 'POST', path: `/sqs/${req.params.name}/purge`, status: 200, latency: 2 });
    jsonResponse(res, 200, { purged });
  });
}
