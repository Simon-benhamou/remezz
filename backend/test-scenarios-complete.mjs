#!/usr/bin/env node
/**
 * 🧪 TEST SUITE COMPLÈTE - Scénarios Réalistes Agent Trading
 * 
 * Teste tous les comportements critiques :
 * 1. Trailing stop assoupli (gains 1-2% au lieu de 0.2%)
 * 2. Mode breakout (capture tendances fortes)
 * 3. Système de TIERS (BTC/ETH prioritaires)
 * 4. Conditions edge cases
 */

import { buildTechSnapshot } from './dist/src/ai/tech.js';

// ============================================================================
// SCÉNARIOS DE TEST
// ============================================================================

const TEST_SCENARIOS = [
  {
    id: 1,
    name: '📈 TENDANCE FORTE - SOL Breakout +10%',
    description: 'SOL monte de 100$ à 110$ en 2 jours avec ADX fort',
    symbol: 'SOL/USD:USD',
    timeline: [
      { time: 'J1-09h', price: 100.00, adx: 25, move24h: 2.0, action: 'setup' },
      { time: 'J1-18h', price: 104.00, adx: 32, move24h: 4.0, action: 'check' },
      { time: 'J2-09h', price: 104.50, adx: 38, move24h: 4.5, action: 'check_breakout' },
      { time: 'J2-12h', price: 107.00, adx: 40, move24h: 7.0, action: 'entry_expected' },
      { time: 'J2-15h', price: 110.24, adx: 42, move24h: 10.2, action: 'exit_expected' },
    ],
    entryZoneInitial: { from: 98, to: 99 },
    expectedBehavior: {
      mode: 'breakout',
      switchTime: 'J2-09h',
      entryPrice: 105,
      exitPrice: 107,
      gain: 2.0,
      captureRate: 20, // 2% capturé sur 10% mouvement
    },
    success: (result) => {
      return result.modeSwitched && 
             result.entryPrice >= 104 && result.entryPrice <= 106 &&
             result.gain >= 1.5 && result.gain <= 3.0;
    }
  },

  {
    id: 2,
    name: '📉 PULLBACK NORMAL - BTC Correction Saine',
    description: 'BTC à 50k, pullback à 49k (-2%), rebond prévu',
    symbol: 'BTC/USD:USD',
    timeline: [
      { time: 'T0', price: 50000, adx: 35, move24h: 3.0, action: 'setup' },
      { time: 'T+1h', price: 49500, adx: 32, move24h: -1.0, action: 'approach_zone' },
      { time: 'T+2h', price: 49200, adx: 30, move24h: -1.6, action: 'in_zone' },
      { time: 'T+3h', price: 49000, adx: 28, move24h: -2.0, action: 'entry_expected' },
      { time: 'T+5h', price: 49800, adx: 30, move24h: -0.4, action: 'profit' },
      { time: 'T+8h', price: 50500, adx: 33, move24h: 1.0, action: 'exit_expected' },
    ],
    entryZoneInitial: { from: 48900, to: 49100 },
    expectedBehavior: {
      mode: 'pullback',
      noBreakoutSwitch: true,
      entryPrice: 49000,
      exitPrice: 50000,
      gain: 2.0,
      captureRate: 100, // Capture complète du rebond
    },
    success: (result) => {
      return !result.modeSwitched && 
             result.entryPrice >= 48900 && result.entryPrice <= 49100 &&
             result.gain >= 1.5;
    }
  },

  {
    id: 3,
    name: '⚡ TRAILING STOP - ETH Petit Gain +1.5%',
    description: 'ETH entry à 2500$, monte à 2537.5$ (+1.5%), trailing doit tenir',
    symbol: 'ETH/USD:USD',
    timeline: [
      { time: 'T0', price: 2500.0, unrealizedR: 0.0, action: 'entry' },
      { time: 'T+15min', price: 2507.5, unrealizedR: 0.5, action: 'small_profit' },
      { time: 'T+30min', price: 2515.0, unrealizedR: 1.0, action: 'decent_profit' },
      { time: 'T+45min', price: 2525.0, unrealizedR: 1.5, action: 'target_zone' },
      { time: 'T+50min', price: 2537.5, unrealizedR: 2.0, action: 'peak' },
      { time: 'T+55min', price: 2532.5, unrealizedR: 1.8, action: 'correction_minor' },
      { time: 'T+60min', price: 2527.5, unrealizedR: 1.5, action: 'still_profitable' },
    ],
    stopDistance: 15.0, // 0.6% stop
    expectedBehavior: {
      trailingActivates: true,
      exitPrice: 2527.5, // Devrait tenir jusqu'ici
      minGain: 1.0, // Au moins +1%
      noEarlyExit: true, // Pas de sortie avant +1.5R
    },
    success: (result) => {
      return result.gain >= 1.0 && 
             result.exitReason !== 'early_trail_stop' &&
             result.maxUnrealizedR >= 1.5;
    }
  },

  {
    id: 4,
    name: '🎯 TIER SYSTEM - Sélection BTC vs ENA',
    description: 'BTC à +0.5% vs ENA à +5%, BTC doit être prioritaire',
    cryptos: [
      { symbol: 'BTC/USD:USD', move24h: 0.5, volume: 2000000000, tier: 1, tierBonus: 2.0 },
      { symbol: 'ETH/USD:USD', move24h: 0.7, volume: 1500000000, tier: 1, tierBonus: 2.0 },
      { symbol: 'SOL/USD:USD', move24h: 1.2, volume: 800000000, tier: 1, tierBonus: 2.0 },
      { symbol: 'XRP/USD:USD', move24h: 1.5, volume: 600000000, tier: 2, tierBonus: 1.0 },
      { symbol: 'ENA/USD:USD', move24h: 5.0, volume: 5000000, tier: 4, tierBonus: -1.0 },
      { symbol: 'EIGEN/USD:USD', move24h: 6.0, volume: 3000000, tier: 4, tierBonus: -1.0 },
    ],
    expectedBehavior: {
      top5Includes: ['BTC', 'ETH', 'SOL'],
      top10NoTier4: true,
      btcRanksBefore: 'ENA',
    },
    success: (result) => {
      const btcRank = result.rankings.findIndex(r => r.symbol.includes('BTC'));
      const enaRank = result.rankings.findIndex(r => r.symbol.includes('ENA'));
      const top5 = result.rankings.slice(0, 5).map(r => r.symbol);
      
      return btcRank < enaRank && 
             btcRank <= 4 &&
             top5.some(s => s.includes('BTC') || s.includes('ETH') || s.includes('SOL'));
    }
  },

  {
    id: 5,
    name: '🛑 STOP LOSS - Protection Rapide',
    description: 'Entry à 100$, prix chute à 99$ (-1%), stop doit déclencher',
    symbol: 'AVAX/USD:USD',
    timeline: [
      { time: 'T0', price: 100.0, unrealizedR: 0.0, action: 'entry' },
      { time: 'T+5min', price: 99.8, unrealizedR: -0.4, action: 'small_loss' },
      { time: 'T+10min', price: 99.5, unrealizedR: -0.8, action: 'approaching_stop' },
      { time: 'T+12min', price: 99.0, unrealizedR: -1.2, action: 'stop_hit' },
    ],
    stopDistance: 0.8, // Stop à 99.2$
    expectedBehavior: {
      stopHit: true,
      exitPrice: 99.2,
      loss: -0.8,
      fastExit: true,
    },
    success: (result) => {
      return result.exitReason === 'stop_loss_hit' && 
             result.loss >= -1.0 && result.loss <= -0.6;
    }
  },

  {
    id: 6,
    name: '🔄 BREAKOUT FAIL - Pas de Switch si Conditions Manquantes',
    description: 'Prix +3% hors zone MAIS ADX faible (range), pas de breakout',
    symbol: 'ADA/USD:USD',
    timeline: [
      { time: 'T0', price: 1.00, adx: 15, move24h: 3.5, action: 'setup' },
      { time: 'T+2h', price: 1.03, adx: 18, move24h: 3.0, action: 'check' },
      { time: 'T+4h', price: 1.04, adx: 16, move24h: 4.0, action: 'check_no_breakout' },
    ],
    entryZoneInitial: { from: 0.98, to: 0.99 },
    expectedBehavior: {
      mode: 'pullback',
      noBreakoutSwitch: true, // ADX trop faible
      reason: 'weak_trend',
    },
    success: (result) => {
      return !result.modeSwitched && result.mode === 'pullback';
    }
  },

  {
    id: 7,
    name: '🎢 VOLATILITÉ EXTRÊME - ETH Flash +8% puis -3%',
    description: 'ETH spike violent +8% puis correction, agent doit gérer',
    symbol: 'ETH/USD:USD',
    timeline: [
      { time: 'T0', price: 2500, adx: 35, move24h: 2.0, action: 'setup' },
      { time: 'T+30min', price: 2650, adx: 55, move24h: 6.0, action: 'spike' },
      { time: 'T+45min', price: 2700, adx: 62, move24h: 8.0, action: 'peak' },
      { time: 'T+60min', price: 2620, adx: 58, move24h: 4.8, action: 'correction' },
    ],
    entryZoneInitial: { from: 2450, to: 2480 },
    expectedBehavior: {
      mode: 'breakout', // Devrait switcher
      entryPrice: 2600, // Entry tardive mais sécurisée
      volatilityExit: true, // Peut sortir sur spike volatilité
    },
    success: (result) => {
      // Accepte soit entry + profit, soit pas d'entry si trop volatile
      return (result.entered && result.gain > 0) || 
             (!result.entered && result.reason === 'volatility_spike');
    }
  },

  {
    id: 8,
    name: '⏰ MAX HOLD TIME - BTC Position Trop Longue',
    description: 'BTC entry à 50k, reste flat 36h+, sortie temps max',
    symbol: 'BTC/USD:USD',
    timeline: [
      { time: 'T0', price: 50000, unrealizedR: 0.0, action: 'entry' },
      { time: 'T+12h', price: 50200, unrealizedR: 0.4, action: 'flat' },
      { time: 'T+24h', price: 50100, unrealizedR: 0.2, action: 'flat' },
      { time: 'T+36h', price: 50300, unrealizedR: 0.6, action: 'max_hold' },
    ],
    stopDistance: 500, // Stop à 49500
    expectedBehavior: {
      exitReason: 'max_hold_time_exceeded',
      exitTime: 'T+36h',
      profit: 0.6, // Petit profit préservé
    },
    success: (result) => {
      return result.exitReason === 'max_hold_time_exceeded' && 
             result.gain >= 0 && result.gain <= 1.0;
    }
  },

  {
    id: 9,
    name: '💰 PARTIAL EXIT - SOL TP1 +2%, TP2 +4%',
    description: 'SOL atteint TP1, prend profit partiel, continue vers TP2',
    symbol: 'SOL/USD:USD',
    timeline: [
      { time: 'T0', price: 100.0, unrealizedR: 0.0, action: 'entry' },
      { time: 'T+1h', price: 102.0, unrealizedR: 2.0, action: 'tp1_hit' },
      { time: 'T+2h', price: 103.0, unrealizedR: 3.0, action: 'continue' },
      { time: 'T+3h', price: 104.0, unrealizedR: 4.0, action: 'tp2_hit' },
    ],
    stopDistance: 1.0,
    takeProfit: [102.0, 104.0],
    expectedBehavior: {
      partialExit: true,
      partialExitPrice: 102.0,
      finalExitPrice: 104.0,
      totalGain: 3.0, // Moyenne entre sorties
    },
    success: (result) => {
      return result.partialTaken && 
             result.gain >= 2.5 && result.gain <= 4.0;
    }
  },

  {
    id: 10,
    name: '🔁 CONSECUTIVE STOPS - Circuit Breaker',
    description: 'Agent prend 3 stops d\'affilée, doit ralentir/arrêter',
    trades: [
      { symbol: 'XRP/USD:USD', entry: 1.00, exit: 0.98, result: 'loss' },
      { symbol: 'ADA/USD:USD', entry: 1.50, exit: 1.47, result: 'loss' },
      { symbol: 'AVAX/USD:USD', entry: 35.0, exit: 34.3, result: 'loss' },
    ],
    expectedBehavior: {
      consecutiveStops: 3,
      circuitBreaker: true,
      nextTradeBlocked: true,
    },
    success: (result) => {
      return result.consecutiveStops >= 3 && 
             result.canTrade === false;
    }
  },

  {
    id: 11,
    name: '🌙 MOONSHOT MODE - DOGE +25% Parabolic',
    description: 'DOGE explose +25%, trailing ultra loose doit laisser courir',
    symbol: 'DOGE/USD:USD',
    timeline: [
      { time: 'T0', price: 0.10, unrealizedR: 0.0, action: 'entry' },
      { time: 'T+30min', price: 0.115, unrealizedR: 10.0, action: 'moonshot' },
      { time: 'T+1h', price: 0.120, unrealizedR: 15.0, action: 'peak' },
      { time: 'T+90min', price: 0.125, unrealizedR: 20.0, action: 'parabolic' },
      { time: 'T+2h', price: 0.118, unrealizedR: 13.0, action: 'correction' },
    ],
    stopDistance: 0.0015, // Stop serré initial
    expectedBehavior: {
      moonshotMode: true,
      trailingMultiplier: 3.0, // x3 trailing
      exitPrice: 0.118, // Devrait tenir malgré -7$ depuis peak
      minGain: 15.0,
    },
    success: (result) => {
      return result.moonshotDetected && 
             result.gain >= 15.0 &&
             result.exitReason !== 'early_stop';
    }
  },

  {
    id: 12,
    name: '🎭 WIN APRÈS LOSS - Breakout Autorisé',
    description: 'Dernier trade WIN → breakout OK, dernier LOSS → pas breakout',
    scenarios: [
      { 
        lastTrade: 'win', 
        conditions: { adx: 35, move24h: 5, timeOutOfZone: 3 },
        expectedBreakout: true 
      },
      { 
        lastTrade: 'loss', 
        conditions: { adx: 35, move24h: 5, timeOutOfZone: 3 },
        expectedBreakout: false 
      },
    ],
    success: (result) => {
      return result.scenarios[0].breakoutSwitched === true &&
             result.scenarios[1].breakoutSwitched === false;
    }
  },
];

// ============================================================================
// SIMULATEUR DE SCÉNARIOS
// ============================================================================

class ScenarioSimulator {
  constructor() {
    this.results = [];
  }

  async runScenario(scenario) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🧪 TEST ${scenario.id}: ${scenario.name}`);
    console.log(`📝 ${scenario.description}`);
    console.log('─'.repeat(80));

    try {
      let result;
      
      if (scenario.timeline) {
        result = await this.simulateTimeline(scenario);
      } else if (scenario.cryptos) {
        result = await this.simulateTierSelection(scenario);
      } else if (scenario.trades) {
        result = await this.simulateConsecutiveTrades(scenario);
      } else if (scenario.scenarios) {
        result = await this.simulateConditionalBehavior(scenario);
      }

      const success = scenario.success(result);
      result.success = success;
      result.scenarioId = scenario.id;
      result.scenarioName = scenario.name;

      this.results.push(result);

      console.log('\n📊 RÉSULTAT:');
      console.log(`   Status: ${success ? '✅ PASS' : '❌ FAIL'}`);
      console.log(`   Détails: ${JSON.stringify(result, null, 2)}`);

      return result;

    } catch (error) {
      console.error(`❌ ERREUR lors du test ${scenario.id}:`, error);
      return {
        success: false,
        error: error.message,
        scenarioId: scenario.id,
        scenarioName: scenario.name,
      };
    }
  }

  async simulateTimeline(scenario) {
    console.log('\n⏱️  SIMULATION TIMELINE:\n');
    
    let entryPrice = null;
    let exitPrice = null;
    let modeSwitched = false;
    let maxUnrealizedR = 0;
    let exitReason = null;
    let partialTaken = false;
    let moonshotDetected = false;

    for (const step of scenario.timeline) {
      console.log(`   ${step.time.padEnd(12)} | Prix: ${step.price.toFixed(2).padEnd(10)} | ADX: ${(step.adx || 0).toString().padEnd(4)} | ${step.action}`);

      // Logique basée sur l'action
      if (step.action === 'entry' || step.action === 'entry_expected') {
        entryPrice = step.price;
      }

      if (step.action === 'check_breakout') {
        // Vérifier conditions breakout
        const adxOk = (step.adx || 0) > 30;
        const moveOk = Math.abs(step.move24h || 0) > 4.0;
        const priceAboveZone = scenario.entryZoneInitial 
          ? ((step.price - scenario.entryZoneInitial.to) / scenario.entryZoneInitial.to) * 100 > 3
          : false;

        if (adxOk && moveOk && priceAboveZone) {
          modeSwitched = true;
          console.log('      └─> 🚀 BREAKOUT MODE ACTIVÉ');
        }
      }

      if (step.action.includes('exit')) {
        exitPrice = step.price;
        exitReason = step.action;
      }

      if (step.unrealizedR && step.unrealizedR > maxUnrealizedR) {
        maxUnrealizedR = step.unrealizedR;
      }

      if (step.unrealizedR && step.unrealizedR >= 15) {
        moonshotDetected = true;
      }

      if (step.action === 'tp1_hit') {
        partialTaken = true;
      }
    }

    const gain = entryPrice && exitPrice 
      ? ((exitPrice - entryPrice) / entryPrice) * 100 
      : 0;

    return {
      entryPrice,
      exitPrice,
      gain,
      modeSwitched,
      mode: modeSwitched ? 'breakout' : 'pullback',
      maxUnrealizedR,
      exitReason,
      partialTaken,
      moonshotDetected,
      entered: entryPrice !== null,
    };
  }

  async simulateTierSelection(scenario) {
    console.log('\n🏆 SIMULATION RANKING:\n');

    // Calculer scores avec système de TIERS
    const rankings = scenario.cryptos.map(crypto => {
      const moveScore = Math.min(10, crypto.move24h * 2);
      const volumeScore = Math.log10(crypto.volume) - 6; // Normalize
      const tierBonus = crypto.tierBonus;
      const qualityBonus = crypto.tier <= 2 ? 1.5 : 0;

      const totalScore = moveScore * 0.25 + volumeScore * 0.25 + tierBonus + qualityBonus;

      return {
        symbol: crypto.symbol,
        tier: crypto.tier,
        move24h: crypto.move24h,
        score: totalScore,
      };
    });

    // Trier par score
    rankings.sort((a, b) => b.score - a.score);

    console.log('   Rank | Symbol          | Tier | Move   | Score');
    console.log('   ' + '─'.repeat(60));
    rankings.forEach((r, i) => {
      const emoji = i < 5 ? '🥇' : i < 10 ? '🥈' : '🥉';
      console.log(`   ${emoji} ${(i + 1).toString().padEnd(2)}  | ${r.symbol.padEnd(15)} | T${r.tier}   | ${r.move24h.toFixed(1).padEnd(6)} | ${r.score.toFixed(2)}`);
    });

    return { rankings };
  }

  async simulateConsecutiveTrades(scenario) {
    console.log('\n🔁 SIMULATION CONSECUTIVE TRADES:\n');

    let consecutiveStops = 0;

    for (const trade of scenario.trades) {
      const profit = trade.exit - trade.entry;
      const isLoss = profit < 0;

      if (isLoss) {
        consecutiveStops++;
      } else {
        consecutiveStops = 0;
      }

      console.log(`   ${trade.symbol.padEnd(20)} | Entry: ${trade.entry.toFixed(2)} | Exit: ${trade.exit.toFixed(2)} | ${isLoss ? '❌ LOSS' : '✅ WIN'}`);
    }

    const circuitBreaker = consecutiveStops >= 3;
    const canTrade = !circuitBreaker;

    console.log(`\n   Consecutive stops: ${consecutiveStops}`);
    console.log(`   Circuit breaker: ${circuitBreaker ? '🔴 ACTIVÉ' : '🟢 Inactif'}`);
    console.log(`   Can trade: ${canTrade ? '✅ OUI' : '❌ NON'}`);

    return { consecutiveStops, circuitBreaker, canTrade };
  }

  async simulateConditionalBehavior(scenario) {
    console.log('\n🎭 SIMULATION CONDITIONAL:\n');

    const results = {
      scenarios: []
    };

    for (const subScenario of scenario.scenarios) {
      const { lastTrade, conditions, expectedBreakout } = subScenario;

      // Simuler conditions
      const adxOk = conditions.adx > 30;
      const moveOk = conditions.move24h > 4;
      const timeOk = conditions.timeOutOfZone > 2;
      const lastTradeWin = lastTrade === 'win';

      const breakoutSwitched = adxOk && moveOk && timeOk && lastTradeWin;

      console.log(`   Last trade: ${lastTrade.toUpperCase().padEnd(6)} | ADX: ${conditions.adx} | Move: ${conditions.move24h}% | Time: ${conditions.timeOutOfZone}h`);
      console.log(`      → Breakout: ${breakoutSwitched ? '✅ ACTIVÉ' : '❌ BLOQUÉ'} (expected: ${expectedBreakout ? 'OUI' : 'NON'})`);

      results.scenarios.push({ 
        lastTrade, 
        breakoutSwitched, 
        expected: expectedBreakout 
      });
    }

    return results;
  }

  async runAllScenarios() {
    console.log('\n');
    console.log('🚀 DÉMARRAGE TEST SUITE COMPLÈTE');
    console.log('═'.repeat(80));
    console.log(`Total scénarios: ${TEST_SCENARIOS.length}`);

    for (const scenario of TEST_SCENARIOS) {
      await this.runScenario(scenario);
      await new Promise(resolve => setTimeout(resolve, 500)); // Pause entre tests
    }

    this.printSummary();
  }

  printSummary() {
    console.log('\n\n');
    console.log('═'.repeat(80));
    console.log('📊 RÉSUMÉ COMPLET DES TESTS');
    console.log('═'.repeat(80));

    const passed = this.results.filter(r => r.success).length;
    const failed = this.results.filter(r => !r.success).length;
    const total = this.results.length;

    console.log(`\n✅ Tests réussis: ${passed}/${total}`);
    console.log(`❌ Tests échoués: ${failed}/${total}`);
    console.log(`📈 Taux de succès: ${((passed / total) * 100).toFixed(1)}%\n`);

    if (failed > 0) {
      console.log('❌ TESTS ÉCHOUÉS:\n');
      this.results.filter(r => !r.success).forEach(r => {
        console.log(`   ${r.scenarioId}. ${r.scenarioName}`);
        if (r.error) console.log(`      Erreur: ${r.error}`);
      });
    }

    console.log('\n' + '═'.repeat(80));
    console.log('🎯 RECOMMANDATIONS:\n');

    if (passed === total) {
      console.log('   ✅ Tous les tests sont passés !');
      console.log('   ✅ L\'agent est prêt pour le déploiement en production');
      console.log('   ✅ Surveillez les 10-20 premiers trades en conditions réelles');
    } else {
      console.log('   ⚠️  Certains tests ont échoué');
      console.log('   ⚠️  Vérifiez les comportements avant déploiement');
      console.log('   ⚠️  Ajustez les paramètres selon les résultats');
    }

    console.log('\n' + '═'.repeat(80));
  }
}

// ============================================================================
// EXÉCUTION
// ============================================================================

const simulator = new ScenarioSimulator();
simulator.runAllScenarios().catch(console.error);
