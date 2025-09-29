#!/usr/bin/env node

// Test des seuils avec différents profils de crypto
async function testThresholdsAcrossCryptos() {
  console.log('🧪 Testing Realistic Thresholds Across Different Crypto Profiles\n');
  
  const cryptos = [
    // High volatility memecoins/altcoins
    { symbol: 'AVNT/USDT', type: 'HIGH_VOLATILITY', rsi: 38, adx: 18, description: 'Oversold altcoin bounce' },
    { symbol: 'DOGE/USDT', type: 'HIGH_VOLATILITY', rsi: 25, adx: 16, description: 'Deep oversold memecoin' },
    { symbol: 'SHIB/USDT', type: 'HIGH_VOLATILITY', rsi: 72, adx: 14, description: 'Overbought memecoin' },
    
    // Moderate volatility
    { symbol: 'ETH/USDT', type: 'MODERATE', rsi: 42, adx: 19, description: 'Standard ETH setup' },
    { symbol: 'SOL/USDT', type: 'MODERATE', rsi: 58, adx: 17, description: 'Neutral SOL momentum' },
    { symbol: 'ADA/USDT', type: 'MODERATE', rsi: 35, adx: 22, description: 'Oversold major alt' },
    
    // Low volatility majors
    { symbol: 'BTC/USDT', type: 'LOW_VOLATILITY', rsi: 45, adx: 21, description: 'Standard BTC trend' },
    { symbol: 'BTC/USDT', type: 'LOW_VOLATILITY', rsi: 38, adx: 15, description: 'Weak BTC oversold' },
    { symbol: 'USDC/USDT', type: 'LOW_VOLATILITY', rsi: 52, adx: 8, description: 'Stablecoin (no trend)' }
  ];
  
  console.log('📊 Testing Different Threshold Systems:\n');
  
  for (const crypto of cryptos) {
    console.log(`\n🎯 ${crypto.symbol} (${crypto.type}): ${crypto.description}`);
    console.log(`   Technical: RSI ${crypto.rsi}, ADX ${crypto.adx}`);
    
    // Test LONG bias (most common)
    const bias = 'long';
    
    // 1. Current strict thresholds
    const strictRSI = (crypto.rsi >= 40 && crypto.rsi <= 75);
    const strictADX = crypto.adx >= 20;
    const strictScore = (strictRSI ? 20 : 0) + (strictADX ? 20 : 0) + 60; // Assume other filters pass
    
    // 2. Relaxed realistic thresholds
    const realisticRSI = (crypto.rsi >= 30 && crypto.rsi <= 80);
    const realisticADX = crypto.adx >= 15;
    const realisticScore = (realisticRSI ? 20 : 0) + (realisticADX ? 20 : 0) + 60;
    
    // 3. Adaptive thresholds by volatility
    let adaptiveRSIMin, adaptiveRSIMax, adaptiveADX;
    switch (crypto.type) {
      case 'HIGH_VOLATILITY':
        adaptiveRSIMin = 25; adaptiveRSIMax = 85; adaptiveADX = 12;
        break;
      case 'MODERATE':
        adaptiveRSIMin = 30; adaptiveRSIMax = 80; adaptiveADX = 15;
        break;
      case 'LOW_VOLATILITY':
        adaptiveRSIMin = 35; adaptiveRSIMax = 75; adaptiveADX = 18;
        break;
    }
    
    const adaptiveRSI = (crypto.rsi >= adaptiveRSIMin && crypto.rsi <= adaptiveRSIMax);
    const adaptiveADXPass = crypto.adx >= adaptiveADX;
    const adaptiveScore = (adaptiveRSI ? 20 : 0) + (adaptiveADXPass ? 20 : 0) + 60;
    
    console.log(`   🔴 Strict (40-75, ADX≥20): ${strictScore >= 80 ? 'PASS' : 'FAIL'} (${strictScore}/100)`);
    console.log(`   🟡 Realistic (30-80, ADX≥15): ${realisticScore >= 80 ? 'PASS' : 'FAIL'} (${realisticScore}/100)`);
    console.log(`   🟢 Adaptive (${adaptiveRSIMin}-${adaptiveRSIMax}, ADX≥${adaptiveADX}): ${adaptiveScore >= 80 ? 'PASS' : 'FAIL'} (${adaptiveScore}/100)`);
    
    // Analysis
    if (strictScore < 80 && realisticScore >= 80) {
      console.log(`   💡 Realistic thresholds UNLOCK this opportunity`);
    }
    if (realisticScore < 80 && adaptiveScore >= 80) {
      console.log(`   🧠 Adaptive system NEEDED for this profile`);
    }
    if (strictScore >= 80 && realisticScore < 80) {
      console.log(`   ⚠️ Realistic thresholds TOO LOOSE for this case`);
    }
  }
  
  console.log(`\n\n🎯 RECOMMENDATIONS:\n`);
  
  // Count results
  let strictPasses = 0, realisticPasses = 0, adaptivePasses = 0;
  let realisticUnlocks = 0, adaptiveUnlocks = 0, realisticFalsePositives = 0;
  
  for (const crypto of cryptos) {
    const bias = 'long';
    const strictRSI = (crypto.rsi >= 40 && crypto.rsi <= 75);
    const strictADX = crypto.adx >= 20;
    const strictScore = (strictRSI ? 20 : 0) + (strictADX ? 20 : 0) + 60;
    
    const realisticRSI = (crypto.rsi >= 30 && crypto.rsi <= 80);
    const realisticADX = crypto.adx >= 15;
    const realisticScore = (realisticRSI ? 20 : 0) + (realisticADX ? 20 : 0) + 60;
    
    let adaptiveRSIMin, adaptiveRSIMax, adaptiveADX;
    switch (crypto.type) {
      case 'HIGH_VOLATILITY':
        adaptiveRSIMin = 25; adaptiveRSIMax = 85; adaptiveADX = 12; break;
      case 'MODERATE':
        adaptiveRSIMin = 30; adaptiveRSIMax = 80; adaptiveADX = 15; break;
      case 'LOW_VOLATILITY':
        adaptiveRSIMin = 35; adaptiveRSIMax = 75; adaptiveADX = 18; break;
    }
    
    const adaptiveRSI = (crypto.rsi >= adaptiveRSIMin && crypto.rsi <= adaptiveRSIMax);
    const adaptiveADXPass = crypto.adx >= adaptiveADX;
    const adaptiveScore = (adaptiveRSI ? 20 : 0) + (adaptiveADXPass ? 20 : 0) + 60;
    
    if (strictScore >= 80) strictPasses++;
    if (realisticScore >= 80) realisticPasses++;
    if (adaptiveScore >= 80) adaptivePasses++;
    
    if (strictScore < 80 && realisticScore >= 80) realisticUnlocks++;
    if (realisticScore < 80 && adaptiveScore >= 80) adaptiveUnlocks++;
    if (strictScore >= 80 && realisticScore < 80) realisticFalsePositives++;
  }
  
  console.log(`1. 📊 COVERAGE ANALYSIS:`);
  console.log(`   - Strict thresholds: ${strictPasses}/${cryptos.length} opportunities (${((strictPasses/cryptos.length)*100).toFixed(0)}%)`);
  console.log(`   - Realistic thresholds: ${realisticPasses}/${cryptos.length} opportunities (${((realisticPasses/cryptos.length)*100).toFixed(0)}%)`);
  console.log(`   - Adaptive system: ${adaptivePasses}/${cryptos.length} opportunities (${((adaptivePasses/cryptos.length)*100).toFixed(0)}%)`);
  
  console.log(`\n2. 🚀 IMPROVEMENT ANALYSIS:`);
  console.log(`   - Realistic unlocks ${realisticUnlocks} new opportunities vs strict`);
  console.log(`   - Adaptive unlocks ${adaptiveUnlocks} additional opportunities vs realistic`);
  console.log(`   - Realistic creates ${realisticFalsePositives} false positives vs strict`);
  
  console.log(`\n3. 💡 FINAL RECOMMENDATION:`);
  if (realisticUnlocks > 0 && realisticFalsePositives === 0) {
    console.log(`   ✅ USE REALISTIC THRESHOLDS GLOBALLY`);
    console.log(`   - RSI: 30-80 for LONG, 20-70 for SHORT`);
    console.log(`   - ADX: >=15`);
    console.log(`   - Simple, effective, no false positives detected`);
  } else if (adaptiveUnlocks > realisticUnlocks * 0.3) {
    console.log(`   🧠 USE ADAPTIVE SYSTEM BY VOLATILITY`);
    console.log(`   - HIGH_VOLATILITY: RSI 25-85, ADX >=12`);
    console.log(`   - MODERATE: RSI 30-80, ADX >=15`);
    console.log(`   - LOW_VOLATILITY: RSI 35-75, ADX >=18`);
    console.log(`   - More complex but captures nuances`);
  } else {
    console.log(`   🔧 CONSIDER GAUGE-BASED SYSTEM`);
    console.log(`   - Weighted scoring instead of hard thresholds`);
    console.log(`   - More flexible for edge cases`);
  }
}

testThresholdsAcrossCryptos();