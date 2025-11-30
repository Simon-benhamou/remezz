/**
 * Debug: Vérifier le calcul du PnL dans le backtest
 */

const COSTS = {
  TRADING_FEE_PCT: 0.04,      // 0.04% per side
  SLIPPAGE_PCT: 0.05,         // 0.05% per side (base slippage)
  FUNDING_RATE_PCT: 0.01,     // 0.01% every 8h
  FUNDING_INTERVAL_BARS: 32,  // 32 × 15min = 8h
};

function calculatePnl(entryPrice, exitPrice, side, capitalUsed, holdBars, extraSlippage = 0, leverage = 4.5) {
  // Gross PnL
  let pnlPct = side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  const leveragedPnlPct = pnlPct * leverage;
  
  // Costs
  const entryFee = COSTS.TRADING_FEE_PCT * leverage;
  const exitFee = COSTS.TRADING_FEE_PCT * leverage;
  const baseSlippage = COSTS.SLIPPAGE_PCT * 2 * leverage;
  const dynamicSlippage = extraSlippage * 2 * leverage;
  const totalSlippage = baseSlippage + dynamicSlippage;
  const fundingPeriods = Math.floor(holdBars / COSTS.FUNDING_INTERVAL_BARS);
  const totalFunding = fundingPeriods * COSTS.FUNDING_RATE_PCT * leverage;
  
  const totalCosts = entryFee + exitFee + totalSlippage + totalFunding;
  const netPnlPct = leveragedPnlPct - totalCosts;
  const netPnlUsd = (netPnlPct / 100) * capitalUsed;
  const costsUsd = (totalCosts / 100) * capitalUsed;
  
  return { pnlPct, leveragedPnlPct, totalCosts, netPnlPct, netPnlUsd, costsUsd };
}

console.log('═'.repeat(80));
console.log('DEBUG: CALCUL DU PNL');
console.log('═'.repeat(80));

// Test 1: LONG gagnant +3% TP
console.log('\n📈 TEST 1: LONG +3% TP');
const test1 = calculatePnl(100, 103, 'long', 800, 32, 0, 4.5);
console.log('   Entry: $100, Exit: $103 (+3%)');
console.log('   Margin: $800, Leverage: 4.5x');
console.log('   Gross PnL: ' + test1.pnlPct.toFixed(2) + '%');
console.log('   Leveraged PnL: ' + test1.leveragedPnlPct.toFixed(2) + '% (' + test1.pnlPct.toFixed(2) + '% × 4.5)');
console.log('   Total Costs: ' + test1.totalCosts.toFixed(2) + '%');
console.log('   Net PnL: ' + test1.netPnlPct.toFixed(2) + '%');
console.log('   Net PnL USD: $' + test1.netPnlUsd.toFixed(2));
console.log('   Costs USD: $' + test1.costsUsd.toFixed(2));

// Test 2: LONG perdant -1.5% SL
console.log('\n📉 TEST 2: LONG -1.5% SL');
const test2 = calculatePnl(100, 98.5, 'long', 800, 32, 0, 4.5);
console.log('   Entry: $100, Exit: $98.5 (-1.5%)');
console.log('   Margin: $800, Leverage: 4.5x');
console.log('   Gross PnL: ' + test2.pnlPct.toFixed(2) + '%');
console.log('   Leveraged PnL: ' + test2.leveragedPnlPct.toFixed(2) + '%');
console.log('   Total Costs: ' + test2.totalCosts.toFixed(2) + '%');
console.log('   Net PnL: ' + test2.netPnlPct.toFixed(2) + '%');
console.log('   Net PnL USD: $' + test2.netPnlUsd.toFixed(2));

// Test 3: Calculons le breakeven
console.log('\n⚖️ TEST 3: BREAKEVEN');
console.log('   Avec les coûts de ' + test1.totalCosts.toFixed(2) + '%...');
const breakeven = test1.totalCosts / 4.5;
console.log('   Le prix doit bouger de +' + breakeven.toFixed(3) + '% pour breakeven');

// Test 4: 10 trades: 6 TP (+3%), 4 SL (-1.5%)
console.log('\n📊 TEST 4: Simulation 10 trades (60% WR)');
const wins = 6, losses = 4;
const totalWinPnl = wins * test1.netPnlPct;
const totalLossPnl = losses * test2.netPnlPct;
const totalPnl = totalWinPnl + totalLossPnl;
console.log('   6 wins × ' + test1.netPnlPct.toFixed(2) + '% = ' + totalWinPnl.toFixed(2) + '%');
console.log('   4 losses × ' + test2.netPnlPct.toFixed(2) + '% = ' + totalLossPnl.toFixed(2) + '%');
console.log('   TOTAL: ' + totalPnl.toFixed(2) + '%');
console.log('   Avec $2000 capital: $' + (totalPnl / 100 * 2000 * 0.4).toFixed(2));

// Test 5: Le vrai problème - les coûts sont-ils trop élevés?
console.log('\n🔍 ANALYSE DES COÛTS PAR TRADE:');
console.log('   Trading Fees: 0.04% × 2 × 4.5 = ' + (0.04 * 2 * 4.5).toFixed(2) + '%');
console.log('   Slippage:     0.05% × 2 × 4.5 = ' + (0.05 * 2 * 4.5).toFixed(2) + '%');
console.log('   Funding (8h): 0.01% × 1 × 4.5 = ' + (0.01 * 1 * 4.5).toFixed(2) + '%');
console.log('   TOTAL:        ~' + (0.04*2*4.5 + 0.05*2*4.5 + 0.01*4.5).toFixed(2) + '% par trade');
console.log('');
console.log('   ⚠️  Pour breakeven avec SL à -1.5% et costs ~0.86%:');
console.log('   SL loss = -1.5% × 4.5 = -6.75%');
console.log('   Net SL loss = -6.75% - 0.86% = -7.61%');
console.log('   TP gain = +3% × 4.5 = +13.5%');
console.log('   Net TP gain = +13.5% - 0.86% = +12.64%');
console.log('');
console.log('   Win Rate needed for breakeven:');
console.log('   WR × 12.64% = (1-WR) × 7.61%');
console.log('   WR = 7.61 / (12.64 + 7.61) = ' + (7.61 / (12.64 + 7.61) * 100).toFixed(1) + '%');

