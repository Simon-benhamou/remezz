# Subagent Update Summary

## What changed

- **Support state tests now pass** – we fixed the naming conflict inside `pythonPredictor.ts`, so Jest can import the predictor code without crashing. This let us re-run the agent hub, bus, and memory tests until they were all green.
- **`PreciseDecimal` lives in its own file** – the math helper used by capital, execution, and ranking services is now defined in `preciseDecimal.ts`. Every place that needs high-precision numbers imports it from there, and `metaAdaptiveAgent` still re-exports it for older code.
- **Predictor agent loads lazily** – the registry now wraps the predictor inside a small loader. During unit tests (or when something fails to boot) it simply returns a disabled insight instead of pulling in the heavy Python bridge.
- **Feature builder imported only when needed** – the predictor subagent now `await`s the meta-adaptive module the moment it needs to build features, which keeps startup light and avoids circular imports.
- **Meta-adaptive modules kept untouched** – strategy logic (recognized strategies, backtests, comparison) now imports `PreciseDecimal` from its new home, with no behavior changes.

## Why it matters

- Jest and other tooling no longer choke on `import.meta` or duplicate `__dirname` definitions, so we can run agent-level tests reliably.
- Subagents such as predictor, risk governor, sentiment, and execution can operate (or be mocked) independently, which makes it easier to validate each piece.
- Backend watcher (`npm run dev`) stays stable because modules that depend on Python only load when truly required.

## Next steps

- Keep running `npm run build` and `npx jest` after edits so we know the subagent pipeline stays healthy.
- When adding new subagents, follow the same lazy-load pattern so we do not regress the boot time or test stability.

## How each subagent helps the trader agent

- **Market Quality Agent** – checks spreads, depth, and order-book impact for every symbol. It tells the trader agent if liquidity is good enough to trade right now, and pushes those scores into the support state so allocations can adapt.
- **Sentiment Agent** – listens to whale moves, news heat, and bias flags. When it emits `sentiment.updated`, the trader agent gets a quick view of crowd mood and confidence, which feeds both guardrails and entry timing.
- **Risk Governor Agent** – enforces leverage caps, max position size, cluster exposure, and hedging requirements. It raises `riskGovernor.updated` and `riskGovernor.alert` events so the trader agent knows when capital must be reduced or when new entries must pause.
- **Predictor Agent** – builds feature snapshots, queries the Python predictor (with caching), and records its insights. It writes the final bias/confidence into support diagnostics, giving the trader agent a directional edge and allowing the meta-adaptive strategy to gate trades.
- **Execution Agent** – converts strategy intent into real orders. It selects the right mode (market, TWAP, sweep, etc.), enforces slippage limits, and shares execution plans through support state so the trader agent and monitoring UI can follow the plan.
- **Agent Hub + Event Bus** – not a subagent itself, but it wires all the above together. The hub subscribes to each subagent’s events, aggregates them into the support state, and keeps the trader agent’s diagnostics, actions, and alerts in sync.

## Self-tuning roadmap

- **Selector agent mandate** – introduce a dedicated selector that watches performance per `(agent, symbol, regime)` tuple, decides which subagent instances stay live, and points the trader toward the best symbol set. The selector ingests live/paper flags coming from the frontend so it knows where to run experiments safely.
- **Performance ledger** – store rolling windows of win rate, PnL delta, drawdown, latency, and compliance incidents in a single Prisma table (or DuckDB view) keyed by agent + symbol + mode. This becomes the memory that tells us which combinations deserve capital.
- **Scoring + decay** – compute a freshness-aware score such as $Score_{a,s} = w_p \Delta PnL_{a,s} + w_h HitRate_{a,s} - w_d Drawdown_{a,s} - w_v Volatility_{a,s}$. Apply exponential decay so old regimes stop dominating decisions.
- **Action policy** – when the score crosses promotion or demotion thresholds, the selector tells the hub to (1) switch the primary subagent for that symbol, (2) park poor performers into paper mode, or (3) spin up exploratory agents. Manual overrides remain available through the UI but default to “auto”.
- **Opportunity filter** – symbols must clear both base liquidity filters (from Market Quality Agent) and selector score thresholds to stay tradable, which keeps the universe limited to assets that actually show edge.
- **Explainability hooks** – broadcast `selector.snapshot` events that include the top reasons scores moved, so dashboards can show *why* a symbol moved in or out and which agent took over.

## Extending learning/optimization to other subagents

- **Risk governor** – tune leverage, aggressiveness, and hedge tightness per symbol by solving for the lowest historical breach rate subject to capital utilization targets. Persist the learned knobs next to selector scores so every new session inherits the latest guardrails.
- **Execution** – maintain a playbook table that stores which execution style (e.g., TWAP vs. liquidity sweep) minimized slippage for each liquidity bucket. Selector inputs become hints for the execution agent when entering a symbol again.
- **Predictor + feature builder** – let the selector flag underperforming predictor cohorts so the predictor agent can auto-request retraining or feature toggles for the affected symbols only, instead of retraining globally.
- **Sentiment + market-quality** – weight their signals by how predictive they have been for each symbol/regime. If sentiment spikes have no edge on a given pair, the selector can down-weight that feed when compiling the final bias.
- **Feedback buses** – every subagent publishes `*.learningUpdate` messages whenever it shifts a parameter. The selector and monitoring UIs subscribe to these so humans can audit what changed and why.

## Rollout plan

- **Phase 1 – data plumbing**: capture per-agent stats in the ledger, emit selector-ready events, and surface the metrics in the ops dashboard alongside paper/live labels.
- **Phase 2 – advisory mode**: selector only recommends switches; humans approve via dashboard toggles. This proves the ranking math and lets us collect counterfactuals.
- **Phase 3 – autonomous mode**: enable auto-promotion/demotion pipelines with guardrails (min sample size, cooldowns, override switch). Tie into order-routing so execution agents change without manual input.
- **Phase 4 – multi-agent learning**: extend the same feedback loop to risk, execution, and predictor agents so the entire stack continuously optimizes without per-agent manual sliders.
