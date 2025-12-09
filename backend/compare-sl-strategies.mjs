/**
 * 🔬 STOP LOSS STRATEGIES COMPARISON - REALISTIC FOR LIVE
 * 
 * Test 3 stratégies réalistes pour le live trading:
 * 
 * 1. ATR DYNAMIQUE PAR CRYPTO
 *    - SL basé sur ATR × multiplier différent par crypto
 *    - Simple, compatible live
 * 
 * 2. SL LARGE + TRAILING AGRESSIF
 *    - SL initial large (ATR × 3.0)
 *    - Mais trailing activé plus tôt (+0.5%)
 *    - Compatible live
 * 
 * 3. SUPPORT/RESISTANCE SL
 *    - SL placé juste au-delà du support/resistance
 *    - Compatible live (SL calculé à l'entrée)
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

// ============================================================================
// CONFIGURATION
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
    MAX_CONSEC_DOWN: 4,
  },
  TAKE_PROFIT: 3.0,
  MAX_HOLD_BARS: 48,
  LEVERAGE: 4.5,
};

const COSTS = {
  TRADING_FEE_PCT: 0.04,
  SLIPPAGE_PCT: 0.05,
};

// ============================================================================
// ATR MULTIPLIERS PAR CRYPTO (Strategy 1)
// ============================================================================

const CRYPTO_ATR_MULTIPLIERS = {
  'BTC/USDT:USDT': 2.0,   // Moins volatil
  'ETH/USDT:USDT': 2.2,   // Légèrement volatil
  'SOL/USDT:USDT': 2.5,   // Volatilité moyenne
  'XRP/USDT:USDT': 2.5,   // Volatilité moyenne
  'DOGE/USDT:USDT': 3.0,  // Très volatil
  'AVAX/USDT:USDT': 2.5,  // Volatilité moyenne
  'DOT/USDT:USDT': 2.5,   // Volatilité moyenne
  'LINK/USDT:USDT': 2.5,  // Volatilité moyenne
};

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
  return { middle: sma, upper: sma + std * Math.sqrt(variance), lower: sma - std * Math.sqrt(variance) };
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

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - (candles[i - 1]?.close || candles[i].open)),
      Math.abs(candles[i].low - (candles[i - 1]?.close || candles[i].open))
    );
    atrSum += tr;
  }
  return atrSum / period;
}

function findSupport(candles, lookback = 30) {
  if (candles.length < lookback) return null;
  return Math.min(...candles.slice(-lookback).map(c => c.low));
}

function findResistance(candles, lookback = 30) {
  if (candles.length < lookback) return null;
  return Math.max(...candles.slice(-lookback).map(c => c.high));
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
  const bb = calcBB(closes);
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
  const bb = calcBB(closes);
  if (!bb || current.close >= bb.lower) return false;
  if (countConsecDown(candles) > CONFIG.SHORT.MAX_CONSEC_DOWN) return false;
  return true;
}

// ============================================================================
// LOAD DATA
// ============================================================================

function loadLocalData(symbols) {
  const data = {};
  for (const symbol of symbols) {
    const base = symbol.replace('/USDT:USDT', '').toUpperCase();
    const filename = `${base}_USDT_1h.json`;
    const filepath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filepath)) continue;
    data[symbol] = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  }
  return data;
}

// ============================================================================
// STRATEGIES DEFINITION
// ============================================================================

const STRATEGIES = {
  // STRATEGY 0: Current (ATR × 2.0 uniform)
  'CURRENT_ATR_2.0': {
    name: 'Current (ATR × 2.0)',
    getSL: (candles, entry, side, symbol) => {
      const atr = calcATR(candles);
      const slPct = atr ? Math.min(3.0, Math.max(0.8, (atr / entry) * 100 * 2.0)) : 1.5;
      return side === 'long' ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
    },
    trailingActivation: 1.0,
    trailingDistance: 0.4,
  },
  
  // STRATEGY 1: ATR dynamique par crypto
  'ATR_PER_CRYPTO': {
    name: 'ATR Dynamique par Crypto',
    getSL: (candles, entry, side, symbol) => {
      const mult = CRYPTO_ATR_MULTIPLIERS[symbol] || 2.5;
      const atr = calcATR(candles);
      const slPct = atr ? Math.min(4.0, Math.max(0.8, (atr / entry) * 100 * mult)) : 2.0;
      return side === 'long' ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
    },
    trailingActivation: 1.0,
    trailingDistance: 0.4,
  },
  
  // STRATEGY 2: SL large + Trailing agressif
  'WIDE_SL_TIGHT_TRAIL': {
    name: 'SL Large + Trailing Agressif',
    getSL: (candles, entry, side, symbol) => {
      const atr = calcATR(candles);
      const slPct = atr ? Math.min(4.5, Math.max(1.0, (atr / entry) * 100 * 3.0)) : 2.5;
      return side === 'long' ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
    },
    trailingActivation: 0.5,  // Activate trailing at +0.5% instead of +1%
    trailingDistance: 0.3,    // Tighter trailing
  },
  
  // STRATEGY 3: Support/Resistance SL
  'SUPPORT_RESISTANCE': {
    name: 'Support/Resistance SL',
    getSL: (candles, entry, side, symbol) => {
      if (side === 'long') {
        const support = findSupport(candles, 30);
        // Place SL 0.5% below recent support
        return support ? support * 0.995 : entry * 0.975;
      } else {
        const resistance = findResistance(candles, 30);
        // Place SL 0.5% above recent resistance
        return resistance ? resistance * 1.005 : entry * 1.025;
      }
    },
    trailingActivation: 1.0,
    trailingDistance: 0.4,
  },
  
  // STRATEGY 4: Hybrid - S/R with ATR fallback
  'HYBRID_SR_ATR': {
    name: 'Hybrid (S/R + ATR fallback)',
    getSL: (candles, entry, side, symbol) => {
      const atr = calcATR(candles);
      const atrPct = atr ? (atr / entry) * 100 : 1.5;
      
      if (side === 'long') {
        const support = findSupport(candles, 30);
        const distanceToSupport = support ? ((entry - support) / entry) * 100 : 999;
        
        // Use support if it's within 1-4% of entry
        if (distanceToSupport >= 1 && distanceToSupport <= 4) {
          return support * 0.995; // 0.5% below support
        }
        // Otherwise use ATR-based
        const slPct = Math.min(3.5, Math.max(0.8, atrPct * 2.5));
        return entry * (1 - slPct / 100);
      } else {
        const resistance = findResistance(candles, 30);
        const distanceToResistance = resistance ? ((resistance - entry) / entry) * 100 : 999;
        
        // Use resistance if it's within 1-4% of entry
        if (distanceToResistance >= 1 && distanceToResistance <= 4) {
          return resistance * 1.005; // 0.5% above resistance
        }
        // Otherwise use ATR-based
        const slPct = Math.min(3.5, Math.max(0.8, atrPct * 2.5));
        return entry * (1 + slPct / 100);
      }
    },
    trailingActivation: 0.8,
    trailingDistance: 0.35,
  },
};

// ============================================================================
// SIMULATE TRADE
// ============================================================================

function simulateTrade(candles, entryIdx, side, entryPrice, strategy, symbol) {
  const slPrice = strategy.getSL(candles.slice(0, entryIdx + 1), entryPrice, side, symbol);
  const slPct = side === 'long' 
    ? ((entryPrice - slPrice) / entryPrice) * 100
    : ((slPrice - entryPrice) / entryPrice) * 100;
  
  let hwm = entryPrice;
  let lwm = entryPrice;
  let exitReason = null;
  let exitPrice = null;
  let exitIdx = null;
  
  for (let i = entryIdx + 1; i < Math.min(entryIdx + CONFIG.MAX_HOLD_BARS, candles.length); i++) {
    const c = candles[i];
    
    if (side === 'long') {
      hwm = Math.max(hwm, c.high);
      const pnlPct = ((c.close - entryPrice) / entryPrice) * 100;
      const hwmPct = ((hwm - entryPrice) / entryPrice) * 100;
      
      // Trailing
      if (hwmPct >= strategy.trailingActivation) {
        const trailStop = hwm * (1 - strategy.trailingDistance / 100);
        if (c.low <= trailStop) {
          exitReason = 'TRAIL';
          exitPrice = trailStop;
          exitIdx = i;
          break;
        }
      }
      
      // SL
      if (c.low <= slPrice) {
        exitReason = 'SL';
        exitPrice = slPrice;
        exitIdx = i;
        break;
      }
      
      // TP
      if (pnlPct >= CONFIG.TAKE_PROFIT) {
        exitReason = 'TP';
        exitPrice = entryPrice * (1 + CONFIG.TAKE_PROFIT / 100);
        exitIdx = i;
        break;
      }
    } else {
      lwm = Math.min(lwm, c.low);
      const pnlPct = ((entryPrice - c.close) / entryPrice) * 100;
      const lwmPct = ((entryPrice - lwm) / entryPrice) * 100;
      
      // Trailing
      if (lwmPct >= strategy.trailingActivation) {
        const trailStop = lwm * (1 + strategy.trailingDistance / 100);
        if (c.high >= trailStop) {
          exitReason = 'TRAIL';
          exitPrice = trailStop;
          exitIdx = i;
          break;
        }
      }
      
      // SL
      if (c.high >= slPrice) {
        exitReason = 'SL';
        exitPrice = slPrice;
        exitIdx = i;
        break;
      }
      
      // TP
      if (pnlPct >= CONFIG.TAKE_PROFIT) {
        exitReason = 'TP';
        exitPrice = entryPrice * (1 - CONFIG.TAKE_PROFIT / 100);
        exitIdx = i;
        break;
      }
    }
  }
  
  // Time exit
  if (!exitReason && entryIdx + CONFIG.MAX_HOLD_BARS < candles.length) {
    exitReason = 'TIME';
    exitPrice = candles[entryIdx + CONFIG.MAX_HOLD_BARS].close;
    exitIdx = entryIdx + CONFIG.MAX_HOLD_BARS;
  }
  
  if (!exitReason) return null;
  
  const pnlPct = side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  // Apply costs
  const costs = (COSTS.TRADING_FEE_PCT + COSTS.SLIPPAGE_PCT) * 2 * CONFIG.LEVERAGE;
  const netPnlPct = pnlPct * CONFIG.LEVERAGE - costs;
  
  return {
    exitReason,
    exitPrice,
    holdBars: exitIdx - entryIdx,
    grossPnlPct: pnlPct,
    netPnlPct,
    slPct,
    isWin: netPnlPct > 0,
  };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('═'.repeat(100));
  console.log('🔬 COMPARAISON STRATEGIES STOP LOSS - REALISTE POUR LIVE');
  console.log('═'.repeat(100));
  
  const SYMBOLS = [
    'BTC/USDT:USDT', 'ETH/USDT:USDT', 'XRP/USDT:USDT', 'SOL/USDT:USDT',
    'LINK/USDT:USDT', 'DOGE/USDT:USDT', 'AVAX/USDT:USDT', 'DOT/USDT:USDT',
  ];
  
  console.log('\n📂 Chargement des donnees...');
  const allData = loadLocalData(SYMBOLS);
  const btcCandles = allData['BTC/USDT:USDT'];
  if (!btcCandles) { console.error('BTC data not found'); return; }
  const btcCloses = btcCandles.map(c => c.close);
  console.log(`  Loaded ${Object.keys(allData).length} symbols`);
  
  // Results storage
  const results = {};
  for (const stratKey of Object.keys(STRATEGIES)) {
    results[stratKey] = {
      trades: 0, wins: 0, slHits: 0, trailHits: 0, tpHits: 0,
      totalPnl: 0, avgSlPct: 0, slPctSum: 0,
      bySymbol: {},
      bySide: { long: { trades: 0, wins: 0, pnl: 0 }, short: { trades: 0, wins: 0, pnl: 0 } },
    };
  }
  
  console.log('\n⏳ Running backtest...\n');
  
  for (const symbol of SYMBOLS) {
    const candles = allData[symbol];
    if (!candles) continue;
    
    for (const stratKey of Object.keys(STRATEGIES)) {
      results[stratKey].bySymbol[symbol] = { trades: 0, wins: 0, pnl: 0 };
    }
    
    for (let btcIdx = 200; btcIdx < btcCandles.length - CONFIG.MAX_HOLD_BARS; btcIdx++) {
      const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
      const isBullRegime = btcCloses[btcIdx - 1] > btcSma200;
      
      const idx = candles.findIndex(c => c.timestamp >= btcCandles[btcIdx].timestamp);
      if (idx < 50) continue;
      
      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];
      
      let side = null;
      if (isBullRegime && checkLongEntry(windowCandles)) side = 'long';
      else if (!isBullRegime && checkShortEntry(windowCandles)) side = 'short';
      
      if (side) {
        for (const [stratKey, strategy] of Object.entries(STRATEGIES)) {
          const result = simulateTrade(candles, idx, side, current.close, strategy, symbol);
          if (result) {
            results[stratKey].trades++;
            results[stratKey].slPctSum += result.slPct;
            results[stratKey].totalPnl += result.netPnlPct;
            results[stratKey].bySymbol[symbol].trades++;
            results[stratKey].bySymbol[symbol].pnl += result.netPnlPct;
            results[stratKey].bySide[side].trades++;
            results[stratKey].bySide[side].pnl += result.netPnlPct;
            
            if (result.isWin) {
              results[stratKey].wins++;
              results[stratKey].bySymbol[symbol].wins++;
              results[stratKey].bySide[side].wins++;
            }
            if (result.exitReason === 'SL') results[stratKey].slHits++;
            if (result.exitReason === 'TRAIL') results[stratKey].trailHits++;
            if (result.exitReason === 'TP') results[stratKey].tpHits++;
          }
        }
        btcIdx += 4; // Skip a few bars to avoid overlapping
      }
    }
  }
  
  // ============================================================================
  // RESULTS
  // ============================================================================
  
  console.log('\n' + '═'.repeat(100));
  console.log('📊 RESULTATS GLOBAUX');
  console.log('═'.repeat(100));
  
  const sortedStrategies = Object.entries(results).sort((a, b) => b[1].totalPnl - a[1].totalPnl);
  
  console.log('\n  Strategy                    | Trades | Win% | SL%  | Trail% | TP%  | Avg SL | Total PnL');
  console.log('  ' + '─'.repeat(95));
  
  for (const [key, r] of sortedStrategies) {
    const wr = (r.wins / r.trades * 100).toFixed(1);
    const slRate = (r.slHits / r.trades * 100).toFixed(1);
    const trailRate = (r.trailHits / r.trades * 100).toFixed(1);
    const tpRate = (r.tpHits / r.trades * 100).toFixed(1);
    const avgSl = (r.slPctSum / r.trades).toFixed(2);
    const pnl = r.totalPnl.toFixed(1);
    const name = STRATEGIES[key].name;
    
    const best = key === sortedStrategies[0][0] ? ' 🏆' : '';
    console.log(`  ${name.padEnd(27)} | ${String(r.trades).padStart(6)} | ${wr.padStart(4)}% | ${slRate.padStart(4)}% | ${trailRate.padStart(5)}% | ${tpRate.padStart(4)}% | ${avgSl.padStart(5)}% | ${pnl.padStart(9)}%${best}`);
  }
  
  // ============================================================================
  // LONG vs SHORT
  // ============================================================================
  
  console.log('\n\n' + '═'.repeat(100));
  console.log('📈📉 PERFORMANCE PAR DIRECTION');
  console.log('═'.repeat(100));
  
  console.log('\n  Strategy                    |    LONG Trades   | LONG WR | LONG PnL |   SHORT Trades   | SHORT WR | SHORT PnL');
  console.log('  ' + '─'.repeat(110));
  
  for (const [key, r] of sortedStrategies) {
    const name = STRATEGIES[key].name;
    const longWr = r.bySide.long.trades > 0 ? (r.bySide.long.wins / r.bySide.long.trades * 100).toFixed(1) : '0.0';
    const shortWr = r.bySide.short.trades > 0 ? (r.bySide.short.wins / r.bySide.short.trades * 100).toFixed(1) : '0.0';
    
    console.log(`  ${name.padEnd(27)} | ${String(r.bySide.long.trades).padStart(16)} | ${longWr.padStart(6)}% | ${r.bySide.long.pnl.toFixed(1).padStart(8)}% | ${String(r.bySide.short.trades).padStart(16)} | ${shortWr.padStart(7)}% | ${r.bySide.short.pnl.toFixed(1).padStart(9)}%`);
  }
  
  // ============================================================================
  // PAR CRYPTO
  // ============================================================================
  
  console.log('\n\n' + '═'.repeat(100));
  console.log('🪙 PERFORMANCE PAR CRYPTO (Meilleure strategie: ' + STRATEGIES[sortedStrategies[0][0]].name + ')');
  console.log('═'.repeat(100));
  
  const bestStratKey = sortedStrategies[0][0];
  const bestStrat = results[bestStratKey];
  
  console.log('\n  Crypto     | Trades | Wins | Win Rate | PnL');
  console.log('  ' + '─'.repeat(55));
  
  const symbolsSorted = Object.entries(bestStrat.bySymbol)
    .sort((a, b) => b[1].pnl - a[1].pnl);
  
  for (const [symbol, stats] of symbolsSorted) {
    const wr = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(1) : '0.0';
    const shortSymbol = symbol.replace('/USDT:USDT', '');
    console.log(`  ${shortSymbol.padEnd(10)} | ${String(stats.trades).padStart(6)} | ${String(stats.wins).padStart(4)} | ${wr.padStart(7)}% | ${stats.pnl.toFixed(1).padStart(8)}%`);
  }
  
  // ============================================================================
  // IMPROVEMENT vs CURRENT
  // ============================================================================
  
  console.log('\n\n' + '═'.repeat(100));
  console.log('📈 AMELIORATION vs STRATEGIE ACTUELLE');
  console.log('═'.repeat(100));
  
  const current = results['CURRENT_ATR_2.0'];
  
  console.log('\n  Strategy                    | vs Current PnL | vs Current WR | SL Reduction');
  console.log('  ' + '─'.repeat(80));
  
  for (const [key, r] of sortedStrategies) {
    if (key === 'CURRENT_ATR_2.0') continue;
    const name = STRATEGIES[key].name;
    const pnlDiff = r.totalPnl - current.totalPnl;
    const wrDiff = (r.wins / r.trades * 100) - (current.wins / current.trades * 100);
    const slReduction = current.slHits - r.slHits;
    
    const pnlSign = pnlDiff >= 0 ? '+' : '';
    const wrSign = wrDiff >= 0 ? '+' : '';
    
    console.log(`  ${name.padEnd(27)} | ${pnlSign}${pnlDiff.toFixed(1).padStart(12)}% | ${wrSign}${wrDiff.toFixed(1).padStart(11)}% | ${String(slReduction).padStart(12)} SL evites`);
  }
  
  // ============================================================================
  // RECOMMENDATION
  // ============================================================================
  
  console.log('\n\n' + '═'.repeat(100));
  console.log('💡 RECOMMANDATION');
  console.log('═'.repeat(100));
  
  const bestKey = sortedStrategies[0][0];
  const best = results[bestKey];
  const bestName = STRATEGIES[bestKey].name;
  
  console.log(`
  🏆 MEILLEURE STRATEGIE: ${bestName}
  
  Performance:
  - Win Rate: ${(best.wins / best.trades * 100).toFixed(1)}%
  - SL Rate: ${(best.slHits / best.trades * 100).toFixed(1)}%
  - Trailing Rate: ${(best.trailHits / best.trades * 100).toFixed(1)}%
  - Total PnL: +${best.totalPnl.toFixed(1)}%
  
  Amelioration vs Actuel:
  - PnL: +${(best.totalPnl - current.totalPnl).toFixed(1)}%
  - SL evites: ${current.slHits - best.slHits}
  
  Configuration recommandee:`);
  
  if (bestKey === 'ATR_PER_CRYPTO') {
    console.log(`
    ATR Multipliers par crypto:
    - BTC: 2.0, ETH: 2.2
    - SOL, XRP, LINK, AVAX, DOT: 2.5
    - DOGE: 3.0`);
  } else if (bestKey === 'WIDE_SL_TIGHT_TRAIL') {
    console.log(`
    - SL: ATR × 3.0 (plus large)
    - Trailing activation: +0.5% (au lieu de +1%)
    - Trailing distance: 0.3% (au lieu de 0.4%)`);
  } else if (bestKey === 'SUPPORT_RESISTANCE') {
    console.log(`
    - LONG: SL = Support recent - 0.5%
    - SHORT: SL = Resistance recente + 0.5%
    - Lookback: 30 bougies`);
  } else if (bestKey === 'HYBRID_SR_ATR') {
    console.log(`
    - Si Support/Resistance a 1-4% de distance: utiliser S/R
    - Sinon: utiliser ATR × 2.5
    - Trailing activation: +0.8%
    - Trailing distance: 0.35%`);
  }
  
  console.log('\n✅ Analyse terminee');
}

main().catch(console.error);
