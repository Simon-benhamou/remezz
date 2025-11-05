import unittest
from quantailabs_patch.risk.position_sizing import PositionSizer


class PositionSizingImprovementsTest(unittest.TestCase):
    def test_position_size_cap_applied(self):
        """Test that max position size cap is enforced"""
        sizer = PositionSizer(
            base_risk_per_trade_pct=2.0,  # High risk %
            max_position_pct=15.0
        )
        equity = 10_000.0
        entry_price = 100.0
        stop_price = 99.0  # Very tight stop
        
        qty = sizer.compute_size(equity, entry_price, stop_price)
        position_value = qty * entry_price
        
        # Position should be capped at 15% of equity
        max_position = equity * 0.15
        self.assertLessEqual(position_value, max_position * 1.01)  # Allow 1% tolerance

    def test_normal_position_not_affected_by_cap(self):
        """Test that normal sized positions are not affected by the cap"""
        sizer = PositionSizer(
            base_risk_per_trade_pct=0.5,
            max_position_pct=15.0
        )
        equity = 10_000.0
        entry_price = 100.0
        stop_price = 95.0  # 5% stop (wider to avoid hitting cap)
        
        qty = sizer.compute_size(equity, entry_price, stop_price)
        position_value = qty * entry_price
        
        # Position should be well below 15% cap for normal risk sizing
        max_position = equity * 0.15
        self.assertLess(position_value, max_position * 0.8)
        # And should be close to what we'd expect from the risk calculation
        expected_risk = equity * 0.005  # 0.5% risk
        expected_qty = expected_risk / (entry_price - stop_price)
        self.assertAlmostEqual(qty, expected_qty, places=2)

    def test_cap_prevents_overleveraging_in_low_volatility(self):
        """Test that cap prevents overleveraging in quiet markets"""
        sizer = PositionSizer(
            base_risk_per_trade_pct=1.0,
            atr_reference_pct=2.0,
            max_position_pct=15.0
        )
        equity = 10_000.0
        entry_price = 100.0
        stop_price = 99.5  # Very tight stop (0.5% - low volatility)
        atr_pct = 0.5  # Low volatility
        
        qty = sizer.compute_size(equity, entry_price, stop_price, atr_pct)
        position_value = qty * entry_price
        
        # Should be capped at 15% despite low volatility boosting size
        max_position = equity * 0.15
        self.assertLessEqual(position_value, max_position * 1.01)

    def test_atr_scaling_still_works_within_cap(self):
        """Test that ATR-based scaling works but respects the cap"""
        sizer = PositionSizer(
            base_risk_per_trade_pct=0.5,
            atr_reference_pct=2.0,
            max_position_pct=15.0
        )
        equity = 10_000.0
        entry_price = 100.0
        stop_price = 98.0
        
        # Low volatility should increase size
        qty_low_vol = sizer.compute_size(equity, entry_price, stop_price, atr_pct=1.0)
        
        # High volatility should decrease size
        qty_high_vol = sizer.compute_size(equity, entry_price, stop_price, atr_pct=4.0)
        
        # Low vol should have larger position (if not capped)
        self.assertGreater(qty_low_vol, qty_high_vol)
        
        # But both should respect the cap
        max_qty = (equity * 0.15) / entry_price
        self.assertLessEqual(qty_low_vol, max_qty * 1.01)
        self.assertLessEqual(qty_high_vol, max_qty * 1.01)

    def test_zero_equity_returns_zero_quantity(self):
        """Test edge case of zero equity"""
        sizer = PositionSizer(max_position_pct=15.0)
        qty = sizer.compute_size(0.0, 100.0, 98.0)
        self.assertEqual(qty, 0.0)

    def test_zero_stop_distance_returns_zero_quantity(self):
        """Test edge case of zero stop distance"""
        sizer = PositionSizer(max_position_pct=15.0)
        qty = sizer.compute_size(10_000.0, 100.0, 100.0)
        self.assertEqual(qty, 0.0)

    def test_negative_entry_returns_zero_quantity(self):
        """Test edge case of negative entry price"""
        sizer = PositionSizer(max_position_pct=15.0)
        qty = sizer.compute_size(10_000.0, -100.0, 98.0)
        self.assertEqual(qty, 0.0)

    def test_cap_value_is_configurable(self):
        """Test that max position % can be configured"""
        sizer_conservative = PositionSizer(
            base_risk_per_trade_pct=1.0,
            max_position_pct=10.0  # More conservative cap
        )
        sizer_aggressive = PositionSizer(
            base_risk_per_trade_pct=1.0,
            max_position_pct=20.0  # More aggressive cap
        )
        
        equity = 10_000.0
        entry_price = 100.0
        stop_price = 99.0
        
        qty_cons = sizer_conservative.compute_size(equity, entry_price, stop_price)
        qty_agg = sizer_aggressive.compute_size(equity, entry_price, stop_price)
        
        # Aggressive should allow larger position
        self.assertGreater(qty_agg, qty_cons)


if __name__ == '__main__':
    unittest.main()
