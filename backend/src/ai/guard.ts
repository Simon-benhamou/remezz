// backend/src/ai/guard.ts
// Global throttling and debounce utilities for LLM-heavy operations

export type Key = string; // typically the symbol
export type Kind = 'strategy';

type KindState = {
  lastAt: number;
  countHour: number;
  windowStart: number;
  outsideTicks: number;
  lastZone?: { min?: number | null; max?: number | null } | null;
  lastWasOutside: boolean;
};

const state: Record<Kind, Record<Key, KindState>> = { strategy: {} };
const NOW = () => Date.now();

export function shouldAllowStrategyLLM(key: Key, opts: {
  cooldownMin: number;
  maxPerHour: number;
}): boolean {
  const s = (state.strategy[key] ||= {
    lastAt: 0,
    countHour: 0,
    windowStart: NOW(),
    outsideTicks: 0,
    lastWasOutside: false,
    lastZone: null,
  });
  const now = NOW();

  // reset hourly window
  if (now - s.windowStart > 60 * 60 * 1000) {
    s.windowStart = now;
    s.countHour = 0;
  }

  // cooldown
  if (now - s.lastAt < opts.cooldownMin * 60 * 1000) return false;

  // budget per hour
  if (s.countHour >= opts.maxPerHour) return false;

  return true;
}

export function markStrategyLLM(key: Key) {
  const s = (state.strategy[key] ||= {
    lastAt: 0,
    countHour: 0,
    windowStart: NOW(),
    outsideTicks: 0,
    lastWasOutside: false,
    lastZone: null,
  });
  s.lastAt = NOW();
  s.countHour += 1;
}

export function updateZoneState(key: Key, zone: { min?: number | null; max?: number | null } | null) {
  const s = (state.strategy[key] ||= {
    lastAt: 0,
    countHour: 0,
    windowStart: NOW(),
    outsideTicks: 0,
    lastWasOutside: false,
    lastZone: null,
  });
  s.lastZone = zone;
}

// Debounce: considers a real exit only after N ticks and hysteresisPct beyond zone
export function zoneExitDebounced(
  key: Key,
  price: number,
  hysteresisPct: number,
  requiredTicks: number
): boolean {
  const s = (state.strategy[key] ||= {
    lastAt: 0,
    countHour: 0,
    windowStart: NOW(),
    outsideTicks: 0,
    lastWasOutside: false,
    lastZone: null,
  });
  const z = s.lastZone;
  if (!z || z.min == null || z.max == null) {
    s.outsideTicks = 0;
    s.lastWasOutside = false;
    return false;
  }

  const below = price < (z.min as number) * (1 - hysteresisPct / 100);
  const above = price > (z.max as number) * (1 + hysteresisPct / 100);
  const isOutside = below || above;

  if (isOutside) {
    s.outsideTicks += 1;
  } else {
    s.outsideTicks = 0;
  }

  const crossed = isOutside && s.outsideTicks >= requiredTicks && !s.lastWasOutside;
  s.lastWasOutside = isOutside;
  return crossed;
}
