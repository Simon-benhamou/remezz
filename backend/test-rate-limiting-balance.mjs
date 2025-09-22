// ANALYSE RATE LIMITING vs RÉACTIVITÉ - ÉQUILIBRE OPTIMAL
// Trouver le bon compromis entre vitesse et limites API
console.log('⚖️  RATE LIMITING vs REACTIVITY ANALYSIS...\n');

function analyzeRateLimitingBalance() {
  console.log('🔍 SITUATION ACTUELLE:');
  console.log('='.repeat(60));
  
  console.log('\n📊 Configuration détectée:');
  console.log('• POLL_MS=2000 (2 secondes)');
  console.log('• Commentaire: "15s pour éviter rate limiting"');
  console.log('• ❌ CONTRADICTION entre valeur et commentaire!');
  
  console.log('\n⚠️  PROBLÈME RATE LIMITING:');
  console.log('• Exchange: Crypto.com');
  console.log('• Limite typique: ~100-200 requêtes/minute');
  console.log('• Avec POLL_MS=2000: 30 requêtes/minute par agent');
  console.log('• Multiple agents = dépassement rapide!');
  
  console.log('\n📈 CALCULS DE CHARGE:');
  console.log('='.repeat(60));
  
  const scenarios = [
    { pollMs: 2000, agents: 1, name: '1 agent - 2s polling' },
    { pollMs: 2000, agents: 5, name: '5 agents - 2s polling' },
    { pollMs: 5000, agents: 5, name: '5 agents - 5s polling' },
    { pollMs: 10000, agents: 5, name: '5 agents - 10s polling' },
    { pollMs: 15000, agents: 5, name: '5 agents - 15s polling' }
  ];
  
  console.log('\nAnalyse charge API:');
  scenarios.forEach(({ pollMs, agents, name }) => {
    const requestsPerMinute = (60 * 1000 / pollMs) * agents;
    const status = requestsPerMinute > 150 ? '🚨 DANGER' : 
                   requestsPerMinute > 100 ? '⚠️  LIMITE' : '✅ OK';
    
    console.log(`${name}:`);
    console.log(`  Requests/min: ${requestsPerMinute.toFixed(1)} ${status}`);
    console.log(`  Délai détection: ${pollMs/1000}s`);
    console.log('');
  });
  
  console.log('🎯 RECOMMANDATIONS ÉQUILIBRÉES:');
  console.log('='.repeat(60));
  
  console.log('\n✅ OPTION 1: Polling Adaptatif (OPTIMAL)');
  console.log('• 1-2 agents: POLL_MS=3000 (3s) - Bon compromis');
  console.log('• 3-5 agents: POLL_MS=5000 (5s) - Sécurisé');
  console.log('• 6+ agents: POLL_MS=10000 (10s) - Conservative');
  console.log('• Avantage: Équilibre réactivité/stabilité');
  
  console.log('\n✅ OPTION 2: Cache Intelligent (AVANCÉ)');
  console.log('• POLL_MS=5000 mais cache ticker 2s');
  console.log('• Partage cache entre agents même symbole');
  console.log('• Réduit appels API tout en gardant réactivité');
  console.log('• Avantage: Meilleur des deux mondes');
  
  console.log('\n✅ OPTION 3: Polling Différencié (PRO)');
  console.log('• Agents critiques: POLL_MS=3000');
  console.log('• Agents normaux: POLL_MS=6000');
  console.log('• Agents tests: POLL_MS=10000');
  console.log('• Avantage: Priorités granulaires');
  
  console.log('\n⚠️  OPTION 4: Rate Limiting Agressif (RISQUÉ)');
  console.log('• POLL_MS=2000 mais surveiller erreurs');
  console.log('• Fallback automatique si rate limited');
  console.log('• Retry avec backoff exponentiel');
  console.log('• Avantage: Max réactivité, mais instable');
  
  console.log('\n🔧 FIX IMMÉDIAT RECOMMANDÉ:');
  console.log('='.repeat(60));
  
  console.log('\nPour ton setup actuel (5 agents):');
  console.log('');
  console.log('🎯 Configuration équilibrée:');
  console.log('POLL_MS=4000  # 4s - Bon compromis réactivité/stabilité');
  console.log('');
  console.log('Charge API résultante:');
  console.log('• 5 agents × 15 req/min = 75 req/min');
  console.log('• ✅ Bien sous la limite (~100-150)');
  console.log('• Délai détection: 4s (acceptable)');
  console.log('• Marge sécurité pour pics temporaires');
  
  console.log('\n📊 ALTERNATIVES PAR NOMBRE D\'AGENTS:');
  console.log('');
  console.log('1-2 agents: POLL_MS=3000 (3s)');
  console.log('3-5 agents: POLL_MS=4000-5000 (4-5s)');
  console.log('6-8 agents: POLL_MS=6000-8000 (6-8s)');
  console.log('9+ agents: POLL_MS=10000+ (10s+)');
  
  console.log('\n💡 OPTIMISATIONS AVANCÉES:');
  console.log('='.repeat(60));
  
  console.log('\n🧠 Cache Partagé Intelligent:');
  console.log(`
// Dans market.ts - Cache par symbole partagé
const symbolLastFetch = new Map();
const MIN_INTERVAL_SAME_SYMBOL = 2000; // 2s entre fetch même symbole

export async function getTicker(symbol, options) {
  const lastFetch = symbolLastFetch.get(symbol) || 0;
  const now = Date.now();
  
  // Si même symbole demandé récemment, utiliser cache
  if (!options?.forceRefresh && (now - lastFetch) < MIN_INTERVAL_SAME_SYMBOL) {
    return getCachedTicker(symbol);
  }
  
  // Marquer comme fetché
  symbolLastFetch.set(symbol, now);
  return fetchFreshTicker(symbol);
}
  `);
  
  console.log('\n⚡ Polling Dynamique:');
  console.log(`
// Adapter le polling selon la charge
let currentPollMs = 4000;
let rateLimitErrors = 0;

function adaptPolling() {
  if (rateLimitErrors > 5) {
    currentPollMs = Math.min(currentPollMs * 1.5, 15000); // Ralentir
  } else if (rateLimitErrors === 0 && currentPollMs > 3000) {
    currentPollMs = Math.max(currentPollMs * 0.9, 3000); // Accélérer
  }
}
  `);
  
  console.log('\n🎯 RECOMMANDATION FINALE:');
  console.log('='.repeat(60));
  
  console.log('\nPour TON cas spécifique:');
  console.log('• 5 agents (1 AUTO + 4 MANUAL)');
  console.log('• Exchange: Crypto.com');
  console.log('• Besoin réactivité pour breakouts');
  console.log('');
  console.log('✅ Configuration recommandée:');
  console.log('POLL_MS=4000  # 4s - Équilibre optimal');
  console.log('');
  console.log('📊 Résultat:');
  console.log('• Charge API: 75 req/min (sécurisé)');
  console.log('• Délai détection: 4s (acceptable)');
  console.log('• Marge pour scaling futur');
  console.log('• Pas de risque rate limiting');
  
  console.log('\n⚠️  Si tu veux absolument 2s:');
  console.log('• Surveiller logs pour erreurs rate limit');
  console.log('• Implémenter fallback automatique');
  console.log('• Réduire nombre agents ou fréquence');
  
  return {
    recommended: 'POLL_MS=4000',
    reasoning: 'Équilibre optimal réactivité/stabilité pour 5 agents'
  };
}

const recommendation = analyzeRateLimitingBalance();
console.log('\n' + '='.repeat(60));
console.log('🎯 CONCLUSION:');
console.log(`Configuration recommandée: ${recommendation.recommended}`);
console.log(`Raison: ${recommendation.reasoning}`);
console.log('='.repeat(60));