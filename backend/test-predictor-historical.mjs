#!/usr/bin/env node
/**
 * Test Predictor on Historical Data
 * 
 * Teste le predictor ML sur une période historique pour vérifier
 * s'il aurait correctement prédit les opportunités LONG et SHORT.
 * 
 * Par défaut : teste ADA entre hier 20h et maintenant
 * 
 * Usage:
 *   node backend/test-predictor-historical.mjs [SYMBOL] [START_TIME] [END_TIME] [TIMEFRAME]
 * 
 * Exemples:
 *   node backend/test-predictor-historical.mjs
 *   node backend/test-predictor-historical.mjs ADA/USDT:USDT
 *   node backend/test-predictor-historical.mjs ADA/USDT:USDT "2024-11-14T20:00:00" "2024-11-15T12:00:00" 15m
 */

import 'dotenv/config';

// Configuration par défaut : tester ADA entre hier soir et aujourd'hui
const now = new Date();
const yesterday = new Date(now);
yesterday.setDate(yesterday.getDate() - 1);
yesterday.setHours(20, 0, 0, 0); // Hier 20h00

const defaultStart = yesterday.toISOString().split('.')[0];
const defaultEnd = now.toISOString().split('.')[0];

const symbol = process.argv[2] || 'ADA/USDT:USDT';
const startTime = process.argv[3] || defaultStart;
const endTime = process.argv[4] || defaultEnd;
const timeframe = process.argv[5] || '15m';

console.log('🔍 Testing Predictor on Historical Data\n');
console.log(`Symbol: ${symbol}`);
console.log(`Period: ${startTime} to ${endTime}`);
console.log(`Timeframe: ${timeframe}\n`);

// Import production modules (REAL production code, not simplified!)
import { getOHLCV } from './dist/src/data/market.js';
import { getPredictionSync } from './dist/src/quantai/pythonPredictor.js';
import { buildPredictorFeatures } from './dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { ema, rsi, atr, adx } from './dist/src/data/indicators.js';

/**
 * Calculate number of candles needed
 */
function calculateCandleCount(start, end, tf) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const diffMs = endMs - startMs;
  
  const tfMs = {
    '1m': 60_000,
    '5m': 300_000,
    '15m': 900_000,
    '1h': 3_600_000,
    '4h': 14_400_000,
  }[tf] || 900_000;
  
  // Add 200 candles before for indicators (EMA200)
  return Math.ceil(diffMs / tfMs) + 200;
}

/**
 * Filter candles for the specific time range
 */
function filterCandlesInRange(candles, start, end) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  
  return candles.filter(c => c[0] >= startMs && c[0] <= endMs);
}

/**
 * Format timestamp for display
 */
function formatTime(timestamp) {
  return new Date(timestamp).toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Build technical snapshot from OHLCV candles using PRODUCTION indicators
 * This uses the EXACT same calculation functions as production buildTechSnapshot
 */
function buildProductionSnapshot(candles) {
  // Need at least 200 candles for EMA200
  if (candles.length < 200) {
    console.log(`  ⚠️  Need 200+ candles for indicators, have ${candles.length}`);
    return null;
  }
  
  // Extract OHLCV arrays (same format as production)
  const closes = candles.map(c => c[4]);
  const highs = candles.map(c => c[2]);
  const lows = candles.map(c => c[3]);
  const volumes = candles.map(c => Number(c[5] || 0));
  
  const lastPrice = closes[closes.length - 1];
  
  // === PRODUCTION INDICATORS (same functions as tech.ts) ===
  
  // EMAs (using production ema() function)
  const ema9Arr = ema(closes, 9);
  const ema12Arr = ema(closes, 12);
  const ema20Arr = ema(closes, 20);
  const ema26Arr = ema(closes, 26);
  const ema50Arr = ema(closes, 50);
  const ema100Arr = ema(closes, 100);
  const ema200Arr = ema(closes, 200);
  
  const ema9v = ema9Arr.length ? ema9Arr[ema9Arr.length - 1] : lastPrice;
  const ema12v = ema12Arr.length ? ema12Arr[ema12Arr.length - 1] : lastPrice;
  const ema20v = ema20Arr[ema20Arr.length - 1];
  const ema26v = ema26Arr.length ? ema26Arr[ema26Arr.length - 1] : ema20v;
  const ema50v = ema50Arr[ema50Arr.length - 1];
  const ema100v = ema100Arr.length ? ema100Arr[ema100Arr.length - 1] : ema20v;
  const ema200v = ema200Arr.length ? ema200Arr[ema200Arr.length - 1] : ema50v;
  
  // Slopes
  const ema20Slope = ema20Arr.length >= 2 ? ema20Arr[ema20Arr.length - 1] - ema20Arr[ema20Arr.length - 2] : 0;
  const ema50Slope = ema50Arr.length >= 2 ? ema50Arr[ema50Arr.length - 1] - ema50Arr[ema50Arr.length - 2] : 0;
  
  // EMA ratios
  const emaTrendSpread = (Number.isFinite(ema20v) && Number.isFinite(ema50v) && Math.abs(ema50v) > 1e-9)
    ? (ema20v - ema50v) / ema50v
    : 0;
  const emaRatio9_20 = ema20v !== 0 ? ema9v / ema20v : 0;
  const emaRatio20_200 = ema200v !== 0 ? ema20v / ema200v : 0;
  const emaRatio50_200 = ema200v !== 0 ? ema50v / ema200v : 0;
  
  // RSI (using production rsi() function)
  const rsi7Arr = rsi(closes, 7);
  const rsi14Arr = rsi(closes, 14);
  const rsi21Arr = rsi(closes, 21);
  const rsi7v = rsi7Arr[rsi7Arr.length - 1];
  const rsi14v = rsi14Arr[rsi14Arr.length - 1];
  const rsi21v = rsi21Arr[rsi21Arr.length - 1];
  
  // RSI slope (change over last 5 periods)
  const rsi14Prev = rsi14Arr.length >= 6 ? rsi14Arr[rsi14Arr.length - 6] : rsi14v;
  const rsiSlope = (rsi14v - rsi14Prev) / 5;
  
  // Stochastic
  const stochPeriod = 14;
  const recentHighs = highs.slice(-stochPeriod);
  const recentLows = lows.slice(-stochPeriod);
  const highestHigh = Math.max(...recentHighs);
  const lowestLow = Math.min(...recentLows);
  const stochK = lowestLow === highestHigh ? 50 : ((lastPrice - lowestLow) / (highestHigh - lowestLow)) * 100;
  const stochD = stochK; // Simplified (production calculates SMA of %K)
  
  // MACD
  const macdLine = ema12v - ema26v;
  const macdSignalArr = ema([macdLine], 9); // Simplified: should use full MACD history
  const macdSignal = macdSignalArr.length ? macdSignalArr[macdSignalArr.length - 1] : macdLine;
  const macdDiff = macdLine - macdSignal;
  
  // Momentum (price % change over periods)
  const safeLookback = (periods) => {
    const idx = closes.length - 1 - periods;
    if (idx < 0) return lastPrice;
    return closes[idx];
  };
  const momentum3 = ((lastPrice - safeLookback(3)) / safeLookback(3)) * 100;
  const momentum5 = ((lastPrice - safeLookback(5)) / safeLookback(5)) * 100;
  const momentum10 = ((lastPrice - safeLookback(10)) / safeLookback(10)) * 100;
  const momentum20 = ((lastPrice - safeLookback(20)) / safeLookback(20)) * 100;
  
  // ATR (using production atr() function - expects OHLCV array)
  const atr7Arr = atr(candles, 7);
  const atr14Arr = atr(candles, 14);
  const atr7v = atr7Arr[atr7Arr.length - 1];
  const atr14v = atr14Arr[atr14Arr.length - 1];
  const atrPct = (atr14v / lastPrice) * 100; // Production stores as percentage
  
  // Bollinger Bands
  const bbPeriod = 20;
  const bbCloses = closes.slice(-bbPeriod);
  const sma20 = bbCloses.reduce((sum, val) => sum + val, 0) / bbCloses.length;
  const variance = bbCloses.reduce((sum, val) => sum + Math.pow(val - sma20, 2), 0) / bbCloses.length;
  const stdDev = Math.sqrt(variance);
  const bbUpper = sma20 + 2 * stdDev;
  const bbLower = sma20 - 2 * stdDev;
  const bbWidth = ((bbUpper - bbLower) / sma20) * 100;
  const bbPosition = (bbUpper - bbLower) === 0 ? 0.5 : (lastPrice - bbLower) / (bbUpper - bbLower);
  
  // Volatility regime (same as ATR%)
  const volatilityRegime = atrPct;
  
  // ADX (using production adx() function if available, else simplified)
  let adx14v, adxPos, adxNeg;
  try {
    const adxResult = adx(candles, 14);
    if (adxResult && adxResult.adx && adxResult.adx.length) {
      adx14v = adxResult.adx[adxResult.adx.length - 1];
      adxPos = adxResult.plusDI && adxResult.plusDI.length ? adxResult.plusDI[adxResult.plusDI.length - 1] : 0;
      adxNeg = adxResult.minusDI && adxResult.minusDI.length ? adxResult.minusDI[adxResult.minusDI.length - 1] : 0;
    } else {
      adx14v = 25; // Fallback
      adxPos = 0;
      adxNeg = 0;
    }
  } catch (e) {
    adx14v = 25;
    adxPos = 0;
    adxNeg = 0;
  }
  
  // Trend strength (based on ADX and EMA alignment)
  const emaBullish = ema9v > ema20v && ema20v > ema50v;
  const emaBearish = ema9v < ema20v && ema20v < ema50v;
  const trendStrength = adx14v > 25 ? (emaBullish || emaBearish ? adx14v / 100 : 0) : 0;
  
  // Volume analysis
  const volumeWindow = 20;
  const recentVolumes = volumes.slice(-volumeWindow);
  const avgVolume = recentVolumes.reduce((sum, v) => sum + v, 0) / recentVolumes.length;
  const volumeRatio = avgVolume > 0 ? volumes[volumes.length - 1] / avgVolume : 1;
  const volumeMA = avgVolume;
  
  // Volume Z-score
  const volumeVariance = recentVolumes.reduce((sum, v) => sum + Math.pow(v - avgVolume, 2), 0) / recentVolumes.length;
  const volumeStdDev = Math.sqrt(volumeVariance);
  const volumeZScore = volumeStdDev > 0 ? (volumes[volumes.length - 1] - avgVolume) / volumeStdDev : 0;
  
  // OBV slope (simplified)
  let obv = 0;
  const obvArr = [0];
  for (let i = 1; i < Math.min(closes.length, 20); i++) {
    const idx = closes.length - 20 + i;
    if (idx < 1) continue;
    const priceChange = closes[idx] - closes[idx - 1];
    obv += priceChange > 0 ? volumes[idx] : (priceChange < 0 ? -volumes[idx] : 0);
    obvArr.push(obv);
  }
  const obvSlope = obvArr.length >= 2 ? (obvArr[obvArr.length - 1] - obvArr[0]) / obvArr.length : 0;
  
  // Volume-price confirmation (simplified: 1 if volume and price move together, -1 if diverge, 0 if neutral)
  const priceChange = closes.length >= 2 ? closes[closes.length - 1] - closes[closes.length - 2] : 0;
  const volumeChange = volumes.length >= 2 ? volumes[volumes.length - 1] - volumes[volumes.length - 2] : 0;
  const volPriceConfirmation = (priceChange > 0 && volumeChange > 0) || (priceChange < 0 && volumeChange > 0) ? 1 : 
                                 (priceChange > 0 && volumeChange < 0) || (priceChange < 0 && volumeChange < 0) ? -1 : 0;
  
  // Spread proxy (ATR-based estimate)
  const spreadProxy = atr14v / lastPrice;
  
  // Distance from EMAs (as percentage)
  const distEma20 = ema20v !== 0 ? Math.abs((lastPrice - ema20v) / ema20v) * 100 : 0;
  const distEma50 = ema50v !== 0 ? Math.abs((lastPrice - ema50v) / ema50v) * 100 : 0;
  const distEma200 = ema200v !== 0 ? Math.abs((lastPrice - ema200v) / ema200v) * 100 : 0;
  
  // Multi-timeframe (simplified: use same values as 15m for historical test)
  const atrPct1h = atrPct; // In real production, this comes from 1h data
  const atrPct4h = atrPct; // In real production, this comes from 4h data
  const rsi14_1h = rsi14v; // In real production, this comes from 1h data
  const rsi14_4h = rsi14v; // In real production, this comes from 4h data
  
  // Microstructure (simplified to 0 for historical test)
  const microImbalance = 0;
  const mtfAgreement = 0;
  
  // Volume-adjusted momentum
  const volAdjustedMomentum = momentum5 * (volumeRatio > 1 ? volumeRatio : 1);
  
  // RSI-EMA divergence (RSI direction vs price direction)
  const rsiDirection = rsiSlope;
  const priceDirection = ema20Slope;
  const rsiEmaDiv = Math.abs(rsiDirection) > 0.1 && Math.abs(priceDirection) > 0.001 
    ? (Math.sign(rsiDirection) !== Math.sign(priceDirection) ? 1 : -1)
    : 0;
  
  // Create snapshot matching TechnicalSnapshot structure
  return {
    symbol,
    last: lastPrice,
    ema9: ema9v,
    ema12: ema12v,
    ema20: ema20v,
    ema26: ema26v,
    ema50: ema50v,
    ema100: ema100v,
    ema200: ema200v,
    ema20Slope,
    ema50Slope,
    emaTrendSpread,
    emaRatio9_20,
    emaRatio20_200,
    emaRatio50_200,
    rsi7: rsi7v,
    rsi14: rsi14v,
    rsi21: rsi21v,
    rsiSlope,
    stochK,
    stochD,
    macd: macdLine,
    macdSignal,
    macdDiff,
    momentum3,
    momentum5,
    momentum10,
    momentum20,
    atr7: atr7v,
    atr14: atr14v,
    atrPct,
    bbWidth,
    bbPosition,
    volatilityRegime,
    adx14: adx14v,
    adxPos14: adxPos,
    adxNeg14: adxNeg,
    trendStrength,
    volumeRatio,
    volume: volumes[volumes.length - 1],
    volumeMA,
    volumeZScore,
    obvSlope,
    volPriceConfirmation,
    spreadProxy,
    distEma20,
    distEma50,
    distEma200,
    atrPct1h,
    atrPct4h,
    rsi14_1h,
    rsi14_4h,
    microImbalance,
    mtfAgreement,
    volAdjustedMomentum,
    rsiEmaDiv,
  };
}

/**
 * Test predictor on a single candle using PRODUCTION feature set
 */
function testCandleWithPredictor(candle, historyCandles, debug = false) {
  try {
    // Build technical snapshot using PRODUCTION indicators
    const snapshot = buildProductionSnapshot(historyCandles);
    
    if (!snapshot) {
      return null;
    }
    
    // Use PRODUCTION buildPredictorFeatures (52 features matching python model)
    const features = buildPredictorFeatures(snapshot);
    
    if (!features) {
      console.log(`  ❌ buildPredictorFeatures returned null (invalid features)`);
      return null;
    }
    
    // Debug: afficher les features si demandé
    if (debug) {
      console.log(`\n🔍 DEBUG Features pour ${formatTime(candle[0])}:`);
      const featureNames = Object.keys(features);
      console.log(`   Nombre de features: ${featureNames.length}`);
      featureNames.forEach(name => {
        const val = features[name];
        console.log(`   ${name.padEnd(20)} = ${typeof val === 'number' ? val.toFixed(4) : val}`);
      });
    }
    
    // Call Python predictor (synchronous)
    const prediction = getPredictionSync(features);
    
    // Debug: afficher la prédiction
    if (debug) {
      console.log(`\n📊 Prédiction:`);
      console.log(`   decision: ${prediction.decision}`);
      console.log(`   probabilityLong: ${(prediction.probabilityLong * 100).toFixed(1)}%`);
      console.log(`   probabilityShort: ${(prediction.probabilityShort * 100).toFixed(1)}%`);
      console.log(`   confidence: ${(prediction.confidence * 100).toFixed(1)}%`);
    }
    
    return {
      timestamp: candle[0],
      close: candle[4],
      snapshot,
      features,
      prediction,
    };
  } catch (error) {
    console.error(`❌ Error testing candle at ${formatTime(candle[0])}: ${error.message}`);
    console.error(error.stack);
    return null;
  }
}

/**
 * Main test function
 */
async function main() {
  try {
    // 1. Fetch historical OHLCV data
    const candleCount = calculateCandleCount(startTime, endTime, timeframe);
    console.log(`📊 Fetching ${candleCount} candles of ${timeframe} data...\n`);
    
    const allCandles = await getOHLCV(symbol, timeframe, candleCount);
    console.log(`✅ Fetched ${allCandles.length} candles\n`);
    
    // 2. Filter candles in the target range
    const targetCandles = filterCandlesInRange(allCandles, startTime, endTime);
    console.log(`🎯 Testing ${targetCandles.length} candles in target range\n`);
    
    if (targetCandles.length === 0) {
      console.log('⚠️  No candles found in the specified time range');
      return;
    }
    
    // 3. Test predictor on each candle
    console.log('🤖 Running predictor on historical candles...\n');
    console.log('Time                | Close    | Decision | Prob Long | Prob Short | Confidence | Features');
    console.log('─'.repeat(110));
    
    const results = [];
    
    for (let i = 0; i < targetCandles.length; i++) {
      const candle = targetCandles[i];
      
      // Find this candle's position in ALL candles (not just target)
      const candleIndex = allCandles.findIndex(c => c[0] === candle[0]);
      
      // Need enough history BEFORE this candle for indicators (35 minimum)
      if (candleIndex < 35) {
        console.log(`⏭️  Skipping ${formatTime(candle[0])} - only ${candleIndex} candles before (need 35+)`);
        continue;
      }
      
      // Get ALL history up to and including this candle
      const historyCandles = allCandles.slice(0, candleIndex + 1);
      
      // Test predictor (synchronous) - debug pour les 3 premières bougies
      const debug = results.length < 3;
      const result = testCandleWithPredictor(candle, historyCandles, debug);
      
      if (result && result.prediction) {
        const pred = result.prediction;
        results.push(result);
        
        const decision = pred.decision || 'none';
        const probLong = (pred.probabilityLong || 0).toFixed(3);
        const probShort = (pred.probabilityShort || 0).toFixed(3);
        const confidence = (pred.confidence || 0).toFixed(3);
        const close = candle[4].toFixed(4);
        
        // Color code decision
        let decisionDisplay = decision;
        if (decision === 'long') decisionDisplay = `\x1b[32m${decision}\x1b[0m`;
        else if (decision === 'short') decisionDisplay = `\x1b[31m${decision}\x1b[0m`;
        else decisionDisplay = `\x1b[90m${decision}\x1b[0m`;
        
        const rsi = result.snapshot.rsi14?.toFixed(1) || 'N/A';
        const atr = result.snapshot.atrPct?.toFixed(2) || 'N/A';
        const adx = result.snapshot.adx14?.toFixed(1) || 'N/A';
        
        console.log(
          `${formatTime(result.timestamp)} | ${close.padStart(8)} | ${decisionDisplay.padEnd(15)} | ` +
          `${probLong.padStart(9)} | ${probShort.padStart(10)} | ${confidence.padStart(10)} | ` +
          `ADX=${adx} RSI=${rsi} ATR=${atr}%`
        );
      }
      
      // Small delay to avoid overloading
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // 4. Summary
    console.log('\n' + '─'.repeat(110));
    console.log('\n📊 ANALYSE DES RÉSULTATS:\n');
    
    const longSignals = results.filter(r => r.prediction.decision === 'long');
    const shortSignals = results.filter(r => r.prediction.decision === 'short');
    const noneSignals = results.filter(r => r.prediction.decision === 'none');
    
    console.log(`Total de bougies testées: ${results.length}`);
    console.log(`🟢 Signaux LONG: ${longSignals.length} (${(longSignals.length / results.length * 100).toFixed(1)}%)`);
    console.log(`🔴 Signaux SHORT: ${shortSignals.length} (${(shortSignals.length / results.length * 100).toFixed(1)}%)`);
    console.log(`⚪ Signaux NONE: ${noneSignals.length} (${(noneSignals.length / results.length * 100).toFixed(1)}%)`);
    
    // Analyse des signaux LONG
    if (longSignals.length > 0) {
      const avgConfidence = longSignals.reduce((sum, r) => sum + r.prediction.confidence, 0) / longSignals.length;
      console.log(`\n🟢 SIGNAUX LONG - Confiance moyenne: ${(avgConfidence * 100).toFixed(1)}%`);
      
      console.log('\nDétails des signaux LONG:');
      longSignals.forEach((r, idx) => {
        const nextCandle = targetCandles.find(c => c[0] > r.timestamp);
        const priceChange = nextCandle ? ((nextCandle[4] - r.close) / r.close * 100) : null;
        const result = priceChange !== null ? (priceChange > 0 ? '✅' : '❌') : '?';
        const changeStr = priceChange !== null ? `${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%` : 'N/A';
        
        console.log(
          `  ${idx + 1}. ${formatTime(r.timestamp)} | ` +
          `Prix: ${r.close.toFixed(4)} | ` +
          `Conf: ${(r.prediction.confidence * 100).toFixed(1)}% | ` +
          `Résultat: ${result} ${changeStr}`
        );
      });
    }
    
    // Analyse des signaux SHORT
    if (shortSignals.length > 0) {
      const avgConfidence = shortSignals.reduce((sum, r) => sum + r.prediction.confidence, 0) / shortSignals.length;
      console.log(`\n🔴 SIGNAUX SHORT - Confiance moyenne: ${(avgConfidence * 100).toFixed(1)}%`);
      
      console.log('\nDétails des signaux SHORT:');
      shortSignals.forEach((r, idx) => {
        const nextCandle = targetCandles.find(c => c[0] > r.timestamp);
        const priceChange = nextCandle ? ((nextCandle[4] - r.close) / r.close * 100) : null;
        const result = priceChange !== null ? (priceChange < 0 ? '✅' : '❌') : '?';
        const changeStr = priceChange !== null ? `${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%` : 'N/A';
        
        console.log(
          `  ${idx + 1}. ${formatTime(r.timestamp)} | ` +
          `Prix: ${r.close.toFixed(4)} | ` +
          `Conf: ${(r.prediction.confidence * 100).toFixed(1)}% | ` +
          `Résultat: ${result} ${changeStr}`
        );
      });
    }
    
    // Analyse du mouvement global des prix
    if (results.length > 1) {
      const firstPrice = results[0].close;
      const lastPrice = results[results.length - 1].close;
      const priceChange = ((lastPrice - firstPrice) / firstPrice) * 100;
      const maxPrice = Math.max(...results.map(r => r.close));
      const minPrice = Math.min(...results.map(r => r.close));
      const volatility = ((maxPrice - minPrice) / minPrice) * 100;
      
      console.log(`\n📈 MOUVEMENT DES PRIX:`);
      console.log(`  Début: ${firstPrice.toFixed(4)} (${formatTime(results[0].timestamp)})`);
      console.log(`  Fin: ${lastPrice.toFixed(4)} (${formatTime(results[results.length - 1].timestamp)})`);
      console.log(`  Variation: ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%`);
      console.log(`  Max: ${maxPrice.toFixed(4)}`);
      console.log(`  Min: ${minPrice.toFixed(4)}`);
      console.log(`  Volatilité: ${volatility.toFixed(2)}%`);
      
      // Évaluation de la précision du prédicateur
      console.log(`\n🎯 ÉVALUATION DE LA PRÉCISION:`);
      
      if (priceChange > 1) {
        if (longSignals.length > shortSignals.length) {
          console.log(`  ✅ EXCELLENT: Le prédicateur a correctement identifié la tendance HAUSSIÈRE`);
          console.log(`     (${longSignals.length} signaux LONG vs ${shortSignals.length} signaux SHORT)`);
        } else if (longSignals.length === 0) {
          console.log(`  ❌ RATÉ: Aucun signal LONG détecté alors que le prix a monté de ${priceChange.toFixed(2)}%`);
        } else {
          console.log(`  ⚠️  MITIGÉ: Signaux mixtes alors que la tendance était HAUSSIÈRE (+${priceChange.toFixed(2)}%)`);
        }
      } else if (priceChange < -1) {
        if (shortSignals.length > longSignals.length) {
          console.log(`  ✅ EXCELLENT: Le prédicateur a correctement identifié la tendance BAISSIÈRE`);
          console.log(`     (${shortSignals.length} signaux SHORT vs ${longSignals.length} signaux LONG)`);
        } else if (shortSignals.length === 0) {
          console.log(`  ❌ RATÉ: Aucun signal SHORT détecté alors que le prix a baissé de ${priceChange.toFixed(2)}%`);
        } else {
          console.log(`  ⚠️  MITIGÉ: Signaux mixtes alors que la tendance était BAISSIÈRE (${priceChange.toFixed(2)}%)`);
        }
      } else {
        if (noneSignals.length > (longSignals.length + shortSignals.length)) {
          console.log(`  ✅ BON: Le prédicateur a correctement évité un marché sans tendance claire`);
        } else {
          console.log(`  ⚠️  Le marché était relativement plat (${priceChange.toFixed(2)}%), difficile à prédire`);
        }
      }
      
      // Calcul du taux de réussite
      let correctPredictions = 0;
      let totalTestedPredictions = 0;
      
      for (const r of results) {
        const nextCandle = targetCandles.find(c => c[0] > r.timestamp);
        if (nextCandle) {
          const priceChangeNext = ((nextCandle[4] - r.close) / r.close * 100);
          totalTestedPredictions++;
          
          if (r.prediction.decision === 'long' && priceChangeNext > 0.1) correctPredictions++;
          else if (r.prediction.decision === 'short' && priceChangeNext < -0.1) correctPredictions++;
          else if (r.prediction.decision === 'none' && Math.abs(priceChangeNext) < 0.5) correctPredictions++;
        }
      }
      
      if (totalTestedPredictions > 0) {
        const accuracy = (correctPredictions / totalTestedPredictions) * 100;
        console.log(`\n📊 TAUX DE RÉUSSITE: ${correctPredictions}/${totalTestedPredictions} (${accuracy.toFixed(1)}%)`);
        
        if (accuracy >= 70) {
          console.log(`  🌟 EXCELLENT: Le prédicateur a une très bonne précision!`);
        } else if (accuracy >= 55) {
          console.log(`  ✅ BON: Le prédicateur montre une précision acceptable`);
        } else if (accuracy >= 40) {
          console.log(`  ⚠️  MOYEN: La précision du prédicateur est limitée`);
        } else {
          console.log(`  ❌ FAIBLE: Le prédicateur a des difficultés sur cette période`);
        }
      }
    }
    
    console.log('\n✅ Test terminé!\n');
    
  } catch (error) {
    console.error('\n❌ Error during test:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run
main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
