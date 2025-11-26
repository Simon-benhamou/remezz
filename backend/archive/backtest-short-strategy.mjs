/**
 * 🔬 BACKTEST: Stratégie SHORT pour marché BEAR
 * 
 * Hypothèse: Miroir de la stratégie LONG V5
 * - Entry: BB breakdown (close < lower band) au lieu de breakout
 * - Regime: BTC < SMA200 (bear market)
 * - Exit: Trailing inversé
 * 
 * On va tester plusieurs variantes:
 * 1. Mirror exact (BB breakdown + ROC négatif)
 * 2. Momentum reversal (après pump, short le retournement)
 * 3. Breakdown + volume spike
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

// ============================================================================
// CONFIGURATIONS À TESTER
// ============================================================================

const STRATEGIES = {
  // 1. Mirror exact de la stratégie LONG
  MIRROR: {
    name: 'Mirror (BB Breakdown)',
    entry: {
      type: 'breakdown',
      bbPeriod: 20,
      bbStd: 2,
      rocMin: -1.5,           // ROC négatif < -1.5%
      volMultiplier: 1.3,
      maxConsecDown: 4,       // Max 4 bougies rouges
    }
  },
  
  // 2. Reversal après pump (short le retournement)
  REVERSAL: {
    name: 'Reversal (Post-Pump Short)',
    entry: {
      type: 'reversal',
      rsiOverbought: 75,      // RSI > 75 = overbought
      rocPrior: 3,            // Pump préalable > 3%
      confirmCandles: 2,      // 2 bougies rouges de confirmation
    }
  },
  
  // 3. Volume breakdown (cassure avec volume)
  VOLUME_BREAK: {
    name: 'Volume Breakdown',
    entry: {
      type: 'volume_break',
      priceDropMin: -1,       // Prix en baisse > 1%
      volSpike: 2.0,          // Volume > 2x moyenne
      belowMA20: true,        // Prix sous MA20
    }
  },
  
  // 4. Mean Reversion Short (trop loin de la moyenne)
  MEAN_REVERT: {
    name: 'Mean Reversion Short',
    entry: {
      type: 'mean_revert',
      distFromMA: 3,          // > 3% au-dessus de MA20
      rsiMin: 70,             // RSI > 70
    }
  }
};

const EXIT_CONFIG = {
  STOP_LOSS_PCT: 1.5,         // Même que LONG
  PROFIT_TARGET_PCT: 3.0,     // Même que LONG
  TRAILING_ACTIVATION: 1.0,   // Trailing à +1%
  TRAILING_DISTANCE: 0.4,     // Trail serré
  HOLD_MAX_BARS: 192,         // 48h
};

const SYMBOLS = ['SEI/USDT:USDT', 'XRP/USDT:USDT', 'ETH/USDT:USDT', 'IMX/USDT:USDT'];

// ============================================================================
// INDICATORS
// ============================================================================

function calcSMA(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
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

function countConsecDown(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close < candles[i].open) count++;
    else break;
  }
  return count;
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

function checkMirrorEntry(candles, btcBelowSma200) {
  if (!btcBelowSma200) return false;
  if (candles.length < 50) return false;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  const config = STRATEGIES.MIRROR.entry;
  
  // BB Breakdown
  const bb = calcBB(closes, config.bbPeriod, config.bbStd);
  if (!bb || current.close >= bb.lower) return false;
  
  // ROC négatif
  const roc = calcROC(closes, 10);
  if (!roc || roc > config.rocMin) return false;
  
  // Volume confirmation
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * config.volMultiplier) return false;
  
  // Pas trop de bougies rouges consécutives
  const consecDown = countConsecDown(candles);
  if (consecDown > config.maxConsecDown) return false;
  
  return true;
}

function checkReversalEntry(candles, btcBelowSma200) {
  if (!btcBelowSma200) return false;
  if (candles.length < 50) return false;
  
  const closes = candles.map(c => c.close);
  const config = STRATEGIES.REVERSAL.entry;
  
  // RSI overbought
  const rsi = calcRSI(closes);
  if (!rsi || rsi < config.rsiOverbought) return false;
  
  // ROC 10 montre un pump préalable
  const roc = calcROC(closes, 10);
  if (!roc || roc < config.rocPrior) return false;
  
  // Dernières X bougies sont rouges (confirmation retournement)
  const recent = candles.slice(-config.confirmCandles);
  const allRed = recent.every(c => c.close < c.open);
  if (!allRed) return false;
  
  return true;
}

function checkVolumeBreakEntry(candles, btcBelowSma200) {
  if (!btcBelowSma200) return false;
  if (candles.length < 50) return false;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  const config = STRATEGIES.VOLUME_BREAK.entry;
  
  // Prix en baisse
  const roc5 = calcROC(closes, 5);
  if (!roc5 || roc5 > config.priceDropMin) return false;
  
  // Volume spike
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * config.volSpike) return false;
  
  // Sous MA20
  const ma20 = calcSMA(closes, 20);
  if (!ma20 || current.close >= ma20) return false;
  
  return true;
}

function checkMeanRevertEntry(candles, btcBelowSma200) {
  if (!btcBelowSma200) return false;
  if (candles.length < 50) return false;
  
  const closes = candles.map(c => c.close);
  const current = candles[candles.length - 1];
  const config = STRATEGIES.MEAN_REVERT.entry;
  
  // Distance de MA20
  const ma20 = calcSMA(closes, 20);
  if (!ma20) return false;
  const distFromMA = ((current.close - ma20) / ma20) * 100;
  if (distFromMA < config.distFromMA) return false;
  
  // RSI élevé
  const rsi = calcRSI(closes);
  if (!rsi || rsi < config.rsiMin) return false;
  
  return true;
}

// ============================================================================
// BACKTEST ENGINE
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

async function runBacktest(strategyKey, checkEntryFn) {
  const results = { trades: [], wins: 0, losses: 0, totalPnl: 0, bearBars: 0, totalBars: 0 };
  
  console.log(`\n📊 Testing: ${STRATEGIES[strategyKey].name}`);
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
      const btcBelowSma200 = btcSma200 ? btcCloses[btcIdx - 1] < btcSma200 : false;
      
      results.totalBars++;
      if (btcBelowSma200) results.bearBars++;
      
      // Manage SHORT position
      if (position) {
        // Pour un SHORT: profit = entry - current (inversé)
        const pnlPct = ((position.entryPrice - current.close) / position.entryPrice) * 100;
        
        // Pour SHORT: lowWaterMark (prix le plus bas atteint)
        position.lowWaterMark = Math.min(position.lowWaterMark || position.entryPrice, current.low);
        const lwmPct = ((position.entryPrice - position.lowWaterMark) / position.entryPrice) * 100;
        
        let exitReason = null;
        let exitPrice = current.close;
        
        // Stop Loss (prix monte trop)
        if (pnlPct <= -EXIT_CONFIG.STOP_LOSS_PCT) {
          exitReason = 'SL';
          exitPrice = position.entryPrice * (1 + EXIT_CONFIG.STOP_LOSS_PCT / 100);
        }
        // Take Profit (prix baisse assez)
        else if (pnlPct >= EXIT_CONFIG.PROFIT_TARGET_PCT) {
          exitReason = 'TP';
          exitPrice = position.entryPrice * (1 - EXIT_CONFIG.PROFIT_TARGET_PCT / 100);
        }
        // Trailing Stop (inversé: on remonte depuis le low)
        else if (lwmPct >= EXIT_CONFIG.TRAILING_ACTIVATION) {
          const trailingStop = position.lowWaterMark * (1 + EXIT_CONFIG.TRAILING_DISTANCE / 100);
          if (current.high >= trailingStop) {
            exitReason = 'TRAIL';
            exitPrice = trailingStop;
          }
        }
        // Max Hold
        else if (i - position.entryBar >= EXIT_CONFIG.HOLD_MAX_BARS) {
          exitReason = 'TIME';
        }
        
        if (exitReason) {
          const finalPnl = ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
          results.trades.push({
            symbol,
            entryPrice: position.entryPrice,
            exitPrice,
            pnlPct: finalPnl,
            exitReason,
            lwmPct
          });
          
          if (finalPnl > 0) results.wins++;
          else results.losses++;
          results.totalPnl += finalPnl * 0.4; // 40% position size
          
          position = null;
          cooldown = 8;
        }
      }
      
      // Check SHORT entry
      if (!position && cooldown <= 0) {
        if (checkEntryFn(windowCandles, btcBelowSma200)) {
          position = {
            entryPrice: current.close,
            entryBar: i,
            lowWaterMark: current.close
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
  console.log('🔬 BACKTEST: STRATÉGIES SHORT POUR MARCHÉ BEAR');
  console.log('═'.repeat(80));
  console.log('\nCondition: BTC < SMA200 (régime BEAR)\n');
  
  const allResults = [];
  
  // Test chaque stratégie
  const strategies = [
    ['MIRROR', checkMirrorEntry],
    ['REVERSAL', checkReversalEntry],
    ['VOLUME_BREAK', checkVolumeBreakEntry],
    ['MEAN_REVERT', checkMeanRevertEntry],
  ];
  
  for (const [key, fn] of strategies) {
    const results = await runBacktest(key, fn);
    
    const winRate = results.trades.length > 0 
      ? (results.wins / results.trades.length * 100).toFixed(1)
      : 0;
    
    const slCount = results.trades.filter(t => t.exitReason === 'SL').length;
    const tpCount = results.trades.filter(t => t.exitReason === 'TP').length;
    const trailCount = results.trades.filter(t => t.exitReason === 'TRAIL').length;
    const bearPct = results.totalBars > 0 ? (results.bearBars / results.totalBars * 100).toFixed(1) : 0;
    
    allResults.push({
      name: STRATEGIES[key].name,
      trades: results.trades.length,
      winRate,
      totalRoi: results.totalPnl.toFixed(1),
      slCount,
      tpCount,
      trailCount,
      bearPct
    });
    
    console.log(`   Trades: ${results.trades.length} | WR: ${winRate}% | ROI: ${results.totalPnl.toFixed(1)}%`);
    console.log(`   Bear market: ${bearPct}% du temps`);
  }
  
  // Summary
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSUMÉ COMPARATIF - STRATÉGIES SHORT');
  console.log('═'.repeat(80));
  console.log('\n┌─────────────────────────────┬────────┬────────┬─────────┬────────┬────────┬────────┐');
  console.log('│ Stratégie                   │ Trades │ WR %   │ ROI %   │   SL   │   TP   │ Trail  │');
  console.log('├─────────────────────────────┼────────┼────────┼─────────┼────────┼────────┼────────┤');
  
  for (const r of allResults) {
    const roi = parseFloat(r.totalRoi);
    const roiStr = roi >= 0 ? `+${r.totalRoi}` : r.totalRoi;
    console.log(`│ ${r.name.padEnd(27)} │ ${String(r.trades).padStart(6)} │ ${String(r.winRate).padStart(5)}% │ ${roiStr.padStart(7)}% │ ${String(r.slCount).padStart(6)} │ ${String(r.tpCount).padStart(6)} │ ${String(r.trailCount).padStart(6)} │`);
  }
  
  console.log('└─────────────────────────────┴────────┴────────┴─────────┴────────┴────────┴────────┘');
  
  // Best strategy
  const best = allResults.reduce((a, b) => parseFloat(a.totalRoi) > parseFloat(b.totalRoi) ? a : b);
  console.log(`\n🏆 MEILLEURE STRATÉGIE SHORT: ${best.name}`);
  console.log(`   ROI: ${best.totalRoi}% | Win Rate: ${best.winRate}% | Trades: ${best.trades}`);
  
  // Compare with LONG
  console.log('\n' + '═'.repeat(80));
  console.log('📊 COMPARAISON LONG vs SHORT');
  console.log('═'.repeat(80));
  console.log(`
   Stratégie V5.2 LONG (BULL market):
   - ROI: +32.2% (6 mois)
   - Win Rate: 68.5%
   - Condition: BTC > SMA200
   
   Meilleure SHORT (BEAR market):
   - ROI: ${best.totalRoi}%
   - Win Rate: ${best.winRate}%
   - Condition: BTC < SMA200
   
   💡 CONCLUSION:
   ${parseFloat(best.totalRoi) > 0 
     ? `La stratégie ${best.name} est VIABLE pour le marché BEAR!`
     : `Aucune stratégie SHORT n'est profitable. Mieux vaut NE PAS TRADER en BEAR.`}
  `);
  
  // Détails des meilleures trades SHORT
  if (parseFloat(best.totalRoi) > 0) {
    console.log('\n═══ TOP 5 MEILLEURES STRATÉGIES ═══');
    allResults
      .sort((a, b) => parseFloat(b.totalRoi) - parseFloat(a.totalRoi))
      .slice(0, 3)
      .forEach((r, i) => {
        console.log(`${i + 1}. ${r.name}: ${r.totalRoi}% ROI, ${r.winRate}% WR`);
      });
  }
}

main().catch(console.error);
