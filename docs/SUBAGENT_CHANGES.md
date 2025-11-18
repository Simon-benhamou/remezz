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
