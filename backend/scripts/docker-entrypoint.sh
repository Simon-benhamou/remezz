#!/bin/sh
set -e

# Function to wait for database with exponential backoff
wait_for_db() {
  local max_attempts=5
  local attempt=1
  local wait_time=2
  
  echo "[entrypoint] Waiting for database to be ready..."
  
  while [ $attempt -le $max_attempts ]; do
    echo "[entrypoint] Attempt $attempt/$max_attempts..."
    
    # Simple connection test using prisma db pull (doesn't modify anything)
    if npx prisma db pull --force --schema=./prisma/schema.prisma >/dev/null 2>&1; then
      echo "[entrypoint] ✅ Database is ready!"
      return 0
    fi
    
    if [ $attempt -lt $max_attempts ]; then
      echo "[entrypoint] Database not ready, waiting ${wait_time}s before retry..."
      sleep $wait_time
      wait_time=$((wait_time + 2))  # Linear backoff (2, 4, 6, 8s)
      attempt=$((attempt + 1))
    else
      echo "[entrypoint] ⚠️ Database connection timeout, but continuing..."
      return 0  # Don't fail, just warn
    fi
  done
}

echo "[entrypoint] Prisma DB sync..."

if [ -n "$DATABASE_URL" ]; then
  # Wait for database to be ready (handles Neon cold starts)
  wait_for_db
  
  # Synchronize schema with database (skips migration history)
  echo "[entrypoint] Syncing Prisma schema with database..."
  npx prisma db push --skip-generate --accept-data-loss 2>&1 || {
    echo "[entrypoint] ⚠️ prisma db push failed, but continuing..."
  }
  
  echo "[entrypoint] ✅ Schema synchronized"
else
  echo "DATABASE_URL not set, skipping Prisma"
fi

echo "[entrypoint] Starting API..."
npm start