// services/sns.js
import { store, randomId, arn } from '../store.js';
import { xmlResponse, errorXml, escapeXml, getRawBody } from '../middleware/response.js';

const ACCOUNT = '000000000000';

export async function handler(req, res) {
  const body = getRawBody(req);
  const params = new URLSearchParams(body);
  const action = req.url.includes('?') ? new URL(req.url,'http://x').searchParams.get('Action') : params.get('Action');

  switch (action) {
    case 'CreateTopic': {
      const name = params.get('Name');
      const a = arn('sns', name);
      if (!store.sns.topics[a]) store.sns.topics[a] = { name, arn: a, created: Date.now(), published: 0, subscriptions: [], attributes: {} };
      return xmlResponse(res, 200, wrap('CreateTopicResponse','CreateTopicResult', `<TopicArn>${escapeXml(a)}</TopicArn>`));
    }
    case 'DeleteTopic': {
      const a = params.get('TopicArn');
      delete store.sns.topics[a];
      return xmlResponse(res, 200, wrap('DeleteTopicResponse','DeleteTopicResult',''));
    }
    case 'ListTopics': {
      const topics = Object.values(store.sns.topics).map(t => `<member><TopicArn>${escapeXml(t.arn)}</TopicArn></member>`).join('');
      return xmlResponse(res, 200, wrap('ListTopicsResponse','ListTopicsResult', `<Topics>${topics}</Topics>`));
    }
    case 'GetTopicAttributes': {
      const topic = store.sns.topics[params.get('TopicArn')];
      if (!topic) return errorXml(res, 404, 'NotFound', 'Topic not found');
      const attrs = {
        TopicArn: topic.arn,
        Owner: ACCOUNT,
        SubscriptionsConfirmed: String(topic.subscriptions.length),
        SubscriptionsPending: '0',
        SubscriptionsDeleted: '0',
        DisplayName: topic.name,
        ...topic.attributes,
      };
      return xmlResponse(res, 200, wrap('GetTopicAttributesResponse','GetTopicAttributesResult', `<Attributes>${attrEntriesXml(attrs)}</Attributes>`));
    }
    case 'SetTopicAttributes': {
      const topic = store.sns.topics[params.get('TopicArn')];
      if (!topic) return errorXml(res, 404, 'NotFound', 'Topic not found');
      const name = params.get('AttributeName');
      if (name) { (topic.attributes ??= {})[name] = params.get('AttributeValue') ?? ''; }
      return xmlResponse(res, 200, wrap('SetTopicAttributesResponse','SetTopicAttributesResult',''));
    }
    case 'Subscribe': {
      const topicArn = params.get('TopicArn');
      const protocol = params.get('Protocol');
      const endpoint = params.get('Endpoint');
      const topic = store.sns.topics[topicArn];
      if (!topic) return errorXml(res, 404, 'NotFound', 'Topic not found');
      const subArn = `${topicArn}:${randomId(8)}`;
      const sub = { subArn, topicArn, protocol, endpoint, status: 'confirmed', owner: ACCOUNT };
      applySubscriptionAttributes(sub, parseStringMap(params, 'Attributes'));
      topic.subscriptions.push(sub);
      return xmlResponse(res, 200, wrap('SubscribeResponse','SubscribeResult', `<SubscriptionArn>${escapeXml(subArn)}</SubscriptionArn>`));
    }
    case 'SetSubscriptionAttributes': {
      const subArn = params.get('SubscriptionArn');
      const sub = findSubscription(subArn);
      if (!sub) return errorXml(res, 404, 'NotFound', 'Subscription not found');
      const name = params.get('AttributeName');
      if (name) applySubscriptionAttributes(sub, { [name]: params.get('AttributeValue') ?? '' });
      return xmlResponse(res, 200, wrap('SetSubscriptionAttributesResponse','SetSubscriptionAttributesResult',''));
    }
    case 'GetSubscriptionAttributes': {
      const sub = findSubscription(params.get('SubscriptionArn'));
      if (!sub) return errorXml(res, 404, 'NotFound', 'Subscription not found');
      const attrs = {
        SubscriptionArn: sub.subArn,
        TopicArn: sub.topicArn,
        Protocol: sub.protocol,
        Endpoint: sub.endpoint,
        Owner: sub.owner || ACCOUNT,
        ConfirmationWasAuthenticated: 'true',
        PendingConfirmation: 'false',
        RawMessageDelivery: sub.rawMessageDelivery ? 'true' : 'false',
        ...(sub.filterPolicy ? { FilterPolicy: sub.filterPolicy, FilterPolicyScope: sub.filterPolicyScope || 'MessageAttributes' } : {}),
      };
      return xmlResponse(res, 200, wrap('GetSubscriptionAttributesResponse','GetSubscriptionAttributesResult', `<Attributes>${attrEntriesXml(attrs)}</Attributes>`));
    }
    case 'Publish': {
      const topicArn = params.get('TopicArn');
      const topic = store.sns.topics[topicArn];
      if (!topic) return errorXml(res, 404, 'NotFound', 'Topic not found');
      const message = params.get('Message') || '';
      const subject = params.get('Subject') || '';
      const attributes = parseMessageAttributes(params, 'MessageAttributes');
      topic.published++;
      const msgId = randomId(36);
      // Fan out to subscribers — async, not awaited (matches AWS semantics:
      // Publish returns success once the message is durably accepted, not
      // once delivered).
      fanoutSnsMessage(topic, { msgId, message, subject, attributes }).catch(e => {
        console.warn(`[SNS] Fanout error for ${topicArn}:`, e.message);
      });
      return xmlResponse(res, 200, wrap('PublishResponse','PublishResult', `<MessageId>${msgId}</MessageId>`));
    }
    case 'PublishBatch': {
      const topicArn = params.get('TopicArn');
      const topic = store.sns.topics[topicArn];
      if (!topic) return errorXml(res, 404, 'NotFound', 'Topic not found');
      const entries = parsePublishBatchEntries(params);
      const successful = [];
      for (const e of entries) {
        topic.published++;
        const msgId = randomId(36);
        fanoutSnsMessage(topic, { msgId, message: e.Message, subject: e.Subject, attributes: e.MessageAttributes })
          .catch(err => console.warn(`[SNS] Fanout error for ${topicArn}:`, err.message));
        successful.push({ Id: e.Id, MessageId: msgId });
      }
      const successXml = successful.map(s => `<member><Id>${escapeXml(s.Id)}</Id><MessageId>${s.MessageId}</MessageId></member>`).join('');
      return xmlResponse(res, 200, wrap('PublishBatchResponse','PublishBatchResult',
        `<Successful>${successXml}</Successful><Failed/>`));
    }
    case 'Unsubscribe': {
      const subArn = params.get('SubscriptionArn');
      // SubscriptionArn format we generate: `${topicArn}:${randomId(8)}`
      // — find the parent topic and remove the matching subscription.
      for (const topic of Object.values(store.sns.topics)) {
        topic.subscriptions = (topic.subscriptions || []).filter(s => s.subArn !== subArn);
      }
      return xmlResponse(res, 200, wrap('UnsubscribeResponse','UnsubscribeResult',''));
    }
    case 'ListSubscriptions': {
      const all = Object.values(store.sns.topics).flatMap(t => t.subscriptions.map(s => ({...s, topicArn: t.arn})));
      return xmlResponse(res, 200, wrap('ListSubscriptionsResponse','ListSubscriptionsResult',
        `<Subscriptions>${all.map(subMemberXml).join('')}</Subscriptions>`));
    }
    case 'ListSubscriptionsByTopic': {
      const topic = store.sns.topics[params.get('TopicArn')];
      if (!topic) return errorXml(res, 404, 'NotFound', 'Topic not found');
      const subs = topic.subscriptions.map(s => ({ ...s, topicArn: topic.arn }));
      return xmlResponse(res, 200, wrap('ListSubscriptionsByTopicResponse','ListSubscriptionsByTopicResult',
        `<Subscriptions>${subs.map(subMemberXml).join('')}</Subscriptions>`));
    }
    default:
      return errorXml(res, 400, 'InvalidAction', `Unknown action: ${action}`);
  }
}

// Fan out a published message to all topic subscribers. Each subscription
// is delivered independently — failure of one doesn't block others.
// Exported so EventBridge SNS targets + S3 notifications can re-trigger fanout.
//   attributes: internal message-attribute map { name: { DataType, StringValue|BinaryValue } }
export async function fanoutSnsMessage(topic, { msgId, message, subject, attributes }) {
  const subs = topic.subscriptions || [];
  const snsEnvelope = {
    Type:      'Notification',
    MessageId: msgId,
    TopicArn:  topic.arn,
    Subject:   subject,
    Message:   message,
    Timestamp: new Date().toISOString(),
    ...(hasAttributes(attributes) ? { MessageAttributes: toEnvelopeAttributes(attributes) } : {}),
  };

  // Lazy imports to avoid circular deps at module load
  const [{ invokeLambda }, { enqueueMessage, queueUrlForArn }] = await Promise.all([
    import('./lambda.js'),
    import('./sqs.js'),
  ]);

  for (const sub of subs) {
    try {
      // Subscription filter policy — skip subscribers whose policy doesn't match.
      if (!subscriptionMatches(sub, attributes, message)) continue;

      // SQS subscription — endpoint is the queue ARN
      if (sub.protocol === 'sqs' || sub.endpoint?.includes(':sqs:')) {
        const url = queueUrlForArn(sub.endpoint);
        if (url && store.sqs.queues[url]) {
          // Raw message delivery: enqueue the bare Message (carrying the
          // original attributes) instead of the JSON SNS envelope.
          if (sub.rawMessageDelivery) enqueueMessage(url, message, { attributes });
          else enqueueMessage(url, JSON.stringify(snsEnvelope));
        }
        continue;
      }
      // Lambda subscription — endpoint is the function ARN
      if (sub.protocol === 'lambda' || sub.endpoint?.includes(':lambda:') || sub.endpoint?.includes(':function:')) {
        const fnName = sub.endpoint.split(':').pop();
        // SNS event format: { Records: [{ EventSource: 'aws:sns', Sns: {...} }] }
        const event = { Records: [{ EventSource: 'aws:sns', EventVersion: '1.0', EventSubscriptionArn: sub.subArn, Sns: snsEnvelope }] };
        invokeLambda(fnName, event, { source: 'sns' }).catch(()=>{});
        continue;
      }
      // HTTP/HTTPS/email/SMS — not delivered, but counted as accepted
      // (kept here as a no-op so we don't fail the publish call).
    } catch (e) {
      console.warn(`[SNS] Subscriber delivery failed (${sub.subArn}):`, e.message);
    }
  }
}

// ── Subscription attributes ────────────────────────────────────────────────
function applySubscriptionAttributes(sub, attrs) {
  if (!attrs) return;
  if ('FilterPolicy' in attrs)      sub.filterPolicy = attrs.FilterPolicy || null;
  if ('FilterPolicyScope' in attrs) sub.filterPolicyScope = attrs.FilterPolicyScope || 'MessageAttributes';
  if ('RawMessageDelivery' in attrs) sub.rawMessageDelivery = attrs.RawMessageDelivery === 'true';
}

function findSubscription(subArn) {
  for (const topic of Object.values(store.sns.topics)) {
    const sub = (topic.subscriptions || []).find(s => s.subArn === subArn);
    if (sub) return sub;
  }
  return null;
}

function subMemberXml(s) {
  return `<member><SubscriptionArn>${escapeXml(s.subArn)}</SubscriptionArn><Owner>${s.owner || ACCOUNT}</Owner><Protocol>${escapeXml(s.protocol || '')}</Protocol><Endpoint>${escapeXml(s.endpoint || '')}</Endpoint><TopicArn>${escapeXml(s.topicArn)}</TopicArn></member>`;
}

// ── Filter policy evaluation (subset: exact, anything-but, prefix, numeric,
//    exists) over message attributes (default) or the message body (scope=
//    MessageBody). Returns true when the subscription has no policy. ─────────
function subscriptionMatches(sub, attributes, message) {
  if (!sub.filterPolicy) return true;
  let policy;
  try { policy = JSON.parse(sub.filterPolicy); } catch { return true; }
  if ((sub.filterPolicyScope || 'MessageAttributes') === 'MessageBody') {
    let bodyObj;
    try { bodyObj = JSON.parse(message); } catch { return false; }
    return matchPolicyObject(policy, bodyObj);
  }
  // MessageAttributes scope: look up each key in the attribute map.
  return matchPolicyObject(policy, attributesToPlain(attributes || {}));
}

// Convert internal attribute map to a plain { name: value } object for matching.
function attributesToPlain(attrs) {
  const out = {};
  for (const [name, a] of Object.entries(attrs)) out[name] = attrValueForMatch(a);
  return out;
}

function attrValueForMatch(a) {
  if (!a) return undefined;
  const dt = a.DataType || a.Type || 'String';
  const raw = a.StringValue ?? a.Value ?? a.BinaryValue;
  if (dt.startsWith('Number')) return Number(raw);
  if (dt === 'String.Array') { try { return JSON.parse(raw); } catch { return raw; } }
  return raw;
}

function matchPolicyObject(policy, obj) {
  for (const [key, spec] of Object.entries(policy)) {
    const present = obj != null && Object.prototype.hasOwnProperty.call(obj, key);
    const value = present ? obj[key] : undefined;
    if (Array.isArray(spec)) {
      if (!matchKey(spec, present, value)) return false;
    } else if (spec && typeof spec === 'object') {
      // Nested object → recurse (MessageBody scope only).
      if (!matchPolicyObject(spec, present ? value : undefined)) return false;
    }
  }
  return true;
}

function matchKey(conditions, present, value) {
  const values = Array.isArray(value) ? value : [value];
  return conditions.some(cond => {
    if (cond && typeof cond === 'object' && 'exists' in cond) return cond.exists ? present : !present;
    if (!present) return false;
    return values.some(v => matchCondition(cond, v));
  });
}

function matchCondition(cond, val) {
  if (typeof cond === 'string') return val === cond;
  if (typeof cond === 'number') return Number(val) === cond;
  if (typeof cond === 'boolean') return val === cond;
  if (cond && typeof cond === 'object') {
    if ('anything-but' in cond) {
      const set = Array.isArray(cond['anything-but']) ? cond['anything-but'] : [cond['anything-but']];
      return !set.includes(val);
    }
    if ('prefix' in cond) return typeof val === 'string' && val.startsWith(cond.prefix);
    if ('numeric' in cond) return matchNumeric(cond.numeric, val);
  }
  return false;
}

function matchNumeric(spec, val) {
  const n = Number(val);
  if (Number.isNaN(n)) return false;
  for (let i = 0; i < spec.length; i += 2) {
    const op = spec[i], operand = Number(spec[i + 1]);
    if (op === '=' && !(n === operand)) return false;
    if (op === '<' && !(n < operand)) return false;
    if (op === '<=' && !(n <= operand)) return false;
    if (op === '>' && !(n > operand)) return false;
    if (op === '>=' && !(n >= operand)) return false;
  }
  return true;
}

// ── Form parsers (AWS query protocol flattening) ────────────────────────────
// MessageAttributes.entry.N.Name / .Value.DataType / .Value.StringValue|BinaryValue
function parseMessageAttributes(params, prefix) {
  const out = {};
  for (let i = 1; ; i++) {
    const name = params.get(`${prefix}.entry.${i}.Name`);
    if (name == null) break;
    const dataType = params.get(`${prefix}.entry.${i}.Value.DataType`) || 'String';
    const binary = params.get(`${prefix}.entry.${i}.Value.BinaryValue`);
    out[name] = { DataType: dataType };
    if (binary != null) out[name].BinaryValue = binary;
    else out[name].StringValue = params.get(`${prefix}.entry.${i}.Value.StringValue`) ?? '';
  }
  return Object.keys(out).length ? out : null;
}

// String→String maps: Prefix.entry.N.key / .value
function parseStringMap(params, prefix) {
  const out = {};
  for (let i = 1; ; i++) {
    const k = params.get(`${prefix}.entry.${i}.key`);
    if (k == null) break;
    out[k] = params.get(`${prefix}.entry.${i}.value`) ?? '';
  }
  return Object.keys(out).length ? out : null;
}

// PublishBatchRequestEntries.member.N.{Id,Message,Subject,MessageAttributes...}
function parsePublishBatchEntries(params) {
  const entries = [];
  for (let i = 1; ; i++) {
    const base = `PublishBatchRequestEntries.member.${i}`;
    const id = params.get(`${base}.Id`);
    if (id == null) break;
    entries.push({
      Id: id,
      Message: params.get(`${base}.Message`) || '',
      Subject: params.get(`${base}.Subject`) || '',
      MessageAttributes: parseMessageAttributes(params, `${base}.MessageAttributes`),
    });
  }
  return entries;
}

// ── Misc helpers ────────────────────────────────────────────────────────────
function hasAttributes(attrs) {
  return attrs && typeof attrs === 'object' && Object.keys(attrs).length > 0;
}

// Internal attribute map → SNS envelope form { name: { Type, Value } }
function toEnvelopeAttributes(attrs) {
  const out = {};
  for (const [name, a] of Object.entries(attrs)) {
    out[name] = { Type: a.DataType || 'String', Value: a.BinaryValue ?? a.StringValue ?? '' };
  }
  return out;
}

function attrEntriesXml(map) {
  return Object.entries(map)
    .map(([k, v]) => `<entry><key>${escapeXml(k)}</key><value>${escapeXml(String(v))}</value></entry>`)
    .join('');
}

function wrap(respTag, resultTag, inner) {
  return `<?xml version="1.0"?><${respTag} xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><${resultTag}>${inner}</${resultTag}><ResponseMetadata><RequestId>${randomId(36)}</RequestId></ResponseMetadata></${respTag}>`;
}
