import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

const {
  computeInitialBracket,
  maybeAdjustOrExit,
} = await import('../../dist/src/quantai/strategy/exitManager.js');
const { PositionSizer } = await import('../../dist/src/quantai/risk/positionSizing.js');

const exitConfig = {
  atrPeriod: 14,
  slAtrMult: 1.8,
  tpRMultiples: [1.5],
  trailAfterR: 0.8,
  trailAtrMult: 1.1,
  trailingAdaptive: {
    mode: 'atr',
    atrBands: {
      low: 0.9,
      high: 2.4,
      extreme: 3.8,
      lowMultiplier: 1.5,
      midMultiplier: 1.0,
      highMultiplier: 0.75,
      extremeMultiplier: 0.6,
    },
    clampMultiplier: { min: 0.5, max: 2.6 },
  },
  earlyExit: {
    adxBelow: 12,
    cmfNegative: true,
    tightenProfitR: 0.8,
    cutLossR: 0.7,
    minHoldMinutes: 5,
  },
  maxHoldingMin: 480,
  reentryCooldownMin: 30,
};

function simulateTrade({ label, atrs, prices, minutesStep }) {
  const entryPrice = prices[0];
  const bracket = computeInitialBracket(entryPrice, atrs[0], 'long', exitConfig, 'impulse');
  let stop = bracket.stop;
  const targets = [...bracket.targets];
  const triggered = new Set();
  let exitPrice = null;
  let exitReason = 'open';
  let minutesOpen = 0;

  for (let i = 1; i < prices.length; i += 1) {
    const lastPrice = prices[i];
    const atr = atrs[Math.min(i, atrs.length - 1)];
    minutesOpen = i * minutesStep;
    const directive = maybeAdjustOrExit({
      side: 'long',
      entryPrice,
      stop,
      targets,
      lastPrice,
      atr,
      adx: 25,
      cmf: 0.25,
      cfg: exitConfig,
      alreadyTriggeredTargets: triggered,
      minutesOpen,
    });

    if (directive.action === 'take_partial') {
      triggered.add(directive.tpHitIndex);
      if (directive.tpHitIndex === targets.length - 1) {
        exitPrice = lastPrice;
        exitReason = `tp_${label}`;
        break;
      }
      continue;
    }

    if (directive.action === 'move_sl') {
      stop = directive.stop;
    } else if (directive.action === 'exit') {
      exitPrice = lastPrice;
      exitReason = `managed_exit_${label}`;
      break;
    }

    if (lastPrice <= stop) {
      exitPrice = stop;
      exitReason = `stop_hit_${label}`;
      break;
    }
  }

  if (exitPrice == null) {
    exitPrice = prices[prices.length - 1];
    exitReason = `time_exit_${label}`;
  }

  const rMultiple = PositionSizer.rMultiple(entryPrice, bracket.stop, exitPrice, 'long');
  return { label, rMultiple, exitReason, trailStop: stop };
}

const calmTrend = simulateTrade({
  label: 'calm',
  atrs: [0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.5, 0.48, 0.45],
  prices: [100, 100.8, 101.6, 102.4, 103.2, 104.1, 104.9, 103.6, 104.8, 105.6],
  minutesStep: 5,
});

const volatileTrend = simulateTrade({
  label: 'volatile',
  atrs: [2.5, 2.4, 2.2, 2.0, 1.9, 1.8, 1.7],
  prices: [100, 102.5, 105.0, 107.2, 106.4, 105.0, 104.2],
  minutesStep: 5,
});

assert(calmTrend.rMultiple > volatileTrend.rMultiple, 'Adaptive trailing should preserve more R in calm regime');
assert(calmTrend.rMultiple > 1, 'Calm regime should capture more than 1R');
assert(volatileTrend.rMultiple > 0, 'Volatile regime should still exit profitably due to tighter trails');

const rMultiples = [calmTrend.rMultiple, volatileTrend.rMultiple];
const returns = rMultiples.map((r) => r * 0.25);

let equity = 1;
let peak = 1;
for (const ret of returns) {
  equity *= (1 + ret);
  if (equity > peak) peak = equity;
}

const trades = returns.length;
const cagrPerTrade = Math.pow(equity, 1 / trades) - 1;

let runningEquity = 1;
let runningPeak = 1;
let maxDrawdown = 0;
for (const ret of returns) {
  runningEquity *= (1 + ret);
  if (runningEquity > runningPeak) runningPeak = runningEquity;
  const dd = (runningPeak - runningEquity) / runningPeak;
  if (dd > maxDrawdown) maxDrawdown = dd;
}

const mean = returns.reduce((sum, r) => sum + r, 0) / trades;
const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / trades;
const stdev = Math.sqrt(variance);
const sharpe = stdev === 0 ? 0 : (mean / stdev) * Math.sqrt(trades);

console.log('🚀 Exit manager adaptive trailing smoke backtest');
console.log(`Calm trade: ${calmTrend.rMultiple.toFixed(3)}R (${calmTrend.exitReason})`);
console.log(`Volatile trade: ${volatileTrend.rMultiple.toFixed(3)}R (${volatileTrend.exitReason})`);
console.log(`CAGR per trade: ${(cagrPerTrade * 100).toFixed(4)}%`);
console.log(`Max drawdown: ${(maxDrawdown * 100).toFixed(4)}%`);
console.log(`Sharpe-like: ${sharpe.toFixed(4)}`);

assert(Number.isFinite(cagrPerTrade), 'CAGR must be finite');
assert(Number.isFinite(maxDrawdown), 'Max drawdown must be finite');
assert(Number.isFinite(sharpe), 'Sharpe must be finite');

console.log('✅ exit-manager-smoke-backtest.mjs passed');
