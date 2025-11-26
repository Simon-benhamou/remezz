/**
 * 🌊 TREND FOLLOWING PURE
 * 
 * Don't predict, just FOLLOW the trend:
 * - Long when price breaks above resistance
 * - Short when price breaks below support
 * - Ride the momentum until it reverses
 * 
 * This is what CTAs and trend-following hedge funds do
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const INITIAL_CAPITAL = 10000;
const RISK_PER_TRADE = 0.02; // 2% risk per trade

// Realistic fees
const FEES = {
  maker: 0.0004,
  taker: 0.0006,
  slippage: 0.0002,
  total: function() { return this.taker + this.slippage; }
};

const LEVERAGE = {
  BTC: 3,
  ETH: 5,
  SOL: 7,
  XRP: 5
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

function calcDonchian(candles, period = 20) {
  if (candles.length < period) return { upper: candles[candles.length - 1][2], lower: candles[candles.length - 1][3] };
  
  const recent = candles.slice(-period);
  const upper = Math.max(...recent.map(c => c[2])); // Highest high
  const lower = Math.min(...recent.map(c => c[3])); // Lowest low
  
  return { upper, lower };
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

async function backtestTrendFollowing(symbol, btcData) {
  console.log(`   Processing ${symbol}...`);
  const candles = await fetchCandles(symbol, '4h', 365);
  if (candles.length < 100) return [];
  
  const asset = symbol.split('/')[0];
  const leverage = LEVERAGE[asset] || 5;
  const closes = candles.map(c => c[4]);
  const ema200 = calcEMA(closes, 200);
  
  // BTC trend filter
  const btcCloses = btcData.map(c => c[4]);
  const btcEma50 = calcEMA(btcCloses, 50);
  const btcTimeMap = new Map();
  btcData.forEach((c, i) => btcTimeMap.set(c[0], { close: c[4], ema50: btcEma50[i] }));
  
  const trades = [];
  let position = null; // { side, entryPrice, stopLoss, entryTime }
  let capital = INITIAL_CAPITAL;
  
  for (let i = 50; i < candles.length - 1; i++) {
    const ts = candles[i][0];
    const close = closes[i];
    const high = candles[i][2];
    const low = candles[i][3];
    const atr = calcATR(candles.slice(0, i + 1), 14);
    const donchian = calcDonchian(candles.slice(0, i), 20); // Previous 20 bars
    const ema200Val = ema200[i];
    
    // BTC trend
    const btc = btcTimeMap.get(ts);
    const btcTrend = btc ? (btc.close > btc.ema50 ? 'up' : 'down') : 'neutral';
    
    if (!position) {
      // Entry: Donchian breakout + trend filter
      
      // LONG: Price breaks above 20-period high + above 200 EMA + BTC bullish
      if (close > donchian.upper && close > ema200Val && btcTrend === 'up') {
        position = {
          side: 'LONG',
          entryPrice: close,
          stopLoss: close - 2 * atr, // 2 ATR stop
          entryTime: ts
        };
      }
      // SHORT: Price breaks below 20-period low + below 200 EMA + BTC bearish
      else if (close < donchian.lower && close < ema200Val && btcTrend === 'down') {
        position = {
          side: 'SHORT',
          entryPrice: close,
          stopLoss: close + 2 * atr, // 2 ATR stop
          entryTime: ts
        };
      }
    } else {
      // Position management
      let exitPrice = null;
      let exitReason = '';
      
      if (position.side === 'LONG') {
        // Trailing stop: move stop to breakeven + 1 ATR if price moved 2 ATR in our favor
        const pnlAtr = (close - position.entryPrice) / atr;
        if (pnlAtr >= 2) {
          position.stopLoss = Math.max(position.stopLoss, position.entryPrice + atr);
        }
        
        // Exit on stop hit
        if (low <= position.stopLoss) {
          exitPrice = position.stopLoss;
          exitReason = 'stop';
        }
        // Exit on new 10-period low (exit faster than entry)
        const exit10 = Math.min(...candles.slice(i - 10, i).map(c => c[3]));
        if (close < exit10) {
          exitPrice = close;
          exitReason = 'exit_signal';
        }
      } else { // SHORT
        const pnlAtr = (position.entryPrice - close) / atr;
        if (pnlAtr >= 2) {
          position.stopLoss = Math.min(position.stopLoss, position.entryPrice - atr);
        }
        
        if (high >= position.stopLoss) {
          exitPrice = position.stopLoss;
          exitReason = 'stop';
        }
        const exit10 = Math.max(...candles.slice(i - 10, i).map(c => c[2]));
        if (close > exit10) {
          exitPrice = close;
          exitReason = 'exit_signal';
        }
      }
      
      if (exitPrice) {
        // Calculate P&L
        const fees = FEES.total() * 2; // Entry + exit
        let pnlPercent;
        
        if (position.side === 'LONG') {
          pnlPercent = ((exitPrice - position.entryPrice) / position.entryPrice - fees) * 100;
        } else {
          pnlPercent = ((position.entryPrice - exitPrice) / position.entryPrice - fees) * 100;
        }
        
        trades.push({
          symbol,
          side: position.side,
          entryTime: position.entryTime,
          exitTime: ts,
          entryPrice: position.entryPrice,
          exitPrice,
          pnlPercent,
          leverage,
          pnlWithLeverage: pnlPercent * leverage,
          exitReason
        });
        
        position = null;
      }
    }
  }
  
  return trades;
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🌊 TREND FOLLOWING - Donchian Breakout Strategy');
  console.log('═'.repeat(80));
  console.log(`\n💰 Starting Capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log('📅 Period: Last 365 days');
  console.log('🎯 Strategy: Donchian breakout + 200 EMA filter + BTC correlation\n');
  
  // Fetch BTC first
  console.log('📥 Fetching data...');
  const btcData = await fetchCandles('BTC/USDT', '4h', 365);
  console.log(`   BTC: ${btcData.length} candles`);
  
  const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'];
  const allTrades = [];
  
  for (const symbol of symbols) {
    const trades = await backtestTrendFollowing(symbol, btcData);
    if (trades.length > 0) {
      allTrades.push(...trades);
      console.log(`   ${symbol}: ${trades.length} trades`);
    }
  }
  
  // Analyze results
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RESULTS');
  console.log('═'.repeat(80));
  
  // By side
  const longs = allTrades.filter(t => t.side === 'LONG');
  const shorts = allTrades.filter(t => t.side === 'SHORT');
  
  console.log('\n📈 LONG trades:');
  if (longs.length > 0) {
    const longWins = longs.filter(t => t.pnlPercent > 0).length;
    const longPnl = longs.reduce((a, t) => a + t.pnlWithLeverage, 0);
    console.log(`   Count: ${longs.length} | WR: ${(longWins / longs.length * 100).toFixed(1)}% | P&L: ${longPnl >= 0 ? '+' : ''}${longPnl.toFixed(1)}%`);
  } else {
    console.log('   No LONG trades');
  }
  
  console.log('\n📉 SHORT trades:');
  if (shorts.length > 0) {
    const shortWins = shorts.filter(t => t.pnlPercent > 0).length;
    const shortPnl = shorts.reduce((a, t) => a + t.pnlWithLeverage, 0);
    console.log(`   Count: ${shorts.length} | WR: ${(shortWins / shorts.length * 100).toFixed(1)}% | P&L: ${shortPnl >= 0 ? '+' : ''}${shortPnl.toFixed(1)}%`);
  } else {
    console.log('   No SHORT trades');
  }
  
  // By symbol
  console.log('\n📊 By Symbol:');
  for (const symbol of symbols) {
    const symbolTrades = allTrades.filter(t => t.symbol === symbol);
    if (symbolTrades.length === 0) {
      console.log(`   ${symbol}: No trades`);
      continue;
    }
    const wins = symbolTrades.filter(t => t.pnlPercent > 0).length;
    const pnl = symbolTrades.reduce((a, t) => a + t.pnlWithLeverage, 0);
    console.log(`   ${symbol}: ${symbolTrades.length} trades | WR: ${(wins / symbolTrades.length * 100).toFixed(1)}% | P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%`);
  }
  
  // Overall
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
      ? '█'.repeat(Math.min(Math.round(data.pnl / 3), 25))
      : '░'.repeat(Math.min(Math.round(Math.abs(data.pnl) / 3), 25));
    console.log(`   ${month}: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(1)}% (${data.trades} trades) ${data.pnl > 0 ? '🟢' : '🔴'} ${bar}`);
    if (data.pnl > 0) positiveMonths++;
  }
  
  const totalMonths = Object.keys(byMonth).length;
  console.log(`\n   Positive months: ${positiveMonths}/${totalMonths} (${totalMonths > 0 ? (positiveMonths / totalMonths * 100).toFixed(0) : 0}%)`);
  
  // Best/worst trades
  if (allTrades.length > 0) {
    console.log('\n🏆 Best Trades:');
    const best = [...allTrades].sort((a, b) => b.pnlWithLeverage - a.pnlWithLeverage).slice(0, 5);
    for (const t of best) {
      console.log(`   ${t.symbol} ${t.side}: +${t.pnlWithLeverage.toFixed(1)}% (${new Date(t.entryTime).toISOString().split('T')[0]})`);
    }
    
    console.log('\n💀 Worst Trades:');
    const worst = [...allTrades].sort((a, b) => a.pnlWithLeverage - b.pnlWithLeverage).slice(0, 5);
    for (const t of worst) {
      console.log(`   ${t.symbol} ${t.side}: ${t.pnlWithLeverage.toFixed(1)}% (${new Date(t.entryTime).toISOString().split('T')[0]})`);
    }
  }
  
  // Comparison
  console.log('\n' + '═'.repeat(80));
  console.log('📊 STRATEGY COMPARISON (Last 365 Days)');
  console.log('═'.repeat(80));
  console.log('\n┌────────────────────────────────┬────────────┬─────────────────┐');
  console.log('│ Strategy                       │    ROI     │  Final Value    │');
  console.log('├────────────────────────────────┼────────────┼─────────────────┤');
  console.log(`│ Trend Following (w/lev)        │ ${(totalPnlLev >= 0 ? '+' : '') + totalPnlLev.toFixed(1)}%`.padEnd(45) + `│ $${(INITIAL_CAPITAL * (1 + totalPnlLev / 100)).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`.padEnd(18) + '│');
  console.log('│ Best Reactive (5.1% w/lev)     │      +5.1% │         $10,510 │');
  console.log('│ BTC Buy & Hold                 │      -9.3% │          $9,073 │');
  console.log('│ ETH Buy & Hold                 │     -20.3% │          $7,968 │');
  console.log('│ SOL Buy & Hold                 │     -43.5% │          $5,652 │');
  console.log('└────────────────────────────────┴────────────┴─────────────────┘');
}

main().catch(console.error);
