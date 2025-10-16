export type RegimeDiagnostics = {
  regime: 'trend' | 'range' | 'breakout' | 'volatility_spike' | 'illiquid' | 'standby';
  direction: 'bull' | 'bear' | 'neutral';
  momentumScore: number;
  volatilityScore: number;
  spreadPercentile: number | null;
  anomaly?: string | null;
  tags: string[];
};

type NumericSnapshot = Record<string, number | null | undefined>;

function safeNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export function classifyRegime(snapshot: NumericSnapshot, extras?: { spreadBps?: number | null; liquidityScore?: number | null }): RegimeDiagnostics {
  const atrPct = Math.abs(safeNumber(snapshot.atrPct));
  const adx = Math.abs(safeNumber(snapshot.adx14));
  const emaSlope = safeNumber(snapshot.ema20Slope ?? snapshot.ema50Slope);
  const rsi = safeNumber(snapshot.rsi14);
  const cmf = safeNumber(snapshot.cmf20);
  const volumeScore = safeNumber(snapshot.volumeScore ?? snapshot.volumeRatio);
  const spreadBps = extras?.spreadBps ?? safeNumber(snapshot.spreadBps);
  const liquidityScore = extras?.liquidityScore ?? safeNumber(snapshot.liquidityScore);

  const slopeScore = Math.tanh(emaSlope * 12);
  const momentumScore = slopeScore + (rsi - 50) / 40 + (adx - 20) / 35;
  const volatilityScore = Math.tanh((atrPct - 2.5) / 3);

  let regime: RegimeDiagnostics['regime'] = 'range';
  let direction: RegimeDiagnostics['direction'] = 'neutral';
  const tags: string[] = [];
  let anomaly: string | null = null;

  if (adx > 35 && Math.abs(emaSlope) > 0.12) {
    regime = 'trend';
    direction = emaSlope >= 0 ? 'bull' : 'bear';
    tags.push('momentum');
  } else if (atrPct > 4.5 && adx > 22 && Math.abs(emaSlope) > 0.08) {
    regime = 'breakout';
    direction = emaSlope >= 0 ? 'bull' : 'bear';
    tags.push('expansion');
  } else if (atrPct < 1.2 && adx < 16) {
    regime = 'range';
    direction = Math.abs(rsi - 50) < 8 ? 'neutral' : rsi > 50 ? 'bull' : 'bear';
    tags.push('mean_reversion');
  } else if (atrPct > 5.5 && adx < 20) {
    regime = 'volatility_spike';
    tags.push('anomaly');
  }

  if (spreadBps > 30 || liquidityScore < 1) {
    tags.push('fragile');
    if (spreadBps > 45) {
      regime = 'illiquid';
      anomaly = 'spread_extreme';
    }
  }

  if (Math.abs(cmf) > 0.25) {
    tags.push(cmf > 0 ? 'buy_pressure' : 'sell_pressure');
  }

  if (volumeScore < 0.7) {
    tags.push('thin_volume');
  } else if (volumeScore > 1.4) {
    tags.push('heavy_volume');
  }

  const spreadPercentile = (() => {
    if (!Number.isFinite(spreadBps)) return null;
    if (spreadBps <= 5) return 0.1;
    if (spreadBps <= 10) return 0.25;
    if (spreadBps <= 20) return 0.5;
    if (spreadBps <= 35) return 0.75;
    return 0.9;
  })();

  return {
    regime,
    direction,
    momentumScore: Number.isFinite(momentumScore) ? Math.max(-3, Math.min(3, momentumScore)) : 0,
    volatilityScore: Number.isFinite(volatilityScore) ? Math.max(-3, Math.min(3, volatilityScore)) : 0,
    spreadPercentile,
    anomaly,
    tags,
  };
}

