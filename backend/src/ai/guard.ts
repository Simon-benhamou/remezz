// backend/src/ai/guard.ts
// Global throttling and debounce utilities for LLM-heavy operations

export type Key = string; // typically the symbol
export type Kind = 'strategy' | 'plan';

type KindState = {
  lastAt: number;
  countHour: number;
  windowStart: number;
  outsideTicks: number;
  lastZone?: { min?: number | null; max?: number | null } | null;
  lastWasOutside: boolean;
};

const state: Record<Kind, Record<Key, KindState>> = { strategy: {}, plan: {} };
const NOW = () => Date.now();

function ensureState(kind: Kind, key: Key): KindState {
  return (state[kind][key] ||= {
    lastAt: 0,
    countHour: 0,
    windowStart: NOW(),
    outsideTicks: 0,
    lastWasOutside: false,
    lastZone: null,
  });
}

export function shouldAllowLLM(kind: Kind, key: Key, opts: {
  cooldownMin: number;
  maxPerHour: number;
}): boolean {
  const s = ensureState(kind, key);
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

export function markLLM(kind: Kind, key: Key) {
  const s = ensureState(kind, key);
  s.lastAt = NOW();
  s.countHour += 1;
}

export function shouldAllowStrategyLLM(key: Key, opts: { cooldownMin: number; maxPerHour: number }): boolean {
  return shouldAllowLLM('strategy', key, opts);
}

export function markStrategyLLM(key: Key) {
  markLLM('strategy', key);
}

export function shouldAllowPlanLLM(key: Key, opts: { cooldownMin: number; maxPerHour: number }): boolean {
  return shouldAllowLLM('plan', key, opts);
}

export function markPlanLLM(key: Key) {
  markLLM('plan', key);
}

export function updateZoneState(key: Key, zone: { min?: number | null; max?: number | null } | null) {
  const s = ensureState('strategy', key);
  s.lastZone = zone;
}

// Debounce: considers a real exit only after N ticks and hysteresisPct beyond zone
export function zoneExitDebounced(
  key: Key,
  price: number,
  hysteresisPct: number,
  requiredTicks: number
): boolean {
  const s = ensureState('strategy', key);
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
