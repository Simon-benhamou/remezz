// Test the enhanced contextual bias logic with different scenarios
import { buildTechSnapshot } from '../dist/ai/tech.js';

console.log('🧪 Testing Enhanced Contextual Bias Logic...\n');

async function testContextualLogic() {
  try {
    // Get current AVNT data
    const snap = await buildTechSnapshot('AVNT/USDT');
    const currentPrice = snap.last;
    
    console.log('📊 Current Market Data:');
    console.log(`- Price: ${currentPrice.toFixed(5)}`);
    console.log(`- EMA20: ${snap.ema20.toFixed(5)}`);
    console.log(`- EMA50: ${snap.ema50.toFixed(5)}`);
    console.log(`- RSI: ${snap.rsi14.toFixed(1)}`);
    console.log(`- ADX: ${snap.adx14.toFixed(1)}`);
    console.log(`- EMA20 Slope: ${snap.ema20Slope?.toFixed(6) || 'N/A'}`);
    console.log(`- ATR%: ${snap.atrPct.toFixed(2)}%`);
    
    // Calculate metrics like the agent does
    const ema20 = snap.ema20;
    const ema50 = snap.ema50;
    const rsi = snap.rsi14;
    const adx = snap.adx14;
    const ema20Slope = snap.ema20Slope || 0;
    const atrPct = snap.atrPct;
    
    const emaSpread = Math.abs((ema20 - ema50) / ema50) * 100;
    const trendUp = ema20 > ema50;
    const strongTrend = adx > 25 && emaSpread > 1.0;
    const moderateTrend = adx > 15 && emaSpread > 0.5;
    const trendStrength = strongTrend ? 'strong' : moderateTrend ? 'moderate' : 'weak';
    const slopeAligned = trendUp ? ema20Slope > 0 : ema20Slope < 0;
    const slopeMagnitude = Math.abs(ema20Slope / ema20) * 100;
    
    console.log(`\n🧠 TREND ANALYSIS:`);
    console.log(`- Direction: ${trendUp ? 'UP' : 'DOWN'}`);
    console.log(`- Strength: ${trendStrength}`);
    console.log(`- EMA Spread: ${emaSpread.toFixed(2)}%`);
    console.log(`- Slope Aligned: ${slopeAligned}`);
    console.log(`- Slope Magnitude: ${slopeMagnitude.toFixed(4)}%`);
    
    // Find nearest levels
    const supports = snap.supports || [];
    const resistances = snap.resistances || [];
    
    const nearestSupport = supports
      .filter(s => s.price < currentPrice)
      .sort((a, b) => Math.abs(currentPrice - b.price) - Math.abs(currentPrice - a.price))[0];
      
    const nearestResistance = resistances
      .filter(r => r.price > currentPrice)
      .sort((a, b) => Math.abs(currentPrice - a.price) - Math.abs(currentPrice - b.price))[0];
    
    const supportDistance = nearestSupport ? Math.abs(currentPrice - nearestSupport.price) / currentPrice : 1;
    const resistanceDistance = nearestResistance ? Math.abs(currentPrice - nearestResistance.price) / currentPrice : 1;
    
    console.log(`\n🎯 LEVEL PROXIMITY:`);
    console.log(`- Nearest Support: ${nearestSupport?.price.toFixed(4)} (${(supportDistance*100).toFixed(1)}% away, ${nearestSupport?.touches} touches)`);
    console.log(`- Nearest Resistance: ${nearestResistance?.price.toFixed(4)} (${(resistanceDistance*100).toFixed(1)}% away, ${nearestResistance?.touches} touches)`);
    
    // Test contextual scenarios
    console.log(`\n🧪 SCENARIO TESTING:`);
    
    // Scenario 1: Near Support
    if (supportDistance < 0.04 && nearestSupport) {
      const supportStrength = nearestSupport.touches || 1;
      const rsiOversold = rsi < 35;
      const rsiNeutral = rsi >= 35 && rsi <= 65;
      
      console.log(`\n📍 NEAR SUPPORT SCENARIO (${(supportDistance*100).toFixed(1)}%):`);
      console.log(`- Support Strength: ${supportStrength} touches`);
      console.log(`- RSI: ${rsi.toFixed(1)} (Oversold: ${rsiOversold}, Neutral: ${rsiNeutral})`);
      
      if (strongTrend && trendUp && slopeAligned) {
        console.log(`✅ STRONG UPTREND + Support → LONG (trend continuation bounce)`);
      } else if (strongTrend && !trendUp && !slopeAligned) {
        console.log(`✅ STRONG DOWNTREND + Support → SHORT (support break continuation)`);
      } else if (supportStrength >= 2 && (rsiOversold || (rsiNeutral && moderateTrend && trendUp))) {
        console.log(`✅ Support bounce (traditional) → LONG`);
      } else {
        console.log(`❌ No clear support signal`);
      }
    }
    
    // Scenario 2: Near Resistance  
    if (resistanceDistance < 0.04 && nearestResistance) {
      const resistanceStrength = nearestResistance.touches || 1;
      const rsiOverbought = rsi > 65;
      const rsiNeutral = rsi >= 35 && rsi <= 65;
      
      console.log(`\n📍 NEAR RESISTANCE SCENARIO (${(resistanceDistance*100).toFixed(1)}%):`);
      console.log(`- Resistance Strength: ${resistanceStrength} touches`);
      console.log(`- RSI: ${rsi.toFixed(1)} (Overbought: ${rsiOverbought}, Neutral: ${rsiNeutral})`);
      
      if (strongTrend && trendUp && slopeAligned) {
        console.log(`✅ STRONG UPTREND + Resistance → LONG (resistance break continuation)`);
      } else if (strongTrend && !trendUp && !slopeAligned) {
        console.log(`✅ STRONG DOWNTREND + Resistance → SHORT (trend continuation rejection)`);
      } else if (resistanceStrength >= 2 && (rsiOverbought || (rsiNeutral && moderateTrend && !trendUp))) {
        console.log(`✅ Resistance rejection (traditional) → SHORT`);
      } else {
        console.log(`❌ No clear resistance signal`);
      }
    }
    
    // Scenario 3: Trend Following
    if (strongTrend && slopeAligned) {
      console.log(`\n📈 STRONG TREND FOLLOWING:`);
      if (trendUp && rsi < 70 && emaSpread > 1.5) {
        console.log(`✅ UPTREND continuation → LONG`);
      } else if (!trendUp && rsi > 30 && emaSpread > 1.5) {
        console.log(`✅ DOWNTREND continuation → SHORT`);
      }
    }
    
    // Scenario 4: Momentum Development
    if (moderateTrend && slopeMagnitude > 0.05) {
      console.log(`\n📊 MOMENTUM DEVELOPMENT:`);
      if (trendUp && rsi >= 45 && rsi <= 65) {
        console.log(`✅ Developing uptrend momentum → LONG`);
      } else if (!trendUp && rsi >= 35 && rsi <= 55) {
        console.log(`✅ Developing downtrend momentum → SHORT`);
      }
    }
    
    // Scenario 5: High Volatility Mean Reversion
    if (atrPct > 3.0 && trendStrength === 'weak' && Math.abs(rsi - 50) > 15) {
      console.log(`\n⚡ HIGH VOLATILITY MEAN REVERSION:`);
      if (rsi < 35 && supportDistance < 0.06) {
        console.log(`✅ High volatility oversold bounce → LONG`);
      } else if (rsi > 65 && resistanceDistance < 0.06) {
        console.log(`✅ High volatility overbought rejection → SHORT`);
      }
    }
    
    if (!strongTrend && !moderateTrend) {
      console.log(`\n🔄 CONSOLIDATION/NEUTRAL - No clear directional edge`);
    }
    
  } catch (error) {
    console.error('❌ Test Error:', error.message);
  }
}

testContextualLogic();