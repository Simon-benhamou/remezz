from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal, getcontext
from typing import Deque, Dict, Iterable, Optional, Tuple


getcontext().prec = 28


@dataclass
class GuardrailState:
    trades: Deque[Decimal] = field(default_factory=lambda: deque(maxlen=30))
    halted_until: Optional[datetime] = None
    last_updated: Optional[datetime] = None
    reason: Optional[str] = None


class SymbolGuardrails:
    """Evaluates recent trade KPIs and halts symbols when performance collapses."""

    def __init__(
        self,
        min_samples: int = 12,
        win_rate_floor: float = 0.35,
        expectancy_floor: float = 0.0,
        cooldown: timedelta = timedelta(days=1),
    ) -> None:
        self._states: Dict[str, GuardrailState] = {}
        self._min_samples = max(1, min_samples)
        self._win_rate_floor = Decimal(str(win_rate_floor))
        self._expectancy_floor = Decimal(str(expectancy_floor))
        self._cooldown = cooldown

    def _state(self, symbol: str) -> GuardrailState:
        if symbol not in self._states:
            self._states[symbol] = GuardrailState()
        return self._states[symbol]

    def register_trades(self, symbol: str, pnl_pcts: Iterable[float], now: Optional[datetime] = None) -> None:
        state = self._state(symbol)
        timestamp = now or datetime.utcnow()
        for value in pnl_pcts:
            state.trades.append(Decimal(str(value)))
        state.last_updated = timestamp
        self._reevaluate(symbol, state, timestamp)

    def register_trade(self, symbol: str, pnl_pct: float, ts: Optional[datetime] = None) -> None:
        self.register_trades(symbol, [pnl_pct], ts)

    def _reevaluate(self, symbol: str, state: GuardrailState, now: datetime) -> None:
        if len(state.trades) < self._min_samples:
            return
        
        # Use the most recent min_samples trades for evaluation
        # This allows recovery after poor performance if recent trades improve
        recent = list(state.trades)[-self._min_samples:]
        wins = sum(1 for x in recent if x > 0)
        n = Decimal(len(recent))
        win_rate = Decimal(wins) / n
        expectancy = sum(recent) / n
        
        # Halt if win_rate is critically low OR expectancy is negative
        if win_rate < self._win_rate_floor or expectancy < self._expectancy_floor:
            state.halted_until = now + self._cooldown
            state.reason = 'win_rate' if win_rate < self._win_rate_floor else 'expectancy'
        elif state.halted_until and now >= state.halted_until:
            state.halted_until = None
            state.reason = None

    def is_halted(self, symbol: str, now: Optional[datetime] = None) -> Tuple[bool, Optional[str], Optional[datetime]]:
        state = self._state(symbol)
        timestamp = now or datetime.utcnow()
        if state.halted_until and timestamp < state.halted_until:
            return True, state.reason, state.halted_until
        if state.halted_until and timestamp >= state.halted_until:
            state.halted_until = None
            state.reason = None
        return False, None, None

    def clear(self, symbol: str) -> None:
        if symbol in self._states:
            del self._states[symbol]

    def describe(self, symbol: str) -> Dict[str, Optional[float]]:
        state = self._state(symbol)
        n = len(state.trades)
        if n == 0:
            return {"samples": 0, "win_rate": None, "expectancy": None}
        wins = sum(1 for x in state.trades if x > 0)
        expectancy = float(sum(state.trades) / Decimal(n))
        win_rate = float(Decimal(wins) / Decimal(n))
        halted, reason, until = self.is_halted(symbol)
        return {
            "samples": n,
            "win_rate": win_rate,
            "expectancy": expectancy,
            "halted": halted,
            "reason": reason,
            "halted_until": until.isoformat() if until else None,
        }
