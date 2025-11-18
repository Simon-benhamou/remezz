-- Create AgentPerformanceLedger table
CREATE TABLE "AgentPerformanceLedger" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "agentName" TEXT NOT NULL,
  "agentFamily" TEXT,
  "symbol" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "regime" TEXT,
  "windowMinutes" INTEGER NOT NULL DEFAULT 1440,
  "bucketStart" TIMESTAMP(3) NOT NULL,
  "tradeCount" INTEGER NOT NULL DEFAULT 0,
  "winRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "realizedPnlUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "netPnlUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "feesUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "avgLatencyMs" DOUBLE PRECISION,
  "avgSlippageBps" DOUBLE PRECISION,
  "avgHoldMinutes" DOUBLE PRECISION,
  "blockedCount" INTEGER NOT NULL DEFAULT 0,
  "complianceHits" INTEGER NOT NULL DEFAULT 0,
  "score" DOUBLE PRECISION,
  "volatilityPct" DOUBLE PRECISION,
  "drawdownPct" DOUBLE PRECISION,
  "stats" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentPerformanceLedger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentPerformanceLedger_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "agent_performance_window_unique"
  ON "AgentPerformanceLedger" ("sessionId", "symbol", "mode", "regime", "windowMinutes", "bucketStart");

CREATE INDEX "AgentPerformanceLedger_symbol_mode_bucketStart_idx"
  ON "AgentPerformanceLedger" ("symbol", "mode", "bucketStart");

CREATE INDEX "AgentPerformanceLedger_session_window_idx"
  ON "AgentPerformanceLedger" ("sessionId", "windowMinutes", "bucketStart");
