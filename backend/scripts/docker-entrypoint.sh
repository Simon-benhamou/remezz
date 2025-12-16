#!/bin/sh
set -e

echo "🚀 Starting Trading Agent Backend..."

# Ensure we're running from the app root (some platforms don't honor WORKDIR)
if [ -d "/app" ]; then
  cd /app
fi

# Run Prisma DB push if DATABASE_URL is set
if [ -n "$DATABASE_URL" ]; then
  echo "📦 Running Prisma DB push..."
  npx prisma db push --skip-generate 2>/dev/null || echo "⚠️ DB push skipped (might already be up to date)"
else
  echo "⚠️ DATABASE_URL not set, skipping DB push"
fi

# Start the application
echo "✅ Starting Node.js server..."

# If build artifacts are missing (e.g. image built without running `npm run build`), build now.
if [ ! -f "dist/src/server.js" ] && [ ! -f "dist/server.js" ]; then
  echo "⚠️ Build artifacts missing, running build..."
  npm run -s build
fi

if [ -f "dist/src/server.js" ]; then
  exec node dist/src/server.js
elif [ -f "dist/server.js" ]; then
  exec node dist/server.js
else
  echo "❌ Cannot find server entrypoint (dist/server.js or dist/src/server.js)"
  echo "📁 dist contents:"
  ls -R dist 2>/dev/null || echo "(dist folder missing)"
  exit 1
fi
