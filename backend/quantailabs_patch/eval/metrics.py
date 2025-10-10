from dataclasses import dataclass, field
from typing import List, Dict
import math

@dataclass
class Trade:
    pnl_pct: float  # realized PnL in percent of equity or per-trade notional
    win: bool

@dataclass
class Metrics:
    trades: List[Trade] = field(default_factory=list)

    def add_trade(self, pnl_pct: float):
        self.trades.append(Trade(pnl_pct=pnl_pct, win=pnl_pct > 0))

    def as_dict(self) -> Dict:
        n = len(self.trades)
        if n == 0:
            return {"n": 0}
        wins = sum(1 for t in self.trades if t.win)
        losses = n - wins
        win_rate = wins / n
        gains = [t.pnl_pct for t in self.trades if t.pnl_pct > 0]
        losses_abs = [-t.pnl_pct for t in self.trades if t.pnl_pct < 0]
        sum_gains = sum(gains) if gains else 0.0
        sum_losses = sum(losses_abs) if losses_abs else 0.0
        profit_factor = (sum_gains / sum_losses) if sum_losses > 0 else float('inf')
        expectancy = (sum_gains - sum_losses) / n
        # Sharpe-like (not annualized): mean/std of per-trade pnl
        mean = (sum_gains - sum_losses) / n
        variance = 0.0
        for t in self.trades:
            variance += (t.pnl_pct - mean)**2
        variance /= n
        std = math.sqrt(variance)
        sharpe_like = mean / std if std > 0 else float('inf')
        # Max drawdown via equity curve
        eq = 0.0
        peak = 0.0
        max_dd = 0.0
        for t in self.trades:
            eq += t.pnl_pct
            peak = max(peak, eq)
            dd = (eq - peak)
            max_dd = min(max_dd, dd)
        return {
            "n": n,
            "wins": wins,
            "losses": losses,
            "win_rate": round(win_rate, 4),
            "profit_factor": round(profit_factor, 4),
            "expectancy": round(expectancy, 4),
            "sharpe_like": round(sharpe_like, 4),
            "max_drawdown_pct": round(max_dd, 4),
        }
