// Test du bug bias/entry zone - Diagnostic simple
import { buildTechSnapshot } from './dist/ai/tech.js';

console.log('🐞 DIAGNOSTIC BUG BIAS/ENTRY ZONE pour DOGE\n');

async function analyzeEntryZoneBug() {
  try {
    console.log('📊 DONNÉES DOGE/USDT:');
    
    // Construire snapshot technique
    const snap = await buildTechSnapshot('DOGE/USDT');
    const currentPrice = snap.last;
    
    console.log(`💰 Prix actuel: $${currentPrice.toFixed(4)}`);
    console.log(`📊 RSI: ${snap.rsi14?.toFixed(1) || 'N/A'}`);
    console.log(`📈 Support: $${snap.support?.toFixed(4) || 'N/A'}`);
    console.log(`📉 Résistance: $${snap.resistance?.toFixed(4) || 'N/A'}`);
    console.log(`⚡ ATR%: ${snap.atrPct?.toFixed(2) || 'N/A'}%`);
    
    console.log('\n🎯 ANALYSE SUPPORTS/RÉSISTANCES:');
    
    const supports = snap.supports || [];
    const resistances = snap.resistances || [];
    
    console.log(`- Supports: ${supports.length} trouvés`);
    supports.forEach((s, i) => {
      const distance = Math.abs(currentPrice - s.price) / currentPrice * 100;
      const position = s.price < currentPrice ? 'EN-DESSOUS' : 'AU-DESSUS';
      console.log(`  ${i+1}. $${s.price.toFixed(4)} (${position}, ${distance.toFixed(1)}%)`);
    });
    
    console.log(`- Résistances: ${resistances.length} trouvées`);
    resistances.forEach((r, i) => {
      const distance = Math.abs(currentPrice - r.price) / currentPrice * 100;
      const position = r.price < currentPrice ? 'EN-DESSOUS' : 'AU-DESSUS';
      console.log(`  ${i+1}. $${r.price.toFixed(4)} (${position}, ${distance.toFixed(1)}%)`);
    });
    
    console.log('\n🧠 SIMULATION LOGIQUE calculateDynamicEntryZone:');
    
    // Tester logique LONG
    console.log('\n📈 SCÉNARIO LONG:');
    const nearestSupportBelow = supports.find(s => s.price < currentPrice);
    if (nearestSupportBelow) {
      const targetLevel = nearestSupportBelow.price;
      const atrPct = snap.atrPct || 1.0;
      const zoneWidth = Math.max(targetLevel * 0.005, targetLevel * (atrPct / 100) * 0.3);
      
      const longZone = {
        from: targetLevel - zoneWidth,
        to: targetLevel + zoneWidth,
        mid: targetLevel
      };
      
      console.log(`✅ Target support: $${targetLevel.toFixed(4)}`);
      console.log(`📍 Entry zone: $${longZone.from.toFixed(4)} - $${longZone.to.toFixed(4)}`);
      console.log(`🎯 Zone mid: $${longZone.mid.toFixed(4)} (${longZone.mid < currentPrice ? 'EN-DESSOUS' : 'AU-DESSUS'} du prix)`);
      
      if (longZone.mid < currentPrice) {
        console.log(`✅ LOGIQUE CORRECTE: Zone LONG en-dessous du prix actuel`);
      } else {
        console.log(`🚨 BUG: Zone LONG au-dessus du prix actuel !`);
      }
    } else {
      console.log(`❌ Aucun support en-dessous trouvé`);
    }
    
    // Tester logique SHORT
    console.log('\n📉 SCÉNARIO SHORT:');
    const nearestResistanceAbove = resistances.find(r => r.price > currentPrice);
    if (nearestResistanceAbove) {
      const targetLevel = nearestResistanceAbove.price;
      const atrPct = snap.atrPct || 1.0;
      const zoneWidth = Math.max(targetLevel * 0.005, targetLevel * (atrPct / 100) * 0.3);
      
      const shortZone = {
        from: targetLevel - zoneWidth,
        to: targetLevel + zoneWidth,
        mid: targetLevel
      };
      
      console.log(`✅ Target résistance: $${targetLevel.toFixed(4)}`);
      console.log(`📍 Entry zone: $${shortZone.from.toFixed(4)} - $${shortZone.to.toFixed(4)}`);
      console.log(`🎯 Zone mid: $${shortZone.mid.toFixed(4)} (${shortZone.mid < currentPrice ? 'EN-DESSOUS' : 'AU-DESSUS'} du prix)`);
      
      if (shortZone.mid > currentPrice) {
        console.log(`✅ LOGIQUE CORRECTE: Zone SHORT au-dessus du prix actuel`);
      } else {
        console.log(`🚨 BUG: Zone SHORT en-dessous du prix actuel !`);
      }
    } else {
      console.log(`❌ Aucune résistance au-dessus trouvée`);
    }
    
    console.log('\n💡 CONCLUSION:');
    console.log('Le bug provient probablement de:');
    console.log('1. Mauvaise sélection des levels (support/résistance inversés)');
    console.log('2. Logique EMA fallback qui ne respecte pas le bias');
    console.log('3. Calcul de zone qui ne vérifie pas la cohérence directionnelle');
    
    console.log('\n🔧 CORRECTION NÉCESSAIRE:');
    console.log('- LONG: S\'assurer que targetLevel < currentPrice (support)');
    console.log('- SHORT: S\'assurer que targetLevel > currentPrice (résistance)');
    console.log('- Ajouter validation directionnelle dans calculateDynamicEntryZone');
    
  } catch (error) {
    console.error('❌ Erreur:', error);
  }
}

analyzeEntryZoneBug();