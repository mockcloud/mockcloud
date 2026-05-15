// tests/dynamodb.test.js
// Exercises the DynamoDB JSON protocol (DynamoDB_20120810.*) directly so the
// test doesn't depend on a separately-installed @aws-sdk/client-dynamodb.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { awsJson } from './helpers/http.js';

let server;
const ddb = (op, payload) => awsJson(server.endpoint, `DynamoDB_20120810.${op}`, payload);

before(async () => { server = await startServer(); });
after(() => server.close());
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
