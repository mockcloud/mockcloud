// tests/dynamodb.test.js
// Exercises the DynamoDB JSON protocol (DynamoDB_20120810.*) directly so the
// test doesn't depend on a separately-installed @aws-sdk/client-dynamodb.

import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { awsJson } from './helpers/http.js';
import { store } from '../src/store.js';
import { persistNow, hydrateFromDisk } from '../src/services/dynamodb/persistence.js';

let server;
const ddb = (op, payload) => awsJson(server.endpoint, `DynamoDB_20120810.${op}`, payload);

// Thin client for MockCloud's internal /mockcloud REST control plane (the API
// the web UI uses) so we can test the Create-item / Create-index / metrics
// surfaces the UI drives.
async function rest(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(server.endpoint + path, opts);
  const text = await res.text();
  let parsed; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

beforeAll(async () => { server = await startServer(); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

describe('Table CRUD', () => {
  it('CreateTable returns ACTIVE table', async () => {
    const res = await ddb('CreateTable', {
      TableName: 'users',
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.TableDescription.TableName, 'users');
    assert.equal(res.body.TableDescription.TableStatus, 'ACTIVE');
  });

  it('CreateTable rejects duplicate', async () => {
    await ddb('CreateTable', { TableName: 't', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] });
    const dup = await ddb('CreateTable', { TableName: 't', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] });
    assert.equal(dup.status, 400);
    assert.match(dup.body.__type, /ResourceInUseException/);
  });

  it('ListTables returns created tables', async () => {
    await ddb('CreateTable', { TableName: 'a', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] });
    await ddb('CreateTable', { TableName: 'b', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] });
    const list = await ddb('ListTables', {});
    assert.deepEqual(list.body.TableNames.sort(), ['a', 'b']);
  });

  it('DescribeTable on missing table 400s', async () => {
    const res = await ddb('DescribeTable', { TableName: 'nope' });
    assert.equal(res.status, 400);
    assert.match(res.body.__type, /ResourceNotFoundException/);
  });

  it('DeleteTable removes the table', async () => {
    await ddb('CreateTable', { TableName: 'tmp', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] });
    await ddb('DeleteTable', { TableName: 'tmp' });
    const list = await ddb('ListTables', {});
    assert.ok(!list.body.TableNames.includes('tmp'));
  });
});

describe('Item CRUD round-trip', () => {
  beforeEach(async () => {
    await ddb('CreateTable', { TableName: 'items', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] });
  });

  it('PutItem then GetItem returns the same item', async () => {
    await ddb('PutItem', {
      TableName: 'items',
      Item: { id: { S: 'a1' }, name: { S: 'alpha' }, count: { N: '7' } },
    });
    const get = await ddb('GetItem', { TableName: 'items', Key: { id: { S: 'a1' } } });
    assert.equal(get.status, 200);
    assert.equal(get.body.Item.id.S, 'a1');
    assert.equal(get.body.Item.name.S, 'alpha');
    assert.equal(get.body.Item.count.N, '7');
  });

  it('GetItem on missing key returns empty body (no Item key)', async () => {
    const get = await ddb('GetItem', { TableName: 'items', Key: { id: { S: 'missing' } } });
    assert.equal(get.status, 200);
    assert.equal(get.body.Item, undefined);
  });

  it('DeleteItem removes the item', async () => {
    await ddb('PutItem', { TableName: 'items', Item: { id: { S: 'gone' } } });
    await ddb('DeleteItem', { TableName: 'items', Key: { id: { S: 'gone' } } });
    const get = await ddb('GetItem', { TableName: 'items', Key: { id: { S: 'gone' } } });
    assert.equal(get.body.Item, undefined);
  });

  it('Scan returns all items with Count and ScannedCount', async () => {
    await ddb('PutItem', { TableName: 'items', Item: { id: { S: '1' } } });
    await ddb('PutItem', { TableName: 'items', Item: { id: { S: '2' } } });
    await ddb('PutItem', { TableName: 'items', Item: { id: { S: '3' } } });
    const scan = await ddb('Scan', { TableName: 'items' });
    assert.equal(scan.body.Count, 3);
    assert.equal(scan.body.ScannedCount, 3);
    assert.equal(scan.body.Items.length, 3);
  });
});

describe('BatchWriteItem and TransactWriteItems', () => {
  beforeEach(async () => {
    await ddb('CreateTable', { TableName: 'b', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] });
  });

  it('BatchWriteItem inserts multiple items', async () => {
    await ddb('BatchWriteItem', {
      RequestItems: {
        b: [
          { PutRequest: { Item: { id: { S: '1' } } } },
          { PutRequest: { Item: { id: { S: '2' } } } },
        ],
      },
    });
    const scan = await ddb('Scan', { TableName: 'b' });
    assert.equal(scan.body.Count, 2);
  });

  it('TransactWriteItems applies all puts atomically', async () => {
    await ddb('TransactWriteItems', {
      TransactItems: [
        { Put: { TableName: 'b', Item: { id: { S: 'tx1' } } } },
        { Put: { TableName: 'b', Item: { id: { S: 'tx2' } } } },
      ],
    });
    const scan = await ddb('Scan', { TableName: 'b' });
    assert.equal(scan.body.Count, 2);
  });
});

describe('ConditionExpression on writes', () => {
  beforeEach(async () => {
    await ddb('CreateTable', { TableName: 'c', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] });
  });

  it('attribute_not_exists guards idempotent insert', async () => {
    const first = await ddb('PutItem', {
      TableName: 'c',
      Item: { id: { S: 'k1' }, v: { N: '1' } },
      ConditionExpression: 'attribute_not_exists(id)',
    });
    assert.equal(first.status, 200);
    const dup = await ddb('PutItem', {
      TableName: 'c',
      Item: { id: { S: 'k1' }, v: { N: '2' } },
      ConditionExpression: 'attribute_not_exists(id)',
    });
    assert.equal(dup.status, 400);
    assert.equal(dup.body.__type, 'ConditionalCheckFailedException');
    assert.equal(dup.body.message, 'The conditional request failed');
    const got = await ddb('GetItem', { TableName: 'c', Key: { id: { S: 'k1' } } });
    assert.equal(got.body.Item.v.N, '1'); // first write preserved
  });

  it('optimistic lock #v = :expected — pass then fail', async () => {
    await ddb('PutItem', { TableName: 'c', Item: { id: { S: 'lock' }, version: { N: '1' } } });
    const ok = await ddb('PutItem', {
      TableName: 'c',
      Item: { id: { S: 'lock' }, version: { N: '2' } },
      ConditionExpression: '#v = :exp',
      ExpressionAttributeNames:  { '#v': 'version' },
      ExpressionAttributeValues: { ':exp': { N: '1' } },
    });
    assert.equal(ok.status, 200);
    const stale = await ddb('PutItem', {
      TableName: 'c',
      Item: { id: { S: 'lock' }, version: { N: '3' } },
      ConditionExpression: '#v = :exp',
      ExpressionAttributeNames:  { '#v': 'version' },
      ExpressionAttributeValues: { ':exp': { N: '1' } }, // stale
    });
    assert.equal(stale.status, 400);
    assert.equal(stale.body.__type, 'ConditionalCheckFailedException');
  });

  it('begins_with / contains / attribute_type / size comparisons', async () => {
    await ddb('PutItem', { TableName: 'c', Item: { id: { S: 'x' }, name: { S: 'mockcloud' }, tags: { L: [{ S: 'a' }, { S: 'b' }] } } });

    const okBeg = await ddb('DeleteItem', {
      TableName: 'c', Key: { id: { S: 'x' } },
      ConditionExpression: 'begins_with(#n, :p)',
      ExpressionAttributeNames:  { '#n': 'name' },
      ExpressionAttributeValues: { ':p': { S: 'mock' } },
    });
    assert.equal(okBeg.status, 200);

    await ddb('PutItem', { TableName: 'c', Item: { id: { S: 'y' }, name: { S: 'mockcloud' }, tags: { L: [{ S: 'a' }, { S: 'b' }] } } });
    const badBeg = await ddb('DeleteItem', {
      TableName: 'c', Key: { id: { S: 'y' } },
      ConditionExpression: 'begins_with(#n, :p)',
      ExpressionAttributeNames:  { '#n': 'name' },
      ExpressionAttributeValues: { ':p': { S: 'zzz' } },
    });
    assert.equal(badBeg.status, 400);

    const okContains = await ddb('PutItem', {
      TableName: 'c', Item: { id: { S: 'y' }, name: { S: 'mockcloud' } },
      ConditionExpression: 'contains(#n, :s)',
      ExpressionAttributeNames:  { '#n': 'name' },
      ExpressionAttributeValues: { ':s': { S: 'cloud' } },
    });
    assert.equal(okContains.status, 200);

    const okType = await ddb('PutItem', {
      TableName: 'c', Item: { id: { S: 'y' }, name: { S: 'mockcloud' } },
      ConditionExpression: 'attribute_type(#n, :t)',
      ExpressionAttributeNames:  { '#n': 'name' },
      ExpressionAttributeValues: { ':t': { S: 'S' } },
    });
    assert.equal(okType.status, 200);

    const okSize = await ddb('PutItem', {
      TableName: 'c', Item: { id: { S: 'y' }, name: { S: 'mockcloud' } },
      ConditionExpression: 'size(#n) > :n',
      ExpressionAttributeNames:  { '#n': 'name' },
      ExpressionAttributeValues: { ':n': { N: '3' } },
    });
    assert.equal(okSize.status, 200);

    const badSize = await ddb('PutItem', {
      TableName: 'c', Item: { id: { S: 'y' }, name: { S: 'mockcloud' } },
      ConditionExpression: 'size(#n) > :n',
      ExpressionAttributeNames:  { '#n': 'name' },
      ExpressionAttributeValues: { ':n': { N: '999' } },
    });
    assert.equal(badSize.status, 400);
  });

  it('BETWEEN and IN', async () => {
    await ddb('PutItem', { TableName: 'c', Item: { id: { S: 'r' }, age: { N: '30' }, color: { S: 'red' } } });
    const okBetween = await ddb('PutItem', {
      TableName: 'c', Item: { id: { S: 'r' }, age: { N: '31' }, color: { S: 'red' } },
      ConditionExpression: 'age BETWEEN :lo AND :hi',
      ExpressionAttributeValues: { ':lo': { N: '20' }, ':hi': { N: '40' } },
    });
    assert.equal(okBetween.status, 200);

    const failBetween = await ddb('PutItem', {
      TableName: 'c', Item: { id: { S: 'r' }, age: { N: '32' }, color: { S: 'red' } },
      ConditionExpression: 'age BETWEEN :lo AND :hi',
      ExpressionAttributeValues: { ':lo': { N: '100' }, ':hi': { N: '200' } },
    });
    assert.equal(failBetween.status, 400);

    const okIn = await ddb('PutItem', {
      TableName: 'c', Item: { id: { S: 'r' }, age: { N: '33' }, color: { S: 'blue' } },
      ConditionExpression: 'color IN (:a, :b, :c)',
      ExpressionAttributeValues: { ':a': { S: 'red' }, ':b': { S: 'green' }, ':c': { S: 'blue' } },
    });
    assert.equal(okIn.status, 200);

    const failIn = await ddb('PutItem', {
      TableName: 'c', Item: { id: { S: 'r' }, age: { N: '34' }, color: { S: 'blue' } },
      ConditionExpression: 'color IN (:a, :b)',
      ExpressionAttributeValues: { ':a': { S: 'pink' }, ':b': { S: 'green' } },
    });
    assert.equal(failIn.status, 400);
  });

  it('nested-path and list-index conditions', async () => {
    await ddb('PutItem', {
      TableName: 'c',
      Item: {
        id:   { S: 'n' },
        meta: { M: { author: { S: 'pranjal' }, tags: { L: [{ S: 'one' }, { S: 'two' }] } } },
      },
    });
    const okNested = await ddb('PutItem', {
      TableName: 'c',
      Item: { id: { S: 'n' }, meta: { M: { author: { S: 'pranjal' } } } },
      ConditionExpression: 'meta.author = :a',
      ExpressionAttributeValues: { ':a': { S: 'pranjal' } },
    });
    assert.equal(okNested.status, 200);

    // re-seed since the prior put overwrote the nested structure
    await ddb('PutItem', {
      TableName: 'c',
      Item: {
        id:   { S: 'n' },
        meta: { M: { author: { S: 'pranjal' }, tags: { L: [{ S: 'one' }, { S: 'two' }] } } },
      },
    });
    const okIndex = await ddb('PutItem', {
      TableName: 'c',
      Item: { id: { S: 'n' }, meta: { M: { author: { S: 'x' } } } },
      ConditionExpression: 'meta.tags[1] = :t',
      ExpressionAttributeValues: { ':t': { S: 'two' } },
    });
    assert.equal(okIndex.status, 200);
  });

  it('AND / OR / NOT precedence and parentheses', async () => {
    await ddb('PutItem', { TableName: 'c', Item: { id: { S: 'p' }, a: { N: '1' }, b: { N: '2' }, c: { N: '3' } } });

    // Without parens, AND binds tighter than OR:
    //   a = :a OR b = :wrong AND c = :wrong  → true OR (false AND false) → true
    const okPrec = await ddb('PutItem', {
      TableName: 'c', Item: { id: { S: 'p' }, a: { N: '1' }, b: { N: '2' }, c: { N: '3' } },
      ConditionExpression: 'a = :a OR b = :w AND c = :w',
      ExpressionAttributeValues: { ':a': { N: '1' }, ':w': { N: '99' } },
    });
    assert.equal(okPrec.status, 200);

    // With parens forcing OR first:
    //   (a = :wrong OR b = :b) AND c = :wrong → (false OR true) AND false → false
    const failParens = await ddb('PutItem', {
      TableName: 'c', Item: { id: { S: 'p' }, a: { N: '1' }, b: { N: '2' }, c: { N: '3' } },
      ConditionExpression: '(a = :w OR b = :b) AND c = :w',
      ExpressionAttributeValues: { ':b': { N: '2' }, ':w': { N: '99' } },
    });
    assert.equal(failParens.status, 400);

    // NOT
    const okNot = await ddb('PutItem', {
      TableName: 'c', Item: { id: { S: 'p' }, a: { N: '1' }, b: { N: '2' }, c: { N: '3' } },
      ConditionExpression: 'NOT a = :w',
      ExpressionAttributeValues: { ':w': { N: '99' } },
    });
    assert.equal(okNot.status, 200);
  });

  it('ReturnValuesOnConditionCheckFailure=ALL_OLD returns the existing item on failure', async () => {
    await ddb('PutItem', { TableName: 'c', Item: { id: { S: 'rv' }, version: { N: '1' }, name: { S: 'orig' } } });
    const fail = await ddb('PutItem', {
      TableName: 'c',
      Item: { id: { S: 'rv' }, version: { N: '2' } },
      ConditionExpression: 'version = :wrong',
      ExpressionAttributeValues: { ':wrong': { N: '99' } },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
    assert.equal(fail.status, 400);
    assert.equal(fail.body.__type, 'ConditionalCheckFailedException');
    assert.ok(fail.body.Item, 'expected Item in failure body');
    assert.equal(fail.body.Item.name.S, 'orig');
    assert.equal(fail.body.Item.version.N, '1');
  });

  it('missing-attribute comparisons evaluate to false', async () => {
    await ddb('PutItem', { TableName: 'c', Item: { id: { S: 'm' } } });
    // No "missing" attribute on the item; comparison should be false → condition fails.
    const fail = await ddb('PutItem', {
      TableName: 'c', Item: { id: { S: 'm' }, x: { N: '1' } },
      ConditionExpression: 'missing = :v',
      ExpressionAttributeValues: { ':v': { S: 'whatever' } },
    });
    assert.equal(fail.status, 400);
    // attribute_not_exists on a missing attribute is true.
    const ok = await ddb('PutItem', {
      TableName: 'c', Item: { id: { S: 'm' }, x: { N: '1' } },
      ConditionExpression: 'attribute_not_exists(missing)',
    });
    assert.equal(ok.status, 200);
  });

  it('TransactWriteItems: partial failure rolls back everything with ordered CancellationReasons', async () => {
    await ddb('CreateTable', { TableName: 'tx', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] });
    await ddb('PutItem', { TableName: 'tx', Item: { id: { S: 'exists' }, v: { N: '1' } } });
    await ddb('PutItem', { TableName: 'tx', Item: { id: { S: 'other' }, v: { N: '7' } } });

    const res = await ddb('TransactWriteItems', {
      TransactItems: [
        // [0] would succeed in isolation
        { Put: { TableName: 'tx', Item: { id: { S: 'new1' } },
                 ConditionExpression: 'attribute_not_exists(id)' } },
        // [1] FAILS: id already exists
        { Put: { TableName: 'tx', Item: { id: { S: 'exists' }, v: { N: '99' } },
                 ConditionExpression: 'attribute_not_exists(id)',
                 ReturnValuesOnConditionCheckFailure: 'ALL_OLD' } },
        // [2] would succeed — distinct key so we exercise rollback, not dup-key rejection
        { Delete: { TableName: 'tx', Key: { id: { S: 'other' } } } },
      ],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.__type, 'TransactionCanceledException');
    assert.equal(res.body.CancellationReasons.length, 3);
    assert.equal(res.body.CancellationReasons[0].Code, 'None');
    assert.equal(res.body.CancellationReasons[1].Code, 'ConditionalCheckFailed');
    assert.equal(res.body.CancellationReasons[1].Item.v.N, '1');
    assert.equal(res.body.CancellationReasons[2].Code, 'None');

    // Nothing should have been applied — both seeded items still present, no new1:
    const scan = await ddb('Scan', { TableName: 'tx' });
    assert.equal(scan.body.Count, 2);
    const ids = scan.body.Items.map(i => i.id.S).sort();
    assert.deepEqual(ids, ['exists', 'other']);
  });

  it('whitespace-only ConditionExpression → ValidationException, not parse error', async () => {
    const res = await ddb('PutItem', {
      TableName: 'c', Item: { id: { S: 'ws' } }, ConditionExpression: '   ',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.__type, 'ValidationException');
    assert.match(res.body.message, /cannot be empty/);
  });

  it('PutItem rejects an Item missing the partition key attribute', async () => {
    const res = await ddb('PutItem', { TableName: 'c', Item: { other: { S: 'x' } } });
    assert.equal(res.status, 400);
    assert.equal(res.body.__type, 'ValidationException');
    assert.match(res.body.message, /Missing the key id/);
    const scan = await ddb('Scan', { TableName: 'c' });
    assert.equal(scan.body.Count, 0, 'must not have inserted the malformed item');
  });

  it('PutItem on a pk+sk table rejects an Item missing the sort key', async () => {
    await ddb('CreateTable', { TableName: 'pksk', KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ] });
    const res = await ddb('PutItem', { TableName: 'pksk', Item: { pk: { S: 'a' } } });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Missing the key sk/);
  });

  it('DeleteItem rejects a Key missing the sort key', async () => {
    await ddb('CreateTable', { TableName: 'pksk2', KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ] });
    const res = await ddb('DeleteItem', { TableName: 'pksk2', Key: { pk: { S: 'a' } } });
    assert.equal(res.status, 400);
    assert.equal(res.body.__type, 'ValidationException');
    assert.match(res.body.message, /missing sk/);
  });

  it('UpdateItem rejects a Key missing the sort key', async () => {
    await ddb('CreateTable', { TableName: 'pksk3', KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ] });
    const res = await ddb('UpdateItem', {
      TableName: 'pksk3', Key: { pk: { S: 'a' } },
      UpdateExpression: 'SET v = :v', ExpressionAttributeValues: { ':v': { N: '1' } },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /missing sk/);
  });

  it('TransactWriteItems: empty TransactItems is a ValidationException', async () => {
    const res = await ddb('TransactWriteItems', { TransactItems: [] });
    assert.equal(res.status, 400);
    assert.equal(res.body.__type, 'ValidationException');
    assert.match(res.body.message, /length between 1 and 100/);
  });

  it('TransactWriteItems: malformed action shape rejected', async () => {
    const res = await ddb('TransactWriteItems', { TransactItems: [{}] });
    assert.equal(res.status, 400);
    assert.equal(res.body.__type, 'ValidationException');
    assert.match(res.body.message, /exactly one of Put/);
  });

  it('TransactWriteItems: nonexistent table is ResourceNotFoundException', async () => {
    const res = await ddb('TransactWriteItems', {
      TransactItems: [{ Put: { TableName: 'no-such', Item: { id: { S: 'x' } } } }],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.__type, 'ResourceNotFoundException');
  });

  it('TransactWriteItems: two operations on the same (table,key) are rejected', async () => {
    await ddb('CreateTable', { TableName: 'tdup', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] });
    const res = await ddb('TransactWriteItems', {
      TransactItems: [
        { Put:    { TableName: 'tdup', Item: { id: { S: 'k' }, v: { N: '1' } } } },
        { Delete: { TableName: 'tdup', Key:  { id: { S: 'k' } } } },
      ],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.__type, 'ValidationException');
    assert.match(res.body.message, /multiple operations on one item/);
    // Neither op should have applied:
    const scan = await ddb('Scan', { TableName: 'tdup' });
    assert.equal(scan.body.Count, 0);
  });

  it('TransactWriteItems: ConditionCheck participates in atomic precheck', async () => {
    await ddb('CreateTable', { TableName: 'tx2', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] });
    await ddb('PutItem', { TableName: 'tx2', Item: { id: { S: 'guard' }, ok: { BOOL: false } } });

    const res = await ddb('TransactWriteItems', {
      TransactItems: [
        { ConditionCheck: { TableName: 'tx2', Key: { id: { S: 'guard' } },
                            ConditionExpression: 'ok = :t',
                            ExpressionAttributeValues: { ':t': { BOOL: true } } } },
        { Put: { TableName: 'tx2', Item: { id: { S: 'should-not-land' } } } },
      ],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.CancellationReasons[0].Code, 'ConditionalCheckFailed');
    assert.equal(res.body.CancellationReasons[1].Code, 'None');

    const got = await ddb('GetItem', { TableName: 'tx2', Key: { id: { S: 'should-not-land' } } });
    assert.equal(got.body.Item, undefined);
  });
});

describe('UI control plane: items', () => {
  beforeEach(async () => {
    await rest('POST', '/mockcloud/dynamodb/tables', { name: 'ui', pk: 'id' });
  });

  it('creates an item via the UI route and reflects it in the table', async () => {
    const put = await rest('POST', '/mockcloud/dynamodb/tables/ui/items', { id: 'u1', name: 'Ada', age: 36 });
    assert.equal(put.status, 200);
    const t = await rest('GET', '/mockcloud/dynamodb/tables/ui');
    assert.equal(t.body.itemCount, 1);
    assert.equal(t.body.items[0].name, 'Ada');
  });

  it('rejects an item missing the partition key', async () => {
    const put = await rest('POST', '/mockcloud/dynamodb/tables/ui/items', { name: 'no-pk' });
    assert.equal(put.status, 400);
    assert.match(put.body.message, /partition key/i);
  });

  it('requires the sort key when the table has one', async () => {
    await rest('POST', '/mockcloud/dynamodb/tables', { name: 'ui2', pk: 'pk', sk: 'sk' });
    const bad = await rest('POST', '/mockcloud/dynamodb/tables/ui2/items', { pk: 'a' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /sort key/i);
    const ok = await rest('POST', '/mockcloud/dynamodb/tables/ui2/items', { pk: 'a', sk: 'b' });
    assert.equal(ok.status, 200);
  });

  it('deletes an item by partition key', async () => {
    await rest('POST', '/mockcloud/dynamodb/tables/ui/items', { id: 'gone' });
    const del = await rest('DELETE', '/mockcloud/dynamodb/tables/ui/items/gone');
    assert.equal(del.status, 200);
    const t = await rest('GET', '/mockcloud/dynamodb/tables/ui');
    assert.equal(t.body.itemCount, 0);
  });
});

describe('UI control plane: secondary indexes', () => {
  beforeEach(async () => {
    await rest('POST', '/mockcloud/dynamodb/tables', { name: 'idx', pk: 'id' });
  });

  it('creates, lists, and deletes an index', async () => {
    const create = await rest('POST', '/mockcloud/dynamodb/tables/idx/indexes', {
      name: 'by-status', type: 'GSI', pk: 'status', sk: 'created_at', projection: 'ALL',
    });
    assert.equal(create.status, 201);
    assert.equal(create.body.type, 'GSI');

    const t = await rest('GET', '/mockcloud/dynamodb/tables/idx');
    assert.equal(t.body.indexes.length, 1);
    assert.equal(t.body.indexes[0].name, 'by-status');
    assert.equal(t.body.indexes[0].pk, 'status');

    const del = await rest('DELETE', '/mockcloud/dynamodb/tables/idx/indexes/by-status');
    assert.equal(del.status, 200);
    const t2 = await rest('GET', '/mockcloud/dynamodb/tables/idx');
    assert.equal(t2.body.indexes.length, 0);
  });

  it('rejects a duplicate index name', async () => {
    const body = { name: 'dup', pk: 'k' };
    await rest('POST', '/mockcloud/dynamodb/tables/idx/indexes', body);
    const dup = await rest('POST', '/mockcloud/dynamodb/tables/idx/indexes', body);
    assert.equal(dup.status, 409);
  });

  it('parses GSIs declared on an AWS CreateTable and surfaces them in DescribeTable', async () => {
    await ddb('CreateTable', {
      TableName: 'gsis',
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [{
        IndexName: 'status-index',
        KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }, { AttributeName: 'ts', KeyType: 'RANGE' }],
        Projection: { ProjectionType: 'KEYS_ONLY' },
      }],
    });
    const desc = await ddb('DescribeTable', { TableName: 'gsis' });
    assert.equal(desc.status, 200);
    assert.equal(desc.body.Table.GlobalSecondaryIndexes.length, 1);
    assert.equal(desc.body.Table.GlobalSecondaryIndexes[0].IndexName, 'status-index');
    assert.equal(desc.body.Table.GlobalSecondaryIndexes[0].Projection.ProjectionType, 'KEYS_ONLY');
    // Also visible through the UI route.
    const t = await rest('GET', '/mockcloud/dynamodb/tables/gsis');
    assert.equal(t.body.indexes[0].name, 'status-index');
    assert.equal(t.body.indexes[0].sk, 'ts');
  });
});

// ── GSI data-plane: querying BY an index + projection-type enforcement ───────
describe('Query against a Global Secondary Index', () => {
  beforeEach(async () => {
    await ddb('CreateTable', {
      TableName: 'orders',
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'status-all',
          KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }, { AttributeName: 'amount', KeyType: 'RANGE' }],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'status-keys',
          KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }, { AttributeName: 'amount', KeyType: 'RANGE' }],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        },
        {
          IndexName: 'status-incl',
          KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }, { AttributeName: 'amount', KeyType: 'RANGE' }],
          Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['customer'] },
        },
      ],
    });
    const rows = [
      { id: 'o1', status: 'NEW',     amount: 30, customer: 'alice', note: 'x' },
      { id: 'o2', status: 'NEW',     amount: 10, customer: 'bob',   note: 'y' },
      { id: 'o3', status: 'SHIPPED', amount: 99, customer: 'carol', note: 'z' },
    ];
    for (const r of rows) {
      await ddb('PutItem', { TableName: 'orders', Item: {
        id: { S: r.id }, status: { S: r.status }, amount: { N: String(r.amount) },
        customer: { S: r.customer }, note: { S: r.note },
      } });
    }
  });

  it('queries by the index key and sorts on the index sort key', async () => {
    const r = await ddb('Query', {
      TableName: 'orders', IndexName: 'status-all',
      KeyConditionExpression: '#s = :v',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':v': { S: 'NEW' } },
    });
    assert.equal(r.body.Count, 2);
    // Sorted ascending by amount (the index range key): o2 (10) before o1 (30).
    assert.deepEqual(r.body.Items.map(i => i.id.S), ['o2', 'o1']);
  });

  it('only matches items present in the index partition', async () => {
    const r = await ddb('Query', {
      TableName: 'orders', IndexName: 'status-all',
      KeyConditionExpression: '#s = :v AND amount > :min',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':v': { S: 'NEW' }, ':min': { N: '20' } },
    });
    assert.deepEqual(r.body.Items.map(i => i.id.S), ['o1']);
  });

  it('KEYS_ONLY projection returns only table + index keys', async () => {
    const r = await ddb('Query', {
      TableName: 'orders', IndexName: 'status-keys',
      KeyConditionExpression: '#s = :v',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':v': { S: 'NEW' } },
    });
    for (const item of r.body.Items) {
      assert.deepEqual(Object.keys(item).sort(), ['amount', 'id', 'status']);
    }
  });

  it('INCLUDE projection adds the NonKeyAttributes only', async () => {
    const r = await ddb('Query', {
      TableName: 'orders', IndexName: 'status-incl',
      KeyConditionExpression: '#s = :v',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':v': { S: 'SHIPPED' } },
    });
    assert.equal(r.body.Count, 1);
    assert.deepEqual(Object.keys(r.body.Items[0]).sort(), ['amount', 'customer', 'id', 'status']);
    assert.equal(r.body.Items[0].note, undefined);   // 'note' is not projected
  });

  it('an explicit ProjectionExpression overrides the index projection', async () => {
    const r = await ddb('Query', {
      TableName: 'orders', IndexName: 'status-keys',
      KeyConditionExpression: '#s = :v',
      ProjectionExpression: 'customer',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':v': { S: 'NEW' } },
    });
    for (const item of r.body.Items) {
      assert.deepEqual(Object.keys(item), ['customer']);
    }
  });

  it('DescribeTable surfaces INCLUDE NonKeyAttributes', async () => {
    const d = await ddb('DescribeTable', { TableName: 'orders' });
    const incl = d.body.Table.GlobalSecondaryIndexes.find(g => g.IndexName === 'status-incl');
    assert.deepEqual(incl.Projection.NonKeyAttributes, ['customer']);
  });
});

// ── UI control plane: query runner + INCLUDE index NonKeyAttributes ─────────
describe('UI control plane: query runner', () => {
  beforeEach(async () => {
    await rest('POST', '/mockcloud/dynamodb/tables', { name: 'shop', pk: 'pk', sk: 'sk' });
    const rows = [
      { pk: 'u1', sk: 'order#1', amount: 10, status: 'NEW' },
      { pk: 'u1', sk: 'order#2', amount: 50, status: 'PAID' },
      { pk: 'u2', sk: 'order#1', amount: 5,  status: 'NEW' },
    ];
    for (const r of rows) await rest('POST', '/mockcloud/dynamodb/tables/shop/items', r);
  });

  it('runs a key-condition query and returns plain-JSON rows', async () => {
    const r = await rest('POST', '/mockcloud/dynamodb/tables/shop/query', {
      keyConditionExpression: 'pk = :p',
      expressionAttributeValues: { ':p': 'u1' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.count, 2);
    assert.equal(r.body.scannedCount, 2);
    assert.deepEqual(r.body.items.map(i => i.sk).sort(), ['order#1', 'order#2']);
  });

  it('applies a filter expression and attribute names', async () => {
    const r = await rest('POST', '/mockcloud/dynamodb/tables/shop/query', {
      keyConditionExpression: 'pk = :p',
      filterExpression: '#s = :st',
      expressionAttributeNames: { '#s': 'status' },
      expressionAttributeValues: { ':p': 'u1', ':st': 'NEW' },
    });
    assert.equal(r.body.count, 1);
    assert.equal(r.body.items[0].sk, 'order#1');
  });

  it('honors limit + descending sort and reports lastEvaluatedKey', async () => {
    const r = await rest('POST', '/mockcloud/dynamodb/tables/shop/query', {
      keyConditionExpression: 'pk = :p',
      expressionAttributeValues: { ':p': 'u1' },
      limit: 1, scanIndexForward: false,
    });
    assert.equal(r.body.count, 1);
    assert.equal(r.body.items[0].sk, 'order#2');     // highest sort key first
    assert.ok(r.body.lastEvaluatedKey, 'pagination token present');
    assert.equal(r.body.lastEvaluatedKey.sk, 'order#2');
  });

  it('surfaces a bad expression as a 400', async () => {
    const r = await rest('POST', '/mockcloud/dynamodb/tables/shop/query', {
      keyConditionExpression: 'pk = = :p',
      expressionAttributeValues: { ':p': 'u1' },
    });
    assert.equal(r.status, 400);
  });

  it('UI-created INCLUDE index persists nonKeyAttributes and enforces projection', async () => {
    await rest('POST', '/mockcloud/dynamodb/tables/shop/indexes', {
      name: 'by-status', type: 'GSI', pk: 'status', sk: 'sk',
      projection: 'INCLUDE', nonKeyAttributes: ['amount'],
    });
    const t = await rest('GET', '/mockcloud/dynamodb/tables/shop');
    assert.deepEqual(t.body.indexes[0].nonKeyAttributes, ['amount']);

    // Querying the index returns only table keys + index keys + amount.
    const r = await rest('POST', '/mockcloud/dynamodb/tables/shop/query', {
      indexName: 'by-status',
      keyConditionExpression: 'status = :s',
      expressionAttributeValues: { ':s': 'NEW' },
    });
    assert.equal(r.body.count, 2);
    for (const item of r.body.items) {
      assert.deepEqual(Object.keys(item).sort(), ['amount', 'pk', 'sk', 'status']);
    }
  });
});

describe('Per-table metrics (real, activity-driven)', () => {
  beforeEach(async () => {
    await ddb('CreateTable', { TableName: 'mt', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] });
  });

  it('accumulates read/write ops and consumed capacity from real traffic', async () => {
    await ddb('PutItem', { TableName: 'mt', Item: { id: { S: 'a' } } });
    await ddb('PutItem', { TableName: 'mt', Item: { id: { S: 'b' } } });
    await ddb('GetItem', { TableName: 'mt', Key: { id: { S: 'a' } } });
    await ddb('Scan',    { TableName: 'mt' });

    const m = await rest('GET', '/mockcloud/dynamodb/tables/mt/metrics');
    assert.equal(m.status, 200);
    assert.equal(m.body.writes, 2);                 // two PutItem
    assert.equal(m.body.reads, 2);                  // GetItem + Scan
    assert.equal(m.body.consumedWrite, 2);          // 1 WCU each
    assert.ok(m.body.consumedRead >= 2, 'consumed read capacity recorded');
    assert.ok(m.body.avgLatency > 0, 'latency recorded');
    // Activity-driven time series populated (one point per op).
    assert.equal(m.body.writeCapacity.length, 2);
    assert.equal(m.body.readCapacity.length, 2);
    assert.equal(m.body.latency.length, 4);
  });

  it('starts at zero for a fresh table', async () => {
    const m = await rest('GET', '/mockcloud/dynamodb/tables/mt/metrics');
    assert.equal(m.body.reads, 0);
    assert.equal(m.body.writes, 0);
    assert.equal(m.body.readCapacity.length, 0);
  });

  it('counts UI-route item writes too', async () => {
    await rest('POST', '/mockcloud/dynamodb/tables/mt/items', { id: 'viaUi' });
    const m = await rest('GET', '/mockcloud/dynamodb/tables/mt/metrics');
    assert.equal(m.body.writes, 1);
    assert.equal(m.body.consumedWrite, 1);
  });
});

// ── Phase 1: Query / Scan / Projection correctness ─────────────────────────
describe('Query with KeyConditionExpression', () => {
  beforeEach(async () => {
    await ddb('CreateTable', {
      TableName: 'kc',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    });
    const items = [
      { pk: 'u1', sk: 'order#001', amount: 10, status: 'NEW' },
      { pk: 'u1', sk: 'order#002', amount: 20, status: 'SHIPPED' },
      { pk: 'u1', sk: 'order#003', amount: 30, status: 'NEW' },
      { pk: 'u1', sk: 'invoice#1', amount: 99, status: 'PAID' },
      { pk: 'u2', sk: 'order#001', amount: 5,  status: 'NEW' },
    ];
    for (const it of items) {
      await ddb('PutItem', {
        TableName: 'kc',
        Item: {
          pk: { S: it.pk }, sk: { S: it.sk },
          amount: { N: String(it.amount) }, status: { S: it.status },
        },
      });
    }
  });

  it('filters by partition key only', async () => {
    const r = await ddb('Query', {
      TableName: 'kc',
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': { S: 'u1' } },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.Count, 4);
    assert.ok(r.body.Items.every(i => i.pk.S === 'u1'));
  });

  it('honors a sort-key comparator', async () => {
    const r = await ddb('Query', {
      TableName: 'kc',
      KeyConditionExpression: 'pk = :p AND sk > :s',
      ExpressionAttributeValues: { ':p': { S: 'u1' }, ':s': { S: 'order#001' } },
    });
    // order#002, order#003 (invoice#1 < order#* lexically, excluded)
    assert.equal(r.body.Count, 2);
    assert.deepEqual(r.body.Items.map(i => i.sk.S), ['order#002', 'order#003']);
  });

  it('honors BETWEEN on the sort key', async () => {
    const r = await ddb('Query', {
      TableName: 'kc',
      KeyConditionExpression: 'pk = :p AND sk BETWEEN :a AND :b',
      ExpressionAttributeValues: {
        ':p': { S: 'u1' }, ':a': { S: 'order#001' }, ':b': { S: 'order#002' },
      },
    });
    assert.deepEqual(r.body.Items.map(i => i.sk.S), ['order#001', 'order#002']);
  });

  it('honors begins_with on the sort key', async () => {
    const r = await ddb('Query', {
      TableName: 'kc',
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :pre)',
      ExpressionAttributeValues: { ':p': { S: 'u1' }, ':pre': { S: 'order#' } },
    });
    assert.equal(r.body.Count, 3);
  });

  it('ScanIndexForward=false reverses sort order', async () => {
    const r = await ddb('Query', {
      TableName: 'kc',
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :pre)',
      ExpressionAttributeValues: { ':p': { S: 'u1' }, ':pre': { S: 'order#' } },
      ScanIndexForward: false,
    });
    assert.deepEqual(r.body.Items.map(i => i.sk.S), ['order#003', 'order#002', 'order#001']);
  });

  it('applies a FilterExpression after the key condition', async () => {
    const r = await ddb('Query', {
      TableName: 'kc',
      KeyConditionExpression: 'pk = :p',
      FilterExpression: '#s = :st',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':p': { S: 'u1' }, ':st': { S: 'NEW' } },
    });
    assert.equal(r.body.Count, 2);
    assert.equal(r.body.ScannedCount, 4);
  });

  it('Select=COUNT returns only a count', async () => {
    const r = await ddb('Query', {
      TableName: 'kc',
      KeyConditionExpression: 'pk = :p',
      Select: 'COUNT',
      ExpressionAttributeValues: { ':p': { S: 'u1' } },
    });
    assert.equal(r.body.Count, 4);
    assert.equal(r.body.Items, undefined);
  });

  it('ProjectionExpression prunes returned attributes', async () => {
    const r = await ddb('Query', {
      TableName: 'kc',
      KeyConditionExpression: 'pk = :p',
      ProjectionExpression: 'sk, amount',
      ExpressionAttributeValues: { ':p': { S: 'u2' } },
    });
    assert.equal(r.body.Count, 1);
    const item = r.body.Items[0];
    assert.deepEqual(Object.keys(item).sort(), ['amount', 'sk']);
  });
});

describe('Scan with FilterExpression and projection', () => {
  beforeEach(async () => {
    await ddb('CreateTable', { TableName: 'sc', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] });
    for (let i = 1; i <= 5; i++) {
      await ddb('PutItem', {
        TableName: 'sc',
        Item: { id: { S: `i${i}` }, n: { N: String(i) }, even: { BOOL: i % 2 === 0 } },
      });
    }
  });

  it('filters with a numeric comparator', async () => {
    const r = await ddb('Scan', {
      TableName: 'sc',
      FilterExpression: 'n >= :min',
      ExpressionAttributeValues: { ':min': { N: '3' } },
    });
    assert.equal(r.body.Count, 3);
    assert.equal(r.body.ScannedCount, 5);
  });

  it('Select=COUNT on Scan', async () => {
    const r = await ddb('Scan', { TableName: 'sc', Select: 'COUNT' });
    assert.equal(r.body.Count, 5);
    assert.equal(r.body.Items, undefined);
  });

  it('ProjectionExpression on Scan', async () => {
    const r = await ddb('Scan', { TableName: 'sc', ProjectionExpression: 'id' });
    assert.ok(r.body.Items.every(i => Object.keys(i).length === 1 && i.id));
  });
});

// ── Phase 1: UpdateItem engine + ReturnValues ──────────────────────────────
describe('UpdateItem expression engine', () => {
  beforeEach(async () => {
    await ddb('CreateTable', { TableName: 'up', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] });
    await ddb('PutItem', {
      TableName: 'up',
      Item: { id: { S: 'x' }, count: { N: '10' }, tags: { L: [{ S: 'a' }] } },
    });
  });

  const get = async () =>
    (await ddb('GetItem', { TableName: 'up', Key: { id: { S: 'x' } } })).body.Item;

  it('SET arithmetic (a = a + :n)', async () => {
    await ddb('UpdateItem', {
      TableName: 'up', Key: { id: { S: 'x' } },
      UpdateExpression: 'SET #c = #c + :n',
      ExpressionAttributeNames: { '#c': 'count' },
      ExpressionAttributeValues: { ':n': { N: '5' } },
    });
    assert.equal((await get()).count.N, '15');
  });

  it('SET list_append', async () => {
    await ddb('UpdateItem', {
      TableName: 'up', Key: { id: { S: 'x' } },
      UpdateExpression: 'SET tags = list_append(tags, :more)',
      ExpressionAttributeValues: { ':more': { L: [{ S: 'b' }] } },
    });
    assert.deepEqual((await get()).tags.L.map(x => x.S), ['a', 'b']);
  });

  it('SET if_not_exists keeps the existing value', async () => {
    await ddb('UpdateItem', {
      TableName: 'up', Key: { id: { S: 'x' } },
      UpdateExpression: 'SET #c = if_not_exists(#c, :z)',
      ExpressionAttributeNames: { '#c': 'count' },
      ExpressionAttributeValues: { ':z': { N: '0' } },
    });
    assert.equal((await get()).count.N, '10');
  });

  it('REMOVE drops an attribute', async () => {
    await ddb('UpdateItem', {
      TableName: 'up', Key: { id: { S: 'x' } },
      UpdateExpression: 'REMOVE tags',
    });
    assert.equal((await get()).tags, undefined);
  });

  it('ADD increments a number', async () => {
    await ddb('UpdateItem', {
      TableName: 'up', Key: { id: { S: 'x' } },
      UpdateExpression: 'ADD #c :n',
      ExpressionAttributeNames: { '#c': 'count' },
      ExpressionAttributeValues: { ':n': { N: '3' } },
    });
    assert.equal((await get()).count.N, '13');
  });

  it('ADD unions a string set, DELETE removes from it', async () => {
    await ddb('UpdateItem', {
      TableName: 'up', Key: { id: { S: 'x' } },
      UpdateExpression: 'ADD colors :c',
      ExpressionAttributeValues: { ':c': { SS: ['red', 'green'] } },
    });
    let item = await get();
    assert.deepEqual([...item.colors.L.map(x => x.S)].sort(), ['green', 'red']);

    await ddb('UpdateItem', {
      TableName: 'up', Key: { id: { S: 'x' } },
      UpdateExpression: 'DELETE colors :c',
      ExpressionAttributeValues: { ':c': { SS: ['red'] } },
    });
    item = await get();
    assert.deepEqual(item.colors.L.map(x => x.S), ['green']);
  });

  it('ReturnValues=UPDATED_NEW returns only changed attrs', async () => {
    const r = await ddb('UpdateItem', {
      TableName: 'up', Key: { id: { S: 'x' } },
      UpdateExpression: 'SET #c = :v',
      ExpressionAttributeNames: { '#c': 'count' },
      ExpressionAttributeValues: { ':v': { N: '42' } },
      ReturnValues: 'UPDATED_NEW',
    });
    assert.deepEqual(Object.keys(r.body.Attributes), ['count']);
    assert.equal(r.body.Attributes.count.N, '42');
  });

  it('ReturnValues=ALL_OLD on UpdateItem', async () => {
    const r = await ddb('UpdateItem', {
      TableName: 'up', Key: { id: { S: 'x' } },
      UpdateExpression: 'SET #c = :v',
      ExpressionAttributeNames: { '#c': 'count' },
      ExpressionAttributeValues: { ':v': { N: '1' } },
      ReturnValues: 'ALL_OLD',
    });
    assert.equal(r.body.Attributes.count.N, '10');
  });

  it('ReturnValues=ALL_OLD on PutItem returns overwritten image', async () => {
    const r = await ddb('PutItem', {
      TableName: 'up',
      Item: { id: { S: 'x' }, count: { N: '99' } },
      ReturnValues: 'ALL_OLD',
    });
    assert.equal(r.body.Attributes.count.N, '10');
  });

  it('ReturnValues=ALL_OLD on DeleteItem', async () => {
    const r = await ddb('DeleteItem', {
      TableName: 'up', Key: { id: { S: 'x' } }, ReturnValues: 'ALL_OLD',
    });
    assert.equal(r.body.Attributes.count.N, '10');
  });
});

// ── Phase 2: Pagination ─────────────────────────────────────────────────────
describe('Pagination (LastEvaluatedKey / ExclusiveStartKey)', () => {
  beforeEach(async () => {
    await ddb('CreateTable', {
      TableName: 'pg',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    });
    for (let i = 0; i < 10; i++) {
      await ddb('PutItem', {
        TableName: 'pg',
        Item: { pk: { S: 'p' }, sk: { S: `s${String(i).padStart(2, '0')}` } },
      });
    }
  });

  it('paginates a Query across pages with no dupes', async () => {
    const seen = [];
    let startKey;
    let pages = 0;
    do {
      const r = await ddb('Query', {
        TableName: 'pg',
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': { S: 'p' } },
        Limit: 3,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      });
      for (const i of r.body.Items) seen.push(i.sk.S);
      startKey = r.body.LastEvaluatedKey;
      pages++;
    } while (startKey && pages < 20);
    assert.equal(seen.length, 10);
    assert.equal(new Set(seen).size, 10);
    assert.deepEqual(seen, seen.slice().sort());
  });

  it('paginates a Scan across pages with no dupes', async () => {
    const seen = new Set();
    let startKey;
    let pages = 0;
    do {
      const r = await ddb('Scan', {
        TableName: 'pg', Limit: 4,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      });
      for (const i of r.body.Items) seen.add(i.sk.S);
      startKey = r.body.LastEvaluatedKey;
      pages++;
    } while (startKey && pages < 20);
    assert.equal(seen.size, 10);
  });
});

// ── Phase 3: Disk persistence ───────────────────────────────────────────────
describe('Disk persistence (survives restart)', () => {
  it('re-hydrates tables and items from disk after an in-memory reset', async () => {
    await ddb('CreateTable', { TableName: 'persist', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] });
    await ddb('PutItem', { TableName: 'persist', Item: { id: { S: 'keep-me' }, v: { N: '1' } } });

    // Force the (debounced) snapshot to disk now.
    persistNow();

    // Simulate a restart: drop all in-memory state, then re-read from disk.
    store.reset();
    assert.equal(store.dynamodb.tables.persist, undefined);
    hydrateFromDisk(true);

    const get = await ddb('GetItem', { TableName: 'persist', Key: { id: { S: 'keep-me' } } });
    assert.equal(get.body.Item.id.S, 'keep-me');
    assert.equal(get.body.Item.v.N, '1');
  });
});

// ── Phase 5: Remaining operations ───────────────────────────────────────────
describe('UpdateTable / TTL / Tags / TransactGetItems', () => {
  beforeEach(async () => {
    await ddb('CreateTable', { TableName: 'ops', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] });
  });

  it('UpdateTable adds a GSI reflected by DescribeTable', async () => {
    await ddb('UpdateTable', {
      TableName: 'ops',
      AttributeDefinitions: [{ AttributeName: 'email', AttributeType: 'S' }],
      GlobalSecondaryIndexUpdates: [{
        Create: {
          IndexName: 'by-email',
          KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      }],
    });
    const d = await ddb('DescribeTable', { TableName: 'ops' });
    const gsis = d.body.Table.GlobalSecondaryIndexes || [];
    assert.equal(gsis.length, 1);
    assert.equal(gsis[0].IndexName, 'by-email');
  });

  it('UpdateTable changes the billing mode', async () => {
    await ddb('UpdateTable', { TableName: 'ops', BillingMode: 'PROVISIONED' });
    const d = await ddb('DescribeTable', { TableName: 'ops' });
    assert.equal(d.body.Table.BillingModeSummary.BillingMode, 'PROVISIONED');
  });

  it('UpdateTimeToLive then DescribeTimeToLive reports ENABLED', async () => {
    await ddb('UpdateTimeToLive', {
      TableName: 'ops',
      TimeToLiveSpecification: { Enabled: true, AttributeName: 'expiresAt' },
    });
    const d = await ddb('DescribeTimeToLive', { TableName: 'ops' });
    assert.equal(d.body.TimeToLiveDescription.TimeToLiveStatus, 'ENABLED');
    assert.equal(d.body.TimeToLiveDescription.AttributeName, 'expiresAt');
  });

  it('expired items are swept on read', async () => {
    await ddb('UpdateTimeToLive', {
      TableName: 'ops',
      TimeToLiveSpecification: { Enabled: true, AttributeName: 'expiresAt' },
    });
    const past = Math.floor(Date.now() / 1000) - 60;
    const future = Math.floor(Date.now() / 1000) + 3600;
    await ddb('PutItem', { TableName: 'ops', Item: { id: { S: 'old' }, expiresAt: { N: String(past) } } });
    await ddb('PutItem', { TableName: 'ops', Item: { id: { S: 'new' }, expiresAt: { N: String(future) } } });

    const gone = await ddb('GetItem', { TableName: 'ops', Key: { id: { S: 'old' } } });
    assert.equal(gone.body.Item, undefined);
    const alive = await ddb('GetItem', { TableName: 'ops', Key: { id: { S: 'new' } } });
    assert.equal(alive.body.Item.id.S, 'new');
  });

  it('TagResource / ListTagsOfResource / UntagResource round-trip', async () => {
    const d = await ddb('DescribeTable', { TableName: 'ops' });
    const arn = d.body.Table.TableArn;
    await ddb('TagResource', { ResourceArn: arn, Tags: [{ Key: 'env', Value: 'dev' }, { Key: 'team', Value: 'core' }] });
    let tags = await ddb('ListTagsOfResource', { ResourceArn: arn });
    assert.equal(tags.body.Tags.length, 2);
    await ddb('UntagResource', { ResourceArn: arn, TagKeys: ['env'] });
    tags = await ddb('ListTagsOfResource', { ResourceArn: arn });
    assert.deepEqual(tags.body.Tags.map(t => t.Key), ['team']);
  });

  it('TransactGetItems returns aligned responses', async () => {
    await ddb('PutItem', { TableName: 'ops', Item: { id: { S: 'a' }, v: { N: '1' } } });
    const r = await ddb('TransactGetItems', {
      TransactItems: [
        { Get: { TableName: 'ops', Key: { id: { S: 'a' } } } },
        { Get: { TableName: 'ops', Key: { id: { S: 'missing' } } } },
      ],
    });
    assert.equal(r.body.Responses.length, 2);
    assert.equal(r.body.Responses[0].Item.v.N, '1');
    assert.deepEqual(r.body.Responses[1], {});
  });
});
