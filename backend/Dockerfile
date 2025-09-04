FROM node:20-slim
WORKDIR /app

# 🔐 OpenSSL pour Prisma (avant prisma:gen)
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
# Install deps
COPY package*.json ./
RUN npm install

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
