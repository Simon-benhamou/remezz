/**
 * ANALYSE V5 - Trading Days & Stop Loss Patterns
 * 
 * 1. Compare Lun-Ven vs Tous les jours
 * 2. Analyse des patterns qui mènent aux stop loss
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const BASE_CONFIG = {
  INITIAL_CAPITAL: 1000,
  POSITION_SIZE_PCT: 0.4,
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
  },
  
  EXIT: {
    STOP_LOSS_PCT: 1.5,
    TAKE_PROFIT_PCT: 3.0,
    TRAILING_ACTIVATION: 1.2,
    TRAILING_DISTANCE: 0.6,
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

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let atr = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    atr += tr;
  }
  return atr / period;
}

function countConsecutiveUp(candles, maxLookback = 10) {
  let count = 0;
  for (let i = candles.length - 1; i > Math.max(0, candles.length - maxLookback); i--) {
    if (candles[i].close > candles[i].open) count++;
    else break;
  }
  return count;
}

function countConsecutiveDown(candles, maxLookback = 10) {
  let count = 0;
  for (let i = candles.length - 1; i > Math.max(0, candles.length - maxLookback); i--) {
    if (candles[i].close < candles[i].open) count++;
    else break;
  }
  return count;
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL AVEC CONTEXT ENRICHI
// ═══════════════════════════════════════════════════════════════════════════

function checkEntrySignalWithContext(candles, btcCandles) {
  if (candles.length < 50 || btcCandles.length < 200) return null;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  // BTC > SMA200
  const btcCloses = btcCandles.map(c => c.close);
  const btcSma200 = calcSMA(btcCloses, 200);
  if (btcCloses[btcCloses.length - 1] < btcSma200) return null;
  
  // BB breakout
  const bb = calcBB(closes, 20, 2);
  if (current.close <= bb.upper) return null;
  
  // ROC > 1.5%
  const roc = calcROC(closes, 10);
  if (roc < 1.5) return null;
  
  // Volume > 1.3x
  const volMA = calcSMA(volumes, 20);
  const volRatio = current.volume / volMA;
  if (volRatio < 1.3) return null;
  
  // Max consec up
  const consecUp = countConsecutiveUp(candles);
  if (consecUp > 4) return null;
  
  // Context enrichi pour analyse
  const rsi = calcRSI(closes, 14);
  const atr = calcATR(candles, 14);
  const atrPct = (atr / current.close) * 100;
  const btcRoc = calcROC(btcCloses, 10);
  const distFromBB = ((current.close - bb.upper) / bb.upper) * 100;
  
  return {
    side: 'long',
    context: {
      roc,
      rsi,
      volRatio,
      consecUp,
      atrPct,
      btcRoc,
      distFromBB,
      dayOfWeek: new Date(current.timestamp).getUTCDay(),
      hour: new Date(current.timestamp).getUTCHours(),
    }
  };
}

function checkExitSignal(position, currentPrice, holdingHours) {
  const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  
  if (pnlPct <= -BASE_CONFIG.EXIT.STOP_LOSS_PCT) return { reason: 'stop_loss', pnlPct };
  if (pnlPct >= BASE_CONFIG.EXIT.TAKE_PROFIT_PCT) return { reason: 'take_profit', pnlPct };
  
  if (position.highWaterMark) {
    const hwmPct = ((position.highWaterMark - position.entryPrice) / position.entryPrice) * 100;
    if (hwmPct >= BASE_CONFIG.EXIT.TRAILING_ACTIVATION) {
      const trailingStop = position.highWaterMark * (1 - BASE_CONFIG.EXIT.TRAILING_DISTANCE / 100);
      if (currentPrice <= trailingStop) return { reason: 'trailing_stop', pnlPct };
    }
  }
  
  if (holdingHours >= BASE_CONFIG.EXIT.MAX_HOLD_HOURS) return { reason: 'max_hold', pnlPct };
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA FETCHING
// ═══════════════════════════════════════════════════════════════════════════

async function fetchExtendedData(symbol, months = 6) {
  const allCandles = [];
  const now = Date.now();
  const interval = 15 * 60 * 1000;
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
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      break;
    }
  }
  
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

async function runSimulation(allowedDays, label) {
  const positions = {};
  const trades = [];
  let capital = BASE_CONFIG.INITIAL_CAPITAL;
  
  const candleInterval = 15 * 60 * 1000;
  
  for (let time = startTime; time <= endTime; time += candleInterval) {
    const date = new Date(time);
    const dayOfWeek = date.getUTCDay();
    const isTradingDay = allowedDays.includes(dayOfWeek);
    
    for (const symbol of BASE_CONFIG.SYMBOLS) {
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
          const exitPrice = currentPrice * (1 - BASE_CONFIG.SLIPPAGE);
          const pnlPct = (exitPrice - pos.entryPrice) / pos.entryPrice;
          const leverage = BASE_CONFIG.LEVERAGE[symbol];
          const pnlWithLeverage = pnlPct * leverage;
          const pnlUsd = pos.capitalUsed * pnlWithLeverage;
          const exitFee = pos.capitalUsed * BASE_CONFIG.EXIT_FEE;
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
            entryContext: pos.entryContext,
            entryDayOfWeek: new Date(pos.entryTime).getUTCDay(),
          });
          
          delete positions[symbol];
        }
      } else if (isTradingDay) {
        const activePositions = Object.keys(positions).length;
        if (activePositions >= BASE_CONFIG.MAX_POSITIONS) continue;
        
        const entrySignal = checkEntrySignalWithContext(symbolCandles, btcCandlesNow);
        
        if (entrySignal) {
          const availableCapital = capital - Object.values(positions).reduce((s, p) => s + p.capitalUsed, 0);
          const positionSize = Math.min(availableCapital * BASE_CONFIG.POSITION_SIZE_PCT, availableCapital);
          
          if (positionSize >= 50) {
            const entryPrice = currentPrice * (1 + BASE_CONFIG.SLIPPAGE);
            const entryFee = positionSize * BASE_CONFIG.ENTRY_FEE;
            
            positions[symbol] = {
              entryPrice,
              entryTime: time,
              capitalUsed: positionSize - entryFee,
              highWaterMark: entryPrice,
              entryContext: entrySignal.context,
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
    const leverage = BASE_CONFIG.LEVERAGE[symbol];
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
      entryContext: pos.entryContext,
      entryDayOfWeek: new Date(pos.entryTime).getUTCDay(),
    });
    capital += pnlUsd;
  }
  
  return { trades, finalCapital: capital, label };
}

// ═══════════════════════════════════════════════════════════════════════════
// GLOBALS
// ═══════════════════════════════════════════════════════════════════════════

let allCandles = {};
let btcCandles = [];
let startTime = 0;
let endTime = 0;

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 ANALYSE V5 - Trading Days & Stop Loss Patterns');
  console.log('═'.repeat(80));
  
  console.log('\n📊 Fetching 6 months of data...\n');
  
  for (const symbol of BASE_CONFIG.SYMBOLS) {
    allCandles[symbol] = await fetchExtendedData(symbol, 6);
    console.log(`   ${symbol}: ${allCandles[symbol].length} candles`);
  }
  
  btcCandles = await fetchExtendedData('BTC/USDT', 7);
  console.log(`   BTC: ${btcCandles.length} candles`);
  
  startTime = Math.max(...BASE_CONFIG.SYMBOLS.map(s => allCandles[s][200]?.timestamp || 0));
  endTime = Math.min(...BASE_CONFIG.SYMBOLS.map(s => allCandles[s][allCandles[s].length-1]?.timestamp || Infinity));
  
  console.log(`\n🚀 Period: ${new Date(startTime).toISOString().split('T')[0]} to ${new Date(endTime).toISOString().split('T')[0]}\n`);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 1: Compare trading days
  // ═══════════════════════════════════════════════════════════════════════════
  
  console.log('═'.repeat(80));
  console.log('📅 TEST 1: COMPARAISON DES JOURS DE TRADING');
  console.log('═'.repeat(80));
  
  const scenarios = [
    { days: [1, 2, 3, 4, 5], label: 'Lun-Ven (weekdays)' },
    { days: [0, 1, 2, 3, 4, 5, 6], label: 'Tous les jours' },
    { days: [0, 6], label: 'Weekend seulement' },
    { days: [1, 2, 3], label: 'Lun-Mer' },
    { days: [3, 4, 5], label: 'Mer-Ven' },
  ];
  
  const results = [];
  
  for (const scenario of scenarios) {
    const result = await runSimulation(scenario.days, scenario.label);
    const roi = ((result.finalCapital - BASE_CONFIG.INITIAL_CAPITAL) / BASE_CONFIG.INITIAL_CAPITAL) * 100;
    const wins = result.trades.filter(t => t.pnlUsd > 0).length;
    const wr = result.trades.length > 0 ? (wins / result.trades.length * 100) : 0;
    
    results.push({
      label: scenario.label,
      trades: result.trades.length,
      wins,
      wr,
      roi,
      avgPnL: result.trades.length > 0 ? result.trades.reduce((s, t) => s + t.pnlWithLeverage, 0) / result.trades.length : 0,
      allTrades: result.trades,
    });
  }
  
  console.log('\n┌─────────────────────────┬────────┬──────────┬───────────┬───────────┐');
  console.log('│ Jours de Trading        │ Trades │ Win Rate │  Avg P&L  │    ROI    │');
  console.log('├─────────────────────────┼────────┼──────────┼───────────┼───────────┤');
  
  for (const r of results.sort((a, b) => b.roi - a.roi)) {
    console.log(`│ ${r.label.padEnd(23)} │ ${String(r.trades).padStart(6)} │ ${r.wr.toFixed(1).padStart(7)}% │ ${r.avgPnL >= 0 ? '+' : ''}${r.avgPnL.toFixed(2).padStart(8)}% │ ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1).padStart(8)}% │`);
  }
  console.log('└─────────────────────────┴────────┴──────────┴───────────┴───────────┘');
  
  // Analyse par jour
  const allDaysResult = results.find(r => r.label === 'Tous les jours');
  if (allDaysResult) {
    console.log('\n📊 Performance par jour de la semaine:');
    const dayNames = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
    
    for (let day = 0; day < 7; day++) {
      const dayTrades = allDaysResult.allTrades.filter(t => t.entryDayOfWeek === day);
      if (dayTrades.length === 0) continue;
      
      const wins = dayTrades.filter(t => t.pnlUsd > 0).length;
      const wr = (wins / dayTrades.length * 100);
      const avgPnL = dayTrades.reduce((s, t) => s + t.pnlWithLeverage, 0) / dayTrades.length;
      const totalPnL = dayTrades.reduce((s, t) => s + t.pnlUsd, 0);
      
      const bar = '█'.repeat(Math.round(Math.abs(avgPnL) * 2));
      const color = avgPnL >= 0 ? '🟢' : '🔴';
      
      console.log(`   ${dayNames[day]}: ${String(dayTrades.length).padStart(3)} trades | WR ${wr.toFixed(0).padStart(2)}% | Avg ${avgPnL >= 0 ? '+' : ''}${avgPnL.toFixed(2).padStart(6)}% | Total ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0).padStart(5)} ${color} ${bar}`);
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 2: Analyse des Stop Loss
  // ═══════════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('🔴 TEST 2: ANALYSE DES STOP LOSS - PATTERNS');
  console.log('═'.repeat(80));
  
  const bestResult = results.find(r => r.label === 'Tous les jours') || results[0];
  const stopLossTrades = bestResult.allTrades.filter(t => t.exitReason === 'stop_loss');
  const winningTrades = bestResult.allTrades.filter(t => t.pnlUsd > 0);
  
  console.log(`\n📊 Total Stop Loss: ${stopLossTrades.length} / ${bestResult.trades} trades (${(stopLossTrades.length / bestResult.trades * 100).toFixed(1)}%)`);
  
  // Analyse des contextes d'entrée pour les SL vs Winners
  if (stopLossTrades.length > 0 && winningTrades.length > 0) {
    
    const analyzeContext = (trades, label) => {
      const contexts = trades.map(t => t.entryContext).filter(c => c);
      if (contexts.length === 0) return null;
      
      return {
        label,
        count: trades.length,
        avgRoc: contexts.reduce((s, c) => s + c.roc, 0) / contexts.length,
        avgRsi: contexts.reduce((s, c) => s + c.rsi, 0) / contexts.length,
        avgVolRatio: contexts.reduce((s, c) => s + c.volRatio, 0) / contexts.length,
        avgConsecUp: contexts.reduce((s, c) => s + c.consecUp, 0) / contexts.length,
        avgAtrPct: contexts.reduce((s, c) => s + c.atrPct, 0) / contexts.length,
        avgBtcRoc: contexts.reduce((s, c) => s + c.btcRoc, 0) / contexts.length,
        avgDistFromBB: contexts.reduce((s, c) => s + c.distFromBB, 0) / contexts.length,
      };
    };
    
    const slContext = analyzeContext(stopLossTrades, 'Stop Loss');
    const winContext = analyzeContext(winningTrades, 'Winners');
    
    console.log('\n┌─────────────────┬──────────────┬──────────────┬────────────┐');
    console.log('│ Métrique        │  Stop Loss   │   Winners    │   Delta    │');
    console.log('├─────────────────┼──────────────┼──────────────┼────────────┤');
    
    if (slContext && winContext) {
      const metrics = [
        { name: 'ROC 10', sl: slContext.avgRoc, win: winContext.avgRoc, unit: '%' },
        { name: 'RSI 14', sl: slContext.avgRsi, win: winContext.avgRsi, unit: '' },
        { name: 'Volume Ratio', sl: slContext.avgVolRatio, win: winContext.avgVolRatio, unit: 'x' },
        { name: 'Consec Up', sl: slContext.avgConsecUp, win: winContext.avgConsecUp, unit: '' },
        { name: 'ATR %', sl: slContext.avgAtrPct, win: winContext.avgAtrPct, unit: '%' },
        { name: 'BTC ROC', sl: slContext.avgBtcRoc, win: winContext.avgBtcRoc, unit: '%' },
        { name: 'Dist from BB', sl: slContext.avgDistFromBB, win: winContext.avgDistFromBB, unit: '%' },
      ];
      
      for (const m of metrics) {
        const delta = m.win - m.sl;
        const deltaStr = delta >= 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
        console.log(`│ ${m.name.padEnd(15)} │ ${m.sl.toFixed(2).padStart(10)}${m.unit.padEnd(2)} │ ${m.win.toFixed(2).padStart(10)}${m.unit.padEnd(2)} │ ${deltaStr.padStart(10)} │`);
      }
    }
    
    console.log('└─────────────────┴──────────────┴──────────────┴────────────┘');
    
    // Patterns spécifiques
    console.log('\n🔍 PATTERNS IDENTIFIÉS:');
    
    // RSI élevé = plus de SL ?
    const highRsiSL = stopLossTrades.filter(t => t.entryContext?.rsi > 70).length;
    const highRsiWin = winningTrades.filter(t => t.entryContext?.rsi > 70).length;
    const highRsiTotal = highRsiSL + highRsiWin;
    if (highRsiTotal > 0) {
      const slRate = (highRsiSL / highRsiTotal * 100);
      console.log(`   RSI > 70 à l'entrée: ${highRsiSL}/${highRsiTotal} = ${slRate.toFixed(0)}% stop loss ${slRate > 50 ? '⚠️ ÉVITER' : '✅ OK'}`);
    }
    
    // ATR élevé = plus de SL ?
    const highAtrSL = stopLossTrades.filter(t => t.entryContext?.atrPct > 2).length;
    const highAtrWin = winningTrades.filter(t => t.entryContext?.atrPct > 2).length;
    const highAtrTotal = highAtrSL + highAtrWin;
    if (highAtrTotal > 0) {
      const slRate = (highAtrSL / highAtrTotal * 100);
      console.log(`   ATR > 2% à l'entrée: ${highAtrSL}/${highAtrTotal} = ${slRate.toFixed(0)}% stop loss ${slRate > 50 ? '⚠️ ÉVITER' : '✅ OK'}`);
    }
    
    // ROC très élevé = plus de SL ?
    const highRocSL = stopLossTrades.filter(t => t.entryContext?.roc > 3).length;
    const highRocWin = winningTrades.filter(t => t.entryContext?.roc > 3).length;
    const highRocTotal = highRocSL + highRocWin;
    if (highRocTotal > 0) {
      const slRate = (highRocSL / highRocTotal * 100);
      console.log(`   ROC > 3% à l'entrée: ${highRocSL}/${highRocTotal} = ${slRate.toFixed(0)}% stop loss ${slRate > 50 ? '⚠️ ÉVITER' : '✅ OK'}`);
    }
    
    // BTC momentum négatif
    const btcNegSL = stopLossTrades.filter(t => t.entryContext?.btcRoc < 0).length;
    const btcNegWin = winningTrades.filter(t => t.entryContext?.btcRoc < 0).length;
    const btcNegTotal = btcNegSL + btcNegWin;
    if (btcNegTotal > 0) {
      const slRate = (btcNegSL / btcNegTotal * 100);
      console.log(`   BTC ROC < 0 à l'entrée: ${btcNegSL}/${btcNegTotal} = ${slRate.toFixed(0)}% stop loss ${slRate > 50 ? '⚠️ ÉVITER' : '✅ OK'}`);
    }
    
    // Consec up >= 3
    const highConsecSL = stopLossTrades.filter(t => t.entryContext?.consecUp >= 3).length;
    const highConsecWin = winningTrades.filter(t => t.entryContext?.consecUp >= 3).length;
    const highConsecTotal = highConsecSL + highConsecWin;
    if (highConsecTotal > 0) {
      const slRate = (highConsecSL / highConsecTotal * 100);
      console.log(`   ConsecUp >= 3: ${highConsecSL}/${highConsecTotal} = ${slRate.toFixed(0)}% stop loss ${slRate > 50 ? '⚠️ ÉVITER' : '✅ OK'}`);
    }
    
    // Volume très élevé
    const highVolSL = stopLossTrades.filter(t => t.entryContext?.volRatio > 2).length;
    const highVolWin = winningTrades.filter(t => t.entryContext?.volRatio > 2).length;
    const highVolTotal = highVolSL + highVolWin;
    if (highVolTotal > 0) {
      const slRate = (highVolSL / highVolTotal * 100);
      console.log(`   Volume > 2x: ${highVolSL}/${highVolTotal} = ${slRate.toFixed(0)}% stop loss ${slRate > 50 ? '⚠️ ÉVITER' : '✅ OK'}`);
    }
    
    // Analyse par jour
    console.log('\n📅 Stop Loss par jour:');
    const dayNames = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
    for (let day = 0; day < 7; day++) {
      const daySL = stopLossTrades.filter(t => t.entryDayOfWeek === day).length;
      const dayTotal = bestResult.allTrades.filter(t => t.entryDayOfWeek === day).length;
      if (dayTotal > 0) {
        const rate = (daySL / dayTotal * 100);
        const bar = '█'.repeat(Math.round(rate / 5));
        console.log(`   ${dayNames[day]}: ${daySL.toString().padStart(3)}/${dayTotal.toString().padStart(3)} = ${rate.toFixed(0).padStart(2)}% SL ${bar}`);
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // RECOMMENDATIONS
  // ═══════════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('💡 RECOMMANDATIONS');
  console.log('═'.repeat(80));
  
  const bestDays = results.sort((a, b) => b.roi - a.roi)[0];
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 📊 RÉSULTATS DE L'ANALYSE                                                     ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ 📅 MEILLEURS JOURS: ${bestDays.label.padEnd(20)} (ROI: ${bestDays.roi >= 0 ? '+' : ''}${bestDays.roi.toFixed(1)}%)                ║
║                                                                               ║
║ 🔴 FILTRES ANTI-STOP LOSS À CONSIDÉRER:                                       ║
║    - Éviter si RSI > 70 (surachat)                                            ║
║    - Éviter si ATR > 2% (trop volatile)                                       ║
║    - Éviter si ROC > 3% (extension extrême)                                   ║
║    - Éviter si BTC ROC < 0 (contexte baissier)                                ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
  
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
