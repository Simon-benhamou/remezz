-- Add regimeContext column to TradeEvaluation
-- This tracks which regime parameters were used for each trade decision
-- enabling traceability and regime-specific optimization

ALTER TABLE "TradeEvaluation" ADD COLUMN IF NOT EXISTS "regimeContext" JSONB;
