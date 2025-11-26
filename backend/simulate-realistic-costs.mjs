/**
 * 🔬 SIMULATION RÉALISTE: LONG + SHORT avec frais et leverage
 * 
 * Paramètres réalistes:
 * - Leverage: 5x (comme en prod)
 * - Frais Binance: 0.04% par trade (maker/taker)
 * - Slippage: 0.05% 
 * - Funding rate: ~0.01% toutes les 8h (estimé)
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

// ============================================================================
// PARAMÈTRES RÉALISTES
// ============================================================================

const REALISTIC_PARAMS = {
  LEVERAGE: 5,                    // Leverage utilisé
  TRADING_FEE_PCT: 0.04,          // 0.04% par trade (Binance futures)
  SLIPPAGE_PCT: 0.05,             // 0.05% slippage moyen
  FUNDING_RATE_PCT: 0.01,         // 0.01% toutes les 8h (32 bars de 15min)
  FUNDING_INTERVAL_BARS: 32,      // 8h en bars de 15min
};

const POSITION_SIZE_PCT = 0.4;    // 40% du capital par position
const INITIAL_CAPITAL = 1000;

// Configs stratégies (identiques au backtest précédent)
const LONG_CONFIG = {
  entry: { bbPeriod: 20, bbStd: 2, rocMin: 1.5, volMultiplier: 1.3, maxConsecUp: 4 },
  exit: { stopLoss: 1.5, takeProfit: 3.0, trailingActivation: 1.0, trailingDistance: 0.4, maxBars: 192 }
};

const SHORT_CONFIG = {
  entry: { priceDropMin: -1, volSpike: 2.0, belowMA20: true },
  exit: { stopLoss: 1.5, takeProfit: 3.0, trailingActivation: 1.0, trailingDistance: 0.4, maxBars: 192 }
};

const SYMBOLS = ['SEI/USDT:USDT', 'XRP/USDT:USDT', 'ETH/USDT:USDT', 'IMX/USDT:USDT'];

// ============================================================================
// INDICATORS (mêmes que avant)
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
// CALCULS RÉALISTES DE PNL
// ============================================================================

function calculateRealisticPnl(entryPrice, exitPrice, side, capitalUsed, holdBars) {
  // 1. PnL brut (avec leverage)
  let pnlPct;
  if (side === 'long') {
    pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  } else {
    pnlPct = ((entryPrice - exitPrice) / entryPrice) * 100;
  }
  
  // Avec leverage
  const leveragedPnlPct = pnlPct * REALISTIC_PARAMS.LEVERAGE;
  
  // 2. Frais d'entrée et sortie
  const entryFee = REALISTIC_PARAMS.TRADING_FEE_PCT * REALISTIC_PARAMS.LEVERAGE; // 0.04% * 5 = 0.2%
  const exitFee = REALISTIC_PARAMS.TRADING_FEE_PCT * REALISTIC_PARAMS.LEVERAGE;
  const totalFees = entryFee + exitFee; // 0.4% du capital
  
  // 3. Slippage entrée et sortie
  const totalSlippage = REALISTIC_PARAMS.SLIPPAGE_PCT * 2 * REALISTIC_PARAMS.LEVERAGE; // 0.5%
  
  // 4. Funding rate (si position tenue > 8h)
  const fundingPeriods = Math.floor(holdBars / REALISTIC_PARAMS.FUNDING_INTERVAL_BARS);
  const totalFunding = fundingPeriods * REALISTIC_PARAMS.FUNDING_RATE_PCT * REALISTIC_PARAMS.LEVERAGE;
  
  // PnL net après tous les coûts
  const netPnlPct = leveragedPnlPct - totalFees - totalSlippage - totalFunding;
  
  // En USD
  const netPnlUsd = (netPnlPct / 100) * capitalUsed;
  
  return {
    grossPnlPct: pnlPct,
    leveragedPnlPct,
    fees: totalFees,
    slippage: totalSlippage,
    funding: totalFunding,
    netPnlPct,
    netPnlUsd
  };
}

// ============================================================================
// BACKTEST ENGINE
// ============================================================================

async function fetchCandles(symbol, months = 12) {
  console.log(`   Fetching ${symbol}...`);
  const since = Date.now() - months * 30 * 24 * 60 * 60 * 1000;
  const allCandles = [];
  let cursor = since;
  
  while (cursor < Date.now()) {
    const ohlcv = await exchange.fetchOHLCV(symbol, '15m', cursor, 1000);
    if (ohlcv.length === 0) break;
    
    for (const c of ohlcv) {
      allCandles.push({
        timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
      });
    }
    cursor = ohlcv[ohlcv.length - 1][0] + 1;
    await new Promise(r => setTimeout(r, 50));
  }
  
  return allCandles;
}

async function runRealisticBacktest() {
  console.log('═'.repeat(80));
  console.log('🔬 SIMULATION RÉALISTE: AVEC FRAIS, LEVERAGE ET SLIPPAGE');
  console.log('═'.repeat(80));
  console.log(`
┌────────────────────────────────────────────────────────┐
│                 PARAMÈTRES RÉALISTES                   │
├────────────────────────────────────────────────────────┤
│  Capital initial:     $${INITIAL_CAPITAL}                            │
│  Position size:       ${POSITION_SIZE_PCT * 100}%                             │
│  Leverage:            ${REALISTIC_PARAMS.LEVERAGE}x                              │
│  Trading fee:         ${REALISTIC_PARAMS.TRADING_FEE_PCT}% (×2 = ${REALISTIC_PARAMS.TRADING_FEE_PCT * 2}% par trade)       │
│  Slippage:            ${REALISTIC_PARAMS.SLIPPAGE_PCT}% (×2 = ${REALISTIC_PARAMS.SLIPPAGE_PCT * 2}% par trade)       │
│  Funding rate:        ${REALISTIC_PARAMS.FUNDING_RATE_PCT}% toutes les 8h               │
├────────────────────────────────────────────────────────┤
│  COÛT TOTAL PAR TRADE (leverage 5x):                   │
│  - Frais: ${(REALISTIC_PARAMS.TRADING_FEE_PCT * 2 * REALISTIC_PARAMS.LEVERAGE).toFixed(2)}%                                     │
│  - Slippage: ${(REALISTIC_PARAMS.SLIPPAGE_PCT * 2 * REALISTIC_PARAMS.LEVERAGE).toFixed(2)}%                                   │
│  = Total fixe: ~${((REALISTIC_PARAMS.TRADING_FEE_PCT * 2 + REALISTIC_PARAMS.SLIPPAGE_PCT * 2) * REALISTIC_PARAMS.LEVERAGE).toFixed(2)}% par trade                      │
└────────────────────────────────────────────────────────┘
`);

  // Fetch data
  console.log('📊 Fetching data...');
  const btcCandles = await fetchCandles('BTC/USDT:USDT', 12);
  const btcCloses = btcCandles.map(c => c.close);
  
  const allData = {};
  for (const symbol of SYMBOLS) {
    allData[symbol] = await fetchCandles(symbol, 12);
  }
  
  // Results
  let capital = INITIAL_CAPITAL;
  const results = {
    trades: [],
    totalFees: 0,
    totalSlippage: 0,
    totalFunding: 0,
    monthlyPnl: {}
  };
  
  const positions = {};
  const cooldowns = {};
  SYMBOLS.forEach(s => { positions[s] = null; cooldowns[s] = 0; });
  
  console.log('\n🚀 Running simulation...');
  
  // Main loop
  for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
    const btcAboveSma200 = btcSma200 ? btcCloses[btcIdx - 1] > btcSma200 : false;
    const btcBelowSma200 = btcSma200 ? btcCloses[btcIdx - 1] < btcSma200 : false;
    
    const month = new Date(btcCandle.timestamp).toISOString().slice(0, 7);
    if (!results.monthlyPnl[month]) results.monthlyPnl[month] = { pnl: 0, trades: 0, fees: 0 };
    
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
          } else if (holdBars >= LONG_CONFIG.exit.maxBars) {
            exitReason = 'TIME';
          }
        } else { // short
          const pnlPct = ((pos.entryPrice - current.close) / pos.entryPrice) * 100;
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
          } else if (holdBars >= SHORT_CONFIG.exit.maxBars) {
            exitReason = 'TIME';
          }
        }
        
        if (exitReason) {
          const pnlResult = calculateRealisticPnl(
            pos.entryPrice, exitPrice, pos.side, pos.capitalUsed, holdBars
          );
          
          capital += pnlResult.netPnlUsd;
          
          results.trades.push({
            symbol,
            side: pos.side,
            grossPnlPct: pnlResult.grossPnlPct,
            netPnlPct: pnlResult.netPnlPct,
            netPnlUsd: pnlResult.netPnlUsd,
            fees: pnlResult.fees,
            slippage: pnlResult.slippage,
            funding: pnlResult.funding,
            exitReason,
            holdBars
          });
          
          results.totalFees += pnlResult.fees * pos.capitalUsed / 100;
          results.totalSlippage += pnlResult.slippage * pos.capitalUsed / 100;
          results.totalFunding += pnlResult.funding * pos.capitalUsed / 100;
          
          results.monthlyPnl[month].pnl += pnlResult.netPnlUsd;
          results.monthlyPnl[month].trades++;
          results.monthlyPnl[month].fees += (pnlResult.fees + pnlResult.slippage + pnlResult.funding) * pos.capitalUsed / 100;
          
          positions[symbol] = null;
          cooldowns[symbol] = 8;
        }
      }
      
      // Check entries
      if (!positions[symbol] && cooldowns[symbol] <= 0 && capital > 100) {
        const capitalToUse = capital * POSITION_SIZE_PCT;
        
        if (btcAboveSma200 && checkLongEntry(windowCandles, true)) {
          positions[symbol] = {
            side: 'long',
            entryPrice: current.close * (1 + REALISTIC_PARAMS.SLIPPAGE_PCT / 100), // Slippage à l'entrée
            entryIdx: idx,
            capitalUsed: capitalToUse,
            highWaterMark: current.close
          };
        } else if (btcBelowSma200 && checkShortEntry(windowCandles, true)) {
          positions[symbol] = {
            side: 'short',
            entryPrice: current.close * (1 - REALISTIC_PARAMS.SLIPPAGE_PCT / 100), // Slippage à l'entrée
            entryIdx: idx,
            capitalUsed: capitalToUse,
            lowWaterMark: current.close
          };
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
  const { results, finalCapital } = await runRealisticBacktest();
  
  const wins = results.trades.filter(t => t.netPnlPct > 0).length;
  const losses = results.trades.filter(t => t.netPnlPct <= 0).length;
  const winRate = results.trades.length > 0 ? (wins / results.trades.length * 100).toFixed(1) : 0;
  
  const longTrades = results.trades.filter(t => t.side === 'long');
  const shortTrades = results.trades.filter(t => t.side === 'short');
  
  const roi = ((finalCapital - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100).toFixed(1);
  
  const avgHoldBars = results.trades.length > 0 
    ? (results.trades.reduce((s, t) => s + t.holdBars, 0) / results.trades.length).toFixed(0)
    : 0;
  const avgHoldHours = (avgHoldBars * 15 / 60).toFixed(1);
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS RÉALISTES - AVEC TOUS LES COÛTS');
  console.log('═'.repeat(80));
  
  console.log(`
┌─────────────────────────────────────────────────────────────────────────────┐
│                           PERFORMANCE RÉALISTE                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  Capital initial:    $${INITIAL_CAPITAL.toFixed(2).padStart(10)}                                        │
│  Capital final:      $${finalCapital.toFixed(2).padStart(10)}                                        │
│  ROI Total:          ${roi.padStart(10)}%                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  Trades totaux:      ${String(results.trades.length).padStart(10)}                                        │
│  Win Rate:           ${winRate.padStart(10)}%                                        │
│  Wins / Losses:      ${(wins + ' / ' + losses).padStart(10)}                                        │
│  Hold moyen:         ${avgHoldHours.padStart(10)}h                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  COÛTS TOTAUX:                                                              │
│  - Frais trading:    $${results.totalFees.toFixed(2).padStart(10)}                                        │
│  - Slippage:         $${results.totalSlippage.toFixed(2).padStart(10)}                                        │
│  - Funding:          $${results.totalFunding.toFixed(2).padStart(10)}                                        │
│  = Total coûts:      $${(results.totalFees + results.totalSlippage + results.totalFunding).toFixed(2).padStart(10)}                                        │
└─────────────────────────────────────────────────────────────────────────────┘
`);

  console.log(`
┌──────────────────────────────────────────────────────────────────────────────┐
│                          BREAKDOWN LONG vs SHORT                             │
├────────────────────┬─────────────────────────┬───────────────────────────────┤
│                    │        LONG             │          SHORT                │
├────────────────────┼─────────────────────────┼───────────────────────────────┤
│  Trades            │  ${String(longTrades.length).padStart(10)}             │     ${String(shortTrades.length).padStart(10)}                │
│  Win Rate          │  ${(longTrades.filter(t => t.netPnlPct > 0).length / longTrades.length * 100 || 0).toFixed(1).padStart(9)}%             │     ${(shortTrades.filter(t => t.netPnlPct > 0).length / shortTrades.length * 100 || 0).toFixed(1).padStart(9)}%                │
│  PnL Net           │  $${longTrades.reduce((s, t) => s + t.netPnlUsd, 0).toFixed(2).padStart(9)}             │     $${shortTrades.reduce((s, t) => s + t.netPnlUsd, 0).toFixed(2).padStart(9)}                │
└────────────────────┴─────────────────────────┴───────────────────────────────┘
`);

  // Monthly
  console.log('\n📅 PERFORMANCE MENSUELLE (NET):');
  console.log('┌─────────────┬──────────────┬────────┬────────────┐');
  console.log('│    Mois     │   PnL Net    │ Trades │   Frais    │');
  console.log('├─────────────┼──────────────┼────────┼────────────┤');
  
  const months = Object.keys(results.monthlyPnl).sort();
  let positiveMonths = 0;
  
  for (const m of months) {
    const d = results.monthlyPnl[m];
    const pnlStr = d.pnl >= 0 ? `+$${d.pnl.toFixed(2)}` : `-$${Math.abs(d.pnl).toFixed(2)}`;
    if (d.pnl > 0) positiveMonths++;
    console.log(`│ ${m}   │ ${pnlStr.padStart(12)} │ ${String(d.trades).padStart(6)} │ $${d.fees.toFixed(2).padStart(9)} │`);
  }
  
  console.log('└─────────────┴──────────────┴────────┴────────────┘');
  console.log(`\n📈 Mois positifs: ${positiveMonths}/${months.length} (${(positiveMonths/months.length*100).toFixed(0)}%)`);
  
  // Comparaison
  console.log('\n' + '═'.repeat(80));
  console.log('💡 COMPARAISON: BACKTEST NAÏF vs RÉALISTE');
  console.log('═'.repeat(80));
  console.log(`
   📊 BACKTEST NAÏF (sans frais):
      ROI: +683.5%
      Win Rate: 67.3%
   
   📊 BACKTEST RÉALISTE (avec frais, leverage 5x, slippage):
      ROI: +${roi}%
      Win Rate: ${winRate}%
      Total frais payés: $${(results.totalFees + results.totalSlippage + results.totalFunding).toFixed(2)}
   
   ⚠️ Impact des coûts:
      - Frais: ${(results.totalFees / INITIAL_CAPITAL * 100).toFixed(1)}% du capital initial
      - Slippage: ${(results.totalSlippage / INITIAL_CAPITAL * 100).toFixed(1)}% du capital initial
      - Funding: ${(results.totalFunding / INITIAL_CAPITAL * 100).toFixed(1)}% du capital initial
`);

  if (parseFloat(roi) > 100) {
    console.log('✅ La stratégie reste TRÈS PROFITABLE même avec tous les coûts!');
  } else if (parseFloat(roi) > 50) {
    console.log('✅ La stratégie reste PROFITABLE avec les coûts réalistes.');
  } else if (parseFloat(roi) > 0) {
    console.log('⚠️ La stratégie est légèrement profitable, mais attention aux coûts.');
  } else {
    console.log('❌ La stratégie n\'est PAS profitable avec les coûts réalistes.');
  }
}

main().catch(console.error);
