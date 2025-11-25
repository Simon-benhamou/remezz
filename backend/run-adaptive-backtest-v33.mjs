/**
 * BACKTEST V33 - STRONG TREND SIGNAL
 * Signal: 3 timeframes alignés (1 bougie, 4 bougies, 12 bougies) + Volume > 1.2x
 * Objectif: 4/4 mois positifs
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
const RISK_PER_TRADE = 0.01; // 1% risk
const TP_PERCENT = 0.01;    // 1% TP
const SL_PERCENT = 0.01;    // 1% SL (R:R = 1:1)

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

function detectStrongTrendSignal(candles, i) {
  if (i < 15) return null;
  
  const vol = candles[i][5];
  const avgVol = candles.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
  
  // 3 timeframes
  const close = candles[i][4];
  const close4 = candles[i-4][4];
  const close12 = candles[i-12][4];
  
  const trend1 = close > candles[i-1][4] ? 'UP' : 'DOWN';
  const trend4 = close > close4 ? 'UP' : 'DOWN';
  const trend12 = close > close12 ? 'UP' : 'DOWN';
  
  // All 3 timeframes must align + volume confirmation
  if (trend1 === 'UP' && trend4 === 'UP' && trend12 === 'UP' && vol > avgVol * 1.2) {
    return 'LONG';
  }
  if (trend1 === 'DOWN' && trend4 === 'DOWN' && trend12 === 'DOWN' && vol > avgVol * 1.2) {
    return 'SHORT';
  }
  
  return null;
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🚀 BACKTEST V33 - STRONG TREND (3 Timeframes Align)');
  console.log('═'.repeat(80));
  console.log(`📊 Capital initial: $${INITIAL_CAPITAL}`);
  console.log(`📊 Risque par trade: ${RISK_PER_TRADE * 100}%`);
  console.log(`📊 TP/SL: ${TP_PERCENT * 100}% / ${SL_PERCENT * 100}%`);
  
  // Fetch data
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`\n📥 Fetching ${symbol}...`);
    allCandles[symbol] = await fetchAllCandles(symbol);
    console.log(`   ✅ Got ${allCandles[symbol].length} candles`);
  }
  
  const firstDate = new Date(Object.values(allCandles)[0][0][0]);
  const lastDate = new Date(Object.values(allCandles)[0].slice(-1)[0][0]);
  console.log(`\n📅 Période: ${firstDate.toISOString().split('T')[0]} → ${lastDate.toISOString().split('T')[0]}`);
  
  // Collect all signals first
  const allSignals = [];
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 60; i < candles.length - 30; i++) {
      const direction = detectStrongTrendSignal(candles, i);
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
  
  // Sort by timestamp
  allSignals.sort((a, b) => a.timestamp - b.timestamp);
  
  console.log(`\n📊 Total signaux détectés: ${allSignals.length}`);
  
  // Simulate with proper capital management
  let capital = INITIAL_CAPITAL;
  const trades = [];
  const monthlyPnL = {};
  let openPositions = {};
  
  // Process signals chronologically
  for (const signal of allSignals) {
    // Check if we already have position on this symbol
    if (openPositions[signal.symbol]) continue;
    
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
    
    // Simulate trade outcome
    const candles = signal.candles;
    let outcome = null;
    let exitPrice = null;
    let exitTime = null;
    
    for (let j = signal.candleIndex + 1; j < Math.min(signal.candleIndex + 30, candles.length); j++) {
      const high = candles[j][2];
      const low = candles[j][3];
      
      if (signal.direction === 'LONG') {
        if (high >= tp) { 
          outcome = 'WIN'; 
          exitPrice = tp;
          exitTime = candles[j][0];
          break; 
        }
        if (low <= sl) { 
          outcome = 'LOSS'; 
          exitPrice = sl;
          exitTime = candles[j][0];
          break; 
        }
      } else {
        if (low <= tp) { 
          outcome = 'WIN'; 
          exitPrice = tp;
          exitTime = candles[j][0];
          break; 
        }
        if (high >= sl) { 
          outcome = 'LOSS'; 
          exitPrice = sl;
          exitTime = candles[j][0];
          break; 
        }
      }
    }
    
    if (!outcome) continue; // Skip timeout trades
    
    // Calculate PnL
    const pnlPercent = outcome === 'WIN' ? TP_PERCENT : -SL_PERCENT;
    const pnlAmount = positionSize * stopDistance * (outcome === 'WIN' ? 1 : -1);
    
    capital += pnlAmount;
    
    const date = new Date(signal.timestamp);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    if (!monthlyPnL[monthKey]) {
      monthlyPnL[monthKey] = { 
        wins: 0, 
        losses: 0, 
        pnlAmount: 0, 
        startCapital: capital - pnlAmount 
      };
    }
    
    if (outcome === 'WIN') {
      monthlyPnL[monthKey].wins++;
    } else {
      monthlyPnL[monthKey].losses++;
    }
    monthlyPnL[monthKey].pnlAmount += pnlAmount;
    
    trades.push({
      symbol: signal.symbol,
      direction: signal.direction,
      entry,
      exit: exitPrice,
      outcome,
      pnlAmount,
      pnlPercent,
      date: date.toISOString(),
      monthKey
    });
  }
  
  // Results
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS DU BACKTEST V33');
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
  
  // Monthly breakdown
  console.log('\n' + '─'.repeat(80));
  console.log('📅 PERFORMANCE MENSUELLE:');
  console.log('─'.repeat(80));
  
  const months = Object.keys(monthlyPnL).sort();
  let positiveMonths = 0;
  
  console.log('\n┌────────────┬─────────┬───────────┬──────────────┬──────────────┬──────────┐');
  console.log('│    Mois    │ Trades  │  Win Rate │    P&L $     │    P&L %     │  Status  │');
  console.log('├────────────┼─────────┼───────────┼──────────────┼──────────────┼──────────┤');
  
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
  
  // Final verdict
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 VERDICT FINAL:');
  console.log('═'.repeat(80));
  
  const allPositive = positiveMonths === months.length;
  
  if (allPositive) {
    console.log(`\n🏆 OBJECTIF ATTEINT: ${positiveMonths}/${months.length} mois positifs!`);
    console.log(`   ✅ Chaque mois est individuellement rentable`);
  } else {
    console.log(`\n⚠️  ${positiveMonths}/${months.length} mois positifs`);
    console.log(`   ❌ Objectif 4/4 non atteint`);
  }
  
  // Trade distribution by symbol
  console.log('\n' + '─'.repeat(80));
  console.log('📊 Distribution par symbol:');
  console.log('─'.repeat(80));
  
  const bySymbol = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { wins: 0, losses: 0, pnl: 0 };
    if (t.outcome === 'WIN') bySymbol[t.symbol].wins++;
    else bySymbol[t.symbol].losses++;
    bySymbol[t.symbol].pnl += t.pnlAmount;
  }
  
  for (const [sym, stats] of Object.entries(bySymbol)) {
    const total = stats.wins + stats.losses;
    const wr = (stats.wins / total * 100).toFixed(1);
    console.log(`   ${sym}: ${total} trades, ${wr}% WR, ${stats.pnl >= 0 ? '+' : ''}$${stats.pnl.toFixed(2)}`);
  }
}

main().catch(console.error);
