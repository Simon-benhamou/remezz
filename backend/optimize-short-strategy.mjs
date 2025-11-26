/**
 * 🔬 OPTIMISATION STRATÉGIE SHORT
 * 
 * Teste différentes configurations de filtres SHORT avec frais réalistes
 * pour trouver la config optimale (comme on a fait pour LONG)
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

// ============================================================================
// PARAMÈTRES RÉALISTES
// ============================================================================

const COSTS = {
  TRADING_FEE_PCT: 0.04,      // 0.04% per side
  SLIPPAGE_PCT: 0.05,         // 0.05% per side
  FUNDING_RATE_PCT: 0.01,     // 0.01% every 8h
  FUNDING_INTERVAL_BARS: 32,  // 32 × 15min = 8h
};

const LEVERAGE = 5;
const POSITION_SIZE_PCT = 0.4;
const INITIAL_CAPITAL = 1000;
const SYMBOLS = ['SEI/USDT:USDT', 'XRP/USDT:USDT', 'ETH/USDT:USDT', 'IMX/USDT:USDT'];

// ============================================================================
// CONFIGURATIONS SHORT À TESTER
// ============================================================================

const SHORT_CONFIGS = {
  // Config actuelle V5.3
  CURRENT: {
    name: '📊 Current V5.3',
    rocDropMin: -2,       // ROC5 < -2%
    volSpike: 2.5,        // Volume > 2.5x
    maxConsecDown: 5,     // Pas oversold
    priceBelowMa20: true,
  },
  
  // Plus strict (comme LONG)
  STRICT: {
    name: '1️⃣ Strict (ROC -3%, Vol 3x)',
    rocDropMin: -3,       // ROC5 < -3%
    volSpike: 3.0,        // Volume > 3x
    maxConsecDown: 4,     // Moins tolérant
    priceBelowMa20: true,
  },
  
  // Très strict
  VERY_STRICT: {
    name: '2️⃣ Very Strict (ROC -4%, Vol 3.5x)',
    rocDropMin: -4,       // ROC5 < -4%
    volSpike: 3.5,        // Volume > 3.5x
    maxConsecDown: 3,
    priceBelowMa20: true,
  },
  
  // Plus loose (plus de trades)
  LOOSE: {
    name: '3️⃣ Loose (ROC -1.5%, Vol 2x)',
    rocDropMin: -1.5,
    volSpike: 2.0,
    maxConsecDown: 6,
    priceBelowMa20: true,
  },
  
  // Avec BB breakdown
  BB_BREAKDOWN: {
    name: '4️⃣ BB Breakdown (Price < BB Lower)',
    rocDropMin: -1.5,
    volSpike: 2.0,
    maxConsecDown: 5,
    priceBelowMa20: true,
    priceBelowBBLower: true,  // Ajout filtre BB
  },
  
  // Sans filtre MA20
  NO_MA20: {
    name: '5️⃣ Sans MA20 (ROC -2.5%, Vol 2.5x)',
    rocDropMin: -2.5,
    volSpike: 2.5,
    maxConsecDown: 5,
    priceBelowMa20: false,  // Pas de filtre MA20
  },
};

// Exit config (même pour tous)
const EXIT_CONFIG = {
  stopLoss: 1.5,
  takeProfit: 3.0,
  trailingActivation: 1.0,
  trailingDistance: 0.4,
  maxHoldBars: 192,  // 48h
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

function countConsecDown(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close < candles[i].open) count++;
    else break;
  }
  return count;
}

// ============================================================================
// SHORT ENTRY CHECK
// ============================================================================

function checkShortEntry(candles, config) {
  if (candles.length < 50) return { valid: false, reason: 'insufficient_data' };
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  // Must be bearish candle
  if (current.close >= current.open) {
    return { valid: false, reason: 'bullish_candle' };
  }
  
  // ROC check
  const roc5 = calcROC(closes, 5);
  if (!roc5 || roc5 > config.rocDropMin) {
    return { valid: false, reason: `roc5_too_high(${roc5?.toFixed(2)}% > ${config.rocDropMin}%)` };
  }
  
  // Volume spike check
  const volAvg = calcVolAvg(volumes);
  const volRatio = volAvg ? current.volume / volAvg : 0;
  if (volRatio < config.volSpike) {
    return { valid: false, reason: `vol_low(${volRatio.toFixed(1)}x < ${config.volSpike}x)` };
  }
  
  // ConsecDown check (avoid oversold)
  const consecDown = countConsecDown(candles);
  if (consecDown > config.maxConsecDown) {
    return { valid: false, reason: `oversold(${consecDown} > ${config.maxConsecDown})` };
  }
  
  // Price below MA20 check
  if (config.priceBelowMa20) {
    const ma20 = calcSMA(closes, 20);
    if (!ma20 || current.close >= ma20) {
      return { valid: false, reason: 'price_above_ma20' };
    }
  }
  
  // BB breakdown check (optional)
  if (config.priceBelowBBLower) {
    const bb = calcBB(closes);
    if (!bb || current.close >= bb.lower) {
      return { valid: false, reason: 'price_above_bb_lower' };
    }
  }
  
  return { 
    valid: true, 
    features: { roc5, volRatio, consecDown }
  };
}

// ============================================================================
// PNL CALCULATOR WITH COSTS
// ============================================================================

function calculatePnl(entryPrice, exitPrice, capitalUsed, holdBars) {
  // SHORT: profit when price goes down
  const pnlPct = ((entryPrice - exitPrice) / entryPrice) * 100;
  const leveragedPnlPct = pnlPct * LEVERAGE;
  
  // Costs
  const entryFee = COSTS.TRADING_FEE_PCT * LEVERAGE;
  const exitFee = COSTS.TRADING_FEE_PCT * LEVERAGE;
  const totalSlippage = COSTS.SLIPPAGE_PCT * 2 * LEVERAGE;
  const fundingPeriods = Math.floor(holdBars / COSTS.FUNDING_INTERVAL_BARS);
  const totalFunding = fundingPeriods * COSTS.FUNDING_RATE_PCT * LEVERAGE;
  
  const totalCosts = entryFee + exitFee + totalSlippage + totalFunding;
  const netPnlPct = leveragedPnlPct - totalCosts;
  const netPnlUsd = (netPnlPct / 100) * capitalUsed;
  const costsUsd = (totalCosts / 100) * capitalUsed;
  
  return { netPnlPct, netPnlUsd, costsUsd, grossPnlPct: leveragedPnlPct };
}

// ============================================================================
// BACKTEST SHORT ONLY
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

async function runShortBacktest(config, btcCandles, btcCloses, allData) {
  let capital = INITIAL_CAPITAL;
  const trades = [];
  let totalCosts = 0;
  const monthlyPnl = {};
  const rejectionReasons = {};
  
  const positions = {};
  const cooldowns = {};
  SYMBOLS.forEach(s => { positions[s] = null; cooldowns[s] = 0; });
  
  for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
    const btcBelowSma200 = btcSma200 ? btcCloses[btcIdx - 1] < btcSma200 : false;
    
    // Skip if not in bear regime
    if (!btcBelowSma200) {
      // Decay cooldowns anyway
      SYMBOLS.forEach(s => { if (cooldowns[s] > 0) cooldowns[s]--; });
      continue;
    }
    
    const month = new Date(btcCandle.timestamp).toISOString().slice(0, 7);
    if (!monthlyPnl[month]) monthlyPnl[month] = 0;
    
    for (const symbol of SYMBOLS) {
      const candles = allData[symbol];
      const idx = candles.findIndex(c => c.timestamp >= btcCandle.timestamp);
      if (idx < 50) continue;
      
      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];
      
      // Manage existing position
      if (positions[symbol]) {
        const pos = positions[symbol];
        const holdBars = idx - pos.entryIdx;
        let exitReason = null, exitPrice = current.close;
        
        // SHORT P&L: profit when price goes down
        const pnlPct = ((pos.entryPrice - current.close) / pos.entryPrice) * 100;
        pos.lwm = Math.min(pos.lwm || pos.entryPrice, current.low);
        const lwmPct = ((pos.entryPrice - pos.lwm) / pos.entryPrice) * 100;
        
        // Exit conditions
        if (pnlPct <= -EXIT_CONFIG.stopLoss) {
          exitReason = 'SL';
          exitPrice = pos.entryPrice * (1 + EXIT_CONFIG.stopLoss / 100);
        } else if (pnlPct >= EXIT_CONFIG.takeProfit) {
          exitReason = 'TP';
          exitPrice = pos.entryPrice * (1 - EXIT_CONFIG.takeProfit / 100);
        } else if (lwmPct >= EXIT_CONFIG.trailingActivation) {
          const trailStop = pos.lwm * (1 + EXIT_CONFIG.trailingDistance / 100);
          if (current.high >= trailStop) { 
            exitReason = 'TRAIL'; 
            exitPrice = trailStop; 
          }
        } else if (holdBars >= EXIT_CONFIG.maxHoldBars) { 
          exitReason = 'TIME'; 
        }
        
        if (exitReason) {
          const pnl = calculatePnl(pos.entryPrice, exitPrice, pos.capitalUsed, holdBars);
          capital += pnl.netPnlUsd;
          trades.push({ 
            symbol, 
            side: 'short',
            entryPrice: pos.entryPrice,
            exitPrice,
            netPnlPct: pnl.netPnlPct, 
            netPnlUsd: pnl.netPnlUsd,
            grossPnlPct: pnl.grossPnlPct,
            exitReason,
            holdBars,
            month
          });
          totalCosts += pnl.costsUsd;
          monthlyPnl[month] += pnl.netPnlUsd;
          positions[symbol] = null;
          cooldowns[symbol] = 8;
        }
      }
      
      // Check for new short entry
      if (!positions[symbol] && cooldowns[symbol] <= 0 && capital > 100) {
        const entryCheck = checkShortEntry(windowCandles, config);
        
        if (entryCheck.valid) {
          const capitalToUse = capital * POSITION_SIZE_PCT;
          positions[symbol] = { 
            entryPrice: current.close, 
            entryIdx: idx, 
            capitalUsed: capitalToUse,
            lwm: current.close
          };
        } else {
          // Track rejection reasons
          const reason = entryCheck.reason.split('(')[0];
          rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
        }
      }
      
      if (cooldowns[symbol] > 0) cooldowns[symbol]--;
    }
  }
  
  return { trades, totalCosts, monthlyPnl, finalCapital: capital, rejectionReasons };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 OPTIMISATION STRATÉGIE SHORT - Avec Frais Réalistes');
  console.log('═'.repeat(80));
  console.log(`\n📊 Paramètres: Leverage ${LEVERAGE}x, Position ${POSITION_SIZE_PCT*100}%`);
  console.log(`💰 Frais: Trading ${COSTS.TRADING_FEE_PCT}%, Slippage ${COSTS.SLIPPAGE_PCT}%, Funding ${COSTS.FUNDING_RATE_PCT}%/8h`);
  
  console.log('\n📊 Fetching data (12 mois)...');
  const btcCandles = await fetchCandles('BTC/USDT:USDT', 12);
  const btcCloses = btcCandles.map(c => c.close);
  console.log(`   BTC: ${btcCandles.length} candles`);
  
  // Count bear regime bars
  let bearBars = 0;
  for (let i = 200; i < btcCandles.length; i++) {
    const sma200 = calcSMA(btcCloses.slice(0, i), 200);
    if (btcCloses[i-1] < sma200) bearBars++;
  }
  console.log(`   Bear regime bars: ${bearBars} / ${btcCandles.length - 200} (${(bearBars / (btcCandles.length - 200) * 100).toFixed(1)}%)`);
  
  const allData = {};
  for (const symbol of SYMBOLS) {
    allData[symbol] = await fetchCandles(symbol, 12);
    console.log(`   ${symbol}: ${allData[symbol].length} candles`);
  }
  
  const allResults = [];
  
  for (const [key, config] of Object.entries(SHORT_CONFIGS)) {
    console.log(`\n🔄 Testing: ${config.name}...`);
    const result = await runShortBacktest(config, btcCandles, btcCloses, allData);
    
    const wins = result.trades.filter(t => t.netPnlPct > 0).length;
    const losses = result.trades.length - wins;
    const roi = ((result.finalCapital - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100).toFixed(1);
    const winRate = result.trades.length > 0 ? (wins / result.trades.length * 100).toFixed(1) : 0;
    
    // Calculate average win/loss
    const avgWin = wins > 0 
      ? result.trades.filter(t => t.netPnlPct > 0).reduce((sum, t) => sum + t.netPnlPct, 0) / wins 
      : 0;
    const avgLoss = losses > 0 
      ? Math.abs(result.trades.filter(t => t.netPnlPct <= 0).reduce((sum, t) => sum + t.netPnlPct, 0) / losses)
      : 0;
    
    const months = Object.keys(result.monthlyPnl).sort();
    const positiveMonths = months.filter(m => result.monthlyPnl[m] > 0).length;
    
    // Exit reason breakdown
    const exitReasons = {};
    result.trades.forEach(t => {
      exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
    });
    
    allResults.push({
      key,
      name: config.name,
      trades: result.trades.length,
      wins,
      losses,
      winRate,
      roi,
      totalCosts: result.totalCosts,
      positiveMonths,
      totalMonths: months.length,
      finalCapital: result.finalCapital,
      monthlyPnl: result.monthlyPnl,
      avgWin,
      avgLoss,
      exitReasons,
      rejectionReasons: result.rejectionReasons,
    });
  }
  
  // ============================================================================
  // RÉSULTATS
  // ============================================================================
  
  console.log('\n' + '═'.repeat(100));
  console.log('📊 RÉSUMÉ COMPARATIF - SHORT STRATEGIES');
  console.log('═'.repeat(100));
  
  console.log('\n┌─────────────────────────────────────────┬────────┬────────┬──────────┬──────────┬───────────┬──────────┐');
  console.log('│ Configuration                           │ Trades │ WR %   │  ROI %   │ Avg Win  │ Avg Loss  │ Mois +   │');
  console.log('├─────────────────────────────────────────┼────────┼────────┼──────────┼──────────┼───────────┼──────────┤');
  
  for (const r of allResults) {
    const roiStr = parseFloat(r.roi) >= 0 ? `+${r.roi}` : r.roi;
    console.log(`│ ${r.name.padEnd(39)} │ ${String(r.trades).padStart(6)} │ ${String(r.winRate).padStart(5)}% │ ${roiStr.padStart(7)}% │ ${r.avgWin.toFixed(1).padStart(7)}% │ ${r.avgLoss.toFixed(1).padStart(8)}% │ ${r.positiveMonths}/${r.totalMonths}      │`);
  }
  
  console.log('└─────────────────────────────────────────┴────────┴────────┴──────────┴──────────┴───────────┴──────────┘');
  
  // Find best
  const best = allResults.reduce((a, b) => parseFloat(a.roi) > parseFloat(b.roi) ? a : b);
  const current = allResults.find(r => r.key === 'CURRENT');
  
  console.log(`\n🏆 MEILLEURE CONFIG: ${best.name}`);
  console.log(`   ROI: ${best.roi}% | Trades: ${best.trades} | WR: ${best.winRate}%`);
  console.log(`   Capital: $${INITIAL_CAPITAL} → $${best.finalCapital.toFixed(2)}`);
  
  // Exit reasons for best
  console.log(`\n📈 Exit Reasons (${best.name}):`);
  for (const [reason, count] of Object.entries(best.exitReasons)) {
    const pct = (count / best.trades * 100).toFixed(1);
    console.log(`   ${reason}: ${count} (${pct}%)`);
  }
  
  // Monthly performance
  console.log(`\n📅 Performance Mensuelle (${best.name}):`);
  const months = Object.keys(best.monthlyPnl).sort();
  for (const m of months) {
    const pnl = best.monthlyPnl[m];
    const bar = pnl > 0 ? '█'.repeat(Math.min(20, Math.floor(Math.abs(pnl) / 50))) : '';
    const barNeg = pnl < 0 ? '░'.repeat(Math.min(20, Math.floor(Math.abs(pnl) / 50))) : '';
    const str = pnl >= 0 ? `+$${pnl.toFixed(0)}` : `-$${Math.abs(pnl).toFixed(0)}`;
    console.log(`   ${m}: ${str.padStart(8)} ${bar}${barNeg}`);
  }
  
  // Comparison with current
  if (best.key !== 'CURRENT') {
    console.log('\n' + '═'.repeat(100));
    console.log('💡 RECOMMANDATION');
    console.log('═'.repeat(100));
    console.log(`
   Config actuelle: ${current.roi}% ROI, ${current.trades} trades, ${current.winRate}% WR
   Meilleure:       ${best.roi}% ROI, ${best.trades} trades, ${best.winRate}% WR
   
   Amélioration: ${(parseFloat(best.roi) - parseFloat(current.roi)).toFixed(1)}% ROI
   
   ✅ APPLIQUER: ${best.name}
    `);
  } else {
    console.log('\n' + '═'.repeat(100));
    console.log('💡 ANALYSE');
    console.log('═'.repeat(100));
    console.log(`
   ✅ La config actuelle V5.3 est déjà optimale!
   
   ROI: ${current.roi}%
   Trades: ${current.trades}
   Win Rate: ${current.winRate}%
   Mois positifs: ${current.positiveMonths}/${current.totalMonths}
    `);
  }
  
  // Costs analysis
  console.log('\n📊 ANALYSE DES COÛTS:');
  for (const r of allResults) {
    const costPerTrade = r.trades > 0 ? r.totalCosts / r.trades : 0;
    const costPct = (r.totalCosts / INITIAL_CAPITAL * 100).toFixed(1);
    console.log(`   ${r.name.padEnd(35)}: $${r.totalCosts.toFixed(0)} total (${costPct}% du capital, $${costPerTrade.toFixed(2)}/trade)`);
  }
}

main().catch(console.error);
