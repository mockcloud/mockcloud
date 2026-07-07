# MockCloud: Node → Go migration

MockCloud's server was rewritten from Node.js to Go. This document records
what changed, how the two implementations were kept equivalent, how to
arbitrate a behavioral dispute against the retired Node reference, and how a
release goes out.

## What changed

- The server is now a single Go program (`cmd/mockcloud`, `internal/…`),
  stdlib-only, cross-compiled to a static binary with the React console
  embedded (`-tags embedui`). Startup is faster and idle memory is far lower
  than the Node process; the Docker image drops from ~140 MB to ~25 MB.
- **The product is unchanged.** Same 16 AWS services, same `/mockcloud/*`
  control plane, same console, same export/import snapshot format, same env
  vars. The engine changed, not the surface.
- **Lambda still executes real Node.js code.** The Go server shells out to a
  `node` binary (discovered on `PATH`, or `MOCKCLOUD_NODE_BIN`). Node is now an
  optional dependency needed only for the Lambda feature — see the Docker note
  below.

## How equivalence was proven

The vitest suite (31 files, 282 tests, driving the server with real
`@aws-sdk/*` clients over HTTP) is the **conformance gate**. It runs black-box
in "spawn mode": one server process per test file, talked to only over HTTP.
The exact same suite that passed against Node passes against Go — that identity
is the definition of done. `conformance/passing.json` lists every gated file;
CI (`conformance-go`, Linux + Windows) enforces it on every push.

- `npm test` — build the Go server, run the full suite against it.
- `node scripts/conformance.mjs --files a.test.js b.test.js` — a subset.
- `node scripts/conformance.mjs --ci` — the ratchet (fails if any listed file regresses).

## The retired Node reference

At cutover the Node implementation was preserved, not lost:

- tag **`node-final`** — the last commit where `src/` (Node) and the Go tree
  coexisted and both passed the suite.
- branch **`node-legacy`** — protected; the Node source lives on here.

### Arbitrating a behavioral dispute

When you're unsure whether the Go server's behavior is a regression or the test
was wrong, ask the Node reference the same question through the same harness:

```bash
# Get the Node reference alongside the current tree.
git worktree add ../mockcloud-node node-legacy
cd ../mockcloud-node && npm ci && cd -

# Run the disputed file against Node using the current harness.
node scripts/conformance.mjs --files <file>.test.js \
  --server "node ../mockcloud-node/src/index.js"
```

Node's answer is authoritative for anything the suite covered at `node-final`.
Tests added after cutover never ran on Node — arbitrate those against AWS docs
(or real AWS), checking out the suite at `node-final` if you need the frozen
baseline.

## Release (manual)

Nothing publishes automatically. A release is a deliberate sequence:

1. Bump `version` in `package.json`, tag `vX.Y.Z`.
2. Build the console: `npm --prefix ui ci && npm run ui:build`.
3. Binaries + GitHub release: `goreleaser release --clean` (see
   `.goreleaser.yml` — five platforms, UI embedded, draft release).
4. npm: publish the `@mockcloud/cli-<os>-<arch>` platform packages and the
   `mockcloud` wrapper (`bin/mockcloud.js` resolves the matching binary — the
   esbuild pattern) so `npx mockcloud` fetches the right prebuilt binary.
5. Docker: run the **Publish Docker Image** workflow (manual `workflow_dispatch`
   with a version input). It pushes two images:
   - `ghcr.io/mockcloud/mockcloud:<v>` — slim distroless (~25 MB).
     **Lambda is unavailable in this image** (no `node` runtime); the health
     endpoint still reports the service, but invokes return a "Node.js runtime
     not found" error. Use it for everything except Lambda.
   - `ghcr.io/mockcloud/mockcloud:<v>-node` — node:alpine + binary; Lambda works.

The `v1.x` Docker tags and the last Node npm release remain available for
anyone pinned to the Node implementation.
