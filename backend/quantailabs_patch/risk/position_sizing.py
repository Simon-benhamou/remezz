from dataclasses import dataclass
from decimal import Decimal, getcontext


getcontext().prec = 28

@dataclass
class PositionSizer:
    base_risk_per_trade_pct: float = 0.5  # % of equity to risk if SL hit
    atr_reference_pct: float = 2.0        # baseline ATR% used for scaling risk
    atr_ceiling_pct: float = 6.0          # clamp to avoid overscaling in extreme volatility

    def compute_size(
        self,
        equity_usd: float,
        entry_price: float,
        stop_price: float,
        atr_pct: float | None = None,
    ) -> float:
        """
        Returns quantity (base units) to buy/sell such that risk at SL ~= scaled risk of equity.
        ATR-based scaling reduces exposure during high volatility and gently increases it during quiet regimes.
        """
        entry = Decimal(str(entry_price))
        stop = Decimal(str(stop_price))
        equity = Decimal(str(equity_usd))
        if entry <= 0 or equity <= 0:
            return 0.0

        stop_distance = abs(entry - stop)
        if stop_distance <= 0:
            return 0.0

        risk_pct = Decimal(str(self.base_risk_per_trade_pct))
        if atr_pct is not None and atr_pct > 0:
            atr_value = Decimal(str(atr_pct))
            baseline = Decimal(str(max(self.atr_reference_pct, 1e-6)))
            ceiling = Decimal(str(max(self.atr_ceiling_pct, self.atr_reference_pct)))
            normalized = min(ceiling, max(atr_value, Decimal('0.0001'))) / baseline
            if normalized > 1:
                scale = Decimal('1') / normalized
                risk_pct *= max(Decimal('0.35'), scale)
            else:
                boost = (Decimal('1') - normalized) * Decimal('0.35')
                risk_pct *= Decimal('1') + boost

        risk_usd = equity * (risk_pct / Decimal('100'))
        if risk_usd <= 0:
            return 0.0

        qty = risk_usd / stop_distance
        return float(max(Decimal('0'), qty))

    @staticmethod
    def r_multiple(entry: float, stop: float, price: float, side: str) -> float:
        risk = abs(entry - stop)
        if risk == 0:
            return 0.0
        if side.lower() == "long":
            return (price - entry) / risk
        else:
            return (entry - price) / risk
