import unittest
from datetime import datetime, timedelta
from quantailabs_patch.risk.circuit_breaker import CircuitBreaker


class CircuitBreakerImprovementsTest(unittest.TestCase):
    def test_ignores_tiny_losses(self):
        """Test that losses < -0.1% don't increment consecutive loss counter"""
        breaker = CircuitBreaker(max_consecutive_losses=3)
        now = datetime(2024, 1, 1, 0, 0, 0)
        equity = 10_000.0
        
        # Small loss that should be ignored
        breaker.on_trade_result(now, -0.05, equity)
        self.assertEqual(breaker.consecutive_losses, 0)
        
        # Meaningful loss that should count
        breaker.on_trade_result(now, -0.5, equity)
        self.assertEqual(breaker.consecutive_losses, 1)

    def test_only_resets_on_meaningful_wins(self):
        """Test that only wins > 0.1% reset the consecutive loss counter"""
        breaker = CircuitBreaker(max_consecutive_losses=3)
        now = datetime(2024, 1, 1, 0, 0, 0)
        equity = 10_000.0
        
        # Build up losses
        breaker.on_trade_result(now, -0.5, equity)
        breaker.on_trade_result(now, -0.3, equity)
        self.assertEqual(breaker.consecutive_losses, 2)
        
        # Tiny win should not reset
        breaker.on_trade_result(now, 0.05, equity)
        self.assertEqual(breaker.consecutive_losses, 2)
        
        # Meaningful win should reset
        breaker.on_trade_result(now, 0.5, equity)
        self.assertEqual(breaker.consecutive_losses, 0)

    def test_prevents_false_cooldowns_from_noise(self):
        """Test that noise trades don't trigger cooldowns"""
        breaker = CircuitBreaker(max_consecutive_losses=3, cooldown_minutes=60)
        now = datetime(2024, 1, 1, 0, 0, 0)
        equity = 10_000.0
        
        # Series of tiny losses (noise)
        breaker.on_trade_result(now, -0.05, equity)
        breaker.on_trade_result(now, -0.08, equity)
        breaker.on_trade_result(now, -0.03, equity)
        breaker.on_trade_result(now, -0.07, equity)
        
        # Should still be able to trade (no cooldown from noise)
        ok, reason = breaker.can_open_trade(now, equity)
        self.assertTrue(ok)
        self.assertEqual(breaker.consecutive_losses, 0)

    def test_triggers_cooldown_on_real_losses(self):
        """Test that meaningful losses still trigger cooldown"""
        breaker = CircuitBreaker(max_consecutive_losses=3, cooldown_minutes=60)
        now = datetime(2024, 1, 1, 0, 0, 0)
        equity = 10_000.0
        
        # Three meaningful losses
        breaker.on_trade_result(now, -0.5, equity)
        breaker.on_trade_result(now, -0.8, equity)
        breaker.on_trade_result(now, -1.2, equity)
        
        # Should trigger cooldown
        ok, reason = breaker.can_open_trade(now, equity)
        self.assertFalse(ok)
        self.assertIn('losses', reason.lower())  # Check for 'losses' in lowercase

    def test_mixed_noise_and_real_losses(self):
        """Test handling of mixed tiny and meaningful losses"""
        breaker = CircuitBreaker(max_consecutive_losses=3)
        now = datetime(2024, 1, 1, 0, 0, 0)
        equity = 10_000.0
        
        # Mix of losses
        breaker.on_trade_result(now, -0.05, equity)  # Ignored
        breaker.on_trade_result(now, -0.5, equity)   # Count: 1
        breaker.on_trade_result(now, -0.08, equity)  # Ignored
        breaker.on_trade_result(now, -0.6, equity)   # Count: 2
        
        self.assertEqual(breaker.consecutive_losses, 2)
        
        ok, reason = breaker.can_open_trade(now, equity)
        self.assertTrue(ok)  # Still below 3 consecutive

    def test_size_reduction_based_on_real_losses_only(self):
        """Test that size multiplier only reduces for meaningful losses"""
        breaker = CircuitBreaker(
            max_consecutive_losses=5,
            reduce_size_after_losses=True,
            size_reduction_after_n_losses=2,
            size_reduction_factor=0.5
        )
        now = datetime(2024, 1, 1, 0, 0, 0)
        equity = 10_000.0
        
        # Many tiny losses shouldn't trigger size reduction
        for _ in range(5):
            breaker.on_trade_result(now, -0.05, equity)
        
        self.assertEqual(breaker.size_multiplier(), 1.0)
        
        # Two meaningful losses should trigger reduction
        breaker.on_trade_result(now, -0.5, equity)
        breaker.on_trade_result(now, -0.6, equity)
        
        self.assertEqual(breaker.size_multiplier(), 0.5)


if __name__ == '__main__':
    unittest.main()
