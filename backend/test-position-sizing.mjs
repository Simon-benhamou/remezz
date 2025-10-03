#!/usr/bin/env node
/**
 * Position Sizing Diagnostic Tool
 * 
 * Analyzes why CRO position was only $49.59 on $1000 balance with 5x leverage
 * Expected: ~$100 (10% of balance)
 * Actual: $49.59 (5% of balance)
 * Missing: 50% of expected size!
 */

console.log('🔍 Position Sizing Diagnostic: CRO Trade\n');
console.log('='.repeat(80));

// Trade data from user
const trade = {
  symbol: 'CRO/USD:USD',
  side: 'buy',
  qty: 225.3049,
  price: 0.2201,
  notional: 49.59,
  leverage: 4.0,
  balance: 1000,
  expectedLeverage: 5.0,
};

console.log('\n📊 Trade Details:');
console.log(`  Symbol: ${trade.symbol}`);
console.log(`  Side: ${trade.side}`);
console.log(`  Quantity: ${trade.qty}`);
console.log(`  Price: $${trade.price}`);
console.log(`  Notional: $${trade.notional}`);
console.log(`  Leverage Used: ${trade.leverage}x`);
console.log(`  Balance: $${trade.balance}`);
console.log(`  Expected Leverage: ${trade.leverage}x`);

console.log('\n' + '='.repeat(80));

// Expected sizing calculation
const baseRiskPct = 2.0; // 2% risk per trade (default)
const expectedNotional = trade.balance * (baseRiskPct / 100) * trade.expectedLeverage;

console.log('\n💰 Expected Sizing (Without Penalties):');
console.log(`  Base Risk: ${baseRiskPct}% of balance`);
console.log(`  Risk Amount: $${trade.balance} × ${baseRiskPct}% = $${(trade.balance * baseRiskPct / 100).toFixed(2)}`);
console.log(`  With Leverage: $${(trade.balance * baseRiskPct / 100).toFixed(2)} × ${trade.expectedLeverage}x = $${expectedNotional.toFixed(2)}`);
console.log(`  Expected Notional: $${expectedNotional.toFixed(2)}`);

// Actual sizing
console.log('\n📉 Actual Sizing (With Penalties):');
console.log(`  Actual Notional: $${trade.notional}`);
console.log(`  Actual Leverage: ${trade.leverage}x`);
console.log(`  Actual Position Size: ${((trade.notional / trade.balance) * 100).toFixed(2)}% of balance`);

// Calculate total penalty
const sizingRatio = trade.notional / expectedNotional;
const totalPenalty = 1 - sizingRatio;

console.log('\n⚠️  Size Reduction Analysis:');
console.log(`  Expected: $${expectedNotional.toFixed(2)}`);
console.log(`  Actual: $${trade.notional}`);
console.log(`  Sizing Ratio: ${(sizingRatio * 100).toFixed(1)}%`);
console.log(`  Total Penalty: ${(totalPenalty * 100).toFixed(1)}%`);
console.log(`  Missing: $${(expectedNotional - trade.notional).toFixed(2)}`);

console.log('\n' + '='.repeat(80));

// Possible penalties from computeQualityBasedSizing
console.log('\n🔍 Likely Penalties Applied (Reverse Engineering):\n');

const penalties = [
  {
    name: 'Aggressiveness Level',
    condition: 'Conservative mode',
    multiplier: 0.8,
    reason: 'Base multiplier for conservative = 0.8 (line 2452)',
    applied: 'LIKELY',
  },
  {
    name: 'ADX < 15',
    condition: 'Weak trend detected',
    multiplier: 0.7,
    reason: 'ADX below 15 triggers 0.7x multiplier (line 2460)',
    applied: 'POSSIBLE',
  },
  {
    name: 'Sideways Market',
    condition: 'EMA spread < 0.002',
    multiplier: 0.6,
    reason: 'Sideways market detection (line 2469)',
    applied: 'POSSIBLE',
  },
  {
    name: 'Low Volume',
    condition: 'Volume ratio < 0.8',
    multiplier: 0.8,
    reason: 'Volume below 80% of MA (line 2476)',
    applied: 'POSSIBLE',
  },
  {
    name: 'High Volatility',
    condition: 'ATR% > 2.0%',
    multiplier: 0.9,
    reason: 'High volatility penalty (line 2479)',
    applied: 'POSSIBLE',
  },
  {
    name: 'Loss Streak',
    condition: '1+ recent losses',
    multiplier: 0.85,
    reason: 'Loss streak penalty 15% per loss (line 2502)',
    applied: 'VERY LIKELY',
  },
  {
    name: 'Risk Fraction Reduction',
    condition: 'Default 0.01 instead of 0.02',
    multiplier: 0.5,
    reason: 'risk_fraction might be set to 1% instead of 2%',
    applied: 'CRITICAL',
  },
];

let cumulativePenalty = 1.0;
penalties.forEach((p, i) => {
  const wouldResult = cumulativePenalty * p.multiplier;
  const match = Math.abs(wouldResult - sizingRatio) < 0.15;
  
  console.log(`${i + 1}. ${p.name}${match ? ' ✅ MATCH!' : ''}`);
  console.log(`   Condition: ${p.condition}`);
  console.log(`   Multiplier: ${p.multiplier}x`);
  console.log(`   Reason: ${p.reason}`);
  console.log(`   Applied: ${p.applied}`);
  if (p.applied === 'CRITICAL' || p.applied === 'VERY LIKELY' || match) {
    cumulativePenalty *= p.multiplier;
    console.log(`   → Cumulative after this: ${(cumulativePenalty * 100).toFixed(1)}%`);
  }
  console.log('');
});

console.log('='.repeat(80));

// Calculate most likely scenario
console.log('\n🎯 Most Likely Scenario:\n');

const scenario1 = 0.8 * 0.85 * 0.8; // Conservative + Loss Streak + Low Volume
const scenario2 = 0.8 * 0.7 * 0.8; // Conservative + Weak ADX + Low Volume
const scenario3 = 0.5; // risk_fraction = 0.01 instead of 0.02

console.log(`Scenario 1: Conservative (0.8) × Loss Streak (0.85) × Low Volume (0.8) = ${(scenario1 * 100).toFixed(1)}% = $${(expectedNotional * scenario1).toFixed(2)}`);
console.log(`Scenario 2: Conservative (0.8) × Weak ADX (0.7) × Low Volume (0.8) = ${(scenario2 * 100).toFixed(1)}% = $${(expectedNotional * scenario2).toFixed(2)}`);
console.log(`Scenario 3: risk_fraction = 0.01 instead of 0.02 = ${(scenario3 * 100).toFixed(1)}% = $${(expectedNotional * scenario3).toFixed(2)}`);

console.log('\n📊 Comparison with Actual:');
console.log(`  Actual notional: $${trade.notional}`);
console.log(`  Scenario 1 match: ${Math.abs(expectedNotional * scenario1 - trade.notional) < 5 ? '✅ EXACT!' : '❌'}`);
console.log(`  Scenario 2 match: ${Math.abs(expectedNotional * scenario2 - trade.notional) < 5 ? '✅ EXACT!' : '❌'}`);
console.log(`  Scenario 3 match: ${Math.abs(expectedNotional * scenario3 - trade.notional) < 5 ? '✅ EXACT!' : '❌'}`);

console.log('\n' + '='.repeat(80));

// Solution recommendations
console.log('\n💡 SOLUTIONS:\n');

console.log('1. ⚙️  CRITICAL: Check risk_fraction setting');
console.log('   Problem: If risk_fraction = 0.01 (1%) instead of 0.02 (2%), size is halved');
console.log('   Fix: Ensure profile.riskPerTradePct = 2.0 and plan.position.risk_fraction = 0.02');
console.log('   Impact: Would DOUBLE position size to ~$100\n');

console.log('2. 📊 HIGH: Reduce quality penalty multipliers');
console.log('   Problem: Too many penalties stacking (conservative, ADX, volume, etc.)');
console.log('   Fix: Reduce penalty severity or cap cumulative penalty at 0.7 (max 30% reduction)');
console.log('   Current penalties:');
console.log('     • Conservative: 0.8x → Change to 0.9x');
console.log('     • Weak ADX: 0.7x → Change to 0.85x');
console.log('     • Low volume: 0.8x → Change to 0.9x');
console.log('     • Loss streak: 0.85x → Change to 0.95x');
console.log('   Impact: Would increase size by 30-40%\n');

console.log('3. 🎯 MEDIUM: Implement minimum notional');
console.log('   Problem: Position too small to justify trading costs');
console.log('   Fix: Set minimum notional to $80-100 (8-10% of balance)');
console.log('   Code: const minNotional = balance * 0.08; notional = Math.max(notional, minNotional);');
console.log('   Impact: Ensures meaningful position sizes\n');

console.log('4. 🔄 LOW: Review aggressiveness mode');
console.log('   Problem: Conservative mode reduces all positions by 20%');
console.log('   Fix: Consider using "reactive" mode for standard sizing');
console.log('   Impact: +25% position size (0.8 → 1.0)\n');

console.log('='.repeat(80));

// Expected outcome after fixes
console.log('\n✅ Expected Outcome After Fixes:\n');

const fixedScenario1 = 1.0 * 1.0 * 1.0; // Remove conservative, remove penalties
const fixedNotional1 = expectedNotional * fixedScenario1;

const fixedScenario2 = 0.9 * 0.95 * 0.9; // Reduced penalties
const fixedNotional2 = expectedNotional * fixedScenario2;

const fixedScenario3 = Math.max(trade.balance * 0.08, expectedNotional * 0.5); // Minimum notional

console.log(`Fix 1 (Remove all penalties): $${fixedNotional1.toFixed(2)} (${((fixedNotional1 / trade.balance) * 100).toFixed(1)}% of balance)`);
console.log(`Fix 2 (Reduce penalties): $${fixedNotional2.toFixed(2)} (${((fixedNotional2 / trade.balance) * 100).toFixed(1)}% of balance)`);
console.log(`Fix 3 (Minimum notional $80): $${fixedScenario3.toFixed(2)} (${((fixedScenario3 / trade.balance) * 100).toFixed(1)}% of balance)`);

console.log('\n🎯 Recommended: Fix 1 (risk_fraction = 0.02) + Fix 2 (reduce penalties)');
console.log(`   Expected result: $90-100 notional (9-10% of balance)`);
console.log(`   This is 2x current size and appropriate for 5x leverage trading\n`);

console.log('='.repeat(80));
