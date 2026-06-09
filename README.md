# ☁ MockCloud

**Free, open-source local AWS emulator. No account. No token. No credit card. MIT licensed.**

Run AWS services on your machine. Point your SDK at `localhost:4566` and go.

```bash
npx mockcloud          # coming soon
# or
git clone https://github.com/mockcloud/mockcloud
npm install && npm start
```

```
AWS API  →  http://127.0.0.1:4566
Console  →  http://127.0.0.1:4567
```

---

## Why MockCloud exists

[LocalStack](https://localstack.cloud) used to be the easy answer for "run AWS locally."
Then the features most teams actually reach for — S3 notifications, DynamoDB streams,
Lambda triggers, the cross-service wiring that makes integration tests worth writing —
drifted behind the paid **Pro** tier. The free Community edition kept shrinking.

MockCloud is the unapologetically free alternative: **12 of the most-used AWS services**,
the cross-service plumbing that actually fires, and a visual console — all under the MIT
license. No account, no auth token, no usage limits, no telemetry, no "upgrade to unlock."

It's a single Node.js process with **zero runtime dependencies** (the AWS SDKs are dev-only,
for the test suite). Clone it, read it, hack on it.

- **No AWS account needed** — develop and test completely offline
- **No Docker required** — pure Node.js, works out of the box
- **Visual console included** — browser UI to inspect every service
- **Cross-service wiring is real** — S3 → SQS/SNS/Lambda, SNS → Lambda, EventBridge → SQS, DynamoDB Streams → Lambda all actually fire
- **SDK-tested** — the suite drives MockCloud with the real `@aws-sdk/*` clients (presigned URLs even exercise live SigV4)

---

## Supported services

12 services, focused on depth over breadth.

| Service | Status | What works |
|---|:---:|---|
| **S3** | ✅ | Buckets & objects (disk-persisted, real ETags), **presigned URLs** (GET/PUT + expiry), **versioning** (version IDs, delete markers, `ListObjectVersions`), **bucket notifications** → SQS/SNS/Lambda, **CORS** (preflight + enforcement), website, ACL, tagging, policy, public-access-block |
| **DynamoDB** | ✅ | Tables, items, Query/Scan, **GSI & LSI** (KEYS_ONLY/INCLUDE/ALL projections), condition / update / filter / projection **expressions**, BatchWrite/Get, **TransactWriteItems / TransactGetItems** (atomic, ordered cancellation reasons) |
| **DynamoDB Streams** | ✅ | INSERT / MODIFY / REMOVE records, Lambda triggers via event-source mappings |
| **Lambda** | ✅ | Create / invoke / delete, zip upload, **real Node.js sandbox execution**, environment variables, timeout enforcement, layers, Get/Update function configuration |
| **SQS** | ✅ | Standard **and FIFO** queues (message groups, content/id dedup, sequence numbers, ordered delivery), send/receive/delete/purge, visibility timeout, real MD5 |
| **SNS** | ✅ | Topics, subscriptions, fan-out to SQS + Lambda subscribers |
| **EventBridge** | ✅ | Rules, targets, real fan-out to Lambda / SQS / SNS |
| **IAM** | ✅ | Users, roles, policies, access keys |
| **STS** | ✅ | AssumeRole, GetCallerIdentity, GetSessionToken |
| **Secrets Manager** | ✅ | Create / get / update / delete secrets |
| **EC2** | 🟡 | Simulated instances (run/stop/start/terminate), security groups, key pairs, VPC/subnet/AZ describes |
| **CloudWatch** | 🟡 | PutMetricData, GetMetricStatistics, live activity metrics (ring-buffer storage) |

✅ broad coverage · 🟡 core operations

---

## Quick start

### npm (recommended)

```bash
npm install -g mockcloud   # coming soon
mockcloud
```

### Docker

```bash
docker pull ghcr.io/mockcloud/mockcloud:latest
docker run -p 4566:4566 -p 4567:4567 ghcr.io/mockcloud/mockcloud
```

### From source

```bash
git clone https://github.com/mockcloud/mockcloud
cd mockcloud
npm install
npm run ui:build     # build the console UI
npm start            # start on :4566 (API) + :4567 (console)
```

---

## Connect your SDK

### AWS CLI

```bash
export AWS_ENDPOINT_URL=http://127.0.0.1:4566
export AWS_ACCESS_KEY_ID=local
export AWS_SECRET_ACCESS_KEY=local
export AWS_DEFAULT_REGION=us-east-1

aws s3 mb s3://my-bucket
aws s3 cp ./file.txt s3://my-bucket/
aws dynamodb list-tables
aws sqs create-queue --queue-name my-queue
```

### AWS SDK (Node.js)

```js
import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: "http://127.0.0.1:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
  forcePathStyle: true,   // required for S3
});

await s3.send(new ListBucketsCommand({}));
```

### Terraform

```hcl
provider "aws" {
  access_key                  = "local"
  secret_key                  = "local"
  region                      = "us-east-1"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  endpoints {
    s3       = "http://127.0.0.1:4566"
    dynamodb = "http://127.0.0.1:4566"
    lambda   = "http://127.0.0.1:4566"
    sqs      = "http://127.0.0.1:4566"
    sns      = "http://127.0.0.1:4566"
    iam      = "http://127.0.0.1:4566"
  }
}
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4566` | AWS API port |
| `UI_PORT` | `4567` | Console UI port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for Docker) |
| `MOCKCLOUD_S3_ROOT` | `~/.mockcloud/s3` | Where S3 object bytes are persisted |
| `MOCKCLOUD_DYNAMODB_ROOT` | `~/.mockcloud/dynamodb` | Where DynamoDB tables are persisted |

---

## Console UI

Open `http://127.0.0.1:4567` in your browser for a visual dashboard of every service —
create/delete resources, inspect state, invoke Lambdas, peek SQS queues, browse DynamoDB
items, and watch live metrics.

---

## Storage

S3 object bytes and DynamoDB tables persist to disk (under `~/.mockcloud/`) and survive
restarts; object versions live in a `.mockcloud-versions` sidecar alongside each bucket.
Everything else is in-memory and resets on restart.

---

## Testing

The test suite is **SDK-driven**: it boots the AWS dispatch layer on an ephemeral port and
drives it with the real `@aws-sdk/*` clients (S3, DynamoDB, SQS, SNS, Lambda, EC2) plus the
S3 request presigner — so the tests exercise the exact wire format AWS SDKs send.

```bash
npm test          # vitest run
npm run test:watch
```

CI runs the full suite on every pull request (Node 18 & 20).

---

## Architecture

```
src/
├── index.js          — HTTP servers, body draining, CORS
├── dispatcher.js     — Routes AWS API calls to service handlers
├── router.js         — /mockcloud/* UI API router
├── store.js          — In-memory state, CloudWatch ring buffer
├── middleware/       — Response helpers (XML, JSON, body)
├── routes/           — UI API handlers (one per service)
└── services/         — AWS API handlers (one per service)
    └── dynamodb/     — expression engine, update engine, persistence
ui/
├── vite.config.js    — Proxies /mockcloud → :4566
└── src/
    ├── App.jsx       — Root, live service counts
    ├── api.js        — Fetch wrapper for all UI calls
    └── pages/        — One page per service
```

---

## Contributing

PRs welcome. Services are isolated — adding one means dropping a file in `src/services/`
and `src/routes/` and registering it in `routes/index.js`. New behaviour should come with
an SDK-driven test in `tests/`.

```bash
git clone https://github.com/mockcloud/mockcloud
cd mockcloud
npm install
npm run dev        # API with --watch
# separate terminal:
npm run ui:dev     # Vite dev server with HMR
```

---

## License

MIT — do whatever you want with it.
