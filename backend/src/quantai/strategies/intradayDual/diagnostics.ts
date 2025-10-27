const counters = new Map<string, Map<string, { count: number; lastAt: number }>>();

export type IntradayDiagnosticKey =
  | 'unusable_data'
  | 'depth_fallback'
  | 'micro_wait_timeout'
  | 'min_notional_skip'
  | 'min_notional_applied'
  | 'risk_scale_floor'
  | 'ev_extreme'
  | 'confidence_risk_floor'
  | 'confidence_risk_boost'
  | 'confidence_target_notional';

export type DiagnosticPayload = Record<string, unknown> | undefined;

export function recordDiagnostic(symbol: string, key: IntradayDiagnosticKey, payload?: DiagnosticPayload): void {
  if (!symbol) return;
  const now = Date.now();
  const existing = counters.get(symbol) ?? new Map<string, { count: number; lastAt: number }>();
  const entry = existing.get(key) ?? { count: 0, lastAt: 0 };
  entry.count += 1;
  entry.lastAt = now;
  existing.set(key, entry);
  counters.set(symbol, existing);
  const logPayload: Record<string, unknown> = {
    symbol,
    counter: key,
    count: entry.count,
    lastAt: new Date(now).toISOString(),
  };
  if (payload && typeof payload === 'object') {
    for (const [payloadKey, value] of Object.entries(payload)) {
      if (value !== undefined) {
        logPayload[payloadKey] = value;
      }
    }
  }
  console.info('intraday.diagnostic', logPayload);
}
