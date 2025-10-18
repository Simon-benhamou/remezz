import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const { evaluateCandidateAgainstFilters } = await import('../../dist/src/services/intelligentAgent.js');

function makeCandidate(overrides = {}) {
  return {
    symbol: overrides.symbol ?? 'SOL/USDT:USDT',
    baseScore: overrides.baseScore ?? 10,
    volumeCents24h: overrides.volumeCents24h ?? BigInt(120_000_000 * 100),
    lastPrice: overrides.lastPrice ?? 150,
    regimeTag: overrides.regimeTag ?? 'trending',
    atrPct: overrides.atrPct ?? 1.1,
    micro: {
      spreadBps: overrides.spreadBps ?? 6,
      bidDepthCents: overrides.bidDepthCents ?? BigInt(40_000 * 100),
      askDepthCents: overrides.askDepthCents ?? BigInt(38_000 * 100),
    },
    performance: {
      sample: overrides.sample ?? 12,
      winRate: overrides.winRate ?? 55,
      expectancyUsd: overrides.expectancyUsd ?? 18,
      profitFactor: overrides.profitFactor ?? 1.6,
      avgSlippageBps: overrides.avgSlippageBps ?? 4,
      avgFillRate: overrides.avgFillRate ?? 0.72,
      lastTradeAt: overrides.lastTradeAt ?? Date.now() - 6 * 3_600_000,
    },
    multiTimeframe: overrides.multiTimeframe,
  };
}

const strategy = {
  aggressiveness: 'reactive',
  targetTpPct: 1.6,
  stopLossPct: 0.9,
};

const now = Date.now();

const illiquid = makeCandidate({
  volumeCents24h: BigInt(10_000_000 * 100),
  bidDepthCents: BigInt(2_000 * 100),
  askDepthCents: BigInt(2_200 * 100),
});

const illiquidResult = evaluateCandidateAgainstFilters(illiquid, strategy, now);
assert.equal(illiquidResult.ok, false, 'illiquid assets must be rejected');
assert(illiquidResult.reasons.includes('volume_below_floor') || illiquidResult.reasons.includes('book_depth_thin'));

const strong = makeCandidate();
const strongResult = evaluateCandidateAgainstFilters(strong, strategy, now);
assert.equal(strongResult.ok, true, 'well structured assets should survive filters');
assert(strongResult.score > strong.baseScore * 0.8, 'score should retain most of base value');

const shallowDepthReactive = makeCandidate({
  bidDepthCents: BigInt(12_000 * 100),
  askDepthCents: BigInt(11_500 * 100),
});
const shallowDepthReactiveResult = evaluateCandidateAgainstFilters(shallowDepthReactive, strategy, now);
assert.equal(shallowDepthReactiveResult.ok, false, 'reactive profile should reject sub-15k depth books');
assert(shallowDepthReactiveResult.reasons.includes('book_depth_thin'));

const aggressiveStrategy = {
  aggressiveness: 'aggressive',
  targetTpPct: 1.8,
  stopLossPct: 1.0,
};
const aggressiveDepthCandidate = makeCandidate({
  bidDepthCents: BigInt(11_500 * 100),
  askDepthCents: BigInt(10_500 * 100),
});
const aggressiveDepthResult = evaluateCandidateAgainstFilters(aggressiveDepthCandidate, aggressiveStrategy, now);
assert.equal(aggressiveDepthResult.ok, true, 'aggressive profile should allow ≥10k depth per side');

const altAsset = makeCandidate({ symbol: 'ACH/USDT:USDT' });
const altAssetResult = evaluateCandidateAgainstFilters(altAsset, strategy, now);
assert.equal(altAssetResult.ok, true, 'baseline alt asset must pass when liquidity is ample');

const majorAsset = makeCandidate({ symbol: 'BTC/USDT:USDT' });
const majorAssetResult = evaluateCandidateAgainstFilters(majorAsset, strategy, now);
assert(majorAssetResult.score > altAssetResult.score, 'majors should gain a post-filter quality bonus');

const weakMajor = makeCandidate({
  symbol: 'BTC/USDT:USDT',
  sample: 5,
  winRate: 30,
  expectancyUsd: -2,
});
const weakMajorResult = evaluateCandidateAgainstFilters(weakMajor, strategy, now);
assert.equal(weakMajorResult.ok, false, 'majors with 5 samples and poor stats must trigger halt');
const weakReasons = new Set(weakMajorResult.reasons);
assert(
  weakReasons.has('win_rate_low') ||
  weakReasons.has('win_rate_cooldown') ||
  weakReasons.has('expectancy_negative') ||
  weakReasons.has('expectancy_cooldown'),
  'weak major should surface performance halt reasons',
);

const conflictCandidate = makeCandidate({
  multiTimeframe: {
    timeframes: {
      '4h': { tf: '4h', bias: 'bullish', momentumPct: 0, rsi: 55 },
      '15m': { tf: '15m', bias: 'bearish', momentumPct: -0.3, rsi: 42 },
    },
    agreementScore: 1,
    divergenceScore: 1,
  },
});
const conflictResult = evaluateCandidateAgainstFilters(conflictCandidate, strategy, now);
assert.equal(conflictResult.ok, false, '4h vs 15m bias conflict must block execution');
assert(conflictResult.reasons.includes('tf_conflict_4h_vs_15m'), 'conflict reason should be reported');

const slippageCandidate = makeCandidate({
  spreadBps: 10,
  avgSlippageBps: 17,
  expectancyUsd: 25,
  winRate: 60,
});
const slippageResult = evaluateCandidateAgainstFilters(slippageCandidate, strategy, now);
assert.equal(slippageResult.ok, false, 'slippage exceeding tightened guard must fail');
assert(slippageResult.reasons.includes('slippage_vs_spread'));

console.log('✅ auto-universe-filters.mjs passed');
