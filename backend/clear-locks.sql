-- Clear all entry locks from active agent sessions
-- This fixes the "Risk governor requires hedge" blocking issue

UPDATE "AgentSession"
SET "profileJson" = jsonb_set(
  COALESCE("profileJson", '{}'::jsonb),
  '{entryLock}',
  jsonb_build_object(
    'active', false,
    'since', COALESCE("profileJson"->'entryLock'->>'since', NOW()::text),
    'reason', CONCAT(COALESCE("profileJson"->'entryLock'->>'reason', 'unknown'), ' [cleared by script]'),
    'releasedAt', NOW()::text,
    'expiresAt', NULL,
    'meta', "profileJson"->'entryLock'->'meta'
  )
)
WHERE status = 'ACTIVE'
  AND "profileJson"->'entryLock'->>'active' = 'true';

-- Show summary
SELECT 
  COUNT(*) as total_active_sessions,
  SUM(CASE WHEN "profileJson"->'entryLock'->>'active' = 'true' THEN 1 ELSE 0 END) as remaining_locked,
  SUM(CASE WHEN "profileJson"->'entryLock'->>'active' = 'false' THEN 1 ELSE 0 END) as cleared
FROM "AgentSession"
WHERE status = 'ACTIVE';
