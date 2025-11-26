/**
 * 🔬 SIMULATION: Stratégie COMBINÉE LONG + SHORT sur 12 mois
 * 
 * - BULL (BTC > SMA200): Stratégie LONG V5.2 (BB breakout)
 * - BEAR (BTC < SMA200): Stratégie SHORT Volume Breakdown
 * 
 * On simule le capital qui évolue à travers les 2 régimes
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

// ============================================================================
// CONFIGURATIONS
// ============================================================================

const LONG_CONFIG = {
  name: 'LONG V5.2 (BB Breakout)',
  regime: 'bull', // BTC > SMA200
  entry: {
    bbPeriod: 20,
    bbStd: 2,
    rocMin: 1.5,              // ROC 10 > 1.5%
    volMultiplier: 1.3,
    maxConsecUp: 4,
  },
  exit: {
    stopLoss: 1.5,
    takeProfit: 3.0,
    trailingActivation: 1.0,
    trailingDistance: 0.4,
    maxBars: 192,
  }
};

const SHORT_CONFIG = {
  name: 'SHORT Volume Breakdown',
  regime: 'bear', // BTC < SMA200
  entry: {
    priceDropMin: -1,         // ROC5 < -1%
    volSpike: 2.0,            // Volume > 2x
    belowMA20: true,
  },
  exit: {
    stopLoss: 1.5,
    takeProfit: 3.0,
    trailingActivation: 1.0,
    trailingDistance: 0.4,
    maxBars: 192,
  }
};

const SYMBOLS = ['SEI/USDT:USDT', 'XRP/USDT:USDT', 'ETH/USDT:USDT', 'IMX/USDT:USDT'];
const POSITION_SIZE_PCT = 0.4;
const INITIAL_CAPITAL = 1000;

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

function calcROC(closes, period = 10) {
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

// ============================================================================
// ENTRY SIGNALS
// ============================================================================

function checkLongEntry(candles, btcAboveSma200) {
  if (!btcAboveSma200) return false;
  if (candles.length < 50) return false;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  const bb = calcBB(closes, LONG_CONFIG.entry.bbPeriod, LONG_CONFIG.entry.bbStd);
  if (!bb || current.close <= bb.upper) return false;
  
  const roc = calcROC(closes, 10);
  if (!roc || roc < LONG_CONFIG.entry.rocMin) return false;
  
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * LONG_CONFIG.entry.volMultiplier) return false;
  
  if (countConsecUp(candles) > LONG_CONFIG.entry.maxConsecUp) return false;
  
  return true;
}

function checkShortEntry(candles, btcBelowSma200) {
  if (!btcBelowSma200) return false;
  if (candles.length < 50) return false;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  const roc5 = calcROC(closes, 5);
  if (!roc5 || roc5 > SHORT_CONFIG.entry.priceDropMin) return false;
  
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * SHORT_CONFIG.entry.volSpike) return false;
  
  const ma20 = calcSMA(closes, 20);
  if (!ma20 || current.close >= ma20) return false;
  
  return true;
}

// ============================================================================
// BACKTEST ENGINE
// ============================================================================

async function fetchCandles(symbol, months = 12) {
  console.log(`   Fetching ${symbol} (${months} months)...`);
  const since = Date.now() - months * 30 * 24 * 60 * 60 * 1000;
  const allCandles = [];
  let cursor = since;
  
  while (cursor < Date.now()) {
    const ohlcv = await exchange.fetchOHLCV(symbol, '15m', cursor, 1000);
    if (ohlcv.length === 0) break;
    
    for (const c of ohlcv) {
      allCandles.push({
        timestamp: c[0],
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5]
      });
    }
    
    cursor = ohlcv[ohlcv.length - 1][0] + 1;
    await new Promise(r => setTimeout(r, 50));
  }
  
  console.log(`      → ${allCandles.length} candles`);
  return allCandles;
}

async function runCombinedBacktest() {
  console.log('═'.repeat(80));
  console.log('🔬 SIMULATION: STRATÉGIE COMBINÉE LONG + SHORT (12 MOIS)');
  console.log('═'.repeat(80));
  console.log(`\nCapital initial: $${INITIAL_CAPITAL}`);
  console.log(`Position size: ${POSITION_SIZE_PCT * 100}%`);
  console.log(`\n📊 Fetching data...`);
  
  // Fetch BTC
  const btcCandles = await fetchCandles('BTC/USDT:USDT', 12);
  const btcCloses = btcCandles.map(c => c.close);
  
  // Fetch all symbols
  const allData = {};
  for (const symbol of SYMBOLS) {
    allData[symbol] = await fetchCandles(symbol, 12);
  }
  
  // Results tracking
  let capital = INITIAL_CAPITAL;
  const results = {
    longTrades: [],
    shortTrades: [],
    capitalHistory: [],
    monthlyPnl: {},
    regimeStats: { bullBars: 0, bearBars: 0 }
  };
  
  // Position tracking per symbol
  const positions = {};
  const cooldowns = {};
  SYMBOLS.forEach(s => { positions[s] = null; cooldowns[s] = 0; });
  
  // Find common time range
  const startTime = Math.max(
    btcCandles[200]?.timestamp || 0,
    ...SYMBOLS.map(s => allData[s][200]?.timestamp || 0)
  );
  
  console.log(`\n🚀 Running simulation from ${new Date(startTime).toISOString().split('T')[0]}...`);
  
  // Main loop - iterate through BTC candles as time reference
  for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
    const btcAboveSma200 = btcSma200 ? btcCloses[btcIdx - 1] > btcSma200 : false;
    const btcBelowSma200 = btcSma200 ? btcCloses[btcIdx - 1] < btcSma200 : false;
    
    // Track regime
    if (btcAboveSma200) results.regimeStats.bullBars++;
    else if (btcBelowSma200) results.regimeStats.bearBars++;
    
    // Track month
    const month = new Date(btcCandle.timestamp).toISOString().slice(0, 7);
    if (!results.monthlyPnl[month]) results.monthlyPnl[month] = { pnl: 0, trades: 0, long: 0, short: 0 };
    
    // Process each symbol
    for (const symbol of SYMBOLS) {
      const candles = allData[symbol];
      const idx = candles.findIndex(c => c.timestamp >= btcCandle.timestamp);
      if (idx < 50) continue;
      
      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];
      
      // Manage existing position
      if (positions[symbol]) {
        const pos = positions[symbol];
        let pnlPct, exitReason = null, exitPrice = current.close;
        
        if (pos.side === 'long') {
          pnlPct = ((current.close - pos.entryPrice) / pos.entryPrice) * 100;
          pos.highWaterMark = Math.max(pos.highWaterMark || pos.entryPrice, current.high);
          const hwmPct = ((pos.highWaterMark - pos.entryPrice) / pos.entryPrice) * 100;
          
          if (pnlPct <= -LONG_CONFIG.exit.stopLoss) {
            exitReason = 'SL';
            exitPrice = pos.entryPrice * (1 - LONG_CONFIG.exit.stopLoss / 100);
          } else if (pnlPct >= LONG_CONFIG.exit.takeProfit) {
            exitReason = 'TP';
            exitPrice = pos.entryPrice * (1 + LONG_CONFIG.exit.takeProfit / 100);
          } else if (hwmPct >= LONG_CONFIG.exit.trailingActivation) {
            const trailStop = pos.highWaterMark * (1 - LONG_CONFIG.exit.trailingDistance / 100);
            if (current.low <= trailStop) {
              exitReason = 'TRAIL';
              exitPrice = trailStop;
            }
          } else if (idx - pos.entryIdx >= LONG_CONFIG.exit.maxBars) {
            exitReason = 'TIME';
          }
          
          if (exitReason) {
            const finalPnl = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
            const pnlUsd = (finalPnl / 100) * pos.capitalUsed;
            capital += pnlUsd;
            
            results.longTrades.push({ symbol, pnlPct: finalPnl, pnlUsd, exitReason });
            results.monthlyPnl[month].pnl += pnlUsd;
            results.monthlyPnl[month].trades++;
            results.monthlyPnl[month].long++;
            
            positions[symbol] = null;
            cooldowns[symbol] = 8;
          }
        } else { // short
          pnlPct = ((pos.entryPrice - current.close) / pos.entryPrice) * 100;
          pos.lowWaterMark = Math.min(pos.lowWaterMark || pos.entryPrice, current.low);
          const lwmPct = ((pos.entryPrice - pos.lowWaterMark) / pos.entryPrice) * 100;
          
          if (pnlPct <= -SHORT_CONFIG.exit.stopLoss) {
            exitReason = 'SL';
            exitPrice = pos.entryPrice * (1 + SHORT_CONFIG.exit.stopLoss / 100);
          } else if (pnlPct >= SHORT_CONFIG.exit.takeProfit) {
            exitReason = 'TP';
            exitPrice = pos.entryPrice * (1 - SHORT_CONFIG.exit.takeProfit / 100);
          } else if (lwmPct >= SHORT_CONFIG.exit.trailingActivation) {
            const trailStop = pos.lowWaterMark * (1 + SHORT_CONFIG.exit.trailingDistance / 100);
            if (current.high >= trailStop) {
              exitReason = 'TRAIL';
              exitPrice = trailStop;
            }
          } else if (idx - pos.entryIdx >= SHORT_CONFIG.exit.maxBars) {
            exitReason = 'TIME';
          }
          
          if (exitReason) {
            const finalPnl = ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;
            const pnlUsd = (finalPnl / 100) * pos.capitalUsed;
            capital += pnlUsd;
            
            results.shortTrades.push({ symbol, pnlPct: finalPnl, pnlUsd, exitReason });
            results.monthlyPnl[month].pnl += pnlUsd;
            results.monthlyPnl[month].trades++;
            results.monthlyPnl[month].short++;
            
            positions[symbol] = null;
            cooldowns[symbol] = 8;
          }
        }
      }
      
      // Check new entries
      if (!positions[symbol] && cooldowns[symbol] <= 0) {
        const capitalToUse = capital * POSITION_SIZE_PCT;
        
        if (btcAboveSma200 && checkLongEntry(windowCandles, true)) {
          positions[symbol] = {
            side: 'long',
            entryPrice: current.close,
            entryIdx: idx,
            capitalUsed: capitalToUse,
            highWaterMark: current.close
          };
        } else if (btcBelowSma200 && checkShortEntry(windowCandles, true)) {
          positions[symbol] = {
            side: 'short',
            entryPrice: current.close,
            entryIdx: idx,
            capitalUsed: capitalToUse,
            lowWaterMark: current.close
          };
        }
      }
      
      if (cooldowns[symbol] > 0) cooldowns[symbol]--;
    }
    
    // Record capital history (every 96 bars = 1 day)
    if (btcIdx % 96 === 0) {
      results.capitalHistory.push({
        date: new Date(btcCandle.timestamp).toISOString().split('T')[0],
        capital,
        regime: btcAboveSma200 ? 'BULL' : 'BEAR'
      });
    }
  }
  
  return results;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const results = await runCombinedBacktest();
  
  // Calculate stats
  const allTrades = [...results.longTrades, ...results.shortTrades];
  const wins = allTrades.filter(t => t.pnlPct > 0).length;
  const losses = allTrades.filter(t => t.pnlPct <= 0).length;
  const winRate = allTrades.length > 0 ? (wins / allTrades.length * 100).toFixed(1) : 0;
  
  const longWins = results.longTrades.filter(t => t.pnlPct > 0).length;
  const shortWins = results.shortTrades.filter(t => t.pnlPct > 0).length;
  const longWR = results.longTrades.length > 0 ? (longWins / results.longTrades.length * 100).toFixed(1) : 0;
  const shortWR = results.shortTrades.length > 0 ? (shortWins / results.shortTrades.length * 100).toFixed(1) : 0;
  
  const totalPnlUsd = allTrades.reduce((s, t) => s + t.pnlUsd, 0);
  const longPnl = results.longTrades.reduce((s, t) => s + t.pnlUsd, 0);
  const shortPnl = results.shortTrades.reduce((s, t) => s + t.pnlUsd, 0);
  
  const finalCapital = results.capitalHistory[results.capitalHistory.length - 1]?.capital || INITIAL_CAPITAL;
  const roi = ((finalCapital - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100).toFixed(1);
  
  // Calculate max drawdown
  let maxCapital = INITIAL_CAPITAL;
  let maxDrawdown = 0;
  for (const h of results.capitalHistory) {
    if (h.capital > maxCapital) maxCapital = h.capital;
    const dd = ((maxCapital - h.capital) / maxCapital) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  
  // Regime stats
  const bullPct = (results.regimeStats.bullBars / (results.regimeStats.bullBars + results.regimeStats.bearBars) * 100).toFixed(1);
  const bearPct = (results.regimeStats.bearBars / (results.regimeStats.bullBars + results.regimeStats.bearBars) * 100).toFixed(1);
  
  // Print results
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS - STRATÉGIE COMBINÉE 12 MOIS');
  console.log('═'.repeat(80));
  
  console.log(`
┌─────────────────────────────────────────────────────────────────────────────┐
│                           PERFORMANCE GLOBALE                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  Capital initial:    $${INITIAL_CAPITAL.toFixed(2).padStart(10)}                                        │
│  Capital final:      $${finalCapital.toFixed(2).padStart(10)}                                        │
│  ROI Total:          ${roi.padStart(10)}%                                        │
│  Max Drawdown:       ${maxDrawdown.toFixed(1).padStart(10)}%                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  Trades totaux:      ${String(allTrades.length).padStart(10)}                                        │
│  Win Rate:           ${winRate.padStart(10)}%                                        │
│  Wins / Losses:      ${(wins + ' / ' + losses).padStart(10)}                                        │
└─────────────────────────────────────────────────────────────────────────────┘
`);

  console.log(`
┌──────────────────────────────────────────────────────────────────────────────┐
│                          BREAKDOWN LONG vs SHORT                             │
├────────────────────┬─────────────────────────┬───────────────────────────────┤
│                    │        LONG             │          SHORT                │
│                    │   (BTC > SMA200)        │     (BTC < SMA200)            │
├────────────────────┼─────────────────────────┼───────────────────────────────┤
│  Trades            │  ${String(results.longTrades.length).padStart(10)}             │     ${String(results.shortTrades.length).padStart(10)}                │
│  Win Rate          │  ${String(longWR + '%').padStart(10)}             │     ${String(shortWR + '%').padStart(10)}                │
│  PnL               │  $${longPnl.toFixed(2).padStart(9)}             │     $${shortPnl.toFixed(2).padStart(9)}                │
│  Temps de marché   │  ${String(bullPct + '%').padStart(10)}             │     ${String(bearPct + '%').padStart(10)}                │
└────────────────────┴─────────────────────────┴───────────────────────────────┘
`);

  // Monthly breakdown
  console.log('\n📅 PERFORMANCE MENSUELLE:');
  console.log('┌─────────────┬──────────────┬────────┬────────┬────────┐');
  console.log('│    Mois     │     PnL      │ Trades │  Long  │ Short  │');
  console.log('├─────────────┼──────────────┼────────┼────────┼────────┤');
  
  const months = Object.keys(results.monthlyPnl).sort();
  let positiveMonths = 0;
  
  for (const m of months) {
    const d = results.monthlyPnl[m];
    const pnlStr = d.pnl >= 0 ? `+$${d.pnl.toFixed(2)}` : `-$${Math.abs(d.pnl).toFixed(2)}`;
    if (d.pnl > 0) positiveMonths++;
    console.log(`│ ${m}   │ ${pnlStr.padStart(12)} │ ${String(d.trades).padStart(6)} │ ${String(d.long).padStart(6)} │ ${String(d.short).padStart(6)} │`);
  }
  
  console.log('└─────────────┴──────────────┴────────┴────────┴────────┘');
  console.log(`\n📈 Mois positifs: ${positiveMonths}/${months.length} (${(positiveMonths/months.length*100).toFixed(0)}%)`);
  
  // Exit reasons
  const longSL = results.longTrades.filter(t => t.exitReason === 'SL').length;
  const longTP = results.longTrades.filter(t => t.exitReason === 'TP').length;
  const longTrail = results.longTrades.filter(t => t.exitReason === 'TRAIL').length;
  const shortSL = results.shortTrades.filter(t => t.exitReason === 'SL').length;
  const shortTP = results.shortTrades.filter(t => t.exitReason === 'TP').length;
  const shortTrail = results.shortTrades.filter(t => t.exitReason === 'TRAIL').length;
  
  console.log(`
┌────────────────────────────────────────────────────────────────┐
│                     EXIT REASONS                               │
├────────────────┬───────────────────┬───────────────────────────┤
│                │      LONG         │        SHORT              │
├────────────────┼───────────────────┼───────────────────────────┤
│  Stop Loss     │  ${String(longSL).padStart(10)}       │     ${String(shortSL).padStart(10)}            │
│  Take Profit   │  ${String(longTP).padStart(10)}       │     ${String(shortTP).padStart(10)}            │
│  Trailing      │  ${String(longTrail).padStart(10)}       │     ${String(shortTrail).padStart(10)}            │
└────────────────┴───────────────────┴───────────────────────────┘
`);

  // Per symbol breakdown
  console.log('\n📊 BREAKDOWN PAR SYMBOLE:');
  console.log('┌────────────────────┬────────┬────────┬────────────┐');
  console.log('│      Symbol        │  Long  │ Short  │   PnL      │');
  console.log('├────────────────────┼────────┼────────┼────────────┤');
  
  for (const symbol of SYMBOLS) {
    const longCount = results.longTrades.filter(t => t.symbol === symbol).length;
    const shortCount = results.shortTrades.filter(t => t.symbol === symbol).length;
    const symbolPnl = [...results.longTrades, ...results.shortTrades]
      .filter(t => t.symbol === symbol)
      .reduce((s, t) => s + t.pnlUsd, 0);
    const pnlStr = symbolPnl >= 0 ? `+$${symbolPnl.toFixed(2)}` : `-$${Math.abs(symbolPnl).toFixed(2)}`;
    console.log(`│ ${symbol.padEnd(18)} │ ${String(longCount).padStart(6)} │ ${String(shortCount).padStart(6)} │ ${pnlStr.padStart(10)} │`);
  }
  
  console.log('└────────────────────┴────────┴────────┴────────────┘');
  
  // Final comparison
  console.log('\n' + '═'.repeat(80));
  console.log('💡 COMPARAISON: STRATÉGIE UNIQUE vs COMBINÉE');
  console.log('═'.repeat(80));
  console.log(`
   📈 LONG SEULEMENT (6 mois BULL):
      ROI: +32.2% | Trades: 372 | WR: 68.5%
      ⚠️ NE TRADE PAS en BEAR (50% du temps)
   
   📉 SHORT SEULEMENT (6 mois BEAR):
      ROI: +55.2% | Trades: 543 | WR: 66.3%
      ⚠️ NE TRADE PAS en BULL (50% du temps)
   
   🔄 COMBINÉE (12 mois complets):
      ROI: +${roi}%
      Trades: ${allTrades.length} (${results.longTrades.length} long + ${results.shortTrades.length} short)
      WR: ${winRate}%
      ✅ TRADE EN PERMANENCE dans les 2 régimes!
`);

  // Recommendation
  if (parseFloat(roi) > 50) {
    console.log('🏆 RECOMMANDATION: La stratégie COMBINÉE est excellente!');
    console.log('   L\'agent peut maintenant trader en BULL et en BEAR.');
  }
}

main().catch(console.error);
