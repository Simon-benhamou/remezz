/**
 * 🔬 Analyse des patterns de volume avant Stop Loss
 * 
 * Hypothèse: Une succession de bougies avec volume décroissant 
 * (momentum qui s'essouffle) précède souvent les stop loss
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

// Configuration V5.1
const CONFIG = {
  SYMBOLS: ['SEI/USDT:USDT', 'XRP/USDT:USDT', 'ETH/USDT:USDT', 'IMX/USDT:USDT'],
  LEVERAGE: { 'SEI': 5, 'XRP': 4, 'ETH': 5, 'IMX': 5 },
  STOP_LOSS_PCT: 1.5,
  TAKE_PROFIT_PCT: 3.0,
  POSITION_SIZE_PCT: 40,
  FEE_PCT: 0.1,
  
  // Entry conditions V5
  MIN_VOL_RATIO: 1.3,
  MIN_ROC: 1.5,
  MAX_CONSEC_UP: 4,
};

// Indicateurs techniques
function calcSMA(data, period) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
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
  
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
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
    width: (stdDev * std * 2) / sma * 100
  };
}

// Analyse du pattern de volume
function analyzeVolumePattern(volumes, lookback = 5) {
  if (volumes.length < lookback + 1) return null;
  
  const recent = volumes.slice(-lookback);
  const avgVol = calcSMA(volumes.slice(-20), 20) || 1;
  
  // Compter les bougies avec volume décroissant consécutif
  let decreasingCount = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] < recent[i - 1]) {
      decreasingCount++;
    } else {
      decreasingCount = 0; // Reset si augmentation
    }
  }
  
  // Volume trend (régression linéaire simple)
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < recent.length; i++) {
    sumX += i;
    sumY += recent[i];
    sumXY += i * recent[i];
    sumX2 += i * i;
  }
  const n = recent.length;
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const volumeTrend = slope / avgVol * 100; // Normalized slope
  
  // Volume ratio actuel vs moyenne
  const currentVolRatio = recent[recent.length - 1] / avgVol;
  
  // Volume diminution totale sur la période
  const volumeChange = ((recent[recent.length - 1] - recent[0]) / recent[0]) * 100;
  
  return {
    decreasingCount,
    volumeTrend,          // Négatif = volume décroissant
    currentVolRatio,
    volumeChange,
    isExhausting: volumeTrend < -5 && decreasingCount >= 2,
  };
}

// Simulation d'un trade avec analyse des patterns
function simulateTrade(candles, btcCandles, entryIndex, symbol) {
  const entryCandle = candles[entryIndex];
  const entryPrice = entryCandle.close;
  const leverage = CONFIG.LEVERAGE[symbol.split('/')[0]] || 5;
  
  // Analyser les patterns au moment de l'entrée
  const closes = candles.slice(0, entryIndex + 1).map(c => c.close);
  const volumes = candles.slice(0, entryIndex + 1).map(c => c.volume);
  
  const volumePattern = analyzeVolumePattern(volumes);
  const rsi = calcRSI(closes);
  const roc = calcROC(closes, 10);
  
  // Prix SL et TP
  const slPrice = entryPrice * (1 - CONFIG.STOP_LOSS_PCT / 100);
  const tpPrice = entryPrice * (1 + CONFIG.TAKE_PROFIT_PCT / 100);
  
  // Simuler le trade
  let exitPrice = null;
  let exitReason = null;
  let holdBars = 0;
  
  for (let i = entryIndex + 1; i < Math.min(candles.length, entryIndex + 192); i++) {
    const candle = candles[i];
    holdBars++;
    
    // Check SL
    if (candle.low <= slPrice) {
      exitPrice = slPrice;
      exitReason = 'stop_loss';
      break;
    }
    
    // Check TP
    if (candle.high >= tpPrice) {
      exitPrice = tpPrice;
      exitReason = 'take_profit';
      break;
    }
    
    // Max hold 48h (192 candles of 15min)
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
  const pnlWithLeverage = pnlPct * leverage - CONFIG.FEE_PCT;
  
  return {
    symbol,
    entryPrice,
    exitPrice,
    exitReason,
    holdBars,
    pnlPct,
    pnlWithLeverage,
    
    // Patterns au moment de l'entrée
    volumePattern,
    rsi,
    roc,
    
    isWin: pnlWithLeverage > 0,
    isSL: exitReason === 'stop_loss',
  };
}

// Vérifier les conditions d'entrée V5
function checkEntrySignal(candles, btcCandles, index) {
  if (index < 220) return false;
  
  const closes = candles.slice(0, index + 1).map(c => c.close);
  const volumes = candles.slice(0, index + 1).map(c => c.volume);
  const btcCloses = btcCandles.slice(0, index + 1).map(c => c.close);
  
  // BTC > SMA200
  const btcSma200 = calcSMA(btcCloses, 200);
  if (!btcSma200 || btcCloses[btcCloses.length - 1] <= btcSma200) return false;
  
  // Volume > 1.3x average
  const avgVol = calcSMA(volumes.slice(-20), 20);
  if (!avgVol || volumes[volumes.length - 1] < avgVol * CONFIG.MIN_VOL_RATIO) return false;
  
  // ROC > 1.5%
  const roc = calcROC(closes, 10);
  if (roc < CONFIG.MIN_ROC) return false;
  
  // Bollinger breakout
  const bb = calcBollingerBands(closes);
  if (!bb || closes[closes.length - 1] <= bb.upper) return false;
  
  // Consecutive up candles <= 4
  let consecUp = 0;
  for (let i = closes.length - 1; i > 0 && consecUp < 10; i--) {
    if (closes[i] > closes[i - 1]) consecUp++;
    else break;
  }
  if (consecUp > CONFIG.MAX_CONSEC_UP) return false;
  
  return true;
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 ANALYSE DES PATTERNS DE VOLUME AVANT STOP LOSS');
  console.log('═'.repeat(80));
  console.log();
  
  console.log('📊 Fetching 6 months of data...\n');
  
  // Fetch data with pagination to get 6 months
  const allData = {};
  for (const symbol of CONFIG.SYMBOLS) {
    const allCandles = [];
    let since = Date.now() - 6 * 30 * 24 * 60 * 60 * 1000; // 6 months ago
    
    while (allCandles.length < 17000) {
      const ohlcv = await exchange.fetchOHLCV(symbol, '15m', since, 1500);
      if (ohlcv.length === 0) break;
      allCandles.push(...ohlcv);
      since = ohlcv[ohlcv.length - 1][0] + 1;
      await new Promise(r => setTimeout(r, 100)); // Rate limit
    }
    
    allData[symbol] = allCandles.map(c => ({
      timestamp: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    }));
    console.log(`   ${symbol}: ${allData[symbol].length} candles`);
  }
  
  // Fetch BTC with pagination
  const btcCandles = [];
  let btcSince = Date.now() - 6 * 30 * 24 * 60 * 60 * 1000;
  while (btcCandles.length < 20000) {
    const ohlcv = await exchange.fetchOHLCV('BTC/USDT:USDT', '15m', btcSince, 1500);
    if (ohlcv.length === 0) break;
    btcCandles.push(...ohlcv.map(c => ({
      timestamp: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    })));
    btcSince = ohlcv[ohlcv.length - 1][0] + 1;
    await new Promise(r => setTimeout(r, 100));
  }
  console.log(`   BTC: ${btcCandles.length} candles\n`);
  
  // Simuler les trades
  const allTrades = [];
  
  for (const symbol of CONFIG.SYMBOLS) {
    const candles = allData[symbol];
    
    for (let i = 220; i < candles.length - 200; i++) {
      if (checkEntrySignal(candles, btcCandles, i)) {
        const trade = simulateTrade(candles, btcCandles, i, symbol);
        allTrades.push(trade);
        i += 10; // Skip 10 candles after entry
      }
    }
  }
  
  console.log(`📈 Total trades simulés: ${allTrades.length}\n`);
  
  // Séparer SL et Winners
  const slTrades = allTrades.filter(t => t.isSL);
  const winTrades = allTrades.filter(t => t.isWin && !t.isSL);
  
  console.log('═'.repeat(80));
  console.log('📊 ANALYSE DES PATTERNS DE VOLUME');
  console.log('═'.repeat(80));
  console.log();
  
  // Analyser les patterns de volume
  const avgSL = {
    decreasingCount: slTrades.reduce((s, t) => s + (t.volumePattern?.decreasingCount || 0), 0) / slTrades.length,
    volumeTrend: slTrades.reduce((s, t) => s + (t.volumePattern?.volumeTrend || 0), 0) / slTrades.length,
    currentVolRatio: slTrades.reduce((s, t) => s + (t.volumePattern?.currentVolRatio || 0), 0) / slTrades.length,
    volumeChange: slTrades.reduce((s, t) => s + (t.volumePattern?.volumeChange || 0), 0) / slTrades.length,
    rsi: slTrades.reduce((s, t) => s + (t.rsi || 0), 0) / slTrades.length,
    roc: slTrades.reduce((s, t) => s + (t.roc || 0), 0) / slTrades.length,
  };
  
  const avgWin = {
    decreasingCount: winTrades.reduce((s, t) => s + (t.volumePattern?.decreasingCount || 0), 0) / winTrades.length,
    volumeTrend: winTrades.reduce((s, t) => s + (t.volumePattern?.volumeTrend || 0), 0) / winTrades.length,
    currentVolRatio: winTrades.reduce((s, t) => s + (t.volumePattern?.currentVolRatio || 0), 0) / winTrades.length,
    volumeChange: winTrades.reduce((s, t) => s + (t.volumePattern?.volumeChange || 0), 0) / winTrades.length,
    rsi: winTrades.reduce((s, t) => s + (t.rsi || 0), 0) / winTrades.length,
    roc: winTrades.reduce((s, t) => s + (t.roc || 0), 0) / winTrades.length,
  };
  
  console.log('┌─────────────────────────┬──────────────┬──────────────┬────────────┐');
  console.log('│ Métrique                │  Stop Loss   │   Winners    │   Delta    │');
  console.log('├─────────────────────────┼──────────────┼──────────────┼────────────┤');
  console.log(`│ Vol Decreasing Count    │     ${avgSL.decreasingCount.toFixed(2).padStart(6)}   │     ${avgWin.decreasingCount.toFixed(2).padStart(6)}   │   ${(avgWin.decreasingCount - avgSL.decreasingCount).toFixed(2).padStart(6)}   │`);
  console.log(`│ Vol Trend (slope)       │   ${avgSL.volumeTrend.toFixed(1).padStart(7)}%  │   ${avgWin.volumeTrend.toFixed(1).padStart(7)}%  │  ${(avgWin.volumeTrend - avgSL.volumeTrend).toFixed(1).padStart(7)}%  │`);
  console.log(`│ Current Vol Ratio       │     ${avgSL.currentVolRatio.toFixed(2).padStart(6)}x  │     ${avgWin.currentVolRatio.toFixed(2).padStart(6)}x  │   ${(avgWin.currentVolRatio - avgSL.currentVolRatio).toFixed(2).padStart(6)}x  │`);
  console.log(`│ Vol Change (5 bars)     │   ${avgSL.volumeChange.toFixed(1).padStart(7)}%  │   ${avgWin.volumeChange.toFixed(1).padStart(7)}%  │  ${(avgWin.volumeChange - avgSL.volumeChange).toFixed(1).padStart(7)}%  │`);
  console.log(`│ RSI                     │     ${avgSL.rsi.toFixed(1).padStart(6)}   │     ${avgWin.rsi.toFixed(1).padStart(6)}   │   ${(avgWin.rsi - avgSL.rsi).toFixed(1).padStart(6)}   │`);
  console.log(`│ ROC 10                  │    ${avgSL.roc.toFixed(2).padStart(6)}%  │    ${avgWin.roc.toFixed(2).padStart(6)}%  │  ${(avgWin.roc - avgSL.roc).toFixed(2).padStart(6)}%  │`);
  console.log('└─────────────────────────┴──────────────┴──────────────┴────────────┘');
  
  console.log();
  console.log('═'.repeat(80));
  console.log('🔍 TEST DES FILTRES ANTI-STOP LOSS');
  console.log('═'.repeat(80));
  console.log();
  
  // Tester différents filtres basés sur le volume
  const filters = [
    { name: 'Vol Decreasing >= 3', fn: t => (t.volumePattern?.decreasingCount || 0) >= 3 },
    { name: 'Vol Decreasing >= 2', fn: t => (t.volumePattern?.decreasingCount || 0) >= 2 },
    { name: 'Vol Trend < -10%', fn: t => (t.volumePattern?.volumeTrend || 0) < -10 },
    { name: 'Vol Trend < -5%', fn: t => (t.volumePattern?.volumeTrend || 0) < -5 },
    { name: 'Vol Change < -20%', fn: t => (t.volumePattern?.volumeChange || 0) < -20 },
    { name: 'Vol Change < -30%', fn: t => (t.volumePattern?.volumeChange || 0) < -30 },
    { name: 'Vol Ratio < 1.5x', fn: t => (t.volumePattern?.currentVolRatio || 0) < 1.5 },
    { name: 'Vol Exhausting', fn: t => t.volumePattern?.isExhausting },
    { name: 'RSI > 75', fn: t => t.rsi > 75 },
    { name: 'RSI > 80', fn: t => t.rsi > 80 },
    { name: 'ROC > 4%', fn: t => t.roc > 4 },
    { name: 'Combo: VolDecr>=2 + VolTrend<-5', fn: t => (t.volumePattern?.decreasingCount || 0) >= 2 && (t.volumePattern?.volumeTrend || 0) < -5 },
    { name: 'Combo: VolDecr>=2 + RSI>70', fn: t => (t.volumePattern?.decreasingCount || 0) >= 2 && t.rsi > 70 },
    { name: 'Combo: VolTrend<-5 + RSI>70', fn: t => (t.volumePattern?.volumeTrend || 0) < -5 && t.rsi > 70 },
  ];
  
  console.log('Si on ÉVITE les trades avec ce filtre:\n');
  console.log('┌─────────────────────────────────────┬─────────┬─────────┬──────────┬──────────┬──────────┐');
  console.log('│ Filtre                              │ Évités  │ SL évit │ Win évit │ New WR   │ Verdict  │');
  console.log('├─────────────────────────────────────┼─────────┼─────────┼──────────┼──────────┼──────────┤');
  
  for (const filter of filters) {
    const tradesFiltered = allTrades.filter(filter.fn);
    const slFiltered = slTrades.filter(filter.fn);
    const winFiltered = winTrades.filter(filter.fn);
    
    const tradesKept = allTrades.filter(t => !filter.fn(t));
    const slKept = tradesKept.filter(t => t.isSL).length;
    const winKept = tradesKept.filter(t => t.isWin).length;
    const newWR = tradesKept.length > 0 ? (winKept / tradesKept.length * 100) : 0;
    
    const originalWR = (winTrades.length / allTrades.length) * 100;
    const verdict = newWR > originalWR + 2 ? '✅ BON' : newWR < originalWR - 2 ? '❌ PIRE' : '➖ ~';
    
    const slAvoidPct = slTrades.length > 0 ? (slFiltered.length / slTrades.length * 100) : 0;
    const winAvoidPct = winTrades.length > 0 ? (winFiltered.length / winTrades.length * 100) : 0;
    
    console.log(`│ ${filter.name.padEnd(35)} │ ${tradesFiltered.length.toString().padStart(5)}   │ ${slAvoidPct.toFixed(0).padStart(5)}%  │ ${winAvoidPct.toFixed(0).padStart(6)}%  │ ${newWR.toFixed(1).padStart(6)}%  │ ${verdict.padEnd(8)} │`);
  }
  
  console.log('└─────────────────────────────────────┴─────────┴─────────┴──────────┴──────────┴──────────┘');
  
  console.log();
  console.log('═'.repeat(80));
  console.log('📊 SIMULATION AVEC MEILLEUR FILTRE');
  console.log('═'.repeat(80));
  console.log();
  
  // Trouver le meilleur filtre
  let bestFilter = null;
  let bestImprovement = 0;
  const originalWR = (winTrades.length / allTrades.length) * 100;
  
  for (const filter of filters) {
    const tradesKept = allTrades.filter(t => !filter.fn(t));
    const winKept = tradesKept.filter(t => t.isWin).length;
    const newWR = tradesKept.length > 0 ? (winKept / tradesKept.length * 100) : 0;
    const improvement = newWR - originalWR;
    
    // Aussi considérer le nombre de trades gardés (pas trop peu)
    if (improvement > bestImprovement && tradesKept.length > allTrades.length * 0.5) {
      bestImprovement = improvement;
      bestFilter = filter;
    }
  }
  
  if (bestFilter) {
    const tradesKept = allTrades.filter(t => !bestFilter.fn(t));
    const totalPnL = tradesKept.reduce((s, t) => s + t.pnlWithLeverage, 0);
    const winKept = tradesKept.filter(t => t.isWin).length;
    
    console.log(`🏆 Meilleur filtre: "${bestFilter.name}"`);
    console.log();
    console.log(`   Trades originaux: ${allTrades.length}`);
    console.log(`   Trades gardés:    ${tradesKept.length} (${(tradesKept.length/allTrades.length*100).toFixed(0)}%)`);
    console.log(`   Win Rate avant:   ${originalWR.toFixed(1)}%`);
    console.log(`   Win Rate après:   ${(winKept/tradesKept.length*100).toFixed(1)}%`);
    console.log(`   Amélioration WR:  +${bestImprovement.toFixed(1)}%`);
    console.log();
    
    // Calculer ROI avec le filtre
    const roiWithFilter = totalPnL / (CONFIG.POSITION_SIZE_PCT);
    console.log(`   ROI avec filtre:  ${roiWithFilter >= 0 ? '+' : ''}${roiWithFilter.toFixed(1)}%`);
    
    // Comparer avec ROI original
    const originalPnL = allTrades.reduce((s, t) => s + t.pnlWithLeverage, 0);
    const originalROI = originalPnL / (CONFIG.POSITION_SIZE_PCT);
    console.log(`   ROI original:     ${originalROI >= 0 ? '+' : ''}${originalROI.toFixed(1)}%`);
    console.log(`   Gain ROI:         ${(roiWithFilter - originalROI) >= 0 ? '+' : ''}${(roiWithFilter - originalROI).toFixed(1)}%`);
  }
  
  console.log();
  console.log('═'.repeat(80));
  console.log('💡 RECOMMANDATION');
  console.log('═'.repeat(80));
  console.log();
  
  if (bestFilter && bestImprovement > 1) {
    console.log(`╔═══════════════════════════════════════════════════════════════════════════════╗`);
    console.log(`║ 🎯 FILTRE RECOMMANDÉ: ${bestFilter.name.padEnd(52)} ║`);
    console.log(`║                                                                               ║`);
    console.log(`║ Ce filtre améliore le Win Rate de +${bestImprovement.toFixed(1)}% en évitant les trades          ║`);
    console.log(`║ où le momentum du volume s'essouffle avant l'entrée.                          ║`);
    console.log(`╚═══════════════════════════════════════════════════════════════════════════════╝`);
  } else {
    console.log('❌ Aucun filtre de volume ne montre une amélioration significative.');
    console.log('   Les patterns de volume ne semblent pas être un bon prédicteur de stop loss.');
  }
}

main().catch(console.error);
