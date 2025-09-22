// Test des nouveaux seuils adaptatifs intelligents avec IA
import { buildTechSnapshot } from './dist/ai/tech.js';

console.log('🧪 Testing AI-Powered Adaptive Diagnostics for AVNT/USDT...\n');

async function testIntelligentDiagnostics() {
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
    
    // Test intelligent thresholds for AVNT (expected HIGH_VOLATILITY)
    console.log(`\n🧠 AVNT Intelligent AI Thresholds:`);
    
    // Determine expected profile based on ATR
    const atrPct = snap.atrPct;
    let expectedProfile = 'MODERATE';
    if (atrPct > 4.0) expectedProfile = 'HIGH_VOLATILITY';
    else if (atrPct < 1.5) expectedProfile = 'LOW_VOLATILITY';
    
    console.log(`📈 Expected AI Profile: ${expectedProfile} (ATR: ${atrPct.toFixed(2)}%)`);
    
    // RSI intelligent zones based on profile
    let rsiZones;
    if (expectedProfile === 'HIGH_VOLATILITY') {
      rsiZones = { long: '35-75', short: '25-65' };
    } else if (expectedProfile === 'LOW_VOLATILITY') {
      rsiZones = { long: '45-65', short: '35-55' };
    } else {
      rsiZones = { long: '40-70', short: '30-60' };
    }
    
    console.log(`📈 Intelligent RSI Zones:`);
    console.log(`  - LONG: ${rsiZones.long} (adaptive for ${expectedProfile})`);
    console.log(`  - SHORT: ${rsiZones.short} (adaptive for ${expectedProfile})`);
    console.log(`  - Current RSI ${snap.rsi14.toFixed(1)} evaluation: ${
      expectedProfile === 'HIGH_VOLATILITY' && snap.rsi14 >= 35 && snap.rsi14 <= 75 ? '✅ PASS LONG' :
      expectedProfile === 'LOW_VOLATILITY' && snap.rsi14 >= 45 && snap.rsi14 <= 65 ? '✅ PASS LONG' :
      snap.rsi14 >= 40 && snap.rsi14 <= 70 ? '✅ PASS LONG' : '❌ OUTSIDE optimal range'
    }`);
    
    // ADX intelligent thresholds
    let adxThresholds;
    if (expectedProfile === 'HIGH_VOLATILITY') {
      adxThresholds = { minimum: 10, moderate: 16, strong: 22 };
    } else if (expectedProfile === 'LOW_VOLATILITY') {
      adxThresholds = { minimum: 15, moderate: 20, strong: 28 };
    } else {
      adxThresholds = { minimum: 12, moderate: 18, strong: 25 };
    }
    
    console.log(`\n⚡ Intelligent ADX Thresholds:`);
    console.log(`  - Minimum: ${adxThresholds.minimum} (intelligent for ${expectedProfile})`);
    console.log(`  - Moderate: ${adxThresholds.moderate}`);
    console.log(`  - Strong: ${adxThresholds.strong}`);
    console.log(`  - Current ADX ${snap.adx14.toFixed(1)}: ${
      snap.adx14 >= adxThresholds.strong ? '✅ STRONG' :
      snap.adx14 >= adxThresholds.moderate ? '✅ MODERATE' :
      snap.adx14 >= adxThresholds.minimum ? '⚠️ WEAK' : '❌ TOO LOW'
    }`);
    
    // EMA spread intelligent requirement
    const emaSpread = ((snap.ema20 - snap.ema50) / snap.ema50) * 100;
    const emaRequirement = expectedProfile === 'HIGH_VOLATILITY' ? 0.75 :
                          expectedProfile === 'LOW_VOLATILITY' ? 0.35 : 0.5;
    
    console.log(`\n📊 Intelligent EMA Spread Requirement:`);
    console.log(`  - Required: ${emaRequirement}% (AI-determined for ${expectedProfile})`);
    console.log(`  - Current: ${emaSpread.toFixed(2)}%`);
    console.log(`  - Status: ${Math.abs(emaSpread) >= emaRequirement ? '✅ MEETS AI requirement' : '❌ Below AI requirement'}`);
    
    // Overall AI assessment
    const rsiPass = expectedProfile === 'HIGH_VOLATILITY' ? 
      (snap.rsi14 >= 35 && snap.rsi14 <= 75) : 
      expectedProfile === 'LOW_VOLATILITY' ? 
      (snap.rsi14 >= 45 && snap.rsi14 <= 65) : 
      (snap.rsi14 >= 40 && snap.rsi14 <= 70);
    
    const adxPass = snap.adx14 >= adxThresholds.moderate;
    const emaPass = Math.abs(emaSpread) >= emaRequirement;
    
    console.log(`\n🧠 AI Overall Assessment:`);
    console.log(`✅ RSI: ${rsiPass ? 'PASS' : 'FAIL'} (intelligent zones)`);
    console.log(`${adxPass ? '✅' : '❌'} ADX: ${adxPass ? 'PASS' : 'FAIL'} (intelligent thresholds)`);
    console.log(`${emaPass ? '✅' : '❌'} EMA: ${emaPass ? 'PASS' : 'FAIL'} (intelligent requirement)`);
    console.log(`📊 Quality Score: ${(rsiPass ? 15 : 0) + (adxPass ? 30 : snap.adx14 >= adxThresholds.minimum ? 20 : 0) + (emaPass ? 25 : 0)}/70 points`);
    
  } catch (error) {
    console.error('❌ Test Error:', error.message);
  }
}

testIntelligentDiagnostics();