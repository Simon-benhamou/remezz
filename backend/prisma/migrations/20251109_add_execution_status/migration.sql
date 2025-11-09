-- Update TradeEvaluation to track full execution flow
-- Instead of just "executed" (filters passed) vs "blocked" (filters failed),
-- we now track: filter_passed, filter_blocked, order_placed, order_blocked_*, order_rejected

-- Add new possible decision values
-- Old: "executed" | "blocked"
-- New: "filter_passed" | "filter_blocked" | "order_placed" | "order_blocked_capital" | "order_blocked_sizing" | "order_blocked_registration" | "order_rejected"

-- Note: We keep the existing column, just expand the accepted values
-- The application code will use the new values going forward
