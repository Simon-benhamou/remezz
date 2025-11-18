# Frontend + Monitoring Reboot Plan

## 1. Current gaps (from code audit)
- **Dashboard** (`DashboardPage.tsx`, ~600 lines) shows pretty KPIs and hero widgets, but no way to drill into live agent telemetry. It fetches `/overview` every 15s and only updates PnL/ROI, not subagent health, allocator status, or running jobs.
- **Intelligence page** is essentially a placeholder (static cards for adaptive weights, "decision feed" card with limited data). No actionable insight, no timeline, no correlation reports.
- **Agents/Sessions** (`SessionsPage`, `SessionCockpitPage`, `MonitorPage`, `MonitorPageNew`) scatter information: Sessions list lacks support-state details, so we always jump into Monitor to inspect predictor/risk data. MonitorPageNew even comments out the Activity Feed component, so no event timeline per session.
- **Feed/Backlog/Operations dashboard** rely on card layouts, not data tables. Important fields (sessionId, event type, severity, job) are buried in JSON blobs, and the feed omits most agent lifecycle events (activations, allocations, subagent refreshes, cache warnings, etc.).
- **Background jobs** (optimizer, predictor cache warmer, analyst, incoherence trackers) have no consistent heartbeat/visibility in the UI, so users cannot tell if they are running.

## 2. Backend telemetry + API plan
1. **Subagent activity stream**
   - Extend the existing `agentEventBus` subscriptions to produce structured activity events:
     - `marketQuality.refresh`: sessionIds[], scores, spreads, book depth.
     - `sentiment.snapshot`: symbol, whale/news metrics.
     - `riskGovernor.limits` and `riskGovernor.alert` (already present) but add `severity`, `cooldownMs`, `hedgingRequired` flags.
     - `predictor.insight`: include cache metadata (fresh/stale, ttl, source).
     - `execution.plan.ready`: include strategy + guard outcomes.
   - Publish these events to a new `ws://.../ws/activity` channel (or extend current hub) with filters: by session, by symbol, by agent type.
   - Persist last N (e.g., 200) events per session in Redis or Postgres for replays.

2. **Job status/heartbeat API**
   - Introduce a `/ops/jobs` endpoint returning `{ id, label, status, lastRunAt, durationMs, nextRunEta, lastError }` for each recurring job (optimizer, capital reconciler, predictor cache warmer, new analyst agent, feed exporter, etc.).
   - Emit websocket events `job.updated` whenever a job changes status, so the frontend keeps the dashboard in sync.

3. **Data/Configuration Analyst Agent**
   - Backend service scans trades, symbol cohorts, leverage usage, and configuration overrides daily/hourly.
   - Outputs findings such as "SOL sessions with leverage >5x have -12% ROI" or "Entry config X underperforms vs config Y".
   - Expose results via `/insights/analyst` and stream new findings via `insight.created` events.

4. **Feed API overhaul**
   - Normalize feed items into `{ id, ts, sessionId, symbol, type, severity, summary, details }` and store them so both backlog and monitoring UIs can page through datasets.
   - Add filters (`?sessionId=`, `?type=`, `?severity=`, `?since=`) to the feed endpoint.

## 3. Frontend refactor blueprint
1. **Dashboard (Command Center)**
   - Hero KPIs stay, but add:
     - "Jobs status" panel (grid of heartbeat cards, tapping into `/ops/jobs`).
     - "Now trading" table listing active sessions with bias, predictor confidence, risk state, execution mode, and latest alert.
     - "System alerts" feed for high-severity risk/predictor issues.
   - Replace quick actions with contextual actions (start/stop agent, open monitoring, trigger diagnostics).

2. **Intelligence page → Insights hub**
   - Sections: `Adaptive Weights`, `Decision Feed`, `Analyst Findings`, `Correlations/Anomalies`.
   - Render analyst agent outputs as cards with tags (symbol, config, leverage) and call-to-action (open session, adjust config).
   - Embed charts showing performance per configuration or symbol cohort.

3. **Agents/Sessions page**
   - Convert list into table with columns: `Session`, `Mode`, `Status`, `Support State freshness` (traffic-light per subagent), `Predictor bias/confidence`, `Risk guardrail`, `PnL/ROI`.
   - Allow inline expansion to show recent actions and provide links to Monitoring and Feed filtered for that session.

4. **Monitoring page (per session)**
   - Left column: support state snapshots (market quality, sentiment, risk, predictor, execution) with timestamps.
   - Right column: scrollable activity log table (time, subagent, event, key values). Provide filters, search, and export.
   - Add "Subagent heartbeat" widget showing time since last update for each component.

5. **Feed / Backlog**
   - Replace cards with table + filters + severity color coding.
   - Provide toggles for "All events", "Ops anomalies", "Agent lifecycle", etc.
   - Add quick link actions: open session, open monitoring, view raw payload.

6. **Jobs panel**
   - Dedicated component reused on Dashboard and Operations page to list all backend jobs with statuses, last run, next run, errors.

## 4. Implementation phases
1. **Telemetry groundwork** (backend)
   - Implement activity event pipeline + storage.
   - Expose job status API/websocket.
   - Build data analyst agent and `/insights/analyst` endpoint.

2. **Frontend data layer**
   - Update `api.ts` and `ws.ts` to include new endpoints/events.
   - Add Zustand/Context stores for activity feed, jobs, analyst insights.

3. **UI refactors**
   - Dashboard re-layout (command center, jobs panel, live table).
   - Intelligence page transformation into insights hub.
   - Agents page table upgrade with support state indicators.
   - Monitoring per-session log timeline.
   - Feed table redesign.

4. **Polish + adaptive controls**
   - Add filtering, exports, and deep links between pages.
   - Provide quick adjustments based on analyst recommendations (e.g., disable symbol, tweak leverage).

This document will guide the detailed tickets for backend work, frontend refactors, and the new analyst agent. Let me know if you want it broken into GitHub issues or a figma-style wireframe next.
