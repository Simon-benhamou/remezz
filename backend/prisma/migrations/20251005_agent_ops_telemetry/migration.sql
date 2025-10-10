-- AgentOpsTelemetry tracks operational health signals per session
CREATE TABLE "AgentOpsTelemetry" (
    "sessionId" TEXT NOT NULL,
    "tradeCount24h" INTEGER NOT NULL DEFAULT 0,
    "lastExecutionAt" TIMESTAMP(3),
    "blockedByVos" BOOLEAN NOT NULL DEFAULT FALSE,
    "lastBlockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentOpsTelemetry_pkey" PRIMARY KEY ("sessionId"),
    CONSTRAINT "AgentOpsTelemetry_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AgentOpsTelemetry_blockedByVos_idx" ON "AgentOpsTelemetry"("blockedByVos", "updatedAt");
