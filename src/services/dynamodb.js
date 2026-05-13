// services/dynamodb.js — DynamoDB emulator
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson, getRawBody } from '../middleware/response.js';
import { emitStreamRecord } from './dynamodbstreams.js';

export async function handler(req, res) {
  const target = req.headers['x-amz-target'] || '';
  const body = getRawBody(req);
  let payload = {};
  try { payload = JSON.parse(body); } catch {}

  const op = target.split('.').pop();

  switch (op) {
    case 'CreateTable': return createTable(res, payload);
    case 'DeleteTable': return deleteTable(res, payload);
    case 'DescribeTable': return describeTable(res, payload);
    case 'ListTables': return listTables(res, payload);
    case 'PutItem': return putItem(res, payload);
    case 'GetItem': return getItem(res, payload);
    case 'DeleteItem': return deleteItem(res, payload);
    case 'UpdateItem': return updateItem(res, payload);
    case 'Query': return query(res, payload);
    case 'Scan': return scan(res, payload);
    case 'BatchWriteItem': return batchWrite(res, payload);
    case 'BatchGetItem': return batchGet(res, payload);
    case 'TransactWriteItems': return transactWrite(res, payload);
    default: return errorJson(res, 400, 'UnknownOperationException', `Unknown operation: ${op}`);
  }
}

function createTable(res, payload) {
  const name = payload.TableName;
  if (!name) return errorJson(res, 400, 'ValidationException', 'TableName is required');
  if (store.dynamodb.tables[name]) return errorJson(res, 400, 'ResourceInUseException', `Table ${name} already exists`);

  const pkAttr = payload.KeySchema?.find(k => k.KeyType === 'HASH')?.AttributeName || 'id';
  const skAttr = payload.KeySchema?.find(k => k.KeyType === 'RANGE')?.AttributeName || null;

  const stream = payload.StreamSpecification;
  const streamEnabled    = !!stream?.StreamEnabled;
  const streamViewType   = stream?.StreamViewType || 'NEW_AND_OLD_IMAGES';
  const streamCreated    = streamEnabled ? new Date().toISOString().replace(/[:.]/g, '-') : null;

  store.dynamodb.tables[name] = {
    name, pk: pkAttr, sk: skAttr,
    billingMode: payload.BillingMode || 'PAY_PER_REQUEST',
    items: [],
    created: Date.now(),
    arn: arn('dynamodb', `table/${name}`),
    streamEnabled,
    streamViewType,
    streamCreated,
  };
  return jsonResponse(res, 200, { TableDescription: describeTableObj(name) });
}

function deleteTable(res, payload) {
  const name = payload.TableName;
  if (!store.dynamodb.tables[name]) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);
  const desc = describeTableObj(name);
  delete store.dynamodb.tables[name];
  return jsonResponse(res, 200, { TableDescription: desc });
}

function describeTable(res, payload) {
  const name = payload.TableName;
  if (!store.dynamodb.tables[name]) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);
  return jsonResponse(res, 200, { Table: describeTableObj(name) });
}

function listTables(res, _payload) {
  return jsonResponse(res, 200, { TableNames: Object.keys(store.dynamodb.tables) });
}

function putItem(res, payload) {
  const name = payload.TableName;
  const table = store.dynamodb.tables[name];
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);
  const item = unmarshal(payload.Item || {});
  const pkVal = item[table.pk];
  const skVal = table.sk ? item[table.sk] : null;
  const idx = table.items.findIndex(i => i[table.pk] === pkVal && (!table.sk || i[table.sk] === skVal));
  const oldImage = idx >= 0 ? { ...table.items[idx] } : null;
  if (idx >= 0) table.items[idx] = item;
  else table.items.push(item);
  emitStreamRecord(name, oldImage ? 'MODIFY' : 'INSERT', oldImage, item);
  return jsonResponse(res, 200, {});
}

function getItem(res, payload) {
  const name = payload.TableName;
  const table = store.dynamodb.tables[name];
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);
  const key = unmarshal(payload.Key || {});
  const item = table.items.find(i => i[table.pk] === key[table.pk] && (!table.sk || i[table.sk] === key[table.sk]));
  return jsonResponse(res, 200, item ? { Item: marshal(item) } : {});
}

function deleteItem(res, payload) {
  const name = payload.TableName;
  const table = store.dynamodb.tables[name];
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);
  const key = unmarshal(payload.Key || {});
  const idx = table.items.findIndex(i => i[table.pk] === key[table.pk] && (!table.sk || i[table.sk] === key[table.sk]));
  if (idx >= 0) {
    const oldImage = { ...table.items[idx] };
    table.items.splice(idx, 1);
    emitStreamRecord(name, 'REMOVE', oldImage, null);
  }
  return jsonResponse(res, 200, {});
}

function updateItem(res, payload) {
  const name = payload.TableName;
  const table = store.dynamodb.tables[name];
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);
  const key = unmarshal(payload.Key || {});
  const existingIdx = table.items.findIndex(i => i[table.pk] === key[table.pk] && (!table.sk || i[table.sk] === key[table.sk]));
  const oldImage = existingIdx >= 0 ? { ...table.items[existingIdx] } : null;
  let item = existingIdx >= 0 ? table.items[existingIdx] : null;
  if (!item) { item = { ...key }; table.items.push(item); }
  // Apply SET expressions from ExpressionAttributeValues
  const vals = payload.ExpressionAttributeValues ? unmarshal(payload.ExpressionAttributeValues) : {};
  const names = payload.ExpressionAttributeNames || {};
  const expr = payload.UpdateExpression || '';
  const setMatch = expr.match(/SET\s+(.+)$/i);
  if (setMatch) {
    for (const part of setMatch[1].split(',')) {
      const [lhs, rhs] = part.split('=').map(s=>s.trim());
      const attrName = names[lhs] || lhs.replace(/^#/,'');
      const val = vals[rhs];
      if (val !== undefined) item[attrName] = val;
    }
  }
  emitStreamRecord(name, oldImage ? 'MODIFY' : 'INSERT', oldImage, { ...item });
  return jsonResponse(res, 200, {});
}

function scan(res, payload) {
  const name = payload.TableName;
  const table = store.dynamodb.tables[name];
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);
  const limit = payload.Limit || table.items.length;
  const items = table.items.slice(0, limit);
  return jsonResponse(res, 200, { Items: items.map(marshal), Count: items.length, ScannedCount: items.length });
}

function query(res, payload) {
  const name = payload.TableName;
  const table = store.dynamodb.tables[name];
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);
  const vals = payload.ExpressionAttributeValues ? unmarshal(payload.ExpressionAttributeValues) : {};
  let items = table.items;
  // Simple equality filter on key condition
  for (const [k, v] of Object.entries(vals)) {
    items = items.filter(i => {
      for (const attr of Object.values(i)) {
        if (attr === v) return true;
      }
      return false;
    });
  }
  return jsonResponse(res, 200, { Items: items.map(marshal), Count: items.length, ScannedCount: table.items.length });
}

function batchWrite(res, payload) {
  for (const [tableName, requests] of Object.entries(payload.RequestItems || {})) {
    const table = store.dynamodb.tables[tableName];
    if (!table) continue;
    for (const r of requests) {
      if (r.PutRequest) {
        const item = unmarshal(r.PutRequest.Item);
        const idx = table.items.findIndex(i => i[table.pk] === item[table.pk] && (!table.sk || i[table.sk] === item[table.sk]));
        const oldImage = idx >= 0 ? { ...table.items[idx] } : null;
        if (idx >= 0) table.items[idx] = item; else table.items.push(item);
        emitStreamRecord(tableName, oldImage ? 'MODIFY' : 'INSERT', oldImage, item);
      } else if (r.DeleteRequest) {
        const key = unmarshal(r.DeleteRequest.Key);
        const idx = table.items.findIndex(i => i[table.pk] === key[table.pk]);
        if (idx >= 0) {
          const oldImage = { ...table.items[idx] };
          table.items.splice(idx, 1);
          emitStreamRecord(tableName, 'REMOVE', oldImage, null);
        }
      }
    }
  }
  return jsonResponse(res, 200, { UnprocessedItems: {} });
}

function batchGet(res, payload) {
  const responses = {};
  for (const [tableName, spec] of Object.entries(payload.RequestItems || {})) {
    const table = store.dynamodb.tables[tableName];
    if (!table) continue;
    responses[tableName] = (spec.Keys || []).map(k => {
      const key = unmarshal(k);
      return table.items.find(i => i[table.pk] === key[table.pk]);
    }).filter(Boolean).map(marshal);
  }
  return jsonResponse(res, 200, { Responses: responses, UnprocessedKeys: {} });
}

function transactWrite(res, payload) {
  for (const item of payload.TransactItems || []) {
    if (item.Put) {
      const tableName = item.Put.TableName;
      const table = store.dynamodb.tables[tableName];
      if (!table) continue;
      const newItem = unmarshal(item.Put.Item);
      const idx = table.items.findIndex(i => i[table.pk] === newItem[table.pk]);
      const oldImage = idx >= 0 ? { ...table.items[idx] } : null;
      if (idx >= 0) table.items[idx] = newItem; else table.items.push(newItem);
      emitStreamRecord(tableName, oldImage ? 'MODIFY' : 'INSERT', oldImage, newItem);
    } else if (item.Delete) {
      const tableName = item.Delete.TableName;
      const table = store.dynamodb.tables[tableName];
      if (!table) continue;
      const key = unmarshal(item.Delete.Key);
      const idx = table.items.findIndex(i => i[table.pk] === key[table.pk]);
      if (idx >= 0) {
        const oldImage = { ...table.items[idx] };
        table.items.splice(idx, 1);
        emitStreamRecord(tableName, 'REMOVE', oldImage, null);
      }
    }
  }
  return jsonResponse(res, 200, {});
}

// ── Marshaling helpers ────────────────────────────────────────────────────

function marshal(obj) {
  if (obj === null || obj === undefined) return { NULL: true };
  if (typeof obj === 'boolean') return { BOOL: obj };
  if (typeof obj === 'number') return { N: String(obj) };
  if (typeof obj === 'string') return { S: obj };
  if (Array.isArray(obj)) return { L: obj.map(marshal) };
  if (typeof obj === 'object') return { M: Object.fromEntries(Object.entries(obj).map(([k,v]) => [k, marshal(v)])) };
  return { S: String(obj) };
}

function unmarshal(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if ('S' in obj) return obj.S;
  if ('N' in obj) return parseFloat(obj.N);
  if ('BOOL' in obj) return obj.BOOL;
  if ('NULL' in obj) return null;
  if ('L' in obj) return obj.L.map(unmarshal);
  if ('M' in obj) return Object.fromEntries(Object.entries(obj.M).map(([k,v]) => [k, unmarshal(v)]));
  // plain object (not DynamoDB format) — unmarshal values recursively
  return Object.fromEntries(Object.entries(obj).map(([k,v]) => [k, typeof v === 'object' && v !== null && ('S' in v || 'N' in v || 'BOOL' in v || 'M' in v || 'L' in v || 'NULL' in v) ? unmarshal(v) : v]));
}

function describeTableObj(name) {
  const t = store.dynamodb.tables[name];
  return {
    TableName: t.name,
    TableArn: t.arn || arn('dynamodb', `table/${t.name}`),
    TableStatus: 'ACTIVE',
    ItemCount: t.items.length,
    TableSizeBytes: JSON.stringify(t.items).length,
    CreationDateTime: t.created / 1000,
    BillingModeSummary: { BillingMode: t.billingMode },
    KeySchema: [
      { AttributeName: t.pk, KeyType: 'HASH' },
      ...(t.sk ? [{ AttributeName: t.sk, KeyType: 'RANGE' }] : []),
    ],
    AttributeDefinitions: [
      { AttributeName: t.pk, AttributeType: 'S' },
      ...(t.sk ? [{ AttributeName: t.sk, AttributeType: 'S' }] : []),
    ],
  };
}
