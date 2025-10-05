#!/usr/bin/env node

/**
 * 🔍 Analyse de la consommation de Weight Binance
 * 
 * Identifie les appels API qui causent les bans:
 * - fetchBalance: 40 weight (TRÈS LOURD)
 * - fetchTickers: 40 weight (TRÈS LOURD)
 * - fetchTicker: 2 weight
 * - fetchOHLCV: 2 weight
 * 
 * Limite Binance: 1200 weight/minute = BAN 2h si dépassé
 */

console.log('🔍 Analyse de la consommation Weight Binance API\n');

const weights = {
  fetchBalance: 40,         // ⚠️ DANGER: Account endpoint
  fetchTickers: 40,         // ⚠️ DANGER: All tickers at once
  fetchTicker: 2,           // ✅ OK: Single ticker
  fetchOHLCV: 2,            // ✅ OK: Klines endpoint
  fetchOrder: 2,
  createOrder: 1,
  cancelOrder: 1,
  fetchMyTrades: 10,
  fetchOpenOrders: 40,      // ⚠️ DANGER
};

const limits = {
  perMinute: 1200,
  perSecond: 50,
  banDuration: 120 // minutes
};

console.log('📊 Weight par endpoint:');
Object.entries(weights).forEach(([endpoint, weight]) => {
  const danger = weight >= 40 ? '🚨' : weight >= 10 ? '⚠️' : '✅';
  const maxPerMin = Math.floor(limits.perMinute / weight);
  console.log(`  ${danger} ${endpoint.padEnd(20)} ${String(weight).padStart(3)} weight → max ${maxPerMin}/min`);
});

console.log(`\n🚨 LIMITES BINANCE:`);
console.log(`  Weight max/minute: ${limits.perMinute}`);
console.log(`  Penalty si dépassé: BAN IP pendant ${limits.banDuration} minutes (2h)`);

console.log('\n💥 SCÉNARIOS QUI CAUSENT UN BAN:\n');

// Scénario 1: Auto-select intelligent agent
console.log('📍 Scénario 1: intelligentAgent.ts - getTopPerformingCryptos()');
console.log('   Ligne 376-383: Boucle fetchTicker sur 150 marchés');
const scenario1Weight = 150 * weights.fetchTicker;
const scenario1Time = 150 * 0.2; // ~200ms par appel avec rate limit
console.log(`   Weight total: ${scenario1Weight} (${Math.round(scenario1Weight/limits.perMinute*100)}% de la limite)`);
console.log(`   Temps: ~${Math.round(scenario1Time/1000)} secondes`);
console.log(`   ${scenario1Weight > limits.perMinute ? '🚨 CAUSE UN BAN' : '✅ Safe'}`);

// Scénario 2: Agents en parallèle
console.log('\n📍 Scénario 2: 10 agents actifs qui fetch OHLCV toutes les 15 secondes');
const agentsCount = 10;
const ohlcvPerAgent = 4; // 15m, 1h, 4h, 1d
const callsPerMinute = agentsCount * ohlcvPerAgent * 4; // 4 cycles de 15s par minute
const scenario2Weight = callsPerMinute * weights.fetchOHLCV;
console.log(`   ${agentsCount} agents × ${ohlcvPerAgent} timeframes × 4 cycles/min`);
console.log(`   Weight total: ${scenario2Weight}/min (${Math.round(scenario2Weight/limits.perMinute*100)}% de la limite)`);
console.log(`   ${scenario2Weight > limits.perMinute ? '🚨 CAUSE UN BAN' : '✅ Safe'}`);

// Scénario 3: User clicks "Recheck API"
console.log('\n📍 Scénario 3: User clique "Recheck API" (avant fix)');
const recheckWeight = weights.fetchBalance;
console.log(`   1 fetchBalance = ${recheckWeight} weight`);
console.log(`   Si user clique 30 fois en 1 min: ${30 * recheckWeight} weight (${Math.round(30*recheckWeight/limits.perMinute*100)}%)`);
console.log(`   🚨 DANGER si répété`);

// Scénario 4: Création d'agent avec prefetch
console.log('\n📍 Scénario 4: routes/agent.ts - Création agent avec fetchBalance');
console.log('   Ligne 160: fetchBalance avant création agent');
const scenario4Weight = weights.fetchBalance;
console.log(`   Weight: ${scenario4Weight} par agent créé`);
console.log(`   Si user crée 10 agents rapide: ${10 * scenario4Weight} weight (${Math.round(10*scenario4Weight/limits.perMinute*100)}%)`);
console.log(`   ${10 * scenario4Weight > limits.perMinute ? '🚨 CAUSE UN BAN' : '✅ Safe'}`);

console.log('\n\n✅ SOLUTION: WebSocket Streams (0 weight)\n');

const wsStreams = {
  'ticker@<symbol>': 'Prix en temps réel (remplace fetchTicker)',
  'kline_<interval>@<symbol>': 'OHLCV en temps réel (remplace fetchOHLCV)',
  'user_data': 'Balance, trades, orders (remplace fetchBalance)',
  '!ticker@arr': 'Tous les tickers (remplace fetchTickers)',
};

console.log('WebSocket streams disponibles:');
Object.entries(wsStreams).forEach(([stream, desc]) => {
  console.log(`  📡 ${stream}`);
  console.log(`     ${desc}`);
  console.log('');
});

console.log('💡 Avantages WebSocket:');
console.log('  • 0 weight (pas de consommation API REST)');
console.log('  • Données en temps réel (push, pas de polling)');
console.log('  • 1 connexion pour plusieurs streams');
console.log('  • Reconnexion automatique');

console.log('\n🎯 Actions prioritaires:\n');
console.log('1. 🚨 URGENT: Remplacer fetchTicker loops dans intelligentAgent.ts');
console.log('   → Utiliser WebSocket !ticker@arr pour tous les tickers');
console.log('   → Économie: 150 appels × 2 weight = 300 weight → 0 weight\n');

console.log('2. 🔧 MOYEN: Implémenter WebSocket klines pour agents');
console.log('   → Remplacer fetchOHLCV répétés');
console.log('   → Économie: ~160 appels/min × 2 weight = 320 weight → 0 weight\n');

console.log('3. ✅ FAIT: Retirer fetchBalance des validations');
console.log('   → Déjà fait, évite 40 weight par validation\n');

console.log('4. 📊 BONUS: WebSocket user_data stream');
console.log('   → Balance en temps réel sans polling');
console.log('   → Économie: continue\n');

console.log('📈 Impact total estimé:');
console.log('   Avant: ~620 weight/min (52% de la limite)');
console.log('   Après WebSocket: ~0 weight/min (0% de la limite)');
console.log('   → Plus de risque de ban ✅');
