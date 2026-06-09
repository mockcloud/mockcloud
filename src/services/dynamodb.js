// services/dynamodb.js — DynamoDB emulator
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson, getRawBody } from '../middleware/response.js';
import { emitStreamRecord } from './dynamodbstreams.js';
import { evaluateCondition, evaluatePredicate, projectItem } from './dynamodb/expression.js';
import { applyUpdate } from './dynamodb/update.js';
import { hydrateFromDisk, persist } from './dynamodb/persistence.js';

// Restore tables + items from disk on startup so they survive a restart.
hydrateFromDisk();

// Resolve the key attributes (pk/sk) used for a Query/Scan, honoring IndexName.
function keyAttrs(table, indexName) {
  if (indexName && Array.isArray(table.indexes)) {
    const ix = table.indexes.find(x => x.name === indexName);
    if (ix) return { pk: ix.pk, sk: ix.sk || null, index: ix };
  }
  return { pk: table.pk, sk: table.sk || null, index: null };
}

// For a query/scan on a secondary index with a KEYS_ONLY or INCLUDE projection,
// build the set of attribute names that should be returned: the table key, the
// index key, and (for INCLUDE) the index's NonKeyAttributes. Returns null when
// the full item should be returned (projection ALL, or a base-table read).
function indexProjectionAttrs(table, index) {
  if (!index || !index.projection || index.projection === 'ALL') return null;
  const attrs = new Set();
  if (table.pk) attrs.add(table.pk);
  if (table.sk) attrs.add(table.sk);
  if (index.pk) attrs.add(index.pk);
  if (index.sk) attrs.add(index.sk);
  if (index.projection === 'INCLUDE') {
    for (const a of index.nonKeyAttributes || []) attrs.add(a);
  }
  return attrs;
}

// Prune a stored item to a set of top-level attribute names.
function pickProjected(item, attrSet) {
  const out = {};
  for (const a of attrSet) if (item[a] !== undefined) out[a] = item[a];
  return out;
}

// Stable comparator for two JS scalars (numbers numeric, otherwise string).
function cmpVals(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : (a < b ? -1 : 1);
  const sa = String(a), sb = String(b);
  return sa === sb ? 0 : (sa < sb ? -1 : 1);
}

// Sort items by (pk, sk) for deterministic ordering / pagination.
function sortByKey(items, pk, sk) {
  return items.slice().sort((x, y) => {
    const c = cmpVals(x[pk], y[pk]);
    if (c !== 0 || !sk) return c;
    return cmpVals(x[sk], y[sk]);
  });
}

// A start-key token used by pagination — the pk (+sk) of an item, marshalled.
function lastKeyOf(item, pk, sk) {
  const k = { [pk]: marshal(item[pk]) };
  if (sk) k[sk] = marshal(item[sk]);
  return k;
}

// Drop items up to and including ExclusiveStartKey (items are pre-sorted).
function afterStartKey(items, startKey, pk, sk) {
  if (!startKey) return items;
  const sKey = unmarshal(startKey);
  const idx = items.findIndex(i =>
    i[pk] === sKey[pk] && (!sk || i[sk] === sKey[sk]));
  return idx >= 0 ? items.slice(idx + 1) : items;
}

// Find a stored item by key (PK + optional SK), or -1.
function findItemIdx(table, key) {
  return table.items.findIndex(i =>
    i[table.pk] === key[table.pk] && (!table.sk || i[table.sk] === key[table.sk])
  );
}

// Try-eval a ConditionExpression. Returns { ok: true } on success;
// { ok: false, validation: msg } if the expression is malformed (becomes a
// ValidationException), { ok: false, failed: true } if it evaluated false.
function tryCondition(expr, existing, names, values) {
  if (!expr) return { ok: true };
  if (typeof expr === 'string' && expr.trim() === '') {
    return { ok: false, validation: 'Invalid ConditionExpression: The expression cannot be empty' };
  }
  try {
    const passed = evaluateCondition(expr, existing, names, values);
    return passed ? { ok: true } : { ok: false, failed: true };
  } catch (e) {
    return { ok: false, validation: e.message };
  }
}

// Validate that an Item supplied to PutItem (or TransactWrite Put) contains
// the table's key attributes. AWS returns a ValidationException when they're
// missing; otherwise MockCloud would silently insert garbage that's invisible
// to the same key lookups the SDK then performs.
function missingKeyAttr(table, item) {
  if (item == null || typeof item !== 'object' || item[table.pk] === undefined) {
    return table.pk;
  }
  if (table.sk && item[table.sk] === undefined) return table.sk;
  return null;
}

// Same for the Key supplied to GetItem/DeleteItem/UpdateItem.
function missingKeyInKey(table, key) {
  if (key == null || typeof key !== 'object' || key[table.pk] === undefined) {
    return table.pk;
  }
  if (table.sk && key[table.sk] === undefined) return table.sk;
  return null;
}

// Stable identity for a (table, key) pair, used to detect duplicate writes
// inside a single TransactWriteItems request.
function txKeyId(tableName, table, key) {
  const pk = key[table.pk];
  const sk = table.sk ? key[table.sk] : null;
  return `${tableName}\x00${JSON.stringify(pk)}\x00${JSON.stringify(sk)}`;
}

// Single-item conditional-failure response. Matches AWS error JSON:
//   HTTP 400, { __type: "ConditionalCheckFailedException",
//               message: "The conditional request failed",
//               Item?: <marshaled old image> }
function respondConditionalFailed(res, existing, returnValues) {
  const body = {
    __type:  'ConditionalCheckFailedException',
    message: 'The conditional request failed',
  };
  if (returnValues === 'ALL_OLD' && existing) {
    body.Item = marshalItem(existing);
  }
  return jsonResponse(res, 400, body);
}

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
    case 'UpdateTable': return updateTable(res, payload);
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
    case 'TransactGetItems': return transactGet(res, payload);
    case 'UpdateTimeToLive': return updateTimeToLive(res, payload);
    case 'DescribeTimeToLive': return describeTimeToLive(res, payload);
    case 'TagResource': return tagResource(res, payload);
    case 'UntagResource': return untagResource(res, payload);
    case 'ListTagsOfResource': return listTagsOfResource(res, payload);
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

  // Secondary indexes declared at create time (GSI + LSI) are normalized to
  // the same internal shape the UI control plane uses.
  const indexes = [
    ...(payload.GlobalSecondaryIndexes || []).map(g => normalizeIndex(g, 'GSI')),
    ...(payload.LocalSecondaryIndexes  || []).map(l => normalizeIndex(l, 'LSI')),
  ];

  store.dynamodb.tables[name] = {
    name, pk: pkAttr, sk: skAttr,
    billingMode: payload.BillingMode || 'PAY_PER_REQUEST',
    items: [],
    indexes,
    created: Date.now(),
    arn: arn('dynamodb', `table/${name}`),
    streamEnabled,
    streamViewType,
    streamCreated,
  };
  store.addTrail({ method: 'POST', path: `/dynamodb/CreateTable/${name}`, status: 200, latency: 2 });
  persist();
  return jsonResponse(res, 200, { TableDescription: describeTableObj(name) });
}

// Convert an AWS GSI/LSI definition into MockCloud's internal index shape.
function normalizeIndex(def, type) {
  return {
    name:       def.IndexName,
    type,
    pk:         def.KeySchema?.find(k => k.KeyType === 'HASH')?.AttributeName || null,
    sk:         def.KeySchema?.find(k => k.KeyType === 'RANGE')?.AttributeName || null,
    projection: def.Projection?.ProjectionType || 'ALL',
    // Only meaningful for projection === 'INCLUDE'.
    nonKeyAttributes: def.Projection?.NonKeyAttributes || [],
    created:    Date.now(),
  };
}

function deleteTable(res, payload) {
  const name = payload.TableName;
  if (!store.dynamodb.tables[name]) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);
  const desc = describeTableObj(name);
  delete store.dynamodb.tables[name];
  store.addTrail({ method: 'POST', path: `/dynamodb/DeleteTable/${name}`, status: 200, latency: 1 });
  persist();
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

// UpdateTable — change billing mode, add/remove GSIs, toggle streams.
function updateTable(res, payload) {
  const name = payload.TableName;
  const table = store.dynamodb.tables[name];
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);

  if (payload.BillingMode) table.billingMode = payload.BillingMode;

  if (payload.StreamSpecification) {
    table.streamEnabled  = !!payload.StreamSpecification.StreamEnabled;
    table.streamViewType = payload.StreamSpecification.StreamViewType || table.streamViewType || 'NEW_AND_OLD_IMAGES';
    if (table.streamEnabled && !table.streamCreated) {
      table.streamCreated = new Date().toISOString().replace(/[:.]/g, '-');
    }
  }

  if (!table.indexes) table.indexes = [];
  for (const upd of payload.GlobalSecondaryIndexUpdates || []) {
    if (upd.Create) {
      if (!table.indexes.some(ix => ix.name === upd.Create.IndexName)) {
        table.indexes.push(normalizeIndex(upd.Create, 'GSI'));
      }
    } else if (upd.Delete) {
      table.indexes = table.indexes.filter(ix => ix.name !== upd.Delete.IndexName);
    } else if (upd.Update) {
      const ix = table.indexes.find(x => x.name === upd.Update.IndexName);
      if (ix && upd.Update.Projection) ix.projection = upd.Update.Projection.ProjectionType || ix.projection;
    }
  }

  store.addTrail({ method: 'POST', path: `/dynamodb/UpdateTable/${name}`, status: 200, latency: 2 });
  persist();
  return jsonResponse(res, 200, { TableDescription: describeTableObj(name) });
}

// ── TTL (time-to-live) ──────────────────────────────────────────────────────
// Items carry an epoch-seconds expiry in the configured attribute. We sweep
// lazily: any read path that touches a table first drops items already expired.
function sweepExpired(table) {
  const ttl = table.ttl;
  if (!ttl || !ttl.enabled || !ttl.attribute) return;
  const now = Date.now() / 1000;
  const attr = ttl.attribute;
  if (table.items.some(i => typeof i[attr] === 'number' && i[attr] <= now)) {
    table.items = table.items.filter(i => !(typeof i[attr] === 'number' && i[attr] <= now));
    persist();
  }
}

function updateTimeToLive(res, payload) {
  const name = payload.TableName;
  const table = store.dynamodb.tables[name];
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);
  const spec = payload.TimeToLiveSpecification || {};
  table.ttl = { enabled: !!spec.Enabled, attribute: spec.AttributeName || null };
  persist();
  return jsonResponse(res, 200, { TimeToLiveSpecification: {
    Enabled: table.ttl.enabled, AttributeName: table.ttl.attribute,
  } });
}

function describeTimeToLive(res, payload) {
  const name = payload.TableName;
  const table = store.dynamodb.tables[name];
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);
  const ttl = table.ttl;
  return jsonResponse(res, 200, { TimeToLiveDescription: {
    TimeToLiveStatus: ttl && ttl.enabled ? 'ENABLED' : 'DISABLED',
    ...(ttl && ttl.attribute ? { AttributeName: ttl.attribute } : {}),
  } });
}

// ── Tags ────────────────────────────────────────────────────────────────────
function tableByArn(resourceArn) {
  return Object.values(store.dynamodb.tables).find(
    t => (t.arn || arn('dynamodb', `table/${t.name}`)) === resourceArn,
  );
}

function tagResource(res, payload) {
  const table = tableByArn(payload.ResourceArn);
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', 'Resource not found');
  if (!table.tags) table.tags = {};
  for (const { Key, Value } of payload.Tags || []) table.tags[Key] = Value;
  persist();
  return jsonResponse(res, 200, {});
}

function untagResource(res, payload) {
  const table = tableByArn(payload.ResourceArn);
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', 'Resource not found');
  for (const key of payload.TagKeys || []) { if (table.tags) delete table.tags[key]; }
  persist();
  return jsonResponse(res, 200, {});
}

function listTagsOfResource(res, payload) {
  const table = tableByArn(payload.ResourceArn);
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', 'Resource not found');
  const Tags = Object.entries(table.tags || {}).map(([Key, Value]) => ({ Key, Value }));
  return jsonResponse(res, 200, { Tags });
}

// TransactGetItems — atomic-ish multi-get. Returns Responses aligned to the
// request order ({} for misses, { Item } for hits).
function transactGet(res, payload) {
  const Responses = [];
  for (const t of payload.TransactItems || []) {
    const g = t.Get;
    if (!g) { Responses.push({}); continue; }
    const table = store.dynamodb.tables[g.TableName];
    if (!table) { Responses.push({}); continue; }
    sweepExpired(table);
    const key = unmarshal(g.Key || {});
    let item = table.items.find(i => i[table.pk] === key[table.pk] && (!table.sk || i[table.sk] === key[table.sk]));
    if (item && g.ProjectionExpression) item = projectItem(item, g.ProjectionExpression, g.ExpressionAttributeNames);
    store.recordDynamoOp(g.TableName, 'read', 1);
    Responses.push(item ? { Item: marshalItem(item) } : {});
  }
  return jsonResponse(res, 200, { Responses });
}

function putItem(res, payload) {
  const name = payload.TableName;
  const table = store.dynamodb.tables[name];
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);
  const item = unmarshal(payload.Item || {});
  const missing = missingKeyAttr(table, item);
  if (missing) return errorJson(res, 400, 'ValidationException',
    `One or more parameter values were invalid: Missing the key ${missing} in the item`);
  const pkVal = item[table.pk];
  const skVal = table.sk ? item[table.sk] : null;
  const idx = table.items.findIndex(i => i[table.pk] === pkVal && (!table.sk || i[table.sk] === skVal));
  const oldImage = idx >= 0 ? { ...table.items[idx] } : null;

  const cond = tryCondition(
    payload.ConditionExpression, oldImage,
    payload.ExpressionAttributeNames, payload.ExpressionAttributeValues,
  );
  if (cond.validation) return errorJson(res, 400, 'ValidationException', cond.validation);
  if (cond.failed)     return respondConditionalFailed(res, oldImage, payload.ReturnValuesOnConditionCheckFailure);

  if (idx >= 0) table.items[idx] = item;
  else table.items.push(item);
  store.recordDynamoOp(name, 'write', 1);
  emitStreamRecord(name, oldImage ? 'MODIFY' : 'INSERT', oldImage, item);
  persist();
  // PutItem only honors ReturnValues = ALL_OLD (the overwritten image) or NONE.
  const out = {};
  if (payload.ReturnValues === 'ALL_OLD' && oldImage) out.Attributes = marshalItem(oldImage);
  return jsonResponse(res, 200, out);
}

function getItem(res, payload) {
  const name = payload.TableName;
  const table = store.dynamodb.tables[name];
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);
  sweepExpired(table);
  const key = unmarshal(payload.Key || {});
  let item = table.items.find(i => i[table.pk] === key[table.pk] && (!table.sk || i[table.sk] === key[table.sk]));
  // Strongly-consistent point read of an item ≤4KB = 1 RCU (ConsistentRead is a no-op here).
  store.recordDynamoOp(name, 'read', 1);
  if (item && payload.ProjectionExpression) {
    item = projectItem(item, payload.ProjectionExpression, payload.ExpressionAttributeNames);
  }
  return jsonResponse(res, 200, item ? { Item: marshalItem(item) } : {});
}

function deleteItem(res, payload) {
  const name = payload.TableName;
  const table = store.dynamodb.tables[name];
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);
  const key = unmarshal(payload.Key || {});
  const missing = missingKeyInKey(table, key);
  if (missing) return errorJson(res, 400, 'ValidationException',
    `The provided key element does not match the schema (missing ${missing})`);
  const idx = findItemIdx(table, key);
  const existing = idx >= 0 ? table.items[idx] : null;

  const cond = tryCondition(
    payload.ConditionExpression, existing,
    payload.ExpressionAttributeNames, payload.ExpressionAttributeValues,
  );
  if (cond.validation) return errorJson(res, 400, 'ValidationException', cond.validation);
  if (cond.failed)     return respondConditionalFailed(res, existing, payload.ReturnValuesOnConditionCheckFailure);

  const out = {};
  if (idx >= 0) {
    const oldImage = { ...table.items[idx] };
    table.items.splice(idx, 1);
    emitStreamRecord(name, 'REMOVE', oldImage, null);
    if (payload.ReturnValues === 'ALL_OLD') out.Attributes = marshalItem(oldImage);
  }
  store.recordDynamoOp(name, 'write', 1);
  persist();
  return jsonResponse(res, 200, out);
}

function updateItem(res, payload) {
  const name = payload.TableName;
  const table = store.dynamodb.tables[name];
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);
  const key = unmarshal(payload.Key || {});
  const missing = missingKeyInKey(table, key);
  if (missing) return errorJson(res, 400, 'ValidationException',
    `The provided key element does not match the schema (missing ${missing})`);
  const existingIdx = findItemIdx(table, key);
  const oldImage = existingIdx >= 0 ? { ...table.items[existingIdx] } : null;

  const cond = tryCondition(
    payload.ConditionExpression, oldImage,
    payload.ExpressionAttributeNames, payload.ExpressionAttributeValues,
  );
  if (cond.validation) return errorJson(res, 400, 'ValidationException', cond.validation);
  if (cond.failed)     return respondConditionalFailed(res, oldImage, payload.ReturnValuesOnConditionCheckFailure);

  // Build the new image from the old via the UpdateExpression engine. The key
  // attributes are always present on the resulting item.
  const base = oldImage ? { ...oldImage } : { ...key };
  const jsVals = payload.ExpressionAttributeValues ? unmarshal(payload.ExpressionAttributeValues) : {};
  let result;
  try {
    result = applyUpdate(
      base, payload.UpdateExpression || '',
      payload.ExpressionAttributeNames, payload.ExpressionAttributeValues, jsVals,
    );
  } catch (e) {
    return errorJson(res, 400, 'ValidationException', e.message);
  }
  // Re-assert key attributes (REMOVE must never drop the key).
  for (const [k, v] of Object.entries(key)) result.item[k] = v;

  if (existingIdx >= 0) table.items[existingIdx] = result.item;
  else table.items.push(result.item);

  store.recordDynamoOp(name, 'write', 1);
  emitStreamRecord(name, oldImage ? 'MODIFY' : 'INSERT', oldImage, { ...result.item });
  persist();

  const out = {};
  const rv = payload.ReturnValues;
  if (rv === 'ALL_NEW') out.Attributes = marshalItem(result.item);
  else if (rv === 'ALL_OLD' && oldImage) out.Attributes = marshalItem(oldImage);
  else if (rv === 'UPDATED_NEW') out.Attributes = marshalItem(pickAttrs(result.item, result.changed));
  else if (rv === 'UPDATED_OLD' && oldImage) out.Attributes = marshalItem(pickAttrs(oldImage, result.changed));
  return jsonResponse(res, 200, out);
}

// Pick a subset of top-level attributes (used for UPDATED_NEW / UPDATED_OLD).
function pickAttrs(item, attrs) {
  const out = {};
  for (const a of attrs) if (a && item[a] !== undefined) out[a] = item[a];
  return out;
}

function scan(res, payload) {
  const name = payload.TableName;
  const table = store.dynamodb.tables[name];
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);
  sweepExpired(table);

  const { pk, sk, index } = keyAttrs(table, payload.IndexName);
  const indexProj = indexProjectionAttrs(table, index);
  const names = payload.ExpressionAttributeNames;
  const rawVals = payload.ExpressionAttributeValues;

  // Deterministic order so pagination is stable.
  let all = sortByKey(table.items, pk, sk);
  const scannedTotal = all.length;
  all = afterStartKey(all, payload.ExclusiveStartKey, pk, sk);

  // Apply FilterExpression (same engine as ConditionExpression).
  let matched;
  try {
    matched = payload.FilterExpression
      ? all.filter(i => evaluatePredicate(payload.FilterExpression, i, names, rawVals))
      : all;
  } catch (e) {
    return errorJson(res, 400, 'ValidationException', e.message);
  }

  // Limit caps the number of items scanned/returned in this page.
  const limit = payload.Limit && payload.Limit > 0 ? payload.Limit : matched.length;
  const page = matched.slice(0, limit);
  const more = matched.length > limit;

  store.recordDynamoOp(name, 'read', Math.max(1, Math.ceil(page.length / 2)));
  return finishReadResponse(res, page, scannedTotal, payload, pk, sk, more, indexProj);
}

// Core Query engine, decoupled from the HTTP response so both the AWS handler
// (query) and the UI control plane (routes/dynamodb.js query runner) can reuse
// it. Returns { error } on a bad expression, otherwise the projected JS page
// plus metadata. `items` are unmarshalled JS (post-projection); callers marshal
// as needed. `lastKey` is a plain key object or null.
export function runQuery(table, payload) {
  sweepExpired(table);
  const { pk, sk, index } = keyAttrs(table, payload.IndexName);
  const indexProj = indexProjectionAttrs(table, index);
  const names = payload.ExpressionAttributeNames;
  const rawVals = payload.ExpressionAttributeValues;

  // Filter through the KeyConditionExpression (full grammar): a single
  // partition (pk = :p) plus optional sort-key comparators / BETWEEN /
  // begins_with — the engine enforces all of that. No condition ⇒ all items.
  let keyed;
  try {
    keyed = payload.KeyConditionExpression
      ? table.items.filter(i => evaluatePredicate(payload.KeyConditionExpression, i, names, rawVals))
      : table.items;
  } catch (e) { return { error: e.message }; }
  const scannedCount = keyed.length;

  // Sort by sort key; ScanIndexForward=false reverses.
  let ordered = sortByKey(keyed, pk, sk);
  if (payload.ScanIndexForward === false) ordered.reverse();
  ordered = afterStartKey(ordered, payload.ExclusiveStartKey, pk, sk);

  // FilterExpression is applied after the key condition.
  let matched;
  try {
    matched = payload.FilterExpression
      ? ordered.filter(i => evaluatePredicate(payload.FilterExpression, i, names, rawVals))
      : ordered;
  } catch (e) { return { error: e.message }; }

  const limit = payload.Limit && payload.Limit > 0 ? payload.Limit : matched.length;
  const page = matched.slice(0, limit);
  const more = matched.length > limit;

  // Projection: explicit ProjectionExpression wins; otherwise a KEYS_ONLY /
  // INCLUDE index projection restricts the attribute set.
  let items = page;
  if (payload.ProjectionExpression) {
    try { items = page.map(i => projectItem(i, payload.ProjectionExpression, names)); }
    catch (e) { return { error: e.message }; }
  } else if (indexProj) {
    items = page.map(i => pickProjected(i, indexProj));
  }

  let lastKey = null;
  if (more && page.length) {
    const last = page[page.length - 1];
    lastKey = { [pk]: last[pk] };
    if (sk) lastKey[sk] = last[sk];
  }
  return { items, count: page.length, scannedCount, lastKey };
}

function query(res, payload) {
  const name = payload.TableName;
  const table = store.dynamodb.tables[name];
  if (!table) return errorJson(res, 400, 'ResourceNotFoundException', `Table ${name} not found`);

  const r = runQuery(table, payload);
  if (r.error) return errorJson(res, 400, 'ValidationException', r.error);
  store.recordDynamoOp(name, 'read', Math.max(1, Math.ceil(r.count / 2)));

  if (payload.Select === 'COUNT') {
    const body = { Count: r.count, ScannedCount: r.scannedCount };
    if (r.lastKey) body.LastEvaluatedKey = marshalItem(r.lastKey);
    return jsonResponse(res, 200, body);
  }
  const body = {
    Items: r.items.map(marshalItem),
    Count: r.items.length,
    ScannedCount: r.scannedCount,
  };
  if (r.lastKey) body.LastEvaluatedKey = marshalItem(r.lastKey);
  return jsonResponse(res, 200, body);
}

// Shared response shaping for Query/Scan: Select=COUNT, ProjectionExpression,
// secondary-index projection (KEYS_ONLY/INCLUDE), pagination (LastEvaluatedKey).
// `page` is the already-limited result set. `indexProjAttrs` is a Set of allowed
// attribute names when querying an index whose projection is not ALL, else null.
function finishReadResponse(res, page, scannedCount, payload, pk, sk, more, indexProjAttrs = null) {
  if (payload.Select === 'COUNT') {
    const body = { Count: page.length, ScannedCount: scannedCount };
    if (more && page.length) body.LastEvaluatedKey = lastKeyOf(page[page.length - 1], pk, sk);
    return jsonResponse(res, 200, body);
  }
  let items = page;
  // An explicit ProjectionExpression takes precedence; otherwise an index's
  // KEYS_ONLY/INCLUDE projection restricts which attributes come back.
  if (payload.ProjectionExpression) {
    try {
      items = page.map(i => projectItem(i, payload.ProjectionExpression, payload.ExpressionAttributeNames));
    } catch (e) {
      return errorJson(res, 400, 'ValidationException', e.message);
    }
  } else if (indexProjAttrs) {
    items = page.map(i => pickProjected(i, indexProjAttrs));
  }
  const body = {
    Items: items.map(marshalItem),
    Count: items.length,
    ScannedCount: scannedCount,
  };
  if (more && page.length) body.LastEvaluatedKey = lastKeyOf(page[page.length - 1], pk, sk);
  return jsonResponse(res, 200, body);
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
        store.recordDynamoOp(tableName, 'write', 1);
        emitStreamRecord(tableName, oldImage ? 'MODIFY' : 'INSERT', oldImage, item);
      } else if (r.DeleteRequest) {
        const key = unmarshal(r.DeleteRequest.Key);
        const idx = table.items.findIndex(i => i[table.pk] === key[table.pk]);
        if (idx >= 0) {
          const oldImage = { ...table.items[idx] };
          table.items.splice(idx, 1);
          store.recordDynamoOp(tableName, 'write', 1);
          emitStreamRecord(tableName, 'REMOVE', oldImage, null);
        }
      }
    }
  }
  persist();
  return jsonResponse(res, 200, { UnprocessedItems: {} });
}

function batchGet(res, payload) {
  const responses = {};
  for (const [tableName, spec] of Object.entries(payload.RequestItems || {})) {
    const table = store.dynamodb.tables[tableName];
    if (!table) continue;
    const keys = spec.Keys || [];
    responses[tableName] = keys.map(k => {
      const key = unmarshal(k);
      return table.items.find(i =>
        i[table.pk] === key[table.pk] && (!table.sk || i[table.sk] === key[table.sk])
      );
    }).filter(Boolean).map(marshalItem);
    if (keys.length) store.recordDynamoOp(tableName, 'read', keys.length);
  }
  return jsonResponse(res, 200, { Responses: responses, UnprocessedKeys: {} });
}

function transactWrite(res, payload) {
  const items = payload.TransactItems || [];

  // Up-front shape validation: AWS rejects an empty list, >100 items, or any
  // item whose action shape isn't exactly one of Put/Update/Delete/ConditionCheck.
  if (!Array.isArray(items) || items.length === 0) {
    return errorJson(res, 400, 'ValidationException',
      'TransactItems must have length between 1 and 100');
  }
  if (items.length > 100) {
    return errorJson(res, 400, 'ValidationException',
      'TransactItems must have length between 1 and 100');
  }
  for (const it of items) {
    const keys = ['Put', 'Update', 'Delete', 'ConditionCheck'].filter(k => it && it[k]);
    if (keys.length !== 1) {
      return errorJson(res, 400, 'ValidationException',
        'TransactItems member must contain exactly one of Put, Update, Delete, or ConditionCheck');
    }
  }

  // Phase 1: pre-validate every item against the PRE-transaction snapshot.
  // Nothing is mutated until all conditions pass; on any failure we emit a
  // TransactionCanceledException with a CancellationReasons array aligned to
  // item order ("None" for non-failing items, "ConditionalCheckFailed" for
  // the failures, optionally with an Item payload).
  const reasons = items.map(() => ({ Code: 'None' }));
  let anyFailed = false;
  let validationError = null;

  const resolved = items.map(it => {
    const op = it.Put || it.Update || it.Delete || it.ConditionCheck;
    const kind = it.Put ? 'Put' : it.Update ? 'Update' : it.Delete ? 'Delete' : 'ConditionCheck';
    const table = store.dynamodb.tables[op.TableName];
    if (!table) return { kind, op, table: null };
    let key;
    if (kind === 'Put') {
      const newItem = unmarshal(op.Item || {});
      const miss = missingKeyAttr(table, newItem);
      if (miss) return { kind, op, table, validation:
        `One or more parameter values were invalid: Missing the key ${miss} in the item` };
      key = { [table.pk]: newItem[table.pk] };
      if (table.sk) key[table.sk] = newItem[table.sk];
      return { kind, op, table, key, newItem };
    }
    key = unmarshal(op.Key || {});
    const miss = missingKeyInKey(table, key);
    if (miss) return { kind, op, table, validation:
      `The provided key element does not match the schema (missing ${miss})` };
    return { kind, op, table, key };
  });

  // Surface table-not-found and key-shape errors as ValidationException — AWS
  // sometimes folds these into CancellationReasons, but local SDK callers
  // typically see a top-level ValidationException for malformed requests.
  for (const r of resolved) {
    if (r.validation) return errorJson(res, 400, 'ValidationException', r.validation);
    if (!r.table) return errorJson(res, 400, 'ResourceNotFoundException',
      `Table ${r.op.TableName} not found`);
  }

  // No two items in one transaction may target the same (table, key). AWS
  // returns a ValidationException ("multiple operations on one item") rather
  // than running them in sequence.
  const seen = new Set();
  for (const r of resolved) {
    const id = txKeyId(r.op.TableName, r.table, r.key);
    if (seen.has(id)) {
      return errorJson(res, 400, 'ValidationException',
        'Transaction request cannot include multiple operations on one item');
    }
    seen.add(id);
  }

  for (let i = 0; i < items.length; i++) {
    const r = resolved[i];
    const idx = findItemIdx(r.table, r.key);
    const existing = idx >= 0 ? r.table.items[idx] : null;
    r.existing = existing;
    r.idx = idx;

    const cond = tryCondition(
      r.op.ConditionExpression, existing,
      r.op.ExpressionAttributeNames, r.op.ExpressionAttributeValues,
    );
    if (cond.validation) { validationError = cond.validation; break; }
    if (cond.failed) {
      anyFailed = true;
      const reason = { Code: 'ConditionalCheckFailed', Message: 'The conditional request failed' };
      if (r.op.ReturnValuesOnConditionCheckFailure === 'ALL_OLD' && existing) {
        reason.Item = marshalItem(existing);
      }
      reasons[i] = reason;
    }
  }

  if (validationError) return errorJson(res, 400, 'ValidationException', validationError);
  if (anyFailed) {
    return jsonResponse(res, 400, {
      __type: 'TransactionCanceledException',
      message: 'Transaction cancelled, please refer cancellation reasons for specific reasons',
      CancellationReasons: reasons,
    });
  }

  // Phase 2: apply. ConditionCheck items contribute no mutation.
  for (const r of resolved) {
    if (r.kind === 'ConditionCheck') continue;
    if (r.kind === 'Put') {
      const oldImage = r.idx >= 0 ? { ...r.table.items[r.idx] } : null;
      if (r.idx >= 0) r.table.items[r.idx] = r.newItem;
      else r.table.items.push(r.newItem);
      store.recordDynamoOp(r.op.TableName, 'write', 1);
      emitStreamRecord(r.op.TableName, oldImage ? 'MODIFY' : 'INSERT', oldImage, r.newItem);
    } else if (r.kind === 'Delete') {
      if (r.idx >= 0) {
        const oldImage = { ...r.table.items[r.idx] };
        r.table.items.splice(r.idx, 1);
        store.recordDynamoOp(r.op.TableName, 'write', 1);
        emitStreamRecord(r.op.TableName, 'REMOVE', oldImage, null);
      }
    } else if (r.kind === 'Update') {
      const oldImage = r.idx >= 0 ? { ...r.table.items[r.idx] } : null;
      const base = oldImage ? { ...oldImage } : { ...r.key };
      const jsVals = r.op.ExpressionAttributeValues ? unmarshal(r.op.ExpressionAttributeValues) : {};
      const result = applyUpdate(
        base, r.op.UpdateExpression || '',
        r.op.ExpressionAttributeNames, r.op.ExpressionAttributeValues, jsVals,
      );
      for (const [k, v] of Object.entries(r.key)) result.item[k] = v;
      if (r.idx >= 0) r.table.items[r.idx] = result.item;
      else r.table.items.push(result.item);
      store.recordDynamoOp(r.op.TableName, 'write', 1);
      emitStreamRecord(r.op.TableName, oldImage ? 'MODIFY' : 'INSERT', oldImage, { ...result.item });
    }
  }
  persist();
  return jsonResponse(res, 200, {});
}

// ── Marshaling helpers ────────────────────────────────────────────────────

// An "item" is a flat map of attribute names → marshaled values. The
// generic marshal() below would wrap the whole thing in `{ M: ... }`, which
// is correct for *nested* maps but wrong for the top-level Item AWS returns.
function marshalItem(item) {
  return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, marshal(v)]));
}

export function marshal(obj) {
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
  const indexes = t.indexes || [];
  const toAwsIndex = ix => ({
    IndexName: ix.name,
    KeySchema: [
      { AttributeName: ix.pk, KeyType: 'HASH' },
      ...(ix.sk ? [{ AttributeName: ix.sk, KeyType: 'RANGE' }] : []),
    ],
    Projection: {
      ProjectionType: ix.projection || 'ALL',
      ...(ix.projection === 'INCLUDE' && ix.nonKeyAttributes?.length
        ? { NonKeyAttributes: ix.nonKeyAttributes }
        : {}),
    },
    IndexStatus: 'ACTIVE',
    ItemCount: t.items.length,
  });
  const gsis = indexes.filter(ix => ix.type === 'GSI');
  const lsis = indexes.filter(ix => ix.type === 'LSI');
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
    ...(gsis.length ? { GlobalSecondaryIndexes: gsis.map(toAwsIndex) } : {}),
    ...(lsis.length ? { LocalSecondaryIndexes:  lsis.map(toAwsIndex) } : {}),
  };
}
