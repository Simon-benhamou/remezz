/**
 * Backtest: Test des optimisations du trailing stop
 * 
 * Problème identifié: Les trades SL atteignent +1.04% max avant de chuter
 * Le trailing actuel s'active à +1.2% → jamais protégés
 * 
 * Test: Trailing activation +0.8% au lieu de +1.2%
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

// ============================================================================
// CONFIGURATIONS À TESTER
// ============================================================================

const BASE_CONFIG = {
  ENTRY: {
    BB_PERIOD: 20,
    BB_STD: 2,
    ROC_MIN: 0.015,          // ROC 10 > 1.5%
    VOL_MULTIPLIER: 1.3,     // Volume > 1.3x
    MAX_CONSEC_UP: 4,
    BTC_SMA_PERIOD: 200,
    ALLOWED_DAYS: [0, 1, 2, 3, 4, 5, 6],
  },
  EXIT: {
    STOP_LOSS_PCT: 1.5,
    PROFIT_TARGET_PCT: 3.0,
    HOLD_MAX_BARS: 192,      // 48h
  },
  RISK: {
    POSITION_SIZE_PCT: 0.4,
  }
};

// Configurations à tester
const TRAILING_CONFIGS = [
  { name: 'V5.1 Current (1.2%/0.6%)', activation: 1.2, distance: 0.6 },
  { name: 'Earlier (0.8%/0.5%)', activation: 0.8, distance: 0.5 },
  { name: 'Very Early (0.6%/0.4%)', activation: 0.6, distance: 0.4 },
  { name: 'Tight (1.0%/0.4%)', activation: 1.0, distance: 0.4 },
  { name: 'No Trailing (SL/TP only)', activation: 999, distance: 0.5 },
];

const SYMBOLS = ['SEI/USDT:USDT', 'XRP/USDT:USDT', 'ETH/USDT:USDT', 'IMX/USDT:USDT'];

// ============================================================================
// INDICATORS
// ============================================================================

function calcSMA(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcBB(closes, period = 20, std = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    middle: sma,
    upper: sma + std * stdDev,
    lower: sma - std * stdDev,
    width: (2 * std * stdDev / sma) * 100
  };
}

function calcROC(closes, period = 10) {
  if (closes.length < period + 1) return null;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  return ((current - past) / past) * 100;
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
// SIGNAL CHECK
// ============================================================================

function checkEntry(candles, btcAboveSma200) {
  if (candles.length < 50) return false;
  
  // BTC Regime Filter - MUST be BULL
  if (!btcAboveSma200) return false;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  // Bollinger Bands breakout
  const bb = calcBB(closes, BASE_CONFIG.ENTRY.BB_PERIOD, BASE_CONFIG.ENTRY.BB_STD);
  if (!bb || current.close <= bb.upper) return false;
  
  // ROC > 1.5%
  const roc = calcROC(closes, 10);
  if (!roc || roc < BASE_CONFIG.ENTRY.ROC_MIN * 100) return false;
  
  // Volume > 1.3x
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * BASE_CONFIG.ENTRY.VOL_MULTIPLIER) return false;
  
  // ConsecUp <= 4
  const consecUp = countConsecUp(candles);
  if (consecUp > BASE_CONFIG.ENTRY.MAX_CONSEC_UP) return false;
  
  // Day filter
  const day = new Date(current.timestamp).getUTCDay();
  if (!BASE_CONFIG.ENTRY.ALLOWED_DAYS.includes(day)) return false;
  
  return true;
}

// ============================================================================
// BACKTEST
// ============================================================================

async function fetchCandles(symbol, months = 6) {
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
  
  return allCandles;
}

async function runBacktest(trailingConfig) {
  const results = { trades: [], wins: 0, losses: 0, totalPnl: 0 };
  
  // Fetch BTC for regime filter
  console.log(`   Fetching BTC...`);
  const btcCandles = await fetchCandles('BTC/USDT:USDT', 6);
  const btcCloses = btcCandles.map(c => c.close);
  
  for (const symbol of SYMBOLS) {
    console.log(`   ${symbol}...`);
    const candles = await fetchCandles(symbol, 6);
    
    let position = null;
    let cooldown = 0;
    
    for (let i = 200; i < candles.length; i++) {
      const windowCandles = candles.slice(Math.max(0, i - 200), i + 1);
      const current = candles[i];
      
      // Find matching BTC candle
      const btcIdx = btcCandles.findIndex(b => b.timestamp >= current.timestamp);
      const btcSma200 = btcIdx >= 200 ? calcSMA(btcCloses.slice(0, btcIdx), 200) : null;
      const btcAboveSma200 = btcSma200 ? btcCloses[btcIdx - 1] > btcSma200 : false;
      
      // Manage position
      if (position) {
        const pnlPct = ((current.close - position.entryPrice) / position.entryPrice) * 100;
        position.highWaterMark = Math.max(position.highWaterMark || position.entryPrice, current.high);
        const hwmPct = ((position.highWaterMark - position.entryPrice) / position.entryPrice) * 100;
        
        let exitReason = null;
        let exitPrice = current.close;
        
        // Stop Loss
        if (pnlPct <= -BASE_CONFIG.EXIT.STOP_LOSS_PCT) {
          exitReason = 'SL';
          exitPrice = position.entryPrice * (1 - BASE_CONFIG.EXIT.STOP_LOSS_PCT / 100);
        }
        // Take Profit
        else if (pnlPct >= BASE_CONFIG.EXIT.PROFIT_TARGET_PCT) {
          exitReason = 'TP';
          exitPrice = position.entryPrice * (1 + BASE_CONFIG.EXIT.PROFIT_TARGET_PCT / 100);
        }
        // Trailing Stop
        else if (hwmPct >= trailingConfig.activation) {
          const trailingStop = position.highWaterMark * (1 - trailingConfig.distance / 100);
          if (current.low <= trailingStop) {
            exitReason = 'TRAIL';
            exitPrice = trailingStop;
          }
        }
        // Max Hold
        else if (i - position.entryBar >= BASE_CONFIG.EXIT.HOLD_MAX_BARS) {
          exitReason = 'TIME';
        }
        
        if (exitReason) {
          const finalPnl = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
          results.trades.push({
            symbol,
            entryPrice: position.entryPrice,
            exitPrice,
            pnlPct: finalPnl,
            exitReason,
            hwmPct
          });
          
          if (finalPnl > 0) results.wins++;
          else results.losses++;
          results.totalPnl += finalPnl * BASE_CONFIG.RISK.POSITION_SIZE_PCT;
          
          position = null;
          cooldown = 8;
        }
      }
      
      // Check entry
      if (!position && cooldown <= 0) {
        if (checkEntry(windowCandles, btcAboveSma200)) {
          position = {
            entryPrice: current.close,
            entryBar: i,
            highWaterMark: current.close
          };
        }
      }
      
      if (cooldown > 0) cooldown--;
    }
  }
  
  return results;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 BACKTEST: TRAILING STOP OPTIMIZATION');
  console.log('═'.repeat(80));
  console.log('\nProblem: SL trades reach +1.04% max before falling');
  console.log('Current trailing activates at +1.2% → never protects them\n');
  
  const allResults = [];
  
  for (const config of TRAILING_CONFIGS) {
    console.log(`\n📊 Testing: ${config.name}`);
    const results = await runBacktest(config);
    
    const winRate = results.trades.length > 0 
      ? (results.wins / results.trades.length * 100).toFixed(1)
      : 0;
    
    const slCount = results.trades.filter(t => t.exitReason === 'SL').length;
    const tpCount = results.trades.filter(t => t.exitReason === 'TP').length;
    const trailCount = results.trades.filter(t => t.exitReason === 'TRAIL').length;
    const avgPnl = results.trades.length > 0
      ? (results.trades.reduce((s, t) => s + t.pnlPct, 0) / results.trades.length).toFixed(2)
      : 0;
    
    allResults.push({
      name: config.name,
      activation: config.activation,
      distance: config.distance,
      trades: results.trades.length,
      winRate,
      totalRoi: results.totalPnl.toFixed(1),
      avgPnl,
      slCount,
      tpCount,
      trailCount
    });
    
    console.log(`   Trades: ${results.trades.length} | WR: ${winRate}% | ROI: ${results.totalPnl.toFixed(1)}%`);
    console.log(`   Exits: SL=${slCount} TP=${tpCount} Trail=${trailCount}`);
  }
  
  // Summary table
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSUMÉ COMPARATIF');
  console.log('═'.repeat(80));
  console.log('\n┌────────────────────────────┬────────┬────────┬─────────┬────────┬────────┬────────┐');
  console.log('│ Configuration              │ Trades │ WR %   │ ROI %   │   SL   │   TP   │ Trail  │');
  console.log('├────────────────────────────┼────────┼────────┼─────────┼────────┼────────┼────────┤');
  
  for (const r of allResults) {
    console.log(`│ ${r.name.padEnd(26)} │ ${String(r.trades).padStart(6)} │ ${String(r.winRate).padStart(5)}% │ ${String(r.totalRoi).padStart(6)}% │ ${String(r.slCount).padStart(6)} │ ${String(r.tpCount).padStart(6)} │ ${String(r.trailCount).padStart(6)} │`);
  }
  
  console.log('└────────────────────────────┴────────┴────────┴─────────┴────────┴────────┴────────┘');
  
  // Find best
  const best = allResults.reduce((a, b) => parseFloat(a.totalRoi) > parseFloat(b.totalRoi) ? a : b);
  console.log(`\n🏆 MEILLEUR: ${best.name} avec ${best.totalRoi}% ROI`);
  
  // Recommendation
  console.log('\n' + '═'.repeat(80));
  console.log('💡 RECOMMANDATION');
  console.log('═'.repeat(80));
  
  const current = allResults.find(r => r.activation === 1.2);
  const early = allResults.find(r => r.activation === 0.8);
  
  if (early && current && parseFloat(early.totalRoi) > parseFloat(current.totalRoi)) {
    console.log('\n✅ Réduire le trailing activation de 1.2% à 0.8%');
    console.log(`   Gain: +${(parseFloat(early.totalRoi) - parseFloat(current.totalRoi)).toFixed(1)}% ROI`);
    console.log(`   Plus de trails: ${early.trailCount} vs ${current.trailCount}`);
    console.log(`   Moins de SL: ${early.slCount} vs ${current.slCount}`);
  } else {
    console.log('\n⚠️ La config actuelle (1.2%/0.6%) est déjà optimale');
  }
}

main().catch(console.error);
