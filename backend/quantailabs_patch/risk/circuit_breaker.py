from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime, timedelta

@dataclass
class CircuitBreaker:
    max_consecutive_losses: int = 3
    cooldown_minutes: int = 60
    daily_loss_limit_pct: float = 3.0        # stop if daily drawdown <= -3%
    daily_trade_limit: int = 7
    reduce_size_after_losses: bool = True
    size_reduction_after_n_losses: int = 2
    size_reduction_factor: float = 0.5

    # runtime state
    consecutive_losses: int = 0
    trades_today: int = 0
    equity_start_day: Optional[float] = None
    cooldown_until: Optional[datetime] = None
    last_trade_day: Optional[int] = None

    def _reset_day_if_needed(self, now: datetime, equity: float):
        day = now.timetuple().tm_yday
        if self.last_trade_day != day:
            self.trades_today = 0
            self.equity_start_day = equity
            self.last_trade_day = day

    def can_open_trade(self, now: datetime, equity: float) -> (bool, str):
        self._reset_day_if_needed(now, equity)
        if self.cooldown_until and now < self.cooldown_until:
            return False, f"Cooldown active until {self.cooldown_until} after losses streak={self.consecutive_losses}."
        if self.trades_today >= self.daily_trade_limit:
            return False, f"Daily trade limit reached: {self.trades_today}/{self.daily_trade_limit}."
        if self.equity_start_day:
            dd = (equity - self.equity_start_day) / self.equity_start_day * 100.0
            if dd <= -abs(self.daily_loss_limit_pct):
                return False, f"Daily loss limit hit: {dd:.2f}% <= -{self.daily_loss_limit_pct}%."
        if self.consecutive_losses >= self.max_consecutive_losses:
            # block *before* next trade
            self.cooldown_until = now + timedelta(minutes=self.cooldown_minutes)
            return False, f"Consecutive losses ({self.consecutive_losses}) >= {self.max_consecutive_losses}. Cooldown engaged."
        return True, "OK"

    def on_before_open(self, now: datetime, equity: float):
        self._reset_day_if_needed(now, equity)
        self.trades_today += 1

    def on_trade_result(self, now: datetime, pnl_pct: float, equity: float):
        self._reset_day_if_needed(now, equity)
        if pnl_pct < 0:
            self.consecutive_losses += 1
            if self.consecutive_losses >= self.max_consecutive_losses:
                self.cooldown_until = now + timedelta(minutes=self.cooldown_minutes)
        else:
            self.consecutive_losses = 0

    def size_multiplier(self) -> float:
        if not self.reduce_size_after_losses:
            return 1.0
        if self.consecutive_losses >= self.size_reduction_after_n_losses:
            return max(0.05, self.size_reduction_factor)
        return 1.0
