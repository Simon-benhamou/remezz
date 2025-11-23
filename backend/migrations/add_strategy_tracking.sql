-- AddStrategyTracking
-- Add strategy tracking columns to Orders, Fills, and TradeEvaluation tables

-- Add strategy fields to Order table
ALTER TABLE "Order" 
  ADD COLUMN IF NOT EXISTS "strategyUsed" TEXT,
  ADD COLUMN IF NOT EXISTS "strategyConfidence" DOUBLE PRECISION;

-- Add index for strategy performance analysis
CREATE INDEX IF NOT EXISTS "Order_strategyUsed_status_idx" ON "Order"("strategyUsed", "status");

-- Add strategy field to Fill table (denormalized for easier querying)
ALTER TABLE "Fill" 
  ADD COLUMN IF NOT EXISTS "strategyUsed" TEXT;

-- Add index for strategy PnL analysis
CREATE INDEX IF NOT EXISTS "Fill_strategyUsed_idx" ON "Fill"("strategyUsed");

-- Add strategy selection tracking to TradeEvaluation
ALTER TABLE "TradeEvaluation" 
  ADD COLUMN IF NOT EXISTS "selectedStrategy" TEXT,
  ADD COLUMN IF NOT EXISTS "strategyConfidence" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "alternativeStrategies" JSONB;

-- Add index for strategy performance analysis
CREATE INDEX IF NOT EXISTS "TradeEvaluation_selectedStrategy_decision_idx" ON "TradeEvaluation"("selectedStrategy", "decision");

-- Comments for documentation
COMMENT ON COLUMN "Order"."strategyUsed" IS 'Strategy used for this trade: trend_following, mean_reversion, breakout, momentum';
COMMENT ON COLUMN "Order"."strategyConfidence" IS 'Confidence score (0-1) that this was the right strategy choice';
COMMENT ON COLUMN "Fill"."strategyUsed" IS 'Strategy used (denormalized from Order for performance)';
COMMENT ON COLUMN "TradeEvaluation"."selectedStrategy" IS 'Strategy selected by router';
COMMENT ON COLUMN "TradeEvaluation"."strategyConfidence" IS 'Confidence in strategy selection';
COMMENT ON COLUMN "TradeEvaluation"."alternativeStrategies" IS 'Other strategies considered with their scores';
