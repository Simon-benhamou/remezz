-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- DropForeignKey
ALTER TABLE "public"."TradeEvaluation" DROP CONSTRAINT "TradeEvaluation_userId_fkey";

-- DropForeignKey
ALTER TABLE "public"."SubagentLearningState" DROP CONSTRAINT "SubagentLearningState_userId_fkey";

-- DropIndex
DROP INDEX "public"."TradeEvaluation_userId_symbol_timestamp_idx";

-- DropIndex
DROP INDEX "public"."SubagentLearningState_userId_symbol_subagent_idx";

-- DropIndex
DROP INDEX "public"."SubagentLearningState_userId_subagent_symbol_mode_regime_key";

-- AlterTable
ALTER TABLE "public"."TradeEvaluation" DROP COLUMN "userId";

-- AlterTable
ALTER TABLE "public"."SubagentLearningState" DROP COLUMN "userId";

-- CreateTable
CREATE TABLE "public"."ab_test_evaluations" (
    "id" SERIAL NOT NULL,
    "test_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    "executed" BOOLEAN NOT NULL,
    "profitable" BOOLEAN,
    "pnl_pct" DECIMAL(10,4),
    "timestamp" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ab_test_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ab_tests" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "symbol" TEXT,
    "aggressiveness" TEXT,
    "variants" JSONB NOT NULL,
    "status" TEXT DEFAULT 'draft',
    "start_date" TIMESTAMP(6),
    "end_date" TIMESTAMP(6),
    "min_sample_size" INTEGER DEFAULT 30,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ab_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."symbol_profiles" (
    "symbol" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "custom_thresholds" JSONB,
    "performance_metrics" JSONB,
    "market_characteristics" JSONB,
    "optimization_status" TEXT DEFAULT 'initial',
    "last_optimized_at" TIMESTAMP(6),
    "notes" TEXT,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "symbol_profiles_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "public"."trade_outcomes" (
    "trade_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "entry_time" TIMESTAMP(6) NOT NULL,
    "exit_time" TIMESTAMP(6) NOT NULL,
    "profitable" BOOLEAN NOT NULL,
    "pnl_pct" DECIMAL(10,4) NOT NULL,
    "hold_time_minutes" INTEGER NOT NULL,
    "threshold_confidence" DECIMAL(5,4),
    "threshold_atr" DECIMAL(5,4),
    "threshold_adx" DECIMAL(5,2),
    "threshold_eligibility" DECIMAL(5,4),
    "threshold_rr_min" DECIMAL(5,2),
    "regime" TEXT,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_outcomes_pkey" PRIMARY KEY ("trade_id")
);

-- CreateIndex
CREATE INDEX "idx_ab_test_evaluations_test_variant" ON "public"."ab_test_evaluations"("test_id" ASC, "variant_id" ASC, "timestamp" DESC);

-- CreateIndex
CREATE INDEX "idx_trade_outcomes_symbol_time" ON "public"."trade_outcomes"("symbol" ASC, "entry_time" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "SubagentLearningState_subagent_symbol_mode_regime_key" ON "public"."SubagentLearningState"("subagent" ASC, "symbol" ASC, "mode" ASC, "regime" ASC);
