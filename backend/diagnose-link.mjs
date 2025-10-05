#!/usr/bin/env node

/**
 * Script de diagnostic LINK/USDT
 * Analyse tous les points de blocage possibles
 */

console.log('\n🔍 DIAGNOSTIC COMPLET LINK/USDT\n');
console.log('═'.repeat(70));

// Données observées dans l'interface
const linkData = {
  symbol: 'LINK/USDT',
  price: 22.8320,
  change24h: 3.91,
  volume24h: 129.3, // K LINK
  volumeUsd24h: 2.88, // M USD
  bid: 22.8270,
  ask: 22.8360,
  spread: 0.039,
  market: 'BULLISH',
  
  // Entry zone
  entryMin: 22.6870,
  entryMax: 23.0530,
  support: 22.7600,
  stop: 22.7210,
  target: 23.0995,
  resistance: 22.8510,
  
  // Diagnostics
  checks: {
    noPosition: 'PASS',
    agentArmed: 'PASS',
    notEntering: 'PASS',
    dailyTradeLimit: 'PASS',
    consecutiveStops: 'PASS',
    inEntryZone: 'PASS',
    momentumGates: 'PASS',
    qualityScore: 'PASS',
  },
  
  qualityScore: 80,
  qualityRequired: 40,
  
  qualityFilters: {
    trendAlignment: { status: 'PASS', points: 20 },
    adxMomentum: { status: 'PASS', points: 20 },
    rsiPosition: { status: 'PASS', points: 20 },
    volatilityATR: { status: 'PASS', points: 20 },
    volumeConfirmation: { status: 'FAIL', points: 0 },
  },
  
  confidence: 79, // % bullish
  score: 7.2,
};

console.log('\n📊 DONNÉES MARCHÉ LINK');
console.log('─'.repeat(70));
console.log(`Prix actuel:     $${linkData.price}`);
console.log(`Change 24h:      +${linkData.change24h}%`);
console.log(`Volume 24h:      ${linkData.volume24h}K LINK ($${linkData.volumeUsd24h}M)`);
console.log(`Spread:          ${linkData.spread}%`);
console.log(`Market sentiment: ${linkData.market}`);
console.log(`Confidence:      ${linkData.confidence}% bullish`);

console.log('\n📍 ZONES DE TRADING');
console.log('─'.repeat(70));
console.log(`Entry Zone:      $${linkData.entryMin} - $${linkData.entryMax}`);
console.log(`Prix actuel:     $${linkData.price}`);
console.log(`Dans zone?       ${linkData.price >= linkData.entryMin && linkData.price <= linkData.entryMax ? '✅ OUI' : '❌ NON'}`);
console.log(`Support:         $${linkData.support}`);
console.log(`Stop:            $${linkData.stop}`);
console.log(`Target:          $${linkData.target}`);

console.log('\n✅ DIAGNOSTICS (8/9 PASS)');
console.log('─'.repeat(70));
Object.entries(linkData.checks).forEach(([check, status]) => {
  const icon = status === 'PASS' ? '✅' : '❌';
  console.log(`${icon} ${check}: ${status}`);
});

console.log('\n📈 QUALITY SCORE: 80/40');
console.log('─'.repeat(70));
console.log(`Score actuel:    ${linkData.qualityScore}/100`);
console.log(`Score requis:    ${linkData.qualityRequired}/100 (mode aggressive)`);
console.log(`Résultat:        ${linkData.qualityScore >= linkData.qualityRequired ? '✅ PASS' : '❌ FAIL'}`);

console.log('\n🔍 FILTRES DE QUALITÉ (4/5 PASS)');
console.log('─'.repeat(70));
Object.entries(linkData.qualityFilters).forEach(([filter, data]) => {
  const icon = data.status === 'PASS' ? '✅' : '❌';
  console.log(`${icon} ${filter}: ${data.status} (+${data.points} pts)`);
});

console.log('\n🚨 POINTS DE BLOCAGE POSSIBLES');
console.log('═'.repeat(70));

const blockingPoints = [
  {
    name: '1. Regime "shouldTrade"',
    check: '!this.regime || this.regime.shouldTrade',
    likely: 'UNLIKELY',
    reason: 'Market is BULLISH, regime devrait permettre trading',
    impact: 'CRITIQUE si false',
  },
  {
    name: '2. Agent state !== ARMED',
    check: 'this.state === "ARMED"',
    likely: 'UNLIKELY',
    reason: 'Interface montre Agent Armed: PASS',
    impact: 'CRITIQUE si false',
  },
  {
    name: '3. Already has position',
    check: '!this.pos',
    likely: 'UNLIKELY',
    reason: 'Interface montre No Position: PASS',
    impact: 'CRITIQUE si false',
  },
  {
    name: '4. Already entering',
    check: '!this.entering',
    likely: 'UNLIKELY',
    reason: 'Interface montre Not Entering: PASS',
    impact: 'CRITIQUE si false',
  },
  {
    name: '5. Quality Score < Required',
    check: 'qualityPoints >= minTradingPoints',
    likely: 'UNLIKELY (après fix)',
    reason: 'Score 80 >= 40 → devrait PASS',
    impact: 'CRITIQUE - était le bug corrigé',
  },
  {
    name: '6. Insufficient profit potential',
    check: 'firstTpProfitPct >= minProfitPct',
    likely: 'POSSIBLE',
    reason: 'TP1: $23.0995, Entry: $22.832 → +1.17% (min requis: 0.5-1.0%)',
    impact: 'CRITIQUE si < 0.5%',
  },
  {
    name: '7. Liquidity check fails',
    check: 'hasAdequateLiquidity()',
    likely: 'POSSIBLE',
    reason: 'Volume 15m pourrait être trop faible',
    impact: 'CRITIQUE si liquidity < 100k USD',
  },
  {
    name: '8. Min order notional',
    check: 'qty * entry >= MIN_ORDER_NOTIONAL_USD',
    likely: 'UNLIKELY',
    reason: 'Min notional = $40, ordre sera bien > $100',
    impact: 'CRITIQUE si order < $40',
  },
  {
    name: '9. Spread too wide',
    check: 'spreadPct < limitSpreadThresh (0.12%)',
    likely: 'UNLIKELY',
    reason: 'Spread = 0.039% < 0.12% → OK',
    impact: 'MOYEN - force TWAP si fail',
  },
  {
    name: '10. Trade cooldown active',
    check: 'now - lastTradeTime > cooldownMs',
    likely: 'POSSIBLE',
    reason: 'Si dernier trade < 10-20 secondes',
    impact: 'CRITIQUE si en cooldown',
  },
];

blockingPoints.forEach((point, i) => {
  console.log(`\n${point.name}`);
  console.log(`  Check: ${point.check}`);
  console.log(`  Probabilité: ${point.likely}`);
  console.log(`  Raison: ${point.reason}`);
  console.log(`  Impact: ${point.impact}`);
});

console.log('\n\n🎯 ANALYSE DE PROBABILITÉ');
console.log('═'.repeat(70));

// Calcul des probabilités
const suspects = [
  { name: 'Insufficient Profit (TP1 trop proche)', prob: 40 },
  { name: 'Liquidity Check Fails (volume 15m faible)', prob: 30 },
  { name: 'Trade Cooldown Active', prob: 15 },
  { name: 'Quality Score (bug pas encore appliqué)', prob: 10 },
  { name: 'Autres (regime, spread, etc.)', prob: 5 },
];

console.log('\nProbabilité de chaque cause de blocage:\n');
suspects.forEach(s => {
  const bar = '█'.repeat(Math.floor(s.prob / 5));
  console.log(`${s.name.padEnd(50)} ${s.prob}% ${bar}`);
});

console.log('\n\n💡 DIAGNOSTIC LE PLUS PROBABLE');
console.log('═'.repeat(70));

console.log(`
🔴 SUSPECT #1: INSUFFICIENT PROFIT POTENTIAL (40%)

Calcul:
  Entry:          $22.832
  TP1:            $23.0995
  Profit:         $0.2675
  Profit %:       1.17%
  
  Min Required:
    - Aggressive:  0.5% (après réduction de 0.3%)
    - Reactive:    0.6% (après réduction de 0.2%)
  
  Verdict: 1.17% > 0.5% → ✅ DEVRAIT PASSER
  
  Mais SI le code utilise MIN_TRADE_PROFIT_PCT sans réduction:
    - MIN_TRADE_PROFIT_PCT = 0.5% (config)
    - 1.17% > 0.5% → ✅ OK
  
  Conclusion: Probablement PAS le blocage (mais à vérifier)

🔴 SUSPECT #2: LIQUIDITY CHECK FAILS (30%)

Le problème:
  Volume 24h:     $2.88M (acceptable)
  Volume 15m:     ??? (inconnu)
  
  hasAdequateLiquidity() vérifie:
    1. Volume 15m USD >= LIQUIDITY_MIN_15M_USD (100k)
    2. Order impact < MAX_IMPACT_PCT (0.35%)
  
  Si volume 15m est faible (ex: $50k):
    $2.88M / 96 bougies = $30k moyenne par 15m
    → Pourrait FAIL si dernière bougie < $30k
  
  Conclusion: ⚠️ SUSPECT PRINCIPAL

🔴 SUSPECT #3: TRADE COOLDOWN (15%)

Si dernier trade:
  - < 10 secondes: Bloqué (aggressive)
  - < 20 secondes: Bloqué (reactive)
  
  Mais interface montre "Not Entering: PASS"
  → Probablement pas en cooldown
  
  Conclusion: Peu probable

🔴 SUSPECT #4: QUALITY SCORE BUG (10%)

Si backend pas encore redémarré:
  - Code utilise encore passesQualityFilters()
  - Volume fail → tout bloque
  
  Si backend redémarré:
  - Code utilise quality score
  - 80 >= 40 → devrait passer
  
  Conclusion: Dépend si redémarrage fait ou non
`);

console.log('\n📋 ACTIONS À PRENDRE');
console.log('═'.repeat(70));

console.log(`
1. ✅ VÉRIFIER SI BACKEND REDÉMARRÉ
   - Si NON → Redémarrer maintenant!
   - Si OUI → Passer à l'étape 2

2. 🔍 CHERCHER LES LOGS BACKEND
   Dans les logs backend, chercher:
   
   ❌ "quality_score_insufficient" 
      → Quality score bug pas encore fixé
   
   ❌ "Trade rejected - insufficient profit potential"
      → TP1 trop proche (ajuster plan)
   
   ❌ "insufficient_liquidity"
      → Volume 15m trop faible
   
   ❌ "cooldown_active"
      → Trade trop récent

3. 📊 SI LIQUIDITY CHECK FAILS
   Solutions:
   - Attendre 15-30 min (volume augmentera)
   - Réduire LIQUIDITY_MIN_15M_USD de 100k à 50k
   - Passer en mode plus aggressive

4. 💰 SI PROFIT TOO LOW
   Solutions:
   - Ajuster TP1 plus loin (ex: $23.20 au lieu de $23.10)
   - Réduire MIN_TRADE_PROFIT_PCT de 0.5% à 0.3%

5. ⏰ SI COOLDOWN ACTIVE
   Solution:
   - Attendre 10-20 secondes
   - Observer le prochain tick
`);

console.log('\n🚀 COMMANDES DE VÉRIFICATION');
console.log('═'.repeat(70));

console.log(`
# Dans le terminal backend, chercher les logs récents:
grep -i "LINK" backend.log | tail -50

# Ou si logs dans console:
# Chercher des lignes contenant:
- "quality_score_insufficient"
- "insufficient profit"
- "insufficient_liquidity"
- "cooldown"
- "Trade rejected"

# Vérifier si backend a bien redémarré:
ps aux | grep "node.*backend"

# Si pas redémarré:
cd /Users/simon-davidbenhamou/Desktop/trading-agent-ia-v3
npm -w backend run dev
`);

console.log('\n═'.repeat(70));
console.log('\n✅ DIAGNOSTIC TERMINÉ\n');
console.log('👉 Action prioritaire: VÉRIFIER LES LOGS BACKEND pour voir le message exact de rejet');
console.log('👉 Si pas de logs: BACKEND PAS ENCORE REDÉMARRÉ → Redémarrer maintenant!\n');
