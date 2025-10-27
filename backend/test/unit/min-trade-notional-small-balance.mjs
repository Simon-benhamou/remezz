import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { resolveMinTradeNotional } = await import('../../dist/src/agent/state/minTradeNotional.js');

const smallBalanceResult = resolveMinTradeNotional({
  configMinNotionalUsd: 40,
  equityUsd: 65,
  sizingFloorUsd: 30,
});

const expectedSmallBalanceFloor = (65 * (2 / 3));
assert(Math.abs(smallBalanceResult - expectedSmallBalanceFloor) < 1e-6, 'Small balance floor should follow the 2/3 equity rule');

const zeroEquityResult = resolveMinTradeNotional({
  configMinNotionalUsd: 40,
  equityUsd: 0,
  sizingFloorUsd: 30,
});
assert.equal(zeroEquityResult, 40, 'Zero equity should keep the configured minimum notional or higher');

const largeBalanceResult = resolveMinTradeNotional({
  configMinNotionalUsd: 40,
  equityUsd: 10_000,
  sizingFloorUsd: 30,
});
assert.equal(largeBalanceResult, 500, 'Large balance should respect the legacy dynamic floor');

console.log('✅ min-trade-notional-small-balance.mjs passed');
