from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Optional


@dataclass
class CachedStrategy:
    strategy_id: str
    expectancy: float
    win_rate: float
    created_at: datetime
    regime_tag: Optional[str] = None
    payload: dict = field(default_factory=dict)


class StrategyCache:
    """Keeps a bounded cache of generated strategies and resolves the best candidate on reuse."""

    def __init__(self, max_age: timedelta = timedelta(minutes=90)) -> None:
        self._store: Dict[str, List[CachedStrategy]] = {}
        self._max_age = max_age

    def _bucket(self, symbol: str) -> List[CachedStrategy]:
        if symbol not in self._store:
            self._store[symbol] = []
        return self._store[symbol]

    def add(self, symbol: str, strategy: CachedStrategy) -> None:
        bucket = self._bucket(symbol)
        bucket.append(strategy)
        bucket.sort(key=lambda s: s.expectancy, reverse=True)

    def purge_stale(self, now: Optional[datetime] = None) -> None:
        timestamp = now or datetime.utcnow()
        for symbol, bucket in list(self._store.items()):
            fresh = [s for s in bucket if timestamp - s.created_at <= self._max_age]
            if fresh:
                self._store[symbol] = fresh
            else:
                del self._store[symbol]

    def resolve(
        self,
        symbol: str,
        regime_tag: Optional[str],
        now: Optional[datetime] = None,
    ) -> Optional[CachedStrategy]:
        self.purge_stale(now)
        bucket = self._store.get(symbol)
        if not bucket:
            return None
        preferred: Optional[CachedStrategy] = None
        fallback: Optional[CachedStrategy] = None
        for candidate in bucket:
            if regime_tag and candidate.regime_tag == regime_tag:
                if preferred is None or candidate.expectancy > preferred.expectancy:
                    preferred = candidate
            if fallback is None or candidate.expectancy > fallback.expectancy:
                fallback = candidate
        return preferred or fallback

    def load_all(self, symbol: str) -> Iterable[CachedStrategy]:
        return list(self._store.get(symbol, []))
