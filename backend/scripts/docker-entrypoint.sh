#!/bin/sh
set -e

echo "🚀 Starting Trading Agent Backend..."

# Run Prisma DB push if DATABASE_URL is set
if [ -n "$DATABASE_URL" ]; then
  echo "📦 Running Prisma DB push..."
  npx prisma db push --skip-generate 2>/dev/null || echo "⚠️ DB push skipped (might already be up to date)"
else
  echo "⚠️ DATABASE_URL not set, skipping DB push"
fi

# Start the application
echo "✅ Starting Node.js server..."
exec node dist/server.js
