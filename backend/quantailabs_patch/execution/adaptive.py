from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal, ROUND_CEILING, getcontext
from typing import Deque, Dict, Optional


getcontext().prec = 28


@dataclass
class ExecutionPlan:
    mode: str
    passive_offset_bps: Optional[float]
    fallback_timeout_ms: int
    twap_slices: Optional[int] = None
    twap_interval_ms: Optional[int] = None
    reason: str = ""


@dataclass
class _SymbolState:
    fills: Deque[tuple[Decimal, Decimal, Decimal, datetime]] = field(default_factory=lambda: deque(maxlen=50))
    ew_fill_ratio: Decimal = Decimal('1')
    ew_slippage_bps: Decimal = Decimal('0')
    ew_spread_bps: Decimal = Decimal('5')
    last_updated: Optional[datetime] = None


class AdaptiveExecutionController:
    """Tracks recent fills to adapt passive offset, fallbacks, and TWAP sizing."""

    def __init__(self, half_life: int = 8):
        self._states: Dict[str, _SymbolState] = {}
        self._decay = Decimal('0.5') ** (Decimal('1') / Decimal(max(half_life, 1)))

    def _state(self, symbol: str) -> _SymbolState:
        if symbol not in self._states:
            self._states[symbol] = _SymbolState()
        return self._states[symbol]

    def record_fill(
        self,
        symbol: str,
        fill_ratio: float,
        slippage_bps: float,
        spread_bps: float,
        ts: Optional[datetime] = None,
    ) -> None:
        state = self._state(symbol)
        timestamp = ts or datetime.utcnow()
        sample = (
            Decimal(str(max(0.0, min(1.0, fill_ratio)))),
            Decimal(str(abs(slippage_bps))),
            Decimal(str(max(0.1, spread_bps))),
            timestamp,
        )
        state.fills.append(sample)

        weight = Decimal('1') - self._decay if state.last_updated else Decimal('1')
        state.ew_fill_ratio = state.ew_fill_ratio * (Decimal('1') - weight) + sample[0] * weight
        state.ew_slippage_bps = state.ew_slippage_bps * (Decimal('1') - weight) + sample[1] * weight
        state.ew_spread_bps = state.ew_spread_bps * (Decimal('1') - weight) + sample[2] * weight
        state.last_updated = timestamp

    def plan(
        self,
        symbol: str,
        notional_usd: float,
        spread_bps: float,
        book_depth_usd: Optional[float],
        default_timeout_ms: int = 3500,
    ) -> ExecutionPlan:
        state = self._state(symbol)
        spread = Decimal(str(max(spread_bps, float(state.ew_spread_bps))))
        fill_ratio = state.ew_fill_ratio
        slippage_ratio = Decimal('0') if spread == 0 else state.ew_slippage_bps / spread

        passive_offset = Decimal('4')
        reason_parts = []

        if fill_ratio < Decimal('0.4'):
            deficit = (Decimal('0.4') - fill_ratio) / Decimal('0.4')
            passive_offset += Decimal('6') * max(Decimal('0'), deficit)
            passive_offset = min(passive_offset, Decimal('16'))
            reason_parts.append('boost_passive')
        else:
            reason_parts.append('stable_fill')

        timeout = Decimal(str(default_timeout_ms))
        if slippage_ratio > Decimal('1.5'):
            timeout *= min(slippage_ratio, Decimal('3'))
            reason_parts.append('extend_timeout')
        elif slippage_ratio < Decimal('0.8') and fill_ratio > Decimal('0.7'):
            timeout *= Decimal('0.85')
            reason_parts.append('tighten_timeout')

        notional = Decimal(str(max(notional_usd, 0.0)))
        mode = 'limit'
        twap_slices: Optional[int] = None
        twap_interval_ms: Optional[int] = None

        if book_depth_usd is not None and book_depth_usd > 0:
            depth = Decimal(str(book_depth_usd))
            ratio = notional / depth if depth > 0 else Decimal('0')
            if ratio > Decimal('1.2'):
                slices = int(ratio.to_integral_value(rounding=ROUND_CEILING))
                twap_slices = max(2, min(12, slices))
                twap_interval_ms = max(400, int(timeout))
                mode = 'twap'
                reason_parts.append('twap_depth')
        elif notional > Decimal('25000'):
            mode = 'twap'
            twap_slices = max(2, int(notional / Decimal('10000')))
            twap_interval_ms = max(400, int(timeout))
            reason_parts.append('twap_size')

        if fill_ratio > Decimal('0.85') and slippage_ratio < Decimal('0.8') and mode != 'twap':
            mode = 'market'
            passive_offset = None
            reason_parts.append('market_ok')

        return ExecutionPlan(
            mode=mode,
            passive_offset_bps=float(passive_offset) if passive_offset is not None else None,
            fallback_timeout_ms=int(timeout),
            twap_slices=twap_slices,
            twap_interval_ms=twap_interval_ms,
            reason='|'.join(reason_parts),
        )

    def purge_expired(self, older_than: timedelta) -> None:
        cutoff = datetime.utcnow() - older_than
        to_delete = [symbol for symbol, state in self._states.items() if state.last_updated and state.last_updated < cutoff]
        for symbol in to_delete:
            del self._states[symbol]
