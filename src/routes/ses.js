// routes/ses.js — /mockcloud/ses/* UI API
import { store, randomId } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';
import { deliverInboundEmail } from '../services/ses.js';

const body = req => req.parsedBody || {};

export function registerSESRoutes(app) {

  app.get('/mockcloud/ses/emails', (req, res) => {
    const limit = parseInt(req.query?.limit || '100');
    jsonResponse(res, 200, {
      emails: store.ses.emails.slice(0, limit),
      total:  store.ses.sent,
    });
  });

  // ── Inbound receipt rules ────────────────────────────────────────────────
  // Create a receipt rule: { name, recipients?, actions:[{type,...}], enabled? }
  app.post('/mockcloud/ses/receipt-rules', (req, res) => {
    const { name, recipients, actions, enabled } = body(req);
    if (!name) return errorJson(res, 400, 'ValidationError', 'name required');
    const rule = {
      name,
      recipients: Array.isArray(recipients) ? recipients : [],
      actions:    Array.isArray(actions) ? actions : [],
      enabled:    enabled !== false,
      created:    Date.now(),
    };
    store.ses.receiptRules = store.ses.receiptRules.filter(r => r.name !== name).concat(rule);
    jsonResponse(res, 201, rule);
  });

  // Simulate an inbound email → runs matching receipt-rule actions.
  // Body: { from, to, subject, body }
  app.post('/mockcloud/ses/inbound', async (req, res) => {
    const result = await deliverInboundEmail(body(req));
    jsonResponse(res, 200, { ...result, id: randomId(8) });
  });
}
