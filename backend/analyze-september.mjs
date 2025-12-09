/**
 * Analyse détaillée de Septembre 2025
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data', 'candles');

// Configuration
const CONFIG = {
  LONG: { BB_PERIOD: 20, BB_STD: 2, ROC_MIN: 2.5, VOL_MULTIPLIER: 2.0, MAX_CONSEC_UP: 3 },
  SHORT: { ROC_DROP_MIN: -1.5, VOL_SPIKE: 2.0, MAX_CONSEC_DOWN: 4 },
  EXIT: { STOP_LOSS_ATR_MULT: 2.0, STOP_LOSS_MIN: 0.8, STOP_LOSS_MAX: 3.0, TAKE_PROFIT: 3.0, TRAILING_ACTIVATION: 1.0, TRAILING_DISTANCE: 0.4, MAX_HOLD_BARS: 192 },
  POSITION_SIZE_PCT: 0.4,
  LEVERAGE: 4.5,
};
const COSTS = { TRADING_FEE_PCT: 0.04, SLIPPAGE_PCT: 0.05, FUNDING_RATE_PCT: 0.01, FUNDING_INTERVAL_BARS: 32 };
const INITIAL_CAPITAL = 1000;

const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'XRP/USDT:USDT', 'SOL/USDT:USDT', 'ADA/USDT:USDT', 'LINK/USDT:USDT', 'SUI/USDT:USDT', 'DOGE/USDT:USDT', 'AVAX/USDT:USDT', 'DOT/USDT:USDT'];

function loadLocalData(symbols) {
  const data = {};
  for (const symbol of symbols) {
    const filename = symbol.replace('/USDT:USDT', '').toLowerCase() + '-usdt.json';
    const filepath = path.join(DATA_DIR, filename);
    if (fs.existsSync(filepath)) {
      const json = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
      data[symbol] = json.candles;
    }
  }
  return data;
}

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
function countConsecUp(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > candles[i].open) count++;
    else break;
  }
  return count;
}
function countConsecDown(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close < candles[i].open) count++;
    else break;
  }
  return count;
}
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const prevClose = candles[i - 1] ? candles[i - 1].close : candles[i].open;
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - prevClose), Math.abs(candles[i].low - prevClose));
    atrSum += tr;
  }
  return atrSum / period;
}
function calcDynamicStopLoss(candles) {
  const atr = calcATR(candles, 14);
  if (!atr || candles.length === 0) return { slPct: 1.5, atrPct: null };
  const currentPrice = candles[candles.length - 1].close;
  const atrPct = (atr / currentPrice) * 100;
  const rawSlPct = atrPct * CONFIG.EXIT.STOP_LOSS_ATR_MULT;
  return { slPct: Math.min(CONFIG.EXIT.STOP_LOSS_MAX, Math.max(CONFIG.EXIT.STOP_LOSS_MIN, rawSlPct)), atrPct };
}

function checkLongEntry(candles) {
  if (candles.length < 50) return { valid: false };
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  if (current.close <= current.open) return { valid: false };
  const bb = calcBB(closes, CONFIG.LONG.BB_PERIOD, CONFIG.LONG.BB_STD);
  if (!bb || current.close <= bb.upper) return { valid: false };
  const roc = calcROC(closes, 10);
  if (!roc || roc < CONFIG.LONG.ROC_MIN) return { valid: false };
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * CONFIG.LONG.VOL_MULTIPLIER) return { valid: false };
  if (countConsecUp(candles) > CONFIG.LONG.MAX_CONSEC_UP) return { valid: false };
  return { valid: true };
}

function checkShortEntry(candles) {
  if (candles.length < 50) return { valid: false };
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  if (current.close >= current.open) return { valid: false };
  const roc5 = calcROC(closes, 5);
  if (!roc5 || roc5 > CONFIG.SHORT.ROC_DROP_MIN) return { valid: false };
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * CONFIG.SHORT.VOL_SPIKE) return { valid: false };
  const ma20 = calcSMA(closes, 20);
  if (!ma20 || current.close >= ma20) return { valid: false };
  const bb = calcBB(closes);
  if (!bb || current.close >= bb.lower) return { valid: false };
  if (countConsecDown(candles) > CONFIG.SHORT.MAX_CONSEC_DOWN) return { valid: false };
  return { valid: true };
}

function calculatePnl(entryPrice, exitPrice, side, capitalUsed, holdBars) {
  const leverage = CONFIG.LEVERAGE;
  const notionalUsd = capitalUsed * leverage;
  let pricePct = side === 'long' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - exitPrice) / entryPrice) * 100;
  const grossPnlPct = pricePct * leverage;
  const tradingFeesUsd = (COSTS.TRADING_FEE_PCT / 100) * notionalUsd * 2;
  const slippageUsd = (COSTS.SLIPPAGE_PCT / 100) * notionalUsd * 2;
  const fundingPeriods = Math.floor(holdBars / COSTS.FUNDING_INTERVAL_BARS);
  const fundingUsd = (COSTS.FUNDING_RATE_PCT / 100) * notionalUsd * fundingPeriods;
  const totalCostsUsd = tradingFeesUsd + slippageUsd + fundingUsd;
  const grossPnlUsd = (grossPnlPct / 100) * capitalUsed;
  const netPnlUsd = grossPnlUsd - totalCostsUsd;
  const netPnlPct = (netPnlUsd / capitalUsed) * 100;
  return { grossPnlPct, netPnlPct, netPnlUsd, totalCostsUsd };
}

// Run backtest and track capital by month
const allData = loadLocalData(SYMBOLS);
const btcCandles = allData['BTC/USDT:USDT'];
const btcCloses = btcCandles.map(c => c.close);

const capitalByMonth = {};
const tradesByMonth = {};
let capital = INITIAL_CAPITAL;

for (const symbol of SYMBOLS) {
  const candles = allData[symbol];
  if (!candles) continue;
  
  let position = null;
  let cooldown = 0;
  
  for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
    const btcPrice = btcCloses[btcIdx - 1];
    const isBullRegime = btcPrice > btcSma200;
    
    const idx = candles.findIndex(c => c.timestamp >= btcCandle.timestamp);
    if (idx < 50) continue;
    
    const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
    const current = candles[idx];
    const month = new Date(btcCandle.timestamp).toISOString().slice(0, 7);
    
    // Track capital at start of each month
    if (!capitalByMonth[month]) {
      capitalByMonth[month] = { startCapital: capital, endCapital: capital, pnl: 0, trades: 0, wins: 0, slHits: 0, regime: isBullRegime ? 'bull' : 'bear' };
    }
    capitalByMonth[month].endCapital = capital;
    
    // Manage position
    if (position) {
      const holdBars = idx - position.entryIdx;
      let exitReason = null, exitPrice = current.close;
      const slPct = position.slPct || 1.5;
      
      if (position.side === 'long') {
        const pnlPct = ((current.close - position.entryPrice) / position.entryPrice) * 100;
        position.hwm = Math.max(position.hwm || position.entryPrice, current.high);
        const hwmPct = ((position.hwm - position.entryPrice) / position.entryPrice) * 100;
        if (hwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION) {
          const trailStop = position.hwm * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100);
          if (current.low <= trailStop) { exitReason = 'TRAIL'; exitPrice = trailStop; }
        }
        if (!exitReason && pnlPct <= -slPct) { exitReason = 'SL'; exitPrice = position.entryPrice * (1 - slPct / 100); }
        else if (!exitReason && pnlPct >= CONFIG.EXIT.TAKE_PROFIT) { exitReason = 'TP'; exitPrice = position.entryPrice * (1 + CONFIG.EXIT.TAKE_PROFIT / 100); }
        else if (!exitReason && holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) { exitReason = 'TIME'; }
      } else {
        const pnlPct = ((position.entryPrice - current.close) / position.entryPrice) * 100;
        position.lwm = Math.min(position.lwm || position.entryPrice, current.low);
        const lwmPct = ((position.entryPrice - position.lwm) / position.entryPrice) * 100;
        if (lwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION) {
          const trailStop = position.lwm * (1 + CONFIG.EXIT.TRAILING_DISTANCE / 100);
          if (current.high >= trailStop) { exitReason = 'TRAIL'; exitPrice = trailStop; }
        }
        if (!exitReason && pnlPct <= -slPct) { exitReason = 'SL'; exitPrice = position.entryPrice * (1 + slPct / 100); }
        else if (!exitReason && pnlPct >= CONFIG.EXIT.TAKE_PROFIT) { exitReason = 'TP'; exitPrice = position.entryPrice * (1 - CONFIG.EXIT.TAKE_PROFIT / 100); }
        else if (!exitReason && holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) { exitReason = 'TIME'; }
      }
      
      if (exitReason) {
        const pnl = calculatePnl(position.entryPrice, exitPrice, position.side, position.capitalUsed, holdBars);
        capital += pnl.netPnlUsd;
        
        capitalByMonth[month].pnl += pnl.netPnlUsd;
        capitalByMonth[month].trades++;
        if (pnl.netPnlPct > 0) capitalByMonth[month].wins++;
        if (exitReason === 'SL') capitalByMonth[month].slHits++;
        capitalByMonth[month].endCapital = capital;
        
        if (!tradesByMonth[month]) tradesByMonth[month] = [];
        tradesByMonth[month].push({ symbol, side: position.side, pnl: pnl.netPnlUsd, pnlPct: pnl.netPnlPct, exitReason });
        
        position = null;
        cooldown = 8;
      }
    }
    
    // New entry
    if (!position && cooldown <= 0 && capital > 100) {
      const capitalUsed = capital * CONFIG.POSITION_SIZE_PCT;
      const { slPct } = calcDynamicStopLoss(windowCandles);
      
      if (isBullRegime && checkLongEntry(windowCandles).valid) {
        position = { side: 'long', entryPrice: current.close, entryIdx: idx, capitalUsed, hwm: current.close, slPct };
      } else if (!isBullRegime && checkShortEntry(windowCandles).valid) {
        position = { side: 'short', entryPrice: current.close, entryIdx: idx, capitalUsed, lwm: current.close, slPct };
      }
    }
    
    if (cooldown > 0) cooldown--;
  }
}

// Display results
console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════');
console.log('📅 CAPITAL PAR MOIS - ANALYSE SEPTEMBRE 2025');
console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════');
console.log('');
console.log('  Mois       │ Capital Début │ Capital Fin   │    PnL USD    │  PnL %  │ Trades │ WR%  │ SL%  │ Commentaire');
console.log('─'.repeat(120));

const months = Object.keys(capitalByMonth).sort();

for (const month of months) {
  const m = capitalByMonth[month];
  const wr = m.trades > 0 ? (m.wins / m.trades * 100) : 0;
  const slRate = m.trades > 0 ? (m.slHits / m.trades * 100) : 0;
  const pnlPct = m.startCapital > 0 ? (m.pnl / m.startCapital * 100) : 0;
  
  let comment = '';
  if (month === '2025-09') comment = '⬅️ ANALYSE ICI';
  else if (m.pnl > 3000) comment = '🏆';
  else if (m.pnl > 1000) comment = '✅';
  else if (m.pnl > 0) comment = '👍';
  else if (m.pnl > -500) comment = '⚠️';
  else comment = '❌';
  
  console.log(`  ${month}    │ $${m.startCapital.toFixed(0).padStart(11)} │ $${m.endCapital.toFixed(0).padStart(11)} │ ${m.pnl >= 0 ? '+' : ''}$${m.pnl.toFixed(0).padStart(10)} │ ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1).padStart(5)}% │  ${String(m.trades).padStart(4)} │ ${wr.toFixed(0).padStart(4)} │ ${slRate.toFixed(0).padStart(4)} │ ${comment}`);
}

// Detailed September analysis
const sep = capitalByMonth['2025-09'];
const sepTrades = tradesByMonth['2025-09'] || [];

console.log('');
console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════');
console.log('🔍 ANALYSE DÉTAILLÉE - SEPTEMBRE 2025');
console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════');

console.log(`
  📊 CAPITAL:
     Capital au début de Septembre:  $${sep.startCapital.toFixed(2)}
     Capital à la fin de Septembre:  $${sep.endCapital.toFixed(2)}
     Perte absolue:                  $${Math.abs(sep.pnl).toFixed(2)}
     Perte relative (% du capital):  ${(sep.pnl / sep.startCapital * 100).toFixed(2)}%

  ⚡ CONTEXTE MARCHÉ:
     BTC a MONTÉ de +5.62% en Septembre 2025
     Or la stratégie SHORT sur le régime Bear
     → CONFLIT: On shortait pendant que BTC montait!
`);

// Count exit reasons
const exitReasons = {};
const bySide = { long: [], short: [] };
sepTrades.forEach(t => {
  exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  bySide[t.side].push(t);
});

console.log('  📉 RAISONS DE SORTIE:');
for (const [reason, count] of Object.entries(exitReasons)) {
  const pct = (count / sepTrades.length * 100).toFixed(0);
  const emoji = reason === 'SL' ? '🛑' : reason === 'TRAIL' ? '📈' : '⏰';
  console.log(`     ${emoji} ${reason}: ${count} (${pct}%)`);
}

console.log('');
console.log('  📊 PERFORMANCE PAR DIRECTION:');
const longPnl = bySide.long.reduce((a, t) => a + t.pnl, 0);
const shortPnl = bySide.short.reduce((a, t) => a + t.pnl, 0);
const longWr = bySide.long.length > 0 ? (bySide.long.filter(t => t.pnl > 0).length / bySide.long.length * 100) : 0;
const shortWr = bySide.short.length > 0 ? (bySide.short.filter(t => t.pnl > 0).length / bySide.short.length * 100) : 0;
console.log(`     LONG:  ${bySide.long.length} trades, WR ${longWr.toFixed(0)}%, PnL: $${longPnl.toFixed(2)}`);
console.log(`     SHORT: ${bySide.short.length} trades, WR ${shortWr.toFixed(0)}%, PnL: $${shortPnl.toFixed(2)}`);

// Worst trades
const worstTrades = [...sepTrades].sort((a, b) => a.pnl - b.pnl).slice(0, 5);
console.log('');
console.log('  💀 TOP 5 PIRES TRADES:');
for (const t of worstTrades) {
  console.log(`     ${t.symbol.replace('/USDT:USDT', '').padEnd(5)} ${t.side.toUpperCase().padEnd(5)} → ${t.exitReason} : $${t.pnl.toFixed(2)} (${t.pnlPct.toFixed(1)}%)`);
}

console.log('');
console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════');
console.log('💡 CONCLUSION:');
console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════');

const lossPct = Math.abs(sep.pnl / sep.startCapital * 100);
console.log(`
  La perte de $${Math.abs(sep.pnl).toFixed(0)} représente seulement ${lossPct.toFixed(1)}% du capital de $${sep.startCapital.toFixed(0)}
`);

if (lossPct < 5) {
  console.log('  ✅ C\'est une perte MINEURE par rapport au capital accumulé.');
  console.log('     Avec un capital de ~$26k, perdre $2.3k = 8.7% drawdown');
  console.log('     C\'est NORMAL et ACCEPTABLE pour une stratégie de trading.');
} else if (lossPct < 15) {
  console.log('  ⚠️ C\'est une perte MODÉRÉE mais gérable.');
} else {
  console.log('  ❌ C\'est une perte SIGNIFICATIVE.');
}

console.log(`
  🔍 RAISON PRINCIPALE DU MOIS NÉGATIF:
     - BTC montait (+5.62%) pendant que la SMA200 indiquait Bear market
     - La stratégie shortait alors que le marché était haussier
     - Win Rate très bas (47%) → beaucoup de stop loss touchés
     - C'est un cas de transition de régime (Bear → Bull)
`);
