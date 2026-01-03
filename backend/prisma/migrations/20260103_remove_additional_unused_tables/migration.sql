-- DropForeignKey (remove relations first)
ALTER TABLE "AgentSession" DROP CONSTRAINT IF EXISTS "AgentSession_userId_fkey";
ALTER TABLE "AgentOpsTelemetry" DROP CONSTRAINT IF EXISTS "AgentOpsTelemetry_sessionId_fkey";
ALTER TABLE "AgentPerformanceLedger" DROP CONSTRAINT IF EXISTS "AgentPerformanceLedger_sessionId_fkey";
ALTER TABLE "Alert" DROP CONSTRAINT IF EXISTS "Alert_sessionId_fkey";
ALTER TABLE "Alert" DROP CONSTRAINT IF EXISTS "Alert_userId_fkey";
ALTER TABLE "ImprovementItem" DROP CONSTRAINT IF EXISTS "ImprovementItem_userId_fkey";
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_strategyId_fkey";
ALTER TABLE "Strategy" DROP CONSTRAINT IF EXISTS "Strategy_sessionId_fkey";

-- Drop unused tables (6 additional tables from old strategies)
DROP TABLE IF EXISTS "SchedulerJob";
DROP TABLE IF EXISTS "Strategy";
DROP TABLE IF EXISTS "AgentOpsTelemetry";
DROP TABLE IF EXISTS "Alert";
DROP TABLE IF EXISTS "ImprovementItem";
DROP TABLE IF EXISTS "AgentPerformanceLedger";

-- Re-add the User constraint we need
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Remove strategyId column from Order table (no longer needed)
ALTER TABLE "Order" DROP COLUMN IF EXISTS "strategyId";
