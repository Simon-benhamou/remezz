import assert from 'node:assert/strict';
import { evaluateMarginSnapshot } from '../../dist/src/risk/marginGuard.js';

const baseSnapshot = {
  freeUsd: 6000,
  equityUsd: 10000,
  committedUsd: 4000,
  maintenanceMarginUsd: 500,
  marginRatio: 0.4,
  timestamp: Date.now(),
  positions: [
    { symbol: 'BTC/USDT', side: 'long', qty: 0.5, markPrice: 30000, liquidationPrice: 24000 },
    { symbol: 'ETH/USDT', side: 'short', qty: 1, markPrice: 1800, liquidationPrice: 2100 },
  ],
  correlatedExposure: {
    BTC: { key: 'BTC', totalNotionalUsd: 15000, longNotionalUsd: 15000, shortNotionalUsd: 0, positions: ['BTC/USDT'] },
    ETH: { key: 'ETH', totalNotionalUsd: 1800, longNotionalUsd: 0, shortNotionalUsd: 1800, positions: ['ETH/USDT'] },
  },
};

{
  const result = evaluateMarginSnapshot(baseSnapshot, {
    thresholds: {
      utilisationWarnPct: 60,
      utilisationCriticalPct: 85,
      minLiquidationDistancePct: 8,
      concentrationWarnPct: 95,
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.breaches.length, 0);
  assert.equal(result.actions.length, 0);
}

{
  const stressed = {
    ...baseSnapshot,
    committedUsd: 9200,
    positions: [
      { symbol: 'BTC/USDT', side: 'long', qty: 0.5, markPrice: 30000, liquidationPrice: 29400 },
    ],
    correlatedExposure: {
      BTC: { key: 'BTC', totalNotionalUsd: 15000, longNotionalUsd: 15000, shortNotionalUsd: 0, positions: ['BTC/USDT'] },
    },
  };
  const result = evaluateMarginSnapshot(stressed, {
    thresholds: {
      utilisationWarnPct: 60,
      utilisationCriticalPct: 85,
      minLiquidationDistancePct: 10,
      concentrationWarnPct: 40,
    },
  });
  assert.equal(result.status, 'critical');
  assert.ok(result.breaches.some((b) => b.kind === 'utilisation'));
  assert.ok(result.breaches.some((b) => b.kind === 'liquidation'));
  assert.ok(result.actions.some((action) => /close/i.test(action.label)));
}

console.log('✅ margin-guard unit tests passed');
