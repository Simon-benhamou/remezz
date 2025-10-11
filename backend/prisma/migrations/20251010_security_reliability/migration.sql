-- Add needsAttention flag for agent sessions and scheduler jobs table
ALTER TABLE "AgentSession"
  ADD COLUMN IF NOT EXISTS "needsAttention" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS "SchedulerJob" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "runAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SchedulerJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SchedulerJob_type_runAt_key" UNIQUE ("type", "runAt")
);

CREATE INDEX IF NOT EXISTS "SchedulerJob_type_status_runAt_idx" ON "SchedulerJob"("type", "status", "runAt");
CREATE INDEX IF NOT EXISTS "SchedulerJob_status_runAt_idx" ON "SchedulerJob"("status", "runAt");
