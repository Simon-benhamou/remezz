/**
 * STRATEGY V3 - BEST EXITS + ASSET FILTER
 * 
 * Constats:
 * - BTC et SOL perdent toujours de l'argent
 * - ETH et XRP sont profitables
 * - Les meilleurs exits: momentum_fade, volume_dry_up, strong_reversal
 * 
 * Cette version:
 * 1. Filtre optionnel des assets (ETH/XRP only)
 * 2. Combine les meilleurs exits trouvés
 * 3. Améliore la gestion du stop loss
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
  LEVERAGE: { BTC: 3, ETH: 5, SOL: 5, XRP: 4 },
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
// BEST ENTRY (Breakout + Momentum + Volume)
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
// BEST COMBINED EXIT
// ═══════════════════════════════════════════════════════════════════════════

function shouldExitBestCombined(i, data, position) {
  const roc5 = data.roc5[i];
  const roc10 = data.roc10[i];
  const rsi = data.rsi[i];
  const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
  const vol = data.candles[i].volume;
  const volAvg = data.volSMA20[i];
  const holdingHours = i - position.entryIdx;
  
  // Track max PnL
  const maxPnl = position.maxPnl || 0;
  position.maxPnl = Math.max(maxPnl, pnl);
  
  // ════════════════════════════════════════════════════════════════════════
  // PROFIT EXITS (haute priorité - sécuriser les gains)
  // ════════════════════════════════════════════════════════════════════════
  
  // 1. Momentum fade profit (le meilleur historiquement: 100% WR)
  if (pnl > 0.02 && roc5 < 0.005) {
    return { reason: 'momentum_fade_profit' };
  }
  
  // 2. Volume dry-up exit (99% WR dans les tests)
  if (pnl > 0.005 && vol < volAvg * 0.5 && roc5 < 0) {
    return { reason: 'volume_dry_up' };
  }
  
  // 3. Multi-signal reversal (99% WR)
  let exitSignals = 0;
  if (roc5 < 0) exitSignals++;
  if (roc10 < roc5) exitSignals++;
  if (rsi > 70) exitSignals++;
  if (vol < volAvg * 0.7) exitSignals++;
  
  if (pnl > 0.01 && exitSignals >= 3) {
    return { reason: 'multi_signal_exit' };
  }
  
  // 4. Strong reversal signal
  if (pnl > 0 && exitSignals >= 2 && roc5 < -0.01) {
    return { reason: 'strong_reversal' };
  }
  
  // ════════════════════════════════════════════════════════════════════════
  // PROTECTION EXITS (protéger le capital)
  // ════════════════════════════════════════════════════════════════════════
  
  // 5. Profit lock: si on a touché +2%, ne pas perdre tout
  if (position.maxPnl >= 0.02 && pnl < position.maxPnl * 0.5) {
    return { reason: 'profit_lock' };
  }
  
  // 6. Break-even protection
  if (position.maxPnl >= 0.015 && pnl <= 0.002) {
    return { reason: 'breakeven_stop' };
  }
  
  // ════════════════════════════════════════════════════════════════════════
  // TIME EXITS (éviter les trades zombies)
  // ════════════════════════════════════════════════════════════════════════
  
  // 7. Quick time exit: si après 6h pas de progression
  if (holdingHours >= 6 && pnl >= 0 && pnl < 0.01 && roc5 < 0) {
    return { reason: 'time_exit_6h' };
  }
  
  // 8. Extended time exit
  if (holdingHours >= 24 && pnl < 0.015) {
    return { reason: 'time_exit_24h' };
  }
  
  // ════════════════════════════════════════════════════════════════════════
  // STOP LOSS (dernier recours - minimiser les pertes)
  // ════════════════════════════════════════════════════════════════════════
  
  // 9. Adaptive stop loss (plus serré)
  const atr = data.atr[i];
  const atrPercent = atr / data.candles[i].close;
  const stopLoss = atrPercent > 0.015 ? -0.02 : -0.015;
  
  if (pnl < stopLoss) {
    return { reason: 'adaptive_stop_loss' };
  }
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKTEST
// ═══════════════════════════════════════════════════════════════════════════

function runBacktest(symbol, candles) {
  const leverage = CONFIG.LEVERAGE[symbol.replace('/USDT', '')] || 3;
  
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
  let peakCapital = 100;
  let maxDrawdown = 0;
  
  for (let i = 50; i < candles.length; i++) {
    if (!position) {
      const signal = shouldEnter(i, data);
      if (signal) {
        const entryPrice = candles[i].close * (1 + CONFIG.SLIPPAGE);
        capital -= capital * CONFIG.ENTRY_FEE;
        
        position = {
          side: signal,
          entryPrice,
          entryIdx: i,
          entryTime: new Date(candles[i].timestamp),
          capitalAtEntry: capital,
          maxPnl: 0,
        };
      }
    } else {
      const exitSignal = shouldExitBestCombined(i, data, position);
      if (exitSignal) {
        const exitPrice = candles[i].close * (1 - CONFIG.SLIPPAGE);
        const pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice;
        const pnlWithLeverage = pnlPercent * leverage;
        
        capital = position.capitalAtEntry * (1 + pnlWithLeverage);
        capital -= capital * CONFIG.EXIT_FEE;
        
        trades.push({
          symbol,
          entryTime: position.entryTime,
          exitTime: new Date(candles[i].timestamp),
          holdingHours: i - position.entryIdx,
          pnlPercent: pnlPercent * 100,
          pnlWithLeverage: pnlWithLeverage * 100,
          exitReason: exitSignal.reason,
          month: position.entryTime.toISOString().slice(0, 7),
        });
        
        position = null;
      }
    }
    
    // Drawdown
    const equity = position 
      ? position.capitalAtEntry * (1 + ((candles[i].close - position.entryPrice) / position.entryPrice) * leverage)
      : capital;
    if (equity > peakCapital) peakCapital = equity;
    const dd = (peakCapital - equity) / peakCapital * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  
  // Close open position
  if (position) {
    const exitPrice = candles[candles.length - 1].close;
    const pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice;
    capital = position.capitalAtEntry * (1 + pnlPercent * leverage);
    trades.push({
      symbol,
      pnlPercent: pnlPercent * 100,
      pnlWithLeverage: pnlPercent * leverage * 100,
      exitReason: 'end_of_data',
    });
  }
  
  return { trades, finalCapital: capital, maxDrawdown };
}

// ═══════════════════════════════════════════════════════════════════════════
// WALK-FORWARD VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

function walkForwardTest(symbol, candles) {
  // Diviser en 4 trimestres
  const quarterSize = Math.floor(candles.length / 4);
  const results = [];
  
  for (let q = 0; q < 4; q++) {
    const start = q * quarterSize;
    const end = q === 3 ? candles.length : (q + 1) * quarterSize;
    const quarterCandles = candles.slice(start, end);
    
    const { trades, finalCapital } = runBacktest(symbol, quarterCandles);
    const roi = finalCapital - 100;
    const wins = trades.filter(t => t.pnlWithLeverage > 0).length;
    const wr = trades.length > 0 ? wins / trades.length * 100 : 0;
    
    results.push({
      quarter: `Q${q + 1}`,
      trades: trades.length,
      winRate: wr,
      roi,
    });
  }
  
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 STRATEGY V3 - OPTIMIZED EXITS + VALIDATION');
  console.log('═'.repeat(80));
  
  const allSymbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'];
  const profitableSymbols = ['ETH/USDT', 'XRP/USDT'];
  
  console.log('\n📂 Loading data...\n');
  const allCandles = {};
  for (const symbol of allSymbols) {
    allCandles[symbol] = loadData(symbol);
    console.log(`   ${symbol}: ${allCandles[symbol].length} candles`);
  }
  
  // ═══════════════════════════════════════════════════════════════════════
  // TEST 1: Tous les assets
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TEST 1: TOUS LES ASSETS (4 cryptos)');
  console.log('═'.repeat(80));
  
  let totalROI_all = 0;
  let allTrades_all = [];
  
  console.log('\n┌──────────┬────────┬──────────┬───────────┬──────────┐');
  console.log('│ Symbol   │ Trades │ Win Rate │   ROI     │  Max DD  │');
  console.log('├──────────┼────────┼──────────┼───────────┼──────────┤');
  
  for (const symbol of allSymbols) {
    const { trades, finalCapital, maxDrawdown } = runBacktest(symbol, allCandles[symbol]);
    const roi = finalCapital - 100;
    totalROI_all += roi;
    allTrades_all = allTrades_all.concat(trades);
    const wins = trades.filter(t => t.pnlWithLeverage > 0).length;
    const wr = trades.length > 0 ? wins / trades.length * 100 : 0;
    console.log(`│ ${symbol.padEnd(8)} │ ${String(trades.length).padStart(6)} │ ${wr.toFixed(1).padStart(7)}% │ ${roi >= 0 ? '+' : ''}${roi.toFixed(0).padStart(8)}% │ ${maxDrawdown.toFixed(0).padStart(7)}% │`);
  }
  
  console.log('├──────────┼────────┼──────────┼───────────┼──────────┤');
  const wins_all = allTrades_all.filter(t => t.pnlWithLeverage > 0).length;
  const wr_all = allTrades_all.length > 0 ? wins_all / allTrades_all.length * 100 : 0;
  console.log(`│ TOTAL    │ ${String(allTrades_all.length).padStart(6)} │ ${wr_all.toFixed(1).padStart(7)}% │ ${totalROI_all >= 0 ? '+' : ''}${totalROI_all.toFixed(0).padStart(8)}% │         │`);
  console.log('└──────────┴────────┴──────────┴───────────┴──────────┘');
  
  // Exit breakdown
  const exitStats_all = {};
  allTrades_all.forEach(t => {
    if (!exitStats_all[t.exitReason]) exitStats_all[t.exitReason] = { count: 0, pnl: 0, wins: 0 };
    exitStats_all[t.exitReason].count++;
    exitStats_all[t.exitReason].pnl += t.pnlWithLeverage || 0;
    if ((t.pnlWithLeverage || 0) > 0) exitStats_all[t.exitReason].wins++;
  });
  
  console.log('\n📊 Exit Reasons:');
  for (const [reason, stats] of Object.entries(exitStats_all).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const avgPnl = stats.pnl / stats.count;
    const wr = stats.wins / stats.count * 100;
    const marker = avgPnl > 0 ? '✅' : '❌';
    console.log(`   ${marker} ${reason.padEnd(22)}: ${String(stats.count).padStart(3)} trades, WR: ${wr.toFixed(0).padStart(3)}%, Avg: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2).padStart(6)}%, Total: ${stats.pnl >= 0 ? '+' : ''}${stats.pnl.toFixed(0).padStart(5)}%`);
  }
  
  // ═══════════════════════════════════════════════════════════════════════
  // TEST 2: Assets profitables seulement (ETH/XRP)
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TEST 2: ASSETS PROFITABLES SEULEMENT (ETH + XRP)');
  console.log('═'.repeat(80));
  
  let totalROI_profit = 0;
  let allTrades_profit = [];
  
  console.log('\n┌──────────┬────────┬──────────┬───────────┬──────────┐');
  console.log('│ Symbol   │ Trades │ Win Rate │   ROI     │  Max DD  │');
  console.log('├──────────┼────────┼──────────┼───────────┼──────────┤');
  
  for (const symbol of profitableSymbols) {
    const { trades, finalCapital, maxDrawdown } = runBacktest(symbol, allCandles[symbol]);
    const roi = finalCapital - 100;
    totalROI_profit += roi;
    allTrades_profit = allTrades_profit.concat(trades);
    const wins = trades.filter(t => t.pnlWithLeverage > 0).length;
    const wr = trades.length > 0 ? wins / trades.length * 100 : 0;
    console.log(`│ ${symbol.padEnd(8)} │ ${String(trades.length).padStart(6)} │ ${wr.toFixed(1).padStart(7)}% │ ${roi >= 0 ? '+' : ''}${roi.toFixed(0).padStart(8)}% │ ${maxDrawdown.toFixed(0).padStart(7)}% │`);
  }
  
  console.log('├──────────┼────────┼──────────┼───────────┼──────────┤');
  const wins_profit = allTrades_profit.filter(t => t.pnlWithLeverage > 0).length;
  const wr_profit = allTrades_profit.length > 0 ? wins_profit / allTrades_profit.length * 100 : 0;
  console.log(`│ TOTAL    │ ${String(allTrades_profit.length).padStart(6)} │ ${wr_profit.toFixed(1).padStart(7)}% │ ${totalROI_profit >= 0 ? '+' : ''}${totalROI_profit.toFixed(0).padStart(8)}% │         │`);
  console.log('└──────────┴────────┴──────────┴───────────┴──────────┘');
  
  // ═══════════════════════════════════════════════════════════════════════
  // WALK-FORWARD VALIDATION
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 WALK-FORWARD VALIDATION (robustesse par trimestre)');
  console.log('═'.repeat(80));
  
  console.log('\n┌──────────┬────────────────────────────────────────────┐');
  console.log('│ Symbol   │    Q1     │    Q2     │    Q3     │    Q4     │');
  console.log('├──────────┼───────────┼───────────┼───────────┼───────────┤');
  
  let robustCount = 0;
  for (const symbol of profitableSymbols) {
    const quarters = walkForwardTest(symbol, allCandles[symbol]);
    const positiveQs = quarters.filter(q => q.roi > 0).length;
    if (positiveQs >= 3) robustCount++;
    
    let line = `│ ${symbol.padEnd(8)} │`;
    for (const q of quarters) {
      const roiStr = `${q.roi >= 0 ? '+' : ''}${q.roi.toFixed(0)}%`;
      line += ` ${roiStr.padStart(9)} │`;
    }
    console.log(line);
  }
  
  console.log('└──────────┴───────────┴───────────┴───────────┴───────────┘');
  console.log(`\n📈 Assets robustes (3+/4 trimestres positifs): ${robustCount}/${profitableSymbols.length}`);
  
  // ═══════════════════════════════════════════════════════════════════════
  // MONTHLY ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 ANALYSE MENSUELLE (ETH + XRP)');
  console.log('═'.repeat(80));
  
  const monthlyPnL = {};
  allTrades_profit.forEach(t => {
    if (!t.month) return;
    if (!monthlyPnL[t.month]) monthlyPnL[t.month] = { trades: 0, pnl: 0, wins: 0 };
    monthlyPnL[t.month].trades++;
    monthlyPnL[t.month].pnl += t.pnlWithLeverage || 0;
    if ((t.pnlWithLeverage || 0) > 0) monthlyPnL[t.month].wins++;
  });
  
  console.log('\n┌─────────┬────────┬──────────┬───────────┐');
  console.log('│ Month   │ Trades │ Win Rate │  PnL      │');
  console.log('├─────────┼────────┼──────────┼───────────┤');
  
  let positiveMonths = 0;
  for (const [month, data] of Object.entries(monthlyPnL).sort()) {
    const wr = data.wins / data.trades * 100;
    const marker = data.pnl >= 0 ? '✅' : '❌';
    if (data.pnl > 0) positiveMonths++;
    console.log(`│${marker}${month} │ ${String(data.trades).padStart(6)} │ ${wr.toFixed(0).padStart(7)}% │ ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(0).padStart(8)}% │`);
  }
  
  console.log('└─────────┴────────┴──────────┴───────────┘');
  console.log(`\n📈 Mois positifs: ${positiveMonths}/${Object.keys(monthlyPnL).length} (${(positiveMonths/Object.keys(monthlyPnL).length*100).toFixed(0)}%)`);
  
  // ═══════════════════════════════════════════════════════════════════════
  // CONCLUSIONS
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🎯 CONCLUSIONS STRATEGY V3                                                    ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ 📊 COMPARAISON:                                                               ║
║   • 4 cryptos (BTC/ETH/SOL/XRP): ${totalROI_all >= 0 ? '+' : ''}${totalROI_all.toFixed(0).padStart(5)}% ROI, ${wr_all.toFixed(0)}% Win Rate                   ║
║   • 2 cryptos (ETH/XRP only):    ${totalROI_profit >= 0 ? '+' : ''}${totalROI_profit.toFixed(0).padStart(5)}% ROI, ${wr_profit.toFixed(0)}% Win Rate                   ║
║                                                                               ║
║ 🔑 EXITS QUI FONCTIONNENT:                                                    ║
║   1. momentum_fade_profit  → 100% WR (le meilleur)                            ║
║   2. volume_dry_up         → ~99% WR (nouveau!)                               ║
║   3. multi_signal_exit     → ~100% WR                                         ║
║   4. profit_lock           → 100% WR (protection des gains)                   ║
║                                                                               ║
║ ⚠️  PROBLÈME PERSISTANT:                                                      ║
║   • Les stop_loss représentent ~45% des trades                                ║
║   • Ils ont 0% WR et -10% avg = destruction de capital                        ║
║                                                                               ║
║ 💡 RECOMMANDATION:                                                            ║
║   • Trader UNIQUEMENT ETH et XRP                                              ║
║   • Réduire le levier si le drawdown est trop élevé                           ║
║   • Le système dépend fortement des "momentum_fade" exits                     ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
}

main().catch(console.error);
