/**
 * 🔬 TEST POSITION SIZE - V5.4
 * 
 * Compare 40% vs 30% vs 25% position size
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  LONG: { BB_PERIOD: 20, BB_STD: 2, ROC_MIN: 2.5, VOL_MULTIPLIER: 2.0, MAX_CONSEC_UP: 3 },
  SHORT: { ROC_DROP_MIN: -1.5, VOL_SPIKE: 2.0, PRICE_BELOW_BB_LOWER: true, MAX_CONSEC_DOWN: 5 },
  EXIT: { STOP_LOSS: 1.5, TAKE_PROFIT: 3.0, TRAILING_ACTIVATION: 1.0, TRAILING_DISTANCE: 0.4, MAX_HOLD_BARS: 192 },
  LEVERAGE: 5,
};

const COSTS = { TRADING_FEE_PCT: 0.04, SLIPPAGE_PCT: 0.05, FUNDING_RATE_PCT: 0.01, FUNDING_INTERVAL_BARS: 32 };
const INITIAL_CAPITAL = 1000;
const SYMBOLS = ['SEI/USDT:USDT', 'XRP/USDT:USDT', 'ETH/USDT:USDT', 'IMX/USDT:USDT'];

// Position sizes to test
const POSITION_SIZES = [0.40, 0.30, 0.25, 0.20];

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

function countConsec(candles, up = true) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const bullish = candles[i].close > candles[i].open;
    if ((up && bullish) || (!up && !bullish)) count++;
    else break;
  }
  return count;
}

// ============================================================================
// ENTRY CHECKS
// ============================================================================

function checkLongEntry(candles) {
  if (candles.length < 50) return false;
  const closes = candles.map(c => c.close), volumes = candles.map(c => c.volume), current = candles[candles.length - 1];
  if (current.close <= current.open) return false;
  const bb = calcBB(closes);
  if (!bb || current.close <= bb.upper) return false;
  const roc = calcROC(closes, 10);
  if (!roc || roc < CONFIG.LONG.ROC_MIN) return false;
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * CONFIG.LONG.VOL_MULTIPLIER) return false;
  if (countConsec(candles, true) > CONFIG.LONG.MAX_CONSEC_UP) return false;
  return true;
}

function checkShortEntry(candles) {
  if (candles.length < 50) return false;
  const closes = candles.map(c => c.close), volumes = candles.map(c => c.volume), current = candles[candles.length - 1];
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
  if (countConsec(candles, false) > CONFIG.SHORT.MAX_CONSEC_DOWN) return false;
  return true;
}

// ============================================================================
// PNL CALCULATOR
// ============================================================================

function calculatePnl(entryPrice, exitPrice, side, capitalUsed, holdBars) {
  let pnlPct = side === 'long' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - exitPrice) / entryPrice) * 100;
  const leveragedPnlPct = pnlPct * CONFIG.LEVERAGE;
  const totalCosts = (COSTS.TRADING_FEE_PCT * 2 + COSTS.SLIPPAGE_PCT * 2) * CONFIG.LEVERAGE + Math.floor(holdBars / COSTS.FUNDING_INTERVAL_BARS) * COSTS.FUNDING_RATE_PCT * CONFIG.LEVERAGE;
  return { netPnlPct: leveragedPnlPct - totalCosts, netPnlUsd: ((leveragedPnlPct - totalCosts) / 100) * capitalUsed, costsUsd: (totalCosts / 100) * capitalUsed };
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
    for (const c of ohlcv) allCandles.push({ timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] });
    cursor = ohlcv[ohlcv.length - 1][0] + 1;
    await new Promise(r => setTimeout(r, 50));
  }
  return allCandles;
}

// ============================================================================
// BACKTEST
// ============================================================================

async function runBacktest(positionSizePct, btcCandles, btcCloses, allData) {
  let capital = INITIAL_CAPITAL;
  const trades = [];
  let totalCosts = 0;
  const positions = {}, cooldowns = {};
  SYMBOLS.forEach(s => { positions[s] = null; cooldowns[s] = 0; });
  
  let maxEquity = INITIAL_CAPITAL, maxDrawdown = 0;
  const monthlyPnl = {};
  
  for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
    const btcPrice = btcCloses[btcIdx - 1];
    const isBullRegime = btcPrice > btcSma200;
    const isBearRegime = btcPrice < btcSma200;
    
    const month = new Date(btcCandle.timestamp).toISOString().slice(0, 7);
    if (!monthlyPnl[month]) monthlyPnl[month] = 0;
    
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
          if (pnlPct <= -CONFIG.EXIT.STOP_LOSS) { exitReason = 'SL'; exitPrice = pos.entryPrice * (1 - CONFIG.EXIT.STOP_LOSS / 100); }
          else if (pnlPct >= CONFIG.EXIT.TAKE_PROFIT) { exitReason = 'TP'; exitPrice = pos.entryPrice * (1 + CONFIG.EXIT.TAKE_PROFIT / 100); }
          else if (hwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION && current.low <= pos.hwm * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100)) { exitReason = 'TRAIL'; exitPrice = pos.hwm * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100); }
          else if (holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) exitReason = 'TIME';
        } else {
          const pnlPct = ((pos.entryPrice - current.close) / pos.entryPrice) * 100;
          pos.lwm = Math.min(pos.lwm || pos.entryPrice, current.low);
          const lwmPct = ((pos.entryPrice - pos.lwm) / pos.entryPrice) * 100;
          if (pnlPct <= -CONFIG.EXIT.STOP_LOSS) { exitReason = 'SL'; exitPrice = pos.entryPrice * (1 + CONFIG.EXIT.STOP_LOSS / 100); }
          else if (pnlPct >= CONFIG.EXIT.TAKE_PROFIT) { exitReason = 'TP'; exitPrice = pos.entryPrice * (1 - CONFIG.EXIT.TAKE_PROFIT / 100); }
          else if (lwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION && current.high >= pos.lwm * (1 + CONFIG.EXIT.TRAILING_DISTANCE / 100)) { exitReason = 'TRAIL'; exitPrice = pos.lwm * (1 + CONFIG.EXIT.TRAILING_DISTANCE / 100); }
          else if (holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) exitReason = 'TIME';
        }
        
        if (exitReason) {
          const pnl = calculatePnl(pos.entryPrice, exitPrice, pos.side, pos.capitalUsed, holdBars);
          capital += pnl.netPnlUsd;
          totalCosts += pnl.costsUsd;
          trades.push({ side: pos.side, netPnlPct: pnl.netPnlPct, netPnlUsd: pnl.netPnlUsd, exitReason });
          monthlyPnl[month] += pnl.netPnlUsd;
          positions[symbol] = null;
          cooldowns[symbol] = 8;
          
          if (capital > maxEquity) maxEquity = capital;
          const dd = (maxEquity - capital) / maxEquity * 100;
          if (dd > maxDrawdown) maxDrawdown = dd;
        }
      }
      
      // New entry
      if (!positions[symbol] && cooldowns[symbol] <= 0 && capital > 100) {
        const capitalToUse = capital * positionSizePct;
        if (isBullRegime && checkLongEntry(windowCandles)) {
          positions[symbol] = { side: 'long', entryPrice: current.close, entryIdx: idx, capitalUsed: capitalToUse, hwm: current.close };
        } else if (isBearRegime && checkShortEntry(windowCandles)) {
          positions[symbol] = { side: 'short', entryPrice: current.close, entryIdx: idx, capitalUsed: capitalToUse, lwm: current.close };
        }
      }
      if (cooldowns[symbol] > 0) cooldowns[symbol]--;
    }
  }
  
  const months = Object.keys(monthlyPnl).sort();
  const positiveMonths = months.filter(m => monthlyPnl[m] > 0).length;
  
  return { 
    finalCapital: capital, 
    trades: trades.length, 
    winRate: trades.length > 0 ? (trades.filter(t => t.netPnlPct > 0).length / trades.length * 100) : 0,
    maxDrawdown,
    totalCosts,
    positiveMonths,
    totalMonths: months.length,
    longTrades: trades.filter(t => t.side === 'long').length,
    shortTrades: trades.filter(t => t.side === 'short').length,
  };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 TEST POSITION SIZE - V5.4');
  console.log('═'.repeat(80));
  
  console.log('\n📊 Fetching data...');
  const btcCandles = await fetchCandles('BTC/USDT:USDT', 12);
  const btcCloses = btcCandles.map(c => c.close);
  console.log(`   BTC: ${btcCandles.length} candles`);
  
  const allData = {};
  for (const symbol of SYMBOLS) {
    allData[symbol] = await fetchCandles(symbol, 12);
    console.log(`   ${symbol}: ${allData[symbol].length} candles`);
  }
  
  const results = [];
  
  for (const posSize of POSITION_SIZES) {
    console.log(`\n🔄 Testing ${(posSize * 100).toFixed(0)}% position size...`);
    const result = await runBacktest(posSize, btcCandles, btcCloses, allData);
    const roi = ((result.finalCapital - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100);
    results.push({ posSize, ...result, roi });
  }
  
  // Results
  console.log('\n' + '═'.repeat(90));
  console.log('📊 COMPARAISON POSITION SIZE');
  console.log('═'.repeat(90));
  
  console.log('\n┌──────────────┬────────┬────────┬──────────┬──────────┬──────────┬──────────┐');
  console.log('│ Position %   │ Trades │ WR %   │  ROI %   │ Max DD   │  Frais   │ Mois +   │');
  console.log('├──────────────┼────────┼────────┼──────────┼──────────┼──────────┼──────────┤');
  
  for (const r of results) {
    const roiStr = r.roi >= 0 ? `+${r.roi.toFixed(0)}` : r.roi.toFixed(0);
    console.log(`│ ${(r.posSize * 100).toFixed(0).padStart(3)}%         │ ${String(r.trades).padStart(6)} │ ${r.winRate.toFixed(1).padStart(5)}% │ ${roiStr.padStart(7)}% │ ${r.maxDrawdown.toFixed(1).padStart(6)}% │ $${r.totalCosts.toFixed(0).padStart(6)} │ ${r.positiveMonths}/${r.totalMonths}      │`);
  }
  
  console.log('└──────────────┴────────┴────────┴──────────┴──────────┴──────────┴──────────┘');
  
  // Analysis
  console.log('\n💡 ANALYSE:');
  for (const r of results) {
    const riskReward = r.roi / r.maxDrawdown;
    console.log(`   ${(r.posSize * 100).toFixed(0)}%: ROI ${r.roi.toFixed(0)}%, DD ${r.maxDrawdown.toFixed(1)}% → Risk/Reward: ${riskReward.toFixed(2)}`);
  }
  
  // Best risk-adjusted
  const bestRR = results.reduce((a, b) => (a.roi / a.maxDrawdown) > (b.roi / b.maxDrawdown) ? a : b);
  console.log(`\n🏆 MEILLEUR RATIO RISQUE/RÉCOMPENSE: ${(bestRR.posSize * 100).toFixed(0)}%`);
  console.log(`   ROI: +${bestRR.roi.toFixed(0)}% | Max DD: ${bestRR.maxDrawdown.toFixed(1)}% | Ratio: ${(bestRR.roi / bestRR.maxDrawdown).toFixed(2)}`);
}

main().catch(console.error);
