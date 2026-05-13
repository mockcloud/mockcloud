// services/sns.js
import { store, randomId, arn } from '../store.js';
import { xmlResponse, errorXml, escapeXml, getRawBody } from '../middleware/response.js';

export async function handler(req, res) {
  const body = getRawBody(req);
  const params = new URLSearchParams(body);
  const action = req.url.includes('?') ? new URL(req.url,'http://x').searchParams.get('Action') : params.get('Action');

  switch (action) {
    case 'CreateTopic': {
      const name = params.get('Name');
      const a = arn('sns', name);
      if (!store.sns.topics[a]) store.sns.topics[a] = { name, arn: a, created: Date.now(), published: 0, subscriptions: [] };
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
    case 'Subscribe': {
      const topicArn = params.get('TopicArn');
      const protocol = params.get('Protocol');
      const endpoint = params.get('Endpoint');
      const topic = store.sns.topics[topicArn];
      if (!topic) return errorXml(res, 404, 'NotFound', 'Topic not found');
      const subArn = `${topicArn}:${randomId(8)}`;
      topic.subscriptions.push({ subArn, protocol, endpoint, status: 'confirmed' });
      return xmlResponse(res, 200, wrap('SubscribeResponse','SubscribeResult', `<SubscriptionArn>${escapeXml(subArn)}</SubscriptionArn>`));
    }
    case 'Publish': {
      const topicArn = params.get('TopicArn');
      const topic = store.sns.topics[topicArn];
      if (!topic) return errorXml(res, 404, 'NotFound', 'Topic not found');
      const message = params.get('Message') || '';
      const subject = params.get('Subject') || '';
      topic.published++;
      const msgId = randomId(36);
      // Fan out to subscribers — async, not awaited (matches AWS semantics:
      // Publish returns success once the message is durably accepted, not
      // once delivered).
      fanoutSnsMessage(topic, { msgId, message, subject }).catch(e => {
        console.warn(`[SNS] Fanout error for ${topicArn}:`, e.message);
      });
      return xmlResponse(res, 200, wrap('PublishResponse','PublishResult', `<MessageId>${msgId}</MessageId>`));
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
        `<Subscriptions>${all.map(s=>`<member><SubscriptionArn>${escapeXml(s.subArn)}</SubscriptionArn><Protocol>${s.protocol}</Protocol><Endpoint>${escapeXml(s.endpoint)}</Endpoint><TopicArn>${escapeXml(s.topicArn)}</TopicArn></member>`).join('')}</Subscriptions>`));
    }
    default:
      return errorXml(res, 400, 'InvalidAction', `Unknown action: ${action}`);
  }
}

// Fan out a published message to all topic subscribers. Each subscription
// is delivered independently — failure of one doesn't block others.
// Exported so EventBridge SNS targets can re-trigger the fanout path.
export async function fanoutSnsMessage(topic, { msgId, message, subject }) {
  const subs = topic.subscriptions || [];
  const snsEnvelope = {
    Type:      'Notification',
    MessageId: msgId,
    TopicArn:  topic.arn,
    Subject:   subject,
    Message:   message,
    Timestamp: new Date().toISOString(),
  };

  // Lazy imports to avoid circular deps at module load
  const [{ invokeLambda }, { enqueueMessage, queueUrlForArn }] = await Promise.all([
    import('./lambda.js'),
    import('./sqs.js'),
  ]);

  for (const sub of subs) {
    try {
      // SQS subscription — endpoint is the queue ARN
      if (sub.protocol === 'sqs' || sub.endpoint?.includes(':sqs:')) {
        const url = queueUrlForArn(sub.endpoint);
        if (url && store.sqs.queues[url]) {
          enqueueMessage(url, JSON.stringify(snsEnvelope));
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

function wrap(respTag, resultTag, inner) {
  return `<?xml version="1.0"?><${respTag} xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><${resultTag}>${inner}</${resultTag}><ResponseMetadata><RequestId>${randomId(36)}</RequestId></ResponseMetadata></${respTag}>`;
}
