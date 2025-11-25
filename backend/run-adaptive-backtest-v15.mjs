/**
 * STRATÉGIE ADAPTATIVE V15 - ÉVITE LE RÉGIME LOW
 * 
 * Observation clé de V14:
 * - LOW regime: 130 trades, 38.5% WR, -3.12% (PERD)
 * - MEDIUM regime: 6 trades, 66.7% WR, +6.02% (GAGNE)
 * - HIGH regime: 3 trades, 66.7% WR, +5.51% (GAGNE)
 * 
 * V15: On trade UNIQUEMENT en MEDIUM/HIGH volatility
 */

import ccxt from 'ccxt';

// Configuration
const INITIAL_CAPITAL = 10000;
const DAYS = 120;
const TIMEFRAME = '15m';
const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];

// Volatility thresholds - ONLY trade MEDIUM and HIGH
const MIN_ATR_RATIO = 0.015; // 1.5% ATR/Close minimum (skip LOW volatility)

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

function MACD(closes) {
  if (closes.length < 35) return { histogram: 0 };
  const emaFast = EMA(closes.slice(-36), 12);
  const emaSlow = EMA(closes.slice(-52), 26);
  return { histogram: emaFast - emaSlow };
}

function BBANDS(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return { upper: closes[closes.length - 1], middle: closes[closes.length - 1], lower: closes[closes.length - 1] };
  const slice = closes.slice(-period);
  const sma = SMA(slice);
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: sma + stdDev * std, middle: sma, lower: sma - stdDev * std };
}

// Get volatility regime
function getVolatilityRegime(atr, close) {
  const ratio = (atr / close) * 100;
  if (ratio < 1.5) return 'LOW';
  if (ratio < 3) return 'MEDIUM';
  return 'HIGH';
}

// Strategy signal detection - ONLY in MEDIUM/HIGH volatility
function detectSignal(candles, idx) {
  if (idx < 50) return null;
  
  const closes = candles.slice(0, idx + 1).map(c => c[4]);
  const currentClose = closes[closes.length - 1];
  
  // Calculate ATR first to check volatility
  const atr = ATR(candles.slice(0, idx + 1), 14);
  const atrRatio = atr / currentClose;
  
  // VOLATILITY FILTER: Skip LOW volatility entirely
  if (atrRatio < MIN_ATR_RATIO) {
    return { signal: null, skipReason: 'LOW_VOL' };
  }
  
  const regime = getVolatilityRegime(atr, currentClose);
  
  // Indicators
  const ema20 = EMA(closes.slice(-40), 20);
  const ema50 = EMA(closes.slice(-100), 50);
  const rsi = RSI(closes, 14);
  const macd = MACD(closes);
  const bb = BBANDS(closes);
  
  // Trend direction
  const bullishTrend = currentClose > ema20 && ema20 > ema50;
  const bearishTrend = currentClose < ema20 && ema20 < ema50;
  
  // Adapt criteria based on regime
  const rsiOversold = regime === 'HIGH' ? 35 : 40;
  const rsiOverbought = regime === 'HIGH' ? 65 : 60;
  
  // LONG signal
  if (bullishTrend && 
      rsi > 50 && rsi < 70 &&
      macd.histogram > 0 &&
      currentClose > ema20 &&
      currentClose < bb.upper * 0.98) {
    return { signal: 'LONG', confidence: 0.7, regime, atr };
  }
  
  // SHORT signal
  if (bearishTrend && 
      rsi < 50 && rsi > 30 &&
      macd.histogram < 0 &&
      currentClose < ema20 &&
      currentClose > bb.lower * 1.02) {
    return { signal: 'SHORT', confidence: 0.7, regime, atr };
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
  console.log('📊 STRATÉGIE ADAPTATIVE V15 - ÉVITE LE RÉGIME LOW');
  console.log('════════════════════════════════════════════════════════════════════════════════');
  console.log(`📅 Période: ${DAYS} jours (${Math.floor(DAYS / 30)} mois)`);
  console.log(`💰 Capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log(`📈 ATR/Close Min: ${(MIN_ATR_RATIO * 100).toFixed(1)}% (skip LOW volatility)`);
  console.log('════════════════════════════════════════════════════════════════════════════════\n');
  
  const allTrades = [];
  const regimeStats = { LOW: { trades: 0, wins: 0, pnl: 0 }, MEDIUM: { trades: 0, wins: 0, pnl: 0 }, HIGH: { trades: 0, wins: 0, pnl: 0 } };
  let lowVolSkips = 0;
  
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
    let symbolLowVolSkips = 0;
    
    for (let i = 50; i < allCandles.length - 96; i++) {
      if (i - lastTradeIdx < 16) continue;
      
      const result = detectSignal(allCandles, i);
      
      if (result && result.skipReason === 'LOW_VOL') {
        symbolLowVolSkips++;
        continue;
      }
      
      if (!result || !result.signal) continue;
      
      const trade = simulateTrade(allCandles, i, result.signal, result.atr);
      trades.push({
        ...trade,
        timestamp: allCandles[i][0],
        symbol,
        signal: result.signal,
        regime: result.regime
      });
      
      regimeStats[result.regime].trades++;
      if (trade.win) regimeStats[result.regime].wins++;
      regimeStats[result.regime].pnl += trade.pnl;
      
      lastTradeIdx = i;
    }
    
    lowVolSkips += symbolLowVolSkips;
    
    const symbolWins = trades.filter(t => t.win).length;
    const symbolPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
    console.log(`   Trades: ${trades.length} | WR: ${trades.length ? ((symbolWins / trades.length) * 100).toFixed(1) : 0}% | Return: ${symbolPnL >= 0 ? '+' : ''}${symbolPnL.toFixed(2)}%`);
    console.log(`   📈 Low volatility skips: ${symbolLowVolSkips}`);
    
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
  console.log(`   LOW_VOL_SKIPPED: ${lowVolSkips} opportunities skipped`);
  
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
  } else {
    console.log('\n   ✅ TOUS LES MOIS SONT POSITIFS!');
  }
  console.log(`\n   📈 Return Moyen/Mois: ${(totalPnL / sortedMonths.length).toFixed(2)}%`);
  
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
}

main().catch(console.error);
