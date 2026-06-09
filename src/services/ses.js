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

// ── Inbound receipt rules (control-plane driven) ────────────────────────────
// A local mock can't receive real SMTP, so inbound mail is simulated via the
// control plane (POST /mockcloud/ses/inbound). For each enabled receipt rule
// whose recipients match, run its actions — reusing the S3 / SNS / Lambda
// delivery paths so an inbound email can land an object, fan out a
// notification, or invoke a function, exactly like real SES receipt rules.
//   rule:   { name, enabled?, recipients: [addr|domain], actions: [Action] }
//   Action: { type:'s3', bucket, objectKeyPrefix? }
//         | { type:'sns', topicArn }
//         | { type:'lambda', functionArn }
export async function deliverInboundEmail({ from, to, subject, body } = {}) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  const messageId  = randomId(36);
  const rawEmail   = `From: ${from || ''}\r\nTo: ${recipients.join(', ')}\r\nSubject: ${subject || ''}\r\n\r\n${body || ''}`;

  const matched = [];
  for (const rule of store.ses.receiptRules || []) {
    if (rule.enabled === false) continue;
    if (!recipientMatches(rule.recipients, recipients)) continue;
    matched.push(rule.name);
    for (const action of rule.actions || []) {
      try { await runReceiptAction(action, { messageId, from, recipients, subject, rawEmail }); }
      catch (e) { console.warn(`[SES] receipt action ${action?.type} failed:`, e.message); }
    }
  }
  // Record the inbound message in the same log the UI lists outbound from.
  store.ses.emails.unshift({ messageId, direction: 'inbound', from, to: recipients, subject: subject || '(no subject)', body: body || '', matchedRules: matched, sent: Date.now() });
  if (store.ses.emails.length > 500) store.ses.emails.pop();
  return { messageId, matched };
}

// Empty/absent recipient list on a rule matches everything. Otherwise match a
// full address, a domain (`example.com`), or an address ending in `@domain`.
function recipientMatches(ruleRecipients, recipients) {
  if (!ruleRecipients || ruleRecipients.length === 0) return true;
  return recipients.some(addr =>
    ruleRecipients.some(r => addr === r || addr.endsWith('@' + r) || addr.endsWith(r)));
}

async function runReceiptAction(action, ctx) {
  switch ((action.type || '').toLowerCase()) {
    case 's3': {
      const { putObjectToBucket } = await import('./s3.js');
      const key = `${action.objectKeyPrefix || ''}${ctx.messageId}`;
      putObjectToBucket(action.bucket, key, Buffer.from(ctx.rawEmail), 'message/rfc822');
      return;
    }
    case 'sns': {
      const topic = store.sns.topics[action.topicArn];
      if (!topic) return;
      const { fanoutSnsMessage } = await import('./sns.js');
      topic.published = (topic.published || 0) + 1;
      const notification = JSON.stringify({
        notificationType: 'Received',
        mail: { messageId: ctx.messageId, source: ctx.from, destination: ctx.recipients, commonHeaders: { subject: ctx.subject } },
      });
      await fanoutSnsMessage(topic, { msgId: randomId(36), message: notification, subject: 'Amazon SES Email Receipt Notification' });
      return;
    }
    case 'lambda': {
      const { invokeLambda } = await import('./lambda.js');
      const fnName = action.functionArn.split(':').pop();
      const event = { Records: [{
        eventSource: 'aws:ses', eventVersion: '1.0',
        ses: {
          mail: { messageId: ctx.messageId, source: ctx.from, destination: ctx.recipients, commonHeaders: { subject: ctx.subject, from: [ctx.from], to: ctx.recipients } },
          receipt: { recipients: ctx.recipients, action: { type: 'Lambda', functionArn: action.functionArn } },
        },
      }] };
      invokeLambda(fnName, event, { source: 'ses' }).catch(() => {});
      return;
    }
  }
}
