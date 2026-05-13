// services/ses.js — AWS SES emulator
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson, xmlResponse, escapeXml } from '../middleware/response.js';

function parseBody(req) {
  try { return JSON.parse(req.rawBody || '{}'); } catch { return {}; }
}
function parseForm(req) {
  return Object.fromEntries(new URLSearchParams(req.rawBody || '').entries());
}

const TARGET_MAP = {
  'AmazonSimpleEmailService.SendEmail':          sendEmailJson,
  'AmazonSimpleEmailService.SendRawEmail':       sendRawEmail,
  'AmazonSimpleEmailService.VerifyEmailIdentity': verifyEmail,
  'AmazonSimpleEmailService.VerifyEmailAddress':  verifyEmail,
  'AmazonSimpleEmailService.ListIdentities':      listIdentities,
  'AmazonSimpleEmailService.ListVerifiedEmailAddresses': listIdentities,
  'AmazonSimpleEmailService.DeleteIdentity':      deleteIdentity,
  'AmazonSimpleEmailService.GetSendQuota':        getSendQuota,
  'AmazonSimpleEmailService.GetSendStatistics':   getSendStats,
  'AmazonSimpleEmailService.GetIdentityVerificationAttributes': getVerificationAttrs,
};

export function handler(req, res) {
  const target = req.headers['x-amz-target'] || '';
  const fn = TARGET_MAP[target];
  if (fn) return fn(req, res);

  // Form-encoded (old SES style)
  const params = parseForm(req);
  const action = params.Action || new URLSearchParams(req.url.split('?')[1] || '').get('Action');
  if (action === 'SendEmail')           return sendEmailForm(req, res, params);
  if (action === 'VerifyEmailIdentity') return verifyEmailForm(req, res, params);
  if (action === 'ListIdentities')      return listIdentitiesForm(req, res);
  if (action === 'GetSendQuota')        return getSendQuotaForm(req, res);

  return errorJson(res, 400, 'InvalidAction', `Unknown SES action: ${target || action}`);
}

function mkEmail(from, to, subject, body, html) {
  const id = randomId(36);
  const email = {
    messageId: id,
    from,
    to:      Array.isArray(to) ? to : [to],
    subject: subject || '(no subject)',
    body:    body    || '',
    html:    html    || '',
    sent:    Date.now(),
  };
  store.ses.emails.unshift(email);
  if (store.ses.emails.length > 500) store.ses.emails.pop();
  store.ses.sent++;
  store.addTrail({ method: 'POST', path: '/ses/SendEmail', status: 200, latency: 8 });
  return id;
}

function sendEmailJson(req, res) {
  const b = parseBody(req);
  const from    = b.Source || b.FromEmailAddress || 'noreply@mockcloud.local';
  const to      = b.Destination?.ToAddresses || b.Destination?.to || [];
  const subject = b.Message?.Subject?.Data || b.Subject || '';
  const body    = b.Message?.Body?.Text?.Data || '';
  const html    = b.Message?.Body?.Html?.Data || '';
  const id      = mkEmail(from, to, subject, body, html);
  jsonResponse(res, 200, { MessageId: id });
}

function sendRawEmail(req, res) {
  const b  = parseBody(req);
  const id = mkEmail('raw@mockcloud.local', [], '(raw email)', b.RawMessage?.Data || '', '');
  jsonResponse(res, 200, { MessageId: id });
}

function verifyEmail(req, res) {
  const b     = parseBody(req);
  const email = b.EmailAddress || b.Identity;
  if (email) store.ses.identities[email] = { email, status: 'Success', verified: true };
  jsonResponse(res, 200, {});
}

function deleteIdentity(req, res) {
  const b = parseBody(req);
  delete store.ses.identities[b.Identity];
  jsonResponse(res, 200, {});
}

function listIdentities(req, res) {
  jsonResponse(res, 200, { Identities: Object.keys(store.ses.identities) });
}

function getSendQuota(req, res) {
  jsonResponse(res, 200, { Max24HourSend: 50000, MaxSendRate: 14, SentLast24Hours: store.ses.sent });
}

function getSendStats(req, res) {
  jsonResponse(res, 200, { SendDataPoints: [] });
}

function getVerificationAttrs(req, res) {
  const b = parseBody(req);
  const attrs = {};
  for (const id of (b.Identities || [])) {
    attrs[id] = { VerificationStatus: store.ses.identities[id] ? 'Success' : 'Pending' };
  }
  jsonResponse(res, 200, { VerificationAttributes: attrs });
}

// Form-encoded variants
function sendEmailForm(req, res, p) {
  const id = mkEmail(p.Source, p['Destination.ToAddresses.member.1'], p['Message.Subject.Data'], p['Message.Body.Text.Data'], p['Message.Body.Html.Data']);
  xmlResponse(res, 200, `<?xml version="1.0"?><SendEmailResponse><SendEmailResult><MessageId>${id}</MessageId></SendEmailResult></SendEmailResponse>`);
}
function verifyEmailForm(req, res, p) {
  if (p.EmailAddress) store.ses.identities[p.EmailAddress] = { email: p.EmailAddress, status: 'Success', verified: true };
  xmlResponse(res, 200, `<?xml version="1.0"?><VerifyEmailIdentityResponse><VerifyEmailIdentityResult/></VerifyEmailIdentityResponse>`);
}
function listIdentitiesForm(req, res) {
  const members = Object.keys(store.ses.identities).map((e, i) => `<member>${escapeXml(e)}</member>`).join('');
  xmlResponse(res, 200, `<?xml version="1.0"?><ListIdentitiesResponse><ListIdentitiesResult><Identities>${members}</Identities></ListIdentitiesResult></ListIdentitiesResponse>`);
}
function getSendQuotaForm(req, res) {
  xmlResponse(res, 200, `<?xml version="1.0"?><GetSendQuotaResponse><GetSendQuotaResult><Max24HourSend>50000</Max24HourSend><MaxSendRate>14</MaxSendRate><SentLast24Hours>${store.ses.sent}</SentLast24Hours></GetSendQuotaResult></GetSendQuotaResponse>`);
}
