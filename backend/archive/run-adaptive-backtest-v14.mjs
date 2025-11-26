/**
 * STRATÉGIE ADAPTATIVE V14 - TREND + VOLATILITY FILTER
 * 
 * V13 atteignait 3/4 mois positifs, mais septembre restait négatif.
 * V14 ajoute un filtre de volatilité minimum pour éviter les marchés plats.
 * 
 * Critères:
 * 1. Trend Filter: |Price - EMA20| / EMA20 > 0.8% (tendance claire)
 * 2. Volatility Filter: ATR(14) / Close > 0.8% (volatilité suffisante)
 * 3. Momentum Filter: RSI pas en zone neutre (30-40 ou 60-70)
 */

import ccxt from 'ccxt';

// Configuration
const INITIAL_CAPITAL = 10000;
const DAYS = 120;
const TIMEFRAME = '15m';
const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];

// Trend + Volatility Filter thresholds
const MIN_TREND_DEVIATION = 0.008; // 0.8% minimum deviation from EMA20
const MIN_VOLATILITY = 0.008; // ATR/Close > 0.8%
const RSI_BULLISH_ZONE = { min: 55, max: 75 }; // RSI bullish zone
const RSI_BEARISH_ZONE = { min: 25, max: 45 }; // RSI bearish zone

// Exchange
const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

// Helpers
function EMA(values, period) {
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function SMA(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function RSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? -c : 0);
  const avgGain = SMA(gains.slice(-period));
  const avgLoss = SMA(losses.slice(-period));
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function ATR(candles, period = 14) {
  if (candles.length < period) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i][2];
    const low = candles[i][3];
    const prevClose = candles[i - 1][4];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  return SMA(trs.slice(-period));
}

function MACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return { macd: 0, signal: 0, histogram: 0 };
  const emaFast = EMA(closes.slice(-fast * 3), fast);
  const emaSlow = EMA(closes.slice(-slow * 3), slow);
  const macdLine = emaFast - emaSlow;
  return { macd: macdLine, signal: 0, histogram: macdLine };
}

function BBANDS(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return { upper: closes[closes.length - 1], middle: closes[closes.length - 1], lower: closes[closes.length - 1] };
  const slice = closes.slice(-period);
  const sma = SMA(slice);
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: sma + stdDev * std, middle: sma, lower: sma - stdDev * std };
}

// Strategy signal detection
function detectSignal(candles, idx) {
  if (idx < 50) return null;
  
  const closes = candles.slice(0, idx + 1).map(c => c[4]);
  const currentClose = closes[closes.length - 1];
  
  // Indicators
  const ema20 = EMA(closes.slice(-40), 20);
  const ema50 = EMA(closes.slice(-100), 50);
  const rsi = RSI(closes, 14);
  const macd = MACD(closes);
  const bb = BBANDS(closes);
  const atr = ATR(candles.slice(0, idx + 1), 14);
  
  // TREND FILTER: Distance from EMA20
  const trendDeviation = Math.abs(currentClose - ema20) / ema20;
  const hasTrend = trendDeviation >= MIN_TREND_DEVIATION;
  
  // VOLATILITY FILTER: ATR/Close
  const volatilityRatio = atr / currentClose;
  const hasVolatility = volatilityRatio >= MIN_VOLATILITY;
  
  // Combined filter
  if (!hasTrend || !hasVolatility) {
    return { signal: null, skipReason: 'NO_TREND_VOL' };
  }
  
  // Trend direction
  const bullishTrend = currentClose > ema20 && ema20 > ema50;
  const bearishTrend = currentClose < ema20 && ema20 < ema50;
  
  // LONG signal
  if (bullishTrend && 
      rsi >= RSI_BULLISH_ZONE.min && rsi <= RSI_BULLISH_ZONE.max &&
      macd.histogram > 0 &&
      currentClose < bb.upper * 0.99) {
    return { signal: 'LONG', confidence: 0.7 };
  }
  
  // SHORT signal
  if (bearishTrend && 
      rsi >= RSI_BEARISH_ZONE.min && rsi <= RSI_BEARISH_ZONE.max &&
      macd.histogram < 0 &&
      currentClose > bb.lower * 1.01) {
    return { signal: 'SHORT', confidence: 0.7 };
  }
  
  return { signal: null };
}

// Simulate trade
function simulateTrade(candles, entryIdx, signal, atrValue) {
  const entryPrice = candles[entryIdx][4];
  const slDistance = atrValue * 1.5;
  const tpDistance = atrValue * 2.5;
  
  let sl, tp;
  if (signal === 'LONG') {
    sl = entryPrice - slDistance;
    tp = entryPrice + tpDistance;
  } else {
    sl = entryPrice + slDistance;
    tp = entryPrice - tpDistance;
  }
  
  // Simulate forward
  for (let i = entryIdx + 1; i < Math.min(entryIdx + 96, candles.length); i++) {
    const high = candles[i][2];
    const low = candles[i][3];
    
    if (signal === 'LONG') {
      if (low <= sl) return { win: false, pnl: -1.2 };
      if (high >= tp) return { win: true, pnl: 2.0 };
    } else {
      if (high >= sl) return { win: false, pnl: -1.2 };
      if (low <= tp) return { win: true, pnl: 2.0 };
    }
  }
  
  // Timeout - close at current price
  const exitPrice = candles[Math.min(entryIdx + 96, candles.length - 1)][4];
  const pnlPct = signal === 'LONG' 
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  return { win: pnlPct > 0, pnl: pnlPct };
}

// Get volatility regime
function getVolatilityRegime(atr, close) {
  const ratio = (atr / close) * 100;
  if (ratio < 1.5) return 'LOW';
  if (ratio < 3) return 'MEDIUM';
  return 'HIGH';
}

// Format date
function formatDate(ts) {
  return new Date(ts).toISOString().split('T')[0];
}

function getYearMonth(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Main
async function main() {
  console.log('════════════════════════════════════════════════════════════════════════════════');
  console.log('📊 STRATÉGIE ADAPTATIVE V14 - TREND + VOLATILITY FILTER');
  console.log('════════════════════════════════════════════════════════════════════════════════');
  console.log(`📅 Période: ${DAYS} jours (${Math.floor(DAYS / 30)} mois)`);
  console.log(`💰 Capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log(`📈 Trend Deviation Min: ${(MIN_TREND_DEVIATION * 100).toFixed(1)}%`);
  console.log(`📊 Volatility Min: ${(MIN_VOLATILITY * 100).toFixed(1)}% ATR/Close`);
  console.log('════════════════════════════════════════════════════════════════════════════════\n');
  
  const allTrades = [];
  const regimeStats = { LOW: { trades: 0, wins: 0, pnl: 0 }, MEDIUM: { trades: 0, wins: 0, pnl: 0 }, HIGH: { trades: 0, wins: 0, pnl: 0 } };
  let noTrendVolSkips = 0;
  
  for (const symbol of SYMBOLS) {
    console.log('────────────────────────────────────────────────────────────────');
    console.log(`🔍 ${symbol}`);
    console.log('────────────────────────────────────────────────────────────────');
    
    const since = Date.now() - DAYS * 24 * 60 * 60 * 1000;
    console.log(`📥 Fetching ${symbol} (${DAYS} days)...`);
    
    let allCandles = [];
    let fetchSince = since;
    while (true) {
      const batch = await exchange.fetchOHLCV(symbol, TIMEFRAME, fetchSince, 1000);
      if (batch.length === 0) break;
      allCandles = allCandles.concat(batch);
      if (batch.length < 1000) break;
      fetchSince = batch[batch.length - 1][0] + 1;
      await new Promise(r => setTimeout(r, 100));
    }
    console.log(`   ✅ Got ${allCandles.length} candles`);
    
    const trades = [];
    let lastTradeIdx = -20;
    let symbolNoTrendSkips = 0;
    
    for (let i = 50; i < allCandles.length - 96; i++) {
      if (i - lastTradeIdx < 16) continue;
      
      const result = detectSignal(allCandles, i);
      
      if (result.skipReason === 'NO_TREND_VOL') {
        symbolNoTrendSkips++;
        continue;
      }
      
      if (!result.signal) continue;
      
      const atr = ATR(allCandles.slice(0, i + 1), 14);
      const close = allCandles[i][4];
      const regime = getVolatilityRegime(atr, close);
      
      const trade = simulateTrade(allCandles, i, result.signal, atr);
      trades.push({
        ...trade,
        timestamp: allCandles[i][0],
        symbol,
        signal: result.signal,
        regime
      });
      
      regimeStats[regime].trades++;
      if (trade.win) regimeStats[regime].wins++;
      regimeStats[regime].pnl += trade.pnl;
      
      lastTradeIdx = i;
    }
    
    noTrendVolSkips += symbolNoTrendSkips;
    
    const symbolWins = trades.filter(t => t.win).length;
    const symbolPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
    console.log(`   Trades: ${trades.length} | WR: ${trades.length ? ((symbolWins / trades.length) * 100).toFixed(1) : 0}% | Return: ${symbolPnL >= 0 ? '+' : ''}${symbolPnL.toFixed(2)}%`);
    console.log(`   📈 No-trend/vol skips: ${symbolNoTrendSkips}`);
    
    allTrades.push(...trades);
  }
  
  // Monthly breakdown
  const monthlyData = {};
  for (const trade of allTrades) {
    const month = getYearMonth(trade.timestamp);
    if (!monthlyData[month]) monthlyData[month] = { trades: 0, wins: 0, pnl: 0 };
    monthlyData[month].trades++;
    if (trade.win) monthlyData[month].wins++;
    monthlyData[month].pnl += trade.pnl;
  }
  
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('📅 PERFORMANCE MOIS PAR MOIS');
  console.log('════════════════════════════════════════════════════════════════════════════════\n');
  
  console.log('┌───────────┬────────┬────────┬───────────┬────────────────┬──────────────┐');
  console.log('│   Mois    │ Trades │   WR   │  Return   │     PnL ($)    │  Capital     │');
  console.log('├───────────┼────────┼────────┼───────────┼────────────────┼──────────────┤');
  
  let capital = INITIAL_CAPITAL;
  let positiveMonths = 0;
  let negativeMonths = [];
  const sortedMonths = Object.keys(monthlyData).sort();
  
  for (const month of sortedMonths) {
    const data = monthlyData[month];
    const wr = data.trades > 0 ? (data.wins / data.trades * 100).toFixed(1) : '0.0';
    const pnlPct = data.pnl;
    const pnlDollar = capital * (pnlPct / 100);
    capital += pnlDollar;
    
    const status = pnlPct >= 0 ? '✅' : '❌';
    if (pnlPct >= 0) positiveMonths++;
    else negativeMonths.push(month);
    
    console.log(`│ ${month} │ ${String(data.trades).padStart(6)} │ ${String(wr).padStart(5)}% │ ${status} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2).padStart(5)}% │ ${pnlPct >= 0 ? '+' : ''}$${Math.abs(pnlDollar).toFixed(0).padStart(10)} │ $${capital.toFixed(0).padStart(9)} │`);
  }
  
  console.log('└───────────┴────────┴────────┴───────────┴────────────────┴──────────────┘');
  
  // Regime stats
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('📊 PERFORMANCE PAR RÉGIME');
  console.log('════════════════════════════════════════════════════════════════════════════════');
  for (const [regime, stats] of Object.entries(regimeStats)) {
    if (stats.trades > 0) {
      const wr = (stats.wins / stats.trades * 100).toFixed(1);
      const avg = (stats.pnl / stats.trades).toFixed(3);
      console.log(`   ${regime.padEnd(8)}: ${String(stats.trades).padStart(3)} trades | ${wr.padStart(5)}% WR | ${stats.pnl >= 0 ? '+' : ''}${stats.pnl.toFixed(2).padStart(6)}% | Avg: ${avg}%`);
    }
  }
  console.log(`   NO_TREND_VOL: ${noTrendVolSkips} opportunities skipped`);
  
  // Summary
  const totalTrades = allTrades.length;
  const totalWins = allTrades.filter(t => t.win).length;
  const totalPnL = allTrades.reduce((sum, t) => sum + t.pnl, 0);
  
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('📊 RÉSUMÉ FINAL');
  console.log('════════════════════════════════════════════════════════════════════════════════\n');
  
  console.log(`   Total Trades: ${totalTrades}`);
  console.log(`   Win Rate Global: ${totalTrades ? ((totalWins / totalTrades) * 100).toFixed(1) : 0}%`);
  console.log(`   Return Total: ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}%`);
  console.log(`   Capital Final: $${capital.toFixed(2)}`);
  
  console.log(`\n   🎯 Mois positifs: ${positiveMonths}/${sortedMonths.length}`);
  if (negativeMonths.length > 0) {
    console.log(`\n   ⚠️ Mois négatifs: ${negativeMonths.join(', ')}`);
  }
  console.log(`\n   📈 Return Moyen/Mois: ${(totalPnL / sortedMonths.length).toFixed(2)}%`);
  
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
}

main().catch(console.error);
