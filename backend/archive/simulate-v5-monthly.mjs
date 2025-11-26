/**
 * SIMULATION V5 - 4 Agents sur 1 Mois
 * 
 * Simule le fonctionnement réel avec:
 * - 4 agents: SEI, XRP, ETH, IMX
 * - Capital Pool partagé ($1000)
 * - 50% du capital par position
 * - Max 4 positions simultanées
 * - Stratégie V5: BB breakout + ROC + Volume + BTC>SMA200
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION V5 (exactement comme momentumSimple.ts)
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Capital
  INITIAL_CAPITAL: 1000,
  POSITION_SIZE_PCT: 0.5,  // 50% par position
  MAX_POSITIONS: 4,
  
  // Symbols V5 compatibles
  SYMBOLS: ['SEI/USDT', 'XRP/USDT', 'ETH/USDT', 'IMX/USDT'],
  
  // Leverage par asset
  LEVERAGE: {
    'SEI/USDT': 5,
    'XRP/USDT': 4,
    'ETH/USDT': 5,
    'IMX/USDT': 5,
  },
  
  // Entry V5
  ENTRY: {
    BB_PERIOD: 20,
    BB_STD: 2.0,
    ROC_PERIOD: 10,
    ROC_MIN: 1.5,           // 1.5%
    VOLUME_MULT: 1.3,
    MAX_CONSEC_UP: 4,
    BTC_SMA200_FILTER: true,
    DIRECTION: 'long',      // LONG ONLY
    ALLOWED_DAYS: [1, 2, 3, 4, 5],  // Lun-Ven
  },
  
  // Exit V5
  EXIT: {
    STOP_LOSS_PCT: 2.0,
    TAKE_PROFIT_PCT: 2.5,
    TRAILING_ACTIVATION: 1.5,
    TRAILING_DISTANCE: 0.8,
    MAX_HOLD_HOURS: 48,
  },
  
  // Fees
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
  return {
    upper: sma + std * stdMult,
    middle: sma,
    lower: sma - std * stdMult,
  };
}

function calcROC(closes, period = 10) {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  return ((current - past) / past) * 100;
}

function calcVolumeMA(volumes, period = 20) {
  return calcSMA(volumes, period);
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
  
  // 1. BTC > SMA200 (regime filter)
  const btcCloses = btcCandles.map(c => c.close);
  const btcSma200 = calcSMA(btcCloses, 200);
  const btcNow = btcCloses[btcCloses.length - 1];
  if (btcNow < btcSma200) return null;
  
  // 2. Bollinger Breakout
  const bb = calcBB(closes, CONFIG.ENTRY.BB_PERIOD, CONFIG.ENTRY.BB_STD);
  if (current.close <= bb.upper) return null;
  
  // 3. ROC > 1.5%
  const roc = calcROC(closes, CONFIG.ENTRY.ROC_PERIOD);
  if (roc < CONFIG.ENTRY.ROC_MIN) return null;
  
  // 4. Volume > 1.3x average
  const volMA = calcVolumeMA(volumes, 20);
  if (current.volume < volMA * CONFIG.ENTRY.VOLUME_MULT) return null;
  
  // 5. Not too many consecutive up candles
  const consecUp = countConsecutiveUp(candles);
  if (consecUp > CONFIG.ENTRY.MAX_CONSEC_UP) return null;
  
  return {
    side: 'long',
    reason: `BB breakout + ROC ${roc.toFixed(1)}% + Vol ${(current.volume/volMA).toFixed(1)}x`,
  };
}

function checkExitSignal(position, currentPrice, candles, holdingHours) {
  const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  
  // Stop Loss
  if (pnlPct <= -CONFIG.EXIT.STOP_LOSS_PCT) {
    return { reason: 'stop_loss', exitPrice: currentPrice };
  }
  
  // Take Profit
  if (pnlPct >= CONFIG.EXIT.TAKE_PROFIT_PCT) {
    return { reason: 'take_profit', exitPrice: currentPrice };
  }
  
  // Trailing Stop (activé à +1.5%)
  if (position.highWaterMark) {
    const hwmPct = ((position.highWaterMark - position.entryPrice) / position.entryPrice) * 100;
    if (hwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION) {
      const trailingStop = position.highWaterMark * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100);
      if (currentPrice <= trailingStop) {
        return { reason: 'trailing_stop', exitPrice: currentPrice };
      }
    }
  }
  
  // Max Hold Time
  if (holdingHours >= CONFIG.EXIT.MAX_HOLD_HOURS) {
    return { reason: 'max_hold_48h', exitPrice: currentPrice };
  }
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CAPITAL POOL (simulation)
// ═══════════════════════════════════════════════════════════════════════════

class CapitalPool {
  constructor(initialCapital) {
    this.totalCapital = initialCapital;
    this.reserved = new Map();
    this.inPosition = new Map();
  }
  
  getAvailable() {
    let used = 0;
    for (const amt of this.reserved.values()) used += amt;
    for (const amt of this.inPosition.values()) used += amt;
    return this.totalCapital - used;
  }
  
  reserve(symbol, amount) {
    if (amount > this.getAvailable()) return false;
    this.reserved.set(symbol, (this.reserved.get(symbol) || 0) + amount);
    return true;
  }
  
  confirmPosition(symbol, amount) {
    const reserved = this.reserved.get(symbol) || 0;
    this.reserved.set(symbol, Math.max(0, reserved - amount));
    this.inPosition.set(symbol, (this.inPosition.get(symbol) || 0) + amount);
  }
  
  releasePosition(symbol, pnl) {
    const inPos = this.inPosition.get(symbol) || 0;
    this.inPosition.set(symbol, 0);
    this.totalCapital += pnl;
  }
  
  getStatus() {
    return {
      total: this.totalCapital,
      available: this.getAvailable(),
      reserved: Object.fromEntries(this.reserved),
      inPosition: Object.fromEntries(this.inPosition),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SIMULATION
// ═══════════════════════════════════════════════════════════════════════════

async function runMonthlySimulation() {
  console.log('═'.repeat(80));
  console.log('🎯 SIMULATION V5 - 4 Agents sur 1 Mois');
  console.log('═'.repeat(80));
  
  // Fetch 1 month of 15m data (environ 2880 candles)
  const now = Date.now();
  const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;
  
  console.log('\n📊 Fetching data (30 days, 15m candles)...\n');
  
  const allCandles = {};
  for (const symbol of CONFIG.SYMBOLS) {
    const binanceSymbol = symbol.replace('/', '');
    try {
      const ohlcv = await exchange.fetchOHLCV(binanceSymbol, '15m', oneMonthAgo, 3000);
      allCandles[symbol] = ohlcv.map(c => ({
        timestamp: c[0],
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5],
      }));
      console.log(`   ${symbol}: ${allCandles[symbol].length} candles`);
    } catch (err) {
      console.log(`   ${symbol}: ERROR - ${err.message}`);
      allCandles[symbol] = [];
    }
  }
  
  // Fetch BTC for regime filter
  const btcOhlcv = await exchange.fetchOHLCV('BTCUSDT', '15m', oneMonthAgo - 7*24*60*60*1000, 3500);
  const btcCandles = btcOhlcv.map(c => ({
    timestamp: c[0],
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5],
  }));
  console.log(`   BTC: ${btcCandles.length} candles (for SMA200 filter)`);
  
  // Initialize
  const capitalPool = new CapitalPool(CONFIG.INITIAL_CAPITAL);
  const positions = {}; // symbol -> position
  const trades = [];
  const dailyPnL = {};
  
  // Find common time range
  const startTime = Math.max(...CONFIG.SYMBOLS.map(s => allCandles[s][0]?.timestamp || 0));
  const endTime = Math.min(...CONFIG.SYMBOLS.map(s => allCandles[s][allCandles[s].length-1]?.timestamp || Infinity));
  
  console.log('\n🚀 Running simulation...\n');
  
  // Process each 15m candle
  let candleIdx = 0;
  const candleInterval = 15 * 60 * 1000; // 15 minutes
  
  for (let time = startTime; time <= endTime; time += candleInterval) {
    candleIdx++;
    const date = new Date(time);
    const dayKey = date.toISOString().split('T')[0];
    const dayOfWeek = date.getUTCDay();
    const isTradingDay = CONFIG.ENTRY.ALLOWED_DAYS.includes(dayOfWeek);
    
    // Get candles up to this point for each symbol
    for (const symbol of CONFIG.SYMBOLS) {
      const symbolCandles = allCandles[symbol].filter(c => c.timestamp <= time);
      if (symbolCandles.length < 50) continue;
      
      const btcCandlesNow = btcCandles.filter(c => c.timestamp <= time);
      const currentCandle = symbolCandles[symbolCandles.length - 1];
      const currentPrice = currentCandle.close;
      
      // Check existing position
      if (positions[symbol]) {
        const pos = positions[symbol];
        pos.highWaterMark = Math.max(pos.highWaterMark || pos.entryPrice, currentCandle.high);
        
        const holdingHours = (time - pos.entryTime) / (60 * 60 * 1000);
        const exitSignal = checkExitSignal(pos, currentPrice, symbolCandles, holdingHours);
        
        if (exitSignal) {
          // EXIT
          const exitPrice = exitSignal.exitPrice * (1 - CONFIG.SLIPPAGE);
          const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice);
          const leverage = CONFIG.LEVERAGE[symbol];
          const pnlWithLeverage = pnlPct * leverage;
          const pnlUsd = pos.capitalUsed * pnlWithLeverage;
          const exitFee = pos.capitalUsed * CONFIG.EXIT_FEE;
          const netPnl = pnlUsd - exitFee;
          
          capitalPool.releasePosition(symbol, netPnl);
          
          trades.push({
            symbol,
            side: 'long',
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
          
          // Track daily P&L
          dailyPnL[dayKey] = (dailyPnL[dayKey] || 0) + netPnl;
          
          delete positions[symbol];
        }
      } else if (isTradingDay) {
        // Check entry
        const entrySignal = checkEntrySignal(symbolCandles, btcCandlesNow);
        
        if (entrySignal) {
          const available = capitalPool.getAvailable();
          const positionSize = Math.min(available * CONFIG.POSITION_SIZE_PCT, available);
          
          if (positionSize >= 50) { // Min $50 position
            const entryPrice = currentPrice * (1 + CONFIG.SLIPPAGE);
            const entryFee = positionSize * CONFIG.ENTRY_FEE;
            
            if (capitalPool.reserve(symbol, positionSize)) {
              capitalPool.confirmPosition(symbol, positionSize);
              
              positions[symbol] = {
                side: 'long',
                entryPrice,
                entryTime: time,
                capitalUsed: positionSize - entryFee,
                highWaterMark: entryPrice,
                reason: entrySignal.reason,
              };
            }
          }
        }
      }
    }
  }
  
  // Close remaining positions at end
  for (const symbol of Object.keys(positions)) {
    const pos = positions[symbol];
    const lastCandle = allCandles[symbol][allCandles[symbol].length - 1];
    const exitPrice = lastCandle.close;
    const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice);
    const leverage = CONFIG.LEVERAGE[symbol];
    const pnlWithLeverage = pnlPct * leverage;
    const pnlUsd = pos.capitalUsed * pnlWithLeverage;
    
    trades.push({
      symbol,
      side: 'long',
      entryTime: pos.entryTime,
      exitTime: endTime,
      entryPrice: pos.entryPrice,
      exitPrice,
      holdingHours: (endTime - pos.entryTime) / (60 * 60 * 1000),
      pnlPct: pnlPct * 100,
      pnlWithLeverage: pnlWithLeverage * 100,
      pnlUsd,
      exitReason: 'end_of_simulation',
      leverage,
    });
    
    capitalPool.releasePosition(symbol, pnlUsd);
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS - 1 MOIS AVEC 4 AGENTS V5');
  console.log('═'.repeat(80));
  
  // Per-symbol breakdown
  console.log('\n┌────────────┬────────┬──────────┬───────────┬───────────┬──────────────┐');
  console.log('│ Symbol     │ Trades │ Win Rate │  Avg P&L  │ Total P&L │ Avg Hold (h) │');
  console.log('├────────────┼────────┼──────────┼───────────┼───────────┼──────────────┤');
  
  for (const symbol of CONFIG.SYMBOLS) {
    const symbolTrades = trades.filter(t => t.symbol === symbol);
    const wins = symbolTrades.filter(t => t.pnlUsd > 0).length;
    const avgPnL = symbolTrades.length > 0 ? symbolTrades.reduce((s, t) => s + t.pnlWithLeverage, 0) / symbolTrades.length : 0;
    const totalPnL = symbolTrades.reduce((s, t) => s + t.pnlUsd, 0);
    const avgHold = symbolTrades.length > 0 ? symbolTrades.reduce((s, t) => s + t.holdingHours, 0) / symbolTrades.length : 0;
    const wr = symbolTrades.length > 0 ? (wins / symbolTrades.length * 100) : 0;
    
    console.log(`│ ${symbol.padEnd(10)} │ ${String(symbolTrades.length).padStart(6)} │ ${wr.toFixed(1).padStart(7)}% │ ${avgPnL >= 0 ? '+' : ''}${avgPnL.toFixed(2).padStart(8)}% │ ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2).padStart(7)} │ ${avgHold.toFixed(1).padStart(12)} │`);
  }
  
  console.log('├────────────┼────────┼──────────┼───────────┼───────────┼──────────────┤');
  
  const totalTrades = trades.length;
  const totalWins = trades.filter(t => t.pnlUsd > 0).length;
  const overallWR = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;
  const overallAvgPnL = totalTrades > 0 ? trades.reduce((s, t) => s + t.pnlWithLeverage, 0) / totalTrades : 0;
  const totalPnLUsd = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const avgHoldAll = totalTrades > 0 ? trades.reduce((s, t) => s + t.holdingHours, 0) / totalTrades : 0;
  
  console.log(`│ ${'TOTAL'.padEnd(10)} │ ${String(totalTrades).padStart(6)} │ ${overallWR.toFixed(1).padStart(7)}% │ ${overallAvgPnL >= 0 ? '+' : ''}${overallAvgPnL.toFixed(2).padStart(8)}% │ ${totalPnLUsd >= 0 ? '+' : ''}$${totalPnLUsd.toFixed(2).padStart(7)} │ ${avgHoldAll.toFixed(1).padStart(12)} │`);
  console.log('└────────────┴────────┴──────────┴───────────┴───────────┴──────────────┘');
  
  // Exit reasons
  console.log('\n📊 Exit Reasons:');
  const exitReasons = {};
  trades.forEach(t => {
    exitReasons[t.exitReason] = exitReasons[t.exitReason] || { count: 0, pnl: 0 };
    exitReasons[t.exitReason].count++;
    exitReasons[t.exitReason].pnl += t.pnlUsd;
  });
  
  for (const [reason, data] of Object.entries(exitReasons).sort((a, b) => b[1].count - a[1].count)) {
    const tradesForReason = trades.filter(t => t.exitReason === reason);
    const avgPnL = tradesForReason.reduce((s, t) => s + t.pnlWithLeverage, 0) / tradesForReason.length;
    console.log(`   ${reason.padEnd(20)}: ${String(data.count).padStart(3)} trades | Avg: ${avgPnL >= 0 ? '+' : ''}${avgPnL.toFixed(2)}% | Total: ${data.pnl >= 0 ? '+' : ''}$${data.pnl.toFixed(2)}`);
  }
  
  // Daily P&L summary
  const dailyKeys = Object.keys(dailyPnL).sort();
  let positiveDays = 0, negativeDays = 0;
  
  console.log('\n📅 Daily P&L Summary:');
  for (const day of dailyKeys) {
    const pnl = dailyPnL[day];
    if (pnl > 0) positiveDays++;
    else if (pnl < 0) negativeDays++;
    console.log(`   ${day}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
  }
  
  // Trade list (last 10)
  console.log('\n📜 Derniers trades:');
  const recentTrades = trades.slice(-10);
  for (const t of recentTrades) {
    const entryDate = new Date(t.entryTime).toISOString().split('T')[0];
    const emoji = t.pnlUsd >= 0 ? '✅' : '❌';
    console.log(`   ${emoji} ${t.symbol.padEnd(10)} | ${entryDate} | ${t.holdingHours.toFixed(0)}h | ${t.pnlWithLeverage >= 0 ? '+' : ''}${t.pnlWithLeverage.toFixed(2)}% (${t.pnlUsd >= 0 ? '+' : ''}$${t.pnlUsd.toFixed(2)}) | ${t.exitReason}`);
  }
  
  // Final summary
  const finalCapital = capitalPool.totalCapital;
  const roi = ((finalCapital - CONFIG.INITIAL_CAPITAL) / CONFIG.INITIAL_CAPITAL) * 100;
  
  console.log('\n' + '═'.repeat(80));
  console.log('💰 RÉSUMÉ FINAL');
  console.log('═'.repeat(80));
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 📊 SIMULATION V5 - 4 AGENTS - 1 MOIS                                          ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ 💵 Capital Initial:  $${CONFIG.INITIAL_CAPITAL.toFixed(2).padStart(10)}                                          ║
║ 💰 Capital Final:    $${finalCapital.toFixed(2).padStart(10)}                                          ║
║ 📈 ROI:              ${roi >= 0 ? '+' : ''}${roi.toFixed(2).padStart(10)}%                                          ║
║                                                                               ║
║ 📊 STATISTIQUES:                                                              ║
║ - Nombre de trades:  ${String(totalTrades).padStart(10)}                                          ║
║ - Trades/semaine:    ${(totalTrades / 4).toFixed(1).padStart(10)}                                          ║
║ - Win Rate:          ${overallWR.toFixed(1).padStart(10)}%                                          ║
║ - Avg P&L/trade:     ${overallAvgPnL >= 0 ? '+' : ''}${overallAvgPnL.toFixed(2).padStart(9)}%                                          ║
║ - Avg Hold Time:     ${avgHoldAll.toFixed(1).padStart(10)}h                                          ║
║                                                                               ║
║ 📅 JOURS:                                                                     ║
║ - Jours positifs:    ${String(positiveDays).padStart(10)}                                          ║
║ - Jours négatifs:    ${String(negativeDays).padStart(10)}                                          ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
  
  // Projection annuelle
  const monthlyROI = roi;
  const annualProjected = ((1 + monthlyROI/100) ** 12 - 1) * 100;
  
  console.log('🔮 PROJECTION (si performance constante):');
  console.log(`   - ROI mensuel: ${monthlyROI >= 0 ? '+' : ''}${monthlyROI.toFixed(2)}%`);
  console.log(`   - ROI annuel projeté: ${annualProjected >= 0 ? '+' : ''}${annualProjected.toFixed(1)}%`);
  console.log(`   - $1000 → $${(CONFIG.INITIAL_CAPITAL * (1 + annualProjected/100)).toFixed(0)} en 1 an`);
  
  process.exit(0);
}

runMonthlySimulation().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
