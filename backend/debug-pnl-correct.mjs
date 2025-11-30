/**
 * DEBUG: Vérification du calcul correct des coûts
 */

const CONFIG = {
  COSTS: {
    TRADING_FEE_PCT: 0.04,
    SLIPPAGE_PCT: 0.05,
    FUNDING_RATE_PCT: 0.01,
    FUNDING_INTERVAL_BARS: 32,
  }
};

// MÉTHODE INCORRECTE (actuelle dans backtestService)
function calculatePnlIncorrect(entryPrice, exitPrice, side, marginUsd, leverage, holdBars) {
  const pricePct = side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  const grossPnlPct = pricePct * leverage;
  
  const tradingFees = CONFIG.COSTS.TRADING_FEE_PCT * 2;
  const slippage = CONFIG.COSTS.SLIPPAGE_PCT * 2;
  const fundingPeriods = Math.floor(holdBars / CONFIG.COSTS.FUNDING_INTERVAL_BARS);
  const funding = fundingPeriods * CONFIG.COSTS.FUNDING_RATE_PCT;
  
  // ❌ BUG: On multiplie TOUT par leverage
  const totalCostsPct = (tradingFees + slippage + funding) * leverage;
  const netPnlPct = grossPnlPct - totalCostsPct;
  
  const feesUsd = (totalCostsPct / 100) * marginUsd;
  const netPnlUsd = (netPnlPct / 100) * marginUsd;
  
  return { grossPnlPct, netPnlPct, netPnlUsd, feesUsd, totalCostsPct };
}

// MÉTHODE CORRECTE
function calculatePnlCorrect(entryPrice, exitPrice, side, marginUsd, leverage, holdBars) {
  const pricePct = side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  const grossPnlPct = pricePct * leverage;
  
  const notionalUsd = marginUsd * leverage;
  
  // ✅ Trading fees et slippage: appliqués sur notional, pas sur margin
  const tradingFeeUsd = notionalUsd * (CONFIG.COSTS.TRADING_FEE_PCT / 100) * 2;
  const slippageUsd = notionalUsd * (CONFIG.COSTS.SLIPPAGE_PCT / 100) * 2;
  
  // Funding: appliqué sur notional
  const fundingPeriods = Math.floor(holdBars / CONFIG.COSTS.FUNDING_INTERVAL_BARS);
  const fundingUsd = notionalUsd * (fundingPeriods * CONFIG.COSTS.FUNDING_RATE_PCT / 100);
  
  const totalFeesUsd = tradingFeeUsd + slippageUsd + fundingUsd;
  const totalCostsPct = (totalFeesUsd / marginUsd) * 100;
  
  const grossPnlUsd = (grossPnlPct / 100) * marginUsd;
  const netPnlUsd = grossPnlUsd - totalFeesUsd;
  const netPnlPct = (netPnlUsd / marginUsd) * 100;
  
  return { grossPnlPct, netPnlPct, netPnlUsd, feesUsd: totalFeesUsd, totalCostsPct };
}

console.log('═'.repeat(80));
console.log('DEBUG: COMPARAISON DES MÉTHODES DE CALCUL');
console.log('═'.repeat(80));

const marginUsd = 800;
const leverage = 4.5;
const notional = marginUsd * leverage;
const holdBars = 16; // 4 heures (pas de funding)

console.log(`\nParamètres:`);
console.log(`  Margin: $${marginUsd}`);
console.log(`  Leverage: ${leverage}x`);
console.log(`  Notional: $${notional}`);
console.log(`  Hold: ${holdBars} bars (${holdBars * 15 / 60}h)`);

// Test 1: TP à +3%
console.log('\n📈 TEST 1: LONG +3% TP');
const entry = 100;
const exitTP = 103;

const incorrectTP = calculatePnlIncorrect(entry, exitTP, 'long', marginUsd, leverage, holdBars);
const correctTP = calculatePnlCorrect(entry, exitTP, 'long', marginUsd, leverage, holdBars);

console.log('  MÉTHODE INCORRECTE (actuelle):');
console.log(`    Coûts %: ${incorrectTP.totalCostsPct.toFixed(3)}%`);
console.log(`    Fees USD: $${incorrectTP.feesUsd.toFixed(2)}`);
console.log(`    Net PnL USD: $${incorrectTP.netPnlUsd.toFixed(2)}`);
console.log('  MÉTHODE CORRECTE:');
console.log(`    Coûts %: ${correctTP.totalCostsPct.toFixed(3)}%`);
console.log(`    Fees USD: $${correctTP.feesUsd.toFixed(2)}`);
console.log(`    Net PnL USD: $${correctTP.netPnlUsd.toFixed(2)}`);

// Test 2: SL à -1.5%
console.log('\n📉 TEST 2: LONG -1.5% SL');
const exitSL = 98.5;

const incorrectSL = calculatePnlIncorrect(entry, exitSL, 'long', marginUsd, leverage, holdBars);
const correctSL = calculatePnlCorrect(entry, exitSL, 'long', marginUsd, leverage, holdBars);

console.log('  MÉTHODE INCORRECTE (actuelle):');
console.log(`    Coûts %: ${incorrectSL.totalCostsPct.toFixed(3)}%`);
console.log(`    Fees USD: $${incorrectSL.feesUsd.toFixed(2)}`);
console.log(`    Net PnL USD: $${incorrectSL.netPnlUsd.toFixed(2)}`);
console.log('  MÉTHODE CORRECTE:');
console.log(`    Coûts %: ${correctSL.totalCostsPct.toFixed(3)}%`);
console.log(`    Fees USD: $${correctSL.feesUsd.toFixed(2)}`);
console.log(`    Net PnL USD: $${correctSL.netPnlUsd.toFixed(2)}`);

// VÉRIFICATION RÉALITÉ BINANCE
console.log('\n💡 VÉRIFICATION CONTRE RÉALITÉ BINANCE:');
console.log('  Notional: $3600 (margin $800 × 4.5x)');
console.log('  Fee Binance: 0.04% × notional × 2 = 0.04% × $3600 × 2 = $2.88');
console.log('  Slippage estimé: 0.05% × notional × 2 = $3.60');
console.log('  TOTAL RÉEL: ~$6.48');
console.log(`\n  Méthode incorrecte calcule: $${incorrectTP.feesUsd.toFixed(2)} ❌`);
console.log(`  Méthode correcte calcule: $${correctTP.feesUsd.toFixed(2)} ✅`);

// DIFF IMPACT
console.log('\n📊 IMPACT SUR 100 TRADES:');
const diffPerTrade = incorrectTP.feesUsd - correctTP.feesUsd;
console.log(`  Surcharge par trade: $${diffPerTrade.toFixed(2)}`);
console.log(`  Sur 100 trades: $${(diffPerTrade * 100).toFixed(2)} de perte fantôme!`);
console.log(`  Sur 300 trades: $${(diffPerTrade * 300).toFixed(2)} de perte fantôme!`);
