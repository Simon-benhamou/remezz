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

## Risk Management
- Introduced dynamic RR expectancy filtering using win rate EWMA, including safety multiplier, blending, and hysteresis controls persisted per session.
- Exposed RR parameters via `GET /agent/state` and a new `PATCH /agent/:id` endpoint with validation guarding against unsafe thresholds.
- Implemented `services/performance/winrate` to derive recent win rate statistics from fills and integrated the logic into the ProfitOk gate.
- Tuned momentum-aware risk handling by tightening ATR stops under strong flow, rebalancing multi-target exits toward higher-RR fills, and enforcing a 1.0 RR floor with fast-track safeguards.
- Logged structured telemetry for RR, stops, targets, and confirmation context to trace how entry filters adjust position sizing in real time.

## Deployment Notes
- Run `npm run prisma:gen` followed by the latest Prisma migration (`20251015_rr_expectancy_config`) before deploying.
- Ensure the scheduler worker is enabled at boot so persisted jobs execute.
