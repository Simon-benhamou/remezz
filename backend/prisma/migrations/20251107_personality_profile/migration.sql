-- CreateTable
CREATE TABLE "TradeEvaluation" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decision" TEXT NOT NULL,
    "blockedReason" TEXT,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "inputMetrics" JSONB NOT NULL,
    "marketOutcome" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CryptoPersonalityProfile" (
    "symbol" TEXT NOT NULL,
    "optimalParams" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CryptoPersonalityProfile_pkey" PRIMARY KEY ("symbol")
);

-- CreateIndex
CREATE INDEX "TradeEvaluation_symbol_timestamp_idx" ON "TradeEvaluation"("symbol", "timestamp");

-- CreateIndex
CREATE INDEX "TradeEvaluation_timestamp_idx" ON "TradeEvaluation"("timestamp");

-- CreateIndex
CREATE INDEX "TradeEvaluation_marketOutcome_idx" ON "TradeEvaluation"("marketOutcome");

-- CreateIndex
CREATE INDEX "CryptoPersonalityProfile_updatedAt_idx" ON "CryptoPersonalityProfile"("updatedAt");
