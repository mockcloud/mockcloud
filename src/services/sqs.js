// services/sqs.js
import { store, randomId, arn } from '../store.js';
import { xmlResponse, errorXml, escapeXml, getRawBody } from '../middleware/response.js';
import crypto from 'crypto';

const ACCOUNT = '000000000000';

export async function handler(req, res) {
  const body = getRawBody(req);
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
      delete store.sqs.queues[url];
      return xmlResponse(res, 200, sqsWrap('DeleteQueueResponse','DeleteQueueResult',''));
    }
    case 'PurgeQueue': {
      const url = params.get('QueueUrl');
      const q = store.sqs.queues[url];
      if (!q) return errorXml(res, 400, 'AWS.SimpleQueueService.NonExistentQueue', 'Queue not found');
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
      const msgBody = params.get('MessageBody') || '';
      const msg = enqueueMessage(url, msgBody, { dedupeId: params.get('MessageDeduplicationId') });
      return xmlResponse(res, 200, sqsWrap('SendMessageResponse','SendMessageResult',
        `<MessageId>${msg.id}</MessageId><MD5OfMessageBody>${md5(msgBody)}</MD5OfMessageBody>`));
    }
    case 'ReceiveMessage': {
      const url = params.get('QueueUrl');
      const q = store.sqs.queues[url];
      if (!q) return errorXml(res, 400, 'AWS.SimpleQueueService.NonExistentQueue', 'Queue not found');
      const maxMsgs = parseInt(params.get('MaxNumberOfMessages') || '1');
      const msgs = q.messages.filter(m => m.visible).slice(0, maxMsgs);
      msgs.forEach(m => {
        m.visible = false;
        setTimeout(() => { m.visible = true; }, 30000);
      });
      const xml = msgs.map(m =>
        `<Message><MessageId>${m.id}</MessageId><ReceiptHandle>${m.receiptHandle}</ReceiptHandle><Body>${escapeXml(m.body)}</Body><MD5OfBody>${md5(m.body)}</MD5OfBody></Message>`
      ).join('');
      return xmlResponse(res, 200, sqsWrap('ReceiveMessageResponse','ReceiveMessageResult', xml));
    }
    case 'DeleteMessage': {
      const url = params.get('QueueUrl');
      const q = store.sqs.queues[url];
      const handle = params.get('ReceiptHandle');
      if (q) q.messages = q.messages.filter(m => m.receiptHandle !== handle);
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

// ── Shared helper used by other services (EventBridge, SNS subscriptions,
//    DDB Streams, UI route). Returns the inserted message object.
export function enqueueMessage(queueUrl, body, opts = {}) {
  const q = store.sqs.queues[queueUrl];
  if (!q) throw new Error(`Queue not found: ${queueUrl}`);
  const msg = {
    id:            randomId(36),
    receiptHandle: randomId(64),
    body:          typeof body === 'string' ? body : JSON.stringify(body),
    sent:          Date.now(),
    visible:       true,
    dedupeId:      opts.dedupeId || null,
  };
  q.messages.push(msg);
  return msg;
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

function md5(str) {
  return crypto.createHash('md5').update(String(str)).digest('hex');
}

function sqsWrap(respTag, resultTag, inner) {
  return `<?xml version="1.0"?><${respTag}><${resultTag}>${inner}</${resultTag}><ResponseMetadata><RequestId>${randomId(36)}</RequestId></ResponseMetadata></${respTag}>`;
}
