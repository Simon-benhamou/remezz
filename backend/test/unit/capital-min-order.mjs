import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.MIN_ORDER_NOTIONAL_USD = '40';

const { PreciseDecimal } = await import('../../dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');
const { CapitalManager } = await import('../../dist/src/core/capital/CapitalManager.js');
const { PaperBalanceProvider } = await import('../../dist/src/core/capital/PaperBalanceProvider.js');
const { capitalConfig } = await import('../../dist/src/config/capital.js');

function cloneDecimal(value) {
  return PreciseDecimal.fromRaw(value.raw);
}

const initial = new PreciseDecimal('65');
const zero = new PreciseDecimal('0');
const provider = new PaperBalanceProvider({
  snapshot: {
    totalUSD: PreciseDecimal.fromRaw(initial.raw),
    freeUSD: PreciseDecimal.fromRaw(initial.raw),
    reservedUSD: PreciseDecimal.fromRaw(zero.raw),
    inPositionsUSD: PreciseDecimal.fromRaw(zero.raw),
    ts: Date.now(),
  },
});

const manager = new CapitalManager(provider, {
  reserveTtlMs: capitalConfig.reserveTtlMs,
  reserveBufferPct: cloneDecimal(capitalConfig.reserveBufferPct),
  perSymbolCapPct: cloneDecimal(capitalConfig.perSymbolCapPct),
  maxPositions: capitalConfig.maxPositions,
  minOrderUSD: cloneDecimal(capitalConfig.minOrderUSD),
  validateLiveBalance: false,
}, {
  reservations: new Map(),
  symbolExposure: new Map(),
});

assert.equal(capitalConfig.minOrderUSD.toNumber(), 40, 'min order should follow configured notional');

const reservation = await manager.reserve({
  agentId: 'small-account',
  symbol: 'MAVIA/USDT',
  requestedUSD: new PreciseDecimal('40'),
  minUSD: new PreciseDecimal('40'),
});

assert(reservation, 'reservation should be granted at configured minimum');
assert.equal(reservation?.grantedUSD.toNumber(), 40, 'granted notional should match request');

const snap = await provider.getSnapshot();
assert.equal(Number(snap.reservedUSD.toNumber().toFixed(2)), 40, 'reserved ledger should reflect grant');

console.log('✅ capital-min-order.mjs passed');
