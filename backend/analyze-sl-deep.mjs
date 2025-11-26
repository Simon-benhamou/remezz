/**
 * 🔬 Analyse PROFONDE des Stop Loss
 * 
 * Objectif: Comprendre exactement QUAND et POURQUOI on hit un stop loss
 * - Conditions de marché au moment de l'entrée
 * - Ce qui se passe APRÈS l'entrée (les 1-10 premières bougies)
 * - Volatilité, momentum BTC, spread BB, etc.
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

// Configuration V5.1
const CONFIG = {
  SYMBOLS: ['SEI/USDT:USDT', 'XRP/USDT:USDT', 'ETH/USDT:USDT', 'IMX/USDT:USDT'],
  LEVERAGE: { 'SEI': 5, 'XRP': 4, 'ETH': 5, 'IMX': 5 },
  STOP_LOSS_PCT: 1.5,
  TAKE_PROFIT_PCT: 3.0,
  MIN_VOL_RATIO: 1.3,
  MIN_ROC: 1.5,
  MAX_CONSEC_UP: 4,
};

// Indicateurs
function calcSMA(data, period) {
  if (data.length < period) return null;
  return data.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcEMA(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcROC(data, period) {
  if (data.length < period + 1) return 0;
  const current = data[data.length - 1];
  const past = data[data.length - 1 - period];
  return ((current - past) / past) * 100;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    atrSum += tr;
  }
  return atrSum / period;
}

function calcBollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    middle: sma,
    upper: sma + stdDev * std,
    lower: sma - stdDev * std,
    width: (stdDev * std * 2) / sma * 100,
    percentB: (closes[closes.length - 1] - (sma - stdDev * std)) / (stdDev * std * 2)
  };
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2) return 25; // Default neutral
  
  let plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < candles.length; i++) {
    const highDiff = candles[i].high - candles[i-1].high;
    const lowDiff = candles[i-1].low - candles[i].low;
    
    plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low - candles[i-1].close)
    ));
  }
  
  const smoothedPlusDM = calcEMA(plusDM.slice(-period*2), period);
  const smoothedMinusDM = calcEMA(minusDM.slice(-period*2), period);
  const smoothedTR = calcEMA(tr.slice(-period*2), period);
  
  if (!smoothedTR || smoothedTR === 0) return 25;
  
  const plusDI = (smoothedPlusDM / smoothedTR) * 100;
  const minusDI = (smoothedMinusDM / smoothedTR) * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  
  return dx || 25;
}

// Vérifier conditions d'entrée V5
function checkEntrySignal(candles, btcCandles, index) {
  if (index < 220) return false;
  
  const closes = candles.slice(0, index + 1).map(c => c.close);
  const volumes = candles.slice(0, index + 1).map(c => c.volume);
  const btcCloses = btcCandles.slice(0, index + 1).map(c => c.close);
  
  const btcSma200 = calcSMA(btcCloses, 200);
  if (!btcSma200 || btcCloses[btcCloses.length - 1] <= btcSma200) return false;
  
  const avgVol = calcSMA(volumes.slice(-20), 20);
  if (!avgVol || volumes[volumes.length - 1] < avgVol * CONFIG.MIN_VOL_RATIO) return false;
  
  const roc = calcROC(closes, 10);
  if (roc < CONFIG.MIN_ROC) return false;
  
  const bb = calcBollingerBands(closes);
  if (!bb || closes[closes.length - 1] <= bb.upper) return false;
  
  let consecUp = 0;
  for (let i = closes.length - 1; i > 0 && consecUp < 10; i--) {
    if (closes[i] > closes[i - 1]) consecUp++;
    else break;
  }
  if (consecUp > CONFIG.MAX_CONSEC_UP) return false;
  
  return true;
}

// Analyser un trade en profondeur
function analyzeTradeDeep(candles, btcCandles, entryIndex, symbol) {
  const entryCandle = candles[entryIndex];
  const entryPrice = entryCandle.close;
  const leverage = CONFIG.LEVERAGE[symbol.split('/')[0]] || 5;
  
  // Données au moment de l'entrée
  const closes = candles.slice(0, entryIndex + 1).map(c => c.close);
  const volumes = candles.slice(0, entryIndex + 1).map(c => c.volume);
  const btcCloses = btcCandles.slice(0, entryIndex + 1).map(c => c.close);
  const candlesSlice = candles.slice(0, entryIndex + 1);
  
  // Indicateurs à l'entrée
  const rsi = calcRSI(closes);
  const roc10 = calcROC(closes, 10);
  const roc5 = calcROC(closes, 5);
  const atr = calcATR(candlesSlice);
  const atrPct = (atr / entryPrice) * 100;
  const bb = calcBollingerBands(closes);
  const adx = calcADX(candlesSlice);
  
  // BTC metrics
  const btcRoc = calcROC(btcCloses, 10);
  const btcSma200 = calcSMA(btcCloses, 200);
  const btcDistFromSma = ((btcCloses[btcCloses.length - 1] - btcSma200) / btcSma200) * 100;
  
  // Volume metrics
  const avgVol20 = calcSMA(volumes.slice(-20), 20);
  const volRatio = volumes[volumes.length - 1] / avgVol20;
  const volRoc = calcROC(volumes, 5); // Volume momentum
  
  // Price action
  const candleBody = Math.abs(entryCandle.close - entryCandle.open);
  const candleRange = entryCandle.high - entryCandle.low;
  const bodyRatio = candleRange > 0 ? candleBody / candleRange : 0;
  const isGreenCandle = entryCandle.close > entryCandle.open;
  
  // Distance from key levels
  const distFromBBUpper = bb ? ((entryPrice - bb.upper) / entryPrice) * 100 : 0;
  const ma20 = calcSMA(closes, 20);
  const distFromMa20 = ma20 ? ((entryPrice - ma20) / ma20) * 100 : 0;
  
  // Consecutive moves
  let consecUp = 0, consecDown = 0;
  for (let i = closes.length - 1; i > 0; i--) {
    if (closes[i] > closes[i - 1]) { consecUp++; if (consecDown > 0) break; }
    else { consecDown++; if (consecUp > 0) break; }
  }
  
  // Hour of day (UTC)
  const entryHour = new Date(entryCandle.timestamp).getUTCHours();
  const dayOfWeek = new Date(entryCandle.timestamp).getUTCDay();
  
  // Simulate trade
  const slPrice = entryPrice * (1 - CONFIG.STOP_LOSS_PCT / 100);
  const tpPrice = entryPrice * (1 + CONFIG.TAKE_PROFIT_PCT / 100);
  
  let exitPrice = null;
  let exitReason = null;
  let holdBars = 0;
  let maxDrawdown = 0;
  let maxRunup = 0;
  let barsToMaxDrawdown = 0;
  
  for (let i = entryIndex + 1; i < Math.min(candles.length, entryIndex + 192); i++) {
    const candle = candles[i];
    holdBars++;
    
    // Track drawdown and runup
    const currentDrawdown = ((entryPrice - candle.low) / entryPrice) * 100;
    const currentRunup = ((candle.high - entryPrice) / entryPrice) * 100;
    if (currentDrawdown > maxDrawdown) {
      maxDrawdown = currentDrawdown;
      barsToMaxDrawdown = holdBars;
    }
    if (currentRunup > maxRunup) maxRunup = currentRunup;
    
    if (candle.low <= slPrice) {
      exitPrice = slPrice;
      exitReason = 'stop_loss';
      break;
    }
    
    if (candle.high >= tpPrice) {
      exitPrice = tpPrice;
      exitReason = 'take_profit';
      break;
    }
    
    if (holdBars >= 192) {
      exitPrice = candle.close;
      exitReason = 'timeout';
      break;
    }
  }
  
  if (!exitPrice) {
    exitPrice = candles[candles.length - 1].close;
    exitReason = 'end_of_data';
  }
  
  const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  const pnlWithLeverage = pnlPct * leverage - 0.1; // -0.1% fees
  
  return {
    symbol,
    entryPrice,
    exitPrice,
    exitReason,
    holdBars,
    pnlPct,
    pnlWithLeverage,
    
    // Entry conditions
    rsi,
    roc10,
    roc5,
    atrPct,
    adx,
    bbWidth: bb?.width || 0,
    bbPercentB: bb?.percentB || 0,
    distFromBBUpper,
    distFromMa20,
    volRatio,
    volRoc,
    
    // BTC conditions
    btcRoc,
    btcDistFromSma,
    
    // Candle characteristics
    bodyRatio,
    isGreenCandle,
    consecUp,
    
    // Time
    entryHour,
    dayOfWeek,
    
    // Trade behavior
    maxDrawdown,
    maxRunup,
    barsToMaxDrawdown,
    
    isSL: exitReason === 'stop_loss',
    isWin: pnlWithLeverage > 0,
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 ANALYSE PROFONDE DES STOP LOSS');
  console.log('═'.repeat(80));
  console.log();
  
  // Fetch data
  console.log('📊 Fetching 6 months of data...\n');
  const allData = {};
  for (const symbol of CONFIG.SYMBOLS) {
    const allCandles = [];
    let since = Date.now() - 6 * 30 * 24 * 60 * 60 * 1000;
    while (allCandles.length < 17000) {
      const ohlcv = await exchange.fetchOHLCV(symbol, '15m', since, 1500);
      if (ohlcv.length === 0) break;
      allCandles.push(...ohlcv);
      since = ohlcv[ohlcv.length - 1][0] + 1;
      await new Promise(r => setTimeout(r, 100));
    }
    allData[symbol] = allCandles.map(c => ({
      timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
    }));
    console.log(`   ${symbol}: ${allData[symbol].length} candles`);
  }
  
  const btcCandles = [];
  let btcSince = Date.now() - 6 * 30 * 24 * 60 * 60 * 1000;
  while (btcCandles.length < 20000) {
    const ohlcv = await exchange.fetchOHLCV('BTC/USDT:USDT', '15m', btcSince, 1500);
    if (ohlcv.length === 0) break;
    btcCandles.push(...ohlcv.map(c => ({
      timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
    })));
    btcSince = ohlcv[ohlcv.length - 1][0] + 1;
    await new Promise(r => setTimeout(r, 100));
  }
  console.log(`   BTC: ${btcCandles.length} candles\n`);
  
  // Simulate trades
  const allTrades = [];
  for (const symbol of CONFIG.SYMBOLS) {
    const candles = allData[symbol];
    for (let i = 220; i < candles.length - 200; i++) {
      if (checkEntrySignal(candles, btcCandles, i)) {
        const trade = analyzeTradeDeep(candles, btcCandles, i, symbol);
        allTrades.push(trade);
        i += 10;
      }
    }
  }
  
  const slTrades = allTrades.filter(t => t.isSL);
  const winTrades = allTrades.filter(t => t.isWin && !t.isSL);
  const tpTrades = allTrades.filter(t => t.exitReason === 'take_profit');
  
  console.log(`📈 Total: ${allTrades.length} trades | SL: ${slTrades.length} | TP: ${tpTrades.length} | Win: ${winTrades.length}\n`);
  
  // Compare averages
  const avg = (arr, fn) => arr.length ? arr.reduce((s, t) => s + fn(t), 0) / arr.length : 0;
  
  console.log('═'.repeat(80));
  console.log('📊 CONDITIONS À L\'ENTRÉE: STOP LOSS vs TAKE PROFIT');
  console.log('═'.repeat(80));
  console.log();
  
  const metrics = [
    { name: 'RSI', fn: t => t.rsi, fmt: v => v.toFixed(1) },
    { name: 'ROC 10', fn: t => t.roc10, fmt: v => v.toFixed(2) + '%' },
    { name: 'ROC 5', fn: t => t.roc5, fmt: v => v.toFixed(2) + '%' },
    { name: 'ATR %', fn: t => t.atrPct, fmt: v => v.toFixed(2) + '%' },
    { name: 'ADX (trend strength)', fn: t => t.adx, fmt: v => v.toFixed(1) },
    { name: 'BB Width', fn: t => t.bbWidth, fmt: v => v.toFixed(2) + '%' },
    { name: 'BB %B (position)', fn: t => t.bbPercentB, fmt: v => v.toFixed(2) },
    { name: 'Dist from BB Upper', fn: t => t.distFromBBUpper, fmt: v => v.toFixed(2) + '%' },
    { name: 'Dist from MA20', fn: t => t.distFromMa20, fmt: v => v.toFixed(2) + '%' },
    { name: 'Volume Ratio', fn: t => t.volRatio, fmt: v => v.toFixed(2) + 'x' },
    { name: 'Volume ROC (mom)', fn: t => t.volRoc, fmt: v => v.toFixed(0) + '%' },
    { name: 'BTC ROC 10', fn: t => t.btcRoc, fmt: v => v.toFixed(2) + '%' },
    { name: 'BTC dist SMA200', fn: t => t.btcDistFromSma, fmt: v => v.toFixed(2) + '%' },
    { name: 'Candle Body Ratio', fn: t => t.bodyRatio, fmt: v => v.toFixed(2) },
    { name: 'Consec Up Candles', fn: t => t.consecUp, fmt: v => v.toFixed(1) },
  ];
  
  console.log('┌─────────────────────────┬──────────────┬──────────────┬────────────┬─────────────┐');
  console.log('│ Métrique                │  Stop Loss   │  Take Profit │   Delta    │ Significant │');
  console.log('├─────────────────────────┼──────────────┼──────────────┼────────────┼─────────────┤');
  
  for (const m of metrics) {
    const slAvg = avg(slTrades, m.fn);
    const tpAvg = avg(tpTrades, m.fn);
    const delta = tpAvg - slAvg;
    const pctDiff = slAvg !== 0 ? Math.abs(delta / slAvg * 100) : 0;
    const sig = pctDiff > 15 ? '⚠️ YES' : pctDiff > 8 ? '~ maybe' : '';
    
    console.log(`│ ${m.name.padEnd(23)} │ ${m.fmt(slAvg).padStart(12)} │ ${m.fmt(tpAvg).padStart(12)} │ ${(delta >= 0 ? '+' : '') + m.fmt(delta).padStart(9)} │ ${sig.padStart(11)} │`);
  }
  console.log('└─────────────────────────┴──────────────┴──────────────┴────────────┴─────────────┘');
  
  // Behavior after entry
  console.log();
  console.log('═'.repeat(80));
  console.log('📊 COMPORTEMENT APRÈS ENTRÉE');
  console.log('═'.repeat(80));
  console.log();
  
  console.log(`   Stop Loss trades:`);
  console.log(`     - Max Drawdown avant SL: ${avg(slTrades, t => t.maxDrawdown).toFixed(2)}%`);
  console.log(`     - Max Runup avant SL:    ${avg(slTrades, t => t.maxRunup).toFixed(2)}%`);
  console.log(`     - Bars to Max Drawdown:  ${avg(slTrades, t => t.barsToMaxDrawdown).toFixed(1)} bars (~${(avg(slTrades, t => t.barsToMaxDrawdown) * 15 / 60).toFixed(1)}h)`);
  console.log(`     - Hold time avg:         ${avg(slTrades, t => t.holdBars).toFixed(1)} bars (~${(avg(slTrades, t => t.holdBars) * 15 / 60).toFixed(1)}h)`);
  console.log();
  console.log(`   Take Profit trades:`);
  console.log(`     - Max Drawdown avant TP: ${avg(tpTrades, t => t.maxDrawdown).toFixed(2)}%`);
  console.log(`     - Max Runup avant TP:    ${avg(tpTrades, t => t.maxRunup).toFixed(2)}%`);
  console.log(`     - Hold time avg:         ${avg(tpTrades, t => t.holdBars).toFixed(1)} bars (~${(avg(tpTrades, t => t.holdBars) * 15 / 60).toFixed(1)}h)`);
  
  // Distribution analysis
  console.log();
  console.log('═'.repeat(80));
  console.log('📊 DISTRIBUTION DES STOP LOSS PAR FACTEUR');
  console.log('═'.repeat(80));
  console.log();
  
  // RSI buckets
  const rsiBuckets = [
    { name: 'RSI < 65', filter: t => t.rsi < 65 },
    { name: 'RSI 65-70', filter: t => t.rsi >= 65 && t.rsi < 70 },
    { name: 'RSI 70-75', filter: t => t.rsi >= 70 && t.rsi < 75 },
    { name: 'RSI 75-80', filter: t => t.rsi >= 75 && t.rsi < 80 },
    { name: 'RSI > 80', filter: t => t.rsi >= 80 },
  ];
  
  console.log('   RSI Distribution:');
  for (const bucket of rsiBuckets) {
    const trades = allTrades.filter(bucket.filter);
    const sl = trades.filter(t => t.isSL).length;
    const slPct = trades.length > 0 ? (sl / trades.length * 100) : 0;
    const bar = '█'.repeat(Math.round(slPct / 3));
    console.log(`     ${bucket.name.padEnd(12)}: ${trades.length.toString().padStart(3)} trades | ${slPct.toFixed(0).padStart(2)}% SL ${bar}`);
  }
  
  // ATR buckets
  console.log();
  console.log('   ATR % (Volatility) Distribution:');
  const atrBuckets = [
    { name: 'ATR < 0.5%', filter: t => t.atrPct < 0.5 },
    { name: 'ATR 0.5-0.7%', filter: t => t.atrPct >= 0.5 && t.atrPct < 0.7 },
    { name: 'ATR 0.7-1.0%', filter: t => t.atrPct >= 0.7 && t.atrPct < 1.0 },
    { name: 'ATR 1.0-1.5%', filter: t => t.atrPct >= 1.0 && t.atrPct < 1.5 },
    { name: 'ATR > 1.5%', filter: t => t.atrPct >= 1.5 },
  ];
  
  for (const bucket of atrBuckets) {
    const trades = allTrades.filter(bucket.filter);
    const sl = trades.filter(t => t.isSL).length;
    const slPct = trades.length > 0 ? (sl / trades.length * 100) : 0;
    const bar = '█'.repeat(Math.round(slPct / 3));
    console.log(`     ${bucket.name.padEnd(12)}: ${trades.length.toString().padStart(3)} trades | ${slPct.toFixed(0).padStart(2)}% SL ${bar}`);
  }
  
  // ADX buckets (trend strength)
  console.log();
  console.log('   ADX (Trend Strength) Distribution:');
  const adxBuckets = [
    { name: 'ADX < 15 (weak)', filter: t => t.adx < 15 },
    { name: 'ADX 15-25', filter: t => t.adx >= 15 && t.adx < 25 },
    { name: 'ADX 25-35', filter: t => t.adx >= 25 && t.adx < 35 },
    { name: 'ADX 35-50', filter: t => t.adx >= 35 && t.adx < 50 },
    { name: 'ADX > 50 (strong)', filter: t => t.adx >= 50 },
  ];
  
  for (const bucket of adxBuckets) {
    const trades = allTrades.filter(bucket.filter);
    const sl = trades.filter(t => t.isSL).length;
    const slPct = trades.length > 0 ? (sl / trades.length * 100) : 0;
    const bar = '█'.repeat(Math.round(slPct / 3));
    console.log(`     ${bucket.name.padEnd(18)}: ${trades.length.toString().padStart(3)} trades | ${slPct.toFixed(0).padStart(2)}% SL ${bar}`);
  }
  
  // BB Width buckets
  console.log();
  console.log('   BB Width (Volatility/Squeeze) Distribution:');
  const bbBuckets = [
    { name: 'BB < 2% (squeeze)', filter: t => t.bbWidth < 2 },
    { name: 'BB 2-3%', filter: t => t.bbWidth >= 2 && t.bbWidth < 3 },
    { name: 'BB 3-5%', filter: t => t.bbWidth >= 3 && t.bbWidth < 5 },
    { name: 'BB 5-8%', filter: t => t.bbWidth >= 5 && t.bbWidth < 8 },
    { name: 'BB > 8% (wide)', filter: t => t.bbWidth >= 8 },
  ];
  
  for (const bucket of bbBuckets) {
    const trades = allTrades.filter(bucket.filter);
    const sl = trades.filter(t => t.isSL).length;
    const slPct = trades.length > 0 ? (sl / trades.length * 100) : 0;
    const bar = '█'.repeat(Math.round(slPct / 3));
    console.log(`     ${bucket.name.padEnd(18)}: ${trades.length.toString().padStart(3)} trades | ${slPct.toFixed(0).padStart(2)}% SL ${bar}`);
  }
  
  // Distance from MA20
  console.log();
  console.log('   Distance from MA20 (Extension) Distribution:');
  const ma20Buckets = [
    { name: 'Dist < 1%', filter: t => t.distFromMa20 < 1 },
    { name: 'Dist 1-2%', filter: t => t.distFromMa20 >= 1 && t.distFromMa20 < 2 },
    { name: 'Dist 2-3%', filter: t => t.distFromMa20 >= 2 && t.distFromMa20 < 3 },
    { name: 'Dist 3-5%', filter: t => t.distFromMa20 >= 3 && t.distFromMa20 < 5 },
    { name: 'Dist > 5%', filter: t => t.distFromMa20 >= 5 },
  ];
  
  for (const bucket of ma20Buckets) {
    const trades = allTrades.filter(bucket.filter);
    const sl = trades.filter(t => t.isSL).length;
    const slPct = trades.length > 0 ? (sl / trades.length * 100) : 0;
    const bar = '█'.repeat(Math.round(slPct / 3));
    console.log(`     ${bucket.name.padEnd(12)}: ${trades.length.toString().padStart(3)} trades | ${slPct.toFixed(0).padStart(2)}% SL ${bar}`);
  }
  
  // Hour of day
  console.log();
  console.log('   Hour of Day (UTC) Distribution:');
  const hourBuckets = [
    { name: '00-04 UTC', filter: t => t.entryHour >= 0 && t.entryHour < 4 },
    { name: '04-08 UTC', filter: t => t.entryHour >= 4 && t.entryHour < 8 },
    { name: '08-12 UTC', filter: t => t.entryHour >= 8 && t.entryHour < 12 },
    { name: '12-16 UTC', filter: t => t.entryHour >= 12 && t.entryHour < 16 },
    { name: '16-20 UTC', filter: t => t.entryHour >= 16 && t.entryHour < 20 },
    { name: '20-24 UTC', filter: t => t.entryHour >= 20 && t.entryHour < 24 },
  ];
  
  for (const bucket of hourBuckets) {
    const trades = allTrades.filter(bucket.filter);
    const sl = trades.filter(t => t.isSL).length;
    const slPct = trades.length > 0 ? (sl / trades.length * 100) : 0;
    const bar = '█'.repeat(Math.round(slPct / 3));
    console.log(`     ${bucket.name.padEnd(12)}: ${trades.length.toString().padStart(3)} trades | ${slPct.toFixed(0).padStart(2)}% SL ${bar}`);
  }
  
  // BTC momentum
  console.log();
  console.log('   BTC ROC 10 (Momentum) Distribution:');
  const btcBuckets = [
    { name: 'BTC ROC < 0%', filter: t => t.btcRoc < 0 },
    { name: 'BTC ROC 0-0.5%', filter: t => t.btcRoc >= 0 && t.btcRoc < 0.5 },
    { name: 'BTC ROC 0.5-1%', filter: t => t.btcRoc >= 0.5 && t.btcRoc < 1 },
    { name: 'BTC ROC 1-2%', filter: t => t.btcRoc >= 1 && t.btcRoc < 2 },
    { name: 'BTC ROC > 2%', filter: t => t.btcRoc >= 2 },
  ];
  
  for (const bucket of btcBuckets) {
    const trades = allTrades.filter(bucket.filter);
    const sl = trades.filter(t => t.isSL).length;
    const slPct = trades.length > 0 ? (sl / trades.length * 100) : 0;
    const bar = '█'.repeat(Math.round(slPct / 3));
    console.log(`     ${bucket.name.padEnd(15)}: ${trades.length.toString().padStart(3)} trades | ${slPct.toFixed(0).padStart(2)}% SL ${bar}`);
  }
  
  // Summary
  console.log();
  console.log('═'.repeat(80));
  console.log('💡 FACTEURS CLÉS IDENTIFIÉS');
  console.log('═'.repeat(80));
  console.log();
  
  // Find significant factors
  const allFactors = [
    ...rsiBuckets.map(b => ({ ...b, category: 'RSI' })),
    ...atrBuckets.map(b => ({ ...b, category: 'ATR' })),
    ...adxBuckets.map(b => ({ ...b, category: 'ADX' })),
    ...bbBuckets.map(b => ({ ...b, category: 'BB Width' })),
    ...ma20Buckets.map(b => ({ ...b, category: 'Dist MA20' })),
    ...hourBuckets.map(b => ({ ...b, category: 'Hour' })),
    ...btcBuckets.map(b => ({ ...b, category: 'BTC ROC' })),
  ];
  
  const avgSlRate = slTrades.length / allTrades.length * 100;
  const significantLow = [];
  const significantHigh = [];
  
  for (const factor of allFactors) {
    const trades = allTrades.filter(factor.filter);
    if (trades.length < 15) continue; // Need enough samples
    const slRate = trades.filter(t => t.isSL).length / trades.length * 100;
    if (slRate < avgSlRate - 8) significantLow.push({ ...factor, slRate, count: trades.length });
    if (slRate > avgSlRate + 8) significantHigh.push({ ...factor, slRate, count: trades.length });
  }
  
  console.log(`   Taux SL moyen: ${avgSlRate.toFixed(1)}%\n`);
  
  if (significantLow.length > 0) {
    console.log('   ✅ FACTEURS QUI RÉDUISENT LE SL:');
    for (const f of significantLow.sort((a, b) => a.slRate - b.slRate)) {
      console.log(`      ${f.category}: ${f.name} → ${f.slRate.toFixed(1)}% SL (${f.count} trades)`);
    }
  }
  
  if (significantHigh.length > 0) {
    console.log();
    console.log('   ❌ FACTEURS QUI AUGMENTENT LE SL:');
    for (const f of significantHigh.sort((a, b) => b.slRate - a.slRate)) {
      console.log(`      ${f.category}: ${f.name} → ${f.slRate.toFixed(1)}% SL (${f.count} trades)`);
    }
  }
}

main().catch(console.error);
