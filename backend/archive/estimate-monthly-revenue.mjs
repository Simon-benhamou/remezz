#!/usr/bin/env node
/**
 * 📊 ESTIMATION DE REVENU MENSUEL - STRATÉGIE ADAPTATIVE V9
 * 
 * Basé sur les résultats du backtest 120 jours (4 mois) :
 * - 110 trades / 120 jours sur 4 assets (BTC, ETH, SOL, XRP)
 * - 49.1% win rate
 * - +7.26% return (sans leverage) sur 4 mois
 * - Focus sur HIGH volatility (99% des trades)
 * 
 * Configuration réelle :
 * - 4 agents en parallèle sur le même capital pool
 * - Leverage variable selon le symbole (3x-5x typique)
 * - Capital de $10,000
 */

const CONFIG = {
  // Capital initial
  startingCapital: 10000,
  
  // Résultats du backtest (120 jours = 4 mois, 4 cryptos)
  backtest: {
    totalTrades: 28,          // ~110 trades / 4 mois = 28/mois
    winRate: 0.491,           // 49.1%
    avgWinPct: 1.85,          // Moyenne des trades gagnants (estimé)
    avgLossPct: -1.10,        // Moyenne des trades perdants (estimé)
    returnWithoutLeverage: 1.82, // % par mois (7.26% / 4)
    profitFactor: 1.65,       // Estimé à partir du WR et avg win/loss
  },
  
  // Configuration de trading réel
  leverage: {
    BTC: 3,    // BTC: 3x leverage (plus stable)
    ETH: 4,    // ETH: 4x leverage
    SOL: 5,    // SOL: 5x leverage (plus volatile)
    XRP: 5,    // XRP: 5x leverage
    default: 4,
  },
  
  // Distribution des trades par asset (basée sur backtest 120j)
  tradeDistribution: {
    BTC: 1 / 110,   // ~1% des trades
    ETH: 30 / 110,  // ~27% des trades
    SOL: 48 / 110,  // ~44% des trades
    XRP: 31 / 110,  // ~28% des trades
  },
  
  // Frais de trading
  fees: {
    makerFee: 0.0002,   // 0.02% maker fee
    takerFee: 0.0004,   // 0.04% taker fee
    fundingRate: 0.0001, // ~0.01% funding rate (8h)
  },
  
  // Gestion du risque
  riskManagement: {
    maxDailyDrawdown: 0.03,      // 3% max perte/jour
    maxTotalDrawdown: 0.10,     // 10% max perte totale
    maxConcurrentPositions: 2,  // Max 2 positions simultanées
    positionSizePct: 0.15,      // 15% du capital par position
  },
};

// Calculer le leverage moyen pondéré
function getWeightedAverageLeverage() {
  let totalWeight = 0;
  let weightedSum = 0;
  
  for (const [asset, distribution] of Object.entries(CONFIG.tradeDistribution)) {
    const leverage = CONFIG.leverage[asset] || CONFIG.leverage.default;
    weightedSum += leverage * distribution;
    totalWeight += distribution;
  }
  
  return weightedSum / totalWeight;
}

// Calculer les frais totaux par trade
function getFeesPerTrade(isWin, holdDays = 0.5) {
  const { makerFee, takerFee, fundingRate } = CONFIG.fees;
  
  // Entry + Exit fees (assume 50% maker, 50% taker)
  const entryExitFees = (makerFee + takerFee) / 2 * 2; // Entry + Exit
  
  // Funding fees (every 8h)
  const fundingPeriods = Math.floor(holdDays * 24 / 8);
  const fundingFees = fundingPeriods * fundingRate;
  
  return entryExitFees + fundingFees;
}

// Simuler un mois de trading avec leverage
function simulateMonth() {
  const { startingCapital, backtest, riskManagement } = CONFIG;
  const avgLeverage = getWeightedAverageLeverage();
  
  console.log('═'.repeat(70));
  console.log('📊 ESTIMATION DE REVENU MENSUEL - Trading avec Leverage');
  console.log('═'.repeat(70));
  console.log(`\n💰 Capital Initial: $${startingCapital.toLocaleString()}`);
  console.log(`📊 Leverage Moyen Pondéré: ${avgLeverage.toFixed(2)}x`);
  console.log(`📈 Win Rate Historique: ${(backtest.winRate * 100).toFixed(1)}%`);
  console.log(`🎯 Trades Attendus/Mois: ${backtest.totalTrades}`);
  
  // Simulation Monte Carlo (1000 itérations)
  const simulations = 1000;
  const results = [];
  
  for (let sim = 0; sim < simulations; sim++) {
    let capital = startingCapital;
    let peakCapital = capital;
    let maxDrawdown = 0;
    let wins = 0;
    let losses = 0;
    let totalFees = 0;
    
    for (let trade = 0; trade < backtest.totalTrades; trade++) {
      // Déterminer si c'est un win ou loss
      const isWin = Math.random() < backtest.winRate;
      
      // Calculer le PnL du trade
      let tradePnlPct;
      if (isWin) {
        // Variation autour de la moyenne (±30%)
        tradePnlPct = backtest.avgWinPct * (0.7 + Math.random() * 0.6);
        wins++;
      } else {
        tradePnlPct = backtest.avgLossPct * (0.7 + Math.random() * 0.6);
        losses++;
      }
      
      // Appliquer le leverage
      const leveragedPnlPct = tradePnlPct * avgLeverage;
      
      // Calculer les frais
      const fees = getFeesPerTrade(isWin) * avgLeverage;
      totalFees += fees * riskManagement.positionSizePct * capital;
      
      // Position size et PnL en $
      const positionSize = capital * riskManagement.positionSizePct;
      const pnlUsd = positionSize * (leveragedPnlPct / 100) - (fees * positionSize);
      
      // Limiter les pertes au max drawdown quotidien
      const adjustedPnl = Math.max(pnlUsd, -capital * CONFIG.riskManagement.maxDailyDrawdown);
      capital += adjustedPnl;
      
      // Stop si max drawdown atteint
      if (capital < startingCapital * (1 - CONFIG.riskManagement.maxTotalDrawdown)) {
        break;
      }
      
      // Tracker le drawdown
      if (capital > peakCapital) peakCapital = capital;
      const drawdown = (peakCapital - capital) / peakCapital;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
    
    results.push({
      finalCapital: capital,
      returnPct: ((capital - startingCapital) / startingCapital) * 100,
      maxDrawdown,
      wins,
      losses,
      totalFees,
    });
  }
  
  // Analyser les résultats
  results.sort((a, b) => a.returnPct - b.returnPct);
  
  const avgReturn = results.reduce((sum, r) => sum + r.returnPct, 0) / simulations;
  const medianReturn = results[Math.floor(simulations / 2)].returnPct;
  const worstCase = results[Math.floor(simulations * 0.05)].returnPct; // 5th percentile
  const bestCase = results[Math.floor(simulations * 0.95)].returnPct;  // 95th percentile
  const avgDrawdown = results.reduce((sum, r) => sum + r.maxDrawdown, 0) / simulations;
  const avgFees = results.reduce((sum, r) => sum + r.totalFees, 0) / simulations;
  
  // Calcul sans leverage pour comparaison
  const returnWithoutLeverage = backtest.returnWithoutLeverage;
  
  console.log('\n' + '─'.repeat(70));
  console.log('📈 RÉSULTATS DE SIMULATION (1000 itérations Monte Carlo)');
  console.log('─'.repeat(70));
  
  console.log(`\n🎯 SCÉNARIO RÉALISTE (Médiane):`);
  console.log(`   Return: +${medianReturn.toFixed(2)}%`);
  console.log(`   Capital Final: $${(startingCapital * (1 + medianReturn/100)).toFixed(2)}`);
  console.log(`   Profit: $${(startingCapital * medianReturn / 100).toFixed(2)}`);
  
  console.log(`\n📊 SCÉNARIO MOYEN:`);
  console.log(`   Return: +${avgReturn.toFixed(2)}%`);
  console.log(`   Capital Final: $${(startingCapital * (1 + avgReturn/100)).toFixed(2)}`);
  console.log(`   Profit: $${(startingCapital * avgReturn / 100).toFixed(2)}`);
  
  console.log(`\n🔥 MEILLEUR CAS (95th percentile):`);
  console.log(`   Return: +${bestCase.toFixed(2)}%`);
  console.log(`   Capital Final: $${(startingCapital * (1 + bestCase/100)).toFixed(2)}`);
  console.log(`   Profit: $${(startingCapital * bestCase / 100).toFixed(2)}`);
  
  console.log(`\n⚠️ PIRE CAS (5th percentile):`);
  console.log(`   Return: ${worstCase.toFixed(2)}%`);
  console.log(`   Capital Final: $${(startingCapital * (1 + worstCase/100)).toFixed(2)}`);
  console.log(`   Perte: $${Math.abs(startingCapital * worstCase / 100).toFixed(2)}`);
  
  console.log('\n' + '─'.repeat(70));
  console.log('💡 MÉTRIQUES DE RISQUE');
  console.log('─'.repeat(70));
  console.log(`   Max Drawdown Moyen: ${(avgDrawdown * 100).toFixed(2)}%`);
  console.log(`   Frais Totaux Moyens: $${avgFees.toFixed(2)}`);
  console.log(`   Trades Positifs: ${Math.round(backtest.totalTrades * backtest.winRate)} / ${backtest.totalTrades}`);
  
  console.log('\n' + '─'.repeat(70));
  console.log('📈 IMPACT DU LEVERAGE');
  console.log('─'.repeat(70));
  console.log(`   Sans Leverage (1x): +${returnWithoutLeverage.toFixed(2)}% → $${(startingCapital * (1 + returnWithoutLeverage/100)).toFixed(2)}`);
  console.log(`   Avec Leverage (${avgLeverage.toFixed(1)}x): +${medianReturn.toFixed(2)}% → $${(startingCapital * (1 + medianReturn/100)).toFixed(2)}`);
  console.log(`   Multiplicateur effectif: ${(medianReturn / returnWithoutLeverage).toFixed(2)}x`);
  
  // Projection annuelle
  console.log('\n' + '═'.repeat(70));
  console.log('📅 PROJECTION ANNUELLE (12 mois)');
  console.log('═'.repeat(70));
  
  const monthlyReturnFactor = 1 + (medianReturn / 100);
  const yearlyReturn = Math.pow(monthlyReturnFactor, 12) - 1;
  const yearlyCapital = startingCapital * (1 + yearlyReturn);
  
  console.log(`\n   Return Annuel Composé: +${(yearlyReturn * 100).toFixed(2)}%`);
  console.log(`   Capital Final (1 an): $${yearlyCapital.toFixed(2)}`);
  console.log(`   Profit Annuel: $${(yearlyCapital - startingCapital).toFixed(2)}`);
  
  // Tableau récapitulatif par scénario
  console.log('\n' + '═'.repeat(70));
  console.log('📊 TABLEAU RÉCAPITULATIF MENSUEL');
  console.log('═'.repeat(70));
  console.log(`
┌──────────────────┬─────────────┬───────────────┬─────────────┐
│    Scénario      │   Return    │ Capital Final │   Profit    │
├──────────────────┼─────────────┼───────────────┼─────────────┤
│ 🔴 Pire (5%)     │  ${worstCase >= 0 ? '+' : ''}${worstCase.toFixed(1).padStart(6)}%  │  $${(startingCapital * (1 + worstCase/100)).toFixed(0).padStart(8)}   │  ${worstCase >= 0 ? '+' : ''}$${(startingCapital * worstCase / 100).toFixed(0).padStart(6)}  │
│ 🟡 Médiane       │  +${medianReturn.toFixed(1).padStart(5)}%  │  $${(startingCapital * (1 + medianReturn/100)).toFixed(0).padStart(8)}   │  +$${(startingCapital * medianReturn / 100).toFixed(0).padStart(5)}  │
│ 🟢 Moyenne       │  +${avgReturn.toFixed(1).padStart(5)}%  │  $${(startingCapital * (1 + avgReturn/100)).toFixed(0).padStart(8)}   │  +$${(startingCapital * avgReturn / 100).toFixed(0).padStart(5)}  │
│ 🔵 Meilleur(95%) │  +${bestCase.toFixed(1).padStart(5)}%  │  $${(startingCapital * (1 + bestCase/100)).toFixed(0).padStart(8)}   │  +$${(startingCapital * bestCase / 100).toFixed(0).padStart(5)}  │
└──────────────────┴─────────────┴───────────────┴─────────────┘
  `);
  
  console.log('═'.repeat(70));
  console.log('✅ ESTIMATION TERMINÉE');
  console.log('═'.repeat(70));
  
  return {
    medianReturn,
    avgReturn,
    worstCase,
    bestCase,
    avgDrawdown,
  };
}

simulateMonth();
