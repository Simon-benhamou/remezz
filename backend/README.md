# Backend Operations Notes

## Scheduler Worker
- The auto-universe retry flow now uses persisted scheduler jobs stored in the `SchedulerJob` table.
- The API server starts a lightweight worker (`startSchedulerWorker`) during boot to poll for due jobs.
- Adjust the polling cadence with `SCHEDULER_WORKER_INTERVAL_MS` if needed (defaults to 1000ms).
- Use the protected `/api/ops/scheduler/jobs` endpoints (admin only) to inspect and replay jobs.

## Session Rehydration
- Active sessions are rehydrated via `rehydrateActiveAgentSessions()` during startup.
- Successful recoveries clear the new `needsAttention` flag; failures mark the session so operators can investigate.
- Review startup logs for a summary of rehydration success and any sessions requiring manual follow-up.

## Market Data Safeguards
- Technical snapshots fail fast when recent OHLCV volumes are zero or missing in more than the configured threshold.
- Configure thresholds via the new environment variables:
  - `OHLCV_FAILFAST_THRESHOLD` (default `0.2`)
  - `OHLCV_BACKFILL_RETRY` (default `1`)

## Deployment Checklist
- Run `npm run prisma:gen` and `npm run migrate` after pulling to apply the `SchedulerJob` migration and regenerate Prisma types.
- Ensure the scheduler worker remains enabled at boot to process pending jobs after restarts.
- Update environment files with the new OHLCV fail-fast variables if custom settings are required.
