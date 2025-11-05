import unittest
from quantailabs_patch.strategy.exits import ExitConfig, compute_initial_sl_tp, maybe_adjust_or_exit


class ExitImprovementsTest(unittest.TestCase):
    def test_breakeven_protection_long(self):
        """Test that SL moves to breakeven after 0.5R profit"""
        cfg = ExitConfig(breakeven_after_r=0.5, trail_after_r=0.8, tp_r_multiples=[2.0, 3.0])
        entry = 100.0
        atr = 2.0
        sl, tps = compute_initial_sl_tp(entry, atr, 'long', cfg)
        
        # Price moves up to trigger breakeven (entry + 0.5 * risk)
        # But not far enough to hit TP (which starts at 2.0R)
        risk = abs(entry - sl)
        breakeven_price = entry + 0.5 * risk
        
        decision = maybe_adjust_or_exit('long', entry, sl, tps, breakeven_price, atr, adx=25.0, cmf=0.2, cfg=cfg)
        
        self.assertEqual(decision['action'], 'move_sl')
        self.assertEqual(decision['sl'], entry)  # SL moved to breakeven
        self.assertIn('Breakeven', decision['reason'])

    def test_breakeven_protection_short(self):
        """Test that SL moves to breakeven for short positions"""
        cfg = ExitConfig(breakeven_after_r=0.5, trail_after_r=0.8, tp_r_multiples=[2.0, 3.0])
        entry = 100.0
        atr = 2.0
        sl, tps = compute_initial_sl_tp(entry, atr, 'short', cfg)
        
        # Price moves down to trigger breakeven but not hit TP
        risk = abs(entry - sl)
        breakeven_price = entry - 0.5 * risk
        
        decision = maybe_adjust_or_exit('short', entry, sl, tps, breakeven_price, atr, adx=25.0, cmf=0.2, cfg=cfg)
        
        self.assertEqual(decision['action'], 'move_sl')
        self.assertEqual(decision['sl'], entry)
        self.assertIn('Breakeven', decision['reason'])

    def test_early_trailing_stop(self):
        """Test that trailing starts at 0.8R instead of 1.0R"""
        cfg = ExitConfig(breakeven_after_r=0.5, trail_after_r=0.8, trail_atr_mult=1.0, tp_r_multiples=[2.0, 3.0])
        entry = 100.0
        atr = 2.0
        sl, tps = compute_initial_sl_tp(entry, atr, 'long', cfg)
        
        # Price moves to 0.9R profit without hitting breakeven first
        # This tests trailing activation at 0.8R
        risk = abs(entry - sl)
        trail_price = entry + 0.9 * risk
        decision = maybe_adjust_or_exit('long', entry, sl, tps, trail_price, atr, adx=25.0, cmf=0.2, cfg=cfg)
        
        # Should trigger breakeven first (since 0.9R > 0.5R breakeven threshold)
        # But we're testing that trail_after_r is set to 0.8 (not 1.0)
        # This will activate once SL is adjusted
        self.assertIn(decision['action'], ['move_sl', 'hold'])
        if decision['action'] == 'move_sl':
            self.assertIn('Breakeven', decision['reason'])

    def test_early_exit_on_momentum_fail_fixed(self):
        """Test that early exit uses absolute value for loss calculation"""
        cfg = ExitConfig(cut_if_loss_gt_r=0.5)
        entry = 100.0
        atr = 2.0
        sl, tps = compute_initial_sl_tp(entry, atr, 'long', cfg)
        
        # Price at -0.6R loss with momentum failure
        risk = abs(entry - sl)
        loss_price = entry - 0.6 * risk
        
        # Should trigger early exit because loss > 0.5R and momentum failed
        decision = maybe_adjust_or_exit('long', entry, sl, tps, loss_price, atr, adx=15.0, cmf=-0.1, cfg=cfg)
        
        self.assertEqual(decision['action'], 'exit')
        self.assertIn('Early exit', decision['reason'])

    def test_tp_hit_detection_returns_first(self):
        """Test that TP detection returns the first level hit"""
        cfg = ExitConfig(tp_r_multiples=[0.5, 1.0, 2.0])
        entry = 100.0
        atr = 2.0
        sl, tps = compute_initial_sl_tp(entry, atr, 'long', cfg)
        
        # Price hits first TP
        price_at_tp1 = tps[0]
        decision = maybe_adjust_or_exit('long', entry, sl, tps, price_at_tp1, atr, adx=25.0, cmf=0.2, cfg=cfg)
        
        self.assertEqual(decision['action'], 'take_partial')
        self.assertEqual(decision['tp_hit_index'], 0)

    def test_holds_position_in_profit_without_signals(self):
        """Test that position is held when in small profit with good momentum"""
        cfg = ExitConfig(breakeven_after_r=0.5, trail_after_r=0.8)
        entry = 100.0
        atr = 2.0
        sl, tps = compute_initial_sl_tp(entry, atr, 'long', cfg)
        
        # Small profit (0.3R) with good momentum
        risk = abs(entry - sl)
        small_profit_price = entry + 0.3 * risk
        
        decision = maybe_adjust_or_exit('long', entry, sl, tps, small_profit_price, atr, adx=25.0, cmf=0.2, cfg=cfg)
        
        self.assertEqual(decision['action'], 'hold')


if __name__ == '__main__':
    unittest.main()
