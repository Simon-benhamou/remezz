// Test the new contextual bias and entry zone logic
import { buildTechSnapshot } from './dist/ai/tech.js';

console.log('🧪 Testing Contextual Entry Zones for AVNT/USDT...\n');

async function testContextualZones() {
  try {
    // Get current technical snapshot
    const snap = await buildTechSnapshot('AVNT/USDT');
    console.log('📊 Current AVNT/USDT Data:');
    console.log(`- Price: ${snap.last}`);
    console.log(`- Support: ${snap.support}`);
    console.log(`- Resistance: ${snap.resistance}`);
    console.log(`- RSI: ${snap.rsi14.toFixed(1)}`);
    console.log(`- ADX: ${snap.adx14.toFixed(1)}`);
    console.log(`- EMA20: ${snap.ema20.toFixed(4)}`);
    console.log(`- EMA50: ${snap.ema50.toFixed(4)}`);
    console.log(`- ATR%: ${snap.atrPct.toFixed(2)}%`);
    
    // Calculate distance to key levels
    const priceToSupport = Math.abs(snap.last - snap.support) / snap.last * 100;
    const priceToResistance = Math.abs(snap.last - snap.resistance) / snap.last * 100;
    
    console.log(`\n🎯 Key Level Analysis:`);
    console.log(`- Distance to Support: ${priceToSupport.toFixed(1)}%`);
    console.log(`- Distance to Resistance: ${priceToResistance.toFixed(1)}%`);
    
    // Determine contextual scenarios
    console.log(`\n🧠 Contextual Analysis:`);
    if (priceToSupport < 3) {
      console.log(`✅ SCENARIO: Near Support (${priceToSupport.toFixed(1)}%) - Potential LONG setup on bounce`);
    } else if (priceToResistance < 3) {
      console.log(`✅ SCENARIO: Near Resistance (${priceToResistance.toFixed(1)}%) - Potential SHORT setup on rejection`);
    } else {
      console.log(`🔄 SCENARIO: Middle Zone - Trend following or consolidation`);
    }
    
    // Show support/resistance details if available
    if (snap.supports && snap.supports.length > 0) {
      console.log(`\n📉 Support Levels:`);
      snap.supports.slice(0, 3).forEach((s, i) => {
        const distance = Math.abs(snap.last - s.price) / snap.last * 100;
        console.log(`  ${i+1}. ${s.price.toFixed(4)} (${distance.toFixed(1)}% away, ${s.touches} touches, strength: ${s.strength})`);
      });
    }
    
    if (snap.resistances && snap.resistances.length > 0) {
      console.log(`\n📈 Resistance Levels:`);
      snap.resistances.slice(0, 3).forEach((r, i) => {
        const distance = Math.abs(snap.last - r.price) / snap.last * 100;
        console.log(`  ${i+1}. ${r.price.toFixed(4)} (${distance.toFixed(1)}% away, ${r.touches} touches, strength: ${r.strength})`);
      });
    }
    
  } catch (error) {
    console.error('❌ Test Error:', error.message);
  }
}

testContextualZones();