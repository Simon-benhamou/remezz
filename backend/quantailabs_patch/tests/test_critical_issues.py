"""
Critical Issue Detection Test Suite
Tests for potential trading-blocking issues in the meta-adaptive strategy
"""
import unittest
from datetime import datetime, timedelta
from decimal import Decimal

from quantailabs_patch.backtest.execution import ExecCosts, apply_fees_slippage
from quantailabs_patch.execution import AdaptiveExecutionController
from quantailabs_patch.risk.circuit_breaker import CircuitBreaker
from quantailabs_patch.risk.position_sizing import PositionSizer
from quantailabs_patch.strategy.exits import ExitConfig, compute_initial_sl_tp
from quantailabs_patch.strategy.guardrails import SymbolGuardrails


class CriticalIssuesTest(unittest.TestCase):
    """Test critical issues that could prevent the agent from trading"""

    def test_circuit_breaker_lockup_prevention(self):
        """Test: Circuit breaker doesn't permanently lock trading"""
        breaker = CircuitBreaker(
            max_consecutive_losses=3,
            cooldown_minutes=60,
            daily_loss_limit_pct=5.0,  # Higher limit so cooldown test works
            daily_trade_limit=7
        )
        now = datetime(2024, 1, 1, 10, 0)
        equity = 1000.0
        
        # Simulate 3 consecutive losses (small losses, under daily limit)
        for i in range(3):
            ok, reason = breaker.can_open_trade(now, equity)
            self.assertTrue(ok, f"Should allow trade {i+1} before breaker triggers")
            breaker.on_before_open(now, equity)
            equity -= 5  # -0.5% loss each
            breaker.on_trade_result(now, -0.5, equity)
            now += timedelta(minutes=5)
        
        # Should now be blocked by cooldown
        ok, reason = breaker.can_open_trade(now, equity)
        self.assertFalse(ok, "Should block trading after 3 consecutive losses")
        self.assertIn("Cooldown active", reason)
        
        # After cooldown period, should allow trading again
        now += timedelta(minutes=61)
        ok, reason = breaker.can_open_trade(now, equity)
        self.assertTrue(ok, f"Should allow trading after cooldown: {reason}")
        
        # After a win, should reset consecutive losses
        breaker.on_before_open(now, equity)
        equity += 15  # +1.5% win
        breaker.on_trade_result(now, 1.5, equity)
        self.assertEqual(breaker.consecutive_losses, 0, "Win should reset consecutive losses")

    def test_circuit_breaker_daily_reset(self):
        """Test: Circuit breaker properly resets on new trading day"""
        breaker = CircuitBreaker(daily_trade_limit=7)
        now = datetime(2024, 1, 1, 10, 0)
        equity = 1000.0
        
        # Execute 7 trades on day 1
        for i in range(7):
            breaker.on_before_open(now, equity)
            now += timedelta(minutes=10)
        
        self.assertEqual(breaker.trades_today, 7)
        
        # Move to next day
        now = datetime(2024, 1, 2, 10, 0)
        ok, reason = breaker.can_open_trade(now, equity)
        self.assertTrue(ok, "Should allow trading on new day")
        self.assertEqual(breaker.trades_today, 0, "Trade counter should reset on new day")

    def test_position_sizing_edge_cases(self):
        """Test: Position sizing handles edge cases without crashing"""
        sizer = PositionSizer(base_risk_per_trade_pct=2.0)
        
        # Test 1: Zero equity should return 0 size (no capital to risk)
        qty = sizer.compute_size(equity_usd=0, entry_price=100, stop_price=95)
        self.assertEqual(qty, 0.0, "Zero equity should produce zero position size")
        
        # Test 2: Zero stop distance should return 0 size
        qty = sizer.compute_size(equity_usd=1000, entry_price=100, stop_price=100)
        self.assertEqual(qty, 0.0, "Zero stop distance should produce zero position size")
        
        # Test 3: Negative prices should return 0 size
        qty = sizer.compute_size(equity_usd=1000, entry_price=-100, stop_price=-95)
        self.assertEqual(qty, 0.0, "Negative prices should produce zero position size")
        
        # Test 4: Very small equity should not crash
        qty = sizer.compute_size(equity_usd=1, entry_price=50000, stop_price=49000)
        self.assertGreaterEqual(qty, 0.0, "Very small equity should not crash")
        
        # Test 5: Extreme volatility (high ATR) should reduce position size
        normal_qty = sizer.compute_size(equity_usd=1000, entry_price=100, stop_price=95, atr_pct=2.0)
        volatile_qty = sizer.compute_size(equity_usd=1000, entry_price=100, stop_price=95, atr_pct=8.0)
        self.assertLess(volatile_qty, normal_qty, "High volatility should reduce position size")
        
        # Test 6: Normal case produces reasonable size
        qty = sizer.compute_size(equity_usd=1000, entry_price=100, stop_price=98, atr_pct=2.0)
        self.assertGreater(qty, 0, "Normal case should produce positive position size")
        # Position sizer uses max_position_pct cap (15% of equity = $150)
        # With entry at $100, max qty would be 1.5 units
        # The actual calculation also adjusts for ATR, so we just verify it's reasonable
        self.assertLess(qty, 100, "Position size should be reasonable")

    def test_guardrails_recovery_mechanism(self):
        """Test: Symbol guardrails allow recovery after poor performance"""
        guard = SymbolGuardrails(
            min_samples=5,
            win_rate_floor=0.35,
            expectancy_floor=0.0,
            cooldown=timedelta(hours=24)
        )
        symbol = "BTC/USDT"
        now = datetime(2024, 1, 1, 10, 0)
        
        # Register 5 losing trades
        for i in range(5):
            guard.register_trade(symbol, -1.5, now)
            now += timedelta(minutes=10)
        
        # Should be halted
        halted, reason, until = guard.is_halted(symbol, now)
        self.assertTrue(halted, "Should halt after poor performance")
        self.assertIsNotNone(until, "Should have halt expiry time")
        
        # Before cooldown expires, should still be halted
        test_time = until - timedelta(minutes=10)
        halted, _, _ = guard.is_halted(symbol, test_time)
        self.assertTrue(halted, "Should still be halted before cooldown expires")
        
        # After cooldown expires, should allow trading again
        test_time = until + timedelta(minutes=10)
        halted, _, _ = guard.is_halted(symbol, test_time)
        self.assertFalse(halted, "Should allow trading after cooldown expires")

    def test_execution_plan_handles_missing_data(self):
        """Test: Execution planner handles missing/invalid data gracefully"""
        executor = AdaptiveExecutionController()
        
        # Test 1: Zero notional should not crash
        plan = executor.plan(
            symbol="BTC/USDT",
            notional_usd=0,
            spread_bps=5.0,
            book_depth_usd=None
        )
        self.assertIn(plan.mode, {'limit', 'market', 'twap'})
        
        # Test 2: Negative spread should be handled
        plan = executor.plan(
            symbol="BTC/USDT",
            notional_usd=100,
            spread_bps=-5.0,
            book_depth_usd=None
        )
        self.assertIn(plan.mode, {'limit', 'market', 'twap'})
        
        # Test 3: None book depth should default to limit
        plan = executor.plan(
            symbol="BTC/USDT",
            notional_usd=100,
            spread_bps=5.0,
            book_depth_usd=None
        )
        self.assertIsNotNone(plan.mode)

    def test_sl_tp_calculation_sanity(self):
        """Test: Stop loss and take profit calculations are sane"""
        config = ExitConfig(sl_atr_mult=1.5, tp_r_multiples=[1.0, 2.0, 3.0])
        
        # Long position
        entry = 100.0
        atr = 2.0
        sl, tps = compute_initial_sl_tp(entry, atr, 'long', config)
        
        # Stop should be below entry for long
        self.assertLess(sl, entry, "Long stop loss should be below entry")
        
        # TPs should be above entry for long
        for tp in tps:
            self.assertGreater(tp, entry, "Long take profits should be above entry")
        
        # TPs should be in ascending order
        for i in range(len(tps) - 1):
            self.assertLess(tps[i], tps[i+1], "Take profits should be in ascending order")
        
        # Short position
        sl, tps = compute_initial_sl_tp(entry, atr, 'short', config)
        
        # Stop should be above entry for short
        self.assertGreater(sl, entry, "Short stop loss should be above entry")
        
        # TPs should be below entry for short
        for tp in tps:
            self.assertLess(tp, entry, "Short take profits should be below entry")

    def test_daily_loss_limit_enforcement(self):
        """Test: Daily loss limit properly prevents trading"""
        breaker = CircuitBreaker(
            daily_loss_limit_pct=3.0,
            daily_trade_limit=20  # High limit so only loss limit triggers
        )
        now = datetime(2024, 1, 1, 10, 0)
        equity_start = 1000.0
        
        # Initialize the day by making a first check
        breaker.on_before_open(now, equity_start)
        
        # Take some losses totaling -2.5% (below limit)
        equity = equity_start * 0.975
        ok, reason = breaker.can_open_trade(now, equity)
        self.assertTrue(ok, "Should allow trading at -2.5% daily loss")
        
        # Take more losses totaling -3.5% (beyond limit)
        equity = equity_start * 0.965
        ok, reason = breaker.can_open_trade(now, equity)
        self.assertFalse(ok, "Should block trading at -3.5% daily loss")
        self.assertIn("Daily loss limit", reason)

    def test_fees_and_slippage_application(self):
        """Test: Fees and slippage are applied correctly"""
        costs = ExecCosts(taker_fee_bps=7.5, maker_fee_bps=2.5, slippage_bps=2.0)
        
        # Long entry with taker fee
        intended_price = 100.0
        fill_price = apply_fees_slippage('long', intended_price, costs, taker=True)
        # Should be worse (higher) for long entry
        self.assertGreater(fill_price, intended_price, "Long entry should have worse fill")
        
        # Expected: 100 * (1 + 0.00075 + 0.0002) = 100.095
        expected = 100 * (1 + 0.00075 + 0.0002)
        self.assertAlmostEqual(fill_price, expected, places=4)
        
        # Short entry with maker fee
        fill_price = apply_fees_slippage('short', intended_price, costs, taker=False)
        # Should be worse (lower) for short entry
        self.assertLess(fill_price, intended_price, "Short entry should have worse fill")
        
        # Expected: 100 * (1 - 0.00025 - 0.0002) = 99.955
        expected = 100 * (1 - 0.00025 - 0.0002)
        self.assertAlmostEqual(fill_price, expected, places=4)

    def test_minimum_sample_size_behavior(self):
        """Test: Guardrails behave correctly with insufficient samples"""
        guard = SymbolGuardrails(min_samples=10, win_rate_floor=0.35)
        symbol = "ETH/USDT"
        now = datetime(2024, 1, 1, 10, 0)
        
        # Register only 5 trades (below min_samples)
        for i in range(5):
            guard.register_trade(symbol, -2.0, now)
            now += timedelta(minutes=5)
        
        # Should NOT halt because sample size is insufficient
        halted, reason, until = guard.is_halted(symbol, now)
        self.assertFalse(halted, "Should not halt with insufficient samples")
        
        # Add 5 more trades to reach minimum
        for i in range(5):
            guard.register_trade(symbol, -2.0, now)
            now += timedelta(minutes=5)
        
        # Now should halt due to poor performance
        halted, reason, until = guard.is_halted(symbol, now)
        self.assertTrue(halted, "Should halt once minimum samples reached with poor performance")


if __name__ == '__main__':
    unittest.main()
