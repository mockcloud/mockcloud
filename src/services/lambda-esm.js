// src/services/lambda-esm.js
// SQS → Lambda event-source-mapping poller. AWS auto-invokes a function with
// batches of queue messages; MockCloud previously stored mappings inertly. This
// runs as a background tick (registered below). DynamoDB-Streams mappings fire
// on write elsewhere.
import crypto from 'crypto';
import { store } from '../store.js';
import { invokeLambda } from './lambda.js';
import { queueUrlForArn, selectMessages, hideMessage, removeAndCancel, cancelVisibilityTimer } from './sqs.js';
import { registerTick } from '../lifecycle.js';

let polling = false;

async function pollEventSourceMappingsOnce() {
  if (polling) return;                 // never overlap (the tick fires repeatedly)
  polling = true;
  try {
    for (const mapping of Object.values(store.lambda.eventSourceMappings || {})) {
      if (mapping.State !== 'Enabled') continue;
      if (!mapping.EventSourceArn?.includes(':sqs:')) continue;     // DDB streams fire on write
      const queueUrl = queueUrlForArn(mapping.EventSourceArn);
      const q = queueUrl && store.sqs.queues[queueUrl];
      if (!q) continue;

      const batch = selectMessages(q, mapping.BatchSize || 10);      // applies DLQ redrive + FIFO locking
      if (!batch.length) continue;
      batch.forEach(m => hideMessage(m, 30_000));                    // in-flight; bumps receive count

      const event = { Records: batch.map(m => ({
        messageId:        m.id,
        receiptHandle:    m.receiptHandle,
        body:             m.body,
        attributes: {
          ApproximateReceiveCount: String(m.approxReceiveCount || 1),
          SentTimestamp:           String(m.sent),
          ...(m.groupId ? { MessageGroupId: m.groupId, SequenceNumber: m.sequenceNumber } : {}),
        },
        messageAttributes: {},
        md5OfBody:        crypto.createHash('md5').update(m.body).digest('hex'),
        eventSource:      'aws:sqs',
        eventSourceARN:   mapping.EventSourceArn,
        awsRegion:        'us-east-1',
      })) };

      const fnName  = mapping.FunctionArn.split(':').pop();
      const outcome = await invokeLambda(fnName, event, { source: 'sqs-esm' });
      const handles = new Set(batch.map(m => m.receiptHandle));
      if (!outcome.error) {
        q.messages = removeAndCancel(q.messages, m => handles.has(m.receiptHandle));   // success → delete batch
      } else {
        for (const m of batch) { m.visible = true; cancelVisibilityTimer(m); }         // retry; repeated failures → DLQ
      }
    }
  } finally {
    polling = false;
  }
}

registerTick(() => { pollEventSourceMappingsOnce().catch(() => {}); });
