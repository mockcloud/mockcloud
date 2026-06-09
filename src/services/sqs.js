// services/sqs.js
import { store, randomId, arn } from '../store.js';
import { xmlResponse, jsonResponse, errorXml, escapeXml, getRawBody } from '../middleware/response.js';
import crypto from 'crypto';

const ACCOUNT = '000000000000';

export async function handler(req, res) {
  const body = getRawBody(req);
  const target = req.headers['x-amz-target'] || '';

  // AWS SDK v2 uses JSON protocol with x-amz-target: AmazonSQS.ActionName
  if (target.startsWith('AmazonSQS.')) {
    const action = target.split('.')[1];
    let payload = {};
    try { payload = JSON.parse(body); } catch {}
    return handleJsonProtocol(req, res, action, payload);
  }

  const params = new URLSearchParams(body);
  const action = new URL(req.url, 'http://x').searchParams.get('Action') || params.get('Action');

  switch (action) {
    case 'CreateQueue': {
      const name = params.get('QueueName');
      const url = queueUrlFor(name);
      const a = arn('sqs', name);
      if (!store.sqs.queues[url]) {
        store.sqs.queues[url] = {
          name, url, arn: a,
          type: name.endsWith('.fifo') ? 'fifo' : 'standard',
          attributes: {}, messages: [], created: Date.now(),
        };
        store.addTrail({ method: 'POST', path: `/sqs/CreateQueue/${name}`, status: 200, latency: 2 });
      }
      return xmlResponse(res, 200, sqsWrap('CreateQueueResponse', 'CreateQueueResult', `<QueueUrl>${escapeXml(url)}</QueueUrl>`));
    }
    case 'GetQueueUrl': {
      const name = params.get('QueueName');
      const url = queueUrlFor(name);
      if (!store.sqs.queues[url]) return errorXml(res, 400, 'AWS.SimpleQueueService.NonExistentQueue', 'Queue not found');
      return xmlResponse(res, 200, sqsWrap('GetQueueUrlResponse','GetQueueUrlResult', `<QueueUrl>${escapeXml(url)}</QueueUrl>`));
    }
    case 'ListQueues': {
      const urls = Object.keys(store.sqs.queues).map(u => `<QueueUrl>${escapeXml(u)}</QueueUrl>`).join('');
      return xmlResponse(res, 200, sqsWrap('ListQueuesResponse','ListQueuesResult', urls));
    }
    case 'DeleteQueue': {
      const url = params.get('QueueUrl');
      const qName = store.sqs.queues[url]?.name || url.split('/').pop();
      delete store.sqs.queues[url];
      store.addTrail({ method: 'POST', path: `/sqs/DeleteQueue/${qName}`, status: 200, latency: 1 });
      return xmlResponse(res, 200, sqsWrap('DeleteQueueResponse','DeleteQueueResult',''));
    }
    case 'PurgeQueue': {
      const url = params.get('QueueUrl');
      const q = store.sqs.queues[url];
      if (!q) return errorXml(res, 400, 'AWS.SimpleQueueService.NonExistentQueue', 'Queue not found');
      for (const m of q.messages) cancelVisibilityTimer(m);
      q.messages = [];
      return xmlResponse(res, 200, sqsWrap('PurgeQueueResponse','PurgeQueueResult',''));
    }
    case 'SetQueueAttributes': {
      const url = params.get('QueueUrl');
      const q = store.sqs.queues[url];
      if (!q) return errorXml(res, 400, 'AWS.SimpleQueueService.NonExistentQueue', 'Queue not found');
      // form-encoded: Attribute.1.Name=...&Attribute.1.Value=...
      for (let i = 1; ; i++) {
        const n = params.get(`Attribute.${i}.Name`);
        const v = params.get(`Attribute.${i}.Value`);
        if (!n) break;
        q.attributes[n] = v;
      }
      return xmlResponse(res, 200, sqsWrap('SetQueueAttributesResponse','SetQueueAttributesResult',''));
    }
    case 'SendMessage': {
      const url = params.get('QueueUrl');
      const q = store.sqs.queues[url];
      if (!q) return errorXml(res, 400, 'AWS.SimpleQueueService.NonExistentQueue', 'Queue not found');
      if (q.type === 'fifo' && !params.get('MessageGroupId')) {
        return errorXml(res, 400, 'MissingParameter', 'The request must contain the parameter MessageGroupId.');
      }
      const msgBody = params.get('MessageBody') || '';
      const msg = enqueueMessage(url, msgBody, { dedupeId: params.get('MessageDeduplicationId'), groupId: params.get('MessageGroupId') });
      const seqXml = q.type === 'fifo' ? `<SequenceNumber>${msg.sequenceNumber}</SequenceNumber>` : '';
      return xmlResponse(res, 200, sqsWrap('SendMessageResponse','SendMessageResult',
        `<MessageId>${msg.id}</MessageId><MD5OfMessageBody>${md5(msgBody)}</MD5OfMessageBody>${seqXml}`));
    }
    case 'ReceiveMessage': {
      const url = params.get('QueueUrl');
      const q = store.sqs.queues[url];
      if (!q) return errorXml(res, 400, 'AWS.SimpleQueueService.NonExistentQueue', 'Queue not found');
      const maxMsgs = parseInt(params.get('MaxNumberOfMessages') || '1');
      const visMs = (parseInt(params.get('VisibilityTimeout') || '30')) * 1000;
      const msgs = selectMessages(q, maxMsgs);
      msgs.forEach(m => hideMessage(m, visMs));
      const xml = msgs.map(m => {
        const a = { ApproximateReceiveCount: m.approxReceiveCount || 1, SentTimestamp: m.sent,
          ...(q.type === 'fifo' ? { MessageGroupId: m.groupId, SequenceNumber: m.sequenceNumber } : {}) };
        const attrXml = Object.entries(a).map(([n, v]) => `<Attribute><Name>${n}</Name><Value>${escapeXml(String(v))}</Value></Attribute>`).join('');
        return `<Message><MessageId>${m.id}</MessageId><ReceiptHandle>${m.receiptHandle}</ReceiptHandle><Body>${escapeXml(m.body)}</Body><MD5OfBody>${md5(m.body)}</MD5OfBody>${attrXml}</Message>`;
      }).join('');
      return xmlResponse(res, 200, sqsWrap('ReceiveMessageResponse','ReceiveMessageResult', xml));
    }
    case 'DeleteMessage': {
      const url = params.get('QueueUrl');
      const q = store.sqs.queues[url];
      const handle = params.get('ReceiptHandle');
      if (q) q.messages = removeAndCancel(q.messages, m => m.receiptHandle === handle);
      return xmlResponse(res, 200, sqsWrap('DeleteMessageResponse','DeleteMessageResult',''));
    }
    case 'GetQueueAttributes': {
      const url = params.get('QueueUrl');
      const q = store.sqs.queues[url];
      if (!q) return errorXml(res, 400, 'AWS.SimpleQueueService.NonExistentQueue', 'Queue not found');
      const visible    = q.messages.filter(m => m.visible).length;
      const notVisible = q.messages.filter(m => !m.visible).length;
      const attrs = {
        QueueArn: q.arn,
        ApproximateNumberOfMessages: visible,
        ApproximateNumberOfMessagesNotVisible: notVisible,
        ApproximateNumberOfMessagesDelayed: 0,
        ...q.attributes,
      };
      const xml = Object.entries(attrs).map(([k, v]) =>
        `<Attribute><Name>${escapeXml(k)}</Name><Value>${escapeXml(String(v))}</Value></Attribute>`
      ).join('');
      return xmlResponse(res, 200, sqsWrap('GetQueueAttributesResponse','GetQueueAttributesResult', xml));
    }
    default:
      return errorXml(res, 400, 'InvalidAction', `Unknown SQS action: ${action}`);
  }
}

// ── JSON protocol handler (AWS SDK v2 / Terraform provider v5) ──────────────
function handleJsonProtocol(req, res, action, payload) {
  switch (action) {
    case 'CreateQueue': {
      const name = payload.QueueName;
      const url = queueUrlFor(name);
      const a = arn('sqs', name);
      if (!store.sqs.queues[url]) {
        store.sqs.queues[url] = {
          name, url, arn: a,
          type: name.endsWith('.fifo') ? 'fifo' : 'standard',
          attributes: payload.Attributes || {}, messages: [], created: Date.now(),
        };
        store.addTrail({ method: 'POST', path: `/sqs/CreateQueue/${name}`, status: 200, latency: 2 });
      }
      return jsonResponse(res, 200, { QueueUrl: url });
    }
    case 'GetQueueUrl': {
      const url = queueUrlFor(payload.QueueName);
      if (!store.sqs.queues[url]) return jsonResponse(res, 400, { __type: 'QueueDoesNotExist', message: 'Queue not found' });
      return jsonResponse(res, 200, { QueueUrl: url });
    }
    case 'GetQueueAttributes': {
      const url = payload.QueueUrl;
      const q = store.sqs.queues[url];
      if (!q) return jsonResponse(res, 400, { __type: 'QueueDoesNotExist', message: 'Queue not found' });
      const visible    = q.messages.filter(m => m.visible).length;
      const notVisible = q.messages.filter(m => !m.visible).length;
      const attrs = {
        QueueArn: q.arn,
        ApproximateNumberOfMessages: String(visible),
        ApproximateNumberOfMessagesNotVisible: String(notVisible),
        ApproximateNumberOfMessagesDelayed: '0',
        VisibilityTimeout: '30',
        MaximumMessageSize: '262144',
        MessageRetentionPeriod: '86400',
        ReceiveMessageWaitTimeSeconds: '0',
        SqsManagedSseEnabled: 'true',
        ...q.attributes,
      };
      return jsonResponse(res, 200, { Attributes: attrs });
    }
    case 'SetQueueAttributes': {
      const url = payload.QueueUrl;
      const q = store.sqs.queues[url];
      if (!q) return jsonResponse(res, 400, { __type: 'QueueDoesNotExist', message: 'Queue not found' });
      Object.assign(q.attributes, payload.Attributes || {});
      return jsonResponse(res, 200, {});
    }
    case 'ListQueues': {
      return jsonResponse(res, 200, { QueueUrls: Object.keys(store.sqs.queues) });
    }
    case 'DeleteQueue': {
      const qName = store.sqs.queues[payload.QueueUrl]?.name || payload.QueueUrl.split('/').pop();
      delete store.sqs.queues[payload.QueueUrl];
      store.addTrail({ method: 'POST', path: `/sqs/DeleteQueue/${qName}`, status: 200, latency: 1 });
      return jsonResponse(res, 200, {});
    }
    case 'PurgeQueue': {
      const q = store.sqs.queues[payload.QueueUrl];
      if (q) {
        for (const m of q.messages) cancelVisibilityTimer(m);
        q.messages = [];
      }
      return jsonResponse(res, 200, {});
    }
    case 'SendMessage': {
      const url = payload.QueueUrl;
      const q = store.sqs.queues[url];
      if (!q) return jsonResponse(res, 400, { __type: 'QueueDoesNotExist', message: 'Queue not found' });
      if (q.type === 'fifo' && !payload.MessageGroupId) {
        return jsonResponse(res, 400, { __type: 'MissingParameter', message: 'The request must contain the parameter MessageGroupId.' });
      }
      const msgBody = payload.MessageBody || '';
      const msg = enqueueMessage(url, msgBody, { dedupeId: payload.MessageDeduplicationId, groupId: payload.MessageGroupId });
      const out = { MessageId: msg.id, MD5OfMessageBody: md5(msgBody) };
      if (q.type === 'fifo') out.SequenceNumber = msg.sequenceNumber;
      return jsonResponse(res, 200, out);
    }
    case 'ReceiveMessage': {
      const url = payload.QueueUrl;
      const q = store.sqs.queues[url];
      if (!q) return jsonResponse(res, 400, { __type: 'QueueDoesNotExist', message: 'Queue not found' });
      const maxMsgs = payload.MaxNumberOfMessages || 1;
      const visMs = (payload.VisibilityTimeout ?? 30) * 1000;
      const msgs = selectMessages(q, maxMsgs);
      msgs.forEach(m => hideMessage(m, visMs));
      return jsonResponse(res, 200, {
        Messages: msgs.map(m => ({
          MessageId: m.id, ReceiptHandle: m.receiptHandle, Body: m.body, MD5OfBody: md5(m.body),
          Attributes: {
            ApproximateReceiveCount: String(m.approxReceiveCount || 1),
            SentTimestamp: String(m.sent),
            ...(q.type === 'fifo' ? { MessageGroupId: m.groupId, SequenceNumber: m.sequenceNumber, ...(m.dedupeId ? { MessageDeduplicationId: m.dedupeId } : {}) } : {}),
          },
        }))
      });
    }
    case 'DeleteMessage': {
      const q = store.sqs.queues[payload.QueueUrl];
      if (q) q.messages = removeAndCancel(q.messages, m => m.receiptHandle === payload.ReceiptHandle);
      return jsonResponse(res, 200, {});
    }
    default:
      return jsonResponse(res, 400, { __type: 'InvalidAction', message: `Unknown SQS action: ${action}` });
  }
}

// ── Shared helper used by other services (EventBridge, SNS subscriptions,
//    DDB Streams, UI route). Returns the inserted message object.
export function enqueueMessage(queueUrl, body, opts = {}) {
  const q = store.sqs.queues[queueUrl];
  if (!q) throw new Error(`Queue not found: ${queueUrl}`);
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const msg = {
    id:            randomId(36),
    receiptHandle: randomId(64),
    body:          bodyStr,
    sent:          Date.now(),
    visible:       true,
    dedupeId:      opts.dedupeId || null,
    approxReceiveCount: 0,
  };

  if (q.type === 'fifo') {
    // Deduplication (5-min window): explicit MessageDeduplicationId, or a
    // content hash when ContentBasedDeduplication is enabled. A duplicate is a
    // no-op that returns the original message (same id + sequence number).
    const dedupeKey = opts.dedupeId ||
      (q.attributes?.ContentBasedDeduplication === 'true' ? md5(bodyStr) : null);
    if (dedupeKey) {
      if (!q.dedupe) q.dedupe = new Map();
      const now = Date.now();
      for (const [k, v] of q.dedupe) if (now - v.t > 300_000) q.dedupe.delete(k);
      const hit = q.dedupe.get(dedupeKey);
      if (hit) return hit.msg;
      q.dedupe.set(dedupeKey, { msg, t: Date.now() });
    }
    q.seq = (q.seq || 0) + 1;
    msg.groupId        = opts.groupId || 'mockcloud-default';
    msg.sequenceNumber = String(q.seq).padStart(20, '0');
  }

  q.messages.push(msg);
  return msg;
}

// Pick the messages a ReceiveMessage returns. Standard queues: the earliest
// visible messages. FIFO: in sequence order, at most one per message group,
// skipping any group with an in-flight (not-visible) message — preserving
// per-group ordering while allowing parallelism across groups.
export function selectMessages(q, maxMsgs) {
  applyRedrive(q);
  if (q.type !== 'fifo') return q.messages.filter(m => m.visible).slice(0, maxMsgs);
  const locked = new Set(q.messages.filter(m => !m.visible).map(m => m.groupId));
  const chosen = [];
  const used = new Set();
  for (const m of q.messages) {
    if (chosen.length >= maxMsgs) break;
    if (!m.visible || locked.has(m.groupId) || used.has(m.groupId)) continue;
    chosen.push(m);
    used.add(m.groupId);
  }
  return chosen;
}

// Convenience: resolve an SQS ARN to its queue URL.
// arn:aws:sqs:us-east-1:000000000000:queue-name → http://localhost:4566/000000000000/queue-name
export function queueUrlForArn(sqsArn) {
  if (!sqsArn) return null;
  const name = sqsArn.split(':').pop();
  return queueUrlFor(name);
}

function queueUrlFor(name) {
  return `http://localhost:4566/${ACCOUNT}/${name}`;
}

// Dead-letter redrive: when a message has been received >= maxReceiveCount times
// (per the queue's RedrivePolicy) move it to the DLQ instead of re-delivering.
// Evaluated at receive time (via selectMessages).
function parseRedrive(q) {
  try {
    const p = JSON.parse(q.attributes?.RedrivePolicy || '');
    if (p && p.deadLetterTargetArn && p.maxReceiveCount) return { arn: p.deadLetterTargetArn, max: Number(p.maxReceiveCount) };
  } catch {}
  return null;
}

function applyRedrive(q) {
  const rd = parseRedrive(q);
  if (!rd) return;
  const dlqUrl = queueUrlForArn(rd.arn);
  if (!dlqUrl || !store.sqs.queues[dlqUrl]) return;
  const survivors = [];
  for (const m of q.messages) {
    if ((m.approxReceiveCount || 0) >= rd.max) {
      cancelVisibilityTimer(m);
      enqueueMessage(dlqUrl, m.body, { groupId: m.groupId });
    } else survivors.push(m);
  }
  q.messages = survivors;
}

// Hide a message and schedule its visibility to be restored after `ms`. We
// store the timer on the message so DeleteMessage / PurgeQueue can cancel it.
// Without cancellation the closure used to silently re-mark a deleted message
// as visible (harmless if the queue was deleted, but it kept node alive in
// tests and made invariants fuzzy).
export function hideMessage(m, ms) {
  m.visible = false;
  m.approxReceiveCount = (m.approxReceiveCount || 0) + 1;
  cancelVisibilityTimer(m);
  m._visTimer = setTimeout(() => {
    m.visible = true;
    m._visTimer = null;
  }, ms);
  m._visTimer.unref?.();
}

export function cancelVisibilityTimer(m) {
  if (m && m._visTimer) {
    clearTimeout(m._visTimer);
    m._visTimer = null;
  }
}

export function removeAndCancel(messages, predicate) {
  const kept = [];
  for (const m of messages) {
    if (predicate(m)) cancelVisibilityTimer(m);
    else kept.push(m);
  }
  return kept;
}

function md5(str) {
  return crypto.createHash('md5').update(String(str)).digest('hex');
}

function sqsWrap(respTag, resultTag, inner) {
  return `<?xml version="1.0"?><${respTag}><${resultTag}>${inner}</${resultTag}><ResponseMetadata><RequestId>${randomId(36)}</RequestId></ResponseMetadata></${respTag}>`;
}
