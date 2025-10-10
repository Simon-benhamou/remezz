"""
Toy integration example (pseudo-wire-up). Replace placeholders with your app's data & routing.
"""
from datetime import datetime
from quantailabs_patch.risk.circuit_breaker import CircuitBreaker
from quantailabs_patch.risk.position_sizing import PositionSizer
from quantailabs_patch.strategy.filters import EntryFilters, FilterConfig
from quantailabs_patch.strategy.exits import ExitConfig, compute_initial_sl_tp, maybe_adjust_or_exit
from quantailabs_patch.eval.metrics import Metrics
from quantailabs_patch.backtest.execution import ExecCosts, apply_fees_slippage

# --- init ---
breaker = CircuitBreaker()
sizer = PositionSizer(base_risk_per_trade_pct=0.5)
filters = EntryFilters(FilterConfig())
excfg = ExitConfig()
costs = ExecCosts()
metrics = Metrics()

equity_usd = 10_000.0

def on_signal(symbol: str, side: str, price: float, atr: float, adx: float, spread_bps: float, dollar_volume: float, rr_to_tp1: float, model_conf: float):
    global equity_usd
    now = datetime.utcnow()

    ok, reason = breaker.can_open_trade(now, equity_usd)
    if not ok:
        print(f"[{symbol}] Blocked by risk: {reason}"); return

    facts = dict(price=price, atr=atr, adx=adx, spread_bps=spread_bps,
                 dollar_volume=dollar_volume, rr_to_tp1=rr_to_tp1, model_confidence=model_conf)
    passed, reasons = filters.evaluate_entry(facts)
    if not passed:
        print(f"[{symbol}] Entry rejected: {reasons}"); return

    breaker.on_before_open(now, equity_usd)

    # bracket
    sl, tps = compute_initial_sl_tp(price, atr, side, excfg)

    # sizing
    qty = sizer.compute_size(equity_usd, entry_price=price, stop_price=sl)
    if qty <= 0:
        print(f"[{symbol}] Qty=0 (check ATR/SL)."); return

    # simulate execution with costs
    fill_price = apply_fees_slippage("long" if side.lower()=="long" else "short", price, costs, taker=True)
    print(f"[{symbol}] OPEN {side} qty={qty:.6f} entry={fill_price:.4f} SL={sl:.4f} TPs={', '.join(f'{tp:.4f}' for tp in tps)}")

    # ... later: on each tick, check exits (example with one tick)
    last_price = price * 1.01  # +1% move toy example
    decision = maybe_adjust_or_exit(side, price, sl, tps, last_price, atr, adx, cmf=0.1, cfg=excfg)
    if decision["action"] == "take_partial":
        print(f"[{symbol}] Partial take at TP{decision['tp_hit_index']+1}: {last_price:.4f}")
    elif decision["action"] == "move_sl":
        sl = decision["sl"]
        print(f"[{symbol}] Trailing SL -> {sl:.4f}")
    elif decision["action"] == "exit":
        # simulate close
        close_px = apply_fees_slippage("short" if side.lower()=="long" else "long", last_price, costs, taker=True)
        pnl = (close_px - fill_price)/fill_price*100.0 if side.lower()=="long" else (fill_price - close_px)/fill_price*100.0
        equity_usd *= (1 + pnl/100.0)
        metrics.add_trade(pnl)
        breaker.on_trade_result(now, pnl, equity_usd)
        print(f"[{symbol}] EXIT {side} pnl={pnl:.3f}% eq={equity_usd:.2f}")

if __name__ == "__main__":
    on_signal("BTCUSDT", "LONG", price=40000.0, atr=100.0, adx=20.0, spread_bps=2.0, dollar_volume=10_000_000, rr_to_tp1=1.5, model_conf=0.65)
    print("Metrics:", metrics.as_dict())
