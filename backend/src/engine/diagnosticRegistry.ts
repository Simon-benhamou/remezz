import type { RegimeDiagnostics } from '../diagnostics/regime.js';

const triggerOverrides = new Map<string, { rate: number; expiresAt: number | null }>();
const regimeStore = new Map<string, { diagnostics: RegimeDiagnostics; updatedAt: number }>();

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

export function setRegimeDiagnostics(symbol: string, diagnostics: RegimeDiagnostics): void {
  regimeStore.set(symbol, { diagnostics, updatedAt: Date.now() });
}

export function getRegimeDiagnostics(symbol: string, maxAgeMs = 5 * 60 * 1000): RegimeDiagnostics | null {
  const entry = regimeStore.get(symbol);
  if (!entry) return null;
  if (maxAgeMs > 0 && Date.now() - entry.updatedAt > maxAgeMs) {
    regimeStore.delete(symbol);
    return null;
  }
  return entry.diagnostics;
}
