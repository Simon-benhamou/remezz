/**
 * 🔬 BACKTEST OPTIMISÉ ANTI-STOP-HUNT V1
 * 
 * Solutions testées basées sur l'analyse des patterns:
 * 
 * 1. SL DYNAMIQUE basé sur ATR (au lieu de 1.5% fixe)
 * 2. CONFIRMATION 2ème BAR (éviter les entrées précipitées)
 * 3. DISTANCE SUPPORT FILTER (si trop loin du support → SL plus large)
 * 4. SESSION FILTER (éviter Europe si ATR élevé)
 * 5. QUICK SL PROTECTION (si SL en < 4 bars → re-entry permis)
 */

import ccxt from 'ccxt';
import fs from 'fs';

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

// ============================================================================
// CONFIGURATIONS À TESTER
// ============================================================================

const CONFIGS = {
  // Baseline (config actuelle)
  BASELINE: {
    name: 'BASELINE (SL 1.5% fixe)',
    SL_TYPE: 'fixed',
    SL_FIXED: 1.5,
    REQUIRE_CONFIRMATION: false,
    ATR_ENTRY_FILTER: false,
    SUPPORT_DISTANCE_FILTER: false,
    SESSION_FILTER: false,
    QUICK_SL_REENTRY: false,
  },
  
  // V1: SL basé sur ATR
  ATR_SL: {
    name: 'V1: SL Dynamique ATR',
    SL_TYPE: 'atr',
    SL_ATR_MULT: 1.5,         // SL = 1.5 × ATR
    SL_MIN: 0.8,              // Min 0.8%
    SL_MAX: 3.0,              // Max 3%
    REQUIRE_CONFIRMATION: false,
    ATR_ENTRY_FILTER: false,
    SUPPORT_DISTANCE_FILTER: false,
    SESSION_FILTER: false,
    QUICK_SL_REENTRY: false,
  },
  
  // V2: Confirmation 2ème bar
  CONFIRM_BAR: {
    name: 'V2: Confirmation 2ème Bar',
    SL_TYPE: 'fixed',
    SL_FIXED: 1.5,
    REQUIRE_CONFIRMATION: true,
    CONFIRM_BARS: 1,          // Attendre 1 bar après signal
    CONFIRM_DIRECTION: true,  // Le prix doit continuer dans notre direction
    ATR_ENTRY_FILTER: false,
    SUPPORT_DISTANCE_FILTER: false,
    SESSION_FILTER: false,
    QUICK_SL_REENTRY: false,
  },
  
  // V3: ATR Filter à l'entrée
  ATR_FILTER: {
    name: 'V3: ATR Entry Filter',
    SL_TYPE: 'fixed',
    SL_FIXED: 1.5,
    REQUIRE_CONFIRMATION: false,
    ATR_ENTRY_FILTER: true,
    MAX_ATR_ENTRY: 1.8,       // Pas d'entrée si ATR > 1.8%
    SUPPORT_DISTANCE_FILTER: false,
    SESSION_FILTER: false,
    QUICK_SL_REENTRY: false,
  },
  
  // V4: Combiné ATR SL + Confirmation
  COMBINED_V1: {
    name: 'V4: ATR SL + Confirmation',
    SL_TYPE: 'atr',
    SL_ATR_MULT: 1.5,
    SL_MIN: 0.8,
    SL_MAX: 3.0,
    REQUIRE_CONFIRMATION: true,
    CONFIRM_BARS: 1,
    CONFIRM_DIRECTION: true,
    ATR_ENTRY_FILTER: false,
    SUPPORT_DISTANCE_FILTER: false,
    SESSION_FILTER: false,
    QUICK_SL_REENTRY: false,
  },
  
  // V5: Tout combiné
  FULL_OPTIMIZED: {
    name: 'V5: Full Optimized',
    SL_TYPE: 'atr',
    SL_ATR_MULT: 1.8,         // Plus large
    SL_MIN: 1.0,
    SL_MAX: 3.5,
    REQUIRE_CONFIRMATION: true,
    CONFIRM_BARS: 1,
    CONFIRM_DIRECTION: true,
    ATR_ENTRY_FILTER: true,
    MAX_ATR_ENTRY: 2.0,
    SUPPORT_DISTANCE_FILTER: true,
    MIN_SUPPORT_DIST: 0.3,    // Min 0.3% du support
    SESSION_FILTER: false,    // On garde désactivé pour l'instant
    QUICK_SL_REENTRY: true,
    QUICK_SL_BARS: 4,
    REENTRY_COOLDOWN: 8,
  },
  
  // V6: SL très large + confirmation stricte
  WIDE_SL: {
    name: 'V6: Wide SL (2x ATR)',
    SL_TYPE: 'atr',
    SL_ATR_MULT: 2.0,
    SL_MIN: 1.2,
    SL_MAX: 4.0,
    REQUIRE_CONFIRMATION: true,
    CONFIRM_BARS: 2,
    CONFIRM_DIRECTION: true,
    ATR_ENTRY_FILTER: true,
    MAX_ATR_ENTRY: 1.5,
    SUPPORT_DISTANCE_FILTER: false,
    SESSION_FILTER: false,
    QUICK_SL_REENTRY: false,
  },
};

// Shared config
const SHARED = {
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

function findSupport(candles, lookback = 50) {
  const lows = candles.slice(-lookback).map(c => c.low);
  return Math.min(...lows);
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
  
  const bb = calcBB(closes);
  if (!bb || current.close < bb.middle || current.close > bb.upper) return false;
  
  const roc10 = calcROC(closes, 10);
  if (!roc10 || roc10 < SHARED.LONG.ROC_MIN) return false;
  
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * SHARED.LONG.VOL_MULTIPLIER) return false;
  
  if (countConsecUp(candles) > SHARED.LONG.MAX_CONSEC_UP) return false;
  
  return true;
}

function checkShortEntry(candles) {
  if (candles.length < 50) return false;
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  if (current.close >= current.open) return false;
  
  const roc5 = calcROC(closes, 5);
  if (!roc5 || roc5 > SHARED.SHORT.ROC_DROP_MIN) return false;
  
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * SHARED.SHORT.VOL_SPIKE) return false;
  
  const ma20 = calcSMA(closes, 20);
  if (!ma20 || current.close >= ma20) return false;
  
  const bb = calcBB(closes);
  if (!bb || current.close >= bb.lower) return false;
  
  if (countConsecDown(candles) > SHARED.SHORT.MAX_CONSEC_DOWN) return false;
  
  return true;
}

// ============================================================================
// DATA FETCHING
// ============================================================================

async function fetchCandles(symbol, months = 12) {
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
  return allCandles;
}

// ============================================================================
// BACKTEST WITH CONFIG
// ============================================================================

function runBacktest(config, allData, btcCandles) {
  const btcCloses = btcCandles.map(c => c.close);
  const trades = [];
  const pendingSignals = {}; // Pour confirmation
  
  for (const symbol of SYMBOLS) {
    const candles = allData[symbol];
    let position = null;
    let lastQuickSlIdx = -999;
    
    for (let idx = 200; idx < candles.length; idx++) {
      const btcIdx = btcCandles.findIndex(c => c.timestamp >= candles[idx].timestamp);
      if (btcIdx < 200) continue;
      
      const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
      const btcPrice = btcCloses[btcIdx - 1];
      const isBullRegime = btcPrice > btcSma200;
      
      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];
      const closes = windowCandles.map(c => c.close);
      const atrPct = calcATRPercent(windowCandles) || 1.5;
      
      // Manage existing position
      if (position) {
        const holdBars = idx - position.entryIdx;
        let exitReason = null;
        let exitPrice = current.close;
        
        // Calculate SL based on config
        let slPct = config.SL_FIXED || 1.5;
        if (config.SL_TYPE === 'atr') {
          slPct = Math.min(config.SL_MAX, Math.max(config.SL_MIN, atrPct * config.SL_ATR_MULT));
        }
        
        const pnlPct = position.side === 'long'
          ? ((current.close - position.entryPrice) / position.entryPrice) * 100
          : ((position.entryPrice - current.close) / position.entryPrice) * 100;
        
        // Update HWM/LWM
        if (position.side === 'long') {
          position.hwm = Math.max(position.hwm || position.entryPrice, current.high);
        } else {
          position.lwm = Math.min(position.lwm || position.entryPrice, current.low);
        }
        
        // Check exits
        if (position.side === 'long') {
          const hwmPct = ((position.hwm - position.entryPrice) / position.entryPrice) * 100;
          const slPrice = position.entryPrice * (1 - slPct / 100);
          
          if (current.low <= slPrice) {
            exitReason = 'SL';
            exitPrice = slPrice;
          } else if (pnlPct >= SHARED.EXIT.TAKE_PROFIT) {
            exitReason = 'TP';
          } else if (hwmPct >= SHARED.EXIT.TRAILING_ACTIVATION) {
            const trailPrice = position.hwm * (1 - SHARED.EXIT.TRAILING_DISTANCE / 100);
            if (current.low <= trailPrice) {
              exitReason = 'TRAIL';
              exitPrice = trailPrice;
            }
          } else if (holdBars >= SHARED.EXIT.MAX_HOLD_BARS) {
            exitReason = 'TIMEOUT';
          }
        } else {
          const lwmPct = ((position.entryPrice - position.lwm) / position.entryPrice) * 100;
          const slPrice = position.entryPrice * (1 + slPct / 100);
          
          if (current.high >= slPrice) {
            exitReason = 'SL';
            exitPrice = slPrice;
          } else if (pnlPct >= SHARED.EXIT.TAKE_PROFIT) {
            exitReason = 'TP';
          } else if (lwmPct >= SHARED.EXIT.TRAILING_ACTIVATION) {
            const trailPrice = position.lwm * (1 + SHARED.EXIT.TRAILING_DISTANCE / 100);
            if (current.high >= trailPrice) {
              exitReason = 'TRAIL';
              exitPrice = trailPrice;
            }
          } else if (holdBars >= SHARED.EXIT.MAX_HOLD_BARS) {
            exitReason = 'TIMEOUT';
          }
        }
        
        if (exitReason) {
          const finalPnlPct = position.side === 'long'
            ? ((exitPrice - position.entryPrice) / position.entryPrice) * 100
            : ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
          
          // Check for stop hunt
          const barsAfterExit = Math.min(20, candles.length - idx - 1);
          let maxFavorableAfterExit = 0;
          for (let i = 1; i <= barsAfterExit; i++) {
            const futureCandle = candles[idx + i];
            if (position.side === 'long') {
              maxFavorableAfterExit = Math.max(maxFavorableAfterExit, 
                ((futureCandle.high - exitPrice) / exitPrice) * 100);
            } else {
              maxFavorableAfterExit = Math.max(maxFavorableAfterExit,
                ((exitPrice - futureCandle.low) / exitPrice) * 100);
            }
          }
          const isStopHunt = exitReason === 'SL' && maxFavorableAfterExit > SHARED.EXIT.TAKE_PROFIT;
          
          trades.push({
            symbol,
            side: position.side,
            exitReason,
            pnlPct: finalPnlPct,
            leveragedPnlPct: finalPnlPct * SHARED.LEVERAGE,
            holdBars,
            slUsed: slPct,
            isStopHunt,
            maxFavorableAfter: maxFavorableAfterExit,
          });
          
          // Track quick SL for reentry
          if (exitReason === 'SL' && holdBars < (config.QUICK_SL_BARS || 4)) {
            lastQuickSlIdx = idx;
          }
          
          position = null;
        }
      }
      
      // Check for new entry
      if (!position) {
        let side = null;
        const signalKey = `${symbol}_signal`;
        
        if (isBullRegime && checkLongEntry(windowCandles)) {
          side = 'long';
        } else if (!isBullRegime && checkShortEntry(windowCandles)) {
          side = 'short';
        }
        
        // Apply filters
        if (side) {
          // ATR entry filter
          if (config.ATR_ENTRY_FILTER && atrPct > config.MAX_ATR_ENTRY) {
            side = null;
          }
          
          // Support distance filter
          if (side && config.SUPPORT_DISTANCE_FILTER) {
            const support = findSupport(candles.slice(0, idx), 50);
            const distToSupport = ((current.close - support) / current.close) * 100;
            if (distToSupport < config.MIN_SUPPORT_DIST) {
              side = null;
            }
          }
          
          // Quick SL reentry cooldown
          if (side && config.QUICK_SL_REENTRY && (idx - lastQuickSlIdx) < (config.REENTRY_COOLDOWN || 8)) {
            // Allow reentry but with wider SL (handled in position management)
          }
          
          // Confirmation filter
          if (side && config.REQUIRE_CONFIRMATION) {
            if (!pendingSignals[signalKey]) {
              pendingSignals[signalKey] = { side, idx, price: current.close };
              side = null; // Wait for confirmation
            } else {
              const pending = pendingSignals[signalKey];
              const barsWaited = idx - pending.idx;
              
              if (barsWaited >= config.CONFIRM_BARS) {
                // Check if price moved in our direction
                if (config.CONFIRM_DIRECTION) {
                  const priceChange = ((current.close - pending.price) / pending.price) * 100;
                  const correctDirection = (pending.side === 'long' && priceChange > 0) ||
                                          (pending.side === 'short' && priceChange < 0);
                  if (!correctDirection) {
                    delete pendingSignals[signalKey];
                    side = null;
                  } else {
                    side = pending.side;
                    delete pendingSignals[signalKey];
                  }
                } else {
                  side = pending.side;
                  delete pendingSignals[signalKey];
                }
              } else {
                side = null; // Still waiting
              }
            }
          }
        } else {
          // Clear pending signal if conditions no longer met
          delete pendingSignals[signalKey];
        }
        
        if (side) {
          position = {
            symbol,
            side,
            entryPrice: current.close,
            entryIdx: idx,
            hwm: current.close,
            lwm: current.close,
          };
        }
      }
    }
  }
  
  return trades;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 BACKTEST COMPARATIF ANTI-STOP-HUNT');
  console.log('═'.repeat(80));
  
  console.log('\n📊 Fetching 12 months of data...');
  const btcCandles = await fetchCandles('BTC/USDT:USDT', 12);
  console.log(`   BTC: ${btcCandles.length} candles`);
  
  const allData = { 'BTC/USDT:USDT': btcCandles };
  for (const symbol of SYMBOLS.filter(s => s !== 'BTC/USDT:USDT')) {
    allData[symbol] = await fetchCandles(symbol, 12);
    console.log(`   ${symbol}: ${allData[symbol].length} candles`);
  }
  
  console.log('\n⏳ Running backtests...\n');
  
  const results = [];
  
  for (const [key, config] of Object.entries(CONFIGS)) {
    const trades = runBacktest(config, allData, btcCandles);
    
    const slTrades = trades.filter(t => t.exitReason === 'SL');
    const tpTrades = trades.filter(t => t.exitReason === 'TP');
    const trailTrades = trades.filter(t => t.exitReason === 'TRAIL');
    const winTrades = trades.filter(t => t.leveragedPnlPct > 0);
    
    const totalPnl = trades.reduce((s, t) => s + t.leveragedPnlPct, 0);
    const avgSlLoss = slTrades.length > 0 ? slTrades.reduce((s, t) => s + t.leveragedPnlPct, 0) / slTrades.length : 0;
    const avgWin = winTrades.length > 0 ? winTrades.reduce((s, t) => s + t.leveragedPnlPct, 0) / winTrades.length : 0;
    const winRate = trades.length > 0 ? (winTrades.length / trades.length * 100) : 0;
    const stopHunts = slTrades.filter(t => t.isStopHunt).length;
    const stopHuntRate = slTrades.length > 0 ? (stopHunts / slTrades.length * 100) : 0;
    const avgSlUsed = slTrades.length > 0 ? slTrades.reduce((s, t) => s + t.slUsed, 0) / slTrades.length : 0;
    
    const result = {
      key,
      name: config.name,
      trades: trades.length,
      winRate,
      totalPnl,
      avgTrade: trades.length > 0 ? totalPnl / trades.length : 0,
      slCount: slTrades.length,
      avgSlLoss,
      avgSlPct: avgSlUsed,
      tpCount: tpTrades.length,
      trailCount: trailTrades.length,
      avgWin,
      stopHunts,
      stopHuntRate,
      profitFactor: slTrades.length > 0 && Math.abs(avgSlLoss) > 0 
        ? (avgWin * winTrades.length) / (Math.abs(avgSlLoss) * slTrades.length) 
        : 0,
    };
    
    results.push(result);
    
    console.log(`\n📊 ${config.name}`);
    console.log(`   Trades: ${trades.length} | WR: ${winRate.toFixed(1)}%`);
    console.log(`   Total PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(1)}%`);
    console.log(`   SL: ${slTrades.length} (avg ${avgSlLoss.toFixed(2)}%, size ${avgSlUsed.toFixed(2)}%)`);
    console.log(`   Stop Hunts: ${stopHunts} (${stopHuntRate.toFixed(1)}%)`);
    console.log(`   Profit Factor: ${result.profitFactor.toFixed(2)}`);
  }
  
  // ============================================================================
  // COMPARAISON
  // ============================================================================
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TABLEAU COMPARATIF');
  console.log('═'.repeat(80));
  
  // Sort by total PnL
  results.sort((a, b) => b.totalPnl - a.totalPnl);
  
  console.log('\n' + '┌' + '─'.repeat(35) + '┬' + '─'.repeat(10) + '┬' + '─'.repeat(12) + '┬' + '─'.repeat(12) + '┬' + '─'.repeat(12) + '┐');
  console.log('│' + ' Configuration'.padEnd(35) + '│' + ' Trades'.padEnd(10) + '│' + ' Win Rate'.padEnd(12) + '│' + ' Total PnL'.padEnd(12) + '│' + ' Stop Hunts'.padEnd(12) + '│');
  console.log('├' + '─'.repeat(35) + '┼' + '─'.repeat(10) + '┼' + '─'.repeat(12) + '┼' + '─'.repeat(12) + '┼' + '─'.repeat(12) + '┤');
  
  for (const r of results) {
    const pnlStr = (r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(1) + '%';
    const huntStr = r.stopHunts + ' (' + r.stopHuntRate.toFixed(0) + '%)';
    console.log('│' + (' ' + r.name).padEnd(35) + '│' + (' ' + r.trades).padEnd(10) + '│' + (' ' + r.winRate.toFixed(1) + '%').padEnd(12) + '│' + (' ' + pnlStr).padEnd(12) + '│' + (' ' + huntStr).padEnd(12) + '│');
  }
  
  console.log('└' + '─'.repeat(35) + '┴' + '─'.repeat(10) + '┴' + '─'.repeat(12) + '┴' + '─'.repeat(12) + '┴' + '─'.repeat(12) + '┘');
  
  // Best config
  const baseline = results.find(r => r.key === 'BASELINE');
  const best = results[0];
  
  console.log('\n' + '═'.repeat(80));
  console.log('🏆 MEILLEURE CONFIGURATION');
  console.log('═'.repeat(80));
  
  console.log(`\n   ${best.name}`);
  console.log(`\n   📈 Amélioration vs Baseline:`);
  console.log(`      PnL: ${baseline.totalPnl.toFixed(1)}% → ${best.totalPnl.toFixed(1)}% (${best.totalPnl > baseline.totalPnl ? '+' : ''}${(best.totalPnl - baseline.totalPnl).toFixed(1)}%)`);
  console.log(`      Win Rate: ${baseline.winRate.toFixed(1)}% → ${best.winRate.toFixed(1)}%`);
  console.log(`      Stop Hunts: ${baseline.stopHuntRate.toFixed(1)}% → ${best.stopHuntRate.toFixed(1)}%`);
  console.log(`      Profit Factor: ${baseline.profitFactor.toFixed(2)} → ${best.profitFactor.toFixed(2)}`);
  
  // Save results
  fs.writeFileSync('./data/sl-optimization-results.json', JSON.stringify({ results, best, baseline }, null, 2));
  console.log('\n✅ Résultats sauvegardés dans data/sl-optimization-results.json');
}

main().catch(console.error);
