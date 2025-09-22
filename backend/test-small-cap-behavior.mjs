// ANALYSE COMPORTEMENT AGENT SUR SMALL CAP VOLATILE - BOME/USDT
// Comment l'agent réagit aux cryptos à faible market cap et volume
console.log('🎢 SMALL CAP CRYPTO BEHAVIOR ANALYSIS - BOME/USDT...\n');

function analyzeSmallCapBehavior() {
  console.log('📊 PROFIL BOME/USDT:');
  console.log('='.repeat(70));
  
  const bomeData = {
    price: 0.001753,
    change24h: 0.14,
    high24h: 0.002039,
    low24h: 0.001683,
    volume24h: 32800, // $32.8K
    bidAsk: { bid: 0.001747, ask: 0.001749 },
    spread: 0.114
  };
  
  console.log(`Prix: $${bomeData.price}`);
  console.log(`Change 24h: ${bomeData.change24h}% (très faible)`);
  console.log(`Range 24h: $${bomeData.low24h} - $${bomeData.high24h}`);
  console.log(`Volatilité 24h: ${((bomeData.high24h - bomeData.low24h) / bomeData.price * 100).toFixed(1)}%`);
  console.log(`Volume: $${(bomeData.volume24h / 1000).toFixed(1)}K (TRÈS FAIBLE)`);
  console.log(`Spread: ${bomeData.spread}% (LARGE)`);
  
  console.log('\n🔍 CLASSIFICATION CRYPTO:');
  console.log('='.repeat(70));
  
  const classification = {
    marketCap: 'MICRO CAP (<$10M probable)',
    volume: 'ULTRA LOW ($32K/24h)',
    volatility: 'HIGH (21.1% range intraday)',
    liquidity: 'POOR (spread 0.114%)',
    riskLevel: 'EXTREME',
    agentDifficulty: 'TRÈS DIFFICILE'
  };
  
  Object.entries(classification).forEach(([key, value]) => {
    const status = value.includes('EXTREME') || value.includes('ULTRA') || value.includes('TRÈS') ? '🚨' :
                   value.includes('HIGH') || value.includes('POOR') ? '⚠️' : '✅';
    console.log(`${key}: ${value} ${status}`);
  });
  
  console.log('\n🤖 COMPORTEMENT AGENT ATTENDU:');
  console.log('='.repeat(70));
  
  console.log('\n✅ POINTS POSITIFS pour l\'agent:');
  console.log('• Volatilité élevée = opportunités breakout fréquentes');
  console.log('• Mouvements rapides = profits potentiels importants');
  console.log('• Moins de "smart money" = patterns plus prévisibles');
  console.log('• ATR élevé = zones d\'entrée plus larges');
  
  console.log('\n❌ DÉFIS MAJEURS pour l\'agent:');
  console.log('• Volume faible = slippage important sur entrées/sorties');
  console.log('• Spread large = coût transaction élevé (0.114%)');
  console.log('• Liquidité faible = difficultés exécution ordres');
  console.log('• Volatilité = stops fréquents sur bruit');
  console.log('• Manipulation possible = faux signaux');
  
  console.log('\n🎯 STRATÉGIES D\'ADAPTATION:');
  console.log('='.repeat(70));
  
  console.log('\n🔧 1. AJUSTEMENTS AUTOMATIQUES:');
  console.log('');
  console.log('Volume Filter (agent devrait rejeter):');
  console.log(`if (volume24h < 100000) { // $100K minimum`);
  console.log(`  return "INSUFFICIENT_VOLUME";`);
  console.log(`} // BOME: $32.8K → REJETÉ ❌`);
  
  console.log('\nSpread Filter:');
  console.log(`if (spread > 0.05) { // 0.05% max`);
  console.log(`  return "SPREAD_TOO_WIDE";`);
  console.log(`} // BOME: 0.114% → REJETÉ ❌`);
  
  console.log('\nMarket Cap Filter:');
  console.log(`if (marketCap < 50000000) { // $50M minimum`);
  console.log(`  return "MARKET_CAP_TOO_SMALL";`);
  console.log(`} // BOME: <$10M → REJETÉ ❌`);
  
  console.log('\n🔧 2. SI FORCE TRADING (risqué):');
  console.log('');
  console.log('Position Size Reduction:');
  console.log('• Position normale: 1-2% du capital');
  console.log('• Small cap: 0.2-0.5% du capital (5x plus petit)');
  console.log('• Risque max par trade réduit drastiquement');
  
  console.log('\nStop Loss Ajusté:');
  console.log('• Stop normal: 1-2% sous entrée');
  console.log('• Small cap: 3-5% (plus de marge pour bruit)');
  console.log('• Ou utiliser ATR × 2.5 au lieu de ATR × 1.5');
  
  console.log('\nTake Profit Agressif:');
  console.log('• Profil normal: attendre TP final');
  console.log('• Small cap: sortie rapide sur premier TP');
  console.log('• Éviter retournements brutaux');
  
  console.log('\n📊 SIMULATION COMPORTEMENT BOME:');
  console.log('='.repeat(70));
  
  console.log('\n🎢 Scénario Breakout BOME:');
  console.log('Prix: $0.001753 → $0.002000 (+14.1%)');
  console.log('');
  console.log('Agent Standard:');
  console.log('• Position: 1% capital ($1000)');
  console.log('• Entrée: $0.001780 (slippage)');
  console.log('• Stop: $0.001700 (-4.5%)');
  console.log('• TP: $0.001950 (+9.6%)');
  console.log('• Risque: $80 (-4.5% × $1780)');
  console.log('• Reward: $170 (+9.6% × $1780)');
  console.log('• Ratio R:R = 2.1:1 ✅');
  
  console.log('\nAgent Small Cap Adapté:');
  console.log('• Position: 0.3% capital ($300)');
  console.log('• Entrée: $0.001790 (plus de slippage)');
  console.log('• Stop: $0.001650 (-7.8%)');
  console.log('• TP: $0.001950 (+9.0%)');
  console.log('• Risque: $42 (-7.8% × $537)');
  console.log('• Reward: $48 (+9.0% × $537)');
  console.log('• Ratio R:R = 1.14:1 ⚠️');
  
  console.log('\n🚨 PROBLÈMES IDENTIFIÉS:');
  console.log('='.repeat(70));
  
  console.log('\n1. 📉 VOLUME INSUFFISANT:');
  console.log('• $32.8K/24h = $1.37K/heure');
  console.log('• Order de $300 = 22% du volume horaire!');
  console.log('• Slippage garanti + impact prix');
  console.log('• Exécution difficile');
  
  console.log('\n2. 💸 SPREAD PROHIBITIF:');
  console.log('• Spread 0.114% = coût instantané');
  console.log('• Besoin +0.114% juste pour breakeven');
  console.log('• Réduit drastiquement profitabilité');
  console.log('• Agent doit compenser dans calculs');
  
  console.log('\n3. 🎢 VOLATILITÉ EXCESSIVE:');
  console.log('• 21% range intraday');
  console.log('• Stops fréquents sur bruit');
  console.log('• Difficile distinguer signal/bruit');
  console.log('• Performance imprévisible');
  
  console.log('\n🛡️ MÉCANISMES DE PROTECTION:');
  console.log('='.repeat(70));
  
  console.log('\nL\'agent DEVRAIT avoir ces filtres:');
  console.log('');
  console.log('✅ Filtres Volume:');
  console.log('• CRYPTO_MIN_VOLUME_24H = 500000 // $500K minimum');
  console.log('• CRYPTO_MIN_HOURLY_VOLUME = 20000 // $20K/h minimum');
  console.log('');
  console.log('✅ Filtres Spread:');
  console.log('• MAX_SPREAD_PCT = 0.05 // 0.05% maximum');
  console.log('• MIN_LIQUIDITY_DEPTH = 10000 // $10K orderbook');
  console.log('');
  console.log('✅ Filtres Market Cap:');
  console.log('• MIN_MARKET_CAP = 100000000 // $100M minimum');
  console.log('• AVOID_MEME_COINS = true');
  
  console.log('\n🎯 RECOMMANDATIONS POUR TON AGENT:');
  console.log('='.repeat(70));
  
  console.log('\n🚫 OPTION 1: ÉVITER COMPLÈTEMENT (RECOMMANDÉ)');
  console.log('• Blacklist cryptos <$100M market cap');
  console.log('• Blacklist volume <$500K/24h');
  console.log('• Focus sur BTC, ETH, SOL, XRP, etc.');
  console.log('• Performance plus prévisible');
  
  console.log('\n⚠️ OPTION 2: TRADING MICRO POSITIONS');
  console.log('• Position max: 0.1-0.2% capital');
  console.log('• Stop loss très large (5-10%)');
  console.log('• Take profit rapide (3-5%)');
  console.log('• Accepter ratio R:R faible');
  
  console.log('\n🧪 OPTION 3: MODE EXPÉRIMENTAL');
  console.log('• Portfolio dédié small caps (5% total)');
  console.log('• Positions ultra-petites (0.05% each)');
  console.log('• Stratégie momentum pure');
  console.log('• Accepter pertes fréquentes');
  
  console.log('\n📊 VERDICT FINAL:');
  console.log('='.repeat(70));
  
  console.log('\n🎯 Pour BOME/USDT spécifiquement:');
  console.log('• ❌ Volume trop faible ($32.8K)');
  console.log('• ❌ Spread trop large (0.114%)');
  console.log('• ❌ Market cap trop petit');
  console.log('• ❌ Risque/reward défavorable');
  console.log('• 🚨 ÉVITER absolument!');
  
  console.log('\n✅ Cryptos recommandées pour agents:');
  console.log('• BTC/USDT (volume: $2B+)');
  console.log('• ETH/USDT (volume: $1B+)');
  console.log('• SOL/USDT (volume: $500M+)');
  console.log('• XRP/USDT (volume: $300M+)');
  console.log('• MATIC/USDT (volume: $100M+)');
  
  return {
    recommendation: 'ÉVITER',
    reason: 'Volume insuffisant + spread trop large',
    riskLevel: 'EXTREME',
    suitability: 'NON ADAPTÉ aux agents automatiques'
  };
}

const analysis = analyzeSmallCapBehavior();
console.log('\n' + '='.repeat(70));
console.log('🎯 CONCLUSION BOME/USDT:');
console.log(`Recommandation: ${analysis.recommendation}`);
console.log(`Raison: ${analysis.reason}`);
console.log(`Niveau risque: ${analysis.riskLevel}`);
console.log(`Suitabilité: ${analysis.suitability}`);
console.log('='.repeat(70));