"""
Unit tests for hybrid smart exit logic.
Tests counter-signal awareness, adaptive peak drawdown protection, 
and multi-indicator technical reversal detection.
"""
import unittest
from quantailabs_patch.strategy.exits import (
    ExitConfig, HybridExitConfig, TechnicalSnapshot,
    compute_initial_sl_tp, maybe_adjust_or_exit,
    calculate_reversal_score, check_counter_signal_exit,
    check_peak_drawdown_exit, check_reversal_exit,
    get_peak_drawdown_threshold
)


class TestCounterSignalExit(unittest.TestCase):
    """Test counter-signal awareness logic"""
    
    def test_strong_counter_signal_triggers_exit_long(self):
        """Strong counter-signal (short) should exit long position at 0.5R+"""
        cfg = HybridExitConfig()
        should_exit, should_tighten, reason = check_counter_signal_exit(
            side='long',
            counter_signal_side='short',
            counter_signal_confidence=0.75,
            r_now=0.6,
            config=cfg
        )
        self.assertTrue(should_exit)
        self.assertIsNone(should_tighten)
        self.assertIn('Counter-signal exit', reason)
        self.assertIn('short', reason.lower())
    
    def test_strong_counter_signal_triggers_exit_short(self):
        """Strong counter-signal (long) should exit short position at 0.5R+"""
        cfg = HybridExitConfig()
        should_exit, should_tighten, reason = check_counter_signal_exit(
            side='short',
            counter_signal_side='long',
            counter_signal_confidence=0.8,
            r_now=0.7,
            config=cfg
        )
        self.assertTrue(should_exit)
        self.assertIsNone(should_tighten)
        self.assertIn('Counter-signal exit', reason)
    
    def test_medium_counter_signal_tightens_stop(self):
        """Medium confidence counter-signal should tighten stop at 0.25R+"""
        cfg = HybridExitConfig()
        should_exit, should_tighten, reason = check_counter_signal_exit(
            side='long',
            counter_signal_side='short',
            counter_signal_confidence=0.65,
            r_now=0.35,
            config=cfg
        )
        self.assertFalse(should_exit)
        self.assertEqual(should_tighten, 'tighten')
        self.assertIn('Counter-signal tighten', reason)
    
    def test_counter_signal_below_threshold_no_action(self):
        """Counter-signal below minimum R should not trigger"""
        cfg = HybridExitConfig()
        should_exit, should_tighten, reason = check_counter_signal_exit(
            side='long',
            counter_signal_side='short',
            counter_signal_confidence=0.75,
            r_now=0.2,  # Below min_r threshold (0.5R)
            config=cfg
        )
        self.assertFalse(should_exit)
        self.assertIsNone(should_tighten)
        self.assertIsNone(reason)
    
    def test_same_direction_signal_ignored(self):
        """Same direction signal should not be treated as counter-signal"""
        cfg = HybridExitConfig()
        should_exit, should_tighten, reason = check_counter_signal_exit(
            side='long',
            counter_signal_side='long',  # Same direction
            counter_signal_confidence=0.9,
            r_now=3.0,
            config=cfg
        )
        self.assertFalse(should_exit)
        self.assertIsNone(should_tighten)
        self.assertIsNone(reason)
    
    def test_disabled_counter_signal_exits(self):
        """Disabled counter-signal exits should not trigger"""
        cfg = HybridExitConfig(enable_counter_signal_exits=False)
        should_exit, should_tighten, reason = check_counter_signal_exit(
            side='long',
            counter_signal_side='short',
            counter_signal_confidence=0.9,
            r_now=3.0,
            config=cfg
        )
        self.assertFalse(should_exit)
        self.assertIsNone(should_tighten)
        self.assertIsNone(reason)


class TestPeakDrawdownProtection(unittest.TestCase):
    """Test adaptive peak drawdown protection"""
    
    def test_peak_drawdown_threshold_selection(self):
        """Test correct threshold selection based on R-multiple"""
        cfg = HybridExitConfig()
        
        # At 1R, should use 5% threshold
        threshold = get_peak_drawdown_threshold(1.0, cfg)
        self.assertEqual(threshold, 0.05)
        
        # At 2.5R, should use 4% threshold (2R tier)
        threshold = get_peak_drawdown_threshold(2.5, cfg)
        self.assertEqual(threshold, 0.04)
        
        # At 5R+, should use 2% threshold
        threshold = get_peak_drawdown_threshold(6.0, cfg)
        self.assertEqual(threshold, 0.02)
    
    def test_peak_drawdown_exit_long(self):
        """Test peak drawdown protection for long position"""
        cfg = HybridExitConfig()
        
        # Entry at 100, peak at 110 (10% gain, ~3.3R), now at 106.5
        # Drawdown: (110 - 106.5) / 110 = 3.18%
        # At 3.3R, threshold is 3%, should exit
        should_exit, reason = check_peak_drawdown_exit(
            side='long',
            entry_price=100.0,
            peak_price=110.0,
            current_price=106.5,
            r_now=3.3,
            config=cfg
        )
        self.assertTrue(should_exit)
        self.assertIn('Peak drawdown exit', reason)
        self.assertIn('3.2%', reason)  # Drawdown percentage
        self.assertIn('3.0%', reason)  # Threshold
    
    def test_peak_drawdown_exit_short(self):
        """Test peak drawdown protection for short position"""
        cfg = HybridExitConfig()
        
        # Entry at 100, peak at 90 (10% gain), now at 93.5
        # Drawdown: (93.5 - 90) / 90 = 3.89%
        # At 3.3R, threshold is 3%, should exit
        should_exit, reason = check_peak_drawdown_exit(
            side='short',
            entry_price=100.0,
            peak_price=90.0,
            current_price=93.5,
            r_now=3.3,
            config=cfg
        )
        self.assertTrue(should_exit)
        self.assertIn('Peak drawdown exit', reason)
    
    def test_peak_drawdown_within_threshold(self):
        """Drawdown within threshold should not exit"""
        cfg = HybridExitConfig()
        
        # Small drawdown within acceptable range
        should_exit, reason = check_peak_drawdown_exit(
            side='long',
            entry_price=100.0,
            peak_price=110.0,
            current_price=107.7,  # 2.1% drawdown
            r_now=3.3,  # 3% threshold applies
            config=cfg
        )
        self.assertFalse(should_exit)
        self.assertIsNone(reason)
    
    def test_no_peak_yet_no_exit(self):
        """No peak to protect should not trigger exit"""
        cfg = HybridExitConfig()
        
        # Price hasn't moved past entry yet
        should_exit, reason = check_peak_drawdown_exit(
            side='long',
            entry_price=100.0,
            peak_price=99.0,  # Below entry
            current_price=98.0,
            r_now=0.5,
            config=cfg
        )
        self.assertFalse(should_exit)
        self.assertIsNone(reason)
    
    def test_disabled_peak_drawdown_protection(self):
        """Disabled peak drawdown protection should not trigger"""
        cfg = HybridExitConfig(enable_peak_drawdown_protection=False)
        should_exit, reason = check_peak_drawdown_exit(
            side='long',
            entry_price=100.0,
            peak_price=110.0,
            current_price=100.0,  # 9% drawdown
            r_now=3.0,
            config=cfg
        )
        self.assertFalse(should_exit)
        self.assertIsNone(reason)


class TestTechnicalReversalDetection(unittest.TestCase):
    """Test multi-indicator technical reversal detection"""
    
    def test_reversal_score_ema_crossover_long(self):
        """Test EMA crossover detection for long positions"""
        current = TechnicalSnapshot(
            ema_fast=98.0,
            ema_slow=100.0,  # Fast crossed below slow (bearish)
            price=99.0
        )
        previous = TechnicalSnapshot(
            ema_fast=101.0,
            ema_slow=100.0,  # Fast was above slow
            price=101.0
        )
        
        score = calculate_reversal_score('long', current, previous)
        self.assertGreater(score, 20)  # Should get points for EMA cross
    
    def test_reversal_score_ema_crossover_short(self):
        """Test EMA crossover detection for short positions"""
        current = TechnicalSnapshot(
            ema_fast=102.0,
            ema_slow=100.0,  # Fast crossed above slow (bullish)
            price=101.0
        )
        previous = TechnicalSnapshot(
            ema_fast=99.0,
            ema_slow=100.0,  # Fast was below slow
            price=99.0
        )
        
        score = calculate_reversal_score('short', current, previous)
        self.assertGreater(score, 20)  # Should get points for EMA cross
    
    def test_reversal_score_macd_crossover(self):
        """Test MACD crossover contributes to reversal score"""
        current = TechnicalSnapshot(
            macd=-0.5,
            macd_signal=0.5,  # MACD below signal (bearish)
            price=100.0
        )
        previous = TechnicalSnapshot(
            macd=0.6,
            macd_signal=0.5,  # MACD was above signal
            price=101.0
        )
        
        score = calculate_reversal_score('long', current, previous)
        self.assertGreater(score, 15)
    
    def test_reversal_score_rsi_extreme(self):
        """Test RSI extreme levels contribute to reversal score"""
        current = TechnicalSnapshot(
            rsi=75.0,  # Overbought
            price=100.0
        )
        
        score = calculate_reversal_score('long', current, None)
        self.assertGreater(score, 15)  # Should get points for overbought RSI
    
    def test_reversal_score_volume_drop(self):
        """Test volume drop contributes to reversal score"""
        current = TechnicalSnapshot(
            volume=50000,
            price=100.0
        )
        previous = TechnicalSnapshot(
            volume=100000,  # 50% volume drop
            price=99.0
        )
        
        score = calculate_reversal_score('long', current, previous)
        self.assertGreater(score, 10)
    
    def test_reversal_score_support_break_long(self):
        """Test support break contributes to reversal score for longs"""
        current = TechnicalSnapshot(
            price=95.0,
            support_level=98.0  # Price broke below support
        )
        
        score = calculate_reversal_score('long', current, None)
        self.assertGreater(score, 10)
    
    def test_reversal_score_resistance_break_short(self):
        """Test resistance break contributes to reversal score for shorts"""
        current = TechnicalSnapshot(
            price=105.0,
            resistance_level=102.0  # Price broke above resistance
        )
        
        score = calculate_reversal_score('short', current, None)
        self.assertGreater(score, 10)
    
    def test_reversal_score_multiple_indicators(self):
        """Test combined indicators give high reversal score"""
        current = TechnicalSnapshot(
            ema_fast=98.0,
            ema_slow=100.0,  # Bearish EMA
            macd=-0.5,
            macd_signal=0.5,  # Bearish MACD
            rsi=75.0,  # Overbought
            volume=30000,
            support_level=99.0,
            price=97.0  # Below support
        )
        previous = TechnicalSnapshot(
            ema_fast=101.0,
            ema_slow=100.0,
            macd=0.6,
            macd_signal=0.5,
            volume=100000,
            price=101.0
        )
        
        score = calculate_reversal_score('long', current, previous)
        self.assertGreater(score, 70)  # Should be high with all indicators aligned
    
    def test_reversal_exit_on_high_score(self):
        """Test that high reversal score triggers exit"""
        cfg = HybridExitConfig()
        
        # High reversal score scenario
        current = TechnicalSnapshot(
            ema_fast=98.0,
            ema_slow=100.0,
            macd=-0.5,
            macd_signal=0.5,
            rsi=75.0,
            volume=30000,
            support_level=99.0,
            price=97.0
        )
        previous = TechnicalSnapshot(
            ema_fast=101.0,
            ema_slow=100.0,
            macd=0.6,
            macd_signal=0.5,
            volume=100000,
            price=101.0
        )
        
        should_exit, should_tighten, reason = check_reversal_exit(
            side='long',
            current_snapshot=current,
            previous_snapshot=previous,
            r_now=0.6,
            config=cfg
        )
        self.assertTrue(should_exit)
        self.assertIn('Technical reversal exit', reason)
    
    def test_reversal_tighten_on_medium_score(self):
        """Test that medium reversal score tightens stop"""
        cfg = HybridExitConfig()
        
        # Medium reversal score scenario
        current = TechnicalSnapshot(
            ema_fast=98.0,
            ema_slow=100.0,
            rsi=68.0,
            price=99.0
        )
        previous = TechnicalSnapshot(
            ema_fast=101.0,
            ema_slow=100.0,
            price=101.0
        )
        
        should_exit, should_tighten, reason = check_reversal_exit(
            side='long',
            current_snapshot=current,
            previous_snapshot=previous,
            r_now=0.35,
            config=cfg
        )
        self.assertFalse(should_exit)
        self.assertEqual(should_tighten, 'tighten')
        self.assertIn('Technical reversal tighten', reason)
    
    def test_reversal_detection_disabled(self):
        """Test that disabled reversal detection doesn't trigger"""
        cfg = HybridExitConfig(enable_reversal_detection=False)
        
        current = TechnicalSnapshot(
            ema_fast=98.0,
            ema_slow=100.0,
            macd=-0.5,
            macd_signal=0.5,
            rsi=75.0,
            price=97.0
        )
        
        should_exit, should_tighten, reason = check_reversal_exit(
            side='long',
            current_snapshot=current,
            previous_snapshot=None,
            r_now=0.6,
            config=cfg
        )
        self.assertFalse(should_exit)
        self.assertIsNone(should_tighten)
        self.assertIsNone(reason)


class TestHybridExitIntegration(unittest.TestCase):
    """Test integration of hybrid exit logic with main exit function"""
    
    def test_hybrid_counter_signal_overrides_trailing(self):
        """Counter-signal exit should take priority over trailing stop"""
        cfg = ExitConfig(
            trail_after_r=0.8,
            trail_atr_mult=1.0,
            hybrid=HybridExitConfig()
        )
        entry = 100.0
        atr = 2.0
        sl, tps = compute_initial_sl_tp(entry, atr, 'long', cfg)
        
        # At 0.6R profit with strong counter-signal
        last_price = entry + 0.6 * abs(entry - sl)
        
        decision = maybe_adjust_or_exit(
            'long', entry, sl, tps, last_price, atr, 
            adx=25.0, cmf=0.2, cfg=cfg,
            counter_signal_side='short',
            counter_signal_confidence=0.8
        )
        
        self.assertEqual(decision['action'], 'exit')
        self.assertIn('Counter-signal exit', decision['reason'])
    
    def test_hybrid_peak_drawdown_triggers_exit(self):
        """Peak drawdown protection should exit on excessive giveback"""
        cfg = ExitConfig(
            trail_after_r=0.8,
            trail_atr_mult=1.0,
            hybrid=HybridExitConfig()
        )
        entry = 643.0
        atr = 10.0
        sl, tps = compute_initial_sl_tp(entry, atr, 'long', cfg)
        
        # Peak at 670, now at 650 (realistic ZEC/USDT scenario from issue)
        peak = 670.0
        current = 650.0
        risk = abs(entry - sl)
        r_now = (current - entry) / risk  # About 0.47R
        
        # Actually let's test with a proper scenario
        # Entry 643, peak 670 (+27, ~4.2% gain)
        # If risk is 6.5 (15 ATR), that's about 4.15R
        # Current at 655 gives drawdown of (670-655)/670 = 2.24%
        # At 4R+, threshold is 3%, should hold
        # But at 650: (670-650)/670 = 2.99%, should still hold
        # At 647: (670-647)/670 = 3.43%, should EXIT
        
        decision = maybe_adjust_or_exit(
            'long', entry, sl, tps, 647.0, atr,
            adx=25.0, cmf=0.2, cfg=cfg,
            peak_price=peak
        )
        
        # This should trigger peak drawdown exit
        # Let me calculate: at entry 643, peak 670, current 647
        # Risk = 15, so r_now = (647-643)/15 = 0.27R
        # Peak is above entry, drawdown = (670-647)/670 = 3.43%
        # But r_now is only 0.27, so no threshold applies yet
        # Let's fix the test scenario
        
        # Better: use a scenario where we're clearly at 3R+
        entry = 100.0
        sl = 95.0  # 5 risk
        risk = 5.0
        peak = 115.0  # 3R profit
        current = 111.5  # 3% drawdown from peak
        r_now = (current - entry) / risk  # 2.3R
        
        decision = maybe_adjust_or_exit(
            'long', entry, sl, tps, current, atr,
            adx=25.0, cmf=0.2, cfg=cfg,
            peak_price=peak
        )
        
        # At 2.3R, threshold is 4%, drawdown is 3%, should hold
        self.assertNotEqual(decision['action'], 'exit')
        
        # Now test with 4.5% drawdown (should exit)
        current = 110.25
        decision = maybe_adjust_or_exit(
            'long', entry, sl, tps, current, atr,
            adx=25.0, cmf=0.2, cfg=cfg,
            peak_price=peak
        )
        
        self.assertEqual(decision['action'], 'exit')
        self.assertIn('Peak drawdown exit', decision['reason'])
    
    def test_hybrid_reversal_triggers_exit(self):
        """Technical reversal should trigger exit with high score"""
        cfg = ExitConfig(
            trail_after_r=0.8,
            trail_atr_mult=1.0,
            hybrid=HybridExitConfig()
        )
        entry = 100.0
        atr = 2.0
        sl, tps = compute_initial_sl_tp(entry, atr, 'long', cfg)
        
        # At 0.7R with strong reversal signals
        last_price = 102.1
        
        current_snap = TechnicalSnapshot(
            ema_fast=98.0,
            ema_slow=100.0,
            macd=-0.5,
            macd_signal=0.5,
            rsi=75.0,
            volume=30000,
            support_level=99.0,
            price=102.1
        )
        previous_snap = TechnicalSnapshot(
            ema_fast=101.0,
            ema_slow=100.0,
            macd=0.6,
            macd_signal=0.5,
            volume=100000,
            price=101.0
        )
        
        decision = maybe_adjust_or_exit(
            'long', entry, sl, tps, last_price, atr,
            adx=25.0, cmf=0.2, cfg=cfg,
            technical_snapshot=current_snap,
            previous_snapshot=previous_snap
        )
        
        self.assertEqual(decision['action'], 'exit')
        self.assertIn('reversal', decision['reason'].lower())
    
    def test_hybrid_defaults_to_trailing_when_inactive(self):
        """Should use normal trailing stop when no hybrid signals"""
        cfg = ExitConfig(
            trail_after_r=0.8,
            trail_atr_mult=1.0,
            breakeven_after_r=1.5,  # Set high so we don't hit breakeven first
            tp_r_multiples=[2.0, 3.0, 4.0],  # Set TPs higher to avoid hitting them
            hybrid=HybridExitConfig()
        )
        entry = 100.0
        atr = 2.0
        sl, tps = compute_initial_sl_tp(entry, atr, 'long', cfg)
        
        # At 1R profit with no hybrid signals (price moved up)
        risk = abs(entry - sl)
        last_price = entry + 1.0 * risk
        
        decision = maybe_adjust_or_exit(
            'long', entry, sl, tps, last_price, atr,
            adx=25.0, cmf=0.2, cfg=cfg
        )
        
        # Should use trailing logic (r_now = 1.0R >= trail_after_r = 0.8R)
        self.assertEqual(decision['action'], 'move_sl')
        self.assertIn('Trailing', decision['reason'])
    
    def test_hybrid_works_for_short_positions(self):
        """Hybrid logic should work correctly for short positions"""
        cfg = ExitConfig(
            trail_after_r=0.8,
            trail_atr_mult=1.0,
            hybrid=HybridExitConfig()
        )
        entry = 100.0
        atr = 2.0
        sl, tps = compute_initial_sl_tp(entry, atr, 'short', cfg)
        
        # At 0.6R profit with counter-signal (long)
        last_price = entry - 0.6 * abs(entry - sl)
        
        decision = maybe_adjust_or_exit(
            'short', entry, sl, tps, last_price, atr,
            adx=25.0, cmf=0.2, cfg=cfg,
            counter_signal_side='long',
            counter_signal_confidence=0.8
        )
        
        self.assertEqual(decision['action'], 'exit')
        self.assertIn('Counter-signal exit', decision['reason'])
    
    def test_tightening_uses_aggressive_stop(self):
        """Hybrid tightening should use 0.3x ATR (more aggressive)"""
        cfg = ExitConfig(
            trail_after_r=0.8,
            trail_atr_mult=1.0,
            hybrid=HybridExitConfig()
        )
        entry = 100.0
        atr = 2.0
        sl, tps = compute_initial_sl_tp(entry, atr, 'long', cfg)
        
        # At 0.35R with medium counter-signal
        last_price = entry + 0.35 * abs(entry - sl)
        
        decision = maybe_adjust_or_exit(
            'long', entry, sl, tps, last_price, atr,
            adx=25.0, cmf=0.2, cfg=cfg,
            counter_signal_side='short',
            counter_signal_confidence=0.65
        )
        
        self.assertEqual(decision['action'], 'move_sl')
        self.assertIn('Counter-signal tighten', decision['reason'])
        
        # New SL should be last_price - 0.3 * atr (aggressive)
        expected_sl = last_price - 0.3 * cfg.trail_atr_mult * atr
        self.assertAlmostEqual(decision['sl'], expected_sl, places=2)


class TestVolatileReversalScenarios(unittest.TestCase):
    """Test real-world volatile reversal scenarios"""
    
    def test_zec_usdt_reversal_scenario(self):
        """Test the ZEC/USDT scenario from the issue description"""
        cfg = ExitConfig(
            trail_after_r=0.8,
            trail_atr_mult=1.0,
            hybrid=HybridExitConfig()
        )
        
        # Entry at 643, ATR ~10, SL at 628 (1.5 ATR)
        entry = 643.0
        atr = 10.0
        sl = 628.0  # 15 risk
        risk = 15.0
        tps = [643 + 2*risk, 643 + 3.2*risk, 643 + 4.6*risk]
        
        # Peak at 670 (~1.8R, +4.2%)
        peak = 670.0
        
        # Reversal back to 655
        current = 655.0
        r_now = (current - entry) / risk  # 0.8R
        
        # With counter-signal (rotation to short)
        decision = maybe_adjust_or_exit(
            'long', entry, sl, tps, current, atr,
            adx=22.0, cmf=0.1, cfg=cfg,
            peak_price=peak,
            counter_signal_side='short',
            counter_signal_confidence=0.75
        )
        
        # Should exit now (R = 0.8R >= 0.5R threshold for counter-signal exit)
        self.assertEqual(decision['action'], 'exit')
        self.assertIn('Counter-signal', decision['reason'])
        
        # Also test that it triggers earlier at just above 0.5R
        current = 650.5  # Just above 0.5R
        r_now = (current - entry) / risk  # ~0.5R
        
        decision = maybe_adjust_or_exit(
            'long', entry, sl, tps, current, atr,
            adx=22.0, cmf=0.1, cfg=cfg,
            peak_price=peak,
            counter_signal_side='short',
            counter_signal_confidence=0.75
        )
        
        # Should exit on counter-signal at 0.5R+
        self.assertEqual(decision['action'], 'exit')
        self.assertIn('Counter-signal', decision['reason'])
    
    def test_crypto_trend_reversal_with_all_signals(self):
        """Test scenario with all hybrid signals firing"""
        cfg = ExitConfig(
            trail_after_r=0.8,
            trail_atr_mult=1.0,
            hybrid=HybridExitConfig()
        )
        
        entry = 100.0
        atr = 3.0
        sl = 95.5  # 4.5 risk
        risk = 4.5
        tps = [100 + 2*risk, 100 + 3.2*risk, 100 + 4.6*risk]
        
        # Reached 5R, now giving back
        peak = 122.5  # 5R
        current = 120.0  # 2% drawdown from peak
        
        # Strong reversal signals
        current_snap = TechnicalSnapshot(
            ema_fast=119.0,
            ema_slow=121.0,  # Bearish cross
            macd=-0.8,
            macd_signal=0.3,  # Bearish MACD
            rsi=78.0,  # Overbought
            volume=40000,
            support_level=118.0,
            price=120.0
        )
        previous_snap = TechnicalSnapshot(
            ema_fast=122.0,
            ema_slow=121.0,
            macd=0.5,
            macd_signal=0.3,
            volume=120000,
            price=122.0
        )
        
        decision = maybe_adjust_or_exit(
            'long', entry, sl, tps, current, atr,
            adx=18.0, cmf=-0.1, cfg=cfg,
            peak_price=peak,
            counter_signal_side='short',
            counter_signal_confidence=0.8,
            technical_snapshot=current_snap,
            previous_snapshot=previous_snap
        )
        
        # Should exit (counter-signal takes priority)
        self.assertEqual(decision['action'], 'exit')


if __name__ == '__main__':
    unittest.main()
