from dataclasses import dataclass

@dataclass
class PositionSizer:
    base_risk_per_trade_pct: float = 0.5  # % of equity to risk if SL hit

    def compute_size(self, equity_usd: float, entry_price: float, stop_price: float) -> float:
        """
        Returns quantity (base units) to buy/sell such that risk at SL ~= base_risk_per_trade_pct of equity.
        Assumes linear PnL (spot or 1x). For futures with leverage, ensure notional and maintenance margins are respected.
        """
        risk_usd = equity_usd * (self.base_risk_per_trade_pct / 100.0)
        stop_distance = abs(entry_price - stop_price)
        if stop_distance <= 0:
            return 0.0
        qty = risk_usd / stop_distance
        return max(0.0, qty)

    @staticmethod
    def r_multiple(entry: float, stop: float, price: float, side: str) -> float:
        risk = abs(entry - stop)
        if risk == 0:
            return 0.0
        if side.lower() == "long":
            return (price - entry) / risk
        else:
            return (entry - price) / risk
