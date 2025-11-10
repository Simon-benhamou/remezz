import assert from 'node:assert/strict';
import { prisma } from '../../dist/src/db/client.js';

const { setPaperBalance, initializePaperBalance, getBalanceSnapshot } = await import('../../dist/src/services/capitalPool.js');

try {
  console.log('🧪 Testing paper balance persistence...');
  
  // Test 1: Set paper balance and verify it's saved to database
  console.log('Test 1: Setting paper balance to $5000');
  await setPaperBalance(5000);
  
  const setting = await prisma.systemSetting.findUnique({
    where: { key: 'paper_balance_usd' },
  });
  
  assert.ok(setting, 'SystemSetting should exist in database');
  assert.equal(parseFloat(setting.value), 5000, 'Database should contain $5000');
  console.log('✅ Test 1 passed: Balance saved to database');
  
  // Test 2: Verify snapshot reflects the balance
  let snapshot = await getBalanceSnapshot('paper');
  assert.equal(Math.round(snapshot.totalUSD.toNumber()), 5000, 'Snapshot should show $5000');
  console.log('✅ Test 2 passed: Snapshot reflects correct balance');
  
  // Test 3: Initialize from database (simulating server restart)
  console.log('Test 3: Simulating server restart by initializing from database');
  await initializePaperBalance();
  
  snapshot = await getBalanceSnapshot('paper');
  assert.equal(Math.round(snapshot.totalUSD.toNumber()), 5000, 'After init, snapshot should still show $5000');
  console.log('✅ Test 3 passed: Balance persists across initialization');
  
  // Test 4: Update to different value
  console.log('Test 4: Updating balance to $2500');
  await setPaperBalance(2500);
  
  const updatedSetting = await prisma.systemSetting.findUnique({
    where: { key: 'paper_balance_usd' },
  });
  
  assert.equal(parseFloat(updatedSetting!.value), 2500, 'Database should contain updated $2500');
  
  snapshot = await getBalanceSnapshot('paper');
  assert.equal(Math.round(snapshot.totalUSD.toNumber()), 2500, 'Snapshot should show updated $2500');
  console.log('✅ Test 4 passed: Balance updates correctly');
  
  // Cleanup: Reset to default
  await setPaperBalance(1000);
  
  console.log('✅ All paper balance persistence tests passed!');
} catch (error) {
  console.error('❌ Test failed:', error);
  process.exit(1);
}
