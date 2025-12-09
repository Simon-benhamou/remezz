# Use multiple fallback base images for reliability
ARG BASE_IMAGE=node:20-bookworm-slim
FROM ${BASE_IMAGE}

# Alternative base images if the main registry fails:
# FROM node:20-alpine (smaller, faster)
# FROM registry.hub.docker.com/library/node:20-bookworm-slim
# FROM ghcr.io/library/node:20-bookworm-slim

WORKDIR /app

# 🔐 OpenSSL pour Prisma
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        openssl \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install Node.js deps
COPY package.json ./
RUN npm install --no-audit --no-fund

# Prisma schema and migrations
COPY prisma ./prisma
RUN PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 npm run prisma:gen

# TypeScript config
COPY tsconfig.json ./

# App source code (excluding test files via .dockerignore)
COPY src ./src
COPY scripts ./scripts

# Historical data for backtest and month macro analysis
COPY data ./data

# Build the application
RUN npm run build

ENV PORT=4000
EXPOSE 4000

# Entrypoint (db push if possible, but don't crash if DATABASE_URL missing)
RUN chmod +x ./scripts/docker-entrypoint.sh
CMD ["./scripts/docker-entrypoint.sh"]
