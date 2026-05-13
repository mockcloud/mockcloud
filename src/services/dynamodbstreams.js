// services/dynamodbstreams.js — DynamoDB Streams emulator
// Fires Lambda triggers on DDB PutItem / DeleteItem / UpdateItem
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

function parseBody(req) {
  try { return JSON.parse(req.rawBody || '{}'); } catch { return {}; }
}

const TARGET_MAP = {
  'DynamoDBStreams_20120810.ListStreams':       listStreams,
  'DynamoDBStreams_20120810.DescribeStream':    describeStream,
  'DynamoDBStreams_20120810.GetShardIterator':  getShardIterator,
  'DynamoDBStreams_20120810.GetRecords':        getRecords,
};

export function handler(req, res) {
  const target = req.headers['x-amz-target'] || '';
  const fn = TARGET_MAP[target];
  if (fn) return fn(req, res);
  return errorJson(res, 400, 'InvalidAction', `Unknown DynamoDB Streams action: ${target}`);
}

// Called internally by dynamodb.js on write operations
export function emitStreamRecord(tableName, eventName, oldImage, newImage) {
  const table = store.dynamodb.tables[tableName];
  if (!table?.streamEnabled) return;

  const streamArn = arn('dynamodb', `table/${tableName}/stream/${table.streamCreated}`);
  if (!store.dynamodbstreams.shards[streamArn]) {
    store.dynamodbstreams.shards[streamArn] = [];
  }

  const record = {
    eventID:      randomId(20),
    eventVersion: '1.1',
    eventSource:  'aws:dynamodb',
    awsRegion:    'us-east-1',
    eventName,                             // INSERT | MODIFY | REMOVE
    dynamodb: {
      Keys:           table.pk ? { [table.pk]: newImage?.[table.pk] || oldImage?.[table.pk] } : {},
      NewImage:       newImage  || undefined,
      OldImage:       oldImage  || undefined,
      StreamViewType: table.streamViewType || 'NEW_AND_OLD_IMAGES',
      SequenceNumber: String(Date.now()),
      SizeBytes:      JSON.stringify(newImage || oldImage || {}).length,
    },
    eventSourceARN: streamArn,
  };

  store.dynamodbstreams.shards[streamArn].push(record);
  if (store.dynamodbstreams.shards[streamArn].length > 1000) {
    store.dynamodbstreams.shards[streamArn].shift();
  }

  // Fire Lambda triggers
  fireLambdaTriggers(tableName, [record]);
}

async function fireLambdaTriggers(tableName, records) {
  const triggers = store.dynamodbstreams.triggers[tableName] || [];
  if (!triggers.length) return;
  // Lazy import to avoid circular module load
  const { invokeLambda } = await import('./lambda.js');
  // DDB Streams envelope shape — Records is exactly what Lambda gets
  const event = { Records: records };
  for (const fnName of triggers) {
    invokeLambda(fnName, event, { source: 'dynamodb-stream' }).catch(()=>{});
  }
}

function listStreams(req, res) {
  const b = parseBody(req);
  const streams = Object.entries(store.dynamodb.tables)
    .filter(([_, t]) => t.streamEnabled)
    .filter(([name]) => !b.TableName || name === b.TableName)
    .map(([name, t]) => ({
      StreamArn:   arn('dynamodb', `table/${name}/stream/${t.streamCreated}`),
      TableName:   name,
      StreamLabel: t.streamCreated,
    }));
  jsonResponse(res, 200, { Streams: streams });
}

function describeStream(req, res) {
  const b = parseBody(req);
  const streamArn = b.StreamArn;
  const tableName = streamArn?.split('/')[1];
  const table = store.dynamodb.tables[tableName];
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', 'Stream not found');
  jsonResponse(res, 200, {
    StreamDescription: {
      StreamArn:    streamArn,
      TableName:    tableName,
      StreamLabel:  table.streamCreated,
      StreamStatus: 'ENABLED',
      StreamViewType: table.streamViewType || 'NEW_AND_OLD_IMAGES',
      Shards: [{ ShardId: `shardId-000000000000`, SequenceNumberRange: { StartingSequenceNumber: '000000000000' } }],
    },
  });
}

function getShardIterator(req, res) {
  const b = parseBody(req);
  const iterator = Buffer.from(JSON.stringify({ streamArn: b.StreamArn, shardId: b.ShardId, pos: 0, t: Date.now() })).toString('base64');
  jsonResponse(res, 200, { ShardIterator: iterator });
}

function getRecords(req, res) {
  const b = parseBody(req);
  try {
    const state  = JSON.parse(Buffer.from(b.ShardIterator, 'base64').toString());
    const records = (store.dynamodbstreams.shards[state.streamArn] || []).slice(state.pos, state.pos + 100);
    state.pos += records.length;
    const nextIterator = Buffer.from(JSON.stringify(state)).toString('base64');
    jsonResponse(res, 200, { Records: records, NextShardIterator: nextIterator });
  } catch {
    errorJson(res, 400, 'ExpiredIteratorException', 'Iterator expired');
  }
}
