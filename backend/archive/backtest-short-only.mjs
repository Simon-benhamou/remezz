/**
 * 🐻 BEAR MARKET SHORT STRATEGY
 * 
 * The last year was a BEAR MARKET (-9% BTC, -43% SOL)
 * Let's see if we can capture those moves by SHORTING
 * 
 * Strategy: SHORT-only with trend confirmation
 * - Only SHORT (never long)
 * - When price below 50 EMA (bearish trend)
 * - When BTC also bearish (correlation)
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const INITIAL_CAPITAL = 10000;
const TIMEFRAME = '4h'; // 4H for more conviction

// Realistic fees
const FEES = {
  maker: 0.0004,
  taker: 0.0006,
  slippage: 0.0002
};

const LEVERAGE = {
  BTC: 3,
  ETH: 5,
  SOL: 7
};

async function fetchCandles(symbol, days = 365) {
  try {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const all = [];
    let fetchSince = since;
    
    while (fetchSince < Date.now()) {
      const candles = await exchange.fetchOHLCV(symbol, TIMEFRAME, fetchSince, 500);
      if (candles.length === 0) break;
      all.push(...candles);
      fetchSince = candles[candles.length - 1][0] + 1;
      if (candles.length < 500) break;
    }
    
    return all;
  } catch (e) {
    console.error(`Error fetching ${symbol}:`, e.message);
    return [];
  }
}

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data[0];
  const result = [ema];
  
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
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

async function backtestShortOnly(symbol, btcData) {
  const candles = await fetchCandles(symbol, 365);
  if (candles.length < 100) return null;
  
  const asset = symbol.split('/')[0];
  const leverage = LEVERAGE[asset] || 5;
  const closes = candles.map(c => c[4]);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  
  // Get BTC closes for correlation
  const btcCloses = btcData.map(c => c[4]);
  const btcEma50 = calcEMA(btcCloses, 50);
  
  const trades = [];
  let inPosition = false;
  let entryPrice = 0;
  let entryTime = 0;
  
  // Align timestamps
  const btcTimeMap = new Map();
  btcData.forEach((c, i) => btcTimeMap.set(c[0], { close: c[4], ema50: btcEma50[i] }));
  
  for (let i = 200; i < candles.length - 1; i++) {
    const ts = candles[i][0];
    const close = closes[i];
    const ema50Val = ema50[i];
    const ema200Val = ema200[i];
    const rsi = calcRSI(closes.slice(0, i + 1), 14);
    
    // Get BTC data for same timestamp
    const btc = btcTimeMap.get(ts);
    const btcBearish = btc ? btc.close < btc.ema50 : false;
    
    if (!inPosition) {
      // SHORT conditions:
      // 1. Price below EMA50 (short-term bearish)
      // 2. EMA50 below EMA200 (long-term bearish)
      // 3. RSI not oversold (room to fall)
      // 4. BTC also bearish (correlation)
      const shortTermBearish = close < ema50Val;
      const longTermBearish = ema50Val < ema200Val;
      const notOversold = rsi > 30;
      
      if (shortTermBearish && longTermBearish && notOversold && btcBearish) {
        inPosition = true;
        entryPrice = close;
        entryTime = ts;
      }
    } else {
      // Exit conditions:
      // 1. Take profit: 3% gain (price dropped 3%)
      // 2. Stop loss: 2% loss (price went up 2%)
      // 3. RSI oversold (bounce likely)
      // 4. Price crosses above EMA50 (trend change)
      
      const pnlPercent = ((entryPrice - close) / entryPrice) * 100;
      const priceAboveEma = close > ema50Val;
      const oversold = rsi < 30;
      
      if (pnlPercent >= 3 || pnlPercent <= -2 || oversold || priceAboveEma) {
        // Close SHORT
        const entryFees = entryPrice * (FEES.taker + FEES.slippage);
        const exitFees = close * (FEES.taker + FEES.slippage);
        const totalFees = entryFees + exitFees;
        const netPnlPercent = pnlPercent - (totalFees / entryPrice * 100);
        
        trades.push({
          entryTime,
          exitTime: ts,
          entryPrice,
          exitPrice: close,
          pnlPercent: netPnlPercent,
          leverage,
          pnlWithLeverage: netPnlPercent * leverage
        });
        
        inPosition = false;
      }
    }
  }
  
  return trades;
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🐻 BEAR MARKET SHORT-ONLY STRATEGY');
  console.log('═'.repeat(80));
  console.log(`\n💰 Starting Capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log('📅 Period: Last 365 days (BEAR MARKET)');
  console.log('🎯 Strategy: SHORT-only when trend is bearish\n');
  
  // Fetch BTC first (for correlation)
  console.log('📥 Fetching data...');
  const btcData = await fetchCandles('BTC/USDT', 365);
  console.log(`   BTC: ${btcData.length} candles (4H)`);
  
  const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
  const allTrades = [];
  const bySymbol = {};
  
  for (const symbol of symbols) {
    const trades = symbol === 'BTC/USDT' 
      ? await backtestShortOnlySimple('BTC/USDT', btcData, btcData)
      : await backtestShortOnlySimple(symbol, btcData);
      
    if (trades && trades.length > 0) {
      bySymbol[symbol] = trades;
      allTrades.push(...trades.map(t => ({ ...t, symbol })));
      console.log(`   ${symbol}: ${trades.length} trades`);
    }
  }
  
  // Results
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RESULTS BY SYMBOL');
  console.log('═'.repeat(80));
  
  let totalPnl = 0;
  let totalPnlLev = 0;
  let totalFees = 0;
  let totalWins = 0;
  let totalTrades = 0;
  
  for (const [symbol, trades] of Object.entries(bySymbol)) {
    const wins = trades.filter(t => t.pnlPercent > 0).length;
    const wr = (wins / trades.length * 100).toFixed(1);
    const sumPnl = trades.reduce((a, t) => a + t.pnlPercent, 0);
    const sumPnlLev = trades.reduce((a, t) => a + t.pnlWithLeverage, 0);
    
    console.log(`\n📉 ${symbol}:`);
    console.log(`   Trades: ${trades.length} | Win Rate: ${wr}%`);
    console.log(`   P&L (no leverage): ${sumPnl >= 0 ? '+' : ''}${sumPnl.toFixed(2)}%`);
    console.log(`   P&L (with leverage): ${sumPnlLev >= 0 ? '+' : ''}${sumPnlLev.toFixed(2)}%`);
    
    totalPnl += sumPnl;
    totalPnlLev += sumPnlLev;
    totalWins += wins;
    totalTrades += trades.length;
  }
  
  // Final results
  console.log('\n' + '═'.repeat(80));
  console.log('📈 OVERALL RESULTS');
  console.log('═'.repeat(80));
  
  const overallWR = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : 0;
  const finalValueNoLev = INITIAL_CAPITAL * (1 + totalPnl / 100);
  const finalValueWithLev = INITIAL_CAPITAL * (1 + totalPnlLev / 100);
  
  console.log(`\n🎯 Total Trades: ${totalTrades}`);
  console.log(`✅ Win Rate: ${overallWR}%`);
  console.log(`\n💵 WITHOUT LEVERAGE:`);
  console.log(`   ROI: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%`);
  console.log(`   $${INITIAL_CAPITAL.toLocaleString()} → $${finalValueNoLev.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`);
  console.log(`\n🚀 WITH LEVERAGE:`);
  console.log(`   ROI: ${totalPnlLev >= 0 ? '+' : ''}${totalPnlLev.toFixed(2)}%`);
  console.log(`   $${INITIAL_CAPITAL.toLocaleString()} → $${finalValueWithLev.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`);
  
  // Compare to HODL
  console.log('\n' + '═'.repeat(80));
  console.log('📊 COMPARISON');
  console.log('═'.repeat(80));
  console.log('\n┌──────────────────────────┬──────────────┬─────────────────┐');
  console.log('│ Strategy                 │     ROI      │  Final Value    │');
  console.log('├──────────────────────────┼──────────────┼─────────────────┤');
  console.log(`│ SHORT Strategy (w/lev)   │ ${(totalPnlLev >= 0 ? '+' : '') + totalPnlLev.toFixed(1) + '%'}`.padEnd(27) + `│ $${finalValueWithLev.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`.padEnd(18) + '│');
  console.log('│ BTC Hold (LOST -9.3%)    │       -9.3%  │          $9,073 │');
  console.log('│ ETH Hold (LOST -20.3%)   │      -20.3%  │          $7,968 │');
  console.log('│ SOL Hold (LOST -43.5%)   │      -43.5%  │          $5,652 │');
  console.log('└──────────────────────────┴──────────────┴─────────────────┘');
  
  // Monthly breakdown
  console.log('\n📅 Monthly P&L:');
  const byMonth = {};
  for (const t of allTrades) {
    const month = new Date(t.exitTime).toISOString().slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { pnl: 0, trades: 0 };
    byMonth[month].pnl += t.pnlWithLeverage;
    byMonth[month].trades++;
  }
  
  const positiveMonths = Object.values(byMonth).filter(m => m.pnl > 0).length;
  const totalMonths = Object.keys(byMonth).length;
  
  for (const [month, data] of Object.entries(byMonth).sort()) {
    const bar = data.pnl > 0 ? '█'.repeat(Math.min(Math.round(data.pnl / 2), 30)) : '░'.repeat(Math.min(Math.round(Math.abs(data.pnl) / 2), 30));
    const color = data.pnl > 0 ? '+' : '';
    console.log(`   ${month}: ${color}${data.pnl.toFixed(1)}% (${data.trades} trades) ${data.pnl > 0 ? '🟢' : '🔴'} ${bar}`);
  }
  
  console.log(`\n   Positive months: ${positiveMonths}/${totalMonths} (${(positiveMonths/totalMonths*100).toFixed(0)}%)`);
}

// Simplified backtest function
async function backtestShortOnlySimple(symbol, btcData, existingData = null) {
  const candles = existingData || await fetchCandles(symbol, 365);
  if (candles.length < 100) return [];
  
  const asset = symbol.split('/')[0];
  const leverage = LEVERAGE[asset] || 5;
  const closes = candles.map(c => c[4]);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  
  // Get BTC EMA50
  const btcCloses = btcData.map(c => c[4]);
  const btcEma50 = calcEMA(btcCloses, 50);
  const btcTimeMap = new Map();
  btcData.forEach((c, i) => btcTimeMap.set(c[0], { close: c[4], ema50: btcEma50[i] }));
  
  const trades = [];
  let inPosition = false;
  let entryPrice = 0;
  let entryTime = 0;
  
  for (let i = 200; i < candles.length - 1; i++) {
    const ts = candles[i][0];
    const close = closes[i];
    const ema50Val = ema50[i];
    const ema200Val = ema200[i];
    const rsi = calcRSI(closes.slice(0, i + 1), 14);
    
    // BTC correlation
    const btc = btcTimeMap.get(ts);
    const btcBearish = btc ? btc.close < btc.ema50 : true;
    
    if (!inPosition) {
      // SHORT entry
      const shortTermBearish = close < ema50Val;
      const longTermBearish = ema50Val < ema200Val;
      const notOversold = rsi > 35;
      
      if (shortTermBearish && longTermBearish && notOversold && btcBearish) {
        inPosition = true;
        entryPrice = close;
        entryTime = ts;
      }
    } else {
      // SHORT exit
      const pnlPercent = ((entryPrice - close) / entryPrice) * 100;
      const priceAboveEma = close > ema50Val;
      const oversold = rsi < 30;
      
      if (pnlPercent >= 3 || pnlPercent <= -2 || oversold || priceAboveEma) {
        const entryFees = entryPrice * (FEES.taker + FEES.slippage);
        const exitFees = close * (FEES.taker + FEES.slippage);
        const totalFees = entryFees + exitFees;
        const netPnlPercent = pnlPercent - (totalFees / entryPrice * 100);
        
        trades.push({
          entryTime,
          exitTime: ts,
          entryPrice,
          exitPrice: close,
          pnlPercent: netPnlPercent,
          leverage,
          pnlWithLeverage: netPnlPercent * leverage
        });
        
        inPosition = false;
      }
    }
  }
  
  return trades;
}

main().catch(console.error);
