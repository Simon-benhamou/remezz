import unittest
from datetime import datetime, timedelta

from quantailabs_patch.strategy.guardrails import SymbolGuardrails


class SymbolGuardrailsTest(unittest.TestCase):
    def test_halts_on_poor_performance_and_resets(self):
        guard = SymbolGuardrails(min_samples=5, cooldown=timedelta(hours=24))
        now = datetime(2024, 1, 1, 0, 0, 0)
        # Three losses, two wins => win rate 0.4, expectancy negative
        guard.register_trades('ETH', [-2.0, -1.5, -1.0, 0.5, 0.3], now)
        halted, reason, until = guard.is_halted('ETH', now)
        self.assertTrue(halted)
        self.assertIn(reason, {'win_rate', 'expectancy'})
        self.assertGreater(until, now)

        # After cooldown expires and positive trades arrive, guard clears
        later = now + timedelta(days=1, minutes=1)
        guard.register_trades('ETH', [1.2, 0.8], later)
        halted, _, _ = guard.is_halted('ETH', later)
        self.assertFalse(halted)

    def test_description_reports_metrics(self):
        guard = SymbolGuardrails(min_samples=2)
        guard.register_trades('BTC', [1.0, -0.5])
        summary = guard.describe('BTC')
        self.assertEqual(summary['samples'], 2)
        self.assertAlmostEqual(summary['expectancy'], 0.25)
        self.assertIn('win_rate', summary)


if __name__ == '__main__':
    unittest.main()
