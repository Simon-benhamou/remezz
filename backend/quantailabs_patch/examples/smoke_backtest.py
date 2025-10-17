from __future__ import annotations

from datetime import datetime, timedelta

from quantailabs_patch.backtest.execution import ExecCosts, apply_fees_slippage
from quantailabs_patch.execution import AdaptiveExecutionController
from quantailabs_patch.eval.metrics import Metrics
from quantailabs_patch.risk.circuit_breaker import CircuitBreaker
from quantailabs_patch.risk.position_sizing import PositionSizer
from quantailabs_patch.strategy.exits import ExitConfig, compute_initial_sl_tp
from quantailabs_patch.strategy.guardrails import SymbolGuardrails


def run_smoke_backtest() -> None:
    now = datetime(2024, 1, 1, 0, 0)
    equity = 10_000.0
    breaker = CircuitBreaker()
    guard = SymbolGuardrails(min_samples=3, cooldown=timedelta(hours=6))
    sizer = PositionSizer(base_risk_per_trade_pct=0.6)
    exits_cfg = ExitConfig(sl_atr_mult=1.4, tp_r_multiples=[0.5, 1.0])
    metrics = Metrics()
    executor = AdaptiveExecutionController()
    costs = ExecCosts(taker_fee_bps=7.5, maker_fee_bps=2.5, slippage_bps=1.5)

    prices = [100.0, 101.2, 100.4, 102.0, 101.1]
    atr = 1.1
    symbol = 'SMOKEUSDT'

    for idx, price in enumerate(prices[:-1]):
        halted, reason, until = guard.is_halted(symbol, now)
        if halted:
            print(f"{now.isoformat()} guardrail skip: {reason} until {until.isoformat()}")
            now += timedelta(minutes=5)
            continue
        ok, msg = breaker.can_open_trade(now, equity)
        if not ok:
            print(f"{now.isoformat()} breaker skip: {msg}")
            now += timedelta(minutes=5)
            continue

        sl, tps = compute_initial_sl_tp(price, atr, 'long', exits_cfg)
        atr_pct = (atr / price) * 100
        qty = sizer.compute_size(equity, entry_price=price, stop_price=sl, atr_pct=atr_pct)
        notional = qty * price
        plan = executor.plan(symbol, notional, spread_bps=5.0, book_depth_usd=notional * 0.6)
        fill = apply_fees_slippage('long', price, costs, taker=(plan.mode == 'market'))

        next_price = prices[idx + 1]
        exit_price = apply_fees_slippage('short', next_price, costs, taker=True)
        pnl_pct = (exit_price - fill) / fill * 100.0
        equity *= (1 + pnl_pct / 100.0)
        guard.register_trade(symbol, pnl_pct, now)
        breaker.on_trade_result(now, pnl_pct, equity)
        metrics.add_trade(pnl_pct)
        now += timedelta(minutes=5)

    report = metrics.as_dict()
    print("SMOKE BACKTEST METRICS")
    for key in ("cagr_per_trade", "max_drawdown_pct", "sharpe_like"):
        print(f"{key}: {report.get(key)}")


if __name__ == "__main__":
    run_smoke_backtest()
