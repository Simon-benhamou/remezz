/**
 * 🔬 BACKTEST LOCAL V5.6 - Analyse LONG vs SHORT + Patterns SL
 * 
 * Utilise les données locales JSON pour des backtests rapides et reproductibles
 * Analyse détaillée des patterns de stop loss pour trouver des filtres
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data', 'candles');

// ============================================================================
// CONFIGURATION V5.6
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
    PRICE_BELOW_MA20: true,
    PRICE_BELOW_BB_LOWER: true,
    MAX_CONSEC_DOWN: 5,
  },
  EXIT: {
    // V5.7: DYNAMIC ATR-BASED STOP LOSS
    STOP_LOSS_TYPE: 'atr',  // 'fixed' | 'atr'
    STOP_LOSS_FIXED: 1.5,  // Fallback
    STOP_LOSS_ATR_MULT: 2.0,
    STOP_LOSS_MIN: 0.8,
    STOP_LOSS_MAX: 3.0,
    TAKE_PROFIT: 3.0,
    TRAILING_ACTIVATION: 1.0,
    TRAILING_DISTANCE: 0.4,
    MAX_HOLD_BARS: 192,
  },
  POSITION_SIZE_PCT: 0.4,
  LEVERAGE: 4.5,
};

const COSTS = {
  TRADING_FEE_PCT: 0.04,
  SLIPPAGE_PCT: 0.05,
  FUNDING_RATE_PCT: 0.01,
  FUNDING_INTERVAL_BARS: 32,
};

const INITIAL_CAPITAL = 1000;

// ============================================================================
// LOAD LOCAL DATA
// ============================================================================

function loadLocalData(symbols) {
  const data = {};
  
  for (const symbol of symbols) {
    const filename = symbol.replace('/USDT:USDT', '').toLowerCase() + '-usdt.json';
    const filepath = path.join(DATA_DIR, filename);
    
    if (!fs.existsSync(filepath)) {
      console.log(`   ⚠️ ${symbol}: Fichier non trouvé (${filename})`);
      continue;
    }
    
    const json = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    data[symbol] = json.candles;
    console.log(`   ✅ ${symbol.padEnd(18)} ${String(json.candles.length).padStart(6)} candles`);
  }
  
  return data;
}

// ============================================================================
// INDICATORS
// ============================================================================

function calcSMA(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcBB(closes, period = 20, std = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return { middle: sma, upper: sma + std * stdDev, lower: sma - std * stdDev };
}

function calcROC(closes, period) {
  if (closes.length < period + 1) return null;
  return ((closes[closes.length - 1] - closes[closes.length - 1 - period]) / closes[closes.length - 1 - period]) * 100;
}

function calcVolAvg(volumes, period = 20) {
  if (volumes.length < period) return null;
  return volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function countConsecUp(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > candles[i].open) count++;
    else break;
  }
  return count;
}

function countConsecDown(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close < candles[i].open) count++;
    else break;
  }
  return count;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  
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

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1]?.close || candles[i].open;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrSum += tr;
  }
  return atrSum / period;
}

// V5.7: Dynamic stop loss based on ATR
function calcDynamicStopLoss(candles) {
  if (CONFIG.EXIT.STOP_LOSS_TYPE !== 'atr') {
    return { slPct: CONFIG.EXIT.STOP_LOSS_FIXED, atrPct: null };
  }
  
  const atr = calcATR(candles, 14);
  if (!atr || candles.length === 0) {
    return { slPct: CONFIG.EXIT.STOP_LOSS_FIXED, atrPct: null };
  }
  
  const currentPrice = candles[candles.length - 1].close;
  const atrPct = (atr / currentPrice) * 100;
  
  const rawSlPct = atrPct * CONFIG.EXIT.STOP_LOSS_ATR_MULT;
  const slPct = Math.min(
    CONFIG.EXIT.STOP_LOSS_MAX,
    Math.max(CONFIG.EXIT.STOP_LOSS_MIN, rawSlPct)
  );
  
  return { slPct, atrPct };
}

// Calcul du ratio wick/body pour détecter les rejections
function calcWickRatio(candle) {
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.close, candle.open);
  const lowerWick = Math.min(candle.close, candle.open) - candle.low;
  const totalWick = upperWick + lowerWick;
  return body > 0 ? totalWick / body : 0;
}

// Distance au support/résistance récent
function calcDistanceToSupport(candles, lookback = 20) {
  if (candles.length < lookback) return null;
  const lows = candles.slice(-lookback).map(c => c.low);
  const support = Math.min(...lows);
  const current = candles[candles.length - 1].close;
  return ((current - support) / support) * 100;
}

function calcDistanceToResistance(candles, lookback = 20) {
  if (candles.length < lookback) return null;
  const highs = candles.slice(-lookback).map(c => c.high);
  const resistance = Math.max(...highs);
  const current = candles[candles.length - 1].close;
  return ((resistance - current) / current) * 100;
}

// Momentum récent (somme ROC)
function calcMomentumSum(closes, periods = [3, 5, 10]) {
  let sum = 0;
  for (const p of periods) {
    const roc = calcROC(closes, p);
    if (roc !== null) sum += roc;
  }
  return sum;
}

// Volume trend
function calcVolumeTrend(volumes, shortPeriod = 5, longPeriod = 20) {
  if (volumes.length < longPeriod) return null;
  const shortAvg = volumes.slice(-shortPeriod).reduce((a, b) => a + b, 0) / shortPeriod;
  const longAvg = volumes.slice(-longPeriod).reduce((a, b) => a + b, 0) / longPeriod;
  return shortAvg / longAvg;
}

// ============================================================================
// ENTRY CHECKS
// ============================================================================

function checkLongEntry(candles) {
  if (candles.length < 50) return false;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  if (current.close <= current.open) return false;
  
  const bb = calcBB(closes, CONFIG.LONG.BB_PERIOD, CONFIG.LONG.BB_STD);
  if (!bb || current.close <= bb.upper) return false;
  
  const roc = calcROC(closes, 10);
  if (!roc || roc < CONFIG.LONG.ROC_MIN) return false;
  
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * CONFIG.LONG.VOL_MULTIPLIER) return false;
  
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
  
  if (CONFIG.SHORT.PRICE_BELOW_BB_LOWER) {
    const bb = calcBB(closes);
    if (!bb || current.close >= bb.lower) return false;
  }
  
  if (countConsecDown(candles) > CONFIG.SHORT.MAX_CONSEC_DOWN) return false;
  
  return true;
}

// ============================================================================
// CAPTURE ENTRY CONTEXT (pour analyse des patterns)
// ============================================================================

function captureEntryContext(candles, btcCandles, btcIdx) {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  const btcCloses = btcCandles.slice(0, btcIdx + 1).map(c => c.close);
  
  return {
    // Prix et momentum
    roc3: calcROC(closes, 3),
    roc5: calcROC(closes, 5),
    roc10: calcROC(closes, 10),
    roc20: calcROC(closes, 20),
    momentumSum: calcMomentumSum(closes),
    
    // RSI
    rsi14: calcRSI(closes, 14),
    rsi7: calcRSI(closes, 7),
    
    // Volatilité
    atr14: calcATR(candles, 14),
    atrPct: calcATR(candles, 14) ? (calcATR(candles, 14) / current.close) * 100 : null,
    
    // Volume
    volumeRatio: calcVolAvg(volumes, 5) / calcVolAvg(volumes, 20),
    volumeTrend: calcVolumeTrend(volumes),
    
    // Bollinger
    bb: calcBB(closes),
    bbWidth: (() => {
      const bb = calcBB(closes);
      return bb ? ((bb.upper - bb.lower) / bb.middle) * 100 : null;
    })(),
    priceVsBbMiddle: (() => {
      const bb = calcBB(closes);
      return bb ? ((current.close - bb.middle) / bb.middle) * 100 : null;
    })(),
    
    // Structure de la bougie
    wickRatio: calcWickRatio(current),
    bodyPct: (Math.abs(current.close - current.open) / current.open) * 100,
    upperWickPct: ((current.high - Math.max(current.close, current.open)) / current.open) * 100,
    lowerWickPct: ((Math.min(current.close, current.open) - current.low) / current.open) * 100,
    
    // Support/Résistance
    distToSupport: calcDistanceToSupport(candles, 20),
    distToResistance: calcDistanceToResistance(candles, 20),
    
    // Consecutive candles
    consecUp: countConsecUp(candles),
    consecDown: countConsecDown(candles),
    
    // BTC context
    btcRoc5: calcROC(btcCloses, 5),
    btcRoc10: calcROC(btcCloses, 10),
    btcRsi: calcRSI(btcCloses, 14),
    
    // Correlation récente avec BTC (5 dernières bougies)
    recentCorrelation: (() => {
      if (closes.length < 10 || btcCloses.length < 10) return null;
      const altReturns = [];
      const btcReturns = [];
      for (let i = 1; i <= 5; i++) {
        altReturns.push((closes[closes.length - i] - closes[closes.length - i - 1]) / closes[closes.length - i - 1]);
        btcReturns.push((btcCloses[btcCloses.length - i] - btcCloses[btcCloses.length - i - 1]) / btcCloses[btcCloses.length - i - 1]);
      }
      // Simple correlation
      const avgAlt = altReturns.reduce((a, b) => a + b, 0) / 5;
      const avgBtc = btcReturns.reduce((a, b) => a + b, 0) / 5;
      let num = 0, denAlt = 0, denBtc = 0;
      for (let i = 0; i < 5; i++) {
        num += (altReturns[i] - avgAlt) * (btcReturns[i] - avgBtc);
        denAlt += Math.pow(altReturns[i] - avgAlt, 2);
        denBtc += Math.pow(btcReturns[i] - avgBtc, 2);
      }
      return denAlt > 0 && denBtc > 0 ? num / Math.sqrt(denAlt * denBtc) : 0;
    })(),
  };
}

// ============================================================================
// PNL CALCULATOR
// ============================================================================

function calculatePnl(entryPrice, exitPrice, side, capitalUsed, holdBars) {
  let pnlPct = side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  const leveragedPnlPct = pnlPct * CONFIG.LEVERAGE;
  
  const entryFee = COSTS.TRADING_FEE_PCT * CONFIG.LEVERAGE;
  const exitFee = COSTS.TRADING_FEE_PCT * CONFIG.LEVERAGE;
  const slippage = COSTS.SLIPPAGE_PCT * 2 * CONFIG.LEVERAGE;
  const fundingPeriods = Math.floor(holdBars / COSTS.FUNDING_INTERVAL_BARS);
  const totalFunding = fundingPeriods * COSTS.FUNDING_RATE_PCT * CONFIG.LEVERAGE;
  
  const totalCosts = entryFee + exitFee + slippage + totalFunding;
  const netPnlPct = leveragedPnlPct - totalCosts;
  const netPnlUsd = (netPnlPct / 100) * capitalUsed;
  const costsUsd = (totalCosts / 100) * capitalUsed;
  
  return { grossPnlPct: pnlPct, leveragedPnlPct, netPnlPct, netPnlUsd, costsUsd };
}

// ============================================================================
// MAIN BACKTEST
// ============================================================================

async function main() {
  console.log('═'.repeat(90));
  console.log('🔬 BACKTEST LOCAL V5.6 - ANALYSE PATTERNS SL');
  console.log('═'.repeat(90));
  
  const SYMBOLS = [
    'BTC/USDT:USDT',
    'ETH/USDT:USDT',
    'XRP/USDT:USDT',
    'SOL/USDT:USDT',
    'ADA/USDT:USDT',
    'LINK/USDT:USDT',
    'SUI/USDT:USDT',
    'DOGE/USDT:USDT',
    'AVAX/USDT:USDT',
    'DOT/USDT:USDT',
    'SEI/USDT:USDT',
    'IMX/USDT:USDT',
  ];
  
  console.log('\n📂 Chargement des données locales...');
  const allData = loadLocalData(SYMBOLS);
  
  const btcCandles = allData['BTC/USDT:USDT'];
  if (!btcCandles) {
    console.error('❌ BTC data required for regime detection');
    return;
  }
  
  const btcCloses = btcCandles.map(c => c.close);
  
  // Results storage
  const allTrades = [];
  const resultsBySymbol = {};
  const resultsBySide = { long: [], short: [] };
  
  // SL Pattern analysis storage
  const slPatterns = { long: [], short: [] };
  const winPatterns = { long: [], short: [] };
  
  console.log('\n⏳ Running backtest on all symbols...\n');
  
  for (const symbol of SYMBOLS) {
    const candles = allData[symbol];
    if (!candles) continue;
    
    let capital = INITIAL_CAPITAL;
    const trades = [];
    let position = null;
    let cooldown = 0;
    
    for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
      const btcCandle = btcCandles[btcIdx];
      const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
      const btcPrice = btcCloses[btcIdx - 1];
      
      const isBullRegime = btcPrice > btcSma200;
      const isBearRegime = btcPrice < btcSma200;
      
      const idx = candles.findIndex(c => c.timestamp >= btcCandle.timestamp);
      if (idx < 50) continue;
      
      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];
      
      // MANAGE POSITION
      if (position) {
        const holdBars = idx - position.entryIdx;
        let exitReason = null, exitPrice = current.close;
        
        // V5.7: Use dynamic SL stored in position
        const slPct = position.slPct || CONFIG.EXIT.STOP_LOSS_FIXED;
        
        if (position.side === 'long') {
          const pnlPct = ((current.close - position.entryPrice) / position.entryPrice) * 100;
          position.hwm = Math.max(position.hwm || position.entryPrice, current.high);
          const hwmPct = ((position.hwm - position.entryPrice) / position.entryPrice) * 100;
          
          // Check TRAILING FIRST (protects gains before SL is hit)
          if (hwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION) {
            const trailStop = position.hwm * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100);
            if (current.low <= trailStop) { 
              exitReason = 'TRAIL'; 
              exitPrice = trailStop; 
            }
          }
          
          // Then check SL (only if trailing didn't trigger)
          if (!exitReason && pnlPct <= -slPct) {
            exitReason = 'SL';
            exitPrice = position.entryPrice * (1 - slPct / 100);
          } else if (!exitReason && pnlPct >= CONFIG.EXIT.TAKE_PROFIT) {
            exitReason = 'TP';
            exitPrice = position.entryPrice * (1 + CONFIG.EXIT.TAKE_PROFIT / 100);
          } else if (!exitReason && holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) {
            exitReason = 'TIME';
          }
        } else {
          const pnlPct = ((position.entryPrice - current.close) / position.entryPrice) * 100;
          position.lwm = Math.min(position.lwm || position.entryPrice, current.low);
          const lwmPct = ((position.entryPrice - position.lwm) / position.entryPrice) * 100;
          
          // Check TRAILING FIRST (protects gains before SL is hit)
          if (lwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION) {
            const trailStop = position.lwm * (1 + CONFIG.EXIT.TRAILING_DISTANCE / 100);
            if (current.high >= trailStop) { 
              exitReason = 'TRAIL'; 
              exitPrice = trailStop; 
            }
          }
          
          // Then check SL (only if trailing didn't trigger)
          if (!exitReason && pnlPct <= -slPct) {
            exitReason = 'SL';
            exitPrice = position.entryPrice * (1 + slPct / 100);
          } else if (!exitReason && pnlPct >= CONFIG.EXIT.TAKE_PROFIT) {
            exitReason = 'TP';
            exitPrice = position.entryPrice * (1 - CONFIG.EXIT.TAKE_PROFIT / 100);
          } else if (!exitReason && holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) {
            exitReason = 'TIME';
          }
        }
        
        if (exitReason) {
          const pnl = calculatePnl(position.entryPrice, exitPrice, position.side, position.capitalUsed, holdBars);
          capital += pnl.netPnlUsd;
          
          const trade = {
            symbol,
            side: position.side,
            entryTime: new Date(position.entryTime).toISOString(),
            exitTime: new Date(btcCandle.timestamp).toISOString(),
            entryPrice: position.entryPrice,
            exitPrice,
            holdBars,
            netPnlPct: pnl.netPnlPct,
            netPnlUsd: pnl.netPnlUsd,
            exitReason,
            capitalAfter: capital,
            entryContext: position.entryContext,
          };
          
          trades.push(trade);
          allTrades.push(trade);
          resultsBySide[position.side].push(trade);
          
          // Store patterns for SL analysis
          if (exitReason === 'SL') {
            slPatterns[position.side].push(position.entryContext);
          } else if (pnl.netPnlPct > 0) {
            winPatterns[position.side].push(position.entryContext);
          }
          
          position = null;
          cooldown = 8;
        }
      }
      
      // NEW ENTRY
      if (!position && cooldown <= 0 && capital > 100) {
        const capitalUsed = capital * CONFIG.POSITION_SIZE_PCT;
        const entryContext = captureEntryContext(windowCandles, btcCandles, btcIdx);
        
        // V5.7: Calculate dynamic SL based on ATR
        const { slPct } = calcDynamicStopLoss(windowCandles);
        
        if (isBullRegime && checkLongEntry(windowCandles)) {
          position = {
            side: 'long',
            entryPrice: current.close,
            entryIdx: idx,
            entryTime: btcCandle.timestamp,
            capitalUsed,
            hwm: current.close,
            entryContext,
            slPct, // V5.7: Store dynamic SL
          };
        } else if (isBearRegime && checkShortEntry(windowCandles)) {
          position = {
            side: 'short',
            entryPrice: current.close,
            entryIdx: idx,
            entryTime: btcCandle.timestamp,
            capitalUsed,
            lwm: current.close,
            entryContext,
            slPct, // V5.7: Store dynamic SL
          };
        }
      }
      
      if (cooldown > 0) cooldown--;
    }
    
    resultsBySymbol[symbol] = {
      trades,
      finalCapital: capital,
      roi: ((capital - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100,
    };
  }
  
  // ============================================================================
  // RESULTS BY SYMBOL
  // ============================================================================
  
  console.log('\n' + '═'.repeat(90));
  console.log('📊 RÉSULTATS PAR CRYPTO');
  console.log('═'.repeat(90));
  console.log('\n  Symbol           │ Trades │  LONG  │  SHORT │  WR%  │   ROI   │ L-WR% │ S-WR%');
  console.log('─'.repeat(90));
  
  for (const symbol of SYMBOLS) {
    const result = resultsBySymbol[symbol];
    if (!result) continue;
    
    const longTrades = result.trades.filter(t => t.side === 'long');
    const shortTrades = result.trades.filter(t => t.side === 'short');
    const wins = result.trades.filter(t => t.netPnlPct > 0);
    const longWins = longTrades.filter(t => t.netPnlPct > 0);
    const shortWins = shortTrades.filter(t => t.netPnlPct > 0);
    
    const wr = result.trades.length > 0 ? (wins.length / result.trades.length * 100) : 0;
    const lwr = longTrades.length > 0 ? (longWins.length / longTrades.length * 100) : 0;
    const swr = shortTrades.length > 0 ? (shortWins.length / shortTrades.length * 100) : 0;
    
    const roiStr = result.roi >= 0 ? `+${result.roi.toFixed(1)}%` : `${result.roi.toFixed(1)}%`;
    
    console.log(`  ${symbol.padEnd(16)} │  ${String(result.trades.length).padStart(4)}  │  ${String(longTrades.length).padStart(4)}  │  ${String(shortTrades.length).padStart(4)}  │ ${wr.toFixed(1).padStart(5)} │ ${roiStr.padStart(7)} │ ${lwr.toFixed(0).padStart(5)} │ ${swr.toFixed(0).padStart(5)}`);
  }
  
  // ============================================================================
  // LONG vs SHORT ANALYSIS
  // ============================================================================
  
  console.log('\n' + '═'.repeat(90));
  console.log('📈📉 ANALYSE LONG vs SHORT');
  console.log('═'.repeat(90));
  
  const longTrades = resultsBySide.long;
  const shortTrades = resultsBySide.short;
  
  const longWins = longTrades.filter(t => t.netPnlPct > 0);
  const shortWins = shortTrades.filter(t => t.netPnlPct > 0);
  const longSL = longTrades.filter(t => t.exitReason === 'SL');
  const shortSL = shortTrades.filter(t => t.exitReason === 'SL');
  
  console.log(`
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              COMPARAISON LONG vs SHORT                                   │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                       │        LONG        │       SHORT        │                       │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│  Total trades         │  ${String(longTrades.length).padStart(6)}             │  ${String(shortTrades.length).padStart(6)}             │                       │
│  Win Rate             │  ${(longWins.length / longTrades.length * 100).toFixed(1).padStart(6)}%            │  ${(shortWins.length / shortTrades.length * 100).toFixed(1).padStart(6)}%            │                       │
│  Stop Loss hits       │  ${String(longSL.length).padStart(6)} (${(longSL.length / longTrades.length * 100).toFixed(0)}%)        │  ${String(shortSL.length).padStart(6)} (${(shortSL.length / shortTrades.length * 100).toFixed(0)}%)        │                       │
│  Avg PnL (win)        │  ${(longWins.reduce((a, t) => a + t.netPnlPct, 0) / longWins.length).toFixed(1).padStart(6)}%            │  ${(shortWins.reduce((a, t) => a + t.netPnlPct, 0) / shortWins.length).toFixed(1).padStart(6)}%            │                       │
│  Avg PnL (loss)       │  ${(longTrades.filter(t => t.netPnlPct < 0).reduce((a, t) => a + t.netPnlPct, 0) / longTrades.filter(t => t.netPnlPct < 0).length).toFixed(1).padStart(6)}%            │  ${(shortTrades.filter(t => t.netPnlPct < 0).reduce((a, t) => a + t.netPnlPct, 0) / shortTrades.filter(t => t.netPnlPct < 0).length).toFixed(1).padStart(6)}%            │                       │
│  Total PnL            │  $${longTrades.reduce((a, t) => a + t.netPnlUsd, 0).toFixed(0).padStart(7)}           │  $${shortTrades.reduce((a, t) => a + t.netPnlUsd, 0).toFixed(0).padStart(7)}           │                       │
└─────────────────────────────────────────────────────────────────────────────────────────┘
`);

  // Exit reasons breakdown
  console.log('\n📊 RAISONS DE SORTIE:');
  console.log('─'.repeat(60));
  
  const longExitReasons = {};
  const shortExitReasons = {};
  longTrades.forEach(t => { longExitReasons[t.exitReason] = (longExitReasons[t.exitReason] || 0) + 1; });
  shortTrades.forEach(t => { shortExitReasons[t.exitReason] = (shortExitReasons[t.exitReason] || 0) + 1; });
  
  console.log('  LONG:');
  for (const [reason, count] of Object.entries(longExitReasons)) {
    console.log(`    ${reason.padEnd(6)}: ${String(count).padStart(4)} (${(count/longTrades.length*100).toFixed(1)}%)`);
  }
  console.log('  SHORT:');
  for (const [reason, count] of Object.entries(shortExitReasons)) {
    console.log(`    ${reason.padEnd(6)}: ${String(count).padStart(4)} (${(count/shortTrades.length*100).toFixed(1)}%)`);
  }

  // ============================================================================
  // PATTERN ANALYSIS FOR STOP LOSS
  // ============================================================================
  
  console.log('\n' + '═'.repeat(90));
  console.log('🔍 ANALYSE DES PATTERNS - STOP LOSS vs WINS');
  console.log('═'.repeat(90));
  
  // Analyze SHORT SL patterns
  console.log('\n📉 SHORTS qui touchent le STOP LOSS:');
  console.log('─'.repeat(90));
  
  if (slPatterns.short.length > 0) {
    // Calculate averages for SL shorts
    const avgSL = {
      roc3: slPatterns.short.reduce((a, p) => a + (p.roc3 || 0), 0) / slPatterns.short.length,
      roc5: slPatterns.short.reduce((a, p) => a + (p.roc5 || 0), 0) / slPatterns.short.length,
      roc10: slPatterns.short.reduce((a, p) => a + (p.roc10 || 0), 0) / slPatterns.short.length,
      rsi14: slPatterns.short.reduce((a, p) => a + (p.rsi14 || 0), 0) / slPatterns.short.length,
      atrPct: slPatterns.short.reduce((a, p) => a + (p.atrPct || 0), 0) / slPatterns.short.length,
      volumeRatio: slPatterns.short.reduce((a, p) => a + (p.volumeRatio || 0), 0) / slPatterns.short.length,
      bbWidth: slPatterns.short.reduce((a, p) => a + (p.bbWidth || 0), 0) / slPatterns.short.length,
      distToSupport: slPatterns.short.reduce((a, p) => a + (p.distToSupport || 0), 0) / slPatterns.short.length,
      btcRoc5: slPatterns.short.reduce((a, p) => a + (p.btcRoc5 || 0), 0) / slPatterns.short.length,
      consecDown: slPatterns.short.reduce((a, p) => a + (p.consecDown || 0), 0) / slPatterns.short.length,
      wickRatio: slPatterns.short.reduce((a, p) => a + (p.wickRatio || 0), 0) / slPatterns.short.length,
      lowerWickPct: slPatterns.short.reduce((a, p) => a + (p.lowerWickPct || 0), 0) / slPatterns.short.length,
    };
    
    // Calculate averages for winning shorts
    const avgWin = {
      roc3: winPatterns.short.reduce((a, p) => a + (p.roc3 || 0), 0) / winPatterns.short.length,
      roc5: winPatterns.short.reduce((a, p) => a + (p.roc5 || 0), 0) / winPatterns.short.length,
      roc10: winPatterns.short.reduce((a, p) => a + (p.roc10 || 0), 0) / winPatterns.short.length,
      rsi14: winPatterns.short.reduce((a, p) => a + (p.rsi14 || 0), 0) / winPatterns.short.length,
      atrPct: winPatterns.short.reduce((a, p) => a + (p.atrPct || 0), 0) / winPatterns.short.length,
      volumeRatio: winPatterns.short.reduce((a, p) => a + (p.volumeRatio || 0), 0) / winPatterns.short.length,
      bbWidth: winPatterns.short.reduce((a, p) => a + (p.bbWidth || 0), 0) / winPatterns.short.length,
      distToSupport: winPatterns.short.reduce((a, p) => a + (p.distToSupport || 0), 0) / winPatterns.short.length,
      btcRoc5: winPatterns.short.reduce((a, p) => a + (p.btcRoc5 || 0), 0) / winPatterns.short.length,
      consecDown: winPatterns.short.reduce((a, p) => a + (p.consecDown || 0), 0) / winPatterns.short.length,
      wickRatio: winPatterns.short.reduce((a, p) => a + (p.wickRatio || 0), 0) / winPatterns.short.length,
      lowerWickPct: winPatterns.short.reduce((a, p) => a + (p.lowerWickPct || 0), 0) / winPatterns.short.length,
    };
    
    console.log(`\n  Nombre de SHORT SL: ${slPatterns.short.length}`);
    console.log(`  Nombre de SHORT Wins: ${winPatterns.short.length}`);
    
    console.log(`\n  ┌─────────────────────┬──────────────┬──────────────┬──────────────┐`);
    console.log(`  │     Indicateur      │   SL Avg     │   Win Avg    │    Diff      │`);
    console.log(`  ├─────────────────────┼──────────────┼──────────────┼──────────────┤`);
    
    const indicators = [
      ['ROC3', avgSL.roc3, avgWin.roc3, '%'],
      ['ROC5', avgSL.roc5, avgWin.roc5, '%'],
      ['ROC10', avgSL.roc10, avgWin.roc10, '%'],
      ['RSI14', avgSL.rsi14, avgWin.rsi14, ''],
      ['ATR%', avgSL.atrPct, avgWin.atrPct, '%'],
      ['Vol Ratio', avgSL.volumeRatio, avgWin.volumeRatio, 'x'],
      ['BB Width', avgSL.bbWidth, avgWin.bbWidth, '%'],
      ['Dist Support', avgSL.distToSupport, avgWin.distToSupport, '%'],
      ['BTC ROC5', avgSL.btcRoc5, avgWin.btcRoc5, '%'],
      ['Consec Down', avgSL.consecDown, avgWin.consecDown, ''],
      ['Wick Ratio', avgSL.wickRatio, avgWin.wickRatio, 'x'],
      ['Lower Wick%', avgSL.lowerWickPct, avgWin.lowerWickPct, '%'],
    ];
    
    const significantDiffs = [];
    
    for (const [name, slVal, winVal, unit] of indicators) {
      const diff = slVal - winVal;
      const diffPct = winVal !== 0 ? (diff / Math.abs(winVal) * 100) : 0;
      const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '=';
      const highlight = Math.abs(diffPct) > 30 ? '⚠️' : '  ';
      
      console.log(`  │ ${name.padEnd(18)} │ ${slVal.toFixed(2).padStart(10)}${unit.padEnd(2)}│ ${winVal.toFixed(2).padStart(10)}${unit.padEnd(2)}│ ${arrow} ${diff.toFixed(2).padStart(7)} ${highlight}│`);
      
      if (Math.abs(diffPct) > 30) {
        significantDiffs.push({ name, slVal, winVal, diff, diffPct });
      }
    }
    
    console.log(`  └─────────────────────┴──────────────┴──────────────┴──────────────┘`);
    
    // ========================================================================
    // IDENTIFY POTENTIAL FILTERS
    // ========================================================================
    
    console.log('\n' + '═'.repeat(90));
    console.log('💡 PATTERNS DISCRIMINANTS IDENTIFIÉS');
    console.log('═'.repeat(90));
    
    if (significantDiffs.length > 0) {
      console.log('\n  Différences significatives (>30%) entre SL et Wins:');
      for (const d of significantDiffs) {
        console.log(`    ⚠️ ${d.name}: SL=${d.slVal.toFixed(2)} vs Win=${d.winVal.toFixed(2)} (diff: ${d.diffPct.toFixed(0)}%)`);
      }
    }
    
    // Test specific filter thresholds
    console.log('\n\n📊 TEST DE FILTRES POTENTIELS POUR SHORT:');
    console.log('─'.repeat(90));
    
    const filterTests = [
      {
        name: 'RSI < 25 (oversold)',
        check: (p) => p.rsi14 < 25,
        description: 'Éviter shorts quand RSI très bas (rebond probable)'
      },
      {
        name: 'RSI < 30',
        check: (p) => p.rsi14 < 30,
        description: 'Éviter shorts en zone de survente'
      },
      {
        name: 'ROC5 < -5%',
        check: (p) => p.roc5 < -5,
        description: 'Éviter quand déjà en chute libre'
      },
      {
        name: 'Lower Wick > 0.3%',
        check: (p) => p.lowerWickPct > 0.3,
        description: 'Éviter si grosse mèche basse (acheteurs présents)'
      },
      {
        name: 'Dist Support < 2%',
        check: (p) => p.distToSupport < 2,
        description: 'Éviter si proche du support'
      },
      {
        name: 'BTC ROC5 > 0',
        check: (p) => p.btcRoc5 > 0,
        description: 'Éviter si BTC monte (divergence)'
      },
      {
        name: 'ATR% > 3%',
        check: (p) => p.atrPct > 3,
        description: 'Éviter en haute volatilité'
      },
      {
        name: 'Consec Down > 3',
        check: (p) => p.consecDown > 3,
        description: 'Éviter après trop de bougies rouges'
      },
    ];
    
    console.log('\n  ┌────────────────────────────┬────────────────┬────────────────┬──────────────────┐');
    console.log('  │         Filtre             │  SL évités     │  Wins perdus   │   Ratio          │');
    console.log('  ├────────────────────────────┼────────────────┼────────────────┼──────────────────┤');
    
    const goodFilters = [];
    
    for (const filter of filterTests) {
      const slFiltered = slPatterns.short.filter(filter.check).length;
      const winFiltered = winPatterns.short.filter(filter.check).length;
      
      const slPct = (slFiltered / slPatterns.short.length * 100).toFixed(0);
      const winPct = (winFiltered / winPatterns.short.length * 100).toFixed(0);
      const ratio = winFiltered > 0 ? (slFiltered / winFiltered).toFixed(2) : '∞';
      
      // Un bon filtre: évite beaucoup de SL mais peu de Wins (ratio > 2)
      const quality = slFiltered > winFiltered * 2 && winFiltered < winPatterns.short.length * 0.1 ? '✅' : 
                      slFiltered > winFiltered ? '⚠️' : '❌';
      
      console.log(`  │ ${filter.name.padEnd(26)} │ ${String(slFiltered).padStart(4)} (${slPct.padStart(3)}%)    │ ${String(winFiltered).padStart(4)} (${winPct.padStart(3)}%)    │ ${ratio.padStart(5)} ${quality}         │`);
      
      if (slFiltered > winFiltered * 2 && winFiltered < winPatterns.short.length * 0.15) {
        goodFilters.push({
          ...filter,
          slFiltered,
          winFiltered,
          ratio: parseFloat(ratio),
          effectiveness: slFiltered / slPatterns.short.length * 100
        });
      }
    }
    
    console.log('  └────────────────────────────┴────────────────┴────────────────┴──────────────────┘');
    
    // RECOMMENDATIONS
    console.log('\n' + '═'.repeat(90));
    console.log('🎯 RECOMMANDATIONS DE FILTRES');
    console.log('═'.repeat(90));
    
    if (goodFilters.length > 0) {
      console.log('\n  Filtres recommandés (évitent >2x plus de SL que de Wins):');
      for (const f of goodFilters.sort((a, b) => b.ratio - a.ratio)) {
        console.log(`\n    ✅ ${f.name}`);
        console.log(`       ${f.description}`);
        console.log(`       Impact: -${f.slFiltered} SL (${f.effectiveness.toFixed(0)}%), -${f.winFiltered} Wins`);
        console.log(`       Ratio: ${f.ratio}x (évite ${f.ratio}x plus de SL que de wins)`);
      }
    } else {
      console.log('\n  ⚠️ Aucun filtre simple n\'a été trouvé avec un ratio >2x');
      console.log('     Les patterns de SL et Wins sont trop similaires.');
    }
    
    // Combined filter test
    console.log('\n\n📊 TEST COMBINAISON DE FILTRES:');
    console.log('─'.repeat(90));
    
    // Test combinaisons
    const combos = [
      {
        name: 'RSI < 28 OR Dist Support < 2%',
        check: (p) => p.rsi14 < 28 || p.distToSupport < 2,
      },
      {
        name: 'RSI < 30 AND Lower Wick > 0.2%',
        check: (p) => p.rsi14 < 30 && p.lowerWickPct > 0.2,
      },
      {
        name: '(RSI < 28) OR (ROC5 < -5 AND BTC ROC5 > 0)',
        check: (p) => p.rsi14 < 28 || (p.roc5 < -5 && p.btcRoc5 > 0),
      },
    ];
    
    for (const combo of combos) {
      const slFiltered = slPatterns.short.filter(combo.check).length;
      const winFiltered = winPatterns.short.filter(combo.check).length;
      const ratio = winFiltered > 0 ? (slFiltered / winFiltered).toFixed(2) : '∞';
      const quality = slFiltered > winFiltered * 2 ? '✅' : slFiltered > winFiltered ? '⚠️' : '❌';
      
      console.log(`\n    ${combo.name}`);
      console.log(`    SL évités: ${slFiltered}/${slPatterns.short.length} (${(slFiltered/slPatterns.short.length*100).toFixed(0)}%)`);
      console.log(`    Wins perdus: ${winFiltered}/${winPatterns.short.length} (${(winFiltered/winPatterns.short.length*100).toFixed(0)}%)`);
      console.log(`    Ratio: ${ratio}x ${quality}`);
    }
  }
  
  // Also analyze LONG SL patterns briefly
  console.log('\n\n📈 LONGS qui touchent le STOP LOSS (résumé):');
  console.log('─'.repeat(60));
  console.log(`  SL: ${slPatterns.long.length} | Wins: ${winPatterns.long.length}`);
  
  if (slPatterns.long.length > 0 && winPatterns.long.length > 0) {
    const avgSL_RSI = slPatterns.long.reduce((a, p) => a + (p.rsi14 || 0), 0) / slPatterns.long.length;
    const avgWin_RSI = winPatterns.long.reduce((a, p) => a + (p.rsi14 || 0), 0) / winPatterns.long.length;
    const avgSL_ROC = slPatterns.long.reduce((a, p) => a + (p.roc10 || 0), 0) / slPatterns.long.length;
    const avgWin_ROC = winPatterns.long.reduce((a, p) => a + (p.roc10 || 0), 0) / winPatterns.long.length;
    
    console.log(`  RSI14: SL avg=${avgSL_RSI.toFixed(1)} vs Win avg=${avgWin_RSI.toFixed(1)}`);
    console.log(`  ROC10: SL avg=${avgSL_ROC.toFixed(1)}% vs Win avg=${avgWin_ROC.toFixed(1)}%`);
  }
  
  // Save detailed results
  const outputPath = path.join(DATA_DIR, '..', 'backtest-sl-analysis.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    summary: {
      totalTrades: allTrades.length,
      longTrades: longTrades.length,
      shortTrades: shortTrades.length,
      longWinRate: (longWins.length / longTrades.length * 100).toFixed(1),
      shortWinRate: (shortWins.length / shortTrades.length * 100).toFixed(1),
    },
    slPatterns: {
      short: slPatterns.short.length,
      long: slPatterns.long.length,
    },
    resultsBySymbol: Object.fromEntries(
      Object.entries(resultsBySymbol).map(([s, r]) => [s, { 
        trades: r.trades.length, 
        roi: r.roi.toFixed(1),
        longTrades: r.trades.filter(t => t.side === 'long').length,
        shortTrades: r.trades.filter(t => t.side === 'short').length,
      }])
    ),
  }, null, 2));
  
  console.log(`\n\n📁 Résultats sauvegardés: ${outputPath}`);
}

main().catch(console.error);
