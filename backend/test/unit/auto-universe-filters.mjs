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
  };
}

const strategy = {
  aggressiveness: 'reactive',
  targetTpPct: 1,
  stopLossPct: 0.7,
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

console.log('✅ auto-universe-filters.mjs passed');
