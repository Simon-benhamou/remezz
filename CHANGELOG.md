# Changelog

## Security
- Hardened agent control endpoints with authentication, role gating, and owner scoping to prevent cross-account access to sessions and stop actions.
- Added structured error responses for unauthorized access attempts on agent and scheduler administration routes to improve visibility.

## Reliability
- Persisted auto-universe retry scheduling to the database and introduced a cooperative worker so planned rescans survive restarts.
- Rehydrated active agent sessions via AgentHub during server startup, flagging sessions that require manual attention when recovery fails.
- Surfaced broker close failures on `/api/agent/stop` with actionable HTTP 502 responses while continuing cleanup routines.

## Data Quality
- Added fail-fast validation for recent OHLCV volumes with configurable retry thresholds to exclude unusable market data from technical analysis.

## Deployment Notes
- Run `npm run prisma:gen` followed by the latest Prisma migration before deploying.
- Ensure the scheduler worker is enabled at boot so persisted jobs execute.
