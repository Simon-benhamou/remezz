import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

const { EntryFilters } = await import('../../dist/src/quantai/strategies/metaAdaptive/entryFilters.js');

const filters = new EntryFilters({
  minAdx: 10,
  minDollarVolume: 0,
  minRr: 1,
  minAtrPct: 0,
  maxSpreadBps: 50,
  confidenceThreshold: 0,
  useConfidenceFilter: false,
  dynamic: {
    spreadAtrRatioLimit: 0.4,
  },
  symbolOverrides: {
    ETH: {
      spreadAtrRatioLimit: 0.6,
      volatilityProfileOverrides: {
        LOW_VOLATILITY: { spreadAtrRatioLimit: 0.5 },
      },
    },
  },
});

const baseFacts = {
  adx: 22,
  dollarVolume: 1_000_000,
  atrPct: 0.4,
  spreadBps: 18,
  rrToTp1: 1.1,
};

const ethResult = filters.evaluateEntry(baseFacts, {
  symbol: 'ETH/USDT:USDT',
  volatilityProfile: 'low_volatility',
});
assert.equal(ethResult.ok, true, 'ETH low-volatility override should relax spread/ATR ratio gate');

const adaResult = filters.evaluateEntry(baseFacts, {
  symbol: 'ADA/USDT:USDT',
  volatilityProfile: 'low_volatility',
});
assert.equal(adaResult.ok, false, 'Other symbols should keep the stricter spread/ATR ratio gate');
assert.match(
  adaResult.reasons.spreadOk,
  /FAIL/,
  'Spread rejection should be explicit when ratio exceeds default limit',
);

console.log('✅ entry-filters-symbol-overrides.mjs passed');
