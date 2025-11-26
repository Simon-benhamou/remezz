/**
 * 🤔 REALITY CHECK - Is momentum trading even viable?
 * 
 * Let's compare:
 * 1. Buy & Hold BTC for 1 year
 * 2. Buy & Hold ETH for 1 year
 * 3. DCA (monthly buys)
 * 4. "Smart" DCA (buy only when RSI < 40)
 * 5. Our best trading strategy
 * 
 * This will tell us if we're overcomplicating things
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const INITIAL_CAPITAL = 10000;
const TIMEFRAME = '1d'; // Daily for this analysis
const DAYS = 365;

async function fetchDailyCandles(symbol) {
  try {
    const candles = await exchange.fetchOHLCV(symbol, TIMEFRAME, Date.now() - DAYS * 24 * 60 * 60 * 1000, 400);
    return candles;
  } catch (e) {
    console.error(`Error fetching ${symbol}:`, e.message);
    return [];
  }
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  const recentChanges = changes.slice(-period);
  const gains = recentChanges.filter(c => c > 0);
  const losses = recentChanges.filter(c => c < 0).map(c => Math.abs(c));
  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🤔 REALITY CHECK - Trading vs Holding');
  console.log('═'.repeat(80));
  console.log(`\n💰 Starting Capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log(`📅 Period: Last ${DAYS} days\n`);
  
  // Fetch daily data
  console.log('📥 Fetching daily data...');
  const btcCandles = await fetchDailyCandles('BTC/USDT');
  const ethCandles = await fetchDailyCandles('ETH/USDT');
  const solCandles = await fetchDailyCandles('SOL/USDT');
  
  console.log(`   BTC: ${btcCandles.length} days`);
  console.log(`   ETH: ${ethCandles.length} days`);
  console.log(`   SOL: ${solCandles.length} days`);
  
  if (btcCandles.length < 30) {
    console.log('❌ Not enough data');
    return;
  }
  
  const startDate = new Date(btcCandles[0][0]).toISOString().split('T')[0];
  const endDate = new Date(btcCandles[btcCandles.length - 1][0]).toISOString().split('T')[0];
  
  console.log(`\n📆 Period: ${startDate} to ${endDate}`);
  
  // 1. BUY & HOLD
  console.log('\n' + '═'.repeat(80));
  console.log('📊 STRATEGY COMPARISON');
  console.log('═'.repeat(80));
  
  const results = [];
  
  // BTC Buy & Hold
  const btcStart = btcCandles[0][4];
  const btcEnd = btcCandles[btcCandles.length - 1][4];
  const btcReturn = ((btcEnd - btcStart) / btcStart) * 100;
  const btcFinalValue = INITIAL_CAPITAL * (1 + btcReturn / 100);
  results.push({ name: '1. BTC Buy & Hold', roi: btcReturn, finalValue: btcFinalValue, trades: 1 });
  
  // ETH Buy & Hold
  const ethStart = ethCandles[0][4];
  const ethEnd = ethCandles[ethCandles.length - 1][4];
  const ethReturn = ((ethEnd - ethStart) / ethStart) * 100;
  const ethFinalValue = INITIAL_CAPITAL * (1 + ethReturn / 100);
  results.push({ name: '2. ETH Buy & Hold', roi: ethReturn, finalValue: ethFinalValue, trades: 1 });
  
  // SOL Buy & Hold
  const solStart = solCandles[0][4];
  const solEnd = solCandles[solCandles.length - 1][4];
  const solReturn = ((solEnd - solStart) / solStart) * 100;
  const solFinalValue = INITIAL_CAPITAL * (1 + solReturn / 100);
  results.push({ name: '3. SOL Buy & Hold', roi: solReturn, finalValue: solFinalValue, trades: 1 });
  
  // 50/50 BTC/ETH
  const mixedReturn = (btcReturn + ethReturn) / 2;
  const mixedFinalValue = INITIAL_CAPITAL * (1 + mixedReturn / 100);
  results.push({ name: '4. 50% BTC + 50% ETH', roi: mixedReturn, finalValue: mixedFinalValue, trades: 1 });
  
  // DCA Monthly (simple)
  let dcaUnits = 0;
  let dcaInvested = 0;
  const monthlyInvestment = INITIAL_CAPITAL / 12;
  
  for (let i = 0; i < btcCandles.length; i += 30) { // Every ~30 days
    if (dcaInvested < INITIAL_CAPITAL) {
      const price = btcCandles[i][4];
      dcaUnits += monthlyInvestment / price;
      dcaInvested += monthlyInvestment;
    }
  }
  const dcaFinalValue = dcaUnits * btcEnd;
  const dcaReturn = ((dcaFinalValue - dcaInvested) / dcaInvested) * 100;
  results.push({ name: '5. DCA Monthly (BTC)', roi: dcaReturn, finalValue: dcaFinalValue, trades: 12 });
  
  // Smart DCA - Buy only when RSI < 40
  let smartDcaUnits = 0;
  let smartDcaInvested = 0;
  let smartDcaTrades = 0;
  const btcCloses = btcCandles.map(c => c[4]);
  
  for (let i = 20; i < btcCandles.length; i++) {
    const rsi = calcRSI(btcCloses.slice(0, i + 1), 14);
    
    // Buy when RSI < 40 (oversold)
    if (rsi < 40 && smartDcaInvested < INITIAL_CAPITAL) {
      const price = btcCandles[i][4];
      const investment = Math.min(INITIAL_CAPITAL * 0.1, INITIAL_CAPITAL - smartDcaInvested); // 10% per buy
      smartDcaUnits += investment / price;
      smartDcaInvested += investment;
      smartDcaTrades++;
    }
  }
  
  // If didn't invest everything, invest remaining at end
  if (smartDcaInvested < INITIAL_CAPITAL) {
    const remaining = INITIAL_CAPITAL - smartDcaInvested;
    smartDcaUnits += remaining / btcEnd;
    smartDcaInvested += remaining;
    smartDcaTrades++;
  }
  
  const smartDcaFinalValue = smartDcaUnits * btcEnd;
  const smartDcaReturn = ((smartDcaFinalValue - smartDcaInvested) / smartDcaInvested) * 100;
  results.push({ name: '6. Smart DCA (RSI<40)', roi: smartDcaReturn, finalValue: smartDcaFinalValue, trades: smartDcaTrades });
  
  // Our "best" trading strategy (from previous tests)
  // ~5% ROI with leverage, ~1% without
  results.push({ name: '7. Momentum Trading (no lev)', roi: 1.1, finalValue: INITIAL_CAPITAL * 1.011, trades: 299 });
  results.push({ name: '8. Momentum Trading (w/ lev)', roi: 5.1, finalValue: INITIAL_CAPITAL * 1.051, trades: 299 });
  
  // Display results
  console.log('\n┌────────────────────────────────┬────────────────┬─────────────────┬──────────┐');
  console.log('│         Strategy               │      ROI       │  Final Value    │  Trades  │');
  console.log('├────────────────────────────────┼────────────────┼─────────────────┼──────────┤');
  
  results.sort((a, b) => b.roi - a.roi);
  
  for (const r of results) {
    const roiStr = r.roi >= 0 ? `+${r.roi.toFixed(1)}%` : `${r.roi.toFixed(1)}%`;
    const valueStr = `$${r.finalValue.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
    console.log(`│ ${r.name.padEnd(30)} │ ${roiStr.padStart(14)} │ ${valueStr.padStart(15)} │ ${String(r.trades).padStart(8)} │`);
  }
  
  console.log('└────────────────────────────────┴────────────────┴─────────────────┴──────────┘');
  
  // Price chart summary
  console.log('\n📈 Price Changes:');
  console.log(`   BTC: $${btcStart.toFixed(0)} → $${btcEnd.toFixed(0)} (${btcReturn >= 0 ? '+' : ''}${btcReturn.toFixed(1)}%)`);
  console.log(`   ETH: $${ethStart.toFixed(0)} → $${ethEnd.toFixed(0)} (${ethReturn >= 0 ? '+' : ''}${ethReturn.toFixed(1)}%)`);
  console.log(`   SOL: $${solStart.toFixed(0)} → $${solEnd.toFixed(0)} (${solReturn >= 0 ? '+' : ''}${solReturn.toFixed(1)}%)`);
  
  // Conclusion
  console.log('\n' + '═'.repeat(80));
  console.log('💡 CONCLUSION');
  console.log('═'.repeat(80));
  
  const bestStrategy = results[0];
  const tradingWithLev = results.find(r => r.name.includes('w/ lev'));
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🏆 BEST STRATEGY: ${bestStrategy.name.padEnd(50)}     ║
║    ROI: ${bestStrategy.roi >= 0 ? '+' : ''}${bestStrategy.roi.toFixed(1)}%  →  $${INITIAL_CAPITAL.toLocaleString()} becomes $${bestStrategy.finalValue.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${' '.repeat(24)}║
║                                                                               ║
║ 📊 KEY INSIGHT:                                                               ║
║    ${btcReturn > 5 ? '✅ Bull market → BUY & HOLD beats active trading!' : btcReturn < -5 ? '❌ Bear market → Maybe shorting could work?' : '➡️ Sideways market → Trading MAY add value'}${' '.repeat(24)}║
║                                                                               ║
║ 🎯 REALISTIC EXPECTATIONS:                                                    ║
║    • Momentum trading with fees: ~${tradingWithLev ? tradingWithLev.roi.toFixed(1) : '5'}% annual ROI (with leverage)       ║
║    • Simple Buy & Hold: ${btcReturn >= 0 ? '+' : ''}${btcReturn.toFixed(1)}% for BTC this year                           ║
║    • Difference: ${(btcReturn - (tradingWithLev ? tradingWithLev.roi : 5)).toFixed(1)}% ${btcReturn > (tradingWithLev ? tradingWithLev.roi : 5) ? '(HODL wins!)' : '(Trading wins!)'}                                      ║
║                                                                               ║
║ 💡 THE TRUTH:                                                                 ║
║    In bull markets → JUST HODL                                                ║
║    In bear markets → MAYBE short (but fees kill you)                          ║
║    In sideways → Neither works well                                           ║
║                                                                               ║
║    Active trading mainly benefits EXCHANGES (fees) not traders.               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);

  // What actually works
  console.log('\n🎯 WHAT ACTUALLY WORKS:');
  console.log(`
1. MACRO TIMING (not micro timing):
   • Buy during fear (RSI < 30, big dumps)
   • Hold through volatility
   • Sell during euphoria (RSI > 80, parabolic moves)
   
2. POSITION SIZING > ENTRY TIMING:
   • Put more in during crashes
   • Reduce exposure at ATH
   
3. SIMPLICITY:
   • DCA into BTC/ETH
   • Hold for 2-4 year cycles
   • Don't trade, just accumulate

4. IF YOU MUST TRADE:
   • Only take EXTREME setups (RSI < 25 or > 75)
   • Max 1-2 trades per month
   • Use leverage sparingly
   • Accept that fees will eat 20-30% of gains
`);
}

main().catch(console.error);
