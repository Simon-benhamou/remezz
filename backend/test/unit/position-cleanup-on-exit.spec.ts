/**
 * Position Cleanup on Exit Unit Tests
 * 
 * Verifies that positions are properly deleted when fully closed (qty=0)
 * to prevent ghost positions from persisting in the database.
 */

import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';

const { prisma } = await import('../../dist/src/db/client.js');
const { recordEnter, recordExit } = await import('../../dist/src/agent/persistence.js');

const testSessionId = 'test-session-ghost-position-' + Date.now();
const testSymbol = 'AVAX/USDT';

async function cleanup() {
  await prisma.fill.deleteMany({ where: { sessionId: testSessionId } });
  await prisma.order.deleteMany({ where: { sessionId: testSessionId } });
  await prisma.position.deleteMany({ where: { sessionId: testSessionId } });
  await prisma.triggerLog.deleteMany({ where: { sessionId: testSessionId } });
}

// Test 1: Position should be deleted when fully closed (qty=0)
await cleanup();
await recordEnter({
  sessionId: testSessionId,
  symbol: testSymbol,
  side: 'buy',
  qty: 10,
  entryPrice: 17.7342,
  stop: 17.578,
});

let position = await prisma.position.findFirst({
  where: { sessionId: testSessionId, symbol: testSymbol },
});
assert(position, 'Position should exist after entry');
assert.strictEqual(position.qty, 10, 'Position qty should be 10');

await recordExit({
  sessionId: testSessionId,
  symbol: testSymbol,
  side: 'buy',
  exitPrice: 18.0,
  qty: 10,
  realizedPnl: 26.58,
});

position = await prisma.position.findFirst({
  where: { sessionId: testSessionId, symbol: testSymbol },
});
assert.strictEqual(position, null, 'Position should be deleted after full exit (no ghost position with qty=0)');

console.log('✅ Test 1 passed: Position deleted when fully closed');

// Test 2: Position qty should be updated on partial exit
await cleanup();
await recordEnter({
  sessionId: testSessionId,
  symbol: testSymbol,
  side: 'buy',
  qty: 10,
  entryPrice: 17.7342,
  stop: 17.578,
});

await recordExit({
  sessionId: testSessionId,
  symbol: testSymbol,
  side: 'buy',
  exitPrice: 18.0,
  qty: 6,
  realizedPnl: 15.95,
});

position = await prisma.position.findFirst({
  where: { sessionId: testSessionId, symbol: testSymbol },
});
assert(position, 'Position should still exist after partial exit');
assert.strictEqual(position.qty, 4, 'Position qty should be 4 after partial exit');

console.log('✅ Test 2 passed: Position qty updated on partial exit');

// Test 3: Position should be deleted when remaining qty is negligible (epsilon)
await cleanup();
await recordEnter({
  sessionId: testSessionId,
  symbol: testSymbol,
  side: 'buy',
  qty: 10,
  entryPrice: 17.7342,
});

await recordExit({
  sessionId: testSessionId,
  symbol: testSymbol,
  side: 'buy',
  exitPrice: 18.0,
  qty: 9.9999999,
  realizedPnl: 26.58,
});

position = await prisma.position.findFirst({
  where: { sessionId: testSessionId, symbol: testSymbol },
});
assert.strictEqual(position, null, 'Position should be deleted when qty within epsilon threshold');

console.log('✅ Test 3 passed: Position deleted when remaining qty is negligible');

// Test 4: Should allow reopening position after full exit
await cleanup();
await recordEnter({
  sessionId: testSessionId,
  symbol: testSymbol,
  side: 'buy',
  qty: 10,
  entryPrice: 17.7342,
});

await recordExit({
  sessionId: testSessionId,
  symbol: testSymbol,
  side: 'buy',
  exitPrice: 18.0,
  qty: 10,
  realizedPnl: 26.58,
});

position = await prisma.position.findFirst({
  where: { sessionId: testSessionId, symbol: testSymbol },
});
assert.strictEqual(position, null, 'No position should exist after full exit');

await recordEnter({
  sessionId: testSessionId,
  symbol: testSymbol,
  side: 'sell',
  qty: 5,
  entryPrice: 18.5,
  stop: 19.0,
});

position = await prisma.position.findFirst({
  where: { sessionId: testSessionId, symbol: testSymbol },
});
assert(position, 'New position should exist');
assert.strictEqual(position.qty, 5, 'New position qty should be 5');
assert.strictEqual(position.side, 'sell', 'New position side should be sell');
assert.strictEqual(position.entryPrice, 18.5, 'New position entryPrice should be 18.5');

console.log('✅ Test 4 passed: Position can be reopened after full exit');

await cleanup();
console.log('✅ position-cleanup-on-exit.spec.ts passed');
