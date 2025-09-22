// Test de cohérence diagnostique avec simulation d'agents
// Simule différents scénarios d'agents et teste la logique
console.log('🧠 Testing Agent Diagnostic Logic with Simulated Scenarios...\n');

async function testDiagnosticLogic() {
  try {
    // Import des modules nécessaires
    const { buildTechSnapshot } = await import('./dist/ai/tech.js');
    
    // Symboles de test populaires
    const testSymbols = ['BTC/USDT', 'ETH/USDT', 'AVNT/USDT', 'SOL/USDT'];
    
    console.log('🔍 Analyzing current market conditions for diagnostic coherence...\n');
    
    for (const symbol of testSymbols) {
      try {
        console.log(`\n📊 ANALYZING ${symbol}:`);
        console.log('='.repeat(60));
        
        // Obtenir les données techniques actuelles
        const snap = await buildTechSnapshot(symbol);
        
        console.log(`📈 CURRENT MARKET DATA:`);
        console.log(`Price: $${snap.last}`);
        console.log(`RSI(14): ${snap.rsi14.toFixed(1)}`);
        console.log(`ADX(14): ${snap.adx14.toFixed(1)}`);
        console.log(`EMA20: $${snap.ema20.toFixed(4)}`);
        console.log(`EMA50: $${snap.ema50.toFixed(4)}`);
        console.log(`ATR%: ${snap.atrPct.toFixed(2)}%`);
        
        // Calculer les indicateurs clés
        const emaSpread = ((snap.ema20 - snap.ema50) / snap.ema50) * 100;
        const priceVsEma20 = ((snap.last - snap.ema20) / snap.ema20) * 100;
        const priceVsEma50 = ((snap.last - snap.ema50) / snap.ema50) * 100;
        
        console.log(`\n🔍 TECHNICAL INDICATORS:`);
        console.log(`EMA Spread: ${emaSpread.toFixed(2)}%`);
        console.log(`Price vs EMA20: ${priceVsEma20.toFixed(2)}%`);
        console.log(`Price vs EMA50: ${priceVsEma50.toFixed(2)}%`);
        
        // Déterminer les conditions de marché
        console.log(`\n🎯 MARKET CONDITIONS:`);
        
        // Tendance générale
        let trendDirection = 'SIDEWAYS';
        let trendStrength = 'NEUTRAL';
        
        if (emaSpread > 1.0) {
          trendDirection = 'STRONG_BULLISH';
          trendStrength = 'STRONG';
        } else if (emaSpread > 0.3) {
          trendDirection = 'BULLISH';
          trendStrength = 'MODERATE';
        } else if (emaSpread < -1.0) {
          trendDirection = 'STRONG_BEARISH';
          trendStrength = 'STRONG';
        } else if (emaSpread < -0.3) {
          trendDirection = 'BEARISH';
          trendStrength = 'MODERATE';
        }
        
        // Ajuster selon ADX
        if (snap.adx14 > 25) trendStrength = 'STRONG';
        else if (snap.adx14 > 20) trendStrength = 'MODERATE';
        else if (snap.adx14 < 15) trendStrength = 'WEAK';
        
        console.log(`Trend: ${trendDirection} (EMA Spread: ${emaSpread.toFixed(2)}%)`);
        console.log(`Strength: ${trendStrength} (ADX: ${snap.adx14.toFixed(1)})`);
        
        // Conditions RSI
        let rsiCondition = 'NEUTRAL';
        let rsiAction = 'WAIT';
        
        if (snap.rsi14 > 70) {
          rsiCondition = 'OVERBOUGHT';
          rsiAction = 'AVOID_LONG';
        } else if (snap.rsi14 > 60) {
          rsiCondition = 'BULLISH';
          rsiAction = 'CONSIDER_LONG';
        } else if (snap.rsi14 < 30) {
          rsiCondition = 'OVERSOLD';
          rsiAction = 'AVOID_SHORT';
        } else if (snap.rsi14 < 40) {
          rsiCondition = 'BEARISH';
          rsiAction = 'CONSIDER_SHORT';
        }
        
        console.log(`RSI: ${rsiCondition} (${snap.rsi14.toFixed(1)}) → ${rsiAction}`);
        
        // Position relative aux EMA
        let pricePosition = 'BETWEEN_EMA';
        if (snap.last > snap.ema20 && snap.last > snap.ema50) {
          pricePosition = 'ABOVE_ALL_EMA';
        } else if (snap.last < snap.ema20 && snap.last < snap.ema50) {
          pricePosition = 'BELOW_ALL_EMA';
        }
        console.log(`Price Position: ${pricePosition}`);
        
        // Volatilité
        let volatilityLevel = 'NORMAL';
        if (snap.atrPct > 4.0) volatilityLevel = 'HIGH';
        else if (snap.atrPct > 2.5) volatilityLevel = 'ELEVATED';
        else if (snap.atrPct < 1.0) volatilityLevel = 'LOW';
        
        console.log(`Volatility: ${volatilityLevel} (ATR: ${snap.atrPct.toFixed(2)}%)`);
        
        // SIMULATION: Que devrait faire un agent intelligent ?
        console.log(`\n🤖 OPTIMAL AGENT BEHAVIOR SIMULATION:`);
        
        let optimalState = 'IDLE';
        let optimalBias = 'none';
        let riskLevel = 'NORMAL';
        const recommendations = [];
        
        // Déterminer l'état optimal
        if (trendStrength === 'STRONG' && volatilityLevel !== 'HIGH') {
          optimalState = 'ARMED';
          if (trendDirection.includes('BULLISH')) {
            optimalBias = 'long';
          } else if (trendDirection.includes('BEARISH')) {
            optimalBias = 'short';
          }
          recommendations.push('✅ Strong trend detected, good for trading');
        } else if (trendStrength === 'MODERATE' && volatilityLevel === 'NORMAL') {
          optimalState = 'ARMED';
          if (trendDirection === 'BULLISH') optimalBias = 'long';
          else if (trendDirection === 'BEARISH') optimalBias = 'short';
          recommendations.push('⚠️ Moderate trend, trade with caution');
        } else {
          optimalState = 'IDLE';
          recommendations.push('🛑 Weak trend or high volatility, better to wait');
        }
        
        // Ajustements selon RSI
        if (rsiAction === 'AVOID_LONG' && optimalBias === 'long') {
          optimalBias = 'none';
          optimalState = 'IDLE';
          recommendations.push('🚨 RSI too high for long positions');
        } else if (rsiAction === 'AVOID_SHORT' && optimalBias === 'short') {
          optimalBias = 'none';
          optimalState = 'IDLE';
          recommendations.push('🚨 RSI too low for short positions');
        }
        
        // Ajustements selon volatilité
        if (volatilityLevel === 'HIGH') {
          riskLevel = 'HIGH';
          if (optimalState === 'ARMED') {
            recommendations.push('⚠️ High volatility: reduce position size');
          }
        } else if (volatilityLevel === 'LOW') {
          riskLevel = 'LOW';
          recommendations.push('✅ Low volatility: favorable for larger positions');
        }
        
        console.log(`Optimal State: ${optimalState}`);
        console.log(`Optimal Bias: ${optimalBias}`);
        console.log(`Risk Level: ${riskLevel}`);
        
        // Afficher les recommandations
        console.log(`\n💡 AGENT RECOMMENDATIONS:`);
        recommendations.forEach(rec => console.log(`  ${rec}`));
        
        // Test des seuils de diagnostic
        console.log(`\n🩺 DIAGNOSTIC THRESHOLDS TEST:`);
        
        // Seuils adaptatifs selon volatilité
        let rsiLongMin, rsiLongMax, rsiShortMin, rsiShortMax;
        let adxMin;
        let emaSpreadMin;
        
        if (volatilityLevel === 'HIGH') {
          // Crypto volatile - seuils plus larges
          rsiLongMin = 35; rsiLongMax = 75;
          rsiShortMin = 25; rsiShortMax = 65;
          adxMin = 10;
          emaSpreadMin = 0.75;
        } else if (volatilityLevel === 'LOW') {
          // Crypto stable - seuils plus stricts  
          rsiLongMin = 45; rsiLongMax = 65;
          rsiShortMin = 35; rsiShortMax = 55;
          adxMin = 15;
          emaSpreadMin = 0.35;
        } else {
          // Crypto normal
          rsiLongMin = 40; rsiLongMax = 70;
          rsiShortMin = 30; rsiShortMax = 60;
          adxMin = 12;
          emaSpreadMin = 0.5;
        }
        
        console.log(`Adaptive RSI Long Zone: ${rsiLongMin}-${rsiLongMax}`);
        console.log(`Adaptive RSI Short Zone: ${rsiShortMin}-${rsiShortMax}`);
        console.log(`Adaptive ADX Minimum: ${adxMin}`);
        console.log(`Adaptive EMA Spread Min: ${emaSpreadMin}%`);
        
        // Tester si les conditions passent les diagnostics
        const rsiLongPass = snap.rsi14 >= rsiLongMin && snap.rsi14 <= rsiLongMax;
        const rsiShortPass = snap.rsi14 >= rsiShortMin && snap.rsi14 <= rsiShortMax;
        const adxPass = snap.adx14 >= adxMin;
        const emaSpreadPass = Math.abs(emaSpread) >= emaSpreadMin;
        
        console.log(`\n📋 DIAGNOSTIC RESULTS:`);
        console.log(`RSI Long Zone: ${rsiLongPass ? '✅' : '❌'} (${snap.rsi14.toFixed(1)})`);
        console.log(`RSI Short Zone: ${rsiShortPass ? '✅' : '❌'} (${snap.rsi14.toFixed(1)})`);
        console.log(`ADX Strength: ${adxPass ? '✅' : '❌'} (${snap.adx14.toFixed(1)})`);
        console.log(`EMA Spread: ${emaSpreadPass ? '✅' : '❌'} (${Math.abs(emaSpread).toFixed(2)}%)`);
        
        // Score global de qualité
        let qualityScore = 0;
        if ((rsiLongPass && optimalBias === 'long') || (rsiShortPass && optimalBias === 'short')) qualityScore += 25;
        if (adxPass) qualityScore += 30;
        if (emaSpreadPass) qualityScore += 25;
        if (volatilityLevel !== 'HIGH') qualityScore += 20;
        
        console.log(`\n🎯 MARKET QUALITY SCORE: ${qualityScore}/100`);
        
        if (qualityScore >= 80) {
          console.log('🟢 EXCELLENT: Perfect conditions for trading');
        } else if (qualityScore >= 60) {
          console.log('🟡 GOOD: Favorable conditions with minor concerns');
        } else if (qualityScore >= 40) {
          console.log('🟠 MODERATE: Mixed conditions, trade carefully');
        } else {
          console.log('🔴 POOR: Unfavorable conditions, avoid trading');
        }
        
        // Conclusion pour cet actif
        console.log(`\n📝 CONCLUSION for ${symbol}:`);
        if (optimalState === 'ARMED' && qualityScore >= 60) {
          console.log(`✅ Agent should be ACTIVE with ${optimalBias} bias`);
        } else if (optimalState === 'ARMED' && qualityScore < 60) {
          console.log(`⚠️ Agent could be active but with HIGH CAUTION`);
        } else {
          console.log(`🛑 Agent should WAIT for better conditions`);
        }
        
      } catch (error) {
        console.error(`❌ Error analyzing ${symbol}:`, error.message);
      }
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('🎯 DIAGNOSTIC COHERENCE SUMMARY:');
    console.log('This analysis shows what agents SHOULD do based on current market conditions.');
    console.log('Compare these recommendations with actual agent behavior to assess coherence.');
    console.log('\n📚 Key Coherence Principles:');
    console.log('  ✅ Strong trends + low volatility = ARMED state');
    console.log('  ✅ Weak trends or high volatility = IDLE state');
    console.log('  ✅ RSI overbought = avoid long positions');
    console.log('  ✅ RSI oversold = avoid short positions');
    console.log('  ✅ High ADX + trend = good trading conditions');
    console.log('  ✅ Adaptive thresholds based on crypto volatility');
    
  } catch (error) {
    console.error('❌ Test Error:', error.message);
    console.log('\n💡 Troubleshooting:');
    console.log('1. Make sure backend is running');
    console.log('2. Verify market data access');
    console.log('3. Check network connectivity');
  }
}

testDiagnosticLogic();