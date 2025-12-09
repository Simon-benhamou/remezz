/**
 * Analyze December 1-9 signals vs other months
 * Compare win rate, avg PnL, number of trades to see if December is favorable
 */

import fs from 'fs';

// V5.11 Strategy Config
const CONFIG = {
  RSI_PERIOD: 14,
  RSI_OVERSOLD: 35,
  RSI_OVERBOUGHT: 65,
  MACD_FAST: 12,
  MACD_SLOW: 26,
  MACD_SIGNAL: 9,
  ATR_PERIOD: 14,
  SL_ATR_MULT: 3.0,
  SL_MIN_PCT: 1.0,
  SL_MAX_PCT: 4.5,
  TRAIL_ACTIVATION_PCT: 0.5,
  TRAIL_DISTANCE_PCT: 0.3,
  FEE_PCT: 0.04,
  LEVERAGE: {
    'SOL/USDT:USDT': 4.5,
    'ETH/USDT:USDT': 4.5,
    'BTC/USDT:USDT': 4,
    'AVAX/USDT:USDT': 4,
    'LINK/USDT:USDT': 4,
    'DOT/USDT:USDT': 4,
    'DOGE/USDT:USDT': 4,
    'XRP/USDT:USDT': 4,
    'ATOM/USDT:USDT': 4,
  }
};

const SYMBOLS = Object.keys(CONFIG.LEVERAGE);

// Technical indicators
function calculateRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

function calculateEMA(data, period) {
  const ema = new Array(data.length).fill(null);
  if (data.length < period) return ema;
  
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  ema[period - 1] = sum / period;
  
  const mult = 2 / (period + 1);
  for (let i = period; i < data.length; i++) {
    ema[i] = (data[i] - ema[i - 1]) * mult + ema[i - 1];
  }
  return ema;
}

function calculateMACD(closes) {
  const emaFast = calculateEMA(closes, CONFIG.MACD_FAST);
  const emaSlow = calculateEMA(closes, CONFIG.MACD_SLOW);
  
  const macdLine = closes.map((_, i) => 
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );
  
  const validMacd = macdLine.filter(v => v !== null);
  const signalLine = calculateEMA(validMacd, CONFIG.MACD_SIGNAL);
  
  const result = { macd: [], signal: [], histogram: [] };
  let sigIdx = 0;
  
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== null) {
      result.macd.push(macdLine[i]);
      const sig = signalLine[sigIdx] ?? null;
      result.signal.push(sig);
      result.histogram.push(sig !== null ? macdLine[i] - sig : null);
      sigIdx++;
    } else {
      result.macd.push(null);
      result.signal.push(null);
      result.histogram.push(null);
    }
  }
  return result;
}

function calculateATR(candles, period = 14) {
  const atr = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return atr;
  
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  atr[period - 1] = sum / period;
  
  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

function runBacktest(candles, symbol) {
  const closes = candles.map(c => c.close);
  const rsi = calculateRSI(closes, CONFIG.RSI_PERIOD);
  const macd = calculateMACD(closes);
  const atr = calculateATR(candles, CONFIG.ATR_PERIOD);
  
  const trades = [];
  let position = null;
  const leverage = CONFIG.LEVERAGE[symbol] || 4;
  
  for (let i = 50; i < candles.length; i++) {
    const candle = candles[i];
    const price = candle.close;
    const ts = new Date(candle.timestamp || candle.ts);
    
    if (rsi[i] === null || macd.histogram[i] === null || atr[i] === null) continue;
    
    // Check exits first
    if (position) {
      const highPrice = candle.high;
      const lowPrice = candle.low;
      
      // Update trailing
      if (position.side === 'long' && highPrice > position.highWaterMark) {
        position.highWaterMark = highPrice;
        const pnlPct = ((highPrice - position.entryPrice) / position.entryPrice) * 100;
        if (pnlPct >= CONFIG.TRAIL_ACTIVATION_PCT && !position.trailingActive) {
          position.trailingActive = true;
          position.trailingStop = highPrice * (1 - CONFIG.TRAIL_DISTANCE_PCT / 100);
        }
        if (position.trailingActive) {
          position.trailingStop = Math.max(position.trailingStop, highPrice * (1 - CONFIG.TRAIL_DISTANCE_PCT / 100));
        }
      }
      
      let exitPrice = null;
      let exitReason = null;
      
      // Check stop loss
      if (position.side === 'long' && lowPrice <= position.stopLoss) {
        exitPrice = position.stopLoss;
        exitReason = 'SL';
      }
      // Check trailing stop
      else if (position.trailingActive && position.side === 'long' && lowPrice <= position.trailingStop) {
        exitPrice = position.trailingStop;
        exitReason = 'TRAIL';
      }
      
      if (exitPrice) {
        const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
        const notional = position.qty * position.entryPrice;
        const fees = notional * CONFIG.FEE_PCT / 100 * 2;
        const pnlUsd = (pnlPct / 100) * notional - fees;
        
        trades.push({
          symbol,
          side: position.side,
          entryTime: position.entryTime,
          exitTime: ts,
          entryPrice: position.entryPrice,
          exitPrice,
          pnlPct,
          pnlUsd,
          exitReason,
          leverage,
          month: position.entryTime.getMonth() + 1,
          year: position.entryTime.getFullYear(),
          day: position.entryTime.getDate(),
        });
        position = null;
      }
    }
    
    // Check entry signals (LONG only)
    if (!position) {
      const prevRsi = rsi[i - 1];
      const currRsi = rsi[i];
      const prevHist = macd.histogram[i - 1];
      const currHist = macd.histogram[i];
      
      // Long signal: RSI crosses above oversold AND MACD histogram turns positive
      const rsiCrossUp = prevRsi !== null && prevRsi < CONFIG.RSI_OVERSOLD && currRsi >= CONFIG.RSI_OVERSOLD;
      const macdCrossUp = prevHist !== null && prevHist < 0 && currHist >= 0;
      
      if (rsiCrossUp && macdCrossUp) {
        const slPctRaw = (atr[i] / price) * 100 * CONFIG.SL_ATR_MULT;
        const slPct = Math.max(CONFIG.SL_MIN_PCT, Math.min(CONFIG.SL_MAX_PCT, slPctRaw));
        
        position = {
          side: 'long',
          entryPrice: price,
          entryTime: ts,
          qty: 1000 / price,
          stopLoss: price * (1 - slPct / 100),
          highWaterMark: price,
          trailingActive: false,
          trailingStop: 0,
        };
      }
    }
  }
  
  return trades;
}

async function analyze() {
  console.log('📊 Analyzing December 1-9 signals vs other periods\n');
  console.log('Strategy: V5.11 (ATR×3.0 SL, Trail +0.5%/0.3%, LONG only)\n');
  
  let allTrades = [];
  
  // Load and backtest each symbol
  for (const symbol of SYMBOLS) {
    // Try 15m data first (more history), fallback to 1h
    let filename = symbol.replace('/', '_').replace(':USDT', '') + '_15m.json';
    let filepath = `./data/${filename}`;
    
    if (!fs.existsSync(filepath)) {
      filename = symbol.replace('/', '_').replace(':USDT', '') + '_1h.json';
      filepath = `./data/${filename}`;
    }
    
    if (!fs.existsSync(filepath)) {
      console.log(`⚠️ No data for ${symbol}`);
      continue;
    }
    
    const rawCandles = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    
    // If 15m data, resample to 1h for strategy (4 candles = 1 hour)
    let candles;
    if (filename.includes('15m')) {
      candles = [];
      for (let i = 0; i < rawCandles.length; i += 4) {
        if (i + 3 >= rawCandles.length) break;
        const chunk = rawCandles.slice(i, i + 4);
        candles.push({
          timestamp: chunk[0].openTime || chunk[0].timestamp,
          open: chunk[0].open,
          high: Math.max(...chunk.map(c => c.high)),
          low: Math.min(...chunk.map(c => c.low)),
          close: chunk[3].close,
          volume: chunk.reduce((s, c) => s + c.volume, 0),
        });
      }
      console.log(`${symbol}: ${candles.length} candles (resampled from 15m)`);
    } else {
      // Normalize 1h data format
      candles = rawCandles.map(c => ({
        timestamp: c.timestamp || c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
      console.log(`${symbol}: ${candles.length} candles (1h)`);
    }
    
    const trades = runBacktest(candles, symbol);
    allTrades.push(...trades);
    console.log(`  → ${trades.length} trades`);
  }
  
  console.log(`\nTotal trades: ${allTrades.length}\n`);
  
  // Group by month
  const monthlyStats = {};
  
  for (const trade of allTrades) {
    const key = `${trade.year}-${String(trade.month).padStart(2, '0')}`;
    if (!monthlyStats[key]) {
      monthlyStats[key] = {
        trades: [],
        wins: 0,
        losses: 0,
        totalPnl: 0,
      };
    }
    monthlyStats[key].trades.push(trade);
    if (trade.pnlUsd > 0) monthlyStats[key].wins++;
    else monthlyStats[key].losses++;
    monthlyStats[key].totalPnl += trade.pnlUsd;
  }
  
  // Print monthly breakdown
  console.log('═'.repeat(90));
  console.log('MONTHLY PERFORMANCE (Full months only)');
  console.log('═'.repeat(90));
  console.log('Month      │ Trades │ Wins │ Losses │ Win Rate │ Total PnL │ Avg PnL/Trade');
  console.log('─'.repeat(90));
  
  const sortedMonths = Object.keys(monthlyStats).sort();
  const monthlyData = [];
  
  for (const month of sortedMonths) {
    const stats = monthlyStats[month];
    const winRate = stats.trades.length > 0 ? (stats.wins / stats.trades.length) * 100 : 0;
    const avgPnl = stats.trades.length > 0 ? stats.totalPnl / stats.trades.length : 0;
    
    monthlyData.push({
      month,
      trades: stats.trades.length,
      wins: stats.wins,
      losses: stats.losses,
      winRate,
      totalPnl: stats.totalPnl,
      avgPnl,
    });
    
    const pnlColor = stats.totalPnl >= 0 ? '\x1b[32m' : '\x1b[31m';
    console.log(
      `${month}   │ ${String(stats.trades.length).padStart(6)} │ ${String(stats.wins).padStart(4)} │ ${String(stats.losses).padStart(6)} │ ${winRate.toFixed(1).padStart(7)}% │ ${pnlColor}$${stats.totalPnl.toFixed(2).padStart(8)}\x1b[0m │ $${avgPnl.toFixed(2)}`
    );
  }
  
  // Now analyze December 1-9 specifically
  console.log('\n' + '═'.repeat(90));
  console.log('DECEMBER 1-9 ANALYSIS (Current period)');
  console.log('═'.repeat(90));
  
  const dec1to9_2025 = allTrades.filter(t => t.year === 2025 && t.month === 12 && t.day <= 9);
  const dec1to9_2024 = allTrades.filter(t => t.year === 2024 && t.month === 12 && t.day <= 9);
  const dec1to9_2023 = allTrades.filter(t => t.year === 2023 && t.month === 12 && t.day <= 9);
  
  function printPeriodStats(name, trades) {
    if (trades.length === 0) {
      console.log(`${name}: No trades`);
      return null;
    }
    const wins = trades.filter(t => t.pnlUsd > 0).length;
    const winRate = (wins / trades.length) * 100;
    const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
    const avgPnl = totalPnl / trades.length;
    
    console.log(`${name}:`);
    console.log(`  Trades: ${trades.length} | Wins: ${wins} | Win Rate: ${winRate.toFixed(1)}%`);
    console.log(`  Total PnL: $${totalPnl.toFixed(2)} | Avg PnL/Trade: $${avgPnl.toFixed(2)}`);
    
    // Show individual trades
    for (const t of trades) {
      const pnlColor = t.pnlUsd >= 0 ? '\x1b[32m' : '\x1b[31m';
      console.log(`    ${t.entryTime.toISOString().slice(0,10)} ${t.symbol.slice(0,3)} ${t.exitReason.padEnd(5)} ${pnlColor}${t.pnlUsd >= 0 ? '+' : ''}$${t.pnlUsd.toFixed(2)}\x1b[0m`);
    }
    
    return { trades: trades.length, wins, winRate, totalPnl, avgPnl };
  }
  
  printPeriodStats('Dec 1-9, 2023', dec1to9_2023);
  console.log('');
  printPeriodStats('Dec 1-9, 2024', dec1to9_2024);
  console.log('');
  printPeriodStats('Dec 1-9, 2025', dec1to9_2025);
  
  // Compare first 9 days of each month
  console.log('\n' + '═'.repeat(90));
  console.log('FIRST 9 DAYS OF EACH MONTH (Historical comparison)');
  console.log('═'.repeat(90));
  console.log('Month      │ Trades │ Wins │ Win Rate │ Total PnL │ Avg PnL');
  console.log('─'.repeat(90));
  
  const first9DaysStats = {};
  
  for (const trade of allTrades) {
    if (trade.day <= 9) {
      const monthName = new Date(trade.year, trade.month - 1, 1).toLocaleString('en', { month: 'short' });
      if (!first9DaysStats[monthName]) {
        first9DaysStats[monthName] = { trades: 0, wins: 0, totalPnl: 0, samples: [] };
      }
      first9DaysStats[monthName].trades++;
      if (trade.pnlUsd > 0) first9DaysStats[monthName].wins++;
      first9DaysStats[monthName].totalPnl += trade.pnlUsd;
      first9DaysStats[monthName].samples.push(trade.pnlUsd);
    }
  }
  
  const monthOrder = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  for (const monthName of monthOrder) {
    const stats = first9DaysStats[monthName];
    if (!stats) continue;
    
    const winRate = (stats.wins / stats.trades) * 100;
    const avgPnl = stats.totalPnl / stats.trades;
    const pnlColor = stats.totalPnl >= 0 ? '\x1b[32m' : '\x1b[31m';
    
    console.log(
      `${monthName.padEnd(10)} │ ${String(stats.trades).padStart(6)} │ ${String(stats.wins).padStart(4)} │ ${winRate.toFixed(1).padStart(7)}% │ ${pnlColor}$${stats.totalPnl.toFixed(2).padStart(8)}\x1b[0m │ $${avgPnl.toFixed(2)}`
    );
  }
  
  // Overall summary
  console.log('\n' + '═'.repeat(90));
  console.log('SUMMARY');
  console.log('═'.repeat(90));
  
  const decFirst9 = first9DaysStats['Dec'];
  const allFirst9 = Object.values(first9DaysStats);
  const avgTradesFirst9 = allFirst9.reduce((s, m) => s + m.trades, 0) / allFirst9.length;
  const avgWinRateFirst9 = allFirst9.reduce((s, m) => s + (m.wins / m.trades) * 100, 0) / allFirst9.length;
  const avgPnlFirst9 = allFirst9.reduce((s, m) => s + m.totalPnl / m.trades, 0) / allFirst9.length;
  
  console.log(`Average across all months (first 9 days):`);
  console.log(`  Avg Trades: ${avgTradesFirst9.toFixed(1)} | Avg Win Rate: ${avgWinRateFirst9.toFixed(1)}% | Avg PnL/Trade: $${avgPnlFirst9.toFixed(2)}`);
  
  if (decFirst9) {
    const decWinRate = (decFirst9.wins / decFirst9.trades) * 100;
    const decAvgPnl = decFirst9.totalPnl / decFirst9.trades;
    
    console.log(`\nDecember first 9 days:`);
    console.log(`  Trades: ${decFirst9.trades} | Win Rate: ${decWinRate.toFixed(1)}% | Avg PnL/Trade: $${decAvgPnl.toFixed(2)}`);
    
    const winRateDiff = decWinRate - avgWinRateFirst9;
    const pnlDiff = decAvgPnl - avgPnlFirst9;
    
    console.log(`\nDecember vs Average:`);
    console.log(`  Win Rate: ${winRateDiff >= 0 ? '+' : ''}${winRateDiff.toFixed(1)}% ${winRateDiff >= 0 ? '✅ BETTER' : '⚠️ WORSE'}`);
    console.log(`  Avg PnL:  ${pnlDiff >= 0 ? '+' : ''}$${pnlDiff.toFixed(2)} ${pnlDiff >= 0 ? '✅ BETTER' : '⚠️ WORSE'}`);
    
    if (winRateDiff >= 0 && pnlDiff >= 0) {
      console.log('\n🎯 CONCLUSION: December (first 9 days) is historically a FAVORABLE period');
    } else if (winRateDiff < 0 && pnlDiff < 0) {
      console.log('\n⚠️ CONCLUSION: December (first 9 days) is historically LESS favorable');
    } else {
      console.log('\n📊 CONCLUSION: December (first 9 days) shows MIXED results');
    }
  }
}

analyze().catch(console.error);
