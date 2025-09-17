import type { TechnicalSnapshot } from './tech.js';

export type RegimeProfile = {
  trend: 'uptrend'|'downtrend'|'range';
  volatility: 'low'|'medium'|'high';
  hurst: number;
  realizedVol: number;
  adxSlope: number;
  trendStrength: number;
  playbook: 'mean_reversion'|'momentum_breakout'|'standby';
  shouldTrade: boolean;
  notes?: string;
};

export function classifyRegime(snap: TechnicalSnapshot & {
  realizedVol?: number;
  hurst?: number;
  adxSlope?: number;
  trendStrength?: number;
}): RegimeProfile {
  const realizedVol = Number.isFinite(snap.realizedVol) ? snap.realizedVol! : 0;
  const hurst = Number.isFinite(snap.hurst) ? snap.hurst! : 0.5;
  const adx = Number(snap.adx14 || 0);
  const adxSlope = Number.isFinite(snap.adxSlope) ? snap.adxSlope! : 0;
  const emaSpreadPct = Math.abs((snap.ema20 - snap.ema50) / (snap.last || 1)) * 100;
  const emaSlopePct = Math.abs((snap.ema20Slope || 0) / (snap.last || 1)) * 100;
  const trendStrength = snap.trendStrength != null ? snap.trendStrength : Math.max(emaSpreadPct, emaSlopePct);
  const isUp = snap.ema20 >= snap.ema50;
  const trend: RegimeProfile['trend'] = trendStrength > 0.25
    ? (isUp ? 'uptrend' : 'downtrend')
    : 'range';

  // Volatility buckets (realized vol expressed in % terms already)
  const vol = realizedVol;
  let volatility: RegimeProfile['volatility'];
  if (vol >= 1.2) volatility = 'high';
  else if (vol >= 0.5) volatility = 'medium';
  else volatility = 'low';

  // Determine playbook
  let playbook: RegimeProfile['playbook'] = 'mean_reversion';
  let shouldTrade = true;
  const momentumStrong = adx >= 25 && Math.abs(adxSlope) > 0.5 && trendStrength > 0.35;
  const hurstBiasTrend = hurst > 0.6;
  const hurstBiasRange = hurst < 0.45;

  if (momentumStrong || hurstBiasTrend) {
    playbook = 'momentum_breakout';
  } else if (volatility === 'high' && !momentumStrong && !hurstBiasTrend) {
    // High vol chop, stand aside unless we regain structure
    playbook = 'standby';
    shouldTrade = false;
  } else if (hurstBiasRange || trendStrength <= 0.25) {
    playbook = 'mean_reversion';
  }

  // In case of conflicting signals (e.g. down ADX slope but large spread) soften to mean reversion
  if (playbook === 'momentum_breakout' && (adx < 20 || trendStrength < 0.25)) {
    playbook = 'mean_reversion';
  }

  return {
    trend,
    volatility,
    hurst,
    realizedVol,
    adxSlope,
    trendStrength,
    playbook,
    shouldTrade,
    notes: playbook === 'standby' ? 'High-volatility chop detected; standing by.' : undefined,
  };
}
