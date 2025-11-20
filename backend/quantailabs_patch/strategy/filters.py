from dataclasses import dataclass
from typing import Dict, Tuple

@dataclass
class FilterConfig:
    min_adx: float = 12.0  # Reduced from 15.0 to capture more momentum setups
    min_dollar_volume: float = 150_000.0  # Fixed: was incorrectly very high
    min_rr: float = 1.05  # Reduced from 1.1 to allow more opportunities
    min_atr_pct: float = 0.05  # Reduced from 0.2 to accept lower volatility periods
    max_spread_bps: float = 12.0  # Increased from 10.0 for more flexibility
    confidence_threshold: float = 0.50  # Reduced from 0.52 to capture more quality setups
    use_confidence_filter: bool = True
    adaptive_confidence: bool = True  # Enable adaptive confidence based on other factors
    # Adaptive confidence parameters
    adaptive_threshold_floor: float = 0.42  # Minimum confidence threshold (lowered from 0.45)
    adaptive_reduction_per_signal: float = 0.05  # Threshold reduction per strong signal
    adaptive_max_signals: int = 2  # Maximum number of signals for reduction

class EntryFilters:
    def __init__(self, cfg: FilterConfig):
        self.cfg = cfg

    def evaluate_entry(self, facts: Dict, strategy_family: str = None) -> Tuple[bool, Dict]:
        """
        facts keys expected (as available): 
         price, atr, adx, spread_bps, dollar_volume, rr_to_tp1, model_confidence (0..1)
        strategy_family: 'trend', 'breakout', 'mean_reversion', 'momentum' (optional)
        Returns (ok, reasons)
        """
        reasons = {}
        ok = True

        # 🎯 FAMILY-BASED ADX ADJUSTMENTS: Allow mean_reversion during corrections (low ADX)
        min_adx_threshold = self.cfg.min_adx
        if strategy_family == 'mean_reversion':
            # Mean reversion trades CORRECTIONS/PULLBACKS (low-ADX environments: 10-14)
            # Lower threshold to capture rebound opportunities
            min_adx_threshold = max(8.0, self.cfg.min_adx - 6.0)  # 12 → 6, allows ADX down to 8
        elif strategy_family == 'momentum':
            # Momentum requires strong directional movement (high ADX)
            min_adx_threshold = min(25.0, self.cfg.min_adx + 4.0)  # 12 → 16, requires stronger trend

        adx = facts.get("adx")
        if adx is None or adx < min_adx_threshold:
            ok = False; reasons["momentumOk"] = f"FAIL (ADX={adx} < {min_adx_threshold:.1f})"
        else:
            reasons["momentumOk"] = f"OK (ADX={adx} >= {min_adx_threshold:.1f})"

        atr = facts.get("atr"); price = facts.get("price")
        if atr and price:
            atr_pct = (atr / price) * 100.0
            if atr_pct < self.cfg.min_atr_pct:
                ok = False; reasons["volatilityOk"] = f"FAIL (ATR%={atr_pct:.2f} < {self.cfg.min_atr_pct})"
            else:
                reasons["volatilityOk"] = f"OK (ATR%={atr_pct:.2f})"

        spread_bps = facts.get("spread_bps")
        if spread_bps is not None and spread_bps > self.cfg.max_spread_bps:
            ok = False; reasons["spreadOk"] = f"FAIL ({spread_bps} bps > {self.cfg.max_spread_bps})"
        else:
            reasons["spreadOk"] = f"OK"

        dv = facts.get("dollar_volume")
        if dv is not None and dv < self.cfg.min_dollar_volume:
            ok = False; reasons["volumeOk"] = f"FAIL ($vol={dv} < {self.cfg.min_dollar_volume})"
        else:
            reasons["volumeOk"] = "OK"

        rr = facts.get("rr_to_tp1")
        if rr is not None and rr < self.cfg.min_rr:
            ok = False; reasons["profitOk"] = f"FAIL (RR={rr:.2f} < {self.cfg.min_rr})"
        else:
            reasons["profitOk"] = "OK"

        if self.cfg.use_confidence_filter:
            conf = facts.get("model_confidence")
            # Adaptive confidence threshold - reduce threshold when other signals are strong
            threshold = self.cfg.confidence_threshold
            if self.cfg.adaptive_confidence:
                # Lower threshold if multiple strong signals present
                strong_signals = 0
                if adx is not None and adx >= 25.0:
                    strong_signals += 1
                if rr is not None and rr >= 2.0:
                    strong_signals += 1
                if dv is not None and dv >= self.cfg.min_dollar_volume * 1.5:
                    strong_signals += 1
                
                # Reduce threshold based on configuration
                reduction = self.cfg.adaptive_reduction_per_signal * min(strong_signals, self.cfg.adaptive_max_signals)
                threshold = max(self.cfg.adaptive_threshold_floor, threshold - reduction)
            
            if conf is not None and conf < threshold:
                ok = False; reasons["confidenceOk"] = f"FAIL (p={conf:.2f} < {threshold:.2f})"
            else:
                reasons["confidenceOk"] = f"OK (p={conf:.2f} >= {threshold:.2f})" if conf else "OK"

        reasons["summary"] = "OK" if ok else "BLOCKED"
        return ok, reasons
