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

function createManager(balance: string | number = '1000') {
  const initialBalance = decimal(balance);
  const zero = decimal(0);
  const snapshot = {
    totalUSD: PreciseDecimal.fromRaw(initialBalance.raw),
    freeUSD: PreciseDecimal.fromRaw(initialBalance.raw),
    reservedUSD: PreciseDecimal.fromRaw(zero.raw),
    inPositionsUSD: PreciseDecimal.fromRaw(zero.raw),
    ts: Date.now(),
  };
  const provider = new PaperBalanceProvider({ snapshot });
  const manager = new CapitalManager(provider, {
    reserveTtlMs: capitalConfig.reserveTtlMs,
    reserveBufferPct: cloneDecimal(capitalConfig.reserveBufferPct),
    perSymbolCapPct: new PreciseDecimal('1'), // 100% for testing
    maxPositions: capitalConfig.maxPositions,
    minOrderUSD: cloneDecimal(capitalConfig.minOrderUSD),
    validateLiveBalance: false,
  }, {
    reservations: new Map(),
    symbolExposure: new Map(),
    agentEquity: new Map(),
  });
  return { manager, provider };
}

// Test 1: Reservation with 10x leverage should only reserve margin requirement
{
  const { manager, provider } = createManager('1000');
  
  // Request $1135.80 notional with 10x leverage
  // Should only reserve $113.58 margin
  const reservation = await manager.reserve({
    agentId: 'agent1',
    symbol: 'BTC/USDT',
    requestedUSD: decimal('1135.80'),
    minUSD: decimal('40'),
    leverage: 10,
  });
  
  assert.ok(reservation, 'reservation should be granted');
  assert.equal(reservation.leverage, 10, 'leverage should be stored');
  assert.equal(Number(reservation.grantedUSD.toNumber().toFixed(2)), 113.58, 'should reserve margin requirement');
  
  const snap = await provider.getSnapshot();
  assert.equal(Number(snap.reservedUSD.toNumber().toFixed(2)), 113.58, 'reserved should be margin only');
  assert.equal(Number(snap.freeUSD.toNumber().toFixed(2)), 886.42, 'free should be remaining capital');
  
  console.log('✅ Test 1 passed: 10x leverage reserves only margin requirement');
}

// Test 2: Multiple agents can use remaining pool after leveraged position
{
  const { manager, provider } = createManager('1000');
  
  // Agent 1: $1135.80 notional with 10x leverage = $113.58 margin
  const r1 = await manager.reserve({
    agentId: 'agent1',
    symbol: 'BTC/USDT',
    requestedUSD: decimal('1135.80'),
    leverage: 10,
  });
  assert.ok(r1, 'first reservation granted');
  
  // Agent 2: Should be able to reserve from remaining ~$886
  const r2 = await manager.reserve({
    agentId: 'agent2',
    symbol: 'ETH/USDT',
    requestedUSD: decimal('800'),
    leverage: 10,
  });
  assert.ok(r2, 'second reservation should be granted');
  assert.equal(Number(r2.grantedUSD.toNumber().toFixed(2)), 80, 'should reserve $80 margin for $800 notional');
  
  const snap = await provider.getSnapshot();
  const totalReserved = Number(snap.reservedUSD.toNumber().toFixed(2));
  assert.ok(totalReserved < 200, 'total reserved should be under $200 margin');
  assert.ok(snap.freeUSD.toNumber() > 800, 'should still have significant free capital');
  
  console.log('✅ Test 2 passed: Multiple agents can share pool with leverage');
}

// Test 3: Commit with leverage properly tracks margin
{
  const { manager, provider } = createManager('1000');
  
  const reservation = await manager.reserve({
    agentId: 'agent1',
    symbol: 'BTC/USDT',
    requestedUSD: decimal('1000'),
    leverage: 5,
  });
  
  assert.ok(reservation);
  assert.equal(Number(reservation.grantedUSD.toNumber().toFixed(2)), 200, 'should reserve $200 margin');
  
  // Commit the position - should move from reserved to inPositions
  await manager.commit(reservation.id, decimal('200')); // Already margin-adjusted
  
  const snap = await provider.getSnapshot();
  assert.equal(Number(snap.reservedUSD.toNumber().toFixed(2)), 0, 'reserved should be cleared');
  assert.equal(Number(snap.inPositionsUSD.toNumber().toFixed(2)), 200, 'inPositions should be margin');
  assert.equal(Number(snap.freeUSD.toNumber().toFixed(2)), 800, 'free should be remaining');
  
  console.log('✅ Test 3 passed: Commit properly tracks margin in positions');
}

// Test 4: No leverage (1x) behaves as before
{
  const { manager, provider } = createManager('1000');
  
  const reservation = await manager.reserve({
    agentId: 'agent1',
    symbol: 'BTC/USDT',
    requestedUSD: decimal('500'),
    leverage: 1, // No leverage
  });
  
  assert.ok(reservation);
  assert.equal(Number(reservation.grantedUSD.toNumber().toFixed(2)), 500, 'should reserve full amount');
  
  const snap = await provider.getSnapshot();
  assert.equal(Number(snap.reservedUSD.toNumber().toFixed(2)), 500, 'reserved should be full notional');
  assert.equal(Number(snap.freeUSD.toNumber().toFixed(2)), 500, 'free should be remaining');
  
  console.log('✅ Test 4 passed: 1x leverage (no leverage) reserves full notional');
}

// Test 5: High leverage allows more notional with less capital
{
  const { manager, provider } = createManager('100');
  
  // With $100 capital and 10x leverage, can take $1000 notional position
  // But 5% buffer means we only reserve 95% of free capital
  const reservation = await manager.reserve({
    agentId: 'agent1',
    symbol: 'BTC/USDT',
    requestedUSD: decimal('1000'),
    leverage: 10,
  });
  
  assert.ok(reservation, 'should allow high notional with leverage');
  assert.equal(Number(reservation.grantedUSD.toNumber().toFixed(2)), 95, 'should reserve 95% due to buffer');
  
  const snap = await provider.getSnapshot();
  assert.equal(Number(snap.reservedUSD.toNumber().toFixed(2)), 95, 'reserved capital with buffer');
  assert.equal(Number(snap.freeUSD.toNumber().toFixed(2)), 5, 'buffer remains free');
  
  console.log('✅ Test 5 passed: High leverage enables larger positions');
}

// Test 6: Partial fill with leverage
{
  const { manager, provider } = createManager('1000');
  
  const reservation = await manager.reserve({
    agentId: 'agent1',
    symbol: 'BTC/USDT',
    requestedUSD: decimal('1000'),
    leverage: 10,
  });
  
  assert.ok(reservation);
  assert.equal(Number(reservation.grantedUSD.toNumber().toFixed(2)), 100, 'reserved $100 margin');
  
  // Only fill 50% of the position
  await manager.commit(reservation.id, decimal('50')); // $50 margin (=$500 notional at 10x)
  
  const snap = await provider.getSnapshot();
  assert.equal(Number(snap.inPositionsUSD.toNumber().toFixed(2)), 50, 'inPositions should be filled margin');
  assert.equal(Number(snap.freeUSD.toNumber().toFixed(2)), 950, 'should refund unused margin');
  assert.equal(Number(snap.reservedUSD.toNumber().toFixed(2)), 0, 'reserved should be cleared');
  
  console.log('✅ Test 6 passed: Partial fill refunds unused margin');
}

console.log('✅ All leverage tests passed');
