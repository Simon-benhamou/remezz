from dataclasses import dataclass
from typing import Optional, Tuple
from datetime import datetime, timedelta, timezone
import math

@dataclass
class CircuitBreaker:
    max_consecutive_losses: int = 3
    cooldown_minutes: int = 60
    daily_loss_limit_pct: float = 3.0        # stop if daily drawdown <= -3%
    daily_trade_limit: int = 7
    catastrophic_trade_drawdown_pct: Optional[float] = None
    catastrophic_trade_consecutive_losses: Optional[int] = None
    reduce_size_after_losses: bool = True
    size_reduction_after_n_losses: int = 2
    size_reduction_factor: float = 0.5

    # runtime state
    consecutive_losses: int = 0
    trades_today: int = 0
    equity_start_day: Optional[float] = None
    cooldown_until: Optional[datetime] = None
    last_trade_day: Optional[str] = None
    day_start_at: Optional[datetime] = None

    def _session_day_key(self, now: datetime) -> str:
        if now.tzinfo is None:
            utc_now = now
        else:
            utc_now = now.astimezone(timezone.utc)
        return utc_now.date().isoformat()

    def _reset_day_if_needed(self, now: datetime, equity: float):
        day_key = self._session_day_key(now)
        if self.last_trade_day != day_key:
            self.trades_today = 0
            self.equity_start_day = equity
            self.last_trade_day = day_key
            if now.tzinfo is None:
                self.day_start_at = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
            else:
                utc_now = now.astimezone(timezone.utc)
                self.day_start_at = datetime(utc_now.year, utc_now.month, utc_now.day, tzinfo=timezone.utc)

    def _trade_limit_evaluation(self, equity: float) -> Tuple[bool, Optional[str]]:
        if equity is None or not isinstance(equity, (int, float)) or not math.isfinite(equity):
            return True, "unable to verify equity"
        if (
            self.catastrophic_trade_drawdown_pct
            and self.equity_start_day not in (None, 0)
        ):
            drawdown = (equity - self.equity_start_day) / self.equity_start_day * 100.0
            if drawdown <= -abs(self.catastrophic_trade_drawdown_pct):
                return True, f"drawdown {drawdown:.2f}%"
        if (
            self.catastrophic_trade_consecutive_losses
            and self.consecutive_losses >= self.catastrophic_trade_consecutive_losses
        ):
            return True, f"{self.consecutive_losses} consecutive losses"
        return False, None

    def can_open_trade(self, now: datetime, equity: float) -> (bool, str):
        self._reset_day_if_needed(now, equity)
        if self.cooldown_until and now < self.cooldown_until:
            return False, f"Cooldown active until {self.cooldown_until} after losses streak={self.consecutive_losses}."
        if self.daily_trade_limit and self.trades_today >= self.daily_trade_limit:
            enforce, detail = self._trade_limit_evaluation(equity)
            if enforce:
                suffix = f" under catastrophic conditions ({detail})" if detail else " under catastrophic conditions"
                return False, f"Daily trade limit reached: {self.trades_today}/{self.daily_trade_limit}{suffix}."
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
        # Only count losses > -0.1% to avoid tiny losses triggering the breaker
        if pnl_pct < -0.1:
            self.consecutive_losses += 1
            if self.consecutive_losses >= self.max_consecutive_losses:
                self.cooldown_until = now + timedelta(minutes=self.cooldown_minutes)
        elif pnl_pct > 0.1:
            # Only reset on meaningful wins (> 0.1%) to avoid tiny wins resetting the counter
            self.consecutive_losses = 0

    def size_multiplier(self) -> float:
        if not self.reduce_size_after_losses:
            return 1.0
        if self.consecutive_losses >= self.size_reduction_after_n_losses:
            return max(0.05, self.size_reduction_factor)
        return 1.0
