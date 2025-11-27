/**
 * 🔬 BACKTEST COMBINÉ V5.4 - LONG (Bull) + SHORT (Bear)
 * 
 * Simulation réaliste avec $1000 sur 24 mois
 * - Détecte automatiquement le régime (BTC vs SMA200)
 * - Applique LONG en Bull, SHORT en Bear
 * - Frais réalistes: trading, slippage, funding
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

// ============================================================================
// CONFIGURATION V5.4 (exactement comme dans momentumSimple.ts)
// ============================================================================

const CONFIG = {
  // LONG Entry (Bull: BTC > SMA200)
  LONG: {
    BB_PERIOD: 20,
    BB_STD: 2,
    ROC_MIN: 2.5,           // ROC10 > 2.5%
    VOL_MULTIPLIER: 2.0,    // Volume > 2x
    MAX_CONSEC_UP: 3,
  },
  
  // SHORT Entry (Bear: BTC < SMA200) - BB Breakdown V5.4
  SHORT: {
    ROC_DROP_MIN: -1.5,     // ROC5 < -1.5%
    VOL_SPIKE: 2.0,         // Volume > 2x
    PRICE_BELOW_MA20: true,
    PRICE_BELOW_BB_LOWER: true,  // BB Breakdown
    MAX_CONSEC_DOWN: 5,
  },
  
  // Exit (même pour LONG et SHORT)
  EXIT: {
    STOP_LOSS: 1.5,
    TAKE_PROFIT: 3.0,
    TRAILING_ACTIVATION: 1.0,
    TRAILING_DISTANCE: 0.4,
    MAX_HOLD_BARS: 192,  // 48h
  },
  
  // Risk
  POSITION_SIZE_PCT: 0.4,  // 40% du capital par trade
  LEVERAGE: 5,
};

const COSTS = {
  TRADING_FEE_PCT: 0.04,      // 0.04% per side
  SLIPPAGE_PCT: 0.05,         // 0.05% per side  
  FUNDING_RATE_PCT: 0.01,     // 0.01% every 8h
  FUNDING_INTERVAL_BARS: 32,  // 32 × 15min = 8h
};

const INITIAL_CAPITAL = 1000;
const SYMBOLS = ['SEI/USDT:USDT', 'XRP/USDT:USDT', 'ETH/USDT:USDT', 'IMX/USDT:USDT'];

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

// ============================================================================
// ENTRY CHECKS
// ============================================================================

function checkLongEntry(candles) {
  if (candles.length < 50) return false;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  // Must be bullish
  if (current.close <= current.open) return false;
  
  // BB Breakout
  const bb = calcBB(closes, CONFIG.LONG.BB_PERIOD, CONFIG.LONG.BB_STD);
  if (!bb || current.close <= bb.upper) return false;
  
  // ROC > 2.5%
  const roc = calcROC(closes, 10);
  if (!roc || roc < CONFIG.LONG.ROC_MIN) return false;
  
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
  
  // Must be bearish
  if (current.close >= current.open) return false;
  
  // ROC5 < -1.5%
  const roc5 = calcROC(closes, 5);
  if (!roc5 || roc5 > CONFIG.SHORT.ROC_DROP_MIN) return false;
  
  // Volume > 2x
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * CONFIG.SHORT.VOL_SPIKE) return false;
  
  // Price < MA20
  const ma20 = calcSMA(closes, 20);
  if (!ma20 || current.close >= ma20) return false;
  
  // Price < BB Lower (V5.4)
  if (CONFIG.SHORT.PRICE_BELOW_BB_LOWER) {
    const bb = calcBB(closes);
    if (!bb || current.close >= bb.lower) return false;
  }
  
  // ConsecDown <= 5
  if (countConsecDown(candles) > CONFIG.SHORT.MAX_CONSEC_DOWN) return false;
  
  return true;
}

// ============================================================================
// PNL CALCULATOR WITH ALL COSTS
// ============================================================================

function calculatePnl(entryPrice, exitPrice, side, capitalUsed, holdBars) {
  // Gross PnL
  let pnlPct = side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  const leveragedPnlPct = pnlPct * CONFIG.LEVERAGE;
  
  // Costs
  const entryFee = COSTS.TRADING_FEE_PCT * CONFIG.LEVERAGE;
  const exitFee = COSTS.TRADING_FEE_PCT * CONFIG.LEVERAGE;
  const totalSlippage = COSTS.SLIPPAGE_PCT * 2 * CONFIG.LEVERAGE;
  const fundingPeriods = Math.floor(holdBars / COSTS.FUNDING_INTERVAL_BARS);
  const totalFunding = fundingPeriods * COSTS.FUNDING_RATE_PCT * CONFIG.LEVERAGE;
  
  const totalCosts = entryFee + exitFee + totalSlippage + totalFunding;
  const netPnlPct = leveragedPnlPct - totalCosts;
  const netPnlUsd = (netPnlPct / 100) * capitalUsed;
  const costsUsd = (totalCosts / 100) * capitalUsed;
  
  return { 
    grossPnlPct: pnlPct, 
    leveragedPnlPct, 
    netPnlPct, 
    netPnlUsd, 
    costsUsd,
    totalCostsPct: totalCosts
  };
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
// MAIN BACKTEST
// ============================================================================

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 BACKTEST COMBINÉ V5.4 - LONG (Bull) + SHORT (Bear)');
  console.log('═'.repeat(80));
  console.log(`\n💰 Capital initial: $${INITIAL_CAPITAL}`);
  console.log(`📊 Leverage: ${CONFIG.LEVERAGE}x | Position Size: ${CONFIG.POSITION_SIZE_PCT * 100}%`);
  console.log(`💸 Frais: Trading ${COSTS.TRADING_FEE_PCT}%, Slippage ${COSTS.SLIPPAGE_PCT}%, Funding ${COSTS.FUNDING_RATE_PCT}%/8h`);
  
  // Fetch data
  console.log('\n📊 Fetching 24 months of data...');
  const btcCandles = await fetchCandles('BTC/USDT:USDT', 24);
  const btcCloses = btcCandles.map(c => c.close);
  console.log(`   BTC: ${btcCandles.length} candles`);
  
  const allData = {};
  for (const symbol of SYMBOLS) {
    allData[symbol] = await fetchCandles(symbol, 24);
    console.log(`   ${symbol}: ${allData[symbol].length} candles`);
  }
  
  // Initialize tracking
  let capital = INITIAL_CAPITAL;
  let capitalInUse = 0;  // Track capital locked in positions
  const trades = [];
  let totalCosts = 0;
  const monthlyPnl = {};
  const dailyEquity = [];
  let rejectedOrders = 0;  // Track rejected orders due to insufficient capital
  
  const positions = {};
  const cooldowns = {};
  SYMBOLS.forEach(s => { positions[s] = null; cooldowns[s] = 0; });
  
  let bullBars = 0, bearBars = 0;
  let longSignals = 0, shortSignals = 0;
  
  // Main loop
  console.log('\n⏳ Running backtest...');
  
  for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
    const btcPrice = btcCloses[btcIdx - 1];
    
    // Determine regime
    const isBullRegime = btcPrice > btcSma200;
    const isBearRegime = btcPrice < btcSma200;
    
    if (isBullRegime) bullBars++;
    if (isBearRegime) bearBars++;
    
    const month = new Date(btcCandle.timestamp).toISOString().slice(0, 7);
    if (!monthlyPnl[month]) monthlyPnl[month] = { pnl: 0, longTrades: 0, shortTrades: 0 };
    
    // Track daily equity
    const day = new Date(btcCandle.timestamp).toISOString().slice(0, 10);
    if (dailyEquity.length === 0 || dailyEquity[dailyEquity.length - 1].day !== day) {
      dailyEquity.push({ day, equity: capital });
    }
    
    for (const symbol of SYMBOLS) {
      const candles = allData[symbol];
      const idx = candles.findIndex(c => c.timestamp >= btcCandle.timestamp);
      if (idx < 50) continue;
      
      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];
      
      // ═══════════════════════════════════════════════════════════════════════
      // MANAGE EXISTING POSITION
      // ═══════════════════════════════════════════════════════════════════════
      if (positions[symbol]) {
        const pos = positions[symbol];
        const holdBars = idx - pos.entryIdx;
        let exitReason = null, exitPrice = current.close;
        
        if (pos.side === 'long') {
          const pnlPct = ((current.close - pos.entryPrice) / pos.entryPrice) * 100;
          pos.hwm = Math.max(pos.hwm || pos.entryPrice, current.high);
          const hwmPct = ((pos.hwm - pos.entryPrice) / pos.entryPrice) * 100;
          
          if (pnlPct <= -CONFIG.EXIT.STOP_LOSS) {
            exitReason = 'SL';
            exitPrice = pos.entryPrice * (1 - CONFIG.EXIT.STOP_LOSS / 100);
          } else if (pnlPct >= CONFIG.EXIT.TAKE_PROFIT) {
            exitReason = 'TP';
            exitPrice = pos.entryPrice * (1 + CONFIG.EXIT.TAKE_PROFIT / 100);
          } else if (hwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION) {
            const trailStop = pos.hwm * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100);
            if (current.low <= trailStop) { 
              exitReason = 'TRAIL'; 
              exitPrice = trailStop; 
            }
          } else if (holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) {
            exitReason = 'TIME';
          }
        } else {
          // SHORT
          const pnlPct = ((pos.entryPrice - current.close) / pos.entryPrice) * 100;
          pos.lwm = Math.min(pos.lwm || pos.entryPrice, current.low);
          const lwmPct = ((pos.entryPrice - pos.lwm) / pos.entryPrice) * 100;
          
          if (pnlPct <= -CONFIG.EXIT.STOP_LOSS) {
            exitReason = 'SL';
            exitPrice = pos.entryPrice * (1 + CONFIG.EXIT.STOP_LOSS / 100);
          } else if (pnlPct >= CONFIG.EXIT.TAKE_PROFIT) {
            exitReason = 'TP';
            exitPrice = pos.entryPrice * (1 - CONFIG.EXIT.TAKE_PROFIT / 100);
          } else if (lwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION) {
            const trailStop = pos.lwm * (1 + CONFIG.EXIT.TRAILING_DISTANCE / 100);
            if (current.high >= trailStop) { 
              exitReason = 'TRAIL'; 
              exitPrice = trailStop; 
            }
          } else if (holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) {
            exitReason = 'TIME';
          }
        }
        
        // Execute exit
        if (exitReason) {
          const pnl = calculatePnl(pos.entryPrice, exitPrice, pos.side, pos.capitalUsed, holdBars);
          capital += pnl.netPnlUsd;
          capitalInUse -= pos.capitalUsed;  // Release capital back
          totalCosts += pnl.costsUsd;
          
          trades.push({
            symbol,
            side: pos.side,
            entryTime: new Date(pos.entryTime).toISOString(),
            exitTime: new Date(btcCandle.timestamp).toISOString(),
            entryPrice: pos.entryPrice,
            exitPrice,
            holdBars,
            grossPnlPct: pnl.grossPnlPct,
            netPnlPct: pnl.netPnlPct,
            netPnlUsd: pnl.netPnlUsd,
            costsUsd: pnl.costsUsd,
            exitReason,
            capitalAfter: capital,
            month
          });
          
          monthlyPnl[month].pnl += pnl.netPnlUsd;
          if (pos.side === 'long') monthlyPnl[month].longTrades++;
          else monthlyPnl[month].shortTrades++;
          
          positions[symbol] = null;
          cooldowns[symbol] = 8;  // 2h cooldown
        }
      }
      
      // ═══════════════════════════════════════════════════════════════════════
      // CHECK FOR NEW ENTRY
      // ═══════════════════════════════════════════════════════════════════════
      if (!positions[symbol] && cooldowns[symbol] <= 0 && capital > 100) {
        const availableCapital = capital - capitalInUse;
        const capitalToUse = capital * CONFIG.POSITION_SIZE_PCT;  // 40% of current capital
        
        // Check if we have enough available capital
        if (capitalToUse > availableCapital) {
          // Not enough capital - order would be rejected
          if (isBullRegime && checkLongEntry(windowCandles)) {
            rejectedOrders++;
          } else if (isBearRegime && checkShortEntry(windowCandles)) {
            rejectedOrders++;
          }
        } else {
          // BULL REGIME → LONG
          if (isBullRegime && checkLongEntry(windowCandles)) {
            longSignals++;
            capitalInUse += capitalToUse;  // Lock capital
            positions[symbol] = {
              side: 'long',
              entryPrice: current.close,
              entryIdx: idx,
              entryTime: btcCandle.timestamp,
              capitalUsed: capitalToUse,
              hwm: current.close
            };
          }
          // BEAR REGIME → SHORT
          else if (isBearRegime && checkShortEntry(windowCandles)) {
            shortSignals++;
            capitalInUse += capitalToUse;  // Lock capital
            positions[symbol] = {
              side: 'short',
              entryPrice: current.close,
              entryIdx: idx,
              entryTime: btcCandle.timestamp,
              capitalUsed: capitalToUse,
              lwm: current.close
            };
          }
        }
      }
      
      if (cooldowns[symbol] > 0) cooldowns[symbol]--;
    }
  }
  
  // ============================================================================
  // RESULTS
  // ============================================================================
  
  const longTrades = trades.filter(t => t.side === 'long');
  const shortTrades = trades.filter(t => t.side === 'short');
  const wins = trades.filter(t => t.netPnlPct > 0);
  const losses = trades.filter(t => t.netPnlPct <= 0);
  
  const longWins = longTrades.filter(t => t.netPnlPct > 0);
  const shortWins = shortTrades.filter(t => t.netPnlPct > 0);
  
  const roi = ((capital - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100);
  const winRate = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
  const longWR = longTrades.length > 0 ? (longWins.length / longTrades.length * 100) : 0;
  const shortWR = shortTrades.length > 0 ? (shortWins.length / shortTrades.length * 100) : 0;
  
  // Max drawdown
  let maxEquity = INITIAL_CAPITAL;
  let maxDrawdown = 0;
  for (const trade of trades) {
    if (trade.capitalAfter > maxEquity) maxEquity = trade.capitalAfter;
    const dd = (maxEquity - trade.capitalAfter) / maxEquity * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  
  // Monthly stats
  const months = Object.keys(monthlyPnl).sort();
  const positiveMonths = months.filter(m => monthlyPnl[m].pnl > 0);
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS V5.4 - LONG (Bull) + SHORT (Bear)');
  console.log('═'.repeat(80));
  
  console.log(`
┌────────────────────────────────────────────────────────────────────────────────┐
│                              PERFORMANCE GLOBALE                                │
├────────────────────────────────────────────────────────────────────────────────┤
│  💰 Capital: $${INITIAL_CAPITAL} → $${capital.toFixed(2).padStart(10)}                                       │
│  📈 ROI:     ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%                                                          │
│  🎯 Trades:  ${String(trades.length).padStart(4)} total (${longTrades.length} LONG + ${shortTrades.length} SHORT)                          │
│  🚫 Rejected: ${rejectedOrders} (insufficient capital)                                       │
│  ✅ Win Rate: ${winRate.toFixed(1)}% global                                                    │
│  📉 Max DD:  ${maxDrawdown.toFixed(1)}%                                                         │
│  💸 Frais:   $${totalCosts.toFixed(2)} (${(totalCosts/INITIAL_CAPITAL*100).toFixed(1)}% du capital initial)                       │
└────────────────────────────────────────────────────────────────────────────────┘
`);

  console.log(`
┌────────────────────────────────────────────────────────────────────────────────┐
│                              PAR STRATÉGIE                                      │
├────────────────────────────────────────────────────────────────────────────────┤
│  📈 LONG (Bull):                                                                │
│     Trades: ${String(longTrades.length).padStart(4)} | Win Rate: ${longWR.toFixed(1)}%                                        │
│     Signaux: ${longSignals} | Régime Bull: ${(bullBars/(bullBars+bearBars)*100).toFixed(1)}% du temps                         │
│                                                                                 │
│  📉 SHORT (Bear):                                                               │
│     Trades: ${String(shortTrades.length).padStart(4)} | Win Rate: ${shortWR.toFixed(1)}%                                       │
│     Signaux: ${shortSignals} | Régime Bear: ${(bearBars/(bullBars+bearBars)*100).toFixed(1)}% du temps                        │
└────────────────────────────────────────────────────────────────────────────────┘
`);

  // Monthly breakdown
  console.log('\n📅 PERFORMANCE MENSUELLE:');
  console.log('─'.repeat(80));
  console.log('  Mois      │    PnL     │ L Trades │ S Trades │ Cumul Capital');
  console.log('─'.repeat(80));
  
  let cumulCapital = INITIAL_CAPITAL;
  for (const m of months) {
    const data = monthlyPnl[m];
    cumulCapital += data.pnl;
    const pnlStr = data.pnl >= 0 ? `+$${data.pnl.toFixed(0)}` : `-$${Math.abs(data.pnl).toFixed(0)}`;
    const bar = data.pnl > 0 
      ? '█'.repeat(Math.min(15, Math.floor(data.pnl / 200)))
      : '░'.repeat(Math.min(15, Math.floor(Math.abs(data.pnl) / 200)));
    console.log(`  ${m}  │ ${pnlStr.padStart(9)} │    ${String(data.longTrades).padStart(3)}   │    ${String(data.shortTrades).padStart(3)}   │ $${cumulCapital.toFixed(0).padStart(8)} ${bar}`);
  }
  console.log('─'.repeat(80));
  console.log(`  TOTAL     │ ${roi >= 0 ? '+' : ''}$${(capital - INITIAL_CAPITAL).toFixed(0).padStart(8)} │    ${String(longTrades.length).padStart(3)}   │    ${String(shortTrades.length).padStart(3)}   │ $${capital.toFixed(0).padStart(8)}`);
  
  // Exit reasons
  console.log('\n📊 RAISONS DE SORTIE:');
  const exitReasons = {};
  trades.forEach(t => { exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1; });
  for (const [reason, count] of Object.entries(exitReasons)) {
    console.log(`   ${reason}: ${count} (${(count/trades.length*100).toFixed(1)}%)`);
  }
  
  // Best/Worst trades
  const sortedByPnl = [...trades].sort((a, b) => b.netPnlUsd - a.netPnlUsd);
  console.log('\n🏆 TOP 5 TRADES:');
  for (const t of sortedByPnl.slice(0, 5)) {
    console.log(`   ${t.side.toUpperCase().padEnd(5)} ${t.symbol.padEnd(16)} +$${t.netPnlUsd.toFixed(2)} (${t.netPnlPct.toFixed(1)}%) - ${t.exitReason}`);
  }
  
  console.log('\n💀 WORST 5 TRADES:');
  for (const t of sortedByPnl.slice(-5).reverse()) {
    console.log(`   ${t.side.toUpperCase().padEnd(5)} ${t.symbol.padEnd(16)} $${t.netPnlUsd.toFixed(2)} (${t.netPnlPct.toFixed(1)}%) - ${t.exitReason}`);
  }
  
  // Summary
  console.log('\n' + '═'.repeat(80));
  console.log('💡 RÉSUMÉ V5.4');
  console.log('═'.repeat(80));
  console.log(`
   ✅ ROI sur 24 mois: ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%
   ✅ Win Rate global: ${winRate.toFixed(1)}%
   ✅ Mois positifs: ${positiveMonths.length}/${months.length}
   ✅ Max Drawdown: ${maxDrawdown.toFixed(1)}%
   
   📈 LONG: ${longTrades.length} trades, ${longWR.toFixed(1)}% WR (${(bullBars/(bullBars+bearBars)*100).toFixed(1)}% du temps en Bull)
   📉 SHORT: ${shortTrades.length} trades, ${shortWR.toFixed(1)}% WR (${(bearBars/(bullBars+bearBars)*100).toFixed(1)}% du temps en Bear)
   
   💸 Coûts totaux: $${totalCosts.toFixed(2)} (${(totalCosts/trades.length).toFixed(2)}$/trade en moyenne)
`);
}

main().catch(console.error);
