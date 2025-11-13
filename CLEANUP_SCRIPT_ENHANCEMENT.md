# Cleanup Script Enhancement

## Problem
The cleanup script was deleting ALL paper trading sessions, including active agents that users wanted to keep running. There was no way to preserve specific user's agents or only clean up stopped sessions.

## Solution
Added two new flags to the cleanup script:

### 1. `--exclude-user` Flag
Preserves all sessions owned by a specific user ID.

**Usage:**
```bash
# Dry run (preview what would be deleted)
npx tsx scripts/cleanup-paper-sessions.ts --exclude-user=cmhhhwem70000pe65r748lnlu

# Execute deletion (excluding user's sessions)
npx tsx scripts/cleanup-paper-sessions.ts --exclude-user=cmhhhwem70000pe65r748lnlu --execute
```

**Example output:**
```
📍 Target mode: paper
🔒 Excluding user: cmhhhwem70000pe65r748lnlu

🔍 Analyzing paper trading sessions...
   🔒 Excluding sessions owned by user: cmhhhwem70000pe65r748lnlu

✅ No paper sessions found. Nothing to clean up.
```

### 2. `--stopped-only` Flag
Only deletes sessions that have been stopped (stoppedAt IS NOT NULL), preserving all active/running agents.

**Usage:**
```bash
# Dry run (preview what would be deleted)
npx tsx scripts/cleanup-paper-sessions.ts --stopped-only

# Execute deletion (only stopped sessions)
npx tsx scripts/cleanup-paper-sessions.ts --stopped-only --execute
```

**Example output:**
```
📍 Target mode: paper
⏹️  Stopped sessions only: true

🔍 Analyzing paper trading sessions...
   ⏹️  Only targeting stopped sessions (preserving active agents)

📊 Found 15 paper sessions to delete (all stopped)
```

### 3. Combined Flags
You can combine both flags for maximum control:

```bash
# Delete only stopped sessions, but exclude specific user
npx tsx scripts/cleanup-paper-sessions.ts --stopped-only --exclude-user=USER_ID --execute
```

## Complete Usage Options

```bash
# 1. Default: Delete ALL paper sessions (destructive!)
npx tsx scripts/cleanup-paper-sessions.ts --execute

# 2. Preserve specific user's sessions
npx tsx scripts/cleanup-paper-sessions.ts --exclude-user=USER_ID --execute

# 3. Only delete stopped sessions (preserve active)
npx tsx scripts/cleanup-paper-sessions.ts --stopped-only --execute

# 4. Combine: stopped only + exclude user
npx tsx scripts/cleanup-paper-sessions.ts --stopped-only --exclude-user=USER_ID --execute

# 5. Change target mode (default is 'paper')
npx tsx scripts/cleanup-paper-sessions.ts --mode=live --execute

# 6. Always run without --execute first to preview (dry run)
npx tsx scripts/cleanup-paper-sessions.ts --stopped-only
```

## Finding Your User ID

You can find your user ID by:

1. **From the UI**: Check browser dev tools console when logged in
2. **From database**:
   ```bash
   npx tsx -e "import('./dist/src/db/client.js').then(async ({ prisma }) => {
     const users = await prisma.user.findMany({ select: { id: true, email: true } });
     console.log(users);
     await prisma.\$disconnect();
   });"
   ```
3. **From your agents**: Check any `AgentSession` record in the database

## Safety Features

- **Dry run by default**: Always shows what would be deleted before executing
- **Confirmation prompt**: Requires explicit "yes" confirmation before deletion
- **Preview mode**: Shows sample sessions and counts before deletion
- **Verification**: Confirms cleanup results after execution

## Files Modified
- `backend/scripts/cleanup-paper-sessions.ts` - Added `--exclude-user` and `--stopped-only` flags

## Implementation Details

The script builds a dynamic `WHERE` clause based on flags:

```typescript
const whereClause: any = { mode: TARGET_MODE };

// Exclude specific user's sessions
if (EXCLUDE_USER_ID) {
  whereClause.NOT = { userId: EXCLUDE_USER_ID };
}

// Only include stopped sessions
if (STOPPED_ONLY) {
  whereClause.stoppedAt = { not: null };
}
```

This ensures flexible filtering while maintaining data integrity.
