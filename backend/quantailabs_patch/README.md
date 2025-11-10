# QuantAILabs Patch Pack — Crypto Trading Agent Fixes

This pack implements practical fixes discussed for your crypto trading agent:
- **Risk controls**: pre-trade circuit breaker, daily loss limit, dynamic size reduction after loss streaks.
- **ATR-based stops and multi-TP ladder**, trailing stop, and early-exit rules (momentum/CMF failure).
- **Hybrid Smart Exit Logic**: counter-signal awareness, adaptive peak drawdown protection, multi-indicator reversal detection.
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
- `strategy/exits.py` — ATR SL/TP ladder, trailing stop, early-exit heuristics, **hybrid smart exit logic**.
- `regime/regime.py` — simple regime classifier and mode selector (conservative/aggressive).
- `eval/metrics.py` — P&L metrics, drawdown, streaks, PF, expectancy, Sharpe-like.
- `eval/diagnostics.py` — decile analysis and Spearman-like rank correlation (no external deps).
- `backtest/execution.py` — fees+slippage application and bracket order helper.
- `utils/indicators.py` — lightweight EMA, RSI, ATR, ADX, CMF.
- `examples/example_integration.py` — how to wire pre-trade checks, entries, SL/TPs, and updates.
- `examples/hybrid_exit_example.py` — demonstrates hybrid smart exit features.

## Hybrid Smart Exit Logic

The new hybrid exit system addresses profit protection in volatile crypto markets by combining:

### 1. Counter-Signal Awareness (Rotation Detection)
Detects when the strategy engine produces a signal in the opposite direction:
- **Strong signal** (confidence ≥ 0.7, R ≥ 2.0): **EXIT immediately** to lock in gains
- **Medium signal** (confidence ≥ 0.6, R ≥ 1.0): **Tighten stop aggressively** (0.3x ATR)
- Properly handles long→short and short→long rotations

### 2. Adaptive Peak Drawdown Protection
Tracks peak price and exits when giveback exceeds threshold:
- **1R profit**: Allow 5% drawdown from peak
- **2R profit**: Allow 4% drawdown from peak
- **3R profit**: Allow 3% drawdown from peak
- **5R+ profit**: Allow 2% drawdown from peak

Prevents giving back significant gains during trend reversals.

### 3. Multi-Indicator Technical Reversal Detection
Calculates reversal score (0-100) based on:
- EMA crossovers (25 points)
- MACD crossovers (25 points)
- RSI extremes (20 points)
- Volume decline (15 points)
- Support/Resistance breaks (15 points)

Actions:
- **Score ≥ 75, R ≥ 2.0**: **EXIT** on strong reversal
- **Score ≥ 60, R ≥ 1.0**: **Tighten stop** on medium reversal

### Configuration

Configure hybrid exits in `config.yaml`:

```yaml
exits:
  hybrid:
    enable_counter_signal_exits: true
    enable_peak_drawdown_protection: true
    enable_reversal_detection: true
    
    counter_signal_exit_confidence: 0.7
    counter_signal_exit_min_r: 2.0
    counter_signal_tighten_confidence: 0.6
    counter_signal_tighten_min_r: 1.0
    
    peak_drawdown_thresholds:
      1.0: 0.05  # 5% at 1R
      2.0: 0.04  # 4% at 2R
      3.0: 0.03  # 3% at 3R
      5.0: 0.02  # 2% at 5R+
    
    reversal_exit_score: 75.0
    reversal_exit_min_r: 2.0
    reversal_tighten_score: 60.0
    reversal_tighten_min_r: 1.0
```

### Usage Example

```python
from quantailabs_patch.strategy.exits import (
    ExitConfig, HybridExitConfig, TechnicalSnapshot,
    maybe_adjust_or_exit
)

# Configure
cfg = ExitConfig(
    trail_after_r=0.8,
    hybrid=HybridExitConfig()  # Uses defaults from config.yaml
)

# In your trading loop:
decision = maybe_adjust_or_exit(
    side='long',
    entry_price=643.0,
    sl=628.0,
    tps=[673.0, 691.0, 712.0],
    last_price=670.0,
    atr=10.0,
    adx=25.0,
    cmf=0.1,
    cfg=cfg,
    # Hybrid parameters (optional)
    peak_price=670.0,  # Track high for longs, low for shorts
    counter_signal_side='short',  # If strategy wants to rotate
    counter_signal_confidence=0.75,  # Rotation confidence
    technical_snapshot=current_indicators,  # Current technical state
    previous_snapshot=previous_indicators   # For crossover detection
)

if decision['action'] == 'exit':
    print(f"EXIT: {decision['reason']}")
    # Close position and lock in gains
```

See `examples/hybrid_exit_example.py` for detailed examples.

## Quick integration

1. Copy this folder into your backend repo (e.g. `backend/quantailabs_patch/`) or install as a package path.
2. Load and tweak `config.yaml` thresholds.
3. In your **signal loop**:
   - Build a `MarketSnapshot` (OHLCV + indicators) or pass raw arrays to the functions here.
   - Call `CircuitBreaker.can_open_trade(...)` before every new trade; respect its cooldown.
   - Use `filters.evaluate_entry(...)` to vet entries (returns `ok, reasons`).
   - Build **ATR-based bracket** via `exits.compute_initial_sl_tp(...)`.
   - On every tick, call `exits.maybe_adjust_or_exit(...)` to trail and early-exit.
   - **Optionally** pass `peak_price`, `counter_signal_*`, and `technical_snapshot` for hybrid exits.
4. On **trade close**, call `CircuitBreaker.on_trade_result(pnl_pct)` and update `eval.metrics` accumulators.
5. For backtests, route fills through `backtest/execution.apply_fees_slippage(...)` first.

> **Note**: This pack assumes you already have order routing and data access (e.g., ccxt). It focuses on decisioning, risk,
> and evaluation. Treat it as a reference implementation you can slot into your agent.

**Disclaimer**: This is not financial advice. Use at your own risk and validate via out-of-sample walk-forward tests.
