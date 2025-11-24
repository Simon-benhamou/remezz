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
    apt-get install -y --no-install-recommends \
        openssl \
        ca-certificates \
        python3 \
        python-is-python3 \
        python3-pip \
        python3-venv && \
    rm -rf /var/lib/apt/lists/*

# Python dependencies for the prediction engine (installed in isolated venv)
# ⚠️ CRITICAL: Copy python folder BEFORE installing requirements to ensure proper paths
COPY python ./python
COPY requirements.txt ./requirements.txt

ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv ${VIRTUAL_ENV}
ENV PATH="${VIRTUAL_ENV}/bin:${PATH}"

# Install Python dependencies
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Verify critical packages are installed (fail fast if missing)
RUN python3 -c "import xgboost; import pandas; import numpy; import sklearn; print('✅ All Python dependencies installed')"

# 🤖 CRITICAL: TRAIN PREDICTOR MODEL during build (modèle non versionné git)
# Le modèle fait 350-450MB et DOIT être généré pendant le build Docker
# Copy training data (CSV files from ccxt_cache)
RUN mkdir -p ./data/ccxt_cache
COPY data/ccxt_cache ./data/ccxt_cache

# Train the model (conservative version with 70%+ target)
RUN echo "🤖 Training XGBoost predictor model (this generates ~450MB file)..." && \
    cd python && \
    python3 train_conservative.py 2>&1 | tail -100 && \
    cd .. && \
    echo "" && \
    echo "📊 Checking generated model files:" && \
    ls -lh python/xgboost_model_conservative.json 2>/dev/null && \
    ls -lh python/feature_order_conservative.json 2>/dev/null && \
    ls -lh python/predictor_metadata_conservative.json 2>/dev/null && \
    echo "✅ Predictor training completed - model will be cached in memory on first load"

# Install Node.js deps
COPY package*.json ./
RUN npm ci --no-audit --no-fund

# Prisma schema and migrations
COPY prisma ./prisma
RUN PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 npm run prisma:gen

# TypeScript config
COPY tsconfig.json ./

# App source code (excluding test files via .dockerignore)
COPY src ./src
COPY scripts ./scripts
COPY quantailabs_patch ./quantailabs_patch

# Build the application
RUN npm run build

ENV PORT=4000
EXPOSE 4000

# Entrypoint (db push if possible, but don't crash if DATABASE_URL missing)
RUN chmod +x ./scripts/docker-entrypoint.sh
CMD ["./scripts/docker-entrypoint.sh"]
