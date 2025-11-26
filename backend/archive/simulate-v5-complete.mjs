/**
 * SIMULATION V5 COMPLÈTE - 6 Mois de backtest
 * 
 * Utilise plusieurs appels pour avoir plus de données
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION V5
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  INITIAL_CAPITAL: 1000,
  POSITION_SIZE_PCT: 0.4,   // 40% (was 50%)
  MAX_POSITIONS: 4,
  
  SYMBOLS: ['SEI/USDT', 'XRP/USDT', 'ETH/USDT', 'IMX/USDT'],
  
  LEVERAGE: {
    'SEI/USDT': 5,
    'XRP/USDT': 4,
    'ETH/USDT': 5,
    'IMX/USDT': 5,
  },
  
  ENTRY: {
    BB_PERIOD: 20,
    BB_STD: 2.0,
    ROC_PERIOD: 10,
    ROC_MIN: 1.5,
    VOLUME_MULT: 1.3,
    MAX_CONSEC_UP: 4,
    ALLOWED_DAYS: [1, 2, 3, 4, 5],
  },
  
  // V5.1 - Ajusté pour meilleur R:R
  EXIT: {
    STOP_LOSS_PCT: 1.5,           // 1.5% (was 2%) → ~7.5% avec 5x
    TAKE_PROFIT_PCT: 3.0,         // 3% (was 2.5%) → ~15% avec 5x
    TRAILING_ACTIVATION: 1.2,     // Activer plus tôt
    TRAILING_DISTANCE: 0.6,       // Plus serré
    MAX_HOLD_HOURS: 48,
  },
  
  ENTRY_FEE: 0.0004,
  EXIT_FEE: 0.0004,
  SLIPPAGE: 0.0002,
};

// ═══════════════════════════════════════════════════════════════════════════
// INDICATEURS
// ═══════════════════════════════════════════════════════════════════════════

function calcSMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcStdDev(values, period) {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const squaredDiffs = slice.map(v => Math.pow(v - mean, 2));
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / period);
}

function calcBB(closes, period = 20, stdMult = 2) {
  const sma = calcSMA(closes, period);
  const std = calcStdDev(closes, period);
  return { upper: sma + std * stdMult, middle: sma, lower: sma - std * stdMult };
}

function calcROC(closes, period = 10) {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  return ((current - past) / past) * 100;
}

function countConsecutiveUp(candles, maxLookback = 10) {
  let count = 0;
  for (let i = candles.length - 1; i > Math.max(0, candles.length - maxLookback); i--) {
    if (candles[i].close > candles[i].open) count++;
    else break;
  }
  return count;
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL V5
// ═══════════════════════════════════════════════════════════════════════════

function checkEntrySignal(candles, btcCandles) {
  if (candles.length < 50 || btcCandles.length < 200) return null;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  // 1. BTC > SMA200
  const btcCloses = btcCandles.map(c => c.close);
  const btcSma200 = calcSMA(btcCloses, 200);
  if (btcCloses[btcCloses.length - 1] < btcSma200) return null;
  
  // 2. BB breakout
  const bb = calcBB(closes, CONFIG.ENTRY.BB_PERIOD, CONFIG.ENTRY.BB_STD);
  if (current.close <= bb.upper) return null;
  
  // 3. ROC > 1.5%
  const roc = calcROC(closes, CONFIG.ENTRY.ROC_PERIOD);
  if (roc < CONFIG.ENTRY.ROC_MIN) return null;
  
  // 4. Volume > 1.3x
  const volMA = calcSMA(volumes, 20);
  if (current.volume < volMA * CONFIG.ENTRY.VOLUME_MULT) return null;
  
  // 5. Max consec up
  if (countConsecutiveUp(candles) > CONFIG.ENTRY.MAX_CONSEC_UP) return null;
  
  return { side: 'long', roc };
}

function checkExitSignal(position, currentPrice, holdingHours) {
  const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  
  if (pnlPct <= -CONFIG.EXIT.STOP_LOSS_PCT) return { reason: 'stop_loss' };
  if (pnlPct >= CONFIG.EXIT.TAKE_PROFIT_PCT) return { reason: 'take_profit' };
  
  if (position.highWaterMark) {
    const hwmPct = ((position.highWaterMark - position.entryPrice) / position.entryPrice) * 100;
    if (hwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION) {
      const trailingStop = position.highWaterMark * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100);
      if (currentPrice <= trailingStop) return { reason: 'trailing_stop' };
    }
  }
  
  if (holdingHours >= CONFIG.EXIT.MAX_HOLD_HOURS) return { reason: 'max_hold_48h' };
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA FETCHING (multiple calls for 6 months)
// ═══════════════════════════════════════════════════════════════════════════

async function fetchExtendedData(symbol, months = 6) {
  const allCandles = [];
  const now = Date.now();
  const interval = 15 * 60 * 1000; // 15 min
  const candlesPerCall = 1000;
  const msPerCall = candlesPerCall * interval;
  
  let endTime = now;
  for (let i = 0; i < Math.ceil(months * 30 * 24 * 4 / candlesPerCall); i++) {
    try {
      const startTime = endTime - msPerCall;
      const ohlcv = await exchange.fetchOHLCV(symbol.replace('/', ''), '15m', startTime, candlesPerCall);
      
      for (const c of ohlcv) {
        allCandles.push({
          timestamp: c[0],
          open: c[1],
          high: c[2],
          low: c[3],
          close: c[4],
          volume: c[5],
        });
      }
      
      endTime = startTime;
      
      // Rate limit
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.log(`   Warning: ${err.message}`);
      break;
    }
  }
  
  // Sort by timestamp and remove duplicates
  allCandles.sort((a, b) => a.timestamp - b.timestamp);
  const unique = [];
  let lastTs = 0;
  for (const c of allCandles) {
    if (c.timestamp !== lastTs) {
      unique.push(c);
      lastTs = c.timestamp;
    }
  }
  
  return unique;
}

// ═══════════════════════════════════════════════════════════════════════════
// SIMULATION
// ═══════════════════════════════════════════════════════════════════════════

async function runSimulation() {
  console.log('═'.repeat(80));
  console.log('🎯 SIMULATION V5 COMPLÈTE - 6 MOIS');
  console.log('═'.repeat(80));
  console.log('\n📊 Fetching 6 months of 15m data (this will take a moment)...\n');
  
  const allCandles = {};
  for (const symbol of CONFIG.SYMBOLS) {
    allCandles[symbol] = await fetchExtendedData(symbol, 6);
    console.log(`   ${symbol}: ${allCandles[symbol].length} candles`);
  }
  
  // BTC for regime filter
  const btcCandles = await fetchExtendedData('BTC/USDT', 7); // Extra month for SMA200
  console.log(`   BTC: ${btcCandles.length} candles`);
  
  // Simulation
  const positions = {};
  const trades = [];
  let capital = CONFIG.INITIAL_CAPITAL;
  const monthlyPnL = {};
  
  // Find common time range
  const startTime = Math.max(...CONFIG.SYMBOLS.map(s => allCandles[s][200]?.timestamp || 0));
  const endTime = Math.min(...CONFIG.SYMBOLS.map(s => allCandles[s][allCandles[s].length-1]?.timestamp || Infinity));
  
  console.log(`\n🚀 Simulating from ${new Date(startTime).toISOString().split('T')[0]} to ${new Date(endTime).toISOString().split('T')[0]}...\n`);
  
  const candleInterval = 15 * 60 * 1000;
  
  for (let time = startTime; time <= endTime; time += candleInterval) {
    const date = new Date(time);
    const monthKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`;
    const dayOfWeek = date.getUTCDay();
    const isTradingDay = CONFIG.ENTRY.ALLOWED_DAYS.includes(dayOfWeek);
    
    for (const symbol of CONFIG.SYMBOLS) {
      const symbolCandles = allCandles[symbol].filter(c => c.timestamp <= time);
      if (symbolCandles.length < 50) continue;
      
      const btcCandlesNow = btcCandles.filter(c => c.timestamp <= time);
      const currentCandle = symbolCandles[symbolCandles.length - 1];
      const currentPrice = currentCandle.close;
      
      if (positions[symbol]) {
        const pos = positions[symbol];
        pos.highWaterMark = Math.max(pos.highWaterMark || pos.entryPrice, currentCandle.high);
        
        const holdingHours = (time - pos.entryTime) / (60 * 60 * 1000);
        const exitSignal = checkExitSignal(pos, currentPrice, holdingHours);
        
        if (exitSignal) {
          const exitPrice = currentPrice * (1 - CONFIG.SLIPPAGE);
          const pnlPct = (exitPrice - pos.entryPrice) / pos.entryPrice;
          const leverage = CONFIG.LEVERAGE[symbol];
          const pnlWithLeverage = pnlPct * leverage;
          const pnlUsd = pos.capitalUsed * pnlWithLeverage;
          const exitFee = pos.capitalUsed * CONFIG.EXIT_FEE;
          const netPnl = pnlUsd - exitFee;
          
          capital += netPnl;
          
          trades.push({
            symbol,
            entryTime: pos.entryTime,
            exitTime: time,
            entryPrice: pos.entryPrice,
            exitPrice,
            holdingHours,
            pnlPct: pnlPct * 100,
            pnlWithLeverage: pnlWithLeverage * 100,
            pnlUsd: netPnl,
            exitReason: exitSignal.reason,
            leverage,
          });
          
          monthlyPnL[monthKey] = (monthlyPnL[monthKey] || 0) + netPnl;
          delete positions[symbol];
        }
      } else if (isTradingDay) {
        const activePositions = Object.keys(positions).length;
        if (activePositions >= CONFIG.MAX_POSITIONS) continue;
        
        const entrySignal = checkEntrySignal(symbolCandles, btcCandlesNow);
        
        if (entrySignal) {
          const availableCapital = capital - Object.values(positions).reduce((s, p) => s + p.capitalUsed, 0);
          const positionSize = Math.min(availableCapital * CONFIG.POSITION_SIZE_PCT, availableCapital);
          
          if (positionSize >= 50) {
            const entryPrice = currentPrice * (1 + CONFIG.SLIPPAGE);
            const entryFee = positionSize * CONFIG.ENTRY_FEE;
            
            positions[symbol] = {
              entryPrice,
              entryTime: time,
              capitalUsed: positionSize - entryFee,
              highWaterMark: entryPrice,
            };
          }
        }
      }
    }
  }
  
  // Close remaining
  for (const symbol of Object.keys(positions)) {
    const pos = positions[symbol];
    const lastCandle = allCandles[symbol][allCandles[symbol].length - 1];
    const exitPrice = lastCandle.close;
    const pnlPct = (exitPrice - pos.entryPrice) / pos.entryPrice;
    const leverage = CONFIG.LEVERAGE[symbol];
    const pnlUsd = pos.capitalUsed * pnlPct * leverage;
    
    trades.push({
      symbol,
      entryTime: pos.entryTime,
      exitTime: endTime,
      entryPrice: pos.entryPrice,
      exitPrice,
      holdingHours: (endTime - pos.entryTime) / (60 * 60 * 1000),
      pnlPct: pnlPct * 100,
      pnlWithLeverage: pnlPct * leverage * 100,
      pnlUsd,
      exitReason: 'end',
      leverage,
    });
    capital += pnlUsd;
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════════════════
  
  console.log('═'.repeat(80));
  console.log('📊 RÉSULTATS - 6 MOIS AVEC 4 AGENTS V5');
  console.log('═'.repeat(80));
  
  // Per-symbol
  console.log('\n┌────────────┬────────┬──────────┬───────────┬───────────┬──────────────┐');
  console.log('│ Symbol     │ Trades │ Win Rate │  Avg P&L  │ Total P&L │ Avg Hold (h) │');
  console.log('├────────────┼────────┼──────────┼───────────┼───────────┼──────────────┤');
  
  for (const symbol of CONFIG.SYMBOLS) {
    const st = trades.filter(t => t.symbol === symbol);
    const wins = st.filter(t => t.pnlUsd > 0).length;
    const avgPnL = st.length > 0 ? st.reduce((s, t) => s + t.pnlWithLeverage, 0) / st.length : 0;
    const totalPnL = st.reduce((s, t) => s + t.pnlUsd, 0);
    const avgHold = st.length > 0 ? st.reduce((s, t) => s + t.holdingHours, 0) / st.length : 0;
    const wr = st.length > 0 ? (wins / st.length * 100) : 0;
    
    console.log(`│ ${symbol.padEnd(10)} │ ${String(st.length).padStart(6)} │ ${wr.toFixed(1).padStart(7)}% │ ${avgPnL >= 0 ? '+' : ''}${avgPnL.toFixed(2).padStart(8)}% │ ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0).padStart(6)} │ ${avgHold.toFixed(1).padStart(12)} │`);
  }
  
  console.log('├────────────┼────────┼──────────┼───────────┼───────────┼──────────────┤');
  
  const totalTrades = trades.length;
  const totalWins = trades.filter(t => t.pnlUsd > 0).length;
  const overallWR = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;
  const overallAvgPnL = totalTrades > 0 ? trades.reduce((s, t) => s + t.pnlWithLeverage, 0) / totalTrades : 0;
  const totalPnLUsd = capital - CONFIG.INITIAL_CAPITAL;
  const avgHoldAll = totalTrades > 0 ? trades.reduce((s, t) => s + t.holdingHours, 0) / totalTrades : 0;
  
  console.log(`│ ${'TOTAL'.padEnd(10)} │ ${String(totalTrades).padStart(6)} │ ${overallWR.toFixed(1).padStart(7)}% │ ${overallAvgPnL >= 0 ? '+' : ''}${overallAvgPnL.toFixed(2).padStart(8)}% │ ${totalPnLUsd >= 0 ? '+' : ''}$${totalPnLUsd.toFixed(0).padStart(6)} │ ${avgHoldAll.toFixed(1).padStart(12)} │`);
  console.log('└────────────┴────────┴──────────┴───────────┴───────────┴──────────────┘');
  
  // Monthly breakdown
  console.log('\n📅 P&L par mois:');
  const months = Object.keys(monthlyPnL).sort();
  let positiveMonths = 0, negativeMonths = 0;
  
  for (const month of months) {
    const pnl = monthlyPnL[month];
    const tradesThisMonth = trades.filter(t => {
      const d = new Date(t.exitTime);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}` === month;
    });
    
    if (pnl > 0) positiveMonths++;
    else if (pnl < 0) negativeMonths++;
    
    console.log(`   ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2).padStart(8)} (${tradesThisMonth.length} trades)`);
  }
  
  // Exit reasons
  console.log('\n📊 Exit Reasons:');
  const exitReasons = {};
  trades.forEach(t => {
    exitReasons[t.exitReason] = exitReasons[t.exitReason] || { count: 0, pnl: 0 };
    exitReasons[t.exitReason].count++;
    exitReasons[t.exitReason].pnl += t.pnlUsd;
  });
  
  for (const [reason, data] of Object.entries(exitReasons).sort((a, b) => b[1].count - a[1].count)) {
    const rt = trades.filter(t => t.exitReason === reason);
    const avgPnL = rt.reduce((s, t) => s + t.pnlWithLeverage, 0) / rt.length;
    const wr = rt.filter(t => t.pnlUsd > 0).length / rt.length * 100;
    console.log(`   ${reason.padEnd(20)}: ${String(data.count).padStart(3)} trades | WR ${wr.toFixed(0)}% | Avg: ${avgPnL >= 0 ? '+' : ''}${avgPnL.toFixed(2)}%`);
  }
  
  // Final summary
  const roi = ((capital - CONFIG.INITIAL_CAPITAL) / CONFIG.INITIAL_CAPITAL) * 100;
  const monthsSimulated = months.length;
  const avgMonthlyROI = roi / monthsSimulated;
  const tradesPerMonth = totalTrades / monthsSimulated;
  const tradesPerWeek = tradesPerMonth / 4;
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 📊 SIMULATION V5 - 4 AGENTS - ${monthsSimulated} MOIS                                        ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ 💵 Capital Initial:  $${CONFIG.INITIAL_CAPITAL.toFixed(0).padStart(10)}                                          ║
║ 💰 Capital Final:    $${capital.toFixed(0).padStart(10)}                                          ║
║ 📈 ROI Total:        ${roi >= 0 ? '+' : ''}${roi.toFixed(1).padStart(10)}%                                          ║
║ 📈 ROI Mensuel Avg:  ${avgMonthlyROI >= 0 ? '+' : ''}${avgMonthlyROI.toFixed(1).padStart(10)}%                                          ║
║                                                                               ║
║ 📊 ACTIVITÉ:                                                                  ║
║ - Total trades:      ${String(totalTrades).padStart(10)}                                          ║
║ - Trades/mois:       ${tradesPerMonth.toFixed(1).padStart(10)}                                          ║
║ - Trades/semaine:    ${tradesPerWeek.toFixed(1).padStart(10)}                                          ║
║ - Win Rate:          ${overallWR.toFixed(1).padStart(10)}%                                          ║
║ - Avg Hold Time:     ${avgHoldAll.toFixed(1).padStart(10)}h                                          ║
║                                                                               ║
║ 📅 MOIS:                                                                      ║
║ - Mois positifs:     ${String(positiveMonths).padStart(10)}                                          ║
║ - Mois négatifs:     ${String(negativeMonths).padStart(10)}                                          ║
║ - % mois gagnants:   ${(positiveMonths/(positiveMonths+negativeMonths)*100).toFixed(0).padStart(10)}%                                          ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
  
  // Projection
  const annualProjected = ((1 + avgMonthlyROI/100) ** 12 - 1) * 100;
  console.log('🔮 PROJECTION ANNUELLE:');
  console.log(`   - ROI mensuel moyen: ${avgMonthlyROI >= 0 ? '+' : ''}${avgMonthlyROI.toFixed(2)}%`);
  console.log(`   - ROI annuel projeté: ${annualProjected >= 0 ? '+' : ''}${annualProjected.toFixed(1)}%`);
  console.log(`   - $1000 → $${(1000 * (1 + annualProjected/100)).toFixed(0)} en 1 an`);
  
  process.exit(0);
}

runSimulation().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
