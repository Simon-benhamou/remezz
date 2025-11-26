/**
 * DEEP ANALYSIS - STOP LOSS INVESTIGATION
 * 
 * Questions à répondre:
 * 1. Pourquoi les stop_loss ont 0% WR et -10% avg?
 * 2. Est-ce que c'est AVEC leverage et frais?
 * 3. Tableau mois par mois par crypto
 * 4. Adapter le levier au risque
 */

import fs from 'fs';

function loadData(symbol) {
  const filename = `./data/${symbol.replace('/', '_')}_1h.json`;
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

const CONFIG = {
  ENTRY_FEE: 0.0004,
  EXIT_FEE: 0.0004,
  SLIPPAGE: 0.0002,
  
  // Leverage ADAPTATIF basé sur le risque du trade
  LEVERAGE_BASE: { BTC: 3, ETH: 5, SOL: 5, XRP: 4 },
  LEVERAGE_RISKY: { BTC: 2, ETH: 3, SOL: 3, XRP: 2 },  // Réduit pour trades risqués
};

// ═══════════════════════════════════════════════════════════════════════════
// INDICATORS
// ═══════════════════════════════════════════════════════════════════════════

function calculateATR(candles, period = 14) {
  const atrs = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { atrs.push(candles[i].high - candles[i].low); continue; }
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low - candles[i-1].close)
    );
    if (i < period) atrs.push(tr);
    else atrs.push((atrs[i-1] * (period - 1) + tr) / period);
  }
  return atrs;
}

function calculateROC(prices, period) {
  return prices.map((p, i) => i < period ? 0 : (p - prices[i - period]) / prices[i - period]);
}

function calculateVolSMA(volumes, period) {
  return volumes.map((v, i) => {
    if (i < period) return v;
    return volumes.slice(i - period, i).reduce((a, b) => a + b, 0) / period;
  });
}

function calculateRSI(candles, period = 14) {
  const rsis = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { rsis.push(50); continue; }
    const change = candles[i].close - candles[i-1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i < period) {
      avgGain = (avgGain * (i - 1) + gain) / i;
      avgLoss = (avgLoss * (i - 1) + loss) / i;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsis.push(100 - (100 / (1 + rs)));
  }
  return rsis;
}

// ═══════════════════════════════════════════════════════════════════════════
// ENTRY
// ═══════════════════════════════════════════════════════════════════════════

function shouldEnter(i, data) {
  if (i < 30) return null;
  
  const close = data.candles[i].close;
  
  let highest = 0, lowest = Infinity;
  for (let j = i - 20; j < i; j++) {
    if (data.candles[j].high > highest) highest = data.candles[j].high;
    if (data.candles[j].low < lowest) lowest = data.candles[j].low;
  }
  
  const range = highest - lowest;
  const breakoutUp = highest + range * 0.02;
  
  const roc5 = data.roc5[i];
  const vol = data.candles[i].volume;
  const volAvg = data.volSMA20[i];
  
  if (close > breakoutUp && roc5 > 0.015 && vol > volAvg * 1.3) {
    return 'long';
  }
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXIT (V3 optimized)
// ═══════════════════════════════════════════════════════════════════════════

function shouldExit(i, data, position) {
  const roc5 = data.roc5[i];
  const roc10 = data.roc10[i];
  const rsi = data.rsi[i];
  const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
  const vol = data.candles[i].volume;
  const volAvg = data.volSMA20[i];
  const holdingHours = i - position.entryIdx;
  
  const maxPnl = position.maxPnl || 0;
  position.maxPnl = Math.max(maxPnl, pnl);
  
  // PROFIT EXITS
  if (pnl > 0.02 && roc5 < 0.005) {
    return { reason: 'momentum_fade_profit' };
  }
  
  if (pnl > 0.005 && vol < volAvg * 0.5 && roc5 < 0) {
    return { reason: 'volume_dry_up' };
  }
  
  let exitSignals = 0;
  if (roc5 < 0) exitSignals++;
  if (roc10 < roc5) exitSignals++;
  if (rsi > 70) exitSignals++;
  if (vol < volAvg * 0.7) exitSignals++;
  
  if (pnl > 0.01 && exitSignals >= 3) {
    return { reason: 'multi_signal_exit' };
  }
  
  if (pnl > 0 && exitSignals >= 2 && roc5 < -0.01) {
    return { reason: 'strong_reversal' };
  }
  
  // PROTECTION
  if (position.maxPnl >= 0.02 && pnl < position.maxPnl * 0.5) {
    return { reason: 'profit_lock' };
  }
  
  if (position.maxPnl >= 0.015 && pnl <= 0.002) {
    return { reason: 'breakeven_stop' };
  }
  
  // TIME
  if (holdingHours >= 6 && pnl >= 0 && pnl < 0.01 && roc5 < 0) {
    return { reason: 'time_exit_6h' };
  }
  
  if (holdingHours >= 24 && pnl < 0.015) {
    return { reason: 'time_exit_24h' };
  }
  
  // STOP LOSS
  const atr = data.atr[i];
  const atrPercent = atr / data.candles[i].close;
  const stopLoss = atrPercent > 0.015 ? -0.02 : -0.015;
  
  if (pnl < stopLoss) {
    return { reason: 'adaptive_stop_loss' };
  }
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKTEST WITH DETAILED TRACKING
// ═══════════════════════════════════════════════════════════════════════════

function runBacktestDetailed(symbol, candles, useAdaptiveLeverage = false) {
  const assetKey = symbol.replace('/USDT', '');
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  
  const data = {
    candles,
    atr: calculateATR(candles, 14),
    roc5: calculateROC(closes, 5),
    roc10: calculateROC(closes, 10),
    volSMA20: calculateVolSMA(volumes, 20),
    rsi: calculateRSI(candles, 14),
  };
  
  const trades = [];
  let position = null;
  let capital = 100;
  
  for (let i = 50; i < candles.length; i++) {
    if (!position) {
      const signal = shouldEnter(i, data);
      if (signal) {
        const entryPrice = candles[i].close * (1 + CONFIG.SLIPPAGE);
        capital -= capital * CONFIG.ENTRY_FEE;
        
        // Évaluer le risque du trade
        const atrPercent = data.atr[i] / candles[i].close;
        const isRisky = atrPercent > 0.02 || data.rsi[i] > 75;
        
        const leverage = useAdaptiveLeverage && isRisky
          ? CONFIG.LEVERAGE_RISKY[assetKey]
          : CONFIG.LEVERAGE_BASE[assetKey];
        
        position = {
          side: signal,
          entryPrice,
          entryIdx: i,
          entryTime: new Date(candles[i].timestamp),
          capitalAtEntry: capital,
          maxPnl: 0,
          leverage,
          isRisky,
        };
      }
    } else {
      const exitSignal = shouldExit(i, data, position);
      if (exitSignal) {
        const exitPrice = candles[i].close * (1 - CONFIG.SLIPPAGE);
        const pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice;
        const pnlWithLeverage = pnlPercent * position.leverage;
        
        // CALCUL DÉTAILLÉ
        const grossPnL = position.capitalAtEntry * pnlWithLeverage;
        const exitFee = (position.capitalAtEntry + grossPnL) * CONFIG.EXIT_FEE;
        const netPnL = grossPnL - exitFee;
        
        capital = position.capitalAtEntry + netPnL;
        
        const month = position.entryTime.toISOString().slice(0, 7);
        
        trades.push({
          symbol,
          entryTime: position.entryTime,
          exitTime: new Date(candles[i].timestamp),
          holdingHours: i - position.entryIdx,
          
          // PnL BRUT (sans leverage, sans frais)
          pnlPercentRaw: pnlPercent * 100,
          
          // PnL AVEC LEVERAGE (sans frais)
          pnlWithLeverage: pnlWithLeverage * 100,
          
          // PnL NET (avec leverage ET frais)
          pnlNet: (netPnL / position.capitalAtEntry) * 100,
          
          exitReason: exitSignal.reason,
          month,
          leverage: position.leverage,
          isRisky: position.isRisky,
          entryPrice: position.entryPrice,
          exitPrice,
        });
        
        position = null;
      }
    }
  }
  
  // Close open position
  if (position) {
    const exitPrice = candles[candles.length - 1].close;
    const pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice;
    const pnlWithLeverage = pnlPercent * position.leverage;
    capital = position.capitalAtEntry * (1 + pnlWithLeverage);
    trades.push({
      symbol,
      pnlPercentRaw: pnlPercent * 100,
      pnlWithLeverage: pnlWithLeverage * 100,
      pnlNet: pnlWithLeverage * 100,
      exitReason: 'end_of_data',
      month: position.entryTime?.toISOString().slice(0, 7),
      leverage: position.leverage,
    });
  }
  
  return { trades, finalCapital: capital };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 DEEP ANALYSIS - STOP LOSS INVESTIGATION');
  console.log('═'.repeat(80));
  
  const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'];
  
  console.log('\n📂 Loading data...\n');
  const allCandles = {};
  for (const symbol of symbols) {
    allCandles[symbol] = loadData(symbol);
    console.log(`   ${symbol}: ${allCandles[symbol].length} candles`);
  }
  
  // ═══════════════════════════════════════════════════════════════════════
  // ANALYSE 1: Breakdown des stop_loss
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 ANALYSE 1: POURQUOI LES STOP_LOSS SONT CATASTROPHIQUES?');
  console.log('═'.repeat(80));
  
  let allTrades = [];
  for (const symbol of symbols) {
    const { trades } = runBacktestDetailed(symbol, allCandles[symbol], false);
    allTrades = allTrades.concat(trades);
  }
  
  const stopLossTrades = allTrades.filter(t => t.exitReason === 'adaptive_stop_loss');
  
  console.log(`\n📉 STOP LOSS TRADES: ${stopLossTrades.length} total\n`);
  
  console.log('┌──────────────────────────────────────────────────────────────────┐');
  console.log('│ Métrique                          │ Sans Lev │ Avec Lev │ Net    │');
  console.log('├───────────────────────────────────┼──────────┼──────────┼────────┤');
  
  const avgRaw = stopLossTrades.reduce((s, t) => s + t.pnlPercentRaw, 0) / stopLossTrades.length;
  const avgLev = stopLossTrades.reduce((s, t) => s + t.pnlWithLeverage, 0) / stopLossTrades.length;
  const avgNet = stopLossTrades.reduce((s, t) => s + t.pnlNet, 0) / stopLossTrades.length;
  
  console.log(`│ PnL Moyen par trade               │ ${avgRaw.toFixed(2).padStart(7)}% │ ${avgLev.toFixed(2).padStart(7)}% │ ${avgNet.toFixed(2).padStart(5)}% │`);
  
  const totalRaw = stopLossTrades.reduce((s, t) => s + t.pnlPercentRaw, 0);
  const totalLev = stopLossTrades.reduce((s, t) => s + t.pnlWithLeverage, 0);
  const totalNet = stopLossTrades.reduce((s, t) => s + t.pnlNet, 0);
  
  console.log(`│ PnL Total                         │ ${totalRaw.toFixed(0).padStart(7)}% │ ${totalLev.toFixed(0).padStart(7)}% │ ${totalNet.toFixed(0).padStart(5)}% │`);
  console.log('└───────────────────────────────────┴──────────┴──────────┴────────┘');
  
  console.log(`
💡 EXPLICATION:
   • PnL Brut (sans leverage): ${avgRaw.toFixed(2)}% en moyenne
   • Avec leverage (~4x moyen): ${avgLev.toFixed(2)}% → MULTIPLIÉ!
   • Le stop loss est à ~-1.5% à -2% SANS leverage
   • AVEC leverage x4 → -6% à -8% par trade
   • AVEC leverage x5 → -7.5% à -10% par trade
`);
  
  // Breakdown par symbole
  console.log('\n┌──────────┬────────┬───────────┬───────────┬───────────┬─────────┐');
  console.log('│ Symbol   │ Trades │ Raw Avg   │ +Lev Avg  │ Net Avg   │ Leverage│');
  console.log('├──────────┼────────┼───────────┼───────────┼───────────┼─────────┤');
  
  for (const symbol of symbols) {
    const symTrades = stopLossTrades.filter(t => t.symbol === symbol);
    if (symTrades.length === 0) continue;
    const avgR = symTrades.reduce((s, t) => s + t.pnlPercentRaw, 0) / symTrades.length;
    const avgL = symTrades.reduce((s, t) => s + t.pnlWithLeverage, 0) / symTrades.length;
    const avgN = symTrades.reduce((s, t) => s + t.pnlNet, 0) / symTrades.length;
    const avgLev = symTrades.reduce((s, t) => s + t.leverage, 0) / symTrades.length;
    console.log(`│ ${symbol.padEnd(8)} │ ${String(symTrades.length).padStart(6)} │ ${avgR.toFixed(2).padStart(8)}% │ ${avgL.toFixed(2).padStart(8)}% │ ${avgN.toFixed(2).padStart(8)}% │ ${avgLev.toFixed(1).padStart(7)} │`);
  }
  console.log('└──────────┴────────┴───────────┴───────────┴───────────┴─────────┘');
  
  // ═══════════════════════════════════════════════════════════════════════
  // ANALYSE 2: Tableau mois par mois par crypto
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 ANALYSE 2: TABLEAU MOIS PAR MOIS PAR CRYPTO');
  console.log('═'.repeat(80));
  
  // Collecter tous les mois
  const months = [...new Set(allTrades.map(t => t.month).filter(Boolean))].sort();
  
  for (const symbol of symbols) {
    const symTrades = allTrades.filter(t => t.symbol === symbol);
    
    console.log(`\n┌─────────────────────────────────────────────────────────────────┐`);
    console.log(`│ ${symbol}                                                        │`);
    console.log('├─────────┬────────┬──────────┬───────────┬───────────┬───────────┤');
    console.log('│ Month   │ Trades │ Win Rate │ PnL Brut  │ +Leverage │ Net PnL   │');
    console.log('├─────────┼────────┼──────────┼───────────┼───────────┼───────────┤');
    
    let totalPnL = 0;
    for (const month of months) {
      const monthTrades = symTrades.filter(t => t.month === month);
      if (monthTrades.length === 0) continue;
      
      const wins = monthTrades.filter(t => t.pnlNet > 0).length;
      const wr = wins / monthTrades.length * 100;
      const pnlRaw = monthTrades.reduce((s, t) => s + t.pnlPercentRaw, 0);
      const pnlLev = monthTrades.reduce((s, t) => s + t.pnlWithLeverage, 0);
      const pnlNet = monthTrades.reduce((s, t) => s + t.pnlNet, 0);
      totalPnL += pnlNet;
      
      const marker = pnlNet >= 0 ? '✅' : '❌';
      console.log(`│${marker}${month} │ ${String(monthTrades.length).padStart(6)} │ ${wr.toFixed(0).padStart(7)}% │ ${pnlRaw >= 0 ? '+' : ''}${pnlRaw.toFixed(0).padStart(8)}% │ ${pnlLev >= 0 ? '+' : ''}${pnlLev.toFixed(0).padStart(8)}% │ ${pnlNet >= 0 ? '+' : ''}${pnlNet.toFixed(0).padStart(8)}% │`);
    }
    
    console.log('├─────────┼────────┼──────────┼───────────┼───────────┼───────────┤');
    const totalWins = symTrades.filter(t => t.pnlNet > 0).length;
    const totalWR = symTrades.length > 0 ? totalWins / symTrades.length * 100 : 0;
    const totalRaw = symTrades.reduce((s, t) => s + t.pnlPercentRaw, 0);
    const totalLev = symTrades.reduce((s, t) => s + t.pnlWithLeverage, 0);
    const totalNet = symTrades.reduce((s, t) => s + t.pnlNet, 0);
    console.log(`│ TOTAL   │ ${String(symTrades.length).padStart(6)} │ ${totalWR.toFixed(0).padStart(7)}% │ ${totalRaw >= 0 ? '+' : ''}${totalRaw.toFixed(0).padStart(8)}% │ ${totalLev >= 0 ? '+' : ''}${totalLev.toFixed(0).padStart(8)}% │ ${totalNet >= 0 ? '+' : ''}${totalNet.toFixed(0).padStart(8)}% │`);
    console.log('└─────────┴────────┴──────────┴───────────┴───────────┴───────────┘');
  }
  
  // ═══════════════════════════════════════════════════════════════════════
  // ANALYSE 3: Avec levier adaptatif
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 ANALYSE 3: COMPARAISON LEVERAGE FIXE vs ADAPTATIF');
  console.log('═'.repeat(80));
  
  console.log('\n┌──────────┬────────────────────────┬────────────────────────┐');
  console.log('│ Symbol   │ Leverage FIXE          │ Leverage ADAPTATIF     │');
  console.log('│          │ ROI     │ Max DD       │ ROI     │ Max DD       │');
  console.log('├──────────┼─────────┼──────────────┼─────────┼──────────────┤');
  
  let totalFixed = 0, totalAdaptive = 0;
  
  for (const symbol of symbols) {
    // Fixed leverage
    const { trades: tradesFixed, finalCapital: capFixed } = runBacktestDetailed(symbol, allCandles[symbol], false);
    const roiFixed = capFixed - 100;
    
    // Adaptive leverage
    const { trades: tradesAdapt, finalCapital: capAdapt } = runBacktestDetailed(symbol, allCandles[symbol], true);
    const roiAdapt = capAdapt - 100;
    
    totalFixed += roiFixed;
    totalAdaptive += roiAdapt;
    
    // Count risky trades
    const riskyCount = tradesAdapt.filter(t => t.isRisky).length;
    
    console.log(`│ ${symbol.padEnd(8)} │ ${roiFixed >= 0 ? '+' : ''}${roiFixed.toFixed(0).padStart(6)}% │              │ ${roiAdapt >= 0 ? '+' : ''}${roiAdapt.toFixed(0).padStart(6)}% │ (${riskyCount} risky) │`);
  }
  
  console.log('├──────────┼─────────┼──────────────┼─────────┼──────────────┤');
  console.log(`│ TOTAL    │ ${totalFixed >= 0 ? '+' : ''}${totalFixed.toFixed(0).padStart(6)}% │              │ ${totalAdaptive >= 0 ? '+' : ''}${totalAdaptive.toFixed(0).padStart(6)}% │              │`);
  console.log('└──────────┴─────────┴──────────────┴─────────┴──────────────┘');
  
  const improvement = totalAdaptive - totalFixed;
  console.log(`\n📈 Différence: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(0)}%`);
  
  // ═══════════════════════════════════════════════════════════════════════
  // ANALYSE 4: Impact du stop loss par asset
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 ANALYSE 4: IMPACT DU STOP LOSS PAR ASSET');
  console.log('═'.repeat(80));
  
  console.log('\n┌──────────┬──────────────────────┬──────────────────────┬──────────────┐');
  console.log('│ Symbol   │ Stop Loss Trades     │ Autres Trades        │ Différence   │');
  console.log('│          │ Count  │ Total PnL   │ Count  │ Total PnL   │              │');
  console.log('├──────────┼────────┼─────────────┼────────┼─────────────┼──────────────┤');
  
  for (const symbol of symbols) {
    const symTrades = allTrades.filter(t => t.symbol === symbol);
    const slTrades = symTrades.filter(t => t.exitReason === 'adaptive_stop_loss');
    const otherTrades = symTrades.filter(t => t.exitReason !== 'adaptive_stop_loss');
    
    const slPnL = slTrades.reduce((s, t) => s + t.pnlNet, 0);
    const otherPnL = otherTrades.reduce((s, t) => s + t.pnlNet, 0);
    
    console.log(`│ ${symbol.padEnd(8)} │ ${String(slTrades.length).padStart(6)} │ ${slPnL >= 0 ? '+' : ''}${slPnL.toFixed(0).padStart(10)}% │ ${String(otherTrades.length).padStart(6)} │ ${otherPnL >= 0 ? '+' : ''}${otherPnL.toFixed(0).padStart(10)}% │ ${(otherPnL + slPnL) >= 0 ? '+' : ''}${(otherPnL + slPnL).toFixed(0).padStart(11)}% │`);
  }
  
  console.log('└──────────┴────────┴─────────────┴────────┴─────────────┴──────────────┘');
  
  // ═══════════════════════════════════════════════════════════════════════
  // ANALYSE 5: Que se passe-t-il si on ne trade pas les stop losses?
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 ANALYSE 5: QUE SE PASSE-T-IL SANS LES TRADES QUI FINISSENT EN STOP LOSS?');
  console.log('═'.repeat(80));
  
  const nonSLTrades = allTrades.filter(t => t.exitReason !== 'adaptive_stop_loss');
  
  console.log('\n┌──────────┬────────┬──────────┬───────────┐');
  console.log('│ Symbol   │ Trades │ Win Rate │ Total PnL │');
  console.log('├──────────┼────────┼──────────┼───────────┤');
  
  let grandTotalNoSL = 0;
  for (const symbol of symbols) {
    const symTrades = nonSLTrades.filter(t => t.symbol === symbol);
    const wins = symTrades.filter(t => t.pnlNet > 0).length;
    const wr = symTrades.length > 0 ? wins / symTrades.length * 100 : 0;
    const totalPnL = symTrades.reduce((s, t) => s + t.pnlNet, 0);
    grandTotalNoSL += totalPnL;
    console.log(`│ ${symbol.padEnd(8)} │ ${String(symTrades.length).padStart(6)} │ ${wr.toFixed(0).padStart(7)}% │ ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(0).padStart(8)}% │`);
  }
  
  console.log('├──────────┼────────┼──────────┼───────────┤');
  const totalWinsNoSL = nonSLTrades.filter(t => t.pnlNet > 0).length;
  const totalWRNoSL = nonSLTrades.length > 0 ? totalWinsNoSL / nonSLTrades.length * 100 : 0;
  console.log(`│ TOTAL    │ ${String(nonSLTrades.length).padStart(6)} │ ${totalWRNoSL.toFixed(0).padStart(7)}% │ ${grandTotalNoSL >= 0 ? '+' : ''}${grandTotalNoSL.toFixed(0).padStart(8)}% │`);
  console.log('└──────────┴────────┴──────────┴───────────┘');
  
  const currentTotal = allTrades.reduce((s, t) => s + t.pnlNet, 0);
  console.log(`
💡 INSIGHT:
   • Avec tous les trades: ${currentTotal.toFixed(0)}% ROI (${allTrades.length} trades)
   • Sans les stop losses: ${grandTotalNoSL.toFixed(0)}% ROI (${nonSLTrades.length} trades)
   • Les stop losses coûtent: ${(grandTotalNoSL - currentTotal).toFixed(0)}% de PnL
   
   → Le problème n'est pas le stop loss en soi, mais les ENTRÉES qui y mènent!
`);

  // ═══════════════════════════════════════════════════════════════════════
  // CONCLUSIONS
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🎯 CONCLUSIONS                                                                ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ 1️⃣  POURQUOI -10% AVG SUR LES STOP LOSS?                                      ║
║    • Stop loss brut = -1.5% à -2% (pas catastrophique)                        ║
║    • MAIS avec leverage x5 (ETH/SOL) → -7.5% à -10%                           ║
║    • C'est le LEVERAGE qui amplifie la perte!                                 ║
║                                                                               ║
║ 2️⃣  OUI, C'EST AVEC LEVERAGE ET FRAIS                                         ║
║    • Les résultats montrés incluent leverage + frais (0.04% entry/exit)       ║
║    • Les frais sont ~0.1% par trade (négligeable vs leverage)                 ║
║                                                                               ║
║ 3️⃣  SOLUTION: LEVIER ADAPTATIF                                                ║
║    • Réduire le levier sur trades "risqués" (haute volatilité, RSI élevé)     ║
║    • Garder le levier normal sur trades "sûrs"                                ║
║    • Amélioration: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(0)}% ROI                                             ║
║                                                                               ║
║ 4️⃣  LE VRAI PROBLÈME                                                          ║
║    • Ce n'est pas le stop loss qui est mauvais                                ║
║    • Ce sont les ENTRÉES qui mènent au stop loss                              ║
║    • Il faut filtrer ces trades en amont (entry filter)                       ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
}

main().catch(console.error);
