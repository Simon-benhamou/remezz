-- Add PendingIntent table for persisting entry timing decisions
CREATE TABLE "PendingIntent" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "sessionId" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "action" TEXT NOT NULL, -- 'wait_pullback' | 'wait_confirmation'
  "targetOffset" DOUBLE PRECISION,
  "originalPrice" DOUBLE PRECISION NOT NULL,
  "originalSignal" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "confirmationTicks" INTEGER DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'active', -- 'active' | 'executed' | 'expired' | 'cancelled'
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "executedAt" TIMESTAMP(3),
  
  CONSTRAINT "PendingIntent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Indexes for fast lookups
CREATE INDEX "PendingIntent_sessionId_status_idx" ON "PendingIntent"("sessionId", "status");
CREATE INDEX "PendingIntent_status_expiresAt_idx" ON "PendingIntent"("status", "expiresAt");
CREATE UNIQUE INDEX "PendingIntent_sessionId_active_idx" ON "PendingIntent"("sessionId") WHERE "status" = 'active';

-- Add order tracking IDs to Position table (already exists, just documenting)
-- slOrderId and tpOrderId are already in the Position table
