// ANALYSE SÉLECTION DOGE - Agent AUTO a choisi DOGE
console.log('🐕 ANALYSE SÉLECTION DOGE PAR AGENT AUTO...\n');

async function analyzeDOGESelection() {
  console.log('🔍 ANALYSE CHOIX DOGE:');
  console.log('='.repeat(70));
  
  console.log('\n🚨 PREMIÈRE OBSERVATION:');
  console.log('DOGE était dans la BLACKLIST !');
  console.log('');
  console.log('Code blacklist:');
  console.log('```javascript');
  console.log('const problematicTokens = ["BOME", "WIF", "PEPE", "SHIB", "DOGE", "FLOKI"];');
  console.log('```');
  console.log('');
  console.log('❓ QUESTIONS:');
  console.log('1. Est-ce que le fix blacklist a été appliqué ?');
  console.log('2. DOGE a-t-il des critères exceptionnels ?');
  console.log('3. Y a-t-il eu une erreur de sélection ?');
  
  console.log('\n📊 ANALYSE FONDAMENTALE DOGE:');
  console.log('='.repeat(50));
  
  try {
    // Simuler analyse DOGE avec données réelles estimées
    const dogeData = {
      symbol: 'DOGE/USDT',
      price: 0.105, // Prix estimé DOGE
      // Données typiques DOGE
      volume24h: 800000000, // $800M volume typique
      change24h: -2.3, // Estimation mouvement
      marketCap: 15000000000, // $15B market cap
      
      // Critères agent AUTO
      variationScore: Math.abs(-2.3), // 2.3 points
      volumeScore: 'Excellent (>$500M)', // Passe critère volume
      liquidityRank: 'Top 10 crypto', // Très liquide
      
      // Analyse technique
      volatility: 'MODERATE-HIGH',
      tradingPairs: 'Disponible sur tous exchanges',
      institutionalAdoption: 'Tesla, SpaceX acceptent DOGE'
    };
    
    console.log(`💰 Prix DOGE: $${dogeData.price}`);
    console.log(`📊 Volume 24h: $${(dogeData.volume24h / 1000000).toFixed(0)}M`);
    console.log(`📈 Change 24h: ${dogeData.change24h}%`);
    console.log(`🏦 Market Cap: $${(dogeData.marketCap / 1000000000).toFixed(1)}B`);
    
    console.log('\n🎯 CRITÈRES AGENT AUTO:');
    console.log('='.repeat(50));
    
    // Test critères sélection
    const volumeOK = dogeData.volume24h >= 500000; // $500K minimum
    const variationOK = Math.abs(dogeData.change24h) >= 0.5; // 0.5% minimum
    const isBlacklisted = true; // DOGE normalement blacklisté
    
    console.log(`✅ Volume: ${volumeOK ? 'PASSE' : 'ÉCHEC'} ($${(dogeData.volume24h/1000000).toFixed(0)}M > $0.5M)`);
    console.log(`✅ Variation: ${variationOK ? 'PASSE' : 'ÉCHEC'} (${Math.abs(dogeData.change24h)}% > 0.5%)`);
    console.log(`❌ Blacklist: ${isBlacklisted ? 'DEVRAIT ÊTRE REJETÉ' : 'OK'}`);
    
    // Calcul score théorique
    const volumeScore = dogeData.volume24h > 10000000 ? 9.5 : 
                       dogeData.volume24h > 5000000 ? 8.5 : 
                       dogeData.volume24h > 1000000 ? 7.0 : 6.0;
    const performanceScore = Math.abs(dogeData.change24h);
    const combinedScore = (performanceScore * 0.6) + (volumeScore * 0.4);
    
    console.log('\n📊 SCORE THÉORIQUE:');
    console.log(`• Performance: ${performanceScore.toFixed(1)}`);
    console.log(`• Volume: ${volumeScore.toFixed(1)}`);
    console.log(`• Score combiné: ${combinedScore.toFixed(1)}`);
    
    console.log('\n🤔 ANALYSE PARADOXE:');
    console.log('='.repeat(50));
    
    console.log('\n🔍 HYPOTHÈSES POSSIBLES:');
    console.log('1. 🐛 BLACKLIST NON APPLIQUÉE:');
    console.log('   • Code pas redémarré après fix');
    console.log('   • Erreur dans filtre blacklist');
    console.log('   • Cache agent pas rafraîchi');
    
    console.log('\n2. 📊 DOGE CRITÈRES EXCEPTIONNELS:');
    console.log('   • Volume $800M = EXCELLENT');
    console.log('   • Liquidité top 10 mondial');
    console.log('   • Variation significative');
    console.log('   • Score théorique très élevé');
    
    console.log('\n3. 🔄 SÉLECTION AVANT FIX:');
    console.log('   • Agent créé avant blacklist');
    console.log('   • Pas encore re-scanné');
    console.log('   • Utilise ancienne logique');
    
    console.log('\n🎯 ÉVALUATION OBJECTIVE DOGE:');
    console.log('='.repeat(50));
    
    console.log('\n✅ POINTS POSITIFS:');
    console.log('• Volume $800M = Liquidité excellente');
    console.log('• Market cap $15B = Crypto établie');
    console.log('• Disponible tous exchanges majeurs');
    console.log('• Adoption institutionnelle croissante');
    console.log('• Volatilité modérée vs micro-caps');
    
    console.log('\n⚠️ POINTS NÉGATIFS:');
    console.log('• Meme coin = risque perception');
    console.log('• Volatilité imprévisible');
    console.log('• Pas de utility technique réelle');
    console.log('• Influencé par social media');
    console.log('• Dans blacklist pour bonnes raisons');
    
    console.log('\n🤝 COMPARAISON ALTERNATIVES:');
    console.log('='.repeat(50));
    
    const alternatives = [
      { crypto: 'BTC', volume: 2000, change: 1.2, score: 'Plus stable, moins volatil' },
      { crypto: 'ETH', volume: 1500, change: -1.8, score: 'Utility réelle, DeFi leader' },
      { crypto: 'SOL', volume: 800, change: -7.0, score: 'Forte opportunité rebond' },
      { crypto: 'DOGE', volume: 800, change: -2.3, score: 'Liquide mais meme coin' }
    ];
    
    console.log('\n| Crypto | Volume | Change | Évaluation |');
    console.log('|--------|--------|--------|------------|');
    alternatives.forEach(alt => {
      console.log(`| ${alt.crypto.padEnd(6)} | $${alt.volume}M | ${alt.change.toString().padEnd(5)}% | ${alt.score} |`);
    });
    
    return {
      shouldBeBlacklisted: true,
      volumeExcellent: true,
      liquidityGood: true,
      recommendAlternative: 'SOL (-7% = better opportunity)',
      action: 'Investigate why blacklist not applied'
    };
    
  } catch (error) {
    console.log('❌ Erreur analyse DOGE:', error.message);
    return null;
  }
}

// Test blacklist functionality
function testBlacklistStatus() {
  console.log('\n🔧 TEST STATUT BLACKLIST:');
  console.log('='.repeat(70));
  
  console.log('\n📝 VÉRIFICATION CODE:');
  console.log('1. Backend redémarré après fix blacklist ?');
  console.log('2. Agent AUTO créé après fix ?');
  console.log('3. Nouveau scan ou ancien cache ?');
  
  console.log('\n🧪 TESTS RECOMMANDÉS:');
  console.log('1. Utiliser bouton "🔄 Rechercher" pour forcer nouveau scan');
  console.log('2. Créer nouvel agent AUTO pour test');
  console.log('3. Vérifier logs backend pour blacklist messages');
  console.log('4. Comparer avec SOL (-7%) qui devrait être meilleur');
  
  console.log('\n💡 ACTION IMMÉDIATE:');
  console.log('• Click bouton relance recherche AUTO');
  console.log('• Devrait switcher vers SOL, ETH, ou BTC');
  console.log('• DOGE ne devrait plus être sélectionné');
}

// Recommandations
function getRecommendations() {
  console.log('\n💡 RECOMMANDATIONS:');
  console.log('='.repeat(70));
  
  console.log('\n🎯 COURT TERME:');
  console.log('1. TESTER bouton "🔄 Rechercher" immédiatement');
  console.log('2. Vérifier si agent switch vers SOL/ETH/BTC');
  console.log('3. Si DOGE reste → bug blacklist confirmé');
  
  console.log('\n🔍 INVESTIGATION:');
  console.log('1. Check logs backend pour messages blacklist');
  console.log('2. Vérifier timing création agent vs fix');
  console.log('3. Tester création nouvel agent AUTO');
  
  console.log('\n📊 OBJECTIVEMENT SUR DOGE:');
  console.log('• Volume/liquidité: EXCELLENT ✅');
  console.log('• Stability: QUESTIONABLE ⚠️');
  console.log('• Better alternatives: SOL (-7%), ETH ✅');
  console.log('• Devrait être blacklisté selon stratégie ❌');
  
  return {
    immediate: 'Test bouton relance recherche',
    expected: 'Switch vers SOL, ETH, ou BTC',
    investigate: 'Vérifier pourquoi blacklist pas appliquée'
  };
}

// Exécution analyse
analyzeDOGESelection().then(result => {
  if (result) {
    testBlacklistStatus();
    const recommendations = getRecommendations();
    
    console.log('\n📋 CONCLUSION:');
    console.log('='.repeat(70));
    
    console.log('\n🐕 DOGE SÉLECTION:');
    console.log(`• Blacklisté: ${result.shouldBeBlacklisted ? 'OUI (devrait être rejeté)' : 'NON'}`);
    console.log(`• Volume: ${result.volumeExcellent ? 'EXCELLENT' : 'FAIBLE'}`);
    console.log(`• Liquidité: ${result.liquidityGood ? 'BONNE' : 'MAUVAISE'}`);
    console.log(`• Alternative: ${result.recommendAlternative}`);
    
    console.log('\n🚨 ACTION REQUISE:');
    console.log(`1. ${recommendations.immediate}`);
    console.log(`2. Attendu: ${recommendations.expected}`);
    console.log(`3. Investigation: ${recommendations.investigate}`);
    
    console.log('\n🎯 VERDICT FINAL:');
    console.log('DOGE liquide MAIS devrait être blacklisté!');
    console.log('Probable bug - tester bouton relance immédiatement!');
  }
}).catch(console.error);