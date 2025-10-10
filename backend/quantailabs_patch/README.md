# QuantAILabs Patch Pack — Crypto Trading Agent Fixes

This pack implements practical fixes discussed for your crypto trading agent:
- **Risk controls**: pre-trade circuit breaker, daily loss limit, dynamic size reduction after loss streaks.
- **ATR-based stops and multi-TP ladder**, trailing stop, and early-exit rules (momentum/CMF failure).
- **Smarter filters** (momentum/volume/profitability) with a clear, tuneable config (`config.yaml`).
- **Market regime awareness** (bull/bear/range) to toggle conservative vs aggressive modes.
- **Fees & slippage modeling** for backtests and live performance accounting.
- **Metrics & diagnostics** (profit factor, expectancy, Sharpe-like, drawdown, score/return correlation).

> This is a *drop-in* pack with minimal dependencies (standard library only).
> You may adapt imports/paths to your backend. See `examples/example_integration.py` for a minimal wiring.

## Files

- `risk/circuit_breaker.py` — consecutive-loss breaker, daily loss limit, daily trade limit, dynamic size multiplier.
- `risk/position_sizing.py` — ATR-based sizing and R-multiple helpers.
- `strategy/filters.py` — momentum/volume/profit/quality gates; confidence thresholding.
- `strategy/exits.py` — ATR SL/TP ladder, trailing stop, early-exit heuristics.
- `regime/regime.py` — simple regime classifier and mode selector (conservative/aggressive).
- `eval/metrics.py` — P&L metrics, drawdown, streaks, PF, expectancy, Sharpe-like.
- `eval/diagnostics.py` — decile analysis and Spearman-like rank correlation (no external deps).
- `backtest/execution.py` — fees+slippage application and bracket order helper.
- `utils/indicators.py` — lightweight EMA, RSI, ATR, ADX, CMF.
- `examples/example_integration.py` — how to wire pre-trade checks, entries, SL/TPs, and updates.

## Quick integration

1. Copy this folder into your backend repo (e.g. `backend/quantailabs_patch/`) or install as a package path.
2. Load and tweak `config.yaml` thresholds.
3. In your **signal loop**:
   - Build a `MarketSnapshot` (OHLCV + indicators) or pass raw arrays to the functions here.
   - Call `CircuitBreaker.can_open_trade(...)` before every new trade; respect its cooldown.
   - Use `filters.evaluate_entry(...)` to vet entries (returns `ok, reasons`).
   - Build **ATR-based bracket** via `exits.compute_bracket(...)`.
   - On every tick, call `exits.maybe_adjust_or_exit(...)` to trail and early-exit.
4. On **trade close**, call `CircuitBreaker.on_trade_result(pnl_pct)` and update `eval.metrics` accumulators.
5. For backtests, route fills through `backtest/execution.apply_fees_slippage(...)` first.

> **Note**: This pack assumes you already have order routing and data access (e.g., ccxt). It focuses on decisioning, risk,
> and evaluation. Treat it as a reference implementation you can slot into your agent.

**Disclaimer**: This is not financial advice. Use at your own risk and validate via out-of-sample walk-forward tests.
