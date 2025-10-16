# Trading System Diagnostics and PnL Improvement Plan

## 1. System Architecture Overview

The backend orchestrates the trading workflow through four tightly coupled layers:

1. **Strategy Generation (`src/ai/strategyManager.ts`)** – External LLM strategies are throttled and optionally reused when rate limits are hit, then converted into concrete levels via bracket calculations before persisting in Prisma. This stage decides directional bias, entry zone, stop-loss and targets.
2. **Market State Engine (`src/engine/events.ts`)** – `tickOnce` streams the technical snapshot (support/resistance, pivot touches) to sessions, maintains recent RSI/ADX state, and triggers strategy refreshes or policy audits.
3. **Execution Planner (`src/agent/executionPlanner.ts`)** – Chooses `market`, `limit`, or `twap` modes based on spread, ATR, notional size, capacity pressure, and liquidity heuristics. It applies passive price offsets, schedules fallbacks, and embeds telemetry.
4. **Risk & Sizing (`src/risk/manager.ts`)** – Enforces per-trade risk percent, daily loss limits, leverage caps, and calculates notional exposure given stop distance. KPI recomputation (`src/metrics/kpi.ts`) aggregates post-trade statistics without feeding back into upstream controls.

This flow provides reactive execution, yet several feedback loops are either missing or delayed, causing performance drift.

## 2. Loss Drivers & Diagnostic Gaps

### 2.1 Stale or Infrequent Strategy Refresh
- `requestStrategy` reuses the last persisted strategy whenever throttling rejects a fresh LLM call. During momentum reversals this keeps the agent anchored to outdated bias/levels, especially because `zoneExitDebounced` requires multiple ticks and ±0.15% hysteresis before triggering regeneration. The missing reinforcement from KPI outcomes means underperforming strategies are not demoted automatically.

**Diagnostic need:** Track strategy age vs. market regime shifts (volatility, RSI divergence) to escalate refresh priority before losses accumulate.

### 2.2 Execution Fallback Slippage
- The planner escalates to market orders after static delays (e.g., 4s for limit, `interval * slices` for TWAP). In thin books the fallback occurs precisely when adverse selection peaks, converting originally protective limit logic into worse-than-market fills. Passive offsets are fixed (5–8 bps) and do not account for measured fill probability or spread variance.

**Diagnostic need:** Instrument fill-to-plan comparisons (limit hit rate, slippage vs. telemetry) and throttle fallback if price stays inside passive band.

### 2.3 Risk Budget Rigidity
- `defaultLimits` sets a minimum 0.5% risk per trade and static daily loss caps based on agent aggressiveness. After drawdowns, the agent still sizes from the original balance. `computeQtyNotional` also prioritizes hitting a minimum TP PnL even if volatility shrinks, potentially oversizing positions. There is no exposure aggregation across correlated symbols.

**Diagnostic need:** Real-time balance-adjusted risk curves and correlation heatmap to dynamically compress leverage when multiple symbols co-move.

### 2.4 KPI Analytics Not Closing the Loop
- KPI recomputation already calculates expectancy, drawdown, and symbol-level win rates, but these insights remain in the database. The engine does not read them to pause underperforming playbooks, increase ATR filters, or bias strategy prompts.

**Diagnostic need:** Surface KPIs as guardrails (e.g., auto-halt symbols with win rate <35% in last 20 trades) and feed expectancy metrics into strategy prompts.

### 2.5 Limited Real-Time Market Diagnostics
- `tickOnce` broadcasts support/resistance touches and simple triggers but lacks a richer state machine (order flow imbalance, funding, liquidation clusters). Divergence tracking (`divergenceTicks`) and `lastIndicatorSig` are stored but unused downstream. Without contextual tagging, the agent cannot discriminate between range-bound chop and breakout phases, leading to repetitive stop-outs.

**Diagnostic need:** Maintain per-symbol regime classification and anomaly alerts, integrating them into strategy requests and risk sizing.

## 3. PnL Improvement Recommendations

### 3.1 Close the Feedback Loop Between KPIs and Strategy Selection
- Introduce a `StrategyHealth` service that queries `sessionKpi` records and recent fill outcomes to rank strategies by expectancy, holding time, and partial win rate. When `requestStrategy` needs to reuse a plan, prefer the most recent positive-expectancy variant or downscale position size if expectancy < 0.
- Automate guardrail actions: if `winRate` or `expectancy` drops below configurable thresholds, push a `cooldown` to the Risk Manager and widen ATR thresholds before new entries.

### 3.2 Adaptive Execution Parameters
- Collect execution telemetry per symbol (fill latency, passive offset success). Use an exponentially weighted score to adjust `passiveOffsetBps` and fallback delays. For example, increase offset in fragile books when limit fill rate < 40%, but extend wait time if adverse slippage exceeds recent spread by >50%.
- For TWAP, derive slice count from real order book liquidity rather than static notional buckets. Use `estimateLiquidityScore` along with live depth snapshots to choose slice size and spacing.

### 3.3 Volatility-Responsive Risk Scaling
- Replace the static 0.5–riskPct cap with an ATR/volatility adjusted budget: `riskPct = baseRisk * clamp(targetATR / currentATR, 0.4, 1.6)`. This reduces exposure in high-vol regimes and allows scaling when volatility contracts.
- Track aggregate delta per base currency to enforce portfolio-level max leverage. When multiple positions share correlation, cap cumulative risk to prevent cascading losses.

### 3.4 Enhanced Real-Time Symbol Diagnostics
- Extend `tickOnce` to emit a diagnostic payload (e.g., regime = trend/range, momentum score, spread percentile). Combine `buildTechSnapshot` data with short-term realized volatility and order book imbalance.
- Build a small streaming classifier (could be rule-based initially) that uses the diagnostic payload to tag scenarios (breakout, mean reversion, liquidity vacuum). Feed the tag into both strategy prompts and execution planner to select the appropriate playbook.

### 3.5 Continuous Learning & Scenario Testing
- Use recorded tick + KPI data to simulate alternative execution decisions (counterfactuals). Evaluate if delaying fallback or using partial profit-taking would have improved PnL.
- Implement a `postTradeReview` job that flags trades where actual slippage or drawdown exceeded plan assumptions, then updates configuration (e.g., increase `TRIGGER_SAMPLE_RATE` for problematic symbols to gather more context).

## 4. Implementation Roadmap

1. **Month 1 – Instrumentation & Dashboards**
   - Log execution telemetry (plan vs. fill) and stream KPI snapshots into the monitoring UI.
   - Add regime tagging and correlation metrics to the tick pipeline.
2. **Month 2 – Adaptive Controls**
   - Integrate KPI guardrails with risk manager; implement volatility-aware risk scaling.
   - Launch adaptive execution offsets and dynamic TWAP slicing.
3. **Month 3 – Predictive Enhancements**
   - Deploy scenario classifier to drive strategy prompts and execution modes.
   - Back-test counterfactual policies and iteratively refine heuristics.

By turning existing metrics into active controls, adapting order execution to observed market microstructure, and enriching symbol diagnostics, the agent can reduce slippage, avoid stale strategies, and improve overall profitability without being overly restrictive.
