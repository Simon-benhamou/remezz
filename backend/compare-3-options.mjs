/**
 * 🔬 COMPARAISON: 3 APPROCHES POUR RÉDUIRE LES FRAIS
 * 
 * 1. MOINS DE TRADES - Filtres plus stricts (ROC 2.5%, Vol 2x)
 * 2. TARGETS PLUS HAUTS - TP 5%, SL 2% (meilleur ratio gain/frais)
 * 3. LEVERAGE RÉDUIT - 3x au lieu de 5x
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

// ============================================================================
// PARAMÈTRES DE BASE
// ============================================================================

const BASE_FEES = {
  TRADING_FEE_PCT: 0.04,
  SLIPPAGE_PCT: 0.05,
  FUNDING_RATE_PCT: 0.01,
  FUNDING_INTERVAL_BARS: 32,
};

const POSITION_SIZE_PCT = 0.4;
const INITIAL_CAPITAL = 1000;
const SYMBOLS = ['SEI/USDT:USDT', 'XRP/USDT:USDT', 'ETH/USDT:USDT', 'IMX/USDT:USDT'];

// ============================================================================
// 3 CONFIGURATIONS À TESTER
// ============================================================================

const CONFIGS = {
  // Option 1: Moins de trades (filtres stricts)
  STRICT_FILTERS: {
    name: '1️⃣ Filtres Stricts (moins de trades)',
    leverage: 5,
    long: {
      rocMin: 2.5,          // Était 1.5%
      volMultiplier: 2.0,   // Était 1.3x
      maxConsecUp: 3,       // Était 4
    },
    short: {
      priceDropMin: -2,     // Était -1%
      volSpike: 2.5,        // Était 2x
    },
    exit: {
      stopLoss: 1.5,
      takeProfit: 3.0,
      trailingActivation: 1.0,
      trailingDistance: 0.4,
    }
  },
  
  // Option 2: Targets plus hauts
  HIGH_TARGETS: {
    name: '2️⃣ Targets Hauts (meilleur ratio)',
    leverage: 5,
    long: {
      rocMin: 1.5,
      volMultiplier: 1.3,
      maxConsecUp: 4,
    },
    short: {
      priceDropMin: -1,
      volSpike: 2.0,
    },
    exit: {
      stopLoss: 2.0,        // Était 1.5%
      takeProfit: 5.0,      // Était 3%
      trailingActivation: 1.5, // Était 1%
      trailingDistance: 0.6,   // Était 0.4%
    }
  },
  
  // Option 3: Leverage réduit
  LOW_LEVERAGE: {
    name: '3️⃣ Leverage Réduit (3x)',
    leverage: 3,           // Était 5x
    long: {
      rocMin: 1.5,
      volMultiplier: 1.3,
      maxConsecUp: 4,
    },
    short: {
      priceDropMin: -1,
      volSpike: 2.0,
    },
    exit: {
      stopLoss: 1.5,
      takeProfit: 3.0,
      trailingActivation: 1.0,
      trailingDistance: 0.4,
    }
  },
  
  // Baseline: Config actuelle
  BASELINE: {
    name: '📊 Baseline (config actuelle)',
    leverage: 5,
    long: {
      rocMin: 1.5,
      volMultiplier: 1.3,
      maxConsecUp: 4,
    },
    short: {
      priceDropMin: -1,
      volSpike: 2.0,
    },
    exit: {
      stopLoss: 1.5,
      takeProfit: 3.0,
      trailingActivation: 1.0,
      trailingDistance: 0.4,
    }
  }
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
// ENTRY SIGNALS (configurables)
// ============================================================================

function checkLongEntry(candles, btcAboveSma200, config) {
  if (!btcAboveSma200) return false;
  if (candles.length < 50) return false;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  const bb = calcBB(closes, 20, 2);
  if (!bb || current.close <= bb.upper) return false;
  
  const roc = calcROC(closes, 10);
  if (!roc || roc < config.long.rocMin) return false;
  
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * config.long.volMultiplier) return false;
  
  if (countConsecUp(candles) > config.long.maxConsecUp) return false;
  
  return true;
}

function checkShortEntry(candles, btcBelowSma200, config) {
  if (!btcBelowSma200) return false;
  if (candles.length < 50) return false;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  const roc5 = calcROC(closes, 5);
  if (!roc5 || roc5 > config.short.priceDropMin) return false;
  
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * config.short.volSpike) return false;
  
  const ma20 = calcSMA(closes, 20);
  if (!ma20 || current.close >= ma20) return false;
  
  return true;
}

// ============================================================================
// PNL CALCULATOR
// ============================================================================

function calculatePnl(entryPrice, exitPrice, side, capitalUsed, holdBars, leverage) {
  let pnlPct = side === 'long' 
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  const leveragedPnlPct = pnlPct * leverage;
  const entryFee = BASE_FEES.TRADING_FEE_PCT * leverage;
  const exitFee = BASE_FEES.TRADING_FEE_PCT * leverage;
  const totalSlippage = BASE_FEES.SLIPPAGE_PCT * 2 * leverage;
  const fundingPeriods = Math.floor(holdBars / BASE_FEES.FUNDING_INTERVAL_BARS);
  const totalFunding = fundingPeriods * BASE_FEES.FUNDING_RATE_PCT * leverage;
  
  const netPnlPct = leveragedPnlPct - entryFee - exitFee - totalSlippage - totalFunding;
  const netPnlUsd = (netPnlPct / 100) * capitalUsed;
  const totalCosts = (entryFee + exitFee + totalSlippage + totalFunding) / 100 * capitalUsed;
  
  return { netPnlPct, netPnlUsd, totalCosts };
}

// ============================================================================
// BACKTEST
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

async function runBacktest(config, btcCandles, btcCloses, allData) {
  let capital = INITIAL_CAPITAL;
  const results = { trades: [], totalCosts: 0, monthlyPnl: {} };
  
  const positions = {};
  const cooldowns = {};
  SYMBOLS.forEach(s => { positions[s] = null; cooldowns[s] = 0; });
  
  for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
    const btcAboveSma200 = btcSma200 ? btcCloses[btcIdx - 1] > btcSma200 : false;
    const btcBelowSma200 = btcSma200 ? btcCloses[btcIdx - 1] < btcSma200 : false;
    
    const month = new Date(btcCandle.timestamp).toISOString().slice(0, 7);
    if (!results.monthlyPnl[month]) results.monthlyPnl[month] = 0;
    
    for (const symbol of SYMBOLS) {
      const candles = allData[symbol];
      const idx = candles.findIndex(c => c.timestamp >= btcCandle.timestamp);
      if (idx < 50) continue;
      
      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];
      
      // Manage position
      if (positions[symbol]) {
        const pos = positions[symbol];
        const holdBars = idx - pos.entryIdx;
        let exitReason = null, exitPrice = current.close;
        
        if (pos.side === 'long') {
          const pnlPct = ((current.close - pos.entryPrice) / pos.entryPrice) * 100;
          pos.hwm = Math.max(pos.hwm || pos.entryPrice, current.high);
          const hwmPct = ((pos.hwm - pos.entryPrice) / pos.entryPrice) * 100;
          
          if (pnlPct <= -config.exit.stopLoss) {
            exitReason = 'SL';
            exitPrice = pos.entryPrice * (1 - config.exit.stopLoss / 100);
          } else if (pnlPct >= config.exit.takeProfit) {
            exitReason = 'TP';
            exitPrice = pos.entryPrice * (1 + config.exit.takeProfit / 100);
          } else if (hwmPct >= config.exit.trailingActivation) {
            const trailStop = pos.hwm * (1 - config.exit.trailingDistance / 100);
            if (current.low <= trailStop) { exitReason = 'TRAIL'; exitPrice = trailStop; }
          } else if (holdBars >= 192) { exitReason = 'TIME'; }
        } else {
          const pnlPct = ((pos.entryPrice - current.close) / pos.entryPrice) * 100;
          pos.lwm = Math.min(pos.lwm || pos.entryPrice, current.low);
          const lwmPct = ((pos.entryPrice - pos.lwm) / pos.entryPrice) * 100;
          
          if (pnlPct <= -config.exit.stopLoss) {
            exitReason = 'SL';
            exitPrice = pos.entryPrice * (1 + config.exit.stopLoss / 100);
          } else if (pnlPct >= config.exit.takeProfit) {
            exitReason = 'TP';
            exitPrice = pos.entryPrice * (1 - config.exit.takeProfit / 100);
          } else if (lwmPct >= config.exit.trailingActivation) {
            const trailStop = pos.lwm * (1 + config.exit.trailingDistance / 100);
            if (current.high >= trailStop) { exitReason = 'TRAIL'; exitPrice = trailStop; }
          } else if (holdBars >= 192) { exitReason = 'TIME'; }
        }
        
        if (exitReason) {
          const pnl = calculatePnl(pos.entryPrice, exitPrice, pos.side, pos.capitalUsed, holdBars, config.leverage);
          capital += pnl.netPnlUsd;
          results.trades.push({ side: pos.side, netPnlPct: pnl.netPnlPct, netPnlUsd: pnl.netPnlUsd, exitReason });
          results.totalCosts += pnl.totalCosts;
          results.monthlyPnl[month] += pnl.netPnlUsd;
          positions[symbol] = null;
          cooldowns[symbol] = 8;
        }
      }
      
      // Check entries
      if (!positions[symbol] && cooldowns[symbol] <= 0 && capital > 100) {
        const capitalToUse = capital * POSITION_SIZE_PCT;
        
        if (btcAboveSma200 && checkLongEntry(windowCandles, true, config)) {
          positions[symbol] = { side: 'long', entryPrice: current.close, entryIdx: idx, capitalUsed: capitalToUse, hwm: current.close };
        } else if (btcBelowSma200 && checkShortEntry(windowCandles, true, config)) {
          positions[symbol] = { side: 'short', entryPrice: current.close, entryIdx: idx, capitalUsed: capitalToUse, lwm: current.close };
        }
      }
      
      if (cooldowns[symbol] > 0) cooldowns[symbol]--;
    }
  }
  
  return { results, finalCapital: capital };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 COMPARAISON: 3 APPROCHES POUR OPTIMISER LE ROI');
  console.log('═'.repeat(80));
  
  console.log('\n📊 Fetching data (12 mois)...');
  const btcCandles = await fetchCandles('BTC/USDT:USDT', 12);
  const btcCloses = btcCandles.map(c => c.close);
  console.log(`   BTC: ${btcCandles.length} candles`);
  
  const allData = {};
  for (const symbol of SYMBOLS) {
    allData[symbol] = await fetchCandles(symbol, 12);
    console.log(`   ${symbol}: ${allData[symbol].length} candles`);
  }
  
  const allResults = [];
  
  for (const [key, config] of Object.entries(CONFIGS)) {
    console.log(`\n🔄 Testing: ${config.name}...`);
    const { results, finalCapital } = await runBacktest(config, btcCandles, btcCloses, allData);
    
    const wins = results.trades.filter(t => t.netPnlPct > 0).length;
    const roi = ((finalCapital - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100).toFixed(1);
    const winRate = results.trades.length > 0 ? (wins / results.trades.length * 100).toFixed(1) : 0;
    const months = Object.keys(results.monthlyPnl).sort();
    const positiveMonths = months.filter(m => results.monthlyPnl[m] > 0).length;
    
    allResults.push({
      key,
      name: config.name,
      leverage: config.leverage,
      trades: results.trades.length,
      winRate,
      roi,
      totalCosts: results.totalCosts,
      positiveMonths,
      totalMonths: months.length,
      finalCapital,
      monthlyPnl: results.monthlyPnl
    });
  }
  
  // Résumé
  console.log('\n' + '═'.repeat(90));
  console.log('📊 RÉSUMÉ COMPARATIF');
  console.log('═'.repeat(90));
  
  console.log('\n┌───────────────────────────────────────┬────────┬────────┬──────────┬──────────┬──────────┐');
  console.log('│ Configuration                         │ Trades │ WR %   │  ROI %   │  Frais   │ Mois +   │');
  console.log('├───────────────────────────────────────┼────────┼────────┼──────────┼──────────┼──────────┤');
  
  for (const r of allResults) {
    const roiStr = parseFloat(r.roi) >= 0 ? `+${r.roi}` : r.roi;
    console.log(`│ ${r.name.padEnd(37)} │ ${String(r.trades).padStart(6)} │ ${String(r.winRate).padStart(5)}% │ ${roiStr.padStart(7)}% │ $${r.totalCosts.toFixed(0).padStart(6)} │ ${r.positiveMonths}/${r.totalMonths}      │`);
  }
  
  console.log('└───────────────────────────────────────┴────────┴────────┴──────────┴──────────┴──────────┘');
  
  // Détails mensuels pour le meilleur
  const best = allResults.reduce((a, b) => parseFloat(a.roi) > parseFloat(b.roi) ? a : b);
  
  console.log(`\n🏆 MEILLEURE OPTION: ${best.name}`);
  console.log(`   ROI: +${best.roi}% | Trades: ${best.trades} | Win Rate: ${best.winRate}%`);
  console.log(`   Capital: $${INITIAL_CAPITAL} → $${best.finalCapital.toFixed(2)}`);
  
  console.log(`\n📅 Performance mensuelle (${best.name}):`);
  const months = Object.keys(best.monthlyPnl).sort();
  for (const m of months) {
    const pnl = best.monthlyPnl[m];
    const bar = pnl > 0 ? '█'.repeat(Math.min(20, Math.floor(pnl / 20))) : '';
    const str = pnl >= 0 ? `+$${pnl.toFixed(0)}` : `-$${Math.abs(pnl).toFixed(0)}`;
    console.log(`   ${m}: ${str.padStart(8)} ${bar}`);
  }
  
  // Recommandation finale
  console.log('\n' + '═'.repeat(90));
  console.log('💡 ANALYSE');
  console.log('═'.repeat(90));
  
  const baseline = allResults.find(r => r.key === 'BASELINE');
  const strict = allResults.find(r => r.key === 'STRICT_FILTERS');
  const highTarget = allResults.find(r => r.key === 'HIGH_TARGETS');
  const lowLev = allResults.find(r => r.key === 'LOW_LEVERAGE');
  
  console.log(`
   📊 Baseline:           ${baseline.roi}% ROI, ${baseline.trades} trades, $${baseline.totalCosts.toFixed(0)} frais
   1️⃣ Filtres Stricts:    ${strict.roi}% ROI, ${strict.trades} trades, $${strict.totalCosts.toFixed(0)} frais
   2️⃣ Targets Hauts:      ${highTarget.roi}% ROI, ${highTarget.trades} trades, $${highTarget.totalCosts.toFixed(0)} frais
   3️⃣ Leverage Réduit:    ${lowLev.roi}% ROI, ${lowLev.trades} trades, $${lowLev.totalCosts.toFixed(0)} frais

   ✅ RECOMMANDATION: ${best.name}
      - Améliore le ROI de ${baseline.roi}% à ${best.roi}%
      - ${best.positiveMonths}/${best.totalMonths} mois positifs
  `);
}

main().catch(console.error);
