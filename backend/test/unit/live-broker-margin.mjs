import assert from 'node:assert/strict';

const { computeCommittedMargin } = await import('../../dist/src/broker/live.js');

{
  const committed = computeCommittedMargin({
    equityUsd: 1000,
    freeUsd: 106,
    positionCost: 894,
    positions: [
      {
        symbol: 'BNBUSDT',
        side: 'long',
        qty: 1,
        notionalUsd: 890,
        initialMarginUsd: 597,
        leverage: 1.49,
      },
    ],
  });
  assert.ok(Math.abs(committed - 597) < 1e-6, `Expected margin near 597, got ${committed}`);
}

{
  const committed = computeCommittedMargin({
    equityUsd: 2000,
    freeUsd: 600,
    positionCost: undefined,
    positions: [
      {
        symbol: 'ETHUSDT',
        side: 'long',
        qty: 2,
        notionalUsd: 800,
        leverage: 4,
      },
    ],
  });
  assert.ok(Math.abs(committed - 200) < 1e-6, `Expected leverage-implied margin 200, got ${committed}`);
}

{
  const committed = computeCommittedMargin({
    equityUsd: 1200,
    freeUsd: 450,
    positionCost: undefined,
    positions: [],
  });
  assert.ok(Math.abs(committed - 750) < 1e-6, `Fallback should use equity-free margin, got ${committed}`);
}

console.log('✅ live-broker-margin.mjs passed');
