#!/usr/bin/env node

// Test des seuils diagnostics avec les données AVNT connues
async function testDiagnosticsThresholds() {
  try {
    console.log('🧪 Testing Trading Diagnostics Thresholds for Smart Agent...\n');
    
    // Données AVNT/USDT obtenues précédemment
    const symbol = 'AVNT/USDT';
    const bias = 'long'; // Smart Agent a trouvé LONG bias 35%
    const isSmartAgent = true; // Testing Smart Agent mode
    
    // Supposons ces valeurs techniques pour AVNT (d'après nos tests précédents)
    const rsi = 38; // RSI oversold selon les logs
    const adx = 18; // ADX plus réaliste (entre 15-20)
    const atrPct = 1.2; // ATR typique pour crypto volatile
    const ema20 = 0.12; // Prix approximatif EMA20
    const ema50 = 0.115; // Prix approximatif EMA50
    const volumeUsd = 900000; // $0.9M de volume selon logs
    
    console.log(`📊 ${symbol} Technical Analysis (simulated):`);
    console.log(`- RSI: ${rsi}`);
    console.log(`- ADX: ${adx}`);
    console.log(`- Volume: $${(volumeUsd / 1000000).toFixed(1)}M`);
    console.log(`- ATR%: ${atrPct}%`);
    console.log(`- EMA20: ${ema20}`);
    console.log(`- EMA50: ${ema50}`);
    
    // Calculs diagnostics exacts du code
    const emaSpread = ((ema20 - ema50) / ema50) * 100;
    const trendAlignment = bias === 'long' ? (ema20 > ema50 && emaSpread > 0.5) : 
                          bias === 'short' ? (ema20 < ema50 && emaSpread < -0.5) : false;
    
    // Standard thresholds
    const rsiPositionStandard = bias === 'long' ? (rsi >= 40 && rsi <= 75) : 
                               bias === 'short' ? (rsi >= 25 && rsi <= 60) : false;
    const adxMomentumStandard = adx >= 20;
    
    // Smart Agent thresholds
    const rsiPositionSmart = bias === 'long' ? (rsi >= 30 && rsi <= 80) : 
                            bias === 'short' ? (rsi >= 20 && rsi <= 70) : false;
    const adxMomentumSmart = adx >= 15;
    
    const atrVolatility = atrPct >= 0.5;
    const volumeConfirmation = true; // Assumons que le volume passe (ratio >= 0.8)
    
    console.log(`\n🔍 STANDARD Trading Diagnostics Tests (${bias.toUpperCase()} bias):`);
    console.log(`1. RSI Position: ${rsiPositionStandard ? '✅ PASS' : '❌ FAIL'} (${rsi} - need 40-75 for LONG)`);
    console.log(`2. ADX Momentum: ${adxMomentumStandard ? '✅ PASS' : '❌ FAIL'} (${adx} - need >= 20)`);
    console.log(`3. ATR Volatility: ${atrVolatility ? '✅ PASS' : '❌ FAIL'} (${atrPct}% - need >= 0.5%)`);
    console.log(`4. Trend Alignment: ${trendAlignment ? '✅ PASS' : '❌ FAIL'} (EMA spread: ${emaSpread.toFixed(2)}% - need >0.5%)`);
    console.log(`5. Volume Confirmation: ${volumeConfirmation ? '✅ PASS' : '❌ FAIL'} (assumed OK)`);
    
    // Score qualité (5 filtres × 20 points = 100 max, besoin 80+ pour trader)
    const qualityPointsStandard = (rsiPositionStandard ? 20 : 0) + (adxMomentumStandard ? 20 : 0) + 
                                 (atrVolatility ? 20 : 0) + (trendAlignment ? 20 : 0) + (volumeConfirmation ? 20 : 0);
    const minTradingPoints = 80;
    
    console.log(`\n📈 Standard Quality Score: ${qualityPointsStandard}/100 points (need ${minTradingPoints}+)`);
    console.log(`Standard Trading Status: ${qualityPointsStandard >= minTradingPoints ? '🟢 READY TO TRADE' : '🔴 BLOCKED'}`);
    
    if (qualityPointsStandard < minTradingPoints) {
      console.log(`\n⚠️ STANDARD MODE BLOCKING ISSUES:`);
      if (!rsiPositionStandard) console.log(`- ❌ RSI ${rsi} is BELOW 40 minimum for LONG entries (need 40-75)`);
      if (!adxMomentumStandard) console.log(`- ❌ ADX ${adx} below 20 threshold`);
      if (!atrVolatility) console.log(`- ❌ ATR ${atrPct}% below 0.5% threshold`);
      if (!trendAlignment) console.log(`- ❌ EMA spread ${emaSpread.toFixed(2)}% insufficient for ${bias} bias (need >0.5%)`);
    }
    
    // Test avec des seuils Smart Agent optimisés
    console.log(`\n🧠 SMART AGENT Optimized Thresholds:`);
    
    const smartQualityPoints = (rsiPositionSmart ? 20 : 0) + (adxMomentumSmart ? 20 : 0) + 
                              (atrVolatility ? 20 : 0) + (trendAlignment ? 20 : 0) + (volumeConfirmation ? 20 : 0);
    
    console.log(`Smart RSI (30-80): ${rsiPositionSmart ? '✅ PASS' : '❌ FAIL'} (${rsi})`);
    console.log(`Smart ADX (>=15): ${adxMomentumSmart ? '✅ PASS' : '❌ FAIL'} (${adx})`);
    console.log(`Smart ATR (>=0.5%): ${atrVolatility ? '✅ PASS' : '❌ FAIL'} (${atrPct}%)`);
    console.log(`Smart EMA Alignment: ${trendAlignment ? '✅ PASS' : '❌ FAIL'} (${emaSpread.toFixed(2)}%)`);
    console.log(`Smart Volume: ${volumeConfirmation ? '✅ PASS' : '❌ FAIL'} (assumed OK)`);
    
    console.log(`\n📈 Smart Quality Score: ${smartQualityPoints}/100`);
    console.log(`🚀 Smart Trading Status: ${smartQualityPoints >= minTradingPoints ? '🟢 READY TO TRADE' : '🔴 STILL BLOCKED'}`);
    
    console.log(`\n🎯 RESULT: Smart Agent mode ${smartQualityPoints >= minTradingPoints ? 'REMOVES' : 'DOES NOT REMOVE'} the trading blocks!`);
    
  } catch (error) {
    console.error('❌ Error testing diagnostics:', error.message);
  }
}

testDiagnosticsThresholds();