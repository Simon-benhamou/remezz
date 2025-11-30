/**
 * 🔬 ANALYSE INTELLIGENTE DES PATTERNS STOP-LOSS
 * 
 * Objectif: Identifier pourquoi certains SL font perdre plus que les wins rapportent
 * 
 * Hypothèses à tester:
 * 1. SL touchés pendant haute volatilité (ATR élevé) → slippage pire
 * 2. SL touchés après X bars → fatigue du setup
 * 3. SL touchés pendant régime contraire → signal invalide
 * 4. SL touchés après fausse cassure → besoin de confirmation
 * 5. Pattern de "stop hunt" avant reversal → SL trop serré
 * 6. Corrélation avec volume au moment du SL
 * 7. Heure de la journée du SL (volatilité asiatique vs US)
 * 8. Distance au support/résistance précédent
 */

import ccxt from 'ccxt';
import fs from 'fs';

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  LONG: {
    BB_PERIOD: 20,
    BB_STD: 2,
    ROC_MIN: 2.5,
    VOL_MULTIPLIER: 2.0,
    MAX_CONSEC_UP: 3,
  },
  SHORT: {
    ROC_DROP_MIN: -1.5,
    VOL_SPIKE: 2.0,
    MAX_CONSEC_DOWN: 5,
  },
  EXIT: {
    STOP_LOSS: 1.5,
    TAKE_PROFIT: 3.0,
    TRAILING_ACTIVATION: 1.0,
    TRAILING_DISTANCE: 0.4,
    MAX_HOLD_BARS: 192,
  },
  POSITION_SIZE_PCT: 0.4,
  LEVERAGE: 4.5,
};

const SYMBOLS = ['XRP/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'BTC/USDT:USDT'];

// ============================================================================
// INDICATORS
// ============================================================================

function calcSMA(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcStdDev(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
  return Math.sqrt(variance);
}

function calcBB(closes, period = 20, stdMult = 2) {
  const sma = calcSMA(closes, period);
  const std = calcStdDev(closes, period);
  if (!sma || !std) return null;
  return { middle: sma, upper: sma + std * stdMult, lower: sma - std * stdMult };
}

function calcROC(values, period) {
  if (values.length < period + 1) return null;
  const current = values[values.length - 1];
  const past = values[values.length - 1 - period];
  return ((current - past) / past) * 100;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  return calcSMA(trs.slice(-period), period);
}

function calcATRPercent(candles, period = 14) {
  const atr = calcATR(candles, period);
  if (!atr) return null;
  return (atr / candles[candles.length - 1].close) * 100;
}

function calcVolAvg(volumes, period = 20) {
  return calcSMA(volumes, period);
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function findSupport(candles, lookback = 50) {
  const lows = candles.slice(-lookback).map(c => c.low);
  return Math.min(...lows);
}

function findResistance(candles, lookback = 50) {
  const highs = candles.slice(-lookback).map(c => c.high);
  return Math.max(...highs);
}

function countConsecUp(candles) {
  let count = 0;
  for (let i = candles.length - 1; i > 0; i--) {
    if (candles[i].close > candles[i - 1].close) count++;
    else break;
  }
  return count;
}

function countConsecDown(candles) {
  let count = 0;
  for (let i = candles.length - 1; i > 0; i--) {
    if (candles[i].close < candles[i - 1].close) count++;
    else break;
  }
  return count;
}

// ============================================================================
// ENTRY CONDITIONS
// ============================================================================

function checkLongEntry(candles) {
  if (candles.length < 50) return false;
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  // BB
  const bb = calcBB(closes);
  if (!bb || current.close < bb.middle || current.close > bb.upper) return false;
  
  // ROC10 > 2.5%
  const roc10 = calcROC(closes, 10);
  if (!roc10 || roc10 < CONFIG.LONG.ROC_MIN) return false;
  
  // Volume > 2x
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * CONFIG.LONG.VOL_MULTIPLIER) return false;
  
  // ConsecUp <= 3
  if (countConsecUp(candles) > CONFIG.LONG.MAX_CONSEC_UP) return false;
  
  return true;
}

function checkShortEntry(candles) {
  if (candles.length < 50) return false;
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  if (current.close >= current.open) return false;
  
  const roc5 = calcROC(closes, 5);
  if (!roc5 || roc5 > CONFIG.SHORT.ROC_DROP_MIN) return false;
  
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * CONFIG.SHORT.VOL_SPIKE) return false;
  
  const ma20 = calcSMA(closes, 20);
  if (!ma20 || current.close >= ma20) return false;
  
  const bb = calcBB(closes);
  if (!bb || current.close >= bb.lower) return false;
  
  if (countConsecDown(candles) > CONFIG.SHORT.MAX_CONSEC_DOWN) return false;
  
  return true;
}

// ============================================================================
// DATA FETCHING
// ============================================================================

async function fetchCandles(symbol, months = 12) {
  console.log(`   Fetching ${symbol}...`);
  const since = Date.now() - months * 30 * 24 * 60 * 60 * 1000;
  const allCandles = [];
  let cursor = since;
  
  while (cursor < Date.now()) {
    const ohlcv = await exchange.fetchOHLCV(symbol, '15m', cursor, 1000);
    if (ohlcv.length === 0) break;
    for (const c of ohlcv) {
      allCandles.push({ timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] });
    }
    cursor = ohlcv[ohlcv.length - 1][0] + 1;
    await new Promise(r => setTimeout(r, 50));
  }
  console.log(`   ✓ ${symbol}: ${allCandles.length} candles`);
  return allCandles;
}

// ============================================================================
// MAIN ANALYSIS
// ============================================================================

async function analyzeStopLossPatterns() {
  console.log('═'.repeat(80));
  console.log('🔬 ANALYSE DES PATTERNS STOP-LOSS');
  console.log('═'.repeat(80));
  
  console.log('\n📊 Fetching 12 months of data...');
  const btcCandles = await fetchCandles('BTC/USDT:USDT', 12);
  const btcCloses = btcCandles.map(c => c.close);
  
  const allData = { 'BTC/USDT:USDT': btcCandles };
  for (const symbol of SYMBOLS.filter(s => s !== 'BTC/USDT:USDT')) {
    allData[symbol] = await fetchCandles(symbol, 12);
  }
  
  // Collect all trades with detailed context
  const allTrades = [];
  
  console.log('\n⏳ Running detailed backtest...');
  
  for (const symbol of SYMBOLS) {
    const candles = allData[symbol];
    const positions = {};
    let position = null;
    
    for (let idx = 200; idx < candles.length; idx++) {
      const btcIdx = btcCandles.findIndex(c => c.timestamp >= candles[idx].timestamp);
      if (btcIdx < 200) continue;
      
      const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
      const btcPrice = btcCloses[btcIdx - 1];
      const isBullRegime = btcPrice > btcSma200;
      
      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];
      const closes = windowCandles.map(c => c.close);
      
      // Manage existing position
      if (position) {
        const holdBars = idx - position.entryIdx;
        let exitReason = null;
        let exitPrice = current.close;
        
        const pnlPct = position.side === 'long'
          ? ((current.close - position.entryPrice) / position.entryPrice) * 100
          : ((position.entryPrice - current.close) / position.entryPrice) * 100;
        
        // Update HWM/LWM
        if (position.side === 'long') {
          position.hwm = Math.max(position.hwm || position.entryPrice, current.high);
          position.lwm = Math.min(position.lwm || position.entryPrice, current.low);
        } else {
          position.hwm = Math.max(position.hwm || position.entryPrice, current.high);
          position.lwm = Math.min(position.lwm || position.entryPrice, current.low);
        }
        
        // Check exits
        if (position.side === 'long') {
          const hwmPct = ((position.hwm - position.entryPrice) / position.entryPrice) * 100;
          
          // Check if price went BELOW SL level during this candle
          const slPrice = position.entryPrice * (1 - CONFIG.EXIT.STOP_LOSS / 100);
          if (current.low <= slPrice) {
            exitReason = 'SL';
            exitPrice = slPrice;
          } else if (pnlPct >= CONFIG.EXIT.TAKE_PROFIT) {
            exitReason = 'TP';
          } else if (hwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION) {
            const trailPrice = position.hwm * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100);
            if (current.low <= trailPrice) {
              exitReason = 'TRAIL';
              exitPrice = trailPrice;
            }
          } else if (holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) {
            exitReason = 'TIMEOUT';
          }
        } else {
          const lwmPct = ((position.entryPrice - position.lwm) / position.entryPrice) * 100;
          
          const slPrice = position.entryPrice * (1 + CONFIG.EXIT.STOP_LOSS / 100);
          if (current.high >= slPrice) {
            exitReason = 'SL';
            exitPrice = slPrice;
          } else if (pnlPct >= CONFIG.EXIT.TAKE_PROFIT) {
            exitReason = 'TP';
          } else if (lwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION) {
            const trailPrice = position.lwm * (1 + CONFIG.EXIT.TRAILING_DISTANCE / 100);
            if (current.high >= trailPrice) {
              exitReason = 'TRAIL';
              exitPrice = trailPrice;
            }
          } else if (holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) {
            exitReason = 'TIMEOUT';
          }
        }
        
        if (exitReason) {
          const finalPnlPct = position.side === 'long'
            ? ((exitPrice - position.entryPrice) / position.entryPrice) * 100
            : ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
          
          const leveragedPnlPct = finalPnlPct * CONFIG.LEVERAGE;
          
          // Collect detailed context at EXIT
          const exitAtr = calcATRPercent(windowCandles);
          const exitRsi = calcRSI(closes);
          const exitVolume = current.volume;
          const avgVolume = calcVolAvg(windowCandles.map(c => c.volume));
          const exitVolumeRatio = avgVolume ? exitVolume / avgVolume : 1;
          
          // Hour of exit (UTC)
          const exitHour = new Date(current.timestamp).getUTCHours();
          const exitDayOfWeek = new Date(current.timestamp).getUTCDay();
          
          // How much price moved AFTER exit (to detect premature SL)
          const barsAfterExit = Math.min(20, candles.length - idx - 1);
          let maxFavorableAfterExit = 0;
          let maxAdverseAfterExit = 0;
          for (let i = 1; i <= barsAfterExit; i++) {
            const futureCandle = candles[idx + i];
            if (position.side === 'long') {
              maxFavorableAfterExit = Math.max(maxFavorableAfterExit, 
                ((futureCandle.high - exitPrice) / exitPrice) * 100);
              maxAdverseAfterExit = Math.min(maxAdverseAfterExit,
                ((futureCandle.low - exitPrice) / exitPrice) * 100);
            } else {
              maxFavorableAfterExit = Math.max(maxFavorableAfterExit,
                ((exitPrice - futureCandle.low) / exitPrice) * 100);
              maxAdverseAfterExit = Math.min(maxAdverseAfterExit,
                ((exitPrice - futureCandle.high) / exitPrice) * 100);
            }
          }
          
          // Distance to support/resistance at entry
          const entrySupport = findSupport(candles.slice(0, position.entryIdx), 50);
          const entryResistance = findResistance(candles.slice(0, position.entryIdx), 50);
          const distToSupport = ((position.entryPrice - entrySupport) / position.entryPrice) * 100;
          const distToResistance = ((entryResistance - position.entryPrice) / position.entryPrice) * 100;
          
          // Was there a "stop hunt" pattern? (price spiked to SL then reversed)
          const isStopHunt = exitReason === 'SL' && maxFavorableAfterExit > CONFIG.EXIT.TAKE_PROFIT;
          
          // BB position at exit
          const exitBB = calcBB(closes);
          let bbPosition = 'middle';
          if (exitBB) {
            if (current.close >= exitBB.upper) bbPosition = 'above_upper';
            else if (current.close <= exitBB.lower) bbPosition = 'below_lower';
            else if (current.close > exitBB.middle) bbPosition = 'upper_half';
            else bbPosition = 'lower_half';
          }
          
          // ROC at exit
          const exitRoc5 = calcROC(closes, 5);
          const exitRoc10 = calcROC(closes, 10);
          
          // Consecutive bars in our direction at entry vs exit
          const entryConsecFavorable = position.side === 'long' 
            ? countConsecUp(candles.slice(0, position.entryIdx + 1))
            : countConsecDown(candles.slice(0, position.entryIdx + 1));
          
          const trade = {
            symbol,
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice,
            exitReason,
            pnlPct: finalPnlPct,
            leveragedPnlPct,
            holdBars,
            
            // Entry context
            entryAtr: position.entryAtr,
            entryRsi: position.entryRsi,
            entryVolumeRatio: position.entryVolumeRatio,
            entryHour: position.entryHour,
            entryDayOfWeek: position.entryDayOfWeek,
            entryBtcRegime: position.entryBtcRegime,
            entryConsecFavorable,
            distToSupportAtEntry: distToSupport,
            distToResistanceAtEntry: distToResistance,
            
            // Exit context  
            exitAtr,
            exitRsi,
            exitVolumeRatio,
            exitHour,
            exitDayOfWeek,
            exitBbPosition: bbPosition,
            exitRoc5,
            exitRoc10,
            
            // Post-exit analysis
            maxFavorableAfterExit,
            maxAdverseAfterExit,
            isStopHunt,
            
            // Timestamps
            entryTs: candles[position.entryIdx].timestamp,
            exitTs: current.timestamp,
          };
          
          allTrades.push(trade);
          position = null;
        }
      }
      
      // Check for new entry
      if (!position) {
        let side = null;
        if (isBullRegime && checkLongEntry(windowCandles)) {
          side = 'long';
        } else if (!isBullRegime && checkShortEntry(windowCandles)) {
          side = 'short';
        }
        
        if (side) {
          const entryAtr = calcATRPercent(windowCandles);
          const entryRsi = calcRSI(closes);
          const avgVolume = calcVolAvg(windowCandles.map(c => c.volume));
          const entryVolumeRatio = avgVolume ? current.volume / avgVolume : 1;
          const entryHour = new Date(current.timestamp).getUTCHours();
          const entryDayOfWeek = new Date(current.timestamp).getUTCDay();
          
          position = {
            symbol,
            side,
            entryPrice: current.close,
            entryIdx: idx,
            entryAtr,
            entryRsi,
            entryVolumeRatio,
            entryHour,
            entryDayOfWeek,
            entryBtcRegime: isBullRegime ? 'bull' : 'bear',
            hwm: current.close,
            lwm: current.close,
          };
        }
      }
    }
  }
  
  // ============================================================================
  // ANALYSIS
  // ============================================================================
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS DE L\'ANALYSE');
  console.log('═'.repeat(80));
  
  console.log(`\n📈 Total trades: ${allTrades.length}`);
  
  const slTrades = allTrades.filter(t => t.exitReason === 'SL');
  const tpTrades = allTrades.filter(t => t.exitReason === 'TP');
  const trailTrades = allTrades.filter(t => t.exitReason === 'TRAIL');
  const timeoutTrades = allTrades.filter(t => t.exitReason === 'TIMEOUT');
  
  console.log(`   SL: ${slTrades.length} (${(slTrades.length/allTrades.length*100).toFixed(1)}%)`);
  console.log(`   TP: ${tpTrades.length} (${(tpTrades.length/allTrades.length*100).toFixed(1)}%)`);
  console.log(`   TRAIL: ${trailTrades.length} (${(trailTrades.length/allTrades.length*100).toFixed(1)}%)`);
  console.log(`   TIMEOUT: ${timeoutTrades.length} (${(timeoutTrades.length/allTrades.length*100).toFixed(1)}%)`);
  
  const avgSlLoss = slTrades.length > 0 ? slTrades.reduce((s, t) => s + t.leveragedPnlPct, 0) / slTrades.length : 0;
  const avgWin = tpTrades.length > 0 ? tpTrades.reduce((s, t) => s + t.leveragedPnlPct, 0) / tpTrades.length : 0;
  const avgTrail = trailTrades.length > 0 ? trailTrades.reduce((s, t) => s + t.leveragedPnlPct, 0) / trailTrades.length : 0;
  
  console.log(`\n💰 PnL moyen (leveraged ${CONFIG.LEVERAGE}x):`);
  console.log(`   SL: ${avgSlLoss.toFixed(2)}%`);
  console.log(`   TP: +${avgWin.toFixed(2)}%`);
  console.log(`   TRAIL: ${avgTrail >= 0 ? '+' : ''}${avgTrail.toFixed(2)}%`);
  
  // ============================================================================
  // PATTERN 1: ATR au moment du SL
  // ============================================================================
  
  console.log('\n' + '─'.repeat(80));
  console.log('🔍 PATTERN 1: ATR (Volatilité) au moment de l\'exit');
  console.log('─'.repeat(80));
  
  const slByAtr = {
    low: slTrades.filter(t => t.exitAtr && t.exitAtr < 2),
    medium: slTrades.filter(t => t.exitAtr && t.exitAtr >= 2 && t.exitAtr < 4),
    high: slTrades.filter(t => t.exitAtr && t.exitAtr >= 4),
  };
  
  for (const [level, trades] of Object.entries(slByAtr)) {
    if (trades.length === 0) continue;
    const avgLoss = trades.reduce((s, t) => s + t.leveragedPnlPct, 0) / trades.length;
    const stopHuntRate = trades.filter(t => t.isStopHunt).length / trades.length * 100;
    console.log(`   ATR ${level}: ${trades.length} SL, avg loss: ${avgLoss.toFixed(2)}%, stop hunts: ${stopHuntRate.toFixed(1)}%`);
  }
  
  // ============================================================================
  // PATTERN 2: Heure de la journée
  // ============================================================================
  
  console.log('\n' + '─'.repeat(80));
  console.log('🔍 PATTERN 2: Heure UTC du Stop-Loss');
  console.log('─'.repeat(80));
  
  const hourBuckets = {
    'Asia (0-8h)': slTrades.filter(t => t.exitHour >= 0 && t.exitHour < 8),
    'Europe (8-16h)': slTrades.filter(t => t.exitHour >= 8 && t.exitHour < 16),
    'US (16-24h)': slTrades.filter(t => t.exitHour >= 16 && t.exitHour < 24),
  };
  
  for (const [session, trades] of Object.entries(hourBuckets)) {
    if (trades.length === 0) continue;
    const avgLoss = trades.reduce((s, t) => s + t.leveragedPnlPct, 0) / trades.length;
    const stopHuntRate = trades.filter(t => t.isStopHunt).length / trades.length * 100;
    console.log(`   ${session}: ${trades.length} SL, avg loss: ${avgLoss.toFixed(2)}%, stop hunts: ${stopHuntRate.toFixed(1)}%`);
  }
  
  // ============================================================================
  // PATTERN 3: Hold time avant SL
  // ============================================================================
  
  console.log('\n' + '─'.repeat(80));
  console.log('🔍 PATTERN 3: Durée avant Stop-Loss (en bars de 15min)');
  console.log('─'.repeat(80));
  
  const holdBuckets = {
    'Quick (<4 bars = 1h)': slTrades.filter(t => t.holdBars < 4),
    'Short (4-16 bars = 1-4h)': slTrades.filter(t => t.holdBars >= 4 && t.holdBars < 16),
    'Medium (16-48 bars = 4-12h)': slTrades.filter(t => t.holdBars >= 16 && t.holdBars < 48),
    'Long (48+ bars = 12h+)': slTrades.filter(t => t.holdBars >= 48),
  };
  
  for (const [bucket, trades] of Object.entries(holdBuckets)) {
    if (trades.length === 0) continue;
    const avgLoss = trades.reduce((s, t) => s + t.leveragedPnlPct, 0) / trades.length;
    const stopHuntRate = trades.filter(t => t.isStopHunt).length / trades.length * 100;
    const avgMaxFav = trades.reduce((s, t) => s + t.maxFavorableAfterExit, 0) / trades.length;
    console.log(`   ${bucket}: ${trades.length} SL, loss: ${avgLoss.toFixed(2)}%, hunts: ${stopHuntRate.toFixed(1)}%, reversal après: +${avgMaxFav.toFixed(2)}%`);
  }
  
  // ============================================================================
  // PATTERN 4: Stop Hunt Analysis (le plus important!)
  // ============================================================================
  
  console.log('\n' + '─'.repeat(80));
  console.log('🎯 PATTERN 4: STOP HUNT ANALYSIS (SL puis reversal > TP)');
  console.log('─'.repeat(80));
  
  const stopHunts = slTrades.filter(t => t.isStopHunt);
  const normalSL = slTrades.filter(t => !t.isStopHunt);
  
  console.log(`\n   Stop Hunts détectés: ${stopHunts.length} (${(stopHunts.length/slTrades.length*100).toFixed(1)}% des SL)`);
  console.log(`   SL normaux: ${normalSL.length}`);
  
  if (stopHunts.length > 0) {
    const avgStopHuntLoss = stopHunts.reduce((s, t) => s + t.leveragedPnlPct, 0) / stopHunts.length;
    const avgMissedGain = stopHunts.reduce((s, t) => s + t.maxFavorableAfterExit, 0) / stopHunts.length;
    console.log(`\n   📉 Perte moyenne sur Stop Hunt: ${avgStopHuntLoss.toFixed(2)}%`);
    console.log(`   📈 Gain moyen manqué après: +${avgMissedGain.toFixed(2)}%`);
    console.log(`   💸 Impact total manqué: ${(avgStopHuntLoss + avgMissedGain * CONFIG.LEVERAGE).toFixed(2)}%`);
    
    // Caractéristiques des stop hunts
    console.log(`\n   🔎 Caractéristiques des Stop Hunts:`);
    const avgHoldBars = stopHunts.reduce((s, t) => s + t.holdBars, 0) / stopHunts.length;
    const avgEntryAtr = stopHunts.reduce((s, t) => s + (t.entryAtr || 0), 0) / stopHunts.length;
    const avgEntryVol = stopHunts.reduce((s, t) => s + t.entryVolumeRatio, 0) / stopHunts.length;
    const avgDistSupport = stopHunts.reduce((s, t) => s + t.distToSupportAtEntry, 0) / stopHunts.length;
    
    console.log(`      Durée moyenne: ${avgHoldBars.toFixed(1)} bars (${(avgHoldBars*15/60).toFixed(1)}h)`);
    console.log(`      ATR moyen à l'entrée: ${avgEntryAtr.toFixed(2)}%`);
    console.log(`      Volume ratio à l'entrée: ${avgEntryVol.toFixed(2)}x`);
    console.log(`      Distance au support: ${avgDistSupport.toFixed(2)}%`);
    
    // Comparer avec les SL normaux
    const normalAvgHold = normalSL.reduce((s, t) => s + t.holdBars, 0) / normalSL.length;
    const normalAvgAtr = normalSL.reduce((s, t) => s + (t.entryAtr || 0), 0) / normalSL.length;
    const normalAvgVol = normalSL.reduce((s, t) => s + t.entryVolumeRatio, 0) / normalSL.length;
    const normalAvgDist = normalSL.reduce((s, t) => s + t.distToSupportAtEntry, 0) / normalSL.length;
    
    console.log(`\n   📊 Comparaison avec SL normaux:`);
    console.log(`      Durée: ${avgHoldBars.toFixed(1)} vs ${normalAvgHold.toFixed(1)} bars`);
    console.log(`      ATR entrée: ${avgEntryAtr.toFixed(2)}% vs ${normalAvgAtr.toFixed(2)}%`);
    console.log(`      Volume entrée: ${avgEntryVol.toFixed(2)}x vs ${normalAvgVol.toFixed(2)}x`);
    console.log(`      Dist support: ${avgDistSupport.toFixed(2)}% vs ${normalAvgDist.toFixed(2)}%`);
  }
  
  // ============================================================================
  // PATTERN 5: RSI à l'entrée et exit
  // ============================================================================
  
  console.log('\n' + '─'.repeat(80));
  console.log('🔍 PATTERN 5: RSI à l\'entrée (suracheté/survendu)');
  console.log('─'.repeat(80));
  
  const rsiAtEntry = {
    'Survendu (<30)': slTrades.filter(t => t.entryRsi && t.entryRsi < 30),
    'Normal (30-70)': slTrades.filter(t => t.entryRsi && t.entryRsi >= 30 && t.entryRsi <= 70),
    'Suracheté (>70)': slTrades.filter(t => t.entryRsi && t.entryRsi > 70),
  };
  
  for (const [level, trades] of Object.entries(rsiAtEntry)) {
    if (trades.length === 0) continue;
    const avgLoss = trades.reduce((s, t) => s + t.leveragedPnlPct, 0) / trades.length;
    const stopHuntRate = trades.filter(t => t.isStopHunt).length / trades.length * 100;
    console.log(`   ${level}: ${trades.length} SL, avg loss: ${avgLoss.toFixed(2)}%, stop hunts: ${stopHuntRate.toFixed(1)}%`);
  }
  
  // ============================================================================
  // PATTERN 6: Volume à l'entrée
  // ============================================================================
  
  console.log('\n' + '─'.repeat(80));
  console.log('🔍 PATTERN 6: Volume Ratio à l\'entrée');
  console.log('─'.repeat(80));
  
  const volAtEntry = {
    'Normal (2-3x)': slTrades.filter(t => t.entryVolumeRatio >= 2 && t.entryVolumeRatio < 3),
    'Élevé (3-5x)': slTrades.filter(t => t.entryVolumeRatio >= 3 && t.entryVolumeRatio < 5),
    'Très élevé (>5x)': slTrades.filter(t => t.entryVolumeRatio >= 5),
  };
  
  for (const [level, trades] of Object.entries(volAtEntry)) {
    if (trades.length === 0) continue;
    const avgLoss = trades.reduce((s, t) => s + t.leveragedPnlPct, 0) / trades.length;
    const stopHuntRate = trades.filter(t => t.isStopHunt).length / trades.length * 100;
    console.log(`   ${level}: ${trades.length} SL, avg loss: ${avgLoss.toFixed(2)}%, stop hunts: ${stopHuntRate.toFixed(1)}%`);
  }
  
  // ============================================================================
  // PATTERN 7: Par symbole
  // ============================================================================
  
  console.log('\n' + '─'.repeat(80));
  console.log('🔍 PATTERN 7: Par symbole');
  console.log('─'.repeat(80));
  
  for (const symbol of SYMBOLS) {
    const symbolSL = slTrades.filter(t => t.symbol === symbol);
    const symbolTP = tpTrades.filter(t => t.symbol === symbol);
    if (symbolSL.length === 0) continue;
    
    const avgLoss = symbolSL.reduce((s, t) => s + t.leveragedPnlPct, 0) / symbolSL.length;
    const stopHuntRate = symbolSL.filter(t => t.isStopHunt).length / symbolSL.length * 100;
    const avgWin = symbolTP.length > 0 ? symbolTP.reduce((s, t) => s + t.leveragedPnlPct, 0) / symbolTP.length : 0;
    const winRate = symbolTP.length / (symbolSL.length + symbolTP.length) * 100;
    
    console.log(`   ${symbol}:`);
    console.log(`      SL: ${symbolSL.length}, avg loss: ${avgLoss.toFixed(2)}%, hunts: ${stopHuntRate.toFixed(1)}%`);
    console.log(`      TP: ${symbolTP.length}, avg win: +${avgWin.toFixed(2)}%, WR: ${winRate.toFixed(1)}%`);
  }
  
  // ============================================================================
  // RECOMMENDATIONS
  // ============================================================================
  
  console.log('\n' + '═'.repeat(80));
  console.log('💡 RECOMMANDATIONS BASÉES SUR L\'ANALYSE');
  console.log('═'.repeat(80));
  
  // Find the worst patterns
  const stopHuntRateTotal = slTrades.length > 0 ? (stopHunts.length / slTrades.length * 100) : 0;
  
  console.log('\n📋 Facteurs identifiés pour les Stop-Loss prématurés:');
  
  if (stopHuntRateTotal > 10) {
    console.log(`\n   1. 🎯 STOP HUNTS (${stopHuntRateTotal.toFixed(1)}% des SL)`);
    console.log(`      → Le SL de ${CONFIG.EXIT.STOP_LOSS}% est trop serré pour cette volatilité`);
    console.log(`      → Solution: SL dynamique basé sur ATR (ex: 1.5 × ATR)`);
  }
  
  const quickSL = slTrades.filter(t => t.holdBars < 4);
  if (quickSL.length > slTrades.length * 0.3) {
    console.log(`\n   2. ⚡ SL RAPIDES (${(quickSL.length/slTrades.length*100).toFixed(1)}% en < 1h)`);
    console.log(`      → Entrées en période de haute volatilité`);
    console.log(`      → Solution: Confirmation sur 2ème bar, ou ATR filter à l'entrée`);
  }
  
  const highVolSL = slTrades.filter(t => t.exitAtr && t.exitAtr > 4);
  if (highVolSL.length > slTrades.length * 0.2) {
    console.log(`\n   3. 🌪️ SL EN HAUTE VOLATILITÉ (${(highVolSL.length/slTrades.length*100).toFixed(1)}%)`);
    console.log(`      → ATR > 4% au moment du SL`);
    console.log(`      → Solution: Élargir le SL quand ATR élevé`);
  }
  
  // Calculer impact potentiel
  if (stopHunts.length > 0) {
    const totalMissedGains = stopHunts.reduce((s, t) => s + t.maxFavorableAfterExit * CONFIG.LEVERAGE, 0);
    const totalLosses = stopHunts.reduce((s, t) => s + Math.abs(t.leveragedPnlPct), 0);
    
    console.log(`\n   📊 IMPACT POTENTIEL si on évite les Stop Hunts:`);
    console.log(`      Pertes évitées: ${totalLosses.toFixed(2)}%`);
    console.log(`      Gains récupérés: +${totalMissedGains.toFixed(2)}%`);
    console.log(`      Amélioration totale: +${(totalLosses + totalMissedGains).toFixed(2)}%`);
  }
  
  // Save results
  const results = {
    config: CONFIG,
    summary: {
      totalTrades: allTrades.length,
      slCount: slTrades.length,
      tpCount: tpTrades.length,
      trailCount: trailTrades.length,
      timeoutCount: timeoutTrades.length,
      avgSlLoss,
      avgWin,
      avgTrail,
      stopHuntRate: stopHuntRateTotal,
    },
    stopHunts: stopHunts.map(t => ({
      symbol: t.symbol,
      side: t.side,
      holdBars: t.holdBars,
      entryAtr: t.entryAtr,
      exitAtr: t.exitAtr,
      entryVolumeRatio: t.entryVolumeRatio,
      distToSupport: t.distToSupportAtEntry,
      maxFavorableAfterExit: t.maxFavorableAfterExit,
      entryTs: new Date(t.entryTs).toISOString(),
      exitTs: new Date(t.exitTs).toISOString(),
    })),
    allTrades: allTrades.map(t => ({
      symbol: t.symbol,
      side: t.side,
      exitReason: t.exitReason,
      pnlPct: t.pnlPct,
      leveragedPnlPct: t.leveragedPnlPct,
      holdBars: t.holdBars,
      entryAtr: t.entryAtr,
      exitAtr: t.exitAtr,
      entryVolumeRatio: t.entryVolumeRatio,
      isStopHunt: t.isStopHunt,
      maxFavorableAfterExit: t.maxFavorableAfterExit,
    })),
  };
  
  fs.writeFileSync('./data/sl-pattern-analysis.json', JSON.stringify(results, null, 2));
  console.log('\n✅ Résultats sauvegardés dans data/sl-pattern-analysis.json');
}

analyzeStopLossPatterns().catch(console.error);
