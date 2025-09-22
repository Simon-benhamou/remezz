// ANALYSE INCOHÉRENCES DOGE - Blacklist & Entry Zone
console.log('🔍 ANALYSE INCOHÉRENCES DOGE - BLACKLIST & ENTRY ZONE...\n');

function analyzeDOGEInconsistencies() {
  console.log('❓ QUESTION 1: POURQUOI DOGE DANS BLACKLIST ?');
  console.log('='.repeat(70));
  
  console.log('\n📊 COMPARAISON DOGE vs VRAIS MICRO-CAPS:');
  
  const comparison = [
    {
      crypto: 'DOGE',
      marketCap: '15B',
      volume: '800M',
      rank: '#8',
      established: '2013',
      category: 'Meme coin MAIS established',
      shouldBlacklist: '❓ QUESTIONABLE'
    },
    {
      crypto: 'BOME',
      marketCap: '<10M',
      volume: '33K',
      rank: '#500+',
      established: '2024',
      category: 'Micro-cap dangereux',
      shouldBlacklist: '✅ OUI'
    },
    {
      crypto: 'WIF',
      marketCap: '50M',
      volume: '1M',
      rank: '#200+',
      established: '2024',
      category: 'Micro-cap volatil',
      shouldBlacklist: '✅ OUI'
    },
    {
      crypto: 'PEPE',
      marketCap: '100M',
      volume: '50M',
      rank: '#100+',
      established: '2023',
      category: 'Meme micro-cap',
      shouldBlacklist: '✅ OUI'
    }
  ];
  
  console.log('\n| Crypto | Market Cap | Volume | Rank | Établi | Catégorie | Blacklist? |');
  console.log('|--------|------------|--------|------|--------|-----------|------------|');
  
  comparison.forEach(item => {
    console.log(`| ${item.crypto.padEnd(6)} | ${item.marketCap.padEnd(10)} | ${item.volume.padEnd(6)} | ${item.rank.padEnd(4)} | ${item.established.padEnd(6)} | ${item.category.padEnd(15)} | ${item.shouldBlacklist} |`);
  });
  
  console.log('\n💡 ANALYSE OBJECTIVE DOGE:');
  console.log('✅ POUR garder DOGE:');
  console.log('• Market cap $15B = Top 10 crypto mondial');
  console.log('• Volume $800M = Liquidité excellente');
  console.log('• Établi depuis 2013 (11 ans)');
  console.log('• Accepté par Tesla, SpaceX');
  console.log('• Pas un "micro-cap" dangereux');
  
  console.log('\n❌ CONTRE garder DOGE:');
  console.log('• Meme coin = volatilité imprévisible');
  console.log('• Pas d\'utility technique');
  console.log('• Prix influencé par tweets/social media');
  console.log('• Risque de manipulation');
  
  console.log('\n🎯 RECOMMANDATION BLACKLIST:');
  console.log('DOGE devrait probablement être RETIRÉ de la blacklist');
  console.log('Il n\'est pas dans la même catégorie que BOME/WIF/PEPE');
  console.log('Blacklist = micro-caps < $1B, pas top 10 cryptos');
  
  return {
    shouldRemoveFromBlacklist: true,
    reason: 'DOGE est établi, top 10, haute liquidité',
    realMicroCaps: ['BOME', 'WIF', 'PEPE', 'SHIB', 'FLOKI']
  };
}

function analyzeEntryZoneInconsistency() {
  console.log('\n❓ QUESTION 2: BIAS SHORT MAIS ENTRY ZONE EN-DESSOUS ?');
  console.log('='.repeat(70));
  
  console.log('\n📊 DONNÉES FOURNIES:');
  const data = {
    currentPrice: 0.238733,
    zoneFrom: 0.22965342749999998,
    zoneTo: 0.2308045725,
    bias: 'SHORT',
    inZone: false
  };
  
  console.log(`• Prix actuel: $${data.currentPrice.toFixed(6)}`);
  console.log(`• Zone entry: $${data.zoneFrom.toFixed(6)} - $${data.zoneTo.toFixed(6)}`);
  console.log(`• Bias: ${data.bias}`);
  console.log(`• In zone: ${data.inZone}`);
  
  // Calculs
  const zoneMid = (data.zoneFrom + data.zoneTo) / 2;
  const zoneWidth = data.zoneTo - data.zoneFrom;
  const priceAboveZone = data.currentPrice - data.zoneTo;
  const percentageAbove = (priceAboveZone / data.currentPrice) * 100;
  
  console.log('\n🔍 ANALYSE GÉOMÉTRIQUE:');
  console.log(`• Zone milieu: $${zoneMid.toFixed(6)}`);
  console.log(`• Zone largeur: $${zoneWidth.toFixed(6)}`);
  console.log(`• Prix au-dessus zone: $${priceAboveZone.toFixed(6)}`);
  console.log(`• Pourcentage au-dessus: ${percentageAbove.toFixed(2)}%`);
  
  console.log('\n🚨 INCOHÉRENCE DÉTECTÉE:');
  console.log('BIAS SHORT normalement = entry zone AU-DESSUS prix actuel');
  console.log('Mais ici: entry zone EN-DESSOUS prix actuel');
  console.log('');
  console.log('Logique attendue SHORT:');
  console.log('• Prix actuel: $0.2387');
  console.log('• Entry zone attendue: $0.2420 - $0.2450 (au-dessus)');
  console.log('• Logique: attendre rejection sur resistance');
  
  console.log('\nLogique trouvée (incorrecte):');
  console.log('• Prix actuel: $0.2387');
  console.log('• Entry zone: $0.2297 - $0.2308 (en-dessous)');
  console.log('• ❌ Incohérent pour SHORT');
  
  console.log('\n🧠 HYPOTHÈSES PROBLÈME:');
  console.log('1. 🔄 BIAS MAL CALCULÉ:');
  console.log('   • Devrait être LONG (rebond depuis support)');
  console.log('   • Entry zone près support = LONG logic');
  console.log('   • Agent a inversé le bias');
  
  console.log('\n2. 📊 ENTRY ZONE MAL CALCULÉE:');
  console.log('   • Bias SHORT correct');
  console.log('   • Mais entry zone calculée pour LONG');
  console.log('   • Bug dans calculateDynamicEntryZone()');
  
  console.log('\n3. 🔀 DONNÉES MIXÉES:');
  console.log('   • Ancien plan LONG + nouveau bias SHORT');
  console.log('   • Cache pas rafraîchi');
  console.log('   • States inconsistants');
  
  console.log('\n🎯 DIAGNOSTIC PROBABLE:');
  console.log('DOGE baisse → Agent détecte support → Devrait être LONG');
  console.log('Mais affiche SHORT par erreur → Entry zone cohérente avec LONG');
  console.log('Bug dans determineContextualBias() ou affichage bias');
  
  return {
    inconsistency: 'SHORT bias avec entry zone pour LONG',
    probableBias: 'LONG (rebond support)',
    bugLocation: 'determineContextualBias() ou affichage'
  };
}

function generateRecommendations() {
  console.log('\n💡 RECOMMANDATIONS:');
  console.log('='.repeat(70));
  
  console.log('\n🔧 FIX 1: RÉVISER BLACKLIST DOGE');
  console.log('```javascript');
  console.log('// AVANT');
  console.log('const problematicTokens = ["BOME", "WIF", "PEPE", "SHIB", "DOGE", "FLOKI"];');
  console.log('');
  console.log('// APRÈS');
  console.log('const problematicTokens = ["BOME", "WIF", "PEPE", "SHIB", "FLOKI"];');
  console.log('// DOGE retiré car top 10 crypto établi');
  console.log('```');
  
  console.log('\n🔧 FIX 2: DEBUG BIAS CALCULATION');
  console.log('1. Vérifier determineContextualBias() pour DOGE');
  console.log('2. Prix près support → devrait être LONG');
  console.log('3. Entry zone cohérente avec LONG, pas SHORT');
  
  console.log('\n🧪 TESTS IMMÉDIATS:');
  console.log('1. Check logs backend pour bias calculation');
  console.log('2. Forcer re-scan avec bouton relance');
  console.log('3. Vérifier si bias corrigé après re-calculation');
  
  console.log('\n📊 LOGIQUE ATTENDUE DOGE:');
  console.log('• Prix baisse → près support');
  console.log('• Entry zone en-dessous = LONG setup');
  console.log('• Bias devrait être LONG, pas SHORT');
  console.log('• Cohérent avec oversold bounce strategy');
  
  return {
    blacklistFix: 'Retirer DOGE de blacklist',
    biasFix: 'Debug determineContextualBias()',
    expectedBias: 'LONG (support bounce)'
  };
}

// Exécution analyses
const blacklistAnalysis = analyzeDOGEInconsistencies();
const entryZoneAnalysis = analyzeEntryZoneInconsistency();
const recommendations = generateRecommendations();

console.log('\n📋 RÉSUMÉ FINAL:');
console.log('='.repeat(70));

console.log('\n🐕 DOGE BLACKLIST:');
console.log(`• Doit être retiré: ${blacklistAnalysis.shouldRemoveFromBlacklist ? 'OUI' : 'NON'}`);
console.log(`• Raison: ${blacklistAnalysis.reason}`);

console.log('\n🎯 BIAS INCONSISTENCY:');
console.log(`• Problème: ${entryZoneAnalysis.inconsistency}`);
console.log(`• Bias probable: ${entryZoneAnalysis.probableBias}`);
console.log(`• Bug location: ${entryZoneAnalysis.bugLocation}`);

console.log('\n🚀 ACTIONS:');
console.log(`1. ${recommendations.blacklistFix}`);
console.log(`2. ${recommendations.biasFix}`);
console.log(`3. Bias attendu: ${recommendations.expectedBias}`);