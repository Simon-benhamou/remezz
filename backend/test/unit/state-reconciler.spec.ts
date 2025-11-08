/**
 * State Reconciler Unit Tests
 * 
 * Tests the core logic of the state reconciliation service
 */

import assert from 'node:assert/strict';

// Mock types for testing
type ExchangePosition = {
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  entryPrice?: number;
  markPrice?: number;
};

type ReconciledState = {
  positions: Map<string, ExchangePosition>;
  marginSnapshot: any;
  lastUpdate: number;
  isStale: boolean;
};

// Helper to detect state changes (simplified version of StateReconciler logic)
function detectStateChanges(
  previousState: ReconciledState | undefined,
  currentPositions: ExchangePosition[]
): {
  ghostPositions: string[];
  newPositions: ExchangePosition[];
  quantityMismatches: Array<{ symbol: string; oldQty: number; newQty: number }>;
} {
  const result = {
    ghostPositions: [] as string[],
    newPositions: [] as ExchangePosition[],
    quantityMismatches: [] as Array<{ symbol: string; oldQty: number; newQty: number }>,
  };

  if (!previousState) {
    return result;
  }

  const currentSymbols = new Set(currentPositions.map(p => p.symbol));
  const previousSymbols = new Set(previousState.positions.keys());

  // Find ghost positions
  for (const symbol of previousSymbols) {
    if (!currentSymbols.has(symbol)) {
      result.ghostPositions.push(symbol);
    }
  }

  // Find new positions and quantity mismatches
  for (const pos of currentPositions) {
    if (!previousSymbols.has(pos.symbol)) {
      result.newPositions.push(pos);
    } else {
      const prevPos = previousState.positions.get(pos.symbol);
      if (prevPos && Math.abs(prevPos.qty - pos.qty) > 1e-6) {
        const diffPct = Math.abs((prevPos.qty - pos.qty) / prevPos.qty) * 100;
        if (diffPct > 5) {
          result.quantityMismatches.push({
            symbol: pos.symbol,
            oldQty: prevPos.qty,
            newQty: pos.qty,
          });
        }
      }
    }
  }

  return result;
}

console.log('🧪 Running State Reconciler Tests...\n');

// Test 1: No previous state - should not report any changes
console.log('Test 1: Initial reconciliation (no previous state)');
{
  const currentPositions: ExchangePosition[] = [
    { symbol: 'BTC/USDT:USDT', side: 'long', qty: 0.5, entryPrice: 50000 },
    { symbol: 'ETH/USDT:USDT', side: 'long', qty: 2.0, entryPrice: 3000 },
  ];

  const changes = detectStateChanges(undefined, currentPositions);

  assert.equal(changes.ghostPositions.length, 0, 'Should have no ghost positions on initial reconciliation');
  assert.equal(changes.newPositions.length, 0, 'Should have no new positions on initial reconciliation');
  assert.equal(changes.quantityMismatches.length, 0, 'Should have no quantity mismatches on initial reconciliation');
  
  console.log('✅ Passed: Initial reconciliation correctly reports no changes\n');
}

// Test 2: Ghost position detection
console.log('Test 2: Ghost position detection');
{
  const previousState: ReconciledState = {
    positions: new Map([
      ['BTC/USDT:USDT', { symbol: 'BTC/USDT:USDT', side: 'long', qty: 0.5, entryPrice: 50000 }],
      ['DOT/USDT:USDT', { symbol: 'DOT/USDT:USDT', side: 'long', qty: 100, entryPrice: 10 }],
    ]),
    marginSnapshot: null,
    lastUpdate: Date.now(),
    isStale: false,
  };

  const currentPositions: ExchangePosition[] = [
    { symbol: 'BTC/USDT:USDT', side: 'long', qty: 0.5, entryPrice: 50000 },
    // DOT position is missing - should be detected as ghost
  ];

  const changes = detectStateChanges(previousState, currentPositions);

  assert.equal(changes.ghostPositions.length, 1, 'Should detect 1 ghost position');
  assert.equal(changes.ghostPositions[0], 'DOT/USDT:USDT', 'Should identify DOT as ghost position');
  assert.equal(changes.newPositions.length, 0, 'Should have no new positions');
  
  console.log('✅ Passed: Ghost position (DOT/USDT:USDT) correctly detected\n');
}

// Test 3: Orphaned position detection
console.log('Test 3: Orphaned position detection');
{
  const previousState: ReconciledState = {
    positions: new Map([
      ['BTC/USDT:USDT', { symbol: 'BTC/USDT:USDT', side: 'long', qty: 0.5, entryPrice: 50000 }],
    ]),
    marginSnapshot: null,
    lastUpdate: Date.now(),
    isStale: false,
  };

  const currentPositions: ExchangePosition[] = [
    { symbol: 'BTC/USDT:USDT', side: 'long', qty: 0.5, entryPrice: 50000 },
    { symbol: 'UAI/USDT:USDT', side: 'long', qty: 500, entryPrice: 2 },
    // UAI position is new - should be detected as orphaned
  ];

  const changes = detectStateChanges(previousState, currentPositions);

  assert.equal(changes.ghostPositions.length, 0, 'Should have no ghost positions');
  assert.equal(changes.newPositions.length, 1, 'Should detect 1 new/orphaned position');
  assert.equal(changes.newPositions[0].symbol, 'UAI/USDT:USDT', 'Should identify UAI as new position');
  
  console.log('✅ Passed: Orphaned position (UAI/USDT:USDT) correctly detected\n');
}

// Test 4: Quantity mismatch detection
console.log('Test 4: Quantity mismatch detection');
{
  const previousState: ReconciledState = {
    positions: new Map([
      ['BTC/USDT:USDT', { symbol: 'BTC/USDT:USDT', side: 'long', qty: 1.0, entryPrice: 50000 }],
      ['ETH/USDT:USDT', { symbol: 'ETH/USDT:USDT', side: 'long', qty: 10.0, entryPrice: 3000 }],
    ]),
    marginSnapshot: null,
    lastUpdate: Date.now(),
    isStale: false,
  };

  const currentPositions: ExchangePosition[] = [
    { symbol: 'BTC/USDT:USDT', side: 'long', qty: 0.5, entryPrice: 50000 }, // 50% reduction
    { symbol: 'ETH/USDT:USDT', side: 'long', qty: 10.1, entryPrice: 3000 }, // 1% change (below threshold)
  ];

  const changes = detectStateChanges(previousState, currentPositions);

  assert.equal(changes.ghostPositions.length, 0, 'Should have no ghost positions');
  assert.equal(changes.newPositions.length, 0, 'Should have no new positions');
  assert.equal(changes.quantityMismatches.length, 1, 'Should detect 1 quantity mismatch');
  assert.equal(changes.quantityMismatches[0].symbol, 'BTC/USDT:USDT', 'Should identify BTC as having quantity mismatch');
  assert.equal(changes.quantityMismatches[0].oldQty, 1.0, 'Should record old quantity');
  assert.equal(changes.quantityMismatches[0].newQty, 0.5, 'Should record new quantity');
  
  console.log('✅ Passed: Quantity mismatch (BTC 1.0 -> 0.5) correctly detected\n');
}

// Test 5: Complex scenario with multiple issues
console.log('Test 5: Complex scenario with ghost + orphaned + mismatch');
{
  const previousState: ReconciledState = {
    positions: new Map([
      ['BTC/USDT:USDT', { symbol: 'BTC/USDT:USDT', side: 'long', qty: 1.0, entryPrice: 50000 }],
      ['DOT/USDT:USDT', { symbol: 'DOT/USDT:USDT', side: 'long', qty: 100, entryPrice: 10 }],
      ['SOL/USDT:USDT', { symbol: 'SOL/USDT:USDT', side: 'short', qty: 50, entryPrice: 100 }],
    ]),
    marginSnapshot: null,
    lastUpdate: Date.now(),
    isStale: false,
  };

  const currentPositions: ExchangePosition[] = [
    { symbol: 'BTC/USDT:USDT', side: 'long', qty: 0.6, entryPrice: 50000 }, // Quantity mismatch
    { symbol: 'UAI/USDT:USDT', side: 'long', qty: 500, entryPrice: 2 }, // New/orphaned
    { symbol: 'SOL/USDT:USDT', side: 'short', qty: 50, entryPrice: 100 }, // No change
    // DOT is missing - ghost position
  ];

  const changes = detectStateChanges(previousState, currentPositions);

  assert.equal(changes.ghostPositions.length, 1, 'Should detect 1 ghost position');
  assert.ok(changes.ghostPositions.includes('DOT/USDT:USDT'), 'DOT should be ghost');
  
  assert.equal(changes.newPositions.length, 1, 'Should detect 1 new position');
  assert.equal(changes.newPositions[0].symbol, 'UAI/USDT:USDT', 'UAI should be new');
  
  assert.equal(changes.quantityMismatches.length, 1, 'Should detect 1 quantity mismatch');
  assert.equal(changes.quantityMismatches[0].symbol, 'BTC/USDT:USDT', 'BTC should have mismatch');
  
  console.log('✅ Passed: Complex scenario correctly detected all issues\n');
}

// Test 6: No changes scenario
console.log('Test 6: No changes scenario');
{
  const previousState: ReconciledState = {
    positions: new Map([
      ['BTC/USDT:USDT', { symbol: 'BTC/USDT:USDT', side: 'long', qty: 0.5, entryPrice: 50000 }],
      ['ETH/USDT:USDT', { symbol: 'ETH/USDT:USDT', side: 'long', qty: 2.0, entryPrice: 3000 }],
    ]),
    marginSnapshot: null,
    lastUpdate: Date.now(),
    isStale: false,
  };

  const currentPositions: ExchangePosition[] = [
    { symbol: 'BTC/USDT:USDT', side: 'long', qty: 0.5, entryPrice: 50000 },
    { symbol: 'ETH/USDT:USDT', side: 'long', qty: 2.0, entryPrice: 3000 },
  ];

  const changes = detectStateChanges(previousState, currentPositions);

  assert.equal(changes.ghostPositions.length, 0, 'Should have no ghost positions');
  assert.equal(changes.newPositions.length, 0, 'Should have no new positions');
  assert.equal(changes.quantityMismatches.length, 0, 'Should have no quantity mismatches');
  
  console.log('✅ Passed: No changes scenario correctly reports all clean\n');
}

console.log('✅ All State Reconciler tests passed!\n');
