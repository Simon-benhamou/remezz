import unittest
from quantailabs_patch.strategy.filters import FilterConfig, EntryFilters


class FilterImprovementsTest(unittest.TestCase):
    def test_adaptive_confidence_with_strong_adx(self):
        """Test that confidence threshold reduces with strong ADX"""
        cfg = FilterConfig(confidence_threshold=0.52, adaptive_confidence=True)
        filters = EntryFilters(cfg)
        
        facts = {
            "model_confidence": 0.50,  # Below base threshold
            "adx": 26.0,  # Strong ADX
            "atr": 0.5,
            "price": 100.0,
            "spread_bps": 5.0,
            "dollar_volume": 600_000.0,
            "rr_to_tp1": 1.5
        }
        
        ok, reasons = filters.evaluate_entry(facts)
        
        # Should pass because threshold reduced from 0.52 to 0.47
        self.assertTrue(ok)
        self.assertIn('OK', reasons['confidenceOk'])

    def test_adaptive_confidence_with_high_rr(self):
        """Test that confidence threshold reduces with high risk/reward"""
        cfg = FilterConfig(confidence_threshold=0.52, adaptive_confidence=True)
        filters = EntryFilters(cfg)
        
        facts = {
            "model_confidence": 0.48,  # Below base threshold
            "adx": 20.0,
            "atr": 0.5,
            "price": 100.0,
            "spread_bps": 5.0,
            "dollar_volume": 600_000.0,
            "rr_to_tp1": 2.5  # High RR
        }
        
        ok, reasons = filters.evaluate_entry(facts)
        
        # Should pass because threshold reduced
        self.assertTrue(ok)

    def test_adaptive_confidence_with_multiple_strong_signals(self):
        """Test maximum threshold reduction with multiple strong signals"""
        cfg = FilterConfig(confidence_threshold=0.52, adaptive_confidence=True)
        filters = EntryFilters(cfg)
        
        facts = {
            "model_confidence": 0.46,  # Well below base threshold
            "adx": 26.0,  # Strong ADX (+0.05 reduction)
            "atr": 0.5,
            "price": 100.0,
            "spread_bps": 5.0,
            "dollar_volume": 900_000.0,  # High volume (+0.05 reduction)
            "rr_to_tp1": 2.5  # High RR (no additional reduction, max 2 signals)
        }
        
        ok, reasons = filters.evaluate_entry(facts)
        
        # Should pass because threshold reduced by 0.10 (max) to 0.42
        self.assertTrue(ok)

    def test_lower_adx_threshold_captures_more_opportunities(self):
        """Test that ADX threshold of 15.0 allows more setups"""
        cfg = FilterConfig(min_adx=15.0)
        filters = EntryFilters(cfg)
        
        facts = {
            "model_confidence": 0.60,
            "adx": 16.0,  # Would fail with old 18.0 threshold
            "atr": 0.5,
            "price": 100.0,
            "spread_bps": 5.0,
            "dollar_volume": 600_000.0,
            "rr_to_tp1": 1.5
        }
        
        ok, reasons = filters.evaluate_entry(facts)
        
        self.assertTrue(ok)
        self.assertIn('OK', reasons['momentumOk'])

    def test_lower_rr_threshold_captures_more_opportunities(self):
        """Test that RR threshold of 1.1 allows more setups"""
        cfg = FilterConfig(min_rr=1.1)
        filters = EntryFilters(cfg)
        
        facts = {
            "model_confidence": 0.60,
            "adx": 20.0,
            "atr": 0.5,
            "price": 100.0,
            "spread_bps": 5.0,
            "dollar_volume": 600_000.0,
            "rr_to_tp1": 1.2  # Would fail with old 1.3 threshold
        }
        
        ok, reasons = filters.evaluate_entry(facts)
        
        self.assertTrue(ok)
        self.assertIn('OK', reasons['profitOk'])

    def test_wider_spread_tolerance(self):
        """Test that max_spread_bps of 10.0 allows more flexibility"""
        cfg = FilterConfig(max_spread_bps=10.0)
        filters = EntryFilters(cfg)
        
        facts = {
            "model_confidence": 0.60,
            "adx": 20.0,
            "atr": 0.5,
            "price": 100.0,
            "spread_bps": 9.0,  # Would fail with old 8.0 threshold
            "dollar_volume": 600_000.0,
            "rr_to_tp1": 1.5
        }
        
        ok, reasons = filters.evaluate_entry(facts)
        
        self.assertTrue(ok)
        self.assertIn('OK', reasons['spreadOk'])

    def test_filters_still_reject_poor_quality_setups(self):
        """Test that filters still reject clearly bad setups"""
        cfg = FilterConfig(confidence_threshold=0.52, adaptive_confidence=True)
        filters = EntryFilters(cfg)
        
        facts = {
            "model_confidence": 0.35,  # Very low confidence
            "adx": 12.0,  # Weak momentum
            "atr": 0.5,
            "price": 100.0,
            "spread_bps": 5.0,
            "dollar_volume": 300_000.0,  # Low volume
            "rr_to_tp1": 0.8  # Poor RR
        }
        
        ok, reasons = filters.evaluate_entry(facts)
        
        self.assertFalse(ok)
        # Multiple failures expected


if __name__ == '__main__':
    unittest.main()
