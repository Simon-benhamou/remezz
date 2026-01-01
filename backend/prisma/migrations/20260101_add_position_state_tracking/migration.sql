-- Migration: Add state persistence for stagnant trade detection and trailing stop tracking
-- Critical for V5.34 strategy to survive agent restarts

-- Add maxPnlPct tracking (required for stagnant trade trigger)
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "maxPnlPct" DOUBLE PRECISION;

-- Add stagnantState as JSON (stores the 3-phase state machine)
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "stagnantState" JSONB;

-- Add trailing stop activation tracking
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "trailingActive" BOOLEAN DEFAULT false;

-- Add watermarks for trailing stop calculation
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "highWaterMark" DOUBLE PRECISION;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "lowWaterMark" DOUBLE PRECISION;

-- Add entryTime tracking (required for hold duration calculation)
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "entryTime" BIGINT;

-- Add marginUsd tracking (required for PnL calculation)
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "marginUsd" DOUBLE PRECISION;

-- Create index for querying stagnant positions
CREATE INDEX IF NOT EXISTS "Position_stagnantState_idx" ON "Position" USING gin ("stagnantState");

-- Comments
COMMENT ON COLUMN "Position"."maxPnlPct" IS 'Maximum PnL % reached since entry (for stagnant trade detection)';
COMMENT ON COLUMN "Position"."stagnantState" IS 'Stagnant trade state machine: {triggered, triggeredAt, confirmed, cancelled, obsPeakPct}';
COMMENT ON COLUMN "Position"."trailingActive" IS 'Whether trailing stop has been activated';
COMMENT ON COLUMN "Position"."highWaterMark" IS 'Highest price reached (LONG positions)';
COMMENT ON COLUMN "Position"."lowWaterMark" IS 'Lowest price reached (SHORT positions)';
COMMENT ON COLUMN "Position"."entryTime" IS 'Unix timestamp (ms) when position was opened';
COMMENT ON COLUMN "Position"."marginUsd" IS 'Margin allocated to this position (USD)';
