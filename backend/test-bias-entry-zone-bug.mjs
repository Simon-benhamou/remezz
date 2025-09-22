// Test et correction du bug bias/entry zone pour DOGE
import { buildTechSnapshot } from './dist/ai/tech.js';

console.log('🐞 Diagnostic BIAS/ENTRY ZONE BUG pour DOGE\n');

async function testBiasEntryZoneBug() {
  try {
    console.log('📊 1. RÉCUPÉRATION DES DONNÉES DOGE/USDT...');
    
    // Construire snapshot technique actuel
    const snap = await buildTechSnapshot('DOGE/USDT');
    const currentPrice = snap.last;
    
    console.log(`\n💰 Prix DOGE actuel: $${currentPrice.toFixed(4)}`);
    console.log(`📈 Support: $${snap.support?.toFixed(4) || 'N/A'}`);
    console.log(`📉 Résistance: $${snap.resistance?.toFixed(4) || 'N/A'}`);
    console.log(`📊 RSI: ${snap.rsi14?.toFixed(1) || 'N/A'}`);
    console.log(`⚡ ATR%: ${snap.atrPct?.toFixed(2) || 'N/A'}%`);
    
    // Tester determineContextualBias en utilisant l'API debug
    console.log('\n🧠 2. TEST CONTEXTUAL BIAS via API...');
    
    // Utiliser l'API de test pour calculer bias et zone
    const testUrl = `http://localhost:5000/api/debug/test-dynamic-zone/DOGE%2FUSDT/${currentPrice}/auto`;
    console.log(`🌐 Test URL: ${testUrl}`);
    
    try {
      // Simuler le test avec les données disponibles
      console.log('\n📋 SIMULATION CALCUL BIAS/ZONE:');
      
      // Déterminer le bias basé sur les conditions techniques
      const rsi = snap.rsi14 || 50;
      const ema20 = snap.ema20 || currentPrice;
      const ema50 = snap.ema50 || currentPrice;
      const supports = snap.supports || [];
      const resistances = snap.resistances || [];
      
      // Simulation logique de bias
      let simulatedBias = 'none';
      
      // Nearst support/resistance
      const nearestSupport = supports
        .filter(s => s.price < currentPrice)
        .sort((a, b) => Math.abs(currentPrice - b.price) - Math.abs(currentPrice - a.price))[0];
        
      const nearestResistance = resistances
        .filter(r => r.price > currentPrice)
        .sort((a, b) => Math.abs(currentPrice - a.price) - Math.abs(currentPrice - b.price))[0];
      
      const supportDistance = nearestSupport ? Math.abs(currentPrice - nearestSupport.price) / currentPrice : 1;
      const resistanceDistance = nearestResistance ? Math.abs(currentPrice - nearestResistance.price) / currentPrice : 1;
      
      // Simulation de la logique determineContextualBias
      if (supportDistance < 0.04 && nearestSupport) {
        if (rsi < 35 || (ema20 > ema50 && rsi < 65)) {
          simulatedBias = 'long';
        }
      } else if (resistanceDistance < 0.04 && nearestResistance) {
        if (rsi > 65 || (ema20 < ema50 && rsi > 35)) {
          simulatedBias = 'short';
        }
      }
      
      console.log(`- Bias simulé: ${simulatedBias}`);
      
      // Simulation entry zone basée sur le bias
      let simulatedZone = { from: 0, to: 0, mid: 0 };
      
      if (simulatedBias === 'long' && nearestSupport) {
        const targetLevel = nearestSupport.price;
        const atrPct = snap.atrPct || 1.0;
        const zoneWidth = Math.max(targetLevel * 0.005, targetLevel * (atrPct / 100) * 0.3);
        
        simulatedZone = {
          from: targetLevel - zoneWidth,
          to: targetLevel + zoneWidth,
          mid: targetLevel
        };
      } else if (simulatedBias === 'short' && nearestResistance) {
        const targetLevel = nearestResistance.price;
        const atrPct = snap.atrPct || 1.0;
        const zoneWidth = Math.max(targetLevel * 0.005, targetLevel * (atrPct / 100) * 0.3);
        
        simulatedZone = {
          from: targetLevel - zoneWidth,
          to: targetLevel + zoneWidth,
          mid: targetLevel
        };
      } else {
        // Fallback
        const range = currentPrice * 0.01;
        simulatedZone = {
          from: currentPrice - range,
          to: currentPrice + range,
          mid: currentPrice
        };
      }
      
      console.log(`- Zone simulée: $${simulatedZone.from.toFixed(4)} - $${simulatedZone.to.toFixed(4)}`);
      console.log(`- Zone mid: $${simulatedZone.mid.toFixed(4)}`);
      
      // Analyser les résultats
      const bias = simulatedBias;
      const zoneMin = simulatedZone.from;
      const zoneMax = simulatedZone.to;
      const zoneMid = simulatedZone.mid;
    
    console.log(`- Prix actuel: $${currentPrice.toFixed(4)}`);
    console.log(`- Zone calculée: $${zoneMin.toFixed(4)} - $${zoneMax.toFixed(4)}`);
    console.log(`- Zone mid: $${zoneMid.toFixed(4)}`);
    
    // Vérifier la cohérence
    const zoneVsPrice = zoneMid < currentPrice ? 'EN-DESSOUS' : zoneMid > currentPrice ? 'AU-DESSUS' : 'ÉGAL';
    
    console.log('\n⚠️  4. PROBLÈMES DÉTECTÉS:');
    
    if (bias === 'short' && zoneMid < currentPrice) {
      console.log('🚨 BUG DÉTECTÉ: BIAS SHORT avec entry zone EN-DESSOUS du prix actuel');
      console.log('   → Pour SHORT, la zone devrait être AU-DESSUS du prix (résistance)');
      console.log('   → L\'agent devrait attendre un bounce vers la résistance pour shorter');
    } else if (bias === 'long' && zoneMid > currentPrice) {
      console.log('🚨 BUG DÉTECTÉ: BIAS LONG avec entry zone AU-DESSUS du prix actuel');
      console.log('   → Pour LONG, la zone devrait être EN-DESSOUS du prix (support)');
      console.log('   → L\'agent devrait attendre un pullback vers le support pour longer');
    } else {
      console.log('✅ LOGIQUE COHÉRENTE: Bias et zone alignés');
    }
    
    console.log(`\n📍 Position relative: Zone ${zoneVsPrice} du prix actuel`);
    console.log(`📏 Distance zone: ${(Math.abs(zoneMid - currentPrice) / currentPrice * 100).toFixed(2)}%`);
    
    // Vérifier les supports/résistances
    console.log('\n🎯 5. ANALYSE SUPPORTS/RÉSISTANCES:');
    
    const supports = snap.supports || [];
    const resistances = snap.resistances || [];
    
    console.log(`- Supports trouvés: ${supports.length}`);
    supports.forEach((s, i) => {
      const distance = Math.abs(currentPrice - s.price) / currentPrice * 100;
      const direction = s.price < currentPrice ? 'EN-DESSOUS' : 'AU-DESSUS';
      console.log(`  ${i+1}. $${s.price.toFixed(4)} (${direction}, ${distance.toFixed(1)}%, touches: ${s.touches})`);
    });
    
    console.log(`- Résistances trouvées: ${resistances.length}`);
    resistances.forEach((r, i) => {
      const distance = Math.abs(currentPrice - r.price) / currentPrice * 100;
      const direction = r.price < currentPrice ? 'EN-DESSOUS' : 'AU-DESSUS';
      console.log(`  ${i+1}. $${r.price.toFixed(4)} (${direction}, ${distance.toFixed(1)}%, touches: ${r.touches})`);
    });
    
    // Recommandations
    console.log('\n💡 6. RECOMMANDATIONS DE CORRECTION:');
    
    if (bias === 'short') {
      const nearestResistanceAbove = resistances.find(r => r.price > currentPrice);
      if (nearestResistanceAbove) {
        console.log(`✅ Pour SHORT: Cibler résistance à $${nearestResistanceAbove.price.toFixed(4)}`);
        console.log(`   Distance: ${((nearestResistanceAbove.price - currentPrice) / currentPrice * 100).toFixed(1)}% AU-DESSUS`);
      } else {
        console.log(`⚠️  Aucune résistance claire au-dessus - utiliser EMA ou calcul bounce`);
      }
    } else if (bias === 'long') {
      const nearestSupportBelow = supports.find(s => s.price < currentPrice);
      if (nearestSupportBelow) {
        console.log(`✅ Pour LONG: Cibler support à $${nearestSupportBelow.price.toFixed(4)}`);
        console.log(`   Distance: ${((currentPrice - nearestSupportBelow.price) / currentPrice * 100).toFixed(1)}% EN-DESSOUS`);
      } else {
        console.log(`⚠️  Aucun support clair en-dessous - utiliser EMA ou calcul pullback`);
      }
    }
    
    console.log('\n🔧 CORRECTION NÉCESSAIRE dans calculateDynamicEntryZone():');
    console.log('- SHORT: Vérifier que targetLevel > currentPrice (résistance)');
    console.log('- LONG: Vérifier que targetLevel < currentPrice (support)');
    console.log('- Fallback: Recalculer avec direction correcte si levels inversés');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

testBiasEntryZoneBug();