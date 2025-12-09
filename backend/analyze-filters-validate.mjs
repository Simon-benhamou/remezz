/**
 * VALIDATION CROISÉE - Comparer mon backtest avec le vrai backtestService.ts
 * Le but est de vérifier que mes résultats sont cohérents avec la vraie stratégie
 */
import fs from 'fs';
import path from 'path';

const SYMBOLS = ['SOL/USDT:USDT', 'ETH/USDT:USDT', 'BTC/USDT:USDT', 'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'DOT/USDT:USDT', 'DOGE/USDT:USDT', 'XRP/USDT:USDT', 'ATOM/USDT:USDT'];

// CONFIG identique au backtestService.ts
const CONFIG = {
  LONG: {
    BB_PERIOD: 20,
    BB_STD: 2,
    ROC_MIN: 2.5,
    VOL_MULTIPLIER: 2.0,
    MAX_CONSEC_UP: 3,
  },
  EXIT: {
    STOP_LOSS_ATR_MULT: 3.0,
    STOP_LOSS_MIN: 1.0,
    STOP_LOSS_MAX: 4.5,
    TRAILING_ACTIVATION: 0.5,
    TRAILING_DISTANCE: 0.3,
  },
  COSTS: {
    TRADING_FEE_PCT: 0.04,
    SLIPPAGE_PCT: 0.05,
    FUNDING_RATE_PCT: 0.01,
    FUNDING_INTERVAL_BARS: 32,
  },
  DEFAULT_LEVERAGE: 4.5,
};

// Indicateurs
function calcSMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0 };
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - middle, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: middle + std * mult, middle, lower: middle - std * mult };
}

function calcROC(closes, period) {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - period - 1];
  return past > 0 ? ((current - past) / past) * 100 : 0;
}

function calcVolRatio(volumes) {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avg > 0 ? current / avg : 0;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1]?.close || candles[i].open;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrSum += tr;
  }
  return atrSum / period;
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

function countConsecUp(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > candles[i].open) count++;
    else break;
  }
  return count;
}

function isBtcBullRegime(btcCandles) {
  if (btcCandles.length < 200) return true;
  const closes = btcCandles.map(c => c.close);
  const sma200 = calcSMA(closes, 200);
  return closes[closes.length - 1] > sma200;
}

function calcBtcRoc4h(btcCandles) {
  if (btcCandles.length < 5) return 0;
  return calcROC(btcCandles.map(c => c.close), 4);
}

// Load data
const btcPath = path.join(process.cwd(), 'data', 'BTC_USDT_1h.json');
const btcCandles = JSON.parse(fs.readFileSync(btcPath, 'utf-8')).map(c => ({
  timestamp: c.timestamp || c.openTime,
  open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume
}));

console.log('╔════════════════════════════════════════════════════════════════════════════╗');
console.log('║              VALIDATION CROISÉE - Test de Fiabilité                       ║');
console.log('╚════════════════════════════════════════════════════════════════════════════╝\n');

// 1. Compter les signaux potentiels (breakouts BB)
let totalBreakouts = 0;
let bullRegimeBreakouts = 0;
let afterFiltersBreakouts = 0;
let filterReasons = { roc: 0, vol: 0, consec: 0, rsi: 0 };

for (const symbol of SYMBOLS) {
  const filename = symbol.replace('/', '_').replace(':USDT', '') + '_1h.json';
  const filepath = path.join(process.cwd(), 'data', filename);
  if (!fs.existsSync(filepath)) continue;
  
  const candles = JSON.parse(fs.readFileSync(filepath, 'utf-8')).map(c => ({
    timestamp: c.timestamp || c.openTime,
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume
  }));
  
  for (let i = 50; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const btcWindow = btcCandles.slice(0, i + 1);
    const current = window[window.length - 1];
    const closes = window.map(c => c.close);
    const volumes = window.map(c => c.volume);
    
    const isBullish = current.close > current.open;
    const bb = calcBB(closes, 20, 2);
    const breakout = current.close > bb.upper;
    
    if (breakout && isBullish) {
      totalBreakouts++;
      
      if (isBtcBullRegime(btcWindow)) {
        bullRegimeBreakouts++;
        
        const roc10 = calcROC(closes, 10);
        const volRatio = calcVolRatio(volumes);
        const consecUp = countConsecUp(window);
        const rsi = calcRSI(closes, 14);
        const btcRoc4h = calcBtcRoc4h(btcWindow);
        
        let blocked = false;
        if (roc10 < CONFIG.LONG.ROC_MIN) { filterReasons.roc++; blocked = true; }
        if (volRatio < CONFIG.LONG.VOL_MULTIPLIER) { filterReasons.vol++; blocked = true; }
        if (consecUp > CONFIG.LONG.MAX_CONSEC_UP) { filterReasons.consec++; blocked = true; }
        if (rsi > 75 && btcRoc4h < 0) { filterReasons.rsi++; blocked = true; }
        
        if (!blocked) afterFiltersBreakouts++;
      }
    }
  }
}

console.log('═══ ANALYSE DES SIGNAUX ═══\n');
console.log(`Total candles analysées: ${9 * 8760} (9 symbols × 12 mois)`);
console.log(`Breakouts BB + Bullish candle: ${totalBreakouts}`);
console.log(`  → En régime BULL: ${bullRegimeBreakouts} (${(bullRegimeBreakouts/totalBreakouts*100).toFixed(1)}%)`);
console.log(`  → Après TOUS les filtres: ${afterFiltersBreakouts} (${(afterFiltersBreakouts/bullRegimeBreakouts*100).toFixed(1)}%)`);

console.log('\n═══ IMPACT DE CHAQUE FILTRE ═══\n');
console.log(`Breakouts en Bull regime: ${bullRegimeBreakouts}`);
console.log(`Bloqués par ROC < 2.5%:   ${filterReasons.roc} (${(filterReasons.roc/bullRegimeBreakouts*100).toFixed(1)}%)`);
console.log(`Bloqués par VOL < 2.0x:   ${filterReasons.vol} (${(filterReasons.vol/bullRegimeBreakouts*100).toFixed(1)}%)`);
console.log(`Bloqués par Consec > 3:   ${filterReasons.consec} (${(filterReasons.consec/bullRegimeBreakouts*100).toFixed(1)}%)`);
console.log(`Bloqués par RSI+BTC:      ${filterReasons.rsi} (${(filterReasons.rsi/bullRegimeBreakouts*100).toFixed(1)}%)`);

// 2. Maintenant, testons la QUALITÉ des trades bloqués vs acceptés
console.log('\n═══ QUALITÉ DES TRADES BLOQUÉS vs ACCEPTÉS ═══\n');

const tradesByCategory = {
  accepted: [],
  blockedByConsec: [],
  blockedByRoc: [],
  blockedByVol: [],
  blockedByRsi: [],
};

function simulateTrade(candles, entryIdx, entryPrice, atr) {
  const leverage = CONFIG.DEFAULT_LEVERAGE;
  let slPct = atr ? (atr / entryPrice) * 100 * CONFIG.EXIT.STOP_LOSS_ATR_MULT : 2.5;
  slPct = Math.max(CONFIG.EXIT.STOP_LOSS_MIN, Math.min(CONFIG.EXIT.STOP_LOSS_MAX, slPct));
  const stopLoss = entryPrice * (1 - slPct / 100);
  
  let highWaterMark = entryPrice;
  let trailingActive = false;
  let trailingStop = 0;
  let holdBars = 0;
  
  for (let i = entryIdx + 1; i < candles.length && holdBars < 192; i++) {
    const candle = candles[i];
    holdBars++;
    
    if (candle.high > highWaterMark) {
      highWaterMark = candle.high;
      const unrealizedPct = ((highWaterMark - entryPrice) / entryPrice) * 100;
      
      if (unrealizedPct >= CONFIG.EXIT.TRAILING_ACTIVATION && !trailingActive) {
        trailingActive = true;
      }
      if (trailingActive) {
        trailingStop = Math.max(trailingStop, highWaterMark * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100));
      }
    }
    
    let exitPrice = null;
    let exitReason = null;
    
    if (candle.low <= stopLoss) {
      exitPrice = stopLoss;
      exitReason = 'SL';
    } else if (trailingActive && candle.low <= trailingStop) {
      exitPrice = trailingStop;
      exitReason = 'TRAIL';
    }
    
    if (exitPrice) {
      const pricePct = ((exitPrice - entryPrice) / entryPrice) * 100;
      const grossPnlPct = pricePct * leverage;
      const tradingFees = CONFIG.COSTS.TRADING_FEE_PCT * 2;
      const slippage = CONFIG.COSTS.SLIPPAGE_PCT * 2;
      const fundingPeriods = Math.floor(holdBars / CONFIG.COSTS.FUNDING_INTERVAL_BARS);
      const funding = fundingPeriods * CONFIG.COSTS.FUNDING_RATE_PCT;
      const totalCostsPct = (tradingFees + slippage + funding) * leverage;
      const netPnlPct = grossPnlPct - totalCostsPct;
      
      return { pnlPct: netPnlPct, exitReason, holdBars };
    }
  }
  
  const lastCandle = candles[Math.min(entryIdx + 192, candles.length - 1)];
  const pricePct = ((lastCandle.close - entryPrice) / entryPrice) * 100;
  const grossPnlPct = pricePct * leverage;
  const totalCostsPct = (CONFIG.COSTS.TRADING_FEE_PCT * 2 + CONFIG.COSTS.SLIPPAGE_PCT * 2) * leverage;
  
  return { pnlPct: grossPnlPct - totalCostsPct, exitReason: 'TIME', holdBars: 192 };
}

// Simuler les trades avec catégorisation
for (const symbol of SYMBOLS) {
  const filename = symbol.replace('/', '_').replace(':USDT', '') + '_1h.json';
  const filepath = path.join(process.cwd(), 'data', filename);
  if (!fs.existsSync(filepath)) continue;
  
  const candles = JSON.parse(fs.readFileSync(filepath, 'utf-8')).map(c => ({
    timestamp: c.timestamp || c.openTime,
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume
  }));
  
  let lastTradeIdx = 0;
  
  for (let i = 50; i < candles.length - 50; i++) {
    if (i < lastTradeIdx + 8) continue; // Cooldown minimum
    
    const window = candles.slice(0, i + 1);
    const btcWindow = btcCandles.slice(0, i + 1);
    const current = window[window.length - 1];
    const closes = window.map(c => c.close);
    const volumes = window.map(c => c.volume);
    
    const isBullish = current.close > current.open;
    const bb = calcBB(closes, 20, 2);
    const breakout = current.close > bb.upper;
    
    if (!breakout || !isBullish) continue;
    if (!isBtcBullRegime(btcWindow)) continue;
    
    const roc10 = calcROC(closes, 10);
    const volRatio = calcVolRatio(volumes);
    const consecUp = countConsecUp(window);
    const rsi = calcRSI(closes, 14);
    const btcRoc4h = calcBtcRoc4h(btcWindow);
    
    const entryPrice = current.close;
    const atr = calcATR(window, 14);
    const trade = simulateTrade(candles, i, entryPrice, atr);
    lastTradeIdx = i + trade.holdBars;
    
    // Catégoriser
    const rocOk = roc10 >= CONFIG.LONG.ROC_MIN;
    const volOk = volRatio >= CONFIG.LONG.VOL_MULTIPLIER;
    const consecOk = consecUp <= CONFIG.LONG.MAX_CONSEC_UP;
    const rsiOk = !(rsi > 75 && btcRoc4h < 0);
    
    if (rocOk && volOk && consecOk && rsiOk) {
      tradesByCategory.accepted.push(trade);
    } else {
      // Premier filtre qui bloque
      if (!consecOk) tradesByCategory.blockedByConsec.push(trade);
      else if (!rocOk) tradesByCategory.blockedByRoc.push(trade);
      else if (!volOk) tradesByCategory.blockedByVol.push(trade);
      else if (!rsiOk) tradesByCategory.blockedByRsi.push(trade);
    }
  }
}

function analyzeCategory(name, trades) {
  if (trades.length === 0) return { trades: 0, avgPnl: 0, wr: 0, slRate: 0 };
  const wins = trades.filter(t => t.pnlPct > 0).length;
  const sls = trades.filter(t => t.exitReason === 'SL').length;
  const avgPnl = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
  return {
    trades: trades.length,
    avgPnl,
    wr: (wins / trades.length) * 100,
    slRate: (sls / trades.length) * 100,
  };
}

console.log('Catégorie              │ Trades │ Avg PnL │  WR%  │  SL%  │ Verdict');
console.log('───────────────────────┼────────┼─────────┼───────┼───────┼─────────');

const accepted = analyzeCategory('Accepted', tradesByCategory.accepted);
const blockedConsec = analyzeCategory('Blocked Consec', tradesByCategory.blockedByConsec);
const blockedRoc = analyzeCategory('Blocked ROC', tradesByCategory.blockedByRoc);
const blockedVol = analyzeCategory('Blocked VOL', tradesByCategory.blockedByVol);
const blockedRsi = analyzeCategory('Blocked RSI', tradesByCategory.blockedByRsi);

function printRow(name, stats) {
  let verdict = '';
  if (stats.trades === 0) verdict = '—';
  else if (stats.avgPnl > accepted.avgPnl && stats.wr >= accepted.wr - 2) verdict = '❌ MISSED';
  else if (stats.avgPnl < 0) verdict = '✅ GOOD FILTER';
  else if (stats.slRate > accepted.slRate + 5) verdict = '✅ RISKY';
  else if (stats.avgPnl < accepted.avgPnl * 0.5) verdict = '✅ WEAKER';
  else verdict = '⚠️ UNCLEAR';
  
  console.log(
    `${name.padEnd(22)} │ ${String(stats.trades).padStart(5)}  │ ${(stats.avgPnl >= 0 ? '+' : '') + stats.avgPnl.toFixed(2).padStart(6)}% │ ${stats.wr.toFixed(0).padStart(4)}% │ ${stats.slRate.toFixed(0).padStart(4)}% │ ${verdict}`
  );
}

printRow('✅ ACCEPTED', accepted);
printRow('🚫 Blocked by Consec>3', blockedConsec);
printRow('🚫 Blocked by ROC<2.5%', blockedRoc);
printRow('🚫 Blocked by VOL<2x', blockedVol);
printRow('🚫 Blocked by RSI+BTC', blockedRsi);

console.log('\n═══ INTERPRÉTATION ═══\n');
console.log('❌ MISSED = Le filtre bloque des trades qui auraient été MEILLEURS que la moyenne');
console.log('✅ GOOD FILTER = Le filtre bloque des trades PERDANTS (avg PnL < 0)');
console.log('✅ RISKY = Le filtre bloque des trades avec un taux de SL élevé');
console.log('✅ WEAKER = Le filtre bloque des trades moins performants');
console.log('⚠️ UNCLEAR = Impact non évident\n');

// Conclusion
const consecQuality = blockedConsec.avgPnl;
const rocQuality = blockedRoc.avgPnl;
const volQuality = blockedVol.avgPnl;
const rsiQuality = blockedRsi.avgPnl;

console.log('═══ RECOMMANDATION BASÉE SUR LA QUALITÉ DES TRADES BLOQUÉS ═══\n');

if (blockedConsec.trades > 0) {
  if (blockedConsec.avgPnl > accepted.avgPnl) {
    console.log(`🔴 ConsecUp=3: TROP RESTRICTIF - Les trades bloqués font +${blockedConsec.avgPnl.toFixed(2)}% vs +${accepted.avgPnl.toFixed(2)}% acceptés`);
    console.log(`   → RECOMMANDATION: Augmenter à 5 ou supprimer`);
  } else if (blockedConsec.avgPnl < 0) {
    console.log(`🟢 ConsecUp=3: EFFICACE - Les trades bloqués font ${blockedConsec.avgPnl.toFixed(2)}% (négatif)`);
  } else {
    console.log(`🟡 ConsecUp=3: MARGINAL - Les trades bloqués font +${blockedConsec.avgPnl.toFixed(2)}% vs +${accepted.avgPnl.toFixed(2)}%`);
  }
}

if (blockedRoc.trades > 0) {
  if (blockedRoc.avgPnl > accepted.avgPnl) {
    console.log(`🔴 ROC>=2.5%: TROP RESTRICTIF - Les trades bloqués font +${blockedRoc.avgPnl.toFixed(2)}% vs +${accepted.avgPnl.toFixed(2)}% acceptés`);
  } else if (blockedRoc.avgPnl < 0) {
    console.log(`🟢 ROC>=2.5%: EFFICACE - Les trades bloqués font ${blockedRoc.avgPnl.toFixed(2)}% (négatif)`);
  } else {
    console.log(`🟡 ROC>=2.5%: ${blockedRoc.avgPnl < accepted.avgPnl * 0.7 ? 'UTILE' : 'MARGINAL'} - Bloqués: +${blockedRoc.avgPnl.toFixed(2)}% vs Acceptés: +${accepted.avgPnl.toFixed(2)}%`);
  }
}

if (blockedVol.trades > 0) {
  if (blockedVol.avgPnl > accepted.avgPnl) {
    console.log(`🔴 VOL>=2x: TROP RESTRICTIF - Les trades bloqués font +${blockedVol.avgPnl.toFixed(2)}% vs +${accepted.avgPnl.toFixed(2)}% acceptés`);
  } else if (blockedVol.avgPnl < 0) {
    console.log(`🟢 VOL>=2x: EFFICACE - Les trades bloqués font ${blockedVol.avgPnl.toFixed(2)}% (négatif)`);
  } else {
    console.log(`🟡 VOL>=2x: ${blockedVol.avgPnl < accepted.avgPnl * 0.7 ? 'UTILE' : 'MARGINAL'} - Bloqués: +${blockedVol.avgPnl.toFixed(2)}% vs Acceptés: +${accepted.avgPnl.toFixed(2)}%`);
  }
}

if (blockedRsi.trades > 0) {
  if (blockedRsi.avgPnl < 0) {
    console.log(`🟢 RSI+BTC: EFFICACE - Les trades bloqués font ${blockedRsi.avgPnl.toFixed(2)}% (négatif)`);
  } else {
    console.log(`🟡 RSI+BTC: Bloqués: +${blockedRsi.avgPnl.toFixed(2)}% vs Acceptés: +${accepted.avgPnl.toFixed(2)}%`);
  }
}
