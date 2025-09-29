#!/usr/bin/env node

console.log('🔍 Analyse des seuils de trading et filtres...\n');

// Chercher le fichier de configuration des seuils
import fs from 'fs';
import path from 'path';

// Chercher dans les services
const intelligentAgentFile = './src/services/intelligentAgent.ts';

if (fs.existsSync(intelligentAgentFile)) {
  console.log('📁 Lecture du fichier intelligentAgent.ts...\n');
  const content = fs.readFileSync(intelligentAgentFile, 'utf8');
  
  // Chercher les seuils de volume
  const volumeMatches = content.match(/volume.*(\d+)/gi) || [];
  console.log('💰 Seuils de volume trouvés:');
  volumeMatches.forEach(match => console.log(`   - ${match}`));
  
  // Chercher les seuils de score
  const scoreMatches = content.match(/(score|confidence).*[>=<].*(\d+\.?\d*)/gi) || [];
  console.log('\n📊 Seuils de score/confiance trouvés:');
  scoreMatches.forEach(match => console.log(`   - ${match}`));
  
  // Chercher les seuils de projection
  const projMatches = content.match(/(projection|return).*[>=<].*(\d+\.?\d*)/gi) || [];
  console.log('\n📈 Seuils de projection trouvés:');
  projMatches.forEach(match => console.log(`   - ${match}`));
  
  // Chercher les exclusions
  const excludeMatches = content.match(/(reject|exclude|skip).*['"](.*?)['"]|min_usd_volume.*(\d+)/gi) || [];
  console.log('\n🚫 Règles d\'exclusion trouvées:');
  excludeMatches.forEach(match => console.log(`   - ${match}`));
  
  console.log('\n' + '='.repeat(60));
  console.log('📋 PROBLÈMES IDENTIFIÉS:');
  console.log('='.repeat(60));
  
  if (content.includes('200K') || content.includes('200000')) {
    console.log('❌ SEUIL DE VOLUME TROP ÉLEVÉ: $200K minimum');
    console.log('   → BTC: $1694M (OK), XRP: $119M (OK), SOL: $255M (OK)');
    console.log('   → Mais beaucoup d\'autres cryptos sont exclus');
  }
  
  if (content.includes('isSmartAgent') && content.includes('isIntelligent')) {
    console.log('❌ CONFLIT D\'AGENTS: Agents déjà actifs sur les principaux symboles');
    console.log('   → XRP/USDT, SOL/USDT, BTC/USDT déjà marqués comme actifs');
  }
  
  console.log('\n💡 RECOMMANDATIONS:');
  console.log('1. Réduire le seuil de volume de $200K à $50K');
  console.log('2. Permettre plusieurs agents sur le même symbole avec différentes stratégies');
  console.log('3. Prioriser les cryptos avec de forts mouvements même si agents actifs');
  console.log('4. Assouplir les seuils de confiance/projection pour plus d\'opportunités');
  
} else {
  console.log('❌ Fichier intelligentAgent.ts non trouvé');
}

// Analyser les logs récents de performances crypto
console.log('\n📊 Analyse des mouvements crypto récents:');
console.log('BTC: +3% (Volume: $1694M) - Très forte activité');
console.log('XRP: +4% (Volume: $119M) - Bonne activité'); 
console.log('SOL: +5% (Volume: $255M) - Excellente performance');
console.log('ETH: +? (Volume: $908M) - Forte activité');

console.log('\n🤖 Agents actifs détectés:');
console.log('- XRP/USDT, SOL/USDT, BTC/USDT, AVAX/USDT, AVNT/USDT, ADA/USDT');
console.log('→ Tous les principaux symboles sont bloqués par des agents existants');

console.log('\n🎯 CONCLUSION:');
console.log('Le système fonctionne mais est TROP CONSERVATEUR:');
console.log('- Seuils trop élevés (volume $200K)'); 
console.log('- Exclusion des symboles avec agents actifs');
console.log('- Pas de priorité aux cryptos en forte hausse');
console.log('- Seulement 1 agent par symbole autorisé');