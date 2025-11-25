/**
 * BACKTEST V34 - MOMENTUM + VOLUME SIGNAL
 * Signal: SMA alignment (close > SMA10 > SMA20) + Volume > 1.3x
 * Alternative avec moins de trades
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];
const TIMEFRAME = '15m';
const DAYS = 120;
const CANDLES_PER_DAY = 96;
const TOTAL_CANDLES = DAYS * CANDLES_PER_DAY;

const INITIAL_CAPITAL = 10000;
const RISK_PER_TRADE = 0.01;
const TP_PERCENT = 0.01;
const SL_PERCENT = 0.01;

async function fetchAllCandles(symbol) {
  const allCandles = [];
  const now = Date.now();
  const candleDuration = 15 * 60 * 1000;
  let since = now - TOTAL_CANDLES * candleDuration;
  
  while (allCandles.length < TOTAL_CANDLES) {
    const candles = await exchange.fetchOHLCV(symbol, TIMEFRAME, since, 1000);
    if (candles.length === 0) break;
    allCandles.push(...candles);
    since = candles[candles.length - 1][0] + candleDuration;
    await new Promise(r => setTimeout(r, 50));
  }
  
  return allCandles.slice(-TOTAL_CANDLES);
}

function detectMomentumVolumeSignal(candles, i) {
  if (i < 25) return null;
  
  const vol = candles[i][5];
  const avgVol = candles.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
  if (vol < avgVol * 1.3) return null;
  
  const close = candles[i][4];
  const sma10 = candles.slice(i-10, i).reduce((s, x) => s + x[4], 0) / 10;
  const sma20 = candles.slice(i-20, i).reduce((s, x) => s + x[4], 0) / 20;
  
  // Trend alignment
  if (close > sma10 && sma10 > sma20) return 'LONG';
  if (close < sma10 && sma10 < sma20) return 'SHORT';
  
  return null;
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🚀 BACKTEST V34 - MOMENTUM + VOLUME (SMA Alignment)');
  console.log('═'.repeat(80));
  console.log(`📊 Capital initial: $${INITIAL_CAPITAL}`);
  console.log(`📊 Risque par trade: ${RISK_PER_TRADE * 100}%`);
  console.log(`📊 TP/SL: ${TP_PERCENT * 100}% / ${SL_PERCENT * 100}%`);
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`\n📥 Fetching ${symbol}...`);
    allCandles[symbol] = await fetchAllCandles(symbol);
    console.log(`   ✅ Got ${allCandles[symbol].length} candles`);
  }
  
  const firstDate = new Date(Object.values(allCandles)[0][0][0]);
  const lastDate = new Date(Object.values(allCandles)[0].slice(-1)[0][0]);
  console.log(`\n📅 Période: ${firstDate.toISOString().split('T')[0]} → ${lastDate.toISOString().split('T')[0]}`);
  
  const allSignals = [];
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 60; i < candles.length - 30; i++) {
      const direction = detectMomentumVolumeSignal(candles, i);
      if (!direction) continue;
      
      allSignals.push({
        symbol,
        candleIndex: i,
        timestamp: candles[i][0],
        direction,
        entry: candles[i][4],
        candles
      });
    }
  }
  
  allSignals.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`\n📊 Total signaux: ${allSignals.length}`);
  
  let capital = INITIAL_CAPITAL;
  const trades = [];
  const monthlyPnL = {};
  
  for (const signal of allSignals) {
    const entry = signal.entry;
    const riskAmount = capital * RISK_PER_TRADE;
    const stopDistance = entry * SL_PERCENT;
    const positionSize = riskAmount / stopDistance;
    
    const tp = signal.direction === 'LONG' 
      ? entry * (1 + TP_PERCENT) 
      : entry * (1 - TP_PERCENT);
    const sl = signal.direction === 'LONG' 
      ? entry * (1 - SL_PERCENT) 
      : entry * (1 + SL_PERCENT);
    
    const candles = signal.candles;
    let outcome = null;
    
    for (let j = signal.candleIndex + 1; j < Math.min(signal.candleIndex + 30, candles.length); j++) {
      const high = candles[j][2];
      const low = candles[j][3];
      
      if (signal.direction === 'LONG') {
        if (high >= tp) { outcome = 'WIN'; break; }
        if (low <= sl) { outcome = 'LOSS'; break; }
      } else {
        if (low <= tp) { outcome = 'WIN'; break; }
        if (high >= sl) { outcome = 'LOSS'; break; }
      }
    }
    
    if (!outcome) continue;
    
    const pnlAmount = positionSize * stopDistance * (outcome === 'WIN' ? 1 : -1);
    capital += pnlAmount;
    
    const date = new Date(signal.timestamp);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    if (!monthlyPnL[monthKey]) {
      monthlyPnL[monthKey] = { wins: 0, losses: 0, pnlAmount: 0, startCapital: capital - pnlAmount };
    }
    
    if (outcome === 'WIN') monthlyPnL[monthKey].wins++;
    else monthlyPnL[monthKey].losses++;
    monthlyPnL[monthKey].pnlAmount += pnlAmount;
    
    trades.push({ symbol: signal.symbol, direction: signal.direction, outcome, pnlAmount, monthKey });
  }
  
  // Results
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS DU BACKTEST V34');
  console.log('═'.repeat(80));
  
  const totalTrades = trades.length;
  const wins = trades.filter(t => t.outcome === 'WIN').length;
  const losses = trades.filter(t => t.outcome === 'LOSS').length;
  const winRate = (wins / totalTrades * 100).toFixed(1);
  const totalPnL = capital - INITIAL_CAPITAL;
  const totalPnLPercent = (totalPnL / INITIAL_CAPITAL * 100).toFixed(2);
  
  console.log(`\n📈 Performance globale:`);
  console.log(`   Trades: ${totalTrades} (${wins}W / ${losses}L)`);
  console.log(`   Win Rate: ${winRate}%`);
  console.log(`   Capital final: $${capital.toFixed(2)}`);
  console.log(`   P&L total: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)} (${totalPnL >= 0 ? '+' : ''}${totalPnLPercent}%)`);
  
  console.log('\n┌────────────┬─────────┬───────────┬──────────────┬──────────────┬──────────┐');
  console.log('│    Mois    │ Trades  │  Win Rate │    P&L $     │    P&L %     │  Status  │');
  console.log('├────────────┼─────────┼───────────┼──────────────┼──────────────┼──────────┤');
  
  const months = Object.keys(monthlyPnL).sort();
  let positiveMonths = 0;
  
  for (const month of months) {
    const m = monthlyPnL[month];
    const total = m.wins + m.losses;
    const wr = (m.wins / total * 100).toFixed(1);
    const pnlPct = (m.pnlAmount / m.startCapital * 100).toFixed(2);
    const status = m.pnlAmount >= 0 ? '✅' : '❌';
    
    if (m.pnlAmount >= 0) positiveMonths++;
    
    console.log(`│ ${month}   │   ${String(total).padStart(4)}  │   ${wr.padStart(5)}%  │ ${(m.pnlAmount >= 0 ? '+' : '') + m.pnlAmount.toFixed(2).padStart(10)}$ │ ${(m.pnlAmount >= 0 ? '+' : '') + pnlPct.padStart(10)}% │    ${status}    │`);
  }
  
  console.log('└────────────┴─────────┴───────────┴──────────────┴──────────────┴──────────┘');
  
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 VERDICT FINAL:');
  console.log('═'.repeat(80));
  
  if (positiveMonths === months.length) {
    console.log(`\n🏆 OBJECTIF ATTEINT: ${positiveMonths}/${months.length} mois positifs!`);
  } else {
    console.log(`\n⚠️  ${positiveMonths}/${months.length} mois positifs`);
  }
}

main().catch(console.error);
