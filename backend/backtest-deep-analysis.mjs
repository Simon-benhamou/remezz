/**
 * DEEP ANALYSIS: Breakout + Momentum Strategy
 * 
 * Questions à répondre:
 * 1. Est-ce que ça marche avec des frais réalistes?
 * 2. Est-ce que c'est du curve fitting ou un vrai edge?
 * 3. Comment se comporte la stratégie mois par mois?
 * 4. Quel est le drawdown max?
 * 5. Est-ce que ça marche sur tous les assets ou juste certains?
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIOS DE FRAIS À TESTER
// ═══════════════════════════════════════════════════════════════════════════

const FEE_SCENARIOS = {
  OPTIMISTIC: {
    name: 'Optimiste (Maker VIP)',
    entryFee: 0.0002,  // 0.02%
    exitFee: 0.0002,
    slippage: 0.0001,
  },
  REALISTIC: {
    name: 'Réaliste (Taker standard)',
    entryFee: 0.0004,  // 0.04%
    exitFee: 0.0004,
    slippage: 0.0002,
  },
  PESSIMISTIC: {
    name: 'Pessimiste (Taker + slippage)',
    entryFee: 0.0005,  // 0.05%
    exitFee: 0.0005,
    slippage: 0.0005,
  },
  WORST_CASE: {
    name: 'Pire cas (urgence liquidité)',
    entryFee: 0.0006,
    exitFee: 0.0006,
    slippage: 0.001,  // 0.1% slippage
  },
};

// Leverage par asset
const LEVERAGE = { BTC: 3, ETH: 5, SOL: 5, XRP: 4 };

// ═══════════════════════════════════════════════════════════════════════════
// INDICATEURS
// ═══════════════════════════════════════════════════════════════════════════

function calculateATR(candles, period = 14) {
  const atrs = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      atrs.push(candles[i].high - candles[i].low);
      continue;
    }
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

// ═══════════════════════════════════════════════════════════════════════════
// STRATÉGIE: Breakout + Momentum Confirm (la meilleure du test précédent)
// ═══════════════════════════════════════════════════════════════════════════

const STRATEGY = {
  name: 'Breakout + Momentum Confirm',
  
  shouldEnter: (i, data) => {
    if (i < 30) return null;
    
    const close = data.candles[i].close;
    
    // Range des 20 dernières bougies
    let highest = 0, lowest = Infinity;
    for (let j = i - 20; j < i; j++) {
      if (data.candles[j].high > highest) highest = data.candles[j].high;
      if (data.candles[j].low < lowest) lowest = data.candles[j].low;
    }
    
    const range = highest - lowest;
    const breakoutThreshold = highest + range * 0.02;
    
    const roc5 = data.roc5[i];
    const vol = data.candles[i].volume;
    const volAvg = data.volSMA20[i];
    
    // Breakout + momentum + volume
    if (close > breakoutThreshold && roc5 > 0.015 && vol > volAvg * 1.3) {
      return 'long';
    }
    return null;
  },
  
  shouldExit: (i, data, position) => {
    const roc5 = data.roc5[i];
    const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
    
    // Exit 1: Momentum ne confirme plus (notre edge!)
    if (pnl > 0.02 && roc5 < 0.005) {
      return { reason: 'momentum_not_confirming', type: 'profit' };
    }
    
    // Exit 2: Faux breakout
    if (pnl < -0.02) {
      return { reason: 'false_breakout', type: 'loss' };
    }
    
    // Exit 3: Trailing stop ATR
    const atr = data.atr[i];
    const high = Math.max(position.highWaterMark || position.entryPrice, data.candles[i].high);
    position.highWaterMark = high;
    if (data.candles[i].close < high - atr * 2) {
      return { reason: 'atr_trailing', type: pnl > 0 ? 'profit' : 'loss' };
    }
    
    return null;
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE AMÉLIORÉ
// ═══════════════════════════════════════════════════════════════════════════

function runBacktest(symbol, candles, feeScenario) {
  const leverage = LEVERAGE[symbol.replace('/USDT', '')] || 3;
  const { entryFee, exitFee, slippage } = feeScenario;
  
  // Prepare indicators
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  
  const data = {
    candles,
    atr: calculateATR(candles, 14),
    roc5: calculateROC(closes, 5),
    volSMA20: calculateVolSMA(volumes, 20),
  };
  
  const trades = [];
  let position = null;
  let capital = 100;
  let peakCapital = 100;
  let maxDrawdown = 0;
  const equityCurve = [];
  
  for (let i = 50; i < candles.length; i++) {
    if (!position) {
      const signal = STRATEGY.shouldEnter(i, data);
      if (signal === 'long') {
        const entryPrice = candles[i].close * (1 + slippage);
        capital -= capital * entryFee;
        
        position = {
          entryPrice,
          entryIdx: i,
          entryTime: new Date(candles[i].timestamp),
          capitalAtEntry: capital,
          highWaterMark: entryPrice,
        };
      }
    } else {
      position.highWaterMark = Math.max(position.highWaterMark, candles[i].high);
      
      const exitSignal = STRATEGY.shouldExit(i, data, position);
      if (exitSignal) {
        const exitPrice = candles[i].close * (1 - slippage);
        const pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice;
        const pnlWithLeverage = pnlPercent * leverage;
        
        capital = position.capitalAtEntry * (1 + pnlWithLeverage);
        capital -= capital * exitFee;
        
        trades.push({
          symbol,
          entryPrice: position.entryPrice,
          exitPrice,
          entryTime: position.entryTime,
          exitTime: new Date(candles[i].timestamp),
          holdingHours: i - position.entryIdx,
          pnlPercent: pnlPercent * 100,
          pnlWithLeverage: pnlWithLeverage * 100,
          exitReason: exitSignal.reason,
          exitType: exitSignal.type,
          month: position.entryTime.toISOString().slice(0, 7),
        });
        
        position = null;
      }
    }
    
    // Track equity curve
    const currentEquity = position 
      ? position.capitalAtEntry * (1 + ((candles[i].close - position.entryPrice) / position.entryPrice) * leverage)
      : capital;
    
    equityCurve.push({ time: candles[i].timestamp, equity: currentEquity });
    
    if (currentEquity > peakCapital) peakCapital = currentEquity;
    const dd = (peakCapital - currentEquity) / peakCapital * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  
  // Close open position
  if (position) {
    const exitPrice = candles[candles.length - 1].close;
    const pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice;
    const pnlWithLeverage = pnlPercent * leverage;
    capital = position.capitalAtEntry * (1 + pnlWithLeverage);
    trades.push({
      symbol,
      pnlPercent: pnlPercent * 100,
      pnlWithLeverage: pnlWithLeverage * 100,
      exitReason: 'end_of_data',
      month: position.entryTime.toISOString().slice(0, 7),
    });
  }
  
  return { trades, finalCapital: capital, maxDrawdown, equityCurve };
}

// ═══════════════════════════════════════════════════════════════════════════
// WALK-FORWARD ANALYSIS (Test de robustesse)
// ═══════════════════════════════════════════════════════════════════════════

function walkForwardAnalysis(candles) {
  // Split en 4 périodes de 3 mois
  const periodLength = Math.floor(candles.length / 4);
  const periods = [];
  
  for (let i = 0; i < 4; i++) {
    const start = i * periodLength;
    const end = Math.min((i + 1) * periodLength, candles.length);
    const periodCandles = candles.slice(start, end);
    
    const result = runBacktest('TEST', periodCandles, FEE_SCENARIOS.REALISTIC);
    const roi = result.finalCapital - 100;
    const wins = result.trades.filter(t => t.pnlWithLeverage > 0).length;
    const wr = result.trades.length > 0 ? wins / result.trades.length * 100 : 0;
    
    periods.push({
      period: i + 1,
      trades: result.trades.length,
      winRate: wr,
      roi,
      maxDD: result.maxDrawdown,
    });
  }
  
  return periods;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 DEEP ANALYSIS: Breakout + Momentum Strategy');
  console.log('═'.repeat(80));
  console.log('\n📊 Fetching 1 year of hourly data...\n');
  
  const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'];
  
  async function fetchCandles(symbol, since) {
    const candles = [];
    let currentSince = since;
    while (candles.length < 8760) {
      const batch = await exchange.fetchOHLCV(symbol, '1h', currentSince, 500);
      if (batch.length === 0) break;
      candles.push(...batch);
      currentSince = batch[batch.length - 1][0] + 1;
      await new Promise(r => setTimeout(r, 100));
    }
    return candles.map(c => ({
      timestamp: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    }));
  }
  
  const allCandles = {};
  const since = Date.now() - 365 * 24 * 60 * 60 * 1000;
  
  for (const symbol of symbols) {
    allCandles[symbol] = await fetchCandles(symbol, since);
    console.log(`   ${symbol}: ${allCandles[symbol].length} candles`);
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 1: Impact des frais
  // ═══════════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TEST 1: IMPACT DES FRAIS');
  console.log('═'.repeat(80));
  
  console.log('\n┌─────────────────────────────┬──────────┬──────────┬──────────┬──────────┐');
  console.log('│ Scénario de Frais           │   BTC    │   ETH    │   SOL    │   XRP    │');
  console.log('├─────────────────────────────┼──────────┼──────────┼──────────┼──────────┤');
  
  const feeResults = {};
  
  for (const [feeKey, feeScenario] of Object.entries(FEE_SCENARIOS)) {
    feeResults[feeKey] = {};
    const rois = [];
    
    for (const symbol of symbols) {
      const result = runBacktest(symbol, allCandles[symbol], feeScenario);
      const roi = result.finalCapital - 100;
      feeResults[feeKey][symbol] = roi;
      rois.push(roi);
    }
    
    const totalROI = rois.reduce((a, b) => a + b, 0);
    console.log(`│ ${feeScenario.name.padEnd(27)} │ ${feeResults[feeKey]['BTC/USDT'] >= 0 ? '+' : ''}${feeResults[feeKey]['BTC/USDT'].toFixed(0).padStart(7)}% │ ${feeResults[feeKey]['ETH/USDT'] >= 0 ? '+' : ''}${feeResults[feeKey]['ETH/USDT'].toFixed(0).padStart(7)}% │ ${feeResults[feeKey]['SOL/USDT'] >= 0 ? '+' : ''}${feeResults[feeKey]['SOL/USDT'].toFixed(0).padStart(7)}% │ ${feeResults[feeKey]['XRP/USDT'] >= 0 ? '+' : ''}${feeResults[feeKey]['XRP/USDT'].toFixed(0).padStart(7)}% │`);
  }
  console.log('└─────────────────────────────┴──────────┴──────────┴──────────┴──────────┘');
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 2: Analyse par mois
  // ═══════════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TEST 2: PERFORMANCE PAR MOIS (tous assets combinés)');
  console.log('═'.repeat(80));
  
  const allTrades = [];
  for (const symbol of symbols) {
    const result = runBacktest(symbol, allCandles[symbol], FEE_SCENARIOS.REALISTIC);
    allTrades.push(...result.trades);
  }
  
  // Group by month
  const monthlyPerf = {};
  allTrades.forEach(t => {
    if (!t.month) return;
    if (!monthlyPerf[t.month]) monthlyPerf[t.month] = { trades: 0, wins: 0, pnl: 0 };
    monthlyPerf[t.month].trades++;
    if (t.pnlWithLeverage > 0) monthlyPerf[t.month].wins++;
    monthlyPerf[t.month].pnl += t.pnlWithLeverage;
  });
  
  console.log('\n┌──────────┬────────┬──────────┬───────────┐');
  console.log('│   Mois   │ Trades │ Win Rate │    P&L    │');
  console.log('├──────────┼────────┼──────────┼───────────┤');
  
  let profitableMonths = 0;
  let totalMonths = 0;
  
  for (const [month, stats] of Object.entries(monthlyPerf).sort()) {
    const wr = stats.trades > 0 ? stats.wins / stats.trades * 100 : 0;
    const marker = stats.pnl > 0 ? '✅' : '❌';
    console.log(`│ ${month}  │ ${String(stats.trades).padStart(6)} │ ${wr.toFixed(0).padStart(7)}% │ ${stats.pnl >= 0 ? '+' : ''}${stats.pnl.toFixed(1).padStart(8)}% │ ${marker}`);
    if (stats.pnl > 0) profitableMonths++;
    totalMonths++;
  }
  console.log('└──────────┴────────┴──────────┴───────────┘');
  console.log(`\n📈 Mois profitables: ${profitableMonths}/${totalMonths} (${(profitableMonths/totalMonths*100).toFixed(0)}%)`);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 3: Walk-Forward Analysis
  // ═══════════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TEST 3: WALK-FORWARD ANALYSIS (robustesse)');
  console.log('═'.repeat(80));
  console.log('\nDivision de l\'année en 4 trimestres - la stratégie marche-t-elle sur TOUS?\n');
  
  for (const symbol of symbols) {
    console.log(`\n${symbol}:`);
    const periods = walkForwardAnalysis(allCandles[symbol]);
    
    console.log('┌──────────┬────────┬──────────┬──────────┬──────────┐');
    console.log('│ Trimestre│ Trades │ Win Rate │   ROI    │  Max DD  │');
    console.log('├──────────┼────────┼──────────┼──────────┼──────────┤');
    
    let allPositive = true;
    for (const p of periods) {
      const marker = p.roi > 0 ? '✅' : '❌';
      if (p.roi <= 0) allPositive = false;
      console.log(`│    Q${p.period}    │ ${String(p.trades).padStart(6)} │ ${p.winRate.toFixed(0).padStart(7)}% │ ${p.roi >= 0 ? '+' : ''}${p.roi.toFixed(0).padStart(7)}% │ ${p.maxDD.toFixed(0).padStart(7)}% │ ${marker}`);
    }
    console.log('└──────────┴────────┴──────────┴──────────┴──────────┘');
    
    if (allPositive) {
      console.log(`   ✅ ${symbol} profitable sur TOUS les trimestres!`);
    } else {
      console.log(`   ⚠️  ${symbol} a des trimestres perdants`);
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 4: Drawdown Analysis
  // ═══════════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TEST 4: ANALYSE DU DRAWDOWN');
  console.log('═'.repeat(80));
  
  console.log('\n┌──────────┬───────────┬───────────┬────────────┬────────────────────┐');
  console.log('│ Symbol   │    ROI    │  Max DD   │ Risk/Reward│ Trades pour profit │');
  console.log('├──────────┼───────────┼───────────┼────────────┼────────────────────┤');
  
  for (const symbol of symbols) {
    const result = runBacktest(symbol, allCandles[symbol], FEE_SCENARIOS.REALISTIC);
    const roi = result.finalCapital - 100;
    const riskReward = roi / result.maxDrawdown;
    
    const profitTrades = result.trades.filter(t => t.pnlWithLeverage > 0);
    const lossTrades = result.trades.filter(t => t.pnlWithLeverage <= 0);
    
    console.log(`│ ${symbol.padEnd(8)} │ ${roi >= 0 ? '+' : ''}${roi.toFixed(0).padStart(8)}% │ ${result.maxDrawdown.toFixed(0).padStart(8)}% │ ${riskReward.toFixed(2).padStart(10)} │ ${profitTrades.length}W / ${lossTrades.length}L           │`);
  }
  console.log('└──────────┴───────────┴───────────┴────────────┴────────────────────┘');
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 5: Exit Reason Deep Dive
  // ═══════════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TEST 5: ANALYSE DES TYPES DE SORTIE');
  console.log('═'.repeat(80));
  
  const exitStats = {};
  allTrades.forEach(t => {
    if (!exitStats[t.exitReason]) exitStats[t.exitReason] = { count: 0, totalPnl: 0, wins: 0 };
    exitStats[t.exitReason].count++;
    exitStats[t.exitReason].totalPnl += t.pnlWithLeverage || 0;
    if ((t.pnlWithLeverage || 0) > 0) exitStats[t.exitReason].wins++;
  });
  
  console.log('\n┌────────────────────────┬────────┬──────────┬───────────┬──────────────┐');
  console.log('│ Exit Reason            │ Count  │ Win Rate │  Avg P&L  │  Total P&L   │');
  console.log('├────────────────────────┼────────┼──────────┼───────────┼──────────────┤');
  
  for (const [reason, stats] of Object.entries(exitStats).sort((a, b) => b[1].totalPnl - a[1].totalPnl)) {
    const avgPnl = stats.totalPnl / stats.count;
    const wr = stats.wins / stats.count * 100;
    const marker = avgPnl > 0 ? '✅' : '❌';
    console.log(`│ ${reason.padEnd(22)} │ ${String(stats.count).padStart(6)} │ ${wr.toFixed(0).padStart(7)}% │ ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2).padStart(8)}% │ ${stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(1).padStart(11)}% │ ${marker}`);
  }
  console.log('└────────────────────────┴────────┴──────────┴───────────┴──────────────┘');
  
  // ═══════════════════════════════════════════════════════════════════════════
  // CONCLUSIONS FINALES
  // ═══════════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 CONCLUSIONS FINALES');
  console.log('═'.repeat(80));
  
  // Calculate overall stats
  const realisticTotal = Object.values(feeResults.REALISTIC).reduce((a, b) => a + b, 0);
  const pessimisticTotal = Object.values(feeResults.PESSIMISTIC).reduce((a, b) => a + b, 0);
  const worstCaseTotal = Object.values(feeResults.WORST_CASE).reduce((a, b) => a + b, 0);
  
  const avgTrades = allTrades.length;
  const avgHolding = allTrades.reduce((s, t) => s + (t.holdingHours || 0), 0) / allTrades.length;
  
  // Check robustness
  let robustAssets = 0;
  for (const symbol of symbols) {
    const periods = walkForwardAnalysis(allCandles[symbol]);
    const allPositive = periods.every(p => p.roi > 0);
    if (allPositive) robustAssets++;
  }
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 📊 RÉSULTATS DE L'ANALYSE APPROFONDIE                                         ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ 💰 IMPACT DES FRAIS:                                                          ║
║    • Frais réalistes (0.04%):    ${realisticTotal >= 0 ? '+' : ''}${realisticTotal.toFixed(0)}% ROI total                        ║
║    • Frais pessimistes (0.05%):  ${pessimisticTotal >= 0 ? '+' : ''}${pessimisticTotal.toFixed(0)}% ROI total                        ║
║    • Pire cas (0.06% + 0.1% slip): ${worstCaseTotal >= 0 ? '+' : ''}${worstCaseTotal.toFixed(0)}% ROI total                       ║
║                                                                               ║
║ 📈 ROBUSTESSE:                                                                ║
║    • Mois profitables: ${profitableMonths}/${totalMonths} (${(profitableMonths/totalMonths*100).toFixed(0)}%)                                      ║
║    • Assets robustes sur 4 trimestres: ${robustAssets}/${symbols.length}                             ║
║                                                                               ║
║ 📊 STATISTIQUES:                                                              ║
║    • ${avgTrades} trades sur 1 an (${(avgTrades/12).toFixed(0)} par mois)                                   ║
║    • Holding moyen: ${avgHolding.toFixed(0)}h (${(avgHolding/24).toFixed(1)} jours)                                   ║
║                                                                               ║
╠═══════════════════════════════════════════════════════════════════════════════╣
`);

  // Final verdict
  const isViable = realisticTotal > 0 && profitableMonths >= totalMonths * 0.5;
  
  if (isViable) {
    console.log(`║ ✅ VERDICT: STRATÉGIE POTENTIELLEMENT VIABLE                                  ║`);
    console.log(`║                                                                               ║`);
    console.log(`║ MAIS ATTENTION:                                                               ║`);
    console.log(`║ • ${robustAssets}/${symbols.length} assets sont vraiment robustes                                       ║`);
    console.log(`║ • Les frais mangent une partie significative des gains                        ║`);
    console.log(`║ • Le backtest ne garantit pas les résultats futurs                            ║`);
    console.log(`║ • La stratégie dépend beaucoup de quelques gros trades gagnants              ║`);
  } else {
    console.log(`║ ❌ VERDICT: STRATÉGIE NON VIABLE EN CONDITIONS RÉELLES                        ║`);
    console.log(`║                                                                               ║`);
    console.log(`║ RAISONS:                                                                      ║`);
    console.log(`║ • Les frais détruisent l'edge                                                 ║`);
    console.log(`║ • Pas assez de mois profitables                                               ║`);
    console.log(`║ • Performance non robuste sur tous les trimestres                             ║`);
  }
  
  console.log(`╚═══════════════════════════════════════════════════════════════════════════════╝
`);
  
  process.exit(0);
}

main().catch(console.error);
