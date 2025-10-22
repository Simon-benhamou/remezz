import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const {
  buildStrategyChecklist,
  resolveStrategySnapshot,
} = await import('../../dist/src/utils/strategySnapshot.js');

const diagnostics = {
  checks: {
    inEntryZone: { status: 'PASS', reason: 'Inside adaptive zone' },
    momentumGates: { status: 'PASS', reason: 'Momentum gates green' },
    entryConfirmation: { status: 'PARTIAL', reason: 'Waiting for retest' },
    qualityScore: { status: 'PASS', reason: 'Score above threshold' },
    liquidity: { status: 'PASS', reason: 'Depth sufficient' },
    biasAlignment: { status: 'FAIL', reason: 'Bias mismatch' },
    qualityFilters: {
      trendAlignment: { status: 'PASS', reason: 'Higher timeframe aligned' },
      volume: { status: 'FAIL', reason: 'Volume expansion missing' },
      rsiPosition: { status: 'PASS', reason: 'RSI within band' },
      volatility: { status: 'PASS', reason: 'ATR contraction observed' },
      momentum: { status: 'PASS', reason: 'Momentum favourable' },
    },
  },
};

const breakoutChecklist = buildStrategyChecklist('breakout_retest', diagnostics);
assert.equal(breakoutChecklist.length, 5, 'Breakout checklist should expose five verification items');
assert.equal(breakoutChecklist[0].status, 'PASS');
assert.equal(breakoutChecklist[2].status, 'FAIL');
assert.equal(breakoutChecklist[3].status, 'PARTIAL');
assert.ok(Array.isArray(buildStrategyChecklist(null, diagnostics)), 'Null strategy should yield a checklist array');
assert.equal(buildStrategyChecklist(null, diagnostics).length, 0, 'Null strategy should produce empty checklist');

let diagCallCount = 0;
const recognizedSignals = [
  {
    id: 'breakout_retest',
    label: 'Adaptive breakout structure',
    bias: 'long',
    confidence: 0.82,
    active: true,
    reasons: ['volume_surge'],
    meta: {
      score: 0.78,
      guardrail: null,
      penalties: [],
      exploration: false,
      executionMode: 'market',
      riskPct: '0.015',
      stopAtrMult: '1.8',
    },
  },
  {
    id: 'classic_trend_following',
    label: 'Adaptive trend follower',
    bias: 'long',
    confidence: 0.51,
    active: false,
    reasons: ['fallback'],
    meta: {
      score: 0.5,
      guardrail: null,
      penalties: ['cooldown'],
      exploration: true,
      executionMode: 'market',
      riskPct: '0.010',
      stopAtrMult: '1.40',
    },
  },
];

const fakeAgent = {
  profile: { strategyEngine: 'meta_adaptive' },
  marketContext: {
    regime: 'breakout',
    basePlaybook: 'trend_following',
    effectivePlaybook: 'momentum_breakout',
    strongTrend: true,
    moderateTrend: false,
    direction: 'long',
    allowMomentumOverride: true,
    favorMeanReversion: false,
    confidence: 0.72,
    notes: ['volume surge', 'range expansion'],
    hurst: 0.38,
    trendStrength: 0.66,
    adx: 27.4,
    strategyFamily: 'breakout',
    strategyToken: 'token-123',
    recognizedStrategies: recognizedSignals,
    primaryStrategy: recognizedSignals[0],
  },
  async getDiagnostics() {
    diagCallCount += 1;
    return diagnostics;
  },
};

const snapshotA = await resolveStrategySnapshot(fakeAgent, { strategyEngine: 'meta_adaptive' }, { includeChecklist: true });
assert.equal(snapshotA.engine, 'meta_adaptive');
assert.equal(snapshotA.primary?.id, 'breakout_retest');
assert.equal(snapshotA.context?.family, 'breakout');
assert.equal(snapshotA.checklist.length, 5);
assert.equal(diagCallCount, 1, 'Diagnostics should be called once on first resolution');

const snapshotB = await resolveStrategySnapshot(fakeAgent, { strategyEngine: 'meta_adaptive' }, { includeChecklist: true });
assert.equal(snapshotB.checklist.length, 5);
assert.equal(diagCallCount, 1, 'Checklist should reuse cached diagnostics within debounce window');
