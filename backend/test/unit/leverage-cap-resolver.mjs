import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';
process.env.DEFAULT_MAX_LEVERAGE = '7';
process.env.LEVERAGE_CAP_DEFAULT = '5';
process.env.LEVERAGE_CAP_MAJOR = '6';
process.env.LEVERAGE_CAP_ALT = '3';
process.env.LEVERAGE_CAP_MEME = '2';

const { prisma } = await import('../../dist/src/db/client.js');
const {
  resolveLeverageCap,
  clearLeverageCapCache,
} = await import('../../dist/src/risk/leverageCaps.js');

if (typeof prisma.$reset === 'function') {
  await prisma.$reset();
}
clearLeverageCapCache();

const fallback = await resolveLeverageCap({
  symbol: 'BTC/USDT:USDT',
  requestedMaxLeverage: 8,
  category: 'major',
  mode: 'paper',
});

assert.equal(fallback.resolved, 6, 'Fallback should clamp to category cap when no constraint exists');
assert.equal(fallback.constraintSource, 'fallback', 'Constraint source should be fallback when none defined');
assert.equal(fallback.trimmed, true, 'Requested leverage should be marked as trimmed when reduced');

await prisma.leverageConstraint.create({
  data: {
    symbol: '*',
    category: 'major',
    targetLeverage: 4.5,
    notes: 'Major default',
  },
});
clearLeverageCapCache();

const category = await resolveLeverageCap({
  symbol: 'ETH/USDT:USDT',
  requestedMaxLeverage: 9,
  category: 'major',
  mode: 'paper',
});

assert.equal(category.resolved, 4.5, 'Category constraint should override config when lower');
assert.equal(category.constraintSource, 'category', 'Constraint source should be category when wildcard matches');
assert.equal(category.trimmed, true, 'Category cap should trim when below requested leverage');

const symbolConstraint = await prisma.leverageConstraint.create({
  data: {
    symbol: 'BTC/USDT:USDT',
    hardCap: 3,
    targetLeverage: 3.5,
  },
});
clearLeverageCapCache();

const symbolCap = await resolveLeverageCap({
  symbol: 'BTC/USDT:USDT',
  requestedMaxLeverage: 9,
  mode: 'paper',
});

assert.equal(symbolCap.resolved, 3, 'Symbol-specific hard cap should take precedence');
assert.equal(symbolCap.constraintSource, 'symbol', 'Constraint source should report symbol for exact match');

await prisma.leverageConstraint.update({
  where: { id: symbolConstraint.id },
  data: { hardCap: 2 },
});

const cachedCap = await resolveLeverageCap({
  symbol: 'BTC/USDT:USDT',
  requestedMaxLeverage: 9,
  mode: 'paper',
});

assert.equal(cachedCap.resolved, 3, 'Cache should retain previous constraint until cleared');

clearLeverageCapCache();
const refreshedCap = await resolveLeverageCap({
  symbol: 'BTC/USDT:USDT',
  requestedMaxLeverage: 9,
  mode: 'paper',
});

assert.equal(refreshedCap.resolved, 2, 'Clearing cache should reload updated constraint values');
assert.equal(refreshedCap.trimmed, true, 'Updated constraint should continue trimming requested leverage');

if (typeof prisma.$disconnect === 'function') {
  await prisma.$disconnect();
}

console.log('✅ leverage-cap-resolver.mjs passed');
