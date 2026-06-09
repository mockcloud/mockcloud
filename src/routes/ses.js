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

  app.delete('/mockcloud/ses/emails', (req, res) => {
    store.ses.emails = [];
    store.ses.sent   = 0;
    jsonResponse(res, 200, { cleared: true });
  });

  app.get('/mockcloud/ses/identities', (req, res) => {
    jsonResponse(res, 200, { identities: Object.values(store.ses.identities) });
  });

  app.post('/mockcloud/ses/identities', (req, res) => {
    const { email } = body(req);
    if (!email) return errorJson(res, 400, 'ValidationError', 'email required');
    store.ses.identities[email] = { email, status: 'Success', verified: true };
    jsonResponse(res, 201, store.ses.identities[email]);
  });

  app.delete('/mockcloud/ses/identities/:email', (req, res) => {
    delete store.ses.identities[decodeURIComponent(req.params.email)];
    jsonResponse(res, 200, { deleted: req.params.email });
  });

  // ── Inbound receipt rules ────────────────────────────────────────────────
  app.get('/mockcloud/ses/receipt-rules', (req, res) => {
    jsonResponse(res, 200, { rules: store.ses.receiptRules });
  });

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

  app.delete('/mockcloud/ses/receipt-rules', (req, res) => {
    store.ses.receiptRules = [];
    jsonResponse(res, 200, { cleared: true });
  });

  // Simulate an inbound email → runs matching receipt-rule actions.
  // Body: { from, to, subject, body }
  app.post('/mockcloud/ses/inbound', async (req, res) => {
    const result = await deliverInboundEmail(body(req));
    jsonResponse(res, 200, { ...result, id: randomId(8) });
  });
}
