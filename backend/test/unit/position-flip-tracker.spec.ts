/**
 * Position Flip Tracker Unit Tests
 * 
 * Tests the position flipping cooldown logic and tracking
 */

import assert from 'node:assert/strict';
import {
  canFlipPosition,
  recordPositionFlip,
  getFlipStats,
  clearFlipHistory,
} from '../../src/services/positionFlipTracker.js';

console.log('\n🧪 Testing Position Flip Tracker...\n');

// Test 1: Initially should allow flips
console.log('🧪 Test 1: Initial state allows flips');
{
  const sessionId = 'test-session-1';
  const config = { cooldownMinutes: 30, maxFlipsPerHour: 3 };
  
  const result = canFlipPosition(sessionId, config);
  assert.equal(result.allowed, true, 'Should allow flip initially');
  assert.equal(result.reason, undefined, 'Should have no rejection reason');
  
  console.log('✅ Initial state correctly allows flips');
}

// Test 2: Time-based cooldown enforcement
console.log('\n🧪 Test 2: Time-based cooldown enforcement');
{
  const sessionId = 'test-session-2';
  const config = { cooldownMinutes: 30, maxFlipsPerHour: 3 };
  
  // Record a flip
  recordPositionFlip(sessionId, {
    fromSide: 'long',
    toSide: 'short',
    price: 100,
    confidence: 0.75,
    rMultiple: 2.5,
  });
  
  // Immediately check if we can flip again
  const result = canFlipPosition(sessionId, config);
  assert.equal(result.allowed, false, 'Should block flip during cooldown');
  assert.ok(result.reason?.includes('cooldown active'), 'Should indicate cooldown reason');
  
  console.log('✅ Time-based cooldown correctly enforced');
  
  // Clean up
  clearFlipHistory(sessionId);
}

// Test 3: Count-based cooldown enforcement
console.log('\n🧪 Test 3: Count-based cooldown (max flips per hour)');
{
  const sessionId = 'test-session-3';
  const config = { cooldownMinutes: 0, maxFlipsPerHour: 3 }; // No time cooldown, only count
  
  // Record 3 flips (the maximum)
  for (let i = 0; i < 3; i++) {
    recordPositionFlip(sessionId, {
      fromSide: i % 2 === 0 ? 'long' : 'short',
      toSide: i % 2 === 0 ? 'short' : 'long',
      price: 100 + i,
      confidence: 0.8,
      rMultiple: 2.0 + i * 0.5,
    });
  }
  
  // Try to flip again - should be blocked
  const result = canFlipPosition(sessionId, config);
  assert.equal(result.allowed, false, 'Should block flip when max per hour reached');
  assert.ok(result.reason?.includes('Maximum flips per hour'), 'Should indicate count limit reason');
  
  console.log('✅ Count-based cooldown correctly enforced');
  
  // Clean up
  clearFlipHistory(sessionId);
}

// Test 4: Flip statistics tracking
console.log('\n🧪 Test 4: Flip statistics tracking');
{
  const sessionId = 'test-session-4';
  
  // Record multiple flips
  recordPositionFlip(sessionId, {
    fromSide: 'long',
    toSide: 'short',
    price: 100,
    confidence: 0.75,
    rMultiple: 2.5,
  });
  
  recordPositionFlip(sessionId, {
    fromSide: 'short',
    toSide: 'long',
    price: 105,
    confidence: 0.80,
    rMultiple: 3.0,
  });
  
  const stats = getFlipStats(sessionId);
  assert.equal(stats.totalFlipsLast24h, 2, 'Should track 2 flips in last 24h');
  assert.equal(stats.totalFlipsLastHour, 2, 'Should track 2 flips in last hour');
  assert.ok(stats.lastFlipTimestamp !== null, 'Should have last flip timestamp');
  assert.ok(stats.minutesSinceLastFlip !== null && stats.minutesSinceLastFlip < 1, 'Should have recent flip');
  
  console.log('✅ Flip statistics correctly tracked');
  
  // Clean up
  clearFlipHistory(sessionId);
}

// Test 5: Multiple sessions isolated
console.log('\n🧪 Test 5: Multiple sessions isolated');
{
  const session1 = 'test-session-5a';
  const session2 = 'test-session-5b';
  const config = { cooldownMinutes: 30, maxFlipsPerHour: 3 };
  
  // Record flip in session1
  recordPositionFlip(session1, {
    fromSide: 'long',
    toSide: 'short',
    price: 100,
    confidence: 0.75,
    rMultiple: 2.5,
  });
  
  // Session1 should be in cooldown
  const result1 = canFlipPosition(session1, config);
  assert.equal(result1.allowed, false, 'Session1 should be in cooldown');
  
  // Session2 should still be able to flip
  const result2 = canFlipPosition(session2, config);
  assert.equal(result2.allowed, true, 'Session2 should be able to flip');
  
  console.log('✅ Sessions correctly isolated');
  
  // Clean up
  clearFlipHistory(session1);
  clearFlipHistory(session2);
}

// Test 6: Clearing flip history
console.log('\n🧪 Test 6: Clearing flip history');
{
  const sessionId = 'test-session-6';
  const config = { cooldownMinutes: 30, maxFlipsPerHour: 3 };
  
  // Record a flip
  recordPositionFlip(sessionId, {
    fromSide: 'long',
    toSide: 'short',
    price: 100,
    confidence: 0.75,
    rMultiple: 2.5,
  });
  
  // Verify cooldown is active
  const resultBefore = canFlipPosition(sessionId, config);
  assert.equal(resultBefore.allowed, false, 'Should be in cooldown before clear');
  
  // Clear history
  clearFlipHistory(sessionId);
  
  // Verify cooldown is cleared
  const resultAfter = canFlipPosition(sessionId, config);
  assert.equal(resultAfter.allowed, true, 'Should allow flip after clearing history');
  
  console.log('✅ Flip history correctly cleared');
}

// Test 7: Zero cooldown allows immediate flips
console.log('\n🧪 Test 7: Zero cooldown configuration');
{
  const sessionId = 'test-session-7';
  const config = { cooldownMinutes: 0, maxFlipsPerHour: 10 }; // No cooldowns
  
  // Record first flip
  recordPositionFlip(sessionId, {
    fromSide: 'long',
    toSide: 'short',
    price: 100,
    confidence: 0.75,
    rMultiple: 2.5,
  });
  
  // Should allow immediate flip with zero cooldown
  const result = canFlipPosition(sessionId, config);
  assert.equal(result.allowed, true, 'Should allow flip with zero cooldown config');
  
  console.log('✅ Zero cooldown correctly bypasses time check');
  
  // Clean up
  clearFlipHistory(sessionId);
}

console.log('\n✅ All Position Flip Tracker tests passed!\n');
