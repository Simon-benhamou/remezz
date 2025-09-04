#!/bin/sh
set -e
echo "[entrypoint] Prisma DB sync..."

if [ -n "$DATABASE_URL" ]; then
  # 1) Appliquer les migrations si elles existent
  npx prisma migrate deploy || true

  # 2) Toujours pousser le schéma (crée les tables si aucune migration)
  npx prisma db push
else
  echo "DATABASE_URL not set, skipping Prisma"
fi

echo "[entrypoint] Starting API..."
npm start