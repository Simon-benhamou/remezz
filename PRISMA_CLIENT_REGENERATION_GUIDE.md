# Prisma Client Regeneration Guide

## Problem
The production environment was experiencing Prisma validation errors:

1. **TradeEvaluation.create()** error: "Argument `updatedAt` is missing"
2. **AgentSession.findMany()** error: "Unknown field `positions` for include statement"

## Root Cause
The Prisma client running in production was generated from an older version of `schema.prisma`. When the schema was updated, the client wasn't regenerated, causing a mismatch between the schema definitions and the generated TypeScript types.

## Solution
The build process has been updated to **always regenerate the Prisma client** before compilation:

### Changes Made
```json
// backend/package.json
"build": "npm run prisma:gen && tsc && node ./scripts/postbuild.mjs"
```

This ensures that:
- ✅ Prisma client is regenerated from the current schema
- ✅ TypeScript compilation uses the latest types
- ✅ No schema-client mismatches can occur

## Deployment Instructions

### Option 1: Rebuild Docker Image (Recommended)
If you're using Docker, rebuild the image to get the latest Prisma client:

```bash
cd backend
docker build -t quantailabs-backend:latest .
```

The Dockerfile already includes `npm run prisma:gen` (line 37), so the rebuild will:
1. Install dependencies
2. Generate Prisma client from current schema
3. Build TypeScript code
4. Package everything correctly

### Option 2: Manual Regeneration (Quick Fix)
If you need to fix production immediately without rebuilding:

```bash
cd backend
npm install
npm run prisma:gen  # Regenerate Prisma client
npm run build       # Rebuild application
npm start           # Restart server
```

### Option 3: Using Process Manager (PM2/Systemd)
If using a process manager, update your deployment script:

```bash
#!/bin/bash
cd /path/to/backend
git pull
npm install
npm run prisma:gen  # ← Add this line
npm run build
pm2 restart quantailabs-backend
```

## Verification
After redeployment, verify the fix by checking:

1. **TradeEvaluation creation** should work without updatedAt errors
2. **AgentSession queries** with `positions: true` should work correctly

## Prevention
The build script now automatically regenerates Prisma client before every build, preventing future schema-client mismatches.

### When to Regenerate Manually
You should still manually run `npm run prisma:gen` when:
- Making schema changes during development
- After pulling schema changes from git
- When switching branches with schema differences

### CI/CD Integration
The GitHub Actions workflow automatically runs `npm run build`, which includes Prisma generation. No additional steps needed.

## Technical Details

### Why This Happened
Prisma client is **generated code** that must match the schema. The client includes:
- TypeScript type definitions
- Runtime query builders
- Validation logic

When the schema changes but the client isn't regenerated, you get type mismatches.

### Schema Changes That Require Regeneration
- Adding/removing models
- Adding/removing fields
- Changing field types or attributes (@updatedAt, @default, etc.)
- Modifying relations
- Changing constraints

### Dockerfile Build Order (Current)
```dockerfile
COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npm run prisma:gen        # ← Generates client from schema

COPY src ./src
RUN npm run build             # ← Now also regenerates (redundant but safe)
```

This double-generation is intentional for safety, ensuring the client is always up-to-date even if the build command is run independently.

## Related Files
- `backend/package.json` - Build script updated
- `backend/prisma/schema.prisma` - Schema definition
- `backend/Dockerfile` - Docker build process
- `.github/workflows/ci.yml` - CI pipeline

## References
- [Prisma Client Generation](https://www.prisma.io/docs/concepts/components/prisma-client/working-with-prismaclient/generating-prisma-client)
- [Prisma in Docker](https://www.prisma.io/docs/guides/deployment/deployment-guides/deploying-to-docker)
