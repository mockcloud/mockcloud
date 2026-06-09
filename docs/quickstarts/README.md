# MockCloud Quickstarts

Per-service, copy-paste guides for pointing a real AWS SDK / CLI / IaC tool at
MockCloud and getting correct results locally — no AWS account, no credentials,
no network.

| Service | Guide |
|---|---|
| DynamoDB | [dynamodb.md](./dynamodb.md) |

> More services land here over time. Each follows the same template below.

---

## The template

Every quickstart is structured the same way so they're predictable to read and
to write:

1. **What this is** — one paragraph: the service, what's emulated, and the
   single promise (e.g. "your tables survive a restart").
2. **Start MockCloud** — `npm start` (and Docker if relevant); the two ports:
   - AWS API → `http://127.0.0.1:4566`
   - Console UI → `http://127.0.0.1:4567`
3. **Connect** — the env vars and a minimal SDK client. MockCloud does **no**
   credential or SigV4 validation, so any dummy creds work; the only thing that
   matters is the `endpoint` override.
4. **Walkthrough** — a runnable end-to-end sequence as **both** AWS CLI and Node
   AWS SDK v3 blocks, covering the create → write → read → update → query path.
5. **Supported / not-yet-supported** — an honest matrix so developers know what
   they can rely on.
6. **Persistence** — where on-disk state lives and the env var to relocate it.
7. **Console** — a pointer to `http://127.0.0.1:4567` for visual inspection.

Keep snippets verbatim-runnable from a clean shell — they double as a smoke
test for the emulator.
