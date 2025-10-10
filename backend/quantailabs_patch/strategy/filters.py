from dataclasses import dataclass
from typing import Dict, Tuple

@dataclass
class FilterConfig:
    min_adx: float = 18.0
    min_dollar_volume: float = 500_000.0
    min_rr: float = 1.3
    min_atr_pct: float = 0.2
    max_spread_bps: float = 8.0
    confidence_threshold: float = 0.58
    use_confidence_filter: bool = True

class EntryFilters:
    def __init__(self, cfg: FilterConfig):
        self.cfg = cfg

    def evaluate_entry(self, facts: Dict) -> Tuple[bool, Dict]:
        """
        facts keys expected (as available): 
         price, atr, adx, spread_bps, dollar_volume, rr_to_tp1, model_confidence (0..1)
        Returns (ok, reasons)
        """
        reasons = {}
        ok = True

        adx = facts.get("adx")
        if adx is None or adx < self.cfg.min_adx:
            ok = False; reasons["momentumOk"] = f"FAIL (ADX={adx})"
        else:
            reasons["momentumOk"] = f"OK (ADX={adx})"

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
            if conf is not None and conf < self.cfg.confidence_threshold:
                ok = False; reasons["confidenceOk"] = f"FAIL (p={conf:.2f} < {self.cfg.confidence_threshold})"
            else:
                reasons["confidenceOk"] = "OK"

        reasons["summary"] = "OK" if ok else "BLOCKED"
        return ok, reasons
