-- Adds leverage constraint table for dynamic leverage caps
CREATE TABLE "LeverageConstraint" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "category" TEXT,
    "targetLeverage" DOUBLE PRECISION,
    "hardCap" DOUBLE PRECISION,
    "liquidityUsd" DOUBLE PRECISION,
    "liquiditySampledAt" TIMESTAMP(3),
    "atrPct" DOUBLE PRECISION,
    "atrSampledAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LeverageConstraint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeverageConstraint_symbol_category_key" ON "LeverageConstraint"("symbol", "category");
CREATE INDEX "LeverageConstraint_symbol_idx" ON "LeverageConstraint"("symbol");
CREATE INDEX "LeverageConstraint_category_idx" ON "LeverageConstraint"("category");
