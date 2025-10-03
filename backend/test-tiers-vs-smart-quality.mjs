#!/usr/bin/env node
/**
 * Test: TIERS vs Smart Quality Scoring
 * 
 * Compare two approaches:
 * 1. TIERS: Arbitrary bonuses/penalties based on crypto name
 * 2. Smart Quality: Objective criteria (liquidity, spread, volatility)
 * 
 * Which one produces better risk-adjusted returns?
 */

console.log('🧪 Testing: TIERS vs Smart Quality Scoring\n');

// Mock market data (realistic scenario)
const marketData = [
  {
    symbol: 'BTC/USD:USD',
    tier: 1,
    movement: 0.8,
    volume24h: 30_000_000_000,
    spread: 0.01,
    avgVolatility: 1.2,
    aiScore: 7.0,
    setupQuality: 8.5, // Clean S/R, volume confirmation
    marketCap: 1_200_000_000_000,
  },
  {
    symbol: 'ETH/USD:USD',
    tier: 1,
    movement: 1.2,
    volume24h: 15_000_000_000,
    spread: 0.01,
    avgVolatility: 1.5,
    aiScore: 7.5,
    setupQuality: 8.0,
    marketCap: 400_000_000_000,
  },
  {
    symbol: 'SOL/USD:USD',
    tier: 1,
    movement: 2.5,
    volume24h: 2_000_000_000,
    spread: 0.02,
    avgVolatility: 2.0,
    aiScore: 8.0,
    setupQuality: 8.5,
    marketCap: 80_000_000_000,
  },
  {
    symbol: 'XRP/USD:USD',
    tier: 2,
    movement: 1.5,
    volume24h: 3_000_000_000,
    spread: 0.02,
    avgVolatility: 1.8,
    aiScore: 7.2,
    setupQuality: 7.5,
    marketCap: 50_000_000_000,
  },
  {
    symbol: 'ENA/USD:USD',
    tier: 4,
    movement: 5.0,
    volume24h: 200_000_000,
    spread: 0.08,
    avgVolatility: 3.5,
    aiScore: 8.5,
    setupQuality: 7.0, // Good momentum but thin liquidity
    marketCap: 2_000_000_000,
  },
  {
    symbol: 'EIGEN/USD:USD',
    tier: 4,
    movement: 4.0,
    volume24h: 150_000_000,
    spread: 0.10,
    avgVolatility: 4.0,
    aiScore: 8.0,
    setupQuality: 6.5,
    marketCap: 1_500_000_000,
  },
  {
    symbol: 'AVAX/USD:USD',
    tier: 3,
    movement: 3.0,
    volume24h: 500_000_000,
    spread: 0.03,
    avgVolatility: 2.5,
    aiScore: 7.8,
    setupQuality: 7.8,
    marketCap: 15_000_000_000,
  },
];

console.log('📊 Market Snapshot:\n');
marketData.forEach(c => {
  console.log(`${c.symbol.padEnd(20)} | Movement: ${c.movement.toFixed(1)}% | Volume: $${(c.volume24h / 1e9).toFixed(1)}B | Spread: ${c.spread}% | AI Score: ${c.aiScore}/10`);
});
console.log('\n' + '='.repeat(120) + '\n');

// ========================================
// APPROACH 1: TIERS (Current System)
// ========================================
console.log('🏷️  APPROACH 1: TIERS System (Current)\n');

const tierBonuses = {
  1: 2.0,   // BTC, ETH, SOL
  2: 1.0,   // XRP, BNB, ADA
  3: 0.3,   // AVAX, LINK, UNI
  4: -1.0,  // ENA, EIGEN
};

const tiersScores = marketData.map(c => {
  const bonus = tierBonuses[c.tier] || 0;
  const finalScore = c.aiScore + bonus;
  return { ...c, bonus, finalScore };
});

tiersScores.sort((a, b) => b.finalScore - a.finalScore);

console.log('Ranking:');
tiersScores.forEach((c, i) => {
  const selected = i < 5 ? '✅' : '❌';
  console.log(`${(i + 1).toString().padStart(2)}. ${selected} ${c.symbol.padEnd(20)} | AI: ${c.aiScore.toFixed(1)} + Tier Bonus: ${c.bonus > 0 ? '+' : ''}${c.bonus.toFixed(1)} = ${c.finalScore.toFixed(1)}/10`);
});

const tiersTop5 = tiersScores.slice(0, 5);
const tiersAvgMovement = tiersTop5.reduce((sum, c) => sum + c.movement, 0) / tiersTop5.length;
const tiersAvgSpread = tiersTop5.reduce((sum, c) => sum + c.spread, 0) / tiersTop5.length;
const tiersAvgVolume = tiersTop5.reduce((sum, c) => sum + c.volume24h, 0) / tiersTop5.length;

console.log('\n📈 Top 5 Statistics:');
console.log(`  Avg Movement: ${tiersAvgMovement.toFixed(2)}%`);
console.log(`  Avg Spread: ${tiersAvgSpread.toFixed(3)}%`);
console.log(`  Avg Volume: $${(tiersAvgVolume / 1e9).toFixed(1)}B`);
console.log(`  Selected: ${tiersTop5.map(c => c.symbol.split('/')[0]).join(', ')}`);

console.log('\n' + '='.repeat(120) + '\n');

// ========================================
// APPROACH 2: Smart Quality (Objective)
// ========================================
console.log('🎯 APPROACH 2: Smart Quality System (Objective)\n');

const smartScores = marketData.map(c => {
  let adjustments = 0;
  const reasons = [];

  // 1. Liquidity penalty (objective cost)
  if (c.volume24h < 50_000_000) {
    adjustments -= 1.5;
    reasons.push('Very low liquidity -1.5');
  } else if (c.volume24h < 200_000_000) {
    adjustments -= 0.5;
    reasons.push('Low liquidity -0.5');
  } else if (c.volume24h > 1_000_000_000) {
    adjustments += 0.3;
    reasons.push('Excellent liquidity +0.3');
  }

  // 2. Spread penalty (real trading cost)
  if (c.spread > 0.1) {
    adjustments -= 1.0;
    reasons.push('High spread -1.0');
  } else if (c.spread < 0.02) {
    adjustments += 0.5;
    reasons.push('Tight spread +0.5');
  }

  // 3. Exceptional movement bonus (risk/reward)
  const volatilityRatio = c.movement / c.avgVolatility;
  if (volatilityRatio > 3) {
    adjustments += 1.0;
    reasons.push(`Exceptional movement +1.0 (${volatilityRatio.toFixed(1)}x volatility)`);
  } else if (volatilityRatio < 1) {
    adjustments -= 0.5;
    reasons.push('Normal movement -0.5');
  }

  // 4. Setup quality bonus (technical)
  if (c.setupQuality >= 8.0) {
    adjustments += 0.5;
    reasons.push('Clean setup +0.5');
  }

  const finalScore = c.aiScore + adjustments;
  return { ...c, adjustments, finalScore, reasons };
});

smartScores.sort((a, b) => b.finalScore - a.finalScore);

console.log('Ranking:');
smartScores.forEach((c, i) => {
  const selected = i < 5 ? '✅' : '❌';
  console.log(`${(i + 1).toString().padStart(2)}. ${selected} ${c.symbol.padEnd(20)} | AI: ${c.aiScore.toFixed(1)} + Adjustments: ${c.adjustments > 0 ? '+' : ''}${c.adjustments.toFixed(1)} = ${c.finalScore.toFixed(1)}/10`);
  if (i < 5) {
    c.reasons.forEach(r => console.log(`       ${r}`));
  }
});

const smartTop5 = smartScores.slice(0, 5);
const smartAvgMovement = smartTop5.reduce((sum, c) => sum + c.movement, 0) / smartTop5.length;
const smartAvgSpread = smartTop5.reduce((sum, c) => sum + c.spread, 0) / smartTop5.length;
const smartAvgVolume = smartTop5.reduce((sum, c) => sum + c.volume24h, 0) / smartTop5.length;

console.log('\n📈 Top 5 Statistics:');
console.log(`  Avg Movement: ${smartAvgMovement.toFixed(2)}%`);
console.log(`  Avg Spread: ${smartAvgSpread.toFixed(3)}%`);
console.log(`  Avg Volume: $${(smartAvgVolume / 1e9).toFixed(1)}B`);
console.log(`  Selected: ${smartTop5.map(c => c.symbol.split('/')[0]).join(', ')}`);

console.log('\n' + '='.repeat(120) + '\n');

// ========================================
// COMPARISON & SIMULATION
// ========================================
console.log('⚖️  COMPARISON: Which Approach Performs Better?\n');

// Simulate expected profit (considering slippage and execution costs)
const simulateTrade = (crypto) => {
  const targetProfit = 2.0; // Agent targets +2% profit
  const slippage = crypto.spread * 2; // Entry + Exit slippage
  const realProfit = targetProfit - slippage;
  
  // Probability of hitting TP (based on movement magnitude)
  const probabilitySuccess = Math.min(0.95, crypto.movement / 2.0 * 0.5);
  
  // Risk of stop out (thin liquidity = worse execution)
  const stopSlippage = crypto.volume24h < 500_000_000 ? 0.5 : 0.1;
  const lossIfStop = -1.0 - stopSlippage; // -1R target + slippage
  
  const expectedValue = (probabilitySuccess * realProfit) + ((1 - probabilitySuccess) * lossIfStop);
  
  return {
    targetProfit,
    slippage,
    realProfit,
    probabilitySuccess,
    stopSlippage,
    expectedValue,
  };
};

console.log('🎲 Expected Value Analysis:\n');

console.log('TIERS Approach:');
let tiersEV = 0;
tiersTop5.forEach((c, i) => {
  const sim = simulateTrade(c);
  tiersEV += sim.expectedValue;
  console.log(`  ${c.symbol.split('/')[0].padEnd(6)} | Target: +${sim.targetProfit}% | Slippage: -${sim.slippage.toFixed(2)}% | Real: +${sim.realProfit.toFixed(2)}% | Success: ${(sim.probabilitySuccess * 100).toFixed(0)}% | EV: ${sim.expectedValue > 0 ? '+' : ''}${sim.expectedValue.toFixed(2)}%`);
});
console.log(`  → Total EV: ${tiersEV > 0 ? '+' : ''}${tiersEV.toFixed(2)}%\n`);

console.log('Smart Quality Approach:');
let smartEV = 0;
smartTop5.forEach((c, i) => {
  const sim = simulateTrade(c);
  smartEV += sim.expectedValue;
  console.log(`  ${c.symbol.split('/')[0].padEnd(6)} | Target: +${sim.targetProfit}% | Slippage: -${sim.slippage.toFixed(2)}% | Real: +${sim.realProfit.toFixed(2)}% | Success: ${(sim.probabilitySuccess * 100).toFixed(0)}% | EV: ${sim.expectedValue > 0 ? '+' : ''}${sim.expectedValue.toFixed(2)}%`);
});
console.log(`  → Total EV: ${smartEV > 0 ? '+' : ''}${smartEV.toFixed(2)}%\n`);

// Final verdict
console.log('='.repeat(120));
console.log('\n🏆 VERDICT:\n');

const winner = smartEV > tiersEV ? 'Smart Quality' : 'TIERS';
const evDiff = Math.abs(smartEV - tiersEV);

console.log(`Winner: ${winner}`);
console.log(`EV Difference: ${evDiff.toFixed(2)}%`);
console.log('');

console.log('💡 Key Insights:');
console.log(`  • TIERS Approach: Favors ${tiersTop5[0].symbol.split('/')[0]} (${tiersTop5[0].movement}% movement, ${(tiersTop5[0].volume24h / 1e9).toFixed(1)}B volume)`);
console.log(`  • Smart Quality: Favors ${smartTop5[0].symbol.split('/')[0]} (${smartTop5[0].movement}% movement, ${(smartTop5[0].volume24h / 1e9).toFixed(1)}B volume)`);
console.log(`  • TIERS Total EV: ${tiersEV > 0 ? '+' : ''}${tiersEV.toFixed(2)}% (${tiersAvgMovement.toFixed(2)}% avg movement, ${tiersAvgSpread.toFixed(3)}% avg spread)`);
console.log(`  • Smart Quality Total EV: ${smartEV > 0 ? '+' : ''}${smartEV.toFixed(2)}% (${smartAvgMovement.toFixed(2)}% avg movement, ${smartAvgSpread.toFixed(3)}% avg spread)`);
console.log('');

if (Math.abs(evDiff) < 0.5) {
  console.log('⚖️  Both approaches are roughly equivalent in this scenario.');
  console.log('   Consider using Smart Quality for more objective decision-making.');
} else if (winner === 'Smart Quality') {
  console.log('✅ Smart Quality wins by being more objective and capturing good setups');
  console.log('   regardless of arbitrary tier classifications.');
} else {
  console.log('✅ TIERS wins by avoiding high-cost small caps and focusing on');
  console.log('   liquid majors with better execution.');
}

console.log('\n' + '='.repeat(120));
