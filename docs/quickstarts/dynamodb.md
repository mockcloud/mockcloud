# DynamoDB Quickstart

MockCloud emulates Amazon DynamoDB locally over the real DynamoDB JSON wire
protocol, so a standard AWS SDK, the AWS CLI, or Terraform can talk to it with
nothing more than an endpoint override. It supports the table control plane,
the full item data plane (`PutItem` / `GetItem` / `UpdateItem` / `DeleteItem`),
correct `Query` and `Scan` semantics (key conditions, filters, projections,
pagination), `ConditionExpression` and `UpdateExpression` grammars, batch and
transactional ops, secondary indexes, TTL, and tags. **Your tables and items
are written to disk, so they survive a restart.**

---

## 1. Start MockCloud

```bash
git clone https://github.com/mockcloud/mockcloud
cd mockcloud
npm install
npm --prefix ui install && npm run ui:build   # build the console UI
npm start
```

```
AWS API  →  http://127.0.0.1:4566
Console  →  http://127.0.0.1:4567
```

(Docker works too — `docker build -t mockcloud . && docker run -p 4566:4566 -p 4567:4567 mockcloud`.)

---

## 2. Connect

By default MockCloud performs **no** credential or SigV4 validation — any dummy
values are accepted. The only thing that matters is the `endpoint` override
pointing at `http://127.0.0.1:4566`. (Validation can be opted into with
`MOCKCLOUD_VERIFY_SIGV4=true` and `MOCKCLOUD_IAM=soft|strict` — see the main
README's env-var table.)

### AWS CLI

```bash
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
export AWS_ENDPOINT_URL=http://127.0.0.1:4566   # AWS CLI v2

# Older CLIs without AWS_ENDPOINT_URL: pass --endpoint-url http://127.0.0.1:4566 per command.
```

### Node — AWS SDK v3

```js
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({
  endpoint: 'http://127.0.0.1:4566',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

// Optional: the Document client marshals plain JS objects for you.
const doc = DynamoDBDocumentClient.from(client);
```

---

## 3. Walkthrough

### Create a table

A partition key `pk` plus sort key `sk` — the classic single-table layout.

**CLI**

```bash
aws dynamodb create-table \
  --table-name app \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

**SDK**

```js
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';

await client.send(new CreateTableCommand({
  TableName: 'app',
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'sk', AttributeType: 'S' },
  ],
  KeySchema: [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'sk', KeyType: 'RANGE' },
  ],
  BillingMode: 'PAY_PER_REQUEST',
}));
```

### Put items

**CLI**

```bash
aws dynamodb put-item --table-name app \
  --item '{"pk":{"S":"user#1"},"sk":{"S":"order#001"},"amount":{"N":"42"},"status":{"S":"NEW"}}'
aws dynamodb put-item --table-name app \
  --item '{"pk":{"S":"user#1"},"sk":{"S":"order#002"},"amount":{"N":"17"},"status":{"S":"SHIPPED"}}'
```

**SDK (Document client)**

```js
import { PutCommand } from '@aws-sdk/lib-dynamodb';

await doc.send(new PutCommand({ TableName: 'app',
  Item: { pk: 'user#1', sk: 'order#001', amount: 42, status: 'NEW' } }));
await doc.send(new PutCommand({ TableName: 'app',
  Item: { pk: 'user#1', sk: 'order#002', amount: 17, status: 'SHIPPED' } }));
```

### Query with a KeyConditionExpression

Real key-condition semantics: a partition-key equality plus an optional
sort-key comparator / `BETWEEN` / `begins_with`.

**CLI**

```bash
aws dynamodb query --table-name app \
  --key-condition-expression "pk = :p AND begins_with(sk, :s)" \
  --expression-attribute-values '{":p":{"S":"user#1"},":s":{"S":"order#"}}'
```

**SDK (Document client)**

```js
import { QueryCommand } from '@aws-sdk/lib-dynamodb';

const { Items } = await doc.send(new QueryCommand({
  TableName: 'app',
  KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
  ExpressionAttributeValues: { ':p': 'user#1', ':s': 'order#' },
  ScanIndexForward: false,   // newest first
}));
```

### Update an item (atomic counter + SET)

**CLI**

```bash
aws dynamodb update-item --table-name app \
  --key '{"pk":{"S":"user#1"},"sk":{"S":"order#001"}}' \
  --update-expression "SET #s = :shipped ADD amount :bump" \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":shipped":{"S":"SHIPPED"},":bump":{"N":"8"}}' \
  --return-values ALL_NEW
```

**SDK (Document client)**

```js
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

const { Attributes } = await doc.send(new UpdateCommand({
  TableName: 'app',
  Key: { pk: 'user#1', sk: 'order#001' },
  UpdateExpression: 'SET #s = :shipped ADD amount :bump',
  ExpressionAttributeNames: { '#s': 'status' },
  ExpressionAttributeValues: { ':shipped': 'SHIPPED', ':bump': 8 },
  ReturnValues: 'ALL_NEW',
}));
// Attributes.amount === 50
```

### Scan with a FilterExpression

**CLI**

```bash
aws dynamodb scan --table-name app \
  --filter-expression "amount > :min" \
  --expression-attribute-values '{":min":{"N":"40"}}'
```

**SDK (Document client)**

```js
import { ScanCommand } from '@aws-sdk/lib-dynamodb';

const { Items, Count } = await doc.send(new ScanCommand({
  TableName: 'app',
  FilterExpression: 'amount > :min',
  ExpressionAttributeValues: { ':min': 40 },
}));
```

Pagination works the standard way: pass `Limit`, then feed the returned
`LastEvaluatedKey` back as `ExclusiveStartKey` until it's absent.

---

## 4. Supported / not-yet-supported

| Area | Supported | Notes |
|---|---|---|
| Control plane | ✅ CreateTable, DeleteTable, DescribeTable, ListTables, UpdateTable | UpdateTable can change billing mode, add/remove GSIs, toggle streams |
| Item ops | ✅ PutItem, GetItem, UpdateItem, DeleteItem | `ReturnValues` (ALL_OLD/ALL_NEW/UPDATED_OLD/UPDATED_NEW) honored |
| Query | ✅ KeyConditionExpression, FilterExpression, ProjectionExpression, ScanIndexForward, Limit, Select=COUNT, IndexName | full comparator / `BETWEEN` / `begins_with` grammar |
| Scan | ✅ FilterExpression, ProjectionExpression, Select=COUNT, Limit | |
| Pagination | ✅ LastEvaluatedKey / ExclusiveStartKey | deterministic (key-sorted) |
| UpdateExpression | ✅ SET (`+`/`-`, `if_not_exists`, `list_append`), REMOVE, ADD, DELETE | |
| ConditionExpression | ✅ full grammar | ConditionalCheckFailedException with optional `Item` |
| Batch / transactions | ✅ BatchWriteItem, BatchGetItem, TransactWriteItems, TransactGetItems | transact writes are pre-validated atomically |
| Secondary indexes | ✅ GSI + LSI (control plane + Query via `IndexName`) | |
| TTL | ✅ UpdateTimeToLive / DescribeTimeToLive + lazy expiry sweep | items expire on read |
| Tags | ✅ TagResource / UntagResource / ListTagsOfResource | |
| Streams | ✅ INSERT/MODIFY/REMOVE → Lambda triggers | see DynamoDB Streams |
| `ConsistentRead` | accepted as a no-op | single-node store is always consistent |
| Data types | ⚠️ partial | Strings, Numbers, Bool, Null, List, Map round-trip; Sets degrade to Lists and Binary/huge-number precision is lossy (a marshalled-storage refactor is planned) |
| Provisioned throughput | not enforced | no throttling; capacity metrics are illustrative |

---

## 5. Persistence

Tables, items, indexes, TTL and tags are snapshotted to disk so they survive a
restart:

```
~/.mockcloud/dynamodb/tables.json
```

Relocate it with an env var (useful for per-project or ephemeral state):

```bash
export MOCKCLOUD_DYNAMODB_ROOT=/tmp/my-app-ddb
```

Set `MOCKCLOUD_DYNAMODB_PERSIST=off` to keep everything in memory only.

---

## 6. Browse it in the Console

Open **http://127.0.0.1:4567** → **DynamoDB** to browse tables, create/edit
items, manage secondary indexes, and watch real per-table read/write capacity
and latency metrics driven by your actual traffic.
