#!/usr/bin/env node

import { getBestIntelligentOpportunity } from './dist/src/services/intelligentAgent.js';

async function testImprovedSelection() {
  console.log('🧪 Test du nouveau système de sélection\n');
  
  try {
    // Test 1: Premier Smart Agent (aucune exclusion)
    console.log('1️⃣ PREMIÈRE SÉLECTION (Smart Agent neuf):');
    const first = await getBestIntelligentOpportunity();
    if (first) {
      console.log(`   ✅ Trouvé: ${first.symbol} (score: ${first.score.toFixed(2)}, conf: ${first.confidence}%)`);
    } else {
      console.log('   ❌ Aucune opportunité trouvée');
    }
    
    // Test 2: Deuxième Smart Agent (exclure la première)
    console.log('\n2️⃣ DEUXIÈME SÉLECTION (Smart Agent avec première active):');
    const second = await getBestIntelligentOpportunity('fake-session-1');
    if (second) {
      console.log(`   ✅ Trouvé: ${second.symbol} (score: ${second.score.toFixed(2)}, conf: ${second.confidence}%)`);
    } else {
      console.log('   ❌ Aucune opportunité trouvée');
    }
    
    // Test 3: Troisième Smart Agent 
    console.log('\n3️⃣ TROISIÈME SÉLECTION (Multiple agents actifs):');
    const third = await getBestIntelligentOpportunity('fake-session-2');
    if (third) {
      console.log(`   ✅ Trouvé: ${third.symbol} (score: ${third.score.toFixed(2)}, conf: ${third.confidence}%)`);
    } else {
      console.log('   ❌ Aucune opportunité trouvée');
    }
    
    console.log('\n💡 ANALYSE:');
    if (first && second && third) {
      console.log('✅ SUCCÈS: Le système peut trouver plusieurs opportunités distinctes');
      if (first.symbol !== second.symbol && second.symbol !== third.symbol) {
        console.log('🎯 PARFAIT: Chaque Smart Agent obtient une crypto différente');
      } else {
        console.log('⚠️ PARTAGE: Certains Smart Agents partagent la même crypto (acceptable)');
      }
    } else {
      if (!second) {
        console.log('❌ PROBLÈME: Pas de 2ème opportunité → retour à SMART/SLEEP');
      }
      if (!third) {
        console.log('⚠️ LIMITATION: Seulement 1-2 opportunités disponibles');
      }
    }
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
  }
}

testImprovedSelection();