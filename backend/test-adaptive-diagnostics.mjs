// Test des nouveaux seuils adaptatifs intelligents
import { buildTechSnapshot } from './dist/ai/tech.js';

console.log('🧪 Testing Intelligent Adaptive Diagnostics for AVNT/USDT...\n');

async function testAdaptiveDiagnostics() {
  try {
    // Get current technical snapshot
    const snap = await buildTechSnapshot('AVNT/USDT');
    
    console.log('📊 Current AVNT/USDT Technical Data:');
    console.log(`- Price: ${snap.last}`);
    console.log(`- RSI: ${snap.rsi14.toFixed(1)}`);
    console.log(`- ADX: ${snap.adx14.toFixed(1)}`);
    console.log(`- EMA20: ${snap.ema20.toFixed(4)}`);
    console.log(`- EMA50: ${snap.ema50.toFixed(4)}`);
    console.log(`- EMA Spread: ${(((snap.ema20 - snap.ema50) / snap.ema50) * 100).toFixed(2)}%`);
    console.log(`- ATR%: ${snap.atrPct.toFixed(2)}%`);
    
    // Test adaptive thresholds for AVNT (HIGH_VOLATILITY crypto)
    console.log(`\n🎯 AVNT Adaptive Thresholds (HIGH_VOLATILITY profile):`);
    
    // RSI adaptive zones
    console.log(`📈 RSI Zones:`);
    console.log(`  - LONG: 35-75 (vs old 45-70) - PLUS LARGE pour volatiles`);
    console.log(`  - SHORT: 25-65 (vs old 30-55) - PLUS LARGE pour volatiles`);
    console.log(`  - Current RSI ${snap.rsi14.toFixed(1)} fits in: ${snap.rsi14 >= 35 && snap.rsi14 <= 75 ? '✅ LONG zone' : snap.rsi14 >= 25 && snap.rsi14 <= 65 ? '✅ SHORT zone' : '❌ Neither'}`);
    
    // ADX adaptive thresholds
    console.log(`\n⚡ ADX Thresholds:`);
    console.log(`  - Minimum: 10 (vs old 12) - PLUS BAS pour volatiles`);
    console.log(`  - Moderate: 16 (vs old 20) - PLUS BAS pour volatiles`);
    console.log(`  - Strong: 22 (vs old 25) - PLUS BAS pour volatiles`);
    console.log(`  - Current ADX ${snap.adx14.toFixed(1)}: ${snap.adx14 >= 22 ? '✅ STRONG' : snap.adx14 >= 16 ? '✅ MODERATE' : snap.adx14 >= 10 ? '⚠️ WEAK' : '❌ TOO LOW'}`);
    
    // EMA spread adaptive requirement
    const emaSpread = ((snap.ema20 - snap.ema50) / snap.ema50) * 100;
    console.log(`\n📊 EMA Spread Requirement:`);
    console.log(`  - Required: 0.75% (vs old 0.5%) - PLUS ÉLEVÉ pour volatiles`);
    console.log(`  - Current: ${emaSpread.toFixed(2)}%`);
    console.log(`  - Status: ${Math.abs(emaSpread) >= 0.75 ? '✅ MEETS adaptive requirement' : '❌ Below adaptive requirement'}`);
    
    console.log(`\n🔍 Comparison with OLD vs NEW thresholds:`);
    console.log(`RSI ${snap.rsi14.toFixed(1)}:`);
    console.log(`  - Old system: ${snap.rsi14 >= 45 && snap.rsi14 <= 70 ? '✅ PASS' : '❌ FAIL'} (45-70 range)`);
    console.log(`  - New system: ${snap.rsi14 >= 35 && snap.rsi14 <= 75 ? '✅ PASS' : '❌ FAIL'} (35-75 range)`);
    
    console.log(`ADX ${snap.adx14.toFixed(1)}:`);
    console.log(`  - Old system: ${snap.adx14 >= 25 ? '✅ STRONG' : snap.adx14 >= 20 ? '⚠️ MODERATE' : snap.adx14 >= 12 ? '❌ WEAK' : '❌ REJECT'}`);
    console.log(`  - New system: ${snap.adx14 >= 22 ? '✅ STRONG' : snap.adx14 >= 16 ? '⚠️ MODERATE' : snap.adx14 >= 10 ? '❌ WEAK' : '❌ REJECT'}`);
    
    console.log(`EMA Spread ${emaSpread.toFixed(2)}%:`);
    console.log(`  - Old system: ${Math.abs(emaSpread) >= 0.5 ? '✅ PASS' : '❌ FAIL'} (±0.5% requirement)`);
    console.log(`  - New system: ${Math.abs(emaSpread) >= 0.75 ? '✅ PASS' : '❌ FAIL'} (±0.75% requirement)`);
    
  } catch (error) {
    console.error('❌ Test Error:', error.message);
  }
}

testAdaptiveDiagnostics();