# MockCloud (Go) — slim self-contained image.
#
# Builds the console and compiles the fully embedded static binary
# (-tags embedui), then ships it on distroless/static. ~20-25 MB vs the old
# node:20-alpine image (~140 MB).
#
# CAVEAT: Lambda emulation spawns `node` to execute function code, and this
# image has no Node runtime — Lambda invokes return a "Node.js runtime not
# found" error. Everything else works. For working Lambda, use Dockerfile.node
# (the node:alpine variant) or set MOCKCLOUD_NODE_BIN to a mounted node.

# ── Stage 1: build the console ────────────────────────────────────────────────
FROM node:20-alpine AS ui-builder
WORKDIR /app/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# ── Stage 2: build the static binary with the UI embedded ─────────────────────
FROM golang:1.24-alpine AS go-builder
WORKDIR /src
COPY go.mod ./
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY ui/*.go ./ui/
COPY --from=ui-builder /app/ui/dist ./ui/dist
RUN CGO_ENABLED=0 go build -tags embedui -ldflags="-s -w" -o /mockcloud ./cmd/mockcloud

# ── Stage 3: distroless runtime ───────────────────────────────────────────────
FROM gcr.io/distroless/static-debian12
COPY --from=go-builder /mockcloud /mockcloud
EXPOSE 4566 4567
ENV PORT=4566 UI_PORT=4567 HOST=0.0.0.0
ENTRYPOINT ["/mockcloud"]
