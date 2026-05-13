# ── Stage 1: build UI ─────────────────────────────────────────────────────────
FROM node:20-alpine AS ui-builder

WORKDIR /app/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# ── Stage 2: production image ──────────────────────────────────────────────────
FROM node:20-alpine

# Install Docker CLI (for EC2 VMM mode via socket mount)
RUN apk add --no-cache docker-cli

WORKDIR /app

# Install backend deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source + pre-built UI
COPY src/ ./src/
COPY --from=ui-builder /app/ui/dist ./ui/dist

# Ports: 4566 = AWS API, 4567 = UI
EXPOSE 4566 4567

ENV PORT=4566
ENV UI_PORT=4567
ENV HOST=0.0.0.0

# Default to lite EC2 (no Docker-in-Docker needed)
ENTRYPOINT ["node", "src/index.js"]
CMD ["--ec2=lite"]
