import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { serializeActivationProfile, hydrateActivationProfile } = await import('../../dist/src/agent/profilePersistence.js');

const timestamp = new Date().toISOString();
const activationProfile = {
  symbol: 'BTC/USDT:USDT',
  mode: 'paper',
  maxLeverage: 5,
  requestedMaxLeverage: 5,
  leverageCap: { resolved: 5, requested: 5, dynamicMax: 5, category: 'default' },
  riskPerTradePct: 1.5,
  dailyLossLimitPct: 3.5,
  timestamp,
  startBalanceUsd: 1000,
  budgetFraction: 0.5,
  aggressiveness: 'reactive',
  strategyEngine: 'meta_adaptive',
  rrFloor: 1.2,
  rrCeil: 3.0,
  rrBaseMin: 1.0,
  rrExpectancy: {
    enabled: true,
    minTrades: 10,
    lookbackDays: 7,
    decay: 0.5,
    safetyMult: 1.1,
    blend: 0.4,
    hysteresis: 0.1,
  },
};

const serialized = serializeActivationProfile(activationProfile, { budgetPct: 50 });

const sessionRecord = {
  id: 'session-test',
  symbol: activationProfile.symbol,
  mode: activationProfile.mode,
  startBalanceUsd: activationProfile.startBalanceUsd,
  userId: null,
  startedAt: new Date(timestamp),
  profileJson: serialized,
  rrFloor: activationProfile.rrFloor,
  rrCeil: activationProfile.rrCeil,
  rrBaseMin: activationProfile.rrBaseMin,
};

const hydrated = hydrateActivationProfile(sessionRecord);
assert.ok(hydrated, 'Hydrated profile should not be null');
assert.equal(hydrated?.strategyEngine, 'meta_adaptive', 'Strategy engine selection should persist meta_adaptive preference');
