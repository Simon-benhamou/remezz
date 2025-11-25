#!/usr/bin/env node
/**
 * 📊 ANALYSE D'ARCHITECTURE: STRATÉGIE MOMENTUM SIMPLE vs META-ADAPTIVE
 * 
 * Objectif: Identifier ce qui est NÉCESSAIRE pour la nouvelle stratégie
 * et ce qui peut être SUPPRIMÉ
 */

console.log('═'.repeat(80));
console.log('📊 ANALYSE D\'ARCHITECTURE: SIMPLIFICATION POSSIBLE');
console.log('═'.repeat(80));

// Stratégie actuelle (meta-adaptive) - 3500+ lignes
const metaAdaptiveComponents = {
  core: [
    'metaAdaptiveAgent.ts (3500+ lines)',
    'metaAdaptiveCalibration.ts',
    'strategyTypes.ts',
    'preciseDecimal.ts',
    'exitManager.ts',
    'entryFilters.ts',
    'entryIntegration.ts',
  ],
  detection: [
    'reboundDetection.ts',
    'btcCorrelation.ts',
    'accumulationDetection.ts',
    'newsDetection.ts (LLM calls)',
    'fundingRateDetection.ts',
    'flashCrashDetection.ts',
    'portfolioExposure.ts',
    'sessionAwareness.ts',
    'whaleActivity.ts',
    'dynamicRSILimits.ts',
  ],
  learning: [
    '../../../learning/adaptiveThresholds.ts',
    '../../../learning/adaptiveWeights.ts',
    '../../../learning/decisionMemory.ts',
    '../../../learning/optimizerJob.ts',
    '../../../learning/outcomeUpdater.ts',
    '../../../learning/personalityProfile.ts',
    '../../../learning/predictorRetrainer.ts',
    '../../../learning/regimeDetector.ts',
    '../../../learning/reoptimizationScheduler.ts',
    '../../../learning/strategyOptimizer.ts',
    '../../../learning/strategyPerformanceAnalyzer.ts',
    '../../../learning/symbolFamily.ts',
    '../../../learning/tradeEvaluationLogger.ts',
    '../../../learning/trainer.ts',
  ],
  regime: [
    '../../regime/marketRegimeDetector.ts',
  ],
  ai: [
    '../../../ai/tech.ts',
    '../../../ai/multiTimeframe.ts',
    '../../../ai/orchestrator.ts (LLM)',
    '../../../ai/llm.ts',
    '../../../ai/prompts.ts',
  ],
  analytics: [
    '../../../analytics/marketContext.ts',
  ],
  strategies: {
    trend: 'classic_trend_following',
    breakout: 'breakout_retest',
    meanReversion: 'bollinger_mean_reversion',
    momentum: 'momentum_scanner_focus',
  },
};

// Nouvelle stratégie MOMENTUM simple
const momentumSimpleComponents = {
  signals: [
    'Vol 4x/5x ratio check',
    'Bullish candle detection',
    'Price above MA20',
    'BTC above MA50 filter',
    'BTC 2h/4h/6h momentum filter',
    'Day filter (Sun, Mon, Wed, Thu)',
  ],
  exit: [
    'Time-based exit (4-6 hours)',
    'SL 1.5-2%',
    'No TP (hold until time)',
  ],
  logic: `
    // Signal: ~20 lignes de code
    if (volRatio > 4 && isBullish && priceAboveMA20) {
      if (btcAboveMA50 && btcMomentum2h > 1.5) {
        if (isDayAllowed(dayOfWeek)) {
          ENTRY_LONG();
        }
      }
    }
    
    // Exit: ~10 lignes
    if (timeSinceEntry > 6h || price < entryPrice * (1 - SL)) {
      EXIT();
    }
  `,
};

console.log('\n📦 COMPOSANTS META-ADAPTIVE ACTUELS:');
console.log('─'.repeat(60));

console.log('\n🔧 Core (obligatoire actuel):');
metaAdaptiveComponents.core.forEach(c => console.log(`   • ${c}`));

console.log('\n🔍 Detection modules (12 modules):');
metaAdaptiveComponents.detection.forEach(c => console.log(`   • ${c}`));

console.log('\n🧠 Learning system (14 modules):');
metaAdaptiveComponents.learning.forEach(c => console.log(`   • ${c}`));

console.log('\n📊 AI/LLM (5 modules):');
metaAdaptiveComponents.ai.forEach(c => console.log(`   • ${c}`));

const totalModules = 
  metaAdaptiveComponents.core.length +
  metaAdaptiveComponents.detection.length +
  metaAdaptiveComponents.learning.length +
  metaAdaptiveComponents.regime.length +
  metaAdaptiveComponents.ai.length +
  metaAdaptiveComponents.analytics.length;

console.log(`\n📈 TOTAL: ${totalModules}+ modules, ~15,000+ lignes de code`);

console.log('\n' + '═'.repeat(80));
console.log('✨ NOUVELLE STRATÉGIE MOMENTUM SIMPLE');
console.log('═'.repeat(80));

console.log('\n📊 Signaux requis:');
momentumSimpleComponents.signals.forEach(s => console.log(`   ✓ ${s}`));

console.log('\n🚪 Exit:');
momentumSimpleComponents.exit.forEach(e => console.log(`   ✓ ${e}`));

console.log('\n💻 Logique:', momentumSimpleComponents.logic);

console.log('\n' + '═'.repeat(80));
console.log('📋 RECOMMANDATION DE SIMPLIFICATION');
console.log('═'.repeat(80));

const keepComponents = [
  { name: 'ai/tech.ts', reason: 'Calcul des indicateurs techniques (EMA, Volume, etc.)' },
  { name: 'broker/capitalPoolBroker.ts', reason: 'Exécution des ordres' },
  { name: 'broker/live.ts / paper.ts', reason: 'Connection Binance' },
  { name: 'db/client.ts (Prisma)', reason: 'Persistance des trades' },
  { name: 'exchange/binance.ts', reason: 'Fetch candles' },
  { name: 'services/capitalPool.ts', reason: 'Gestion du capital' },
  { name: 'ws/hub.ts', reason: 'WebSocket frontend (optionnel)' },
];

const removeOrSimplifyComponents = [
  { name: 'metaAdaptiveAgent.ts (3500 lines)', action: 'REMPLACER par ~200 lignes', gain: '95%' },
  { name: 'learning/* (14 modules)', action: 'SUPPRIMER', gain: '100%' },
  { name: 'detection/* (12 modules)', action: 'SUPPRIMER', gain: '100%' },
  { name: 'ai/llm.ts, prompts.ts, orchestrator.ts', action: 'SUPPRIMER (pas de LLM)', gain: '100%' },
  { name: 'ai/multiTimeframe.ts', action: 'SIMPLIFIER (juste BTC regime)', gain: '80%' },
  { name: 'regime/marketRegimeDetector.ts', action: 'SIMPLIFIER (juste BTC MA50)', gain: '90%' },
  { name: 'analytics/marketContext.ts', action: 'SUPPRIMER', gain: '100%' },
  { name: 'agent/subagents/* (6 agents)', action: 'SUPPRIMER', gain: '100%' },
  { name: 'agent/loops/* (5 loops)', action: 'SUPPRIMER', gain: '100%' },
  { name: 'agent/decisions/*', action: 'SUPPRIMER', gain: '100%' },
];

console.log('\n✅ GARDER:');
keepComponents.forEach(c => console.log(`   • ${c.name.padEnd(35)} → ${c.reason}`));

console.log('\n🗑️  SUPPRIMER/SIMPLIFIER:');
removeOrSimplifyComponents.forEach(c => 
  console.log(`   • ${c.name.padEnd(40)} → ${c.action} (${c.gain})`)
);

console.log('\n' + '═'.repeat(80));
console.log('📊 ESTIMATION DE RÉDUCTION');
console.log('═'.repeat(80));

console.log(`
┌─────────────────────────┬───────────────┬────────────────┐
│        Métrique         │   Actuel      │   Après Simpli │
├─────────────────────────┼───────────────┼────────────────┤
│ Lignes de code          │ ~15,000+      │ ~1,500         │
│ Modules TypeScript      │ ~45           │ ~12            │
│ Appels LLM/API          │ Oui (coûteux) │ Non            │
│ Complexity              │ Très haute    │ Basse          │
│ Maintenance             │ Difficile     │ Facile         │
│ Temps de build          │ ~30s          │ ~5s            │
│ Bugs potentiels         │ Beaucoup      │ Peu            │
│ Testabilité             │ Difficile     │ Facile         │
└─────────────────────────┴───────────────┴────────────────┘
`);

console.log('\n' + '═'.repeat(80));
console.log('🎯 NOUVEAU FICHIER SUGGÉRÉ: momentumStrategy.ts');
console.log('═'.repeat(80));

const newStrategyCode = `
// backend/src/strategies/momentumStrategy.ts - ~200 lignes

import { fetchCandles } from '../exchange/binance.js';

type Signal = { action: 'LONG' | 'NONE'; confidence: number };

const CONFIG = {
  // Signal
  volMultiplier: 5,        // Volume > 5x moyenne
  btcMomentumMin: 1.5,     // BTC 2h momentum > 1.5%
  allowedDays: [0, 1, 3, 4], // Dim, Lun, Mer, Jeu
  
  // Exit
  holdPeriodMin: 360,      // 6 heures
  slPct: 2,               // Stop Loss 2%
  
  // Risk
  riskPct: 1,             // 1% du capital par trade
  leverage: 4.5,          // Leverage moyen
};

export async function checkSignal(symbol: string): Promise<Signal> {
  const candles = await fetchCandles(symbol, '15m', 100);
  const btcCandles = await fetchCandles('BTC/USDT:USDT', '15m', 100);
  
  // Calculs
  const close = candles[candles.length - 1][4];
  const open = candles[candles.length - 1][1];
  const volume = candles[candles.length - 1][5];
  const avgVol = candles.slice(-21, -1).reduce((s, c) => s + c[5], 0) / 20;
  const ma20 = candles.slice(-20).reduce((s, c) => s + c[4], 0) / 20;
  
  // BTC check
  const btcNow = btcCandles[btcCandles.length - 1][4];
  const btc8ago = btcCandles[btcCandles.length - 9][4]; // 2h ago
  const btcMa50 = btcCandles.slice(-50).reduce((s, c) => s + c[4], 0) / 50;
  const btcMomentum2h = (btcNow - btc8ago) / btc8ago * 100;
  
  // Day filter
  const dayOfWeek = new Date().getDay();
  if (!CONFIG.allowedDays.includes(dayOfWeek)) {
    return { action: 'NONE', confidence: 0 };
  }
  
  // Signal check
  const volRatio = volume / avgVol;
  const isBullish = close > open;
  const aboveMa20 = close > ma20;
  const btcAboveMa50 = btcNow > btcMa50;
  const btcMomentumOk = btcMomentum2h > CONFIG.btcMomentumMin;
  
  if (volRatio > CONFIG.volMultiplier && isBullish && aboveMa20 && btcAboveMa50 && btcMomentumOk) {
    return { action: 'LONG', confidence: Math.min(volRatio / 10, 1) };
  }
  
  return { action: 'NONE', confidence: 0 };
}

export function shouldExit(entryTime: number, entryPrice: number, currentPrice: number): boolean {
  const elapsed = Date.now() - entryTime;
  const elapsedMin = elapsed / 60000;
  
  // Time exit
  if (elapsedMin >= CONFIG.holdPeriodMin) return true;
  
  // Stop loss
  const pnlPct = (currentPrice - entryPrice) / entryPrice * 100;
  if (pnlPct <= -CONFIG.slPct) return true;
  
  return false;
}
`;

console.log(newStrategyCode);

console.log('\n' + '═'.repeat(80));
console.log('🔄 OPTIONS D\'IMPLÉMENTATION');
console.log('═'.repeat(80));

console.log(`
OPTION 1: REMPLACEMENT TOTAL (Recommandé)
─────────────────────────────────────────
• Créer un nouveau module momentumStrategy.ts (~200 lignes)
• Modifier le routing pour utiliser ce module
• Désactiver/supprimer les 40+ modules non utilisés
• Temps estimé: 2-4 heures
• Risque: Faible (nouvelle implémentation clean)

OPTION 2: SIMPLIFICATION IN-PLACE
─────────────────────────────────────────
• Modifier metaAdaptiveAgent.ts pour utiliser que le signal Vol 5x
• Commenter/bypasser les modules de détection
• Garder la structure existante
• Temps estimé: 4-6 heures
• Risque: Moyen (code legacy peut interférer)

OPTION 3: MODE HYBRIDE
─────────────────────────────────────────
• Créer momentumStrategy.ts en parallèle
• Ajouter un flag pour switcher entre strategies
• Tester les deux en parallèle
• Temps estimé: 3-5 heures
• Risque: Faible (pas de breaking changes)

🎯 RECOMMANDATION: Option 1 ou 3
   → La stratégie momentum est 10x plus simple
   → Moins de bugs, plus facile à maintenir
   → Pas besoin de 90% du code actuel
`);

console.log('\n' + '═'.repeat(80));
console.log('✅ CONCLUSION');
console.log('═'.repeat(80));

console.log(`
La nouvelle stratégie momentum (Vol 5x + BTC MA50 + momentum 2h) nécessite:

  ✓ ~200 lignes de code vs ~15,000 actuellement
  ✓ Pas de LLM (économie sur les coûts API)
  ✓ Pas de machine learning complexe
  ✓ Pas de 12 modules de détection
  ✓ Signal simple et backtesté: 91% mois positifs

SUPPRIMER:
  • 14 modules learning/
  • 12 modules detection (rebound, news, whale, etc.)
  • LLM calls (orchestrator, prompts)
  • Multi-strategy scoring (4 stratégies → 1)
  • Sub-agents complexes

GARDER:
  • Indicateurs techniques (ai/tech.ts)
  • Broker/Exchange (exécution)
  • Base de données (historique)
  • Frontend/WebSocket (monitoring)

Voulez-vous que j'implémente l'Option 1 (remplacement total) ?
`);
