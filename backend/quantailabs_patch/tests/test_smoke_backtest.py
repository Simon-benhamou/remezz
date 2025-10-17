import unittest
from datetime import datetime, timedelta

from quantailabs_patch.backtest.execution import ExecCosts, apply_fees_slippage
from quantailabs_patch.execution import AdaptiveExecutionController
from quantailabs_patch.eval.metrics import Metrics
from quantailabs_patch.risk.circuit_breaker import CircuitBreaker
from quantailabs_patch.risk.position_sizing import PositionSizer
from quantailabs_patch.strategy.exits import ExitConfig, compute_initial_sl_tp, maybe_adjust_or_exit
from quantailabs_patch.strategy.guardrails import SymbolGuardrails


class SmokeBacktestTest(unittest.TestCase):
    def test_backtest_cycle(self):
        now = datetime(2024, 1, 1, 0, 0)
        equity = 10_000.0
        breaker = CircuitBreaker()
        guard = SymbolGuardrails(min_samples=3, cooldown=timedelta(hours=6))
        sizer = PositionSizer(base_risk_per_trade_pct=0.6)
        exits_cfg = ExitConfig(sl_atr_mult=1.4, tp_r_multiples=[0.5, 1.0])
        metrics = Metrics()
        executor = AdaptiveExecutionController()
        costs = ExecCosts(taker_fee_bps=7.5, maker_fee_bps=2.5, slippage_bps=1.5)

        prices = [100.0, 101.5, 100.8, 99.5]
        atr = 1.2
        symbol = 'ARBUSDT'

        for idx, price in enumerate(prices[:-1]):
            halted, _, _ = guard.is_halted(symbol, now)
            self.assertFalse(halted)
            ok, _ = breaker.can_open_trade(now, equity)
            self.assertTrue(ok)

            sl, tps = compute_initial_sl_tp(price, atr, 'long', exits_cfg)
            qty = sizer.compute_size(equity, entry_price=price, stop_price=sl, atr_pct=(atr / price) * 100)
            self.assertGreater(qty, 0)

            plan = executor.plan(symbol, qty * price, spread_bps=4.0, book_depth_usd=qty * price * 0.4)
            self.assertIn(plan.mode, {'limit', 'market', 'twap'})
            fill = apply_fees_slippage('long', price, costs, taker=(plan.mode == 'market'))

            # Next price determines exit decision
            next_price = prices[idx + 1]
            decision = maybe_adjust_or_exit('long', price, sl, tps, next_price, atr, adx=25.0, cmf=0.2, cfg=exits_cfg)
            if decision['action'] == 'move_sl':
                sl = decision['sl']
                decision = {'action': 'hold'}

            close_price = apply_fees_slippage('short', next_price, costs, taker=True)
            pnl_pct = (close_price - fill) / fill * 100.0
            equity *= (1 + pnl_pct / 100.0)
            metrics.add_trade(pnl_pct)
            guard.register_trade(symbol, pnl_pct, now)
            breaker.on_trade_result(now, pnl_pct, equity)
            now += timedelta(minutes=5)

        report = metrics.as_dict()
        self.assertGreater(report['n'], 0)
        self.assertIn('cagr_per_trade', report)
        self.assertIn('sharpe_like', report)
        self.assertIn('max_drawdown_pct', report)


if __name__ == '__main__':
    unittest.main()
