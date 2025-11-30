/**
 * Simulation RÉALISTE avec compounding (le capital diminue/augmente)
 */

const initialCapital = 2000;
const leverage = 4.5;
const positionSizePct = 0.4;
const tradingFeePct = 0.04;
const slippagePct = 0.05;
const fundingPct = 0.01;

function simulateTrade(capital, isWin, slPct = 1.5, tpPct = 3.0, holdBars = 32) {
  const margin = capital * positionSizePct;
  
  const pricePct = isWin ? tpPct : -slPct;
  const grossPnlPct = pricePct * leverage;
  
  // Coûts
  const tradingFees = tradingFeePct * 2;
  const slippage = slippagePct * 2;
  const fundingPeriods = Math.floor(holdBars / 32);
  const funding = fundingPeriods * fundingPct;
  const totalCostsPct = (tradingFees + slippage + funding) * leverage;
  
  const netPnlPct = grossPnlPct - totalCostsPct;
  const netPnlUsd = (netPnlPct / 100) * margin;
  
  return capital + netPnlUsd;
}

console.log('═'.repeat(80));
console.log('SIMULATION RÉALISTE AVEC COMPOUNDING');
console.log('═'.repeat(80));

const winRates = [0.25, 0.30, 0.35, 0.40, 0.45, 0.50];
const totalTrades = 200; // Estimation sur 11 mois

for (const wr of winRates) {
  let capital = initialCapital;
  let wins = 0;
  let losses = 0;
  let maxDrawdown = 0;
  let peak = initialCapital;
  
  // On va simuler avec un pattern aléatoire mais fixe
  for (let i = 0; i < totalTrades; i++) {
    // On utilise un pseudo-random basé sur i et wr pour la reproductibilité
    const isWin = ((i * 17 + Math.floor(wr * 1000)) % 100) < wr * 100;
    
    if (capital < 100) break; // Arrêt si plus de capital
    
    capital = simulateTrade(capital, isWin);
    if (isWin) wins++; else losses++;
    
    if (capital > peak) peak = capital;
    const dd = (peak - capital) / peak * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  
  const returnPct = (capital - initialCapital) / initialCapital * 100;
  console.log(`\nWR ${(wr * 100).toFixed(0)}%:`);
  console.log(`  Trades: ${wins + losses} (${wins}W/${losses}L, actual WR: ${(wins / (wins + losses) * 100).toFixed(1)}%)`);
  console.log(`  Final Capital: $${capital.toFixed(2)}`);
  console.log(`  Return: ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%`);
  console.log(`  Max Drawdown: -${maxDrawdown.toFixed(1)}%`);
}

// Maintenant testons avec beaucoup plus de trades (streaks)
console.log('\n' + '═'.repeat(80));
console.log('TEST AVEC LOSING STREAKS');
console.log('═'.repeat(80));

// Simulation d'un scénario où on a des séries de pertes consécutives
function simWithStreaks(winRate) {
  let capital = initialCapital;
  let trades = 0;
  const maxTrades = 200;
  let consecutiveLosses = 0;
  let maxConsecutiveLosses = 0;
  
  while (trades < maxTrades && capital > 100) {
    // Simuler des streaks plus réalistes
    const rand = Math.random();
    const isWin = rand < winRate;
    
    capital = simulateTrade(capital, isWin);
    trades++;
    
    if (!isWin) {
      consecutiveLosses++;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
    } else {
      consecutiveLosses = 0;
    }
  }
  
  return { capital, trades, maxConsecutiveLosses };
}

// Faire plusieurs simulations et moyenner
for (const wr of [0.25, 0.30, 0.35, 0.40]) {
  const results = [];
  for (let run = 0; run < 100; run++) {
    results.push(simWithStreaks(wr));
  }
  
  const avgCapital = results.reduce((s, r) => s + r.capital, 0) / results.length;
  const avgTrades = results.reduce((s, r) => s + r.trades, 0) / results.length;
  const avgStreaks = results.reduce((s, r) => s + r.maxConsecutiveLosses, 0) / results.length;
  const minCapital = Math.min(...results.map(r => r.capital));
  const maxCapital = Math.max(...results.map(r => r.capital));
  
  console.log(`\nWR ${(wr * 100).toFixed(0)}% (100 simulations):`);
  console.log(`  Avg Final: $${avgCapital.toFixed(0)} (${((avgCapital - initialCapital) / initialCapital * 100).toFixed(1)}%)`);
  console.log(`  Range: $${minCapital.toFixed(0)} - $${maxCapital.toFixed(0)}`);
  console.log(`  Avg Max Losing Streak: ${avgStreaks.toFixed(1)}`);
}

console.log('\n' + '═'.repeat(80));
console.log('CONCLUSION');
console.log('═'.repeat(80));
console.log('Pour avoir -50% ($2000 → $1000):');
console.log('  - Avec compounding, un WR de ~30% peut facilement donner -50%');
console.log('  - Surtout avec des losing streaks de 5-10 trades consécutifs');
console.log('\nLE PROBLÈME PROBABLE:');
console.log('  ❌ La stratégie V5.3/5.4 a un WR trop bas en 2025');
console.log('  ❌ Les conditions d\'entrée sont trop strictes ou pas adaptées');
console.log('  ❌ Le régime BTC filter cause des faux signaux');
