import assert from 'node:assert/strict';

const { PreciseDecimal } = await import('../../dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');
const { PaperBalanceProvider } = await import('../../dist/src/core/capital/PaperBalanceProvider.js');
const { CapitalManager } = await import('../../dist/src/core/capital/CapitalManager.js');
const { capitalConfig } = await import('../../dist/src/config/capital.js');

function decimal(value: string | number) {
  return new PreciseDecimal(value);
}

function cloneDecimal(value: typeof capitalConfig.reserveBufferPct) {
  return PreciseDecimal.fromRaw(value.raw);
}

type ManagerFactoryOptions = {
  balance?: string | number;
  reserveTtlMs?: number;
  validateLiveBalance?: boolean;
  perSymbolCapPct?: string | number | PreciseDecimal;
};

function createManager(options: ManagerFactoryOptions = {}) {
  const initialBalance = decimal(options.balance ?? '1000');
  const zero = decimal(0);
  const snapshot = {
    totalUSD: PreciseDecimal.fromRaw(initialBalance.raw),
    freeUSD: PreciseDecimal.fromRaw(initialBalance.raw),
    reservedUSD: PreciseDecimal.fromRaw(zero.raw),
    inPositionsUSD: PreciseDecimal.fromRaw(zero.raw),
    ts: Date.now(),
  };
  const provider = new PaperBalanceProvider({ snapshot });
  const perSymbolCap = options.perSymbolCapPct
    ? new PreciseDecimal(options.perSymbolCapPct)
    : cloneDecimal(capitalConfig.perSymbolCapPct);
  const manager = new CapitalManager(provider, {
    reserveTtlMs: options.reserveTtlMs ?? capitalConfig.reserveTtlMs,
    reserveBufferPct: cloneDecimal(capitalConfig.reserveBufferPct),
    perSymbolCapPct: perSymbolCap,
    maxPositions: capitalConfig.maxPositions,
    minOrderUSD: cloneDecimal(capitalConfig.minOrderUSD),
    validateLiveBalance: options.validateLiveBalance ?? capitalConfig.validateLiveBalance,
  }, {
    reservations: new Map(),
    symbolExposure: new Map(),
  });
  return { manager, provider };
}

// Test 1: Multiple reservations should respect buffer and per-symbol cap
{
  const { manager, provider } = createManager();
  const r1 = await manager.reserve({ agentId: 'a1', symbol: 'BTC/USDT', requestedUSD: decimal('350'), minUSD: decimal('50') });
  assert.ok(r1, 'first reservation granted');
  assert.equal(r1?.grantedUSD.toNumber(), 300);

  const r2 = await manager.reserve({ agentId: 'a2', symbol: 'ETH/USDT', requestedUSD: decimal('350'), minUSD: decimal('50') });
  assert.ok(r2, 'second reservation granted');
  assert.equal(r2?.grantedUSD.toNumber(), 300);

  const r3 = await manager.reserve({ agentId: 'a3', symbol: 'SOL/USDT', requestedUSD: decimal('400'), minUSD: decimal('50') });
  assert.ok(r3, 'third reservation granted');
  assert.equal(r3?.grantedUSD.toNumber(), 300);

  const snap = await provider.getSnapshot();
  assert.equal(Number(snap.reservedUSD.toNumber().toFixed(2)), 900);
  assert.equal(Number(snap.freeUSD.toNumber().toFixed(2)), 100);
}

// Test 2: TTL expiration returns funds to free balance
{
  const { manager, provider } = createManager({ reserveTtlMs: 10 });
  const r1 = await manager.reserve({ agentId: 'ttl', symbol: 'ADA/USDT', requestedUSD: decimal('200'), minUSD: decimal('50') });
  assert.ok(r1, 'reservation created');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await manager.expireReservations();
  const snap = await provider.getSnapshot();
  assert.equal(Number(snap.reservedUSD.toNumber().toFixed(2)), 0);
  assert.equal(Number(snap.freeUSD.toNumber().toFixed(2)), 1000);
}

// Test 3: Partial fill adjusts ledgers correctly
{
  const { manager, provider } = createManager({ perSymbolCapPct: '1' });
  const reservation = await manager.reserve({ agentId: 'partial', symbol: 'XRP/USDT', requestedUSD: decimal('500'), minUSD: decimal('50') });
  assert.ok(reservation, 'reservation created');
  const committed = await manager.commit(reservation!.id, decimal('320'));
  assert.equal(committed, true);
  const snap = await provider.getSnapshot();
  assert.equal(Number(snap.inPositionsUSD.toNumber().toFixed(2)), 320);
  assert.equal(Number(snap.freeUSD.toNumber().toFixed(2)), 680);
  assert.equal(Number(snap.reservedUSD.toNumber().toFixed(2)), 0);
}

// Test 4: per-symbol cap enforces exposure limit
{
  const { manager } = createManager();
  const first = await manager.reserve({ agentId: 'cap1', symbol: 'DOGE/USDT', requestedUSD: decimal('400'), minUSD: decimal('50') });
  assert.ok(first, 'first reservation granted');
  assert.equal(first?.grantedUSD.toNumber(), 300);
  const blocked = await manager.reserve({ agentId: 'cap2', symbol: 'DOGE/USDT', requestedUSD: decimal('100'), minUSD: decimal('50') });
  assert.equal(blocked, null);
}

// Test 5: live validation rejects when free balance insufficient
{
  const initial = {
    totalUSD: decimal('1000'),
    freeUSD: decimal('1000'),
    reservedUSD: decimal('0'),
    inPositionsUSD: decimal('0'),
    ts: Date.now(),
  };
  let callCount = 0;
  const provider = {
    async getSnapshot() {
      callCount += 1;
      if (callCount === 2) {
        return { ...initial, freeUSD: decimal('100'), totalUSD: decimal('100') };
      }
      return initial;
    },
    async applyLedgerDelta() {
      throw new Error('should not apply ledger delta when validation fails');
    },
  };
  const manager = new CapitalManager(provider as any, {
    reserveTtlMs: capitalConfig.reserveTtlMs,
    reserveBufferPct: cloneDecimal(capitalConfig.reserveBufferPct),
    perSymbolCapPct: cloneDecimal(capitalConfig.perSymbolCapPct),
    maxPositions: capitalConfig.maxPositions,
    minOrderUSD: cloneDecimal(capitalConfig.minOrderUSD),
    validateLiveBalance: true,
  }, {
    reservations: new Map(),
    symbolExposure: new Map(),
  });
  const result = await manager.reserve({ agentId: 'live', symbol: 'BNB/USDT', requestedUSD: decimal('200'), minUSD: decimal('50') });
  assert.equal(result, null);
}

console.log('✅ capitalManager.spec passed');
