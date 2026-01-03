-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_userId_fkey";
ALTER TABLE "DiagnosticsCache" DROP CONSTRAINT IF EXISTS "DiagnosticsCache_userId_fkey";
ALTER TABLE "SubagentLearningState" DROP CONSTRAINT IF EXISTS "SubagentLearningState_userId_fkey";
ALTER TABLE "TradeEvaluation" DROP CONSTRAINT IF EXISTS "TradeEvaluation_userId_fkey";

-- DropTable
DROP TABLE IF EXISTS "AdaptiveThreshold";
DROP TABLE IF EXISTS "AuditLog";
DROP TABLE IF EXISTS "AutoUniverseSchedule";
DROP TABLE IF EXISTS "CryptoPersonalityProfile";
DROP TABLE IF EXISTS "DecisionMemory";
DROP TABLE IF EXISTS "DiagnosticsCache";
DROP TABLE IF EXISTS "LeverageConstraint";
DROP TABLE IF EXISTS "PredictorDecision";
DROP TABLE IF EXISTS "SubagentLearningState";
DROP TABLE IF EXISTS "TradeEvaluation";
