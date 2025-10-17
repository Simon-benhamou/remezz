import unittest
from datetime import datetime, timedelta

from quantailabs_patch.strategy.refresh import CachedStrategy, StrategyCache


class StrategyRefreshTest(unittest.TestCase):
    def test_prefers_high_expectancy_and_matching_regime(self):
        cache = StrategyCache(max_age=timedelta(minutes=30))
        now = datetime(2024, 1, 1, 12, 0, 0)
        cache.add('SOL', CachedStrategy('a', expectancy=0.2, win_rate=0.55, created_at=now - timedelta(minutes=5), regime_tag='trend'))
        cache.add('SOL', CachedStrategy('b', expectancy=0.25, win_rate=0.52, created_at=now - timedelta(minutes=10), regime_tag='mean'))
        cache.add('SOL', CachedStrategy('c', expectancy=0.18, win_rate=0.6, created_at=now - timedelta(minutes=2), regime_tag='trend'))

        picked = cache.resolve('SOL', regime_tag='trend', now=now)
        self.assertIsNotNone(picked)
        self.assertEqual(picked.strategy_id, 'a')  # highest expectancy within regime

        picked_any = cache.resolve('SOL', regime_tag=None, now=now)
        self.assertEqual(picked_any.strategy_id, 'b')  # absolute best expectancy

    def test_discards_stale_entries(self):
        cache = StrategyCache(max_age=timedelta(minutes=15))
        now = datetime(2024, 1, 1, 12, 0, 0)
        cache.add('BTC', CachedStrategy('old', expectancy=0.5, win_rate=0.7, created_at=now - timedelta(minutes=20)))
        cache.add('BTC', CachedStrategy('fresh', expectancy=0.4, win_rate=0.68, created_at=now - timedelta(minutes=1)))
        picked = cache.resolve('BTC', regime_tag='trend', now=now)
        self.assertEqual(picked.strategy_id, 'fresh')


if __name__ == '__main__':
    unittest.main()
