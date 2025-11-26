/**
 * 🚀 LONG-ONLY TREND FOLLOWING
 * 
 * Key insight from previous test:
 * - LONG trades: +63.6% ✅
 * - SHORT trades: -697.7% ❌
 * 
 * SHORT positions get destroyed by crypto volatility.
 * Let's test LONG-ONLY with better risk management.
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const INITIAL_CAPITAL = 10000;

// Realistic fees
const FEES = {
  maker: 0.0004,
  taker: 0.0006,
  slippage: 0.0002,
  total: function() { return this.taker + this.slippage; }
};

const LEVERAGE = {
  BTC: 3,
  ETH: 4,
  SOL: 5,
  XRP: 4
};

async function fetchCandles(symbol, timeframe = '4h', days = 365) {
  try {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const all = [];
    let fetchSince = since;
    
    while (fetchSince < Date.now()) {
      const candles = await exchange.fetchOHLCV(symbol, timeframe, fetchSince, 500);
      if (candles.length === 0) break;
      all.push(...candles);
      fetchSince = candles[candles.length - 1][0] + 1;
      if (candles.length < 500) break;
    }
    
    return all;
  } catch (e) {
    console.error(`Error ${symbol}:`, e.message);
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

function calcATR(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i][2];
    const low = candles[i][3];
    const prevClose = candles[i - 1][4];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  
  if (trs.length < period) return trs[trs.length - 1] || 0;
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
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

async function backtestLongOnly(symbol, btcData) {
  console.log(`   Processing ${symbol}...`);
  const candles = await fetchCandles(symbol, '4h', 365);
  if (candles.length < 100) return [];
  
  const asset = symbol.split('/')[0];
  const leverage = LEVERAGE[asset] || 4;
  const closes = candles.map(c => c[4]);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  
  // BTC data for correlation
  const btcCloses = btcData.map(c => c[4]);
  const btcEma50 = calcEMA(btcCloses, 50);
  const btcTimeMap = new Map();
  btcData.forEach((c, i) => btcTimeMap.set(c[0], { close: c[4], ema50: btcEma50[i] }));
  
  const trades = [];
  let position = null;
  
  for (let i = 50; i < candles.length - 1; i++) {
    const ts = candles[i][0];
    const close = closes[i];
    const high = candles[i][2];
    const low = candles[i][3];
    const ema21Val = ema21[i];
    const ema50Val = ema50[i];
    const ema200Val = ema200[i];
    const atr = calcATR(candles.slice(0, i + 1), 14);
    const rsi = calcRSI(closes.slice(0, i + 1), 14);
    
    // BTC trend
    const btc = btcTimeMap.get(ts);
    const btcBullish = btc ? btc.close > btc.ema50 : false;
    
    // Volume analysis
    const vol = candles[i][5];
    const avgVol = candles.slice(Math.max(0, i - 20), i).reduce((a, c) => a + c[5], 0) / 20;
    const volRatio = vol / avgVol;
    
    if (!position) {
      // LONG entry conditions:
      // 1. Price > EMA21 (short-term bullish)
      // 2. EMA21 > EMA50 (medium-term bullish)
      // 3. RSI not overbought (< 70)
      // 4. BTC bullish OR volume spike
      // 5. Not in a death cross (EMA50 < EMA200)
      
      const shortTermBullish = close > ema21Val;
      const mediumTermBullish = ema21Val > ema50Val;
      const notOverbought = rsi < 70;
      const notDeathCross = ema50Val > ema200Val * 0.98; // Allow 2% tolerance
      const volumeConfirmation = btcBullish || volRatio > 1.5;
      
      if (shortTermBullish && mediumTermBullish && notOverbought && notDeathCross && volumeConfirmation) {
        position = {
          entryPrice: close,
          stopLoss: close - 1.5 * atr, // 1.5 ATR stop (tighter)
          entryTime: ts,
          atr
        };
      }
    } else {
      // Position management
      let exitPrice = null;
      let exitReason = '';
      
      // Update trailing stop
      const pnlAtr = (close - position.entryPrice) / position.atr;
      if (pnlAtr >= 1.5) {
        // Move stop to breakeven when 1.5 ATR in profit
        position.stopLoss = Math.max(position.stopLoss, position.entryPrice);
      }
      if (pnlAtr >= 3) {
        // Move stop to lock in 1 ATR profit when 3 ATR in profit
        position.stopLoss = Math.max(position.stopLoss, position.entryPrice + position.atr);
      }
      
      // Exit conditions
      // 1. Stop loss hit
      if (low <= position.stopLoss) {
        exitPrice = position.stopLoss;
        exitReason = 'stop_loss';
      }
      // 2. Price closes below EMA21 AND RSI > 50 (bearish momentum)
      else if (close < ema21Val && rsi > 50) {
        exitPrice = close;
        exitReason = 'ema_cross';
      }
      // 3. RSI overbought (> 75) - take profit
      else if (rsi > 75 && pnlAtr > 2) {
        exitPrice = close;
        exitReason = 'rsi_overbought';
      }
      
      if (exitPrice) {
        const fees = FEES.total() * 2;
        const pnlPercent = ((exitPrice - position.entryPrice) / position.entryPrice - fees) * 100;
        
        trades.push({
          symbol,
          entryTime: position.entryTime,
          exitTime: ts,
          entryPrice: position.entryPrice,
          exitPrice,
          pnlPercent,
          leverage,
          pnlWithLeverage: pnlPercent * leverage,
          exitReason,
          holdingHours: (ts - position.entryTime) / (1000 * 60 * 60)
        });
        
        position = null;
      }
    }
  }
  
  return trades;
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🚀 LONG-ONLY TREND FOLLOWING');
  console.log('═'.repeat(80));
  console.log(`\n💰 Starting Capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log('📅 Period: Last 365 days');
  console.log('🎯 Strategy: LONG-only + EMA alignment + BTC correlation\n');
  
  // Fetch BTC first
  console.log('📥 Fetching data...');
  const btcData = await fetchCandles('BTC/USDT', '4h', 365);
  console.log(`   BTC: ${btcData.length} candles`);
  
  const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'];
  const allTrades = [];
  
  for (const symbol of symbols) {
    const trades = await backtestLongOnly(symbol, btcData);
    if (trades.length > 0) {
      allTrades.push(...trades);
      console.log(`   ${symbol}: ${trades.length} trades`);
    }
  }
  
  // Results by symbol
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RESULTS BY SYMBOL');
  console.log('═'.repeat(80));
  
  for (const symbol of symbols) {
    const symbolTrades = allTrades.filter(t => t.symbol === symbol);
    if (symbolTrades.length === 0) {
      console.log(`\n${symbol}: No trades`);
      continue;
    }
    
    const wins = symbolTrades.filter(t => t.pnlPercent > 0).length;
    const wr = (wins / symbolTrades.length * 100).toFixed(1);
    const pnl = symbolTrades.reduce((a, t) => a + t.pnlPercent, 0);
    const pnlLev = symbolTrades.reduce((a, t) => a + t.pnlWithLeverage, 0);
    const avgHold = symbolTrades.reduce((a, t) => a + t.holdingHours, 0) / symbolTrades.length;
    
    console.log(`\n📈 ${symbol}:`);
    console.log(`   Trades: ${symbolTrades.length} | Win Rate: ${wr}%`);
    console.log(`   P&L (no lev): ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`);
    console.log(`   P&L (w/ lev): ${pnlLev >= 0 ? '+' : ''}${pnlLev.toFixed(2)}%`);
    console.log(`   Avg Hold: ${avgHold.toFixed(0)}h`);
    
    // Exit reasons breakdown
    const byReason = {};
    symbolTrades.forEach(t => {
      if (!byReason[t.exitReason]) byReason[t.exitReason] = { count: 0, pnl: 0 };
      byReason[t.exitReason].count++;
      byReason[t.exitReason].pnl += t.pnlWithLeverage;
    });
    
    console.log('   Exit Reasons:');
    for (const [reason, data] of Object.entries(byReason)) {
      console.log(`     ${reason}: ${data.count} trades, ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(1)}%`);
    }
  }
  
  // Overall results
  const totalTrades = allTrades.length;
  const totalWins = allTrades.filter(t => t.pnlPercent > 0).length;
  const totalPnl = allTrades.reduce((a, t) => a + t.pnlPercent, 0);
  const totalPnlLev = allTrades.reduce((a, t) => a + t.pnlWithLeverage, 0);
  
  console.log('\n' + '═'.repeat(80));
  console.log('💰 OVERALL PERFORMANCE');
  console.log('═'.repeat(80));
  
  console.log(`\n🎯 Total Trades: ${totalTrades}`);
  console.log(`✅ Win Rate: ${totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : 0}%`);
  console.log(`\n💵 WITHOUT LEVERAGE: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%`);
  console.log(`   $${INITIAL_CAPITAL.toLocaleString()} → $${(INITIAL_CAPITAL * (1 + totalPnl / 100)).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`);
  console.log(`\n🚀 WITH LEVERAGE: ${totalPnlLev >= 0 ? '+' : ''}${totalPnlLev.toFixed(2)}%`);
  console.log(`   $${INITIAL_CAPITAL.toLocaleString()} → $${(INITIAL_CAPITAL * (1 + totalPnlLev / 100)).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`);
  
  // Monthly breakdown
  console.log('\n📅 Monthly P&L:');
  const byMonth = {};
  for (const t of allTrades) {
    const month = new Date(t.exitTime).toISOString().slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { pnl: 0, trades: 0 };
    byMonth[month].pnl += t.pnlWithLeverage;
    byMonth[month].trades++;
  }
  
  let positiveMonths = 0;
  for (const [month, data] of Object.entries(byMonth).sort()) {
    const bar = data.pnl > 0 
      ? '█'.repeat(Math.min(Math.round(data.pnl / 3), 30))
      : '░'.repeat(Math.min(Math.round(Math.abs(data.pnl) / 3), 30));
    console.log(`   ${month}: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(1)}% (${data.trades} trades) ${data.pnl > 0 ? '🟢' : '🔴'} ${bar}`);
    if (data.pnl > 0) positiveMonths++;
  }
  
  const totalMonths = Object.keys(byMonth).length;
  console.log(`\n   Positive months: ${positiveMonths}/${totalMonths} (${totalMonths > 0 ? (positiveMonths / totalMonths * 100).toFixed(0) : 0}%)`);
  
  // Final comparison
  console.log('\n' + '═'.repeat(80));
  console.log('📊 STRATEGY COMPARISON (Last 365 Days - Bear Market)');
  console.log('═'.repeat(80));
  
  const strategies = [
    { name: 'LONG-Only (w/lev)', roi: totalPnlLev, value: INITIAL_CAPITAL * (1 + totalPnlLev / 100) },
    { name: 'Best Reactive (prev)', roi: 5.1, value: 10510 },
    { name: 'BTC Buy & Hold', roi: -9.3, value: 9073 },
    { name: 'ETH Buy & Hold', roi: -20.3, value: 7968 },
    { name: 'SOL Buy & Hold', roi: -43.5, value: 5652 }
  ].sort((a, b) => b.roi - a.roi);
  
  console.log('\n┌────────────────────────────────┬────────────┬─────────────────┐');
  console.log('│ Strategy                       │    ROI     │  Final Value    │');
  console.log('├────────────────────────────────┼────────────┼─────────────────┤');
  
  for (const s of strategies) {
    const roiStr = s.roi >= 0 ? `+${s.roi.toFixed(1)}%` : `${s.roi.toFixed(1)}%`;
    console.log(`│ ${s.name.padEnd(30)} │ ${roiStr.padStart(10)} │ $${s.value.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',').padStart(14)} │`);
  }
  
  console.log('└────────────────────────────────┴────────────┴─────────────────┘');
  
  // Conclusion
  const winner = strategies[0];
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🏆 WINNER: ${winner.name.padEnd(60)} ║
║    ROI: ${winner.roi >= 0 ? '+' : ''}${winner.roi.toFixed(1)}% | $${INITIAL_CAPITAL.toLocaleString()} → $${winner.value.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${' '.repeat(40 - winner.value.toFixed(0).length)}║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
}

main().catch(console.error);
