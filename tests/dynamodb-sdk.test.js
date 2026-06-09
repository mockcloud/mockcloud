// tests/dynamodb-sdk.test.js
// Exercises DynamoDB transactions + GSI through the real @aws-sdk/client-dynamodb
// (the exhaustive expression-grammar coverage lives in dynamodb.test.js, which
// hits the wire protocol directly). This locks in real-SDK marshalling.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  CreateTableCommand,
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  TransactGetItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';

let server, dynamo;

beforeAll(async () => {
  server = await startServer();
  ({ dynamo } = makeClients(server.endpoint));
});
afterAll(() => server.close());
beforeEach(() => server.resetStore());

describe('DynamoDB transactions (SDK)', () => {
  beforeEach(() => dynamo.send(new CreateTableCommand({
    TableName: 'accounts',
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
  })));

  it('TransactWriteItems applies every put atomically', async () => {
    await dynamo.send(new TransactWriteItemsCommand({
      TransactItems: [
        { Put: { TableName: 'accounts', Item: { id: { S: 'a' }, balance: { N: '100' } } } },
        { Put: { TableName: 'accounts', Item: { id: { S: 'b' }, balance: { N: '50' } } } },
      ],
    }));
    const a = await dynamo.send(new GetItemCommand({ TableName: 'accounts', Key: { id: { S: 'a' } } }));
    const b = await dynamo.send(new GetItemCommand({ TableName: 'accounts', Key: { id: { S: 'b' } } }));
    assert.equal(a.Item.balance.N, '100');
    assert.equal(b.Item.balance.N, '50');
  });

  it('a failing ConditionExpression cancels the whole transaction', async () => {
    await dynamo.send(new PutItemCommand({ TableName: 'accounts', Item: { id: { S: 'a' }, balance: { N: '100' } } }));
    await assert.rejects(
      () => dynamo.send(new TransactWriteItemsCommand({
        TransactItems: [
          { Put: { TableName: 'accounts', Item: { id: { S: 'b' }, balance: { N: '1' } } } },
          { Put: { TableName: 'accounts', Item: { id: { S: 'a' }, balance: { N: '999' } }, ConditionExpression: 'attribute_not_exists(id)' } },
        ],
      })),
      err => { assert.equal(err.name, 'TransactionCanceledException'); return true; }
    );
    // Atomic: the sibling put ('b') must not have landed.
    const b = await dynamo.send(new GetItemCommand({ TableName: 'accounts', Key: { id: { S: 'b' } } }));
    assert.equal(b.Item, undefined);
  });

  it('TransactGetItems reads multiple items in order', async () => {
    await dynamo.send(new PutItemCommand({ TableName: 'accounts', Item: { id: { S: 'a' }, balance: { N: '100' } } }));
    await dynamo.send(new PutItemCommand({ TableName: 'accounts', Item: { id: { S: 'b' }, balance: { N: '50' } } }));
    const r = await dynamo.send(new TransactGetItemsCommand({
      TransactItems: [
        { Get: { TableName: 'accounts', Key: { id: { S: 'a' } } } },
        { Get: { TableName: 'accounts', Key: { id: { S: 'b' } } } },
      ],
    }));
    assert.equal(r.Responses.length, 2);
    assert.equal(r.Responses[0].Item.balance.N, '100');
    assert.equal(r.Responses[1].Item.balance.N, '50');
  });
});

describe('DynamoDB GSI (SDK)', () => {
  beforeEach(() => dynamo.send(new CreateTableCommand({
    TableName: 'users',
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' },
      { AttributeName: 'email', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [{
      IndexName: 'email-index',
      KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'KEYS_ONLY' },
    }],
  })));

  it('queries a GSI and returns only the projected (KEYS_ONLY) attributes', async () => {
    await dynamo.send(new PutItemCommand({ TableName: 'users', Item: { id: { S: 'u1' }, email: { S: 'a@x.com' }, name: { S: 'Alice' } } }));
    await dynamo.send(new PutItemCommand({ TableName: 'users', Item: { id: { S: 'u2' }, email: { S: 'b@x.com' }, name: { S: 'Bob' } } }));

    const r = await dynamo.send(new QueryCommand({
      TableName: 'users',
      IndexName: 'email-index',
      KeyConditionExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': { S: 'a@x.com' } },
    }));
    assert.equal(r.Count, 1);
    const item = r.Items[0];
    assert.equal(item.id.S, 'u1');
    assert.equal(item.email.S, 'a@x.com');
    assert.equal(item.name, undefined); // KEYS_ONLY excludes non-key attributes
  });

  it('querying a nonexistent index raises ValidationException', async () => {
    await assert.rejects(
      () => dynamo.send(new QueryCommand({
        TableName: 'users',
        IndexName: 'nope-index',
        KeyConditionExpression: 'email = :e',
        ExpressionAttributeValues: { ':e': { S: 'a@x.com' } },
      })),
      err => { assert.equal(err.name, 'ValidationException'); return true; }
    );
  });
});
