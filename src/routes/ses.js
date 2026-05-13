// routes/ses.js — /mockcloud/ses/* UI API
import { store } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

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
}
