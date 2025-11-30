/**
 * Analyse approfondie du problème de backtest
 * On va simuler exactement ce que fait le backtest
 */

const CONFIG = {
  POSITION_SIZE_PCT: 0.4,
  DEFAULT_LEVERAGE: 4.5,
  EXIT: {
    STOP_LOSS_ATR_MULT: 2.0,
    STOP_LOSS_MIN: 0.8,
    STOP_LOSS_MAX: 3.0,
    TAKE_PROFIT: 3.0,
  },
  COSTS: {
    TRADING_FEE_PCT: 0.04,
    SLIPPAGE_PCT: 0.05,
    FUNDING_RATE_PCT: 0.01,
    FUNDING_INTERVAL_BARS: 32,
  }
};

function calculatePnl(entryPrice, exitPrice, side, marginUsd, leverage, holdBars) {
  const pricePct = side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  const grossPnlPct = pricePct * leverage;
  
  const tradingFees = CONFIG.COSTS.TRADING_FEE_PCT * 2;
  const slippage = CONFIG.COSTS.SLIPPAGE_PCT * 2;
  const fundingPeriods = Math.floor(holdBars / CONFIG.COSTS.FUNDING_INTERVAL_BARS);
  const funding = fundingPeriods * CONFIG.COSTS.FUNDING_RATE_PCT;
  
  const totalCostsPct = (tradingFees + slippage + funding) * leverage;
  const netPnlPct = grossPnlPct - totalCostsPct;
  
  const netPnlUsd = (netPnlPct / 100) * marginUsd;
  const feesUsd = (totalCostsPct / 100) * marginUsd;
  
  return { grossPnlPct, netPnlPct, netPnlUsd, feesUsd };
}

console.log('═'.repeat(80));
console.log('SIMULATION: 11 cryptos × 11 mois avec différents WR');
console.log('═'.repeat(80));

const initialCapital = 2000;
let capital = initialCapital;
const leverage = 4.5;
const avgSlPct = 1.5; // SL moyen estimé
const tpPct = 3.0;

// Simulation avec différents win rates
const simulations = [
  { wr: 0.30, name: '30% WR (bad)' },
  { wr: 0.37, name: '37.6% WR (breakeven)' },
  { wr: 0.45, name: '45% WR (average)' },
  { wr: 0.50, name: '50% WR (good)' },
  { wr: 0.55, name: '55% WR (excellent)' },
];

// Estimation du nombre de trades sur 11 mois
const tradesPerSymbolPerMonth = 3; // Estimation conservative
const symbols = 11;
const months = 11;
const totalTrades = tradesPerSymbolPerMonth * symbols * months;

console.log(`\nEstimation: ${totalTrades} trades sur ${months} mois avec ${symbols} symboles`);

for (const sim of simulations) {
  capital = initialCapital;
  const wins = Math.round(totalTrades * sim.wr);
  const losses = totalTrades - wins;
  
  // Calculer le PnL moyen pour chaque type
  const avgMargin = 800; // 40% de $2000
  const holdBars = 32; // 8 heures moyenne
  
  const winPnl = calculatePnl(100, 100 * (1 + tpPct / 100), 'long', avgMargin, leverage, holdBars);
  const lossPnl = calculatePnl(100, 100 * (1 - avgSlPct / 100), 'long', avgMargin, leverage, holdBars);
  
  // Simulation simple
  const totalWinPnl = wins * winPnl.netPnlUsd;
  const totalLossPnl = losses * Math.abs(lossPnl.netPnlUsd);
  const netPnl = totalWinPnl - totalLossPnl;
  
  console.log(`\n${sim.name}:`);
  console.log(`  Wins: ${wins}, Losses: ${losses}`);
  console.log(`  Avg Win: $${winPnl.netPnlUsd.toFixed(2)}, Avg Loss: $${Math.abs(lossPnl.netPnlUsd).toFixed(2)}`);
  console.log(`  Total Win PnL: $${totalWinPnl.toFixed(2)}`);
  console.log(`  Total Loss PnL: -$${totalLossPnl.toFixed(2)}`);
  console.log(`  Net PnL: $${netPnl.toFixed(2)} (${(netPnl / initialCapital * 100).toFixed(1)}%)`);
  console.log(`  Final: $${(initialCapital + netPnl).toFixed(2)}`);
}

// TEST: Que se passe-t-il si le win rate est très bas?
console.log('\n═'.repeat(80));
console.log('ANALYSE DU PROBLÈME POTENTIEL');
console.log('═'.repeat(80));

// Avec $2000 et -50%, on arrive à $1000
// Cela veut dire une perte de $1000
// Avec un loss moyen de ~$60.50, ça fait environ 17 losses nets
// Si on a 300 trades et le WR est de ~30%, on a:
// 90 wins × $100 = $9000 gagné
// 210 losses × $60 = $12600 perdu
// Net = -$3600 (!)

const targetLoss = 1000; // Pour arriver à -50%
const lossPerTrade = 60; // Environ
const winPerTrade = 100;

console.log('\nPour perdre $1000 avec ce système:');
const neededNetLosses = Math.ceil(targetLoss / lossPerTrade);
console.log(`  Besoin de ~${neededNetLosses} trades perdants nets`);
console.log(`  Si on a ${totalTrades} trades:`);

for (let wr = 0.20; wr <= 0.40; wr += 0.05) {
  const wins = Math.round(totalTrades * wr);
  const losses = totalTrades - wins;
  const grossWin = wins * winPerTrade;
  const grossLoss = losses * lossPerTrade;
  const net = grossWin - grossLoss;
  console.log(`    WR=${(wr * 100).toFixed(0)}%: ${wins}W/${losses}L → Net: $${net.toFixed(0)}`);
}

console.log('\n💡 CONCLUSION:');
console.log('  Pour avoir -50% avec ces paramètres, le WR doit être ~25-30%');
console.log('  Si le backtest montre -50%, le problème est probablement:');
console.log('  1. Le signal V5.3/5.4 génère trop de faux signaux');
console.log('  2. Le régime BTC filter élimine trop de bons trades');
console.log('  3. Les conditions de marché 2025 ne matchent pas la stratégie');
