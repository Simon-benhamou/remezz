#!/bin/sh
set -e

# Function to wait for database with exponential backoff
wait_for_db() {
  local max_attempts=10
  local attempt=1
  local wait_time=2
  
  echo "[entrypoint] Waiting for database to be ready..."
  
  while [ $attempt -le $max_attempts ]; do
    echo "[entrypoint] Attempt $attempt/$max_attempts..."
    
    if npx prisma db execute --stdin <<EOF 2>/dev/null
SELECT 1;
EOF
    then
      echo "[entrypoint] ✅ Database is ready!"
      return 0
    fi
    
    if [ $attempt -lt $max_attempts ]; then
      echo "[entrypoint] Database not ready, waiting ${wait_time}s before retry..."
      sleep $wait_time
      wait_time=$((wait_time * 2))  # Exponential backoff
      attempt=$((attempt + 1))
    else
      echo "[entrypoint] ❌ Database connection failed after $max_attempts attempts"
      return 1
    fi
  done
}

echo "[entrypoint] Prisma DB sync..."

if [ -n "$DATABASE_URL" ]; then
  # Wait for database to be ready (handles Neon cold starts)
  wait_for_db || {
    echo "[entrypoint] WARNING: Could not connect to database, but continuing..."
  }
  
  # 1) Appliquer les migrations si elles existent
  npx prisma migrate deploy || true

  # 2) Toujours pousser le schéma (crée les tables si aucune migration)
  npx prisma db push || {
    echo "[entrypoint] WARNING: prisma db push failed, but continuing..."
  }
else
  echo "DATABASE_URL not set, skipping Prisma"
fi

echo "[entrypoint] Starting API..."
npm start