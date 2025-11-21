-- AlterTable: Add userId to TradeEvaluation
ALTER TABLE "TradeEvaluation" ADD COLUMN "userId" TEXT;

-- AlterTable: Add userId to SubagentLearningState
ALTER TABLE "SubagentLearningState" ADD COLUMN "userId" TEXT;

-- CreateIndex for TradeEvaluation
CREATE INDEX "TradeEvaluation_userId_symbol_timestamp_idx" ON "TradeEvaluation"("userId", "symbol", "timestamp");

-- CreateIndex for SubagentLearningState
CREATE INDEX "SubagentLearningState_userId_symbol_subagent_idx" ON "SubagentLearningState"("userId", "symbol", "subagent");

-- Drop old unique constraint on SubagentLearningState
DROP INDEX IF EXISTS "subagent_learning_unique";

-- Create new unique constraint with userId
CREATE UNIQUE INDEX "subagent_learning_user_unique" ON "SubagentLearningState"("userId", "subagent", "symbol", "mode", "regime");

-- AddForeignKey
ALTER TABLE "TradeEvaluation" ADD CONSTRAINT "TradeEvaluation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubagentLearningState" ADD CONSTRAINT "SubagentLearningState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
