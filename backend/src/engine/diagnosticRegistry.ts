const triggerOverrides = new Map<string, { rate: number; expiresAt: number | null }>();

export function setTriggerSampleRate(symbol: string, rate: number, ttlMs = 60 * 60 * 1000): void {
  const clamped = Math.max(0, Math.min(1, rate));
  triggerOverrides.set(symbol, { rate: clamped, expiresAt: ttlMs > 0 ? Date.now() + ttlMs : null });
}

export function bumpTriggerSampleRate(symbol: string, delta = 0.1, ttlMs = 60 * 60 * 1000): void {
  const current = triggerOverrides.get(symbol);
  const base = current?.rate ?? 0.25;
  setTriggerSampleRate(symbol, Math.min(1, base + delta), ttlMs);
}

export function getTriggerSampleRate(symbol: string, fallback: number): number {
  const override = triggerOverrides.get(symbol);
  if (!override) return fallback;
  if (override.expiresAt != null && override.expiresAt < Date.now()) {
    triggerOverrides.delete(symbol);
    return fallback;
  }
  return override.rate;
}

export function clearTriggerOverride(symbol?: string): void {
  if (symbol) triggerOverrides.delete(symbol); else triggerOverrides.clear();
}

