import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const { metaAdaptiveStrategyAgent, PreciseDecimal } = await import('../../dist/src/quantai/strategy/metaAdaptiveAgent.js');

function buildSnapshot(overrides = {}) {
  const last = overrides.last ?? 100;
  return {
    symbol: overrides.symbol ?? 'SOL/USDT',
    last,
    ema20: overrides.ema20 ?? last * 1.01,
    ema50: overrides.ema50 ?? last * 1.005,
    ema100: overrides.ema100 ?? last * 0.998,
    ema200: overrides.ema200 ?? last * 0.99,
    rsi14: overrides.rsi14 ?? 60,
    atr14: overrides.atr14 ?? (last * 0.012),
    atrPct: overrides.atrPct ?? 1.2,
    adx14: overrides.adx14 ?? 27,
    ema20Slope: overrides.ema20Slope ?? last * 0.0012,
    support: overrides.support ?? last * 0.97,
    resistance: overrides.resistance ?? last * 1.03,
    supports: overrides.supports ?? [{ price: last * 0.97, label: 'S1', touches: 3, strength: 2 }],
    resistances: overrides.resistances ?? [{ price: last * 1.03, label: 'R1', touches: 2, strength: 2 }],
    pivots: overrides.pivots ?? {
      P: last,
      S1: last * 0.99,
      S2: last * 0.98,
      R1: last * 1.01,
      R2: last * 1.02,
      refDay: new Date().toISOString().slice(0, 10),
    },
    trend: overrides.trend ?? 1.1,
    srBias: overrides.srBias ?? 'nearSupport',
    meta: overrides.meta ?? { tf: '15m', windowBars: 120, recentBarsFor24h: 96 },
    realizedVol: overrides.realizedVol ?? 1.3,
    hurst: overrides.hurst ?? 0.55,
    trendStrength: overrides.trendStrength ?? 0.82,
    trendBias: overrides.trendBias ?? 'bullish',
    volume: overrides.volume ?? 900_000,
    volumeMA: overrides.volumeMA ?? 600_000,
    volume24h: overrides.volume24h ?? 70_000_000,
    cmf20: overrides.cmf20 ?? 0.28,
    multiTimeframe: overrides.multiTimeframe ?? {
      timeframes: {
        '4h': { tf: '4h', bias: 'bullish', momentumPct: 0.45, rsi: 58 },
        '1h': { tf: '1h', bias: 'bullish', momentumPct: 0.35, rsi: 56 },
        '15m': { tf: '15m', bias: 'bullish', momentumPct: 0.25, rsi: 55 },
      },
      agreementScore: 3,
      divergenceScore: 0,
    },
  };
}

function computeNetAfterFees(plan, atrPct, feeBps) {
  const zero = new PreciseDecimal('0');
  if (plan.riskUsd.equals(0) || plan.targetProfitUsd.equals(0)) {
    return { net: zero, fee: zero };
  }
  const atrPercent = Math.max(Number.isFinite(atrPct) ? atrPct : 0.05, 0.05);
  const atrFraction = new PreciseDecimal((atrPercent / 100).toFixed(6));
  const stopFraction = plan.stopAtrMult.times(atrFraction);
  const notional = stopFraction.equals(0) ? plan.riskUsd : plan.riskUsd.dividedBy(stopFraction);
  const roundTripPct = feeBps.times(new PreciseDecimal('2')).dividedBy(new PreciseDecimal('10000'));
  const fee = notional.times(roundTripPct);
  return { net: plan.targetProfitUsd.minus(fee), fee };
}

metaAdaptiveStrategyAgent.reset();

const snapshot = buildSnapshot();
const feeBps = new PreciseDecimal('4');
const desired = new PreciseDecimal('30');

const highCapitalEval = metaAdaptiveStrategyAgent.evaluate({
  sessionId: 'fee-target-high',
  symbol: snapshot.symbol,
  snap: snapshot,
  micro: { takerFeeBps: feeBps },
  accountBalanceUsd: '5000',
  desiredProfitUsd: desired,
});

const activePlans = highCapitalEval.signals
  .filter(signal => signal.active && !signal.plan.riskUsd.equals(0));

assert(activePlans.length > 0, 'High capital context should produce active plans');

for (const signal of activePlans) {
  const net = computeNetAfterFees(signal.plan, snapshot.atrPct ?? 1.2, feeBps);
  assert(!net.net.lt(desired), `Net target should meet or exceed ${desired.toFixed(0)} USD`);
}

const lowCapitalEval = metaAdaptiveStrategyAgent.evaluate({
  sessionId: 'fee-target-low',
  symbol: snapshot.symbol,
  snap: snapshot,
  micro: { takerFeeBps: feeBps },
  accountBalanceUsd: '200',
  desiredProfitUsd: desired,
});

assert(lowCapitalEval.signals.every(signal => signal.plan.riskUsd.equals(0)), 'Plans should be suppressed when capital cannot reach net profit target');

metaAdaptiveStrategyAgent.reset();

console.log('✅ meta-adaptive fee target test passed');
