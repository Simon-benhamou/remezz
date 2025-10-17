from dataclasses import dataclass, field
from decimal import Decimal, getcontext
from typing import List, Dict
import math


getcontext().prec = 28

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

        equity_curve = Decimal('1')
        peak_equity = Decimal('1')
        max_drawdown = Decimal('0')

        wins = 0
        sum_gains = Decimal('0')
        sum_losses = Decimal('0')
        pnl_values: List[Decimal] = []

        for trade in self.trades:
            pnl_pct = Decimal(str(trade.pnl_pct))
            pnl_values.append(pnl_pct)
            if trade.win:
                wins += 1
                sum_gains += pnl_pct
            else:
                sum_losses += -pnl_pct

            equity_curve *= (Decimal('1') + pnl_pct / Decimal('100'))
            peak_equity = max(peak_equity, equity_curve)
            drawdown = (equity_curve - peak_equity) / peak_equity * Decimal('100')
            max_drawdown = min(max_drawdown, drawdown)

        losses = n - wins
        win_rate = Decimal(wins) / Decimal(n)
        profit_factor = Decimal('inf') if sum_losses == 0 else sum_gains / sum_losses
        expectancy = (sum_gains - sum_losses) / Decimal(n)

        mean = (sum_gains - sum_losses) / Decimal(n)
        variance = Decimal('0')
        for pnl in pnl_values:
            diff = pnl - mean
            variance += diff * diff
        variance /= Decimal(n)
        std = variance.sqrt() if variance > 0 else Decimal('0')
        sharpe_like = Decimal('inf') if std == 0 else mean / std

        if equity_curve <= 0:
            raise ValueError("Equity curve collapsed; metrics invalid")
        cagr_per_trade = equity_curve ** (Decimal('1') / Decimal(n)) - Decimal('1')

        metrics = {
            "n": n,
            "wins": wins,
            "losses": losses,
            "win_rate": float(round(win_rate, 4)),
            "profit_factor": float(round(profit_factor, 4)) if profit_factor != Decimal('inf') else float('inf'),
            "expectancy": float(round(expectancy, 4)),
            "sharpe_like": float(round(sharpe_like, 4)) if sharpe_like != Decimal('inf') else float('inf'),
            "max_drawdown_pct": float(round(max_drawdown, 4)),
            "cagr_per_trade": float(round(cagr_per_trade * Decimal('100'), 4)),
        }

        for key, value in metrics.items():
            if isinstance(value, float) and math.isnan(value):
                raise ValueError(f"Metric {key} is NaN")
        return metrics
