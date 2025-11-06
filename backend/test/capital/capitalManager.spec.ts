import assert from 'node:assert/strict';

const { PreciseDecimal } = await import('../../dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');
const { PaperBalanceProvider } = await import('../../dist/src/core/capital/PaperBalanceProvider.js');
const { LiveBalanceProvider } = await import('../../dist/src/core/capital/LiveBalanceProvider.js');
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
    agentEquity: new Map(),
  });
  return { manager, provider };
}

type LiveManagerFactoryOptions = {
  balance?: string | number;
  perSymbolCapPct?: string | number | PreciseDecimal;
};

function createLiveManager(options: LiveManagerFactoryOptions = {}) {
  const initialBalance = decimal(options.balance ?? '1000');
  const zero = decimal(0);
  const exchangeState = {
    total: PreciseDecimal.fromRaw(initialBalance.raw),
    free: PreciseDecimal.fromRaw(initialBalance.raw),
  };
  const provider = new LiveBalanceProvider(
    {
      async getUsdBalance() {
        return { total: exchangeState.total, free: exchangeState.free };
      },
    },
    {
      snapshot: {
        totalUSD: PreciseDecimal.fromRaw(initialBalance.raw),
        freeUSD: PreciseDecimal.fromRaw(initialBalance.raw),
        reservedUSD: PreciseDecimal.fromRaw(zero.raw),
        inPositionsUSD: PreciseDecimal.fromRaw(zero.raw),
        ts: Date.now(),
      },
    },
  );
  const perSymbolCap = options.perSymbolCapPct
    ? new PreciseDecimal(options.perSymbolCapPct)
    : cloneDecimal(capitalConfig.perSymbolCapPct);
  const manager = new CapitalManager(provider as any, {
    reserveTtlMs: capitalConfig.reserveTtlMs,
    reserveBufferPct: cloneDecimal(capitalConfig.reserveBufferPct),
    perSymbolCapPct: perSymbolCap,
    maxPositions: capitalConfig.maxPositions,
    minOrderUSD: cloneDecimal(capitalConfig.minOrderUSD),
    validateLiveBalance: true,
  }, {
    reservations: new Map(),
    symbolExposure: new Map(),
    agentEquity: new Map(),
  });
  return { manager, provider, exchangeState };
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
    agentEquity: new Map(),
  });
  const result = await manager.reserve({ agentId: 'live', symbol: 'BNB/USDT', requestedUSD: decimal('200'), minUSD: decimal('50') });
  assert.equal(result, null);
}

// Test 6: concurrent reservations respect remaining balance
{
  const { manager, provider } = createManager({ balance: '120', perSymbolCapPct: '1' });
  const [first, second] = await Promise.all([
    manager.reserve({ agentId: 'concurrent-1', symbol: 'BTC/USDT', requestedUSD: decimal('80'), minUSD: decimal('50') }),
    manager.reserve({ agentId: 'concurrent-2', symbol: 'ETH/USDT', requestedUSD: decimal('80'), minUSD: decimal('50') }),
  ]);
  assert.ok(first, 'first reservation should be granted');
  assert.equal(second, null, 'second reservation should be rejected due to insufficient capital');
  const snap = await provider.getSnapshot();
  assert.equal(Number(snap.reservedUSD.toNumber().toFixed(2)), 80);
  assert.equal(Number(snap.freeUSD.toNumber().toFixed(2)), 40);
}

// Test 7: live manager tracks ledger against exchange updates
{
  const { manager, provider, exchangeState } = createLiveManager({ balance: '500', perSymbolCapPct: '1' });
  const [first, second] = await Promise.all([
    manager.reserve({ agentId: 'live-a', symbol: 'BTC/USDT', requestedUSD: decimal('300'), minUSD: decimal('50') }),
    manager.reserve({ agentId: 'live-b', symbol: 'ETH/USDT', requestedUSD: decimal('300'), minUSD: decimal('50') }),
  ]);
  assert.ok(first, 'first live reservation granted');
  assert.ok(second, 'second live reservation granted with cap');
  const combined = first!.grantedUSD.plus(second!.grantedUSD);
  assert.ok(combined.toNumber() <= 500, 'combined reservations do not exceed total capital');
  const snapAfter = await provider.getSnapshot();
  assert.equal(Number(snapAfter.reservedUSD.toNumber().toFixed(2)), Number(combined.toNumber().toFixed(2)));
  assert.ok(snapAfter.freeUSD.toNumber() >= 0, 'free capital remains non-negative');

  exchangeState.total = decimal('650');
  exchangeState.free = decimal('650');
  const driftSnap = await provider.getSnapshot();
  assert.equal(Number(driftSnap.totalUSD.toNumber().toFixed(2)), 650);
  const reconstructed = driftSnap.freeUSD.plus(driftSnap.reservedUSD).plus(driftSnap.inPositionsUSD).toNumber();
  assert.equal(Number(reconstructed.toFixed(2)), 650);
}

// Test: Per-agent equity tracking
{
  console.log('Test: Per-agent equity tracking');
  const { manager } = createManager({ balance: '10000' });
  
  // Initialize two agents with different starting equities
  await manager.initializeAgentEquity('agent1', decimal('1000'));
  await manager.initializeAgentEquity('agent2', decimal('2000'));
  
  // Check initial equity
  const agent1InitialEquity = manager.getAgentEquity('agent1');
  const agent2InitialEquity = manager.getAgentEquity('agent2');
  assert.equal(agent1InitialEquity?.currentEquity.toNumber(), 1000);
  assert.equal(agent2InitialEquity?.currentEquity.toNumber(), 2000);
  assert.equal(agent1InitialEquity?.cumulativePnl.toNumber(), 0);
  assert.equal(agent2InitialEquity?.cumulativePnl.toNumber(), 0);
  
  // Agent 1 makes a profitable trade (+100)
  await manager.applyPnlDelta('agent1', 'BTC/USDT', decimal('100'));
  
  // Agent 2 makes a losing trade (-50)
  await manager.applyPnlDelta('agent2', 'ETH/USDT', decimal('-50'));
  
  // Check updated equities - each agent should have their own PnL
  const agent1AfterTrade = manager.getAgentEquity('agent1');
  const agent2AfterTrade = manager.getAgentEquity('agent2');
  
  assert.equal(agent1AfterTrade?.cumulativePnl.toNumber(), 100);
  assert.equal(agent1AfterTrade?.currentEquity.toNumber(), 1100); // 1000 + 100
  
  assert.equal(agent2AfterTrade?.cumulativePnl.toNumber(), -50);
  assert.equal(agent2AfterTrade?.currentEquity.toNumber(), 1950); // 2000 - 50
  
  // Verify that agent1's equity is NOT affected by agent2's loss
  assert.equal(agent1AfterTrade?.currentEquity.toNumber(), 1100, 'Agent 1 equity should not be affected by Agent 2 loss');
  
  // Get all agent equities
  const allEquities = manager.getAllAgentEquity();
  assert.equal(allEquities.length, 2);
  assert.ok(allEquities.some(e => e.agentId === 'agent1' && e.currentEquity.toNumber() === 1100));
  assert.ok(allEquities.some(e => e.agentId === 'agent2' && e.currentEquity.toNumber() === 1950));
  
  console.log('✅ Per-agent equity tracking works correctly');
}

console.log('✅ capitalManager.spec passed');
