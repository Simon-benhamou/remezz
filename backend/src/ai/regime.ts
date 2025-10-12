import type { TechnicalSnapshot } from './tech.js';

export type RegimeRiskModifier = {
  level: 'caution' | 'extreme';
  sizingMultiplier?: number;
  stopMultiplier?: number;
  reason: string;
};

export type RegimeProfile = {
  trend: 'uptrend'|'downtrend'|'range';
  volatility: 'low'|'medium'|'high';
  hurst: number;
  realizedVol: number;
  adxSlope: number;
  trendStrength: number;
  playbook: 'mean_reversion'|'momentum_breakout'|'trend_following'|'standby';
  shouldTrade: boolean;
  volatilityProfile?: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' | string;
  riskModifier?: RegimeRiskModifier;
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
  if (vol >= 3) volatility = 'high';
  else if (vol >= 1) volatility = 'medium';
  else volatility = 'low';

  // Determine playbook
  let playbook: RegimeProfile['playbook'] = 'mean_reversion';
  let shouldTrade = true;
  let riskModifier: RegimeRiskModifier | undefined;
  const momentumStrong = adx >= 25 && Math.abs(adxSlope) > 0.5 && trendStrength > 0.35;
  const hurstBiasTrend = hurst > 0.6;
  const hurstBiasRange = hurst < 0.45;
  const structureWeak = trendStrength < 0.2 || adx < 15;
  const structureFragile = trendStrength < 0.25 || adx < 18;
  const structureCollapsed = trendStrength <= 0.12 && adx <= 12;
  const adxFallingHard = adxSlope < -1.2;
  const extremeVol = vol >= 6;
  const catastrophicVol = vol >= 8;
  const violentSpike = volatility === 'high' && structureCollapsed && adxFallingHard && hurst < 0.5;

  if (violentSpike) {
    playbook = 'standby';
    shouldTrade = false;
    riskModifier = {
      level: 'extreme',
      sizingMultiplier: 0.25,
      stopMultiplier: 1.05,
      reason: 'disorderly_spike_structure_failure'
    };
  } else if (momentumStrong || hurstBiasTrend) {
    playbook = 'momentum_breakout';
    if (volatility === 'high' && !hurstBiasTrend) {
      // Encourage caution in breakouts during high vol conditions
      riskModifier = {
        level: 'caution',
        sizingMultiplier: 0.75,
        stopMultiplier: 0.9,
        reason: 'high_volatility_breakout_context'
      };
    }
  } else if (volatility === 'high' && !momentumStrong) {
    // Only step aside completely if market structure collapses under extreme volatility
    if (catastrophicVol && structureCollapsed && adxFallingHard) {
      playbook = 'mean_reversion';
      riskModifier = {
        level: 'extreme',
        sizingMultiplier: 0.35,
        stopMultiplier: 1,
        reason: 'catastrophic_volatility_structure_collapse'
      };
    } else {
      riskModifier = {
        level: 'caution',
        sizingMultiplier: structureWeak ? 0.55 : 0.7,
        stopMultiplier: structureWeak ? 0.8 : 0.9,
        reason: structureFragile
          ? 'high_volatility_soft_structure'
          : 'high_volatility_opportunity'
      };
    }
  } else if (hurstBiasRange || trendStrength <= 0.25) {
    playbook = 'mean_reversion';
  }

  if (!riskModifier && volatility === 'medium' && structureFragile && !momentumStrong) {
    riskModifier = {
      level: 'caution',
      sizingMultiplier: 0.7,
      stopMultiplier: 0.9,
      reason: 'elevated_volatility_with_fragile_structure'
    };
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
    volatilityProfile: volatility === 'high'
      ? (catastrophicVol ? 'EXTREME' : 'HIGH')
      : volatility.toUpperCase(),
    riskModifier,
    notes: !shouldTrade
      ? 'Extreme volatility and structural breakdown detected; standing by.'
      : riskModifier?.reason,
  };
}
