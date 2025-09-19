# Use multiple fallback base images for reliability
ARG BASE_IMAGE=node:20-bookworm-slim
FROM ${BASE_IMAGE}

# Alternative base images if the main registry fails:
# FROM node:20-alpine (smaller, faster)
# FROM registry.hub.docker.com/library/node:20-bookworm-slim
# FROM ghcr.io/library/node:20-bookworm-slim

WORKDIR /app

# 🔐 OpenSSL pour Prisma (avant prisma:gen)
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
# Install deps
COPY package*.json ./
RUN npm ci --no-audit --no-fund

# Prisma
COPY prisma ./prisma
RUN npm run prisma:gen

# App
COPY tsconfig.json ./
COPY src ./src

# Build
RUN npm run build

ENV PORT=4000
EXPOSE 4000

# Entrypoint (db push if possible, but don't crash if DATABASE_URL missing)
COPY scripts/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
CMD ["./docker-entrypoint.sh"]
