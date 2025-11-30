/**
 * 🔬 OPTIMISATION FINE DU SL ATR
 * 
 * On a trouvé que SL ATR × 1.5 est meilleur que 1.5% fixe.
 * Testons différents multiplicateurs pour trouver l'optimal.
 */

import ccxt from 'ccxt';
import fs from 'fs';

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

// Test différents multiplicateurs ATR
const ATR_MULTIPLIERS = [1.0, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.0, 2.2, 2.5];
const SL_MINS = [0.6, 0.8, 1.0];
const SL_MAXS = [2.5, 3.0, 3.5, 4.0];

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

// Indicators
function calcSMA(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcStdDev(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  return Math.sqrt(slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period);
}

function calcBB(closes, period = 20, stdMult = 2) {
  const sma = calcSMA(closes, period);
  const std = calcStdDev(closes, period);
  if (!sma || !std) return null;
  return { middle: sma, upper: sma + std * stdMult, lower: sma - std * stdMult };
}

function calcROC(values, period) {
  if (values.length < period + 1) return null;
  return ((values[values.length - 1] - values[values.length - 1 - period]) / values[values.length - 1 - period]) * 100;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
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

function runBacktest(atrMult, slMin, slMax, allData, btcCandles) {
  const btcCloses = btcCandles.map(c => c.close);
  const trades = [];
  
  for (const symbol of SYMBOLS) {
    const candles = allData[symbol];
    let position = null;
    
    for (let idx = 200; idx < candles.length; idx++) {
      const btcIdx = btcCandles.findIndex(c => c.timestamp >= candles[idx].timestamp);
      if (btcIdx < 200) continue;
      
      const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
      const btcPrice = btcCloses[btcIdx - 1];
      const isBullRegime = btcPrice > btcSma200;
      
      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];
      const atrPct = calcATRPercent(windowCandles) || 1.5;
      
      // Calculate dynamic SL
      const slPct = Math.min(slMax, Math.max(slMin, atrPct * atrMult));
      
      if (position) {
        const holdBars = idx - position.entryIdx;
        let exitReason = null;
        let exitPrice = current.close;
        
        const pnlPct = position.side === 'long'
          ? ((current.close - position.entryPrice) / position.entryPrice) * 100
          : ((position.entryPrice - current.close) / position.entryPrice) * 100;
        
        if (position.side === 'long') {
          position.hwm = Math.max(position.hwm || position.entryPrice, current.high);
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
          position.lwm = Math.min(position.lwm || position.entryPrice, current.low);
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
          
          // Check stop hunt
          const barsAfter = Math.min(20, candles.length - idx - 1);
          let maxFavAfter = 0;
          for (let i = 1; i <= barsAfter; i++) {
            const future = candles[idx + i];
            if (position.side === 'long') {
              maxFavAfter = Math.max(maxFavAfter, ((future.high - exitPrice) / exitPrice) * 100);
            } else {
              maxFavAfter = Math.max(maxFavAfter, ((exitPrice - future.low) / exitPrice) * 100);
            }
          }
          
          trades.push({
            exitReason,
            pnlPct: finalPnlPct,
            leveragedPnlPct: finalPnlPct * SHARED.LEVERAGE,
            slUsed: slPct,
            isStopHunt: exitReason === 'SL' && maxFavAfter > SHARED.EXIT.TAKE_PROFIT,
            holdBars,
          });
          
          position = null;
        }
      }
      
      if (!position) {
        let side = null;
        if (isBullRegime && checkLongEntry(windowCandles)) side = 'long';
        else if (!isBullRegime && checkShortEntry(windowCandles)) side = 'short';
        
        if (side) {
          position = {
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

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 OPTIMISATION FINE DU SL ATR');
  console.log('═'.repeat(80));
  
  console.log('\n📊 Fetching data...');
  const btcCandles = await fetchCandles('BTC/USDT:USDT', 12);
  const allData = { 'BTC/USDT:USDT': btcCandles };
  for (const symbol of SYMBOLS.filter(s => s !== 'BTC/USDT:USDT')) {
    allData[symbol] = await fetchCandles(symbol, 12);
  }
  console.log('   ✓ Data loaded\n');
  
  // Test baseline (fixed 1.5%)
  console.log('Testing configurations...\n');
  
  const results = [];
  
  // Baseline
  const baselineTrades = runBacktest(0, 1.5, 1.5, allData, btcCandles); // Fixed 1.5%
  const baselineSL = baselineTrades.filter(t => t.exitReason === 'SL');
  const baselineWins = baselineTrades.filter(t => t.leveragedPnlPct > 0);
  results.push({
    config: 'BASELINE (1.5% fixe)',
    atrMult: 0,
    slMin: 1.5,
    slMax: 1.5,
    trades: baselineTrades.length,
    winRate: (baselineWins.length / baselineTrades.length * 100),
    totalPnl: baselineTrades.reduce((s, t) => s + t.leveragedPnlPct, 0),
    slCount: baselineSL.length,
    avgSl: baselineSL.length > 0 ? baselineSL.reduce((s, t) => s + t.slUsed, 0) / baselineSL.length : 0,
    stopHunts: baselineSL.filter(t => t.isStopHunt).length,
    stopHuntRate: baselineSL.length > 0 ? (baselineSL.filter(t => t.isStopHunt).length / baselineSL.length * 100) : 0,
  });
  
  // Test different ATR multipliers with best min/max from previous tests
  const bestSlMin = 0.8;
  const bestSlMax = 3.0;
  
  for (const atrMult of ATR_MULTIPLIERS) {
    const trades = runBacktest(atrMult, bestSlMin, bestSlMax, allData, btcCandles);
    const slTrades = trades.filter(t => t.exitReason === 'SL');
    const wins = trades.filter(t => t.leveragedPnlPct > 0);
    
    results.push({
      config: `ATR × ${atrMult}`,
      atrMult,
      slMin: bestSlMin,
      slMax: bestSlMax,
      trades: trades.length,
      winRate: trades.length > 0 ? (wins.length / trades.length * 100) : 0,
      totalPnl: trades.reduce((s, t) => s + t.leveragedPnlPct, 0),
      slCount: slTrades.length,
      avgSl: slTrades.length > 0 ? slTrades.reduce((s, t) => s + t.slUsed, 0) / slTrades.length : 0,
      stopHunts: slTrades.filter(t => t.isStopHunt).length,
      stopHuntRate: slTrades.length > 0 ? (slTrades.filter(t => t.isStopHunt).length / slTrades.length * 100) : 0,
    });
    
    process.stdout.write('.');
  }
  
  console.log('\n');
  
  // Sort by PnL
  results.sort((a, b) => b.totalPnl - a.totalPnl);
  
  console.log('═'.repeat(100));
  console.log('📊 RÉSULTATS TRIÉS PAR PNL');
  console.log('═'.repeat(100));
  
  console.log('\n┌' + '─'.repeat(22) + '┬' + '─'.repeat(8) + '┬' + '─'.repeat(10) + '┬' + '─'.repeat(12) + '┬' + '─'.repeat(10) + '┬' + '─'.repeat(10) + '┬' + '─'.repeat(14) + '┐');
  console.log('│' + ' Config'.padEnd(22) + '│' + ' Trades'.padEnd(8) + '│' + ' WinRate'.padEnd(10) + '│' + ' Total PnL'.padEnd(12) + '│' + ' Avg SL%'.padEnd(10) + '│' + ' SL Count'.padEnd(10) + '│' + ' Stop Hunts'.padEnd(14) + '│');
  console.log('├' + '─'.repeat(22) + '┼' + '─'.repeat(8) + '┼' + '─'.repeat(10) + '┼' + '─'.repeat(12) + '┼' + '─'.repeat(10) + '┼' + '─'.repeat(10) + '┼' + '─'.repeat(14) + '┤');
  
  for (const r of results) {
    const pnlStr = (r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(0) + '%';
    const huntStr = r.stopHunts + ' (' + r.stopHuntRate.toFixed(0) + '%)';
    console.log('│' + (' ' + r.config).padEnd(22) + '│' + (' ' + r.trades).padEnd(8) + '│' + (' ' + r.winRate.toFixed(1) + '%').padEnd(10) + '│' + (' ' + pnlStr).padEnd(12) + '│' + (' ' + r.avgSl.toFixed(2) + '%').padEnd(10) + '│' + (' ' + r.slCount).padEnd(10) + '│' + (' ' + huntStr).padEnd(14) + '│');
  }
  
  console.log('└' + '─'.repeat(22) + '┴' + '─'.repeat(8) + '┴' + '─'.repeat(10) + '┴' + '─'.repeat(12) + '┴' + '─'.repeat(10) + '┴' + '─'.repeat(10) + '┴' + '─'.repeat(14) + '┘');
  
  // Best result
  const best = results[0];
  const baseline = results.find(r => r.config.includes('BASELINE'));
  
  console.log('\n' + '═'.repeat(80));
  console.log('🏆 MEILLEUR MULTIPLICATEUR ATR');
  console.log('═'.repeat(80));
  
  console.log(`\n   ${best.config}`);
  console.log(`   SL dynamique: min ${best.slMin}%, max ${best.slMax}%`);
  console.log(`   SL moyen utilisé: ${best.avgSl.toFixed(2)}%`);
  
  console.log(`\n   📈 Amélioration vs Baseline:`);
  console.log(`      PnL: ${baseline.totalPnl.toFixed(0)}% → ${best.totalPnl.toFixed(0)}% (${best.totalPnl > baseline.totalPnl ? '+' : ''}${(best.totalPnl - baseline.totalPnl).toFixed(0)}%)`);
  console.log(`      Stop Hunts: ${baseline.stopHuntRate.toFixed(0)}% → ${best.stopHuntRate.toFixed(0)}% (${best.stopHuntRate < baseline.stopHuntRate ? '-' : '+'}${Math.abs(best.stopHuntRate - baseline.stopHuntRate).toFixed(0)}%)`);
  
  // Recommend implementation
  console.log('\n' + '═'.repeat(80));
  console.log('💡 RECOMMANDATION D\'IMPLÉMENTATION');
  console.log('═'.repeat(80));
  
  console.log(`
   // Remplacer dans momentumSimple.ts / simpleAgent.ts:
   
   // AVANT (SL fixe):
   STOP_LOSS: 1.5,
   
   // APRÈS (SL dynamique ATR):
   STOP_LOSS_TYPE: 'atr',
   STOP_LOSS_ATR_MULT: ${best.atrMult},
   STOP_LOSS_MIN: ${best.slMin},
   STOP_LOSS_MAX: ${best.slMax},
   
   // Calcul dans checkExit():
   const atrPct = calcATRPercent(candles, 14);
   const dynamicSL = Math.min(${best.slMax}, Math.max(${best.slMin}, atrPct * ${best.atrMult}));
  `);
  
  // Save
  fs.writeFileSync('./data/sl-atr-optimization.json', JSON.stringify({ results, best, baseline }, null, 2));
  console.log('\n✅ Résultats sauvegardés dans data/sl-atr-optimization.json');
}

main().catch(console.error);
