-- CreateTable
CREATE TABLE "SubagentLearningState" (
    "id" TEXT NOT NULL,
    "subagent" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "mode" TEXT,
    "regime" TEXT,
    "score" DOUBLE PRECISION,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "metrics" JSONB,
    "tuning" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SubagentLearningState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subagent_learning_unique" ON "SubagentLearningState"("subagent", "symbol", "mode", "regime");

-- CreateIndex
CREATE INDEX "SubagentLearningState_symbol_idx" ON "SubagentLearningState"("symbol");

-- CreateIndex
CREATE INDEX "SubagentLearningState_subagent_idx" ON "SubagentLearningState"("subagent");
