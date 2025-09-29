#!/usr/bin/env node

import { scanIntelligentOpportunities } from './dist/src/services/intelligentAgent.js';

async function testImprovedRanking() {
  console.log('🧪 Test du ranking amélioré avec seuils de volume réalistes\n');
  
  try {
    console.log('🔍 Scan complet de toutes les cryptos...');
    const opportunities = await scanIntelligentOpportunities();
    
    console.log(`\n📊 RÉSULTATS DU RANKING:`);
    console.log(`   Total opportunités trouvées: ${opportunities.length}`);
    
    if (opportunities.length >= 5) {
      console.log(`   ✅ EXCELLENT: ${opportunities.length} cryptos dans le ranking`);
    } else if (opportunities.length >= 3) {
      console.log(`   🟡 ACCEPTABLE: ${opportunities.length} cryptos dans le ranking`);
    } else {
      console.log(`   ❌ PROBLÈME: Seulement ${opportunities.length} cryptos - pas assez pour un bon ranking`);
    }
    
    console.log(`\n🏆 TOP 10 RANKING:`);
    opportunities.slice(0, 10).forEach((opp, i) => {
      const vol = (opp.metrics.volume24h / 1000000).toFixed(1);
      const change = opp.metrics.momentum.toFixed(2);
      const conf = opp.confidence?.toFixed(0) || '0';
      console.log(`   ${i+1}. ${opp.symbol}: score ${opp.score.toFixed(2)} | vol $${vol}M | move ${change}% | conf ${conf}%`);
    });
    
    // Test simulation sélection multiple
    console.log(`\n🎯 SIMULATION SÉLECTION MULTIPLE:`);
    const activeSymbols = ['BTC/USDT', 'ETH/USDT']; // Simule cryptos déjà actives
    
    let selectedCount = 0;
    for (let i = 0; i < Math.min(5, opportunities.length); i++) {
      const opp = opportunities[i];
      const isAvailable = !activeSymbols.includes(opp.symbol);
      
      if (isAvailable) {
        selectedCount++;
        console.log(`   Agent ${selectedCount}: ${opp.symbol} 🟢 SÉLECTIONNÉ`);
        activeSymbols.push(opp.symbol); // Marque comme actif pour simulation suivante
      } else {
        console.log(`   Skip: ${opp.symbol} 🔴 DÉJÀ ACTIF`);
      }
      
      if (selectedCount >= 3) break; // Simule 3 Smart Agents
    }
    
    console.log(`\n💡 ANALYSE:`);
    if (selectedCount >= 3) {
      console.log(`✅ PARFAIT: Le système peut supporter ${selectedCount} Smart Agents simultanés`);
      console.log(`✅ Plus de retours à SMART/SLEEP !`);
    } else if (selectedCount >= 2) {
      console.log(`🟡 BIEN: Le système peut supporter ${selectedCount} Smart Agents`);
      console.log(`⚠️ 3ème+ Smart Agent pourrait tomber sur SMART/SLEEP`);
    } else {
      console.log(`❌ PROBLÈME: Seulement ${selectedCount} Smart Agent possible`);
      console.log(`❌ 2ème+ Smart Agent tombera sur SMART/SLEEP`);
    }
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
  }
}

testImprovedRanking();