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

## Seuil RR dynamique (espérance)
- Le filtre `ProfitOk` calcule désormais un seuil RR minimal dynamique à partir du win rate observé sur les derniers trades.
- Le seuil théorique respecte la relation d'espérance `RR_min = (1 - p) / p`, où `p` est le win rate lissé (EWMA).
- Par défaut, le RR est borné entre `rrFloor = 1.0` et `rrCeil = 2.0`, avec un fallback statique `rrBaseMin = 1.3` lorsque l'échantillon (`minTrades = 50`) est insuffisant.
- Un coefficient `safetyMult` (1.0 par défaut) permet de durcir le seuil, puis un `blend` (0.5 par défaut) combine la valeur dynamique avec le minimum statique pour limiter les oscillations.
- Une hystérésis de 5 % évite les oscillations rapides : un nouveau seuil plus bas n'est accepté que s'il s'écarte suffisamment du précédent.
- Exemples rapides :
  - `RR = 1.3` ↔ win rate ≈ 43.5 % (`p = 0.435`).
  - `RR = 1.0` ↔ win rate = 50 % (`p = 0.5`).
  - `RR = 0.8` ↔ win rate ≈ 55.5 % (`p ≈ 0.555`).
- Les paramètres sont persistés sur chaque session (colonnes Prisma `rrFloor`, `rrCeil`, `rrBaseMin`, `rrExpectancy`) et exposés via `GET /agent/state`.
- Utilisez `PATCH /agent/:id` pour ajuster le comportement (validation : `0.5 ≤ rrFloor ≤ rrBaseMin ≤ rrCeil ≤ 5`, `0 < decay ≤ 1`, `0 ≤ blend ≤ 1`, `0 ≤ hysteresis ≤ 0.2`).

## Deployment Checklist
- Run `npm run prisma:gen` and `npm run migrate` after pulling to apply the `SchedulerJob` migration and regenerate Prisma types.
- Ensure the scheduler worker remains enabled at boot to process pending jobs after restarts.
- Update environment files with the new OHLCV fail-fast variables if custom settings are required.
