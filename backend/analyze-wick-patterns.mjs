/**
 * 🔬 ANALYSE APPROFONDIE WICK RATIO + PATTERNS AVANCÉS
 * 
 * Le Wick Ratio est le seul pattern discriminant trouvé (SL=0.89 vs Win=1.36)
 * Explorons ce pattern plus en détail + d'autres combinaisons
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data', 'candles');

// Configuration
const CONFIG = {
  LONG: { BB_PERIOD: 20, BB_STD: 2, ROC_MIN: 2.5, VOL_MULTIPLIER: 2.0, MAX_CONSEC_UP: 3 },
  SHORT: { ROC_DROP_MIN: -1.5, VOL_SPIKE: 2.0, PRICE_BELOW_MA20: true, PRICE_BELOW_BB_LOWER: true, MAX_CONSEC_DOWN: 5 },
  EXIT: { STOP_LOSS: 1.5, TAKE_PROFIT: 3.0, TRAILING_ACTIVATION: 1.0, TRAILING_DISTANCE: 0.4, MAX_HOLD_BARS: 192 },
  LEVERAGE: 4.5,
  POSITION_SIZE_PCT: 0.4,
};

const COSTS = { TRADING_FEE_PCT: 0.04, SLIPPAGE_PCT: 0.05, FUNDING_RATE_PCT: 0.01, FUNDING_INTERVAL_BARS: 32 };

function loadLocalData(symbols) {
  const data = {};
  for (const symbol of symbols) {
    const filename = symbol.replace('/USDT:USDT', '').toLowerCase() + '-usdt.json';
    const filepath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filepath)) continue;
    const json = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    data[symbol] = json.candles;
  }
  return data;
}

// Indicateurs
function calcSMA(values, period) { if (values.length < period) return null; return values.slice(-period).reduce((a, b) => a + b, 0) / period; }
function calcBB(closes, period = 20, std = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
  return { middle: sma, upper: sma + std * Math.sqrt(variance), lower: sma - std * Math.sqrt(variance) };
}
function calcROC(closes, period) { if (closes.length < period + 1) return null; return ((closes[closes.length - 1] - closes[closes.length - 1 - period]) / closes[closes.length - 1 - period]) * 100; }
function calcVolAvg(volumes, period = 20) { if (volumes.length < period) return null; return volumes.slice(-period).reduce((a, b) => a + b, 0) / period; }
function countConsecUp(candles) { let count = 0; for (let i = candles.length - 1; i >= 0; i--) { if (candles[i].close > candles[i].open) count++; else break; } return count; }
function countConsecDown(candles) { let count = 0; for (let i = candles.length - 1; i >= 0; i--) { if (candles[i].close < candles[i].open) count++; else break; } return count; }
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change; else losses -= change;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - (candles[i-1]?.close || candles[i].open)), Math.abs(candles[i].low - (candles[i-1]?.close || candles[i].open)));
    atrSum += tr;
  }
  return atrSum / period;
}

// Wick analysis avancée
function calcWickMetrics(candle) {
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  const upperWick = candle.high - Math.max(candle.close, candle.open);
  const lowerWick = Math.min(candle.close, candle.open) - candle.low;
  
  return {
    wickRatio: body > 0 ? (upperWick + lowerWick) / body : 0,
    bodyRatio: range > 0 ? body / range : 0,  // Corps / Range total
    upperWickRatio: range > 0 ? upperWick / range : 0,
    lowerWickRatio: range > 0 ? lowerWick / range : 0,
    isBullish: candle.close > candle.open,
    // Rejection patterns
    isHammer: lowerWick > body * 2 && upperWick < body * 0.5,  // Marteau = rejection haussière
    isShootingStar: upperWick > body * 2 && lowerWick < body * 0.5,  // Étoile filante = rejection baissière
    isDoji: body < range * 0.1,  // Doji = indécision
  };
}

// Pattern sur plusieurs bougies
function analyzeRecentCandles(candles, n = 3) {
  if (candles.length < n) return null;
  
  const recent = candles.slice(-n);
  
  // Comptage des patterns
  let hammers = 0, shootingStars = 0, dojis = 0;
  let totalLowerWickRatio = 0, totalUpperWickRatio = 0;
  let bullishCandles = 0;
  
  for (const c of recent) {
    const metrics = calcWickMetrics(c);
    if (metrics.isHammer) hammers++;
    if (metrics.isShootingStar) shootingStars++;
    if (metrics.isDoji) dojis++;
    if (metrics.isBullish) bullishCandles++;
    totalLowerWickRatio += metrics.lowerWickRatio;
    totalUpperWickRatio += metrics.upperWickRatio;
  }
  
  return {
    hammers,
    shootingStars,
    dojis,
    avgLowerWickRatio: totalLowerWickRatio / n,
    avgUpperWickRatio: totalUpperWickRatio / n,
    bullishCount: bullishCandles,
    bearishCount: n - bullishCandles,
  };
}

// Divergence price vs momentum
function detectDivergence(candles, period = 10) {
  if (candles.length < period + 5) return null;
  
  const closes = candles.map(c => c.close);
  
  // Prix: dernière bougie vs il y a 'period' bougies
  const priceChange = (closes[closes.length - 1] - closes[closes.length - period]) / closes[closes.length - period] * 100;
  
  // RSI: idem
  const rsiNow = calcRSI(closes, 14);
  const rsiBefore = calcRSI(closes.slice(0, -period + 1), 14);
  
  if (!rsiNow || !rsiBefore) return null;
  
  const rsiChange = rsiNow - rsiBefore;
  
  // Divergence haussière: prix baisse mais RSI monte
  const bullishDivergence = priceChange < -2 && rsiChange > 5;
  // Divergence baissière: prix monte mais RSI baisse
  const bearishDivergence = priceChange > 2 && rsiChange < -5;
  
  return {
    priceChange,
    rsiChange,
    bullishDivergence,
    bearishDivergence,
  };
}

function checkLongEntry(candles) {
  if (candles.length < 50) return false;
  const closes = candles.map(c => c.close), volumes = candles.map(c => c.volume), current = candles[candles.length - 1];
  if (current.close <= current.open) return false;
  const bb = calcBB(closes, 20, 2); if (!bb || current.close <= bb.upper) return false;
  const roc = calcROC(closes, 10); if (!roc || roc < 2.5) return false;
  const volAvg = calcVolAvg(volumes); if (!volAvg || current.volume < volAvg * 2) return false;
  if (countConsecUp(candles) > 3) return false;
  return true;
}

function checkShortEntry(candles) {
  if (candles.length < 50) return false;
  const closes = candles.map(c => c.close), volumes = candles.map(c => c.volume), current = candles[candles.length - 1];
  if (current.close >= current.open) return false;
  const roc5 = calcROC(closes, 5); if (!roc5 || roc5 > -1.5) return false;
  const volAvg = calcVolAvg(volumes); if (!volAvg || current.volume < volAvg * 2) return false;
  const ma20 = calcSMA(closes, 20); if (!ma20 || current.close >= ma20) return false;
  const bb = calcBB(closes); if (!bb || current.close >= bb.lower) return false;
  if (countConsecDown(candles) > 5) return false;
  return true;
}

function captureAdvancedContext(candles, btcCandles, btcIdx) {
  const closes = candles.map(c => c.close);
  const current = candles[candles.length - 1];
  const btcCloses = btcCandles.slice(0, btcIdx + 1).map(c => c.close);
  
  const wickMetrics = calcWickMetrics(current);
  const recentPattern = analyzeRecentCandles(candles, 3);
  const divergence = detectDivergence(candles, 10);
  
  return {
    // Wick metrics (single candle)
    ...wickMetrics,
    
    // Recent pattern (3 candles)
    ...recentPattern,
    
    // Divergence
    ...divergence,
    
    // Standard indicators
    rsi14: calcRSI(closes, 14),
    roc5: calcROC(closes, 5),
    roc10: calcROC(closes, 10),
    atrPct: calcATR(candles, 14) ? (calcATR(candles, 14) / current.close) * 100 : null,
    btcRoc5: calcROC(btcCloses, 5),
    btcRsi: calcRSI(btcCloses, 14),
    consecDown: countConsecDown(candles),
    
    // Volume analysis
    volumeSpike: candles[candles.length - 1].volume / calcVolAvg(candles.map(c => c.volume), 20),
    
    // Price position vs recent range
    pricePosition: (() => {
      const highs = candles.slice(-20).map(c => c.high);
      const lows = candles.slice(-20).map(c => c.low);
      const range = Math.max(...highs) - Math.min(...lows);
      return range > 0 ? (current.close - Math.min(...lows)) / range * 100 : 50;
    })(),
  };
}

function calculatePnl(entryPrice, exitPrice, side, capitalUsed, holdBars) {
  let pnlPct = side === 'long' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - exitPrice) / entryPrice) * 100;
  const leveragedPnlPct = pnlPct * CONFIG.LEVERAGE;
  const totalCosts = (COSTS.TRADING_FEE_PCT * 2 + COSTS.SLIPPAGE_PCT * 2) * CONFIG.LEVERAGE + Math.floor(holdBars / COSTS.FUNDING_INTERVAL_BARS) * COSTS.FUNDING_RATE_PCT * CONFIG.LEVERAGE;
  return { netPnlPct: leveragedPnlPct - totalCosts, netPnlUsd: ((leveragedPnlPct - totalCosts) / 100) * capitalUsed };
}

async function main() {
  console.log('═'.repeat(90));
  console.log('🔬 ANALYSE APPROFONDIE - WICK RATIO + PATTERNS AVANCÉS');
  console.log('═'.repeat(90));
  
  const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'XRP/USDT:USDT', 'SOL/USDT:USDT', 'ADA/USDT:USDT', 'LINK/USDT:USDT', 'SUI/USDT:USDT', 'DOGE/USDT:USDT', 'AVAX/USDT:USDT', 'DOT/USDT:USDT'];
  
  console.log('\n📂 Chargement des données...');
  const allData = loadLocalData(SYMBOLS);
  const btcCandles = allData['BTC/USDT:USDT'];
  const btcCloses = btcCandles.map(c => c.close);
  
  // Storage
  const shortSL = [];
  const shortWin = [];
  const longSL = [];
  const longWin = [];
  
  console.log('⏳ Running analysis...\n');
  
  for (const symbol of SYMBOLS) {
    const candles = allData[symbol];
    if (!candles) continue;
    
    let position = null, cooldown = 0;
    
    for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
      const btcCandle = btcCandles[btcIdx];
      const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
      const btcPrice = btcCloses[btcIdx - 1];
      const isBullRegime = btcPrice > btcSma200;
      const isBearRegime = btcPrice < btcSma200;
      
      const idx = candles.findIndex(c => c.timestamp >= btcCandle.timestamp);
      if (idx < 50) continue;
      
      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];
      
      // MANAGE POSITION
      if (position) {
        const holdBars = idx - position.entryIdx;
        let exitReason = null, exitPrice = current.close;
        
        if (position.side === 'long') {
          const pnlPct = ((current.close - position.entryPrice) / position.entryPrice) * 100;
          position.hwm = Math.max(position.hwm || position.entryPrice, current.high);
          const hwmPct = ((position.hwm - position.entryPrice) / position.entryPrice) * 100;
          if (pnlPct <= -1.5) { exitReason = 'SL'; exitPrice = position.entryPrice * 0.985; }
          else if (pnlPct >= 3.0) { exitReason = 'TP'; exitPrice = position.entryPrice * 1.03; }
          else if (hwmPct >= 1.0 && current.low <= position.hwm * 0.996) { exitReason = 'TRAIL'; exitPrice = position.hwm * 0.996; }
          else if (holdBars >= 192) exitReason = 'TIME';
        } else {
          const pnlPct = ((position.entryPrice - current.close) / position.entryPrice) * 100;
          position.lwm = Math.min(position.lwm || position.entryPrice, current.low);
          const lwmPct = ((position.entryPrice - position.lwm) / position.entryPrice) * 100;
          if (pnlPct <= -1.5) { exitReason = 'SL'; exitPrice = position.entryPrice * 1.015; }
          else if (pnlPct >= 3.0) { exitReason = 'TP'; exitPrice = position.entryPrice * 0.97; }
          else if (lwmPct >= 1.0 && current.high >= position.lwm * 1.004) { exitReason = 'TRAIL'; exitPrice = position.lwm * 1.004; }
          else if (holdBars >= 192) exitReason = 'TIME';
        }
        
        if (exitReason) {
          const pnl = calculatePnl(position.entryPrice, exitPrice, position.side, 400, holdBars);
          
          if (position.side === 'short') {
            if (exitReason === 'SL') shortSL.push(position.entryContext);
            else if (pnl.netPnlPct > 0) shortWin.push(position.entryContext);
          } else {
            if (exitReason === 'SL') longSL.push(position.entryContext);
            else if (pnl.netPnlPct > 0) longWin.push(position.entryContext);
          }
          
          position = null;
          cooldown = 8;
        }
      }
      
      // NEW ENTRY
      if (!position && cooldown <= 0) {
        const entryContext = captureAdvancedContext(windowCandles, btcCandles, btcIdx);
        
        if (isBullRegime && checkLongEntry(windowCandles)) {
          position = { side: 'long', entryPrice: current.close, entryIdx: idx, hwm: current.close, entryContext };
        } else if (isBearRegime && checkShortEntry(windowCandles)) {
          position = { side: 'short', entryPrice: current.close, entryIdx: idx, lwm: current.close, entryContext };
        }
      }
      
      if (cooldown > 0) cooldown--;
    }
  }
  
  // ============================================================================
  // ANALYSE APPROFONDIE
  // ============================================================================
  
  console.log('\n' + '═'.repeat(90));
  console.log('📊 ANALYSE SHORTS - WICK METRICS DÉTAILLÉS');
  console.log('═'.repeat(90));
  
  console.log(`\n  SHORT SL: ${shortSL.length} | SHORT Wins: ${shortWin.length}`);
  
  // Calculer moyennes
  const metrics = ['wickRatio', 'bodyRatio', 'upperWickRatio', 'lowerWickRatio', 'avgLowerWickRatio', 'avgUpperWickRatio', 'hammers', 'shootingStars', 'dojis', 'bullishDivergence', 'pricePosition', 'rsi14', 'volumeSpike'];
  
  console.log(`\n  ┌─────────────────────────┬──────────────┬──────────────┬────────────────────┐`);
  console.log(`  │       Indicateur        │   SL Avg     │   Win Avg    │     Analyse        │`);
  console.log(`  ├─────────────────────────┼──────────────┼──────────────┼────────────────────┤`);
  
  const significantMetrics = [];
  
  for (const metric of metrics) {
    const slAvg = shortSL.reduce((a, p) => a + (p[metric] || 0), 0) / shortSL.length;
    const winAvg = shortWin.reduce((a, p) => a + (p[metric] || 0), 0) / shortWin.length;
    const diff = winAvg !== 0 ? ((slAvg - winAvg) / Math.abs(winAvg) * 100) : 0;
    const arrow = slAvg > winAvg ? '↑' : slAvg < winAvg ? '↓' : '=';
    const highlight = Math.abs(diff) > 20 ? '⚠️ SIGNIFICANT' : '';
    
    console.log(`  │ ${metric.padEnd(23)} │ ${slAvg.toFixed(3).padStart(10)}  │ ${winAvg.toFixed(3).padStart(10)}  │ ${arrow} ${diff.toFixed(0).padStart(4)}% ${highlight.padEnd(7)} │`);
    
    if (Math.abs(diff) > 15) significantMetrics.push({ metric, slAvg, winAvg, diff });
  }
  
  console.log(`  └─────────────────────────┴──────────────┴──────────────┴────────────────────┘`);
  
  // ============================================================================
  // TEST FILTRES BASÉS SUR WICK
  // ============================================================================
  
  console.log('\n\n' + '═'.repeat(90));
  console.log('🧪 TEST FILTRES AVANCÉS BASÉS SUR WICK PATTERN');
  console.log('═'.repeat(90));
  
  const advancedFilters = [
    // Wick Ratio filters
    { name: 'Wick Ratio < 0.5', check: (p) => p.wickRatio < 0.5, desc: 'Petit wick ratio = continuation probable' },
    { name: 'Wick Ratio < 0.7', check: (p) => p.wickRatio < 0.7, desc: 'Éviter les entrées avec petits wicks' },
    { name: 'Wick Ratio > 1.5', check: (p) => p.wickRatio > 1.5, desc: 'Grands wicks = plus de rejections' },
    
    // Body ratio filters
    { name: 'Body Ratio > 0.6', check: (p) => p.bodyRatio > 0.6, desc: 'Corps dominant = momentum fort' },
    { name: 'Body Ratio < 0.3', check: (p) => p.bodyRatio < 0.3, desc: 'Petit corps = indécision' },
    
    // Lower wick (important pour shorts)
    { name: 'Lower Wick Ratio > 0.2', check: (p) => p.lowerWickRatio > 0.2, desc: 'Mèche basse = acheteurs présents' },
    { name: 'Lower Wick Ratio > 0.3', check: (p) => p.lowerWickRatio > 0.3, desc: 'Forte mèche basse = rejection' },
    
    // Hammer pattern (rejection haussière)
    { name: 'isHammer = true', check: (p) => p.isHammer, desc: 'Pattern marteau = signal de retournement' },
    { name: 'Hammers récents > 0', check: (p) => p.hammers > 0, desc: 'Marteaux dans les 3 dernières bougies' },
    
    // Combined patterns
    { name: 'Lower Wick > 0.2 AND RSI < 25', check: (p) => p.lowerWickRatio > 0.2 && p.rsi14 < 25, desc: 'Oversold + rejection' },
    { name: 'Wick Ratio < 0.6 AND Body > 0.5', check: (p) => p.wickRatio < 0.6 && p.bodyRatio > 0.5, desc: 'Momentum fort sans hesitation' },
    { name: 'Bullish Divergence', check: (p) => p.bullishDivergence, desc: 'Prix baisse mais RSI monte' },
    { name: 'Price Position < 10%', check: (p) => p.pricePosition < 10, desc: 'Prix proche du bas du range' },
    { name: 'Price Position < 20%', check: (p) => p.pricePosition < 20, desc: 'Prix dans le bas du range' },
    
    // BTC context
    { name: 'BTC RSI > 50', check: (p) => p.btcRsi > 50, desc: 'BTC pas en survente' },
    { name: 'BTC ROC5 > -0.5%', check: (p) => p.btcRoc5 > -0.5, desc: 'BTC pas en forte baisse' },
  ];
  
  console.log(`\n  ┌────────────────────────────────┬──────────────┬──────────────┬─────────────────┐`);
  console.log(`  │           Filtre               │  SL bloqués  │  Win bloqués │   Ratio         │`);
  console.log(`  ├────────────────────────────────┼──────────────┼──────────────┼─────────────────┤`);
  
  const goodFilters = [];
  
  for (const filter of advancedFilters) {
    const slBlocked = shortSL.filter(filter.check).length;
    const winBlocked = shortWin.filter(filter.check).length;
    const slPct = (slBlocked / shortSL.length * 100).toFixed(0);
    const winPct = (winBlocked / shortWin.length * 100).toFixed(0);
    const ratio = winBlocked > 0 ? (slBlocked / winBlocked).toFixed(2) : slBlocked > 0 ? '∞' : '0';
    
    // Un bon filtre bloque plus de SL que de wins, et pas trop de wins
    const quality = slBlocked > winBlocked * 1.5 && winBlocked < shortWin.length * 0.15 ? '✅ GOOD' :
                    slBlocked > winBlocked * 1.2 ? '⚠️' : '';
    
    console.log(`  │ ${filter.name.padEnd(30)} │ ${String(slBlocked).padStart(4)} (${slPct.padStart(2)}%)  │ ${String(winBlocked).padStart(4)} (${winPct.padStart(2)}%)  │ ${ratio.padStart(5)}x ${quality.padEnd(6)}│`);
    
    if (slBlocked > winBlocked * 1.3 && winBlocked < shortWin.length * 0.2) {
      goodFilters.push({ ...filter, slBlocked, winBlocked, ratio: parseFloat(ratio) || 999 });
    }
  }
  
  console.log(`  └────────────────────────────────┴──────────────┴──────────────┴─────────────────┘`);
  
  // ============================================================================
  // RECOMMANDATIONS
  // ============================================================================
  
  console.log('\n\n' + '═'.repeat(90));
  console.log('🎯 FILTRES RECOMMANDÉS');
  console.log('═'.repeat(90));
  
  if (goodFilters.length > 0) {
    goodFilters.sort((a, b) => b.ratio - a.ratio);
    
    console.log('\n  Filtres qui bloquent >1.3x plus de SL que de Wins (<20% des wins):');
    for (const f of goodFilters.slice(0, 5)) {
      const impactPct = (f.slBlocked / shortSL.length * 100).toFixed(0);
      const winLossPct = (f.winBlocked / shortWin.length * 100).toFixed(0);
      console.log(`\n    ✅ ${f.name}`);
      console.log(`       ${f.desc}`);
      console.log(`       Impact: Bloque ${f.slBlocked} SL (${impactPct}%) et ${f.winBlocked} Wins (${winLossPct}%)`);
      console.log(`       Ratio: ${f.ratio}x`);
    }
    
    // Test combinaison des meilleurs
    console.log('\n\n  📊 TEST COMBINAISON DES MEILLEURS FILTRES:');
    
    // Combinaison 1: Lower wick + Price position
    const combo1 = (p) => p.lowerWickRatio > 0.25 || p.pricePosition < 15;
    const combo1SL = shortSL.filter(combo1).length;
    const combo1Win = shortWin.filter(combo1).length;
    console.log(`\n    COMBO 1: Lower Wick > 0.25 OR Price Position < 15%`);
    console.log(`    SL bloqués: ${combo1SL}/${shortSL.length} (${(combo1SL/shortSL.length*100).toFixed(0)}%)`);
    console.log(`    Wins bloqués: ${combo1Win}/${shortWin.length} (${(combo1Win/shortWin.length*100).toFixed(0)}%)`);
    console.log(`    Ratio: ${(combo1SL/combo1Win).toFixed(2)}x`);
    
    // Combinaison 2: Bullish divergence + hammers
    const combo2 = (p) => p.bullishDivergence || p.hammers > 0 || p.isHammer;
    const combo2SL = shortSL.filter(combo2).length;
    const combo2Win = shortWin.filter(combo2).length;
    console.log(`\n    COMBO 2: Bullish Divergence OR Hammer pattern`);
    console.log(`    SL bloqués: ${combo2SL}/${shortSL.length} (${(combo2SL/shortSL.length*100).toFixed(0)}%)`);
    console.log(`    Wins bloqués: ${combo2Win}/${shortWin.length} (${(combo2Win/shortWin.length*100).toFixed(0)}%)`);
    console.log(`    Ratio: ${combo2Win > 0 ? (combo2SL/combo2Win).toFixed(2) : '∞'}x`);
    
    // Combinaison 3: Stricte - plusieurs signaux d'alerte
    const combo3 = (p) => (p.lowerWickRatio > 0.2 && p.rsi14 < 28) || p.bullishDivergence;
    const combo3SL = shortSL.filter(combo3).length;
    const combo3Win = shortWin.filter(combo3).length;
    console.log(`\n    COMBO 3: (Lower Wick > 0.2 AND RSI < 28) OR Bullish Divergence`);
    console.log(`    SL bloqués: ${combo3SL}/${shortSL.length} (${(combo3SL/shortSL.length*100).toFixed(0)}%)`);
    console.log(`    Wins bloqués: ${combo3Win}/${shortWin.length} (${(combo3Win/shortWin.length*100).toFixed(0)}%)`);
    console.log(`    Ratio: ${combo3Win > 0 ? (combo3SL/combo3Win).toFixed(2) : '∞'}x`);
    
  } else {
    console.log('\n  ⚠️ Aucun filtre n\'a un ratio >1.3x avec <20% de wins perdus');
  }
  
  // ============================================================================
  // ANALYSE LONG (brief)
  // ============================================================================
  
  console.log('\n\n' + '═'.repeat(90));
  console.log('📈 ANALYSE LONGS (Résumé)');
  console.log('═'.repeat(90));
  console.log(`\n  LONG SL: ${longSL.length} | LONG Wins: ${longWin.length}`);
  
  const longMetrics = ['wickRatio', 'upperWickRatio', 'rsi14', 'pricePosition'];
  for (const m of longMetrics) {
    const slAvg = longSL.reduce((a, p) => a + (p[m] || 0), 0) / longSL.length;
    const winAvg = longWin.reduce((a, p) => a + (p[m] || 0), 0) / longWin.length;
    console.log(`  ${m}: SL=${slAvg.toFixed(2)} vs Win=${winAvg.toFixed(2)}`);
  }
  
  console.log('\n\n✅ Analyse terminée');
}

main().catch(console.error);
