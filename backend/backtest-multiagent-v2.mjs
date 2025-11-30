/**
 * 🔬 BACKTEST MULTI-AGENT V2 - Position Size Fixe (Réaliste)
 * 
 * Simule 12 agents tradant simultanément sur un capital partagé de $2000
 * - Position size FIXE basé sur le capital initial (pas de compound)
 * - Ordres rejetés si capital insuffisant
 * - Plus réaliste pour estimer la vraie performance
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data', 'candles');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  LONG: { BB_PERIOD: 20, BB_STD: 2, ROC_MIN: 2.5, VOL_MULTIPLIER: 2.0, MAX_CONSEC_UP: 3 },
  SHORT: { ROC_DROP_MIN: -1.5, VOL_SPIKE: 2.0, PRICE_BELOW_MA20: true, PRICE_BELOW_BB_LOWER: true, MAX_CONSEC_DOWN: 5 },
  EXIT: { STOP_LOSS: 1.5, TAKE_PROFIT: 3.0, TRAILING_ACTIVATION: 1.0, TRAILING_DISTANCE: 0.4, MAX_HOLD_BARS: 192 },
  FIXED_POSITION_SIZE: 200,  // $200 fixe par position (40% de $500 par agent)
  LEVERAGE: 4.5,
  MAX_POSITIONS: 6,  // Max 6 positions simultanées
};

const COSTS = {
  TRADING_FEE_PCT: 0.04,
  SLIPPAGE_PCT: 0.05,
  FUNDING_RATE_PCT: 0.01,
  FUNDING_INTERVAL_BARS: 32,
};

const INITIAL_CAPITAL = 2000;

const SYMBOLS = [
  'BTC/USDT:USDT', 'ETH/USDT:USDT', 'XRP/USDT:USDT', 'SOL/USDT:USDT',
  'ADA/USDT:USDT', 'LINK/USDT:USDT', 'SUI/USDT:USDT', 'DOGE/USDT:USDT',
  'AVAX/USDT:USDT', 'DOT/USDT:USDT', 'SEI/USDT:USDT', 'IMX/USDT:USDT',
];

// ============================================================================
// LOAD DATA
// ============================================================================

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

// ============================================================================
// INDICATORS (same as before)
// ============================================================================

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

function calculatePnl(entryPrice, exitPrice, side, marginUsed, holdBars) {
  let pnlPct = side === 'long' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - exitPrice) / entryPrice) * 100;
  const leveragedPnlPct = pnlPct * CONFIG.LEVERAGE;
  const totalCosts = (COSTS.TRADING_FEE_PCT * 2 + COSTS.SLIPPAGE_PCT * 2) * CONFIG.LEVERAGE + Math.floor(holdBars / COSTS.FUNDING_INTERVAL_BARS) * COSTS.FUNDING_RATE_PCT * CONFIG.LEVERAGE;
  const netPnlPct = leveragedPnlPct - totalCosts;
  const netPnlUsd = (netPnlPct / 100) * marginUsed;
  return { grossPnlPct: pnlPct, netPnlPct, netPnlUsd, costsUsd: (totalCosts / 100) * marginUsed };
}

// ============================================================================
// CAPITAL POOL MANAGER (Version Fixe)
// ============================================================================

class CapitalPool {
  constructor(initialCapital) {
    this.totalCapital = initialCapital;
    this.availableCapital = initialCapital;
    this.lockedCapital = 0;
    this.positions = new Map();
    
    // Stats
    this.rejectedOrders = 0;
    this.totalOrders = 0;
    this.peakCapital = initialCapital;
    this.minCapital = initialCapital;
    this.maxDrawdown = 0;
    this.maxConcurrentPositions = 0;
    this.positionCountHistory = [];
  }
  
  getAvailableCapital() { return this.availableCapital; }
  getPositionCount() { return this.positions.size; }
  
  canOpenPosition() {
    if (CONFIG.FIXED_POSITION_SIZE > this.availableCapital) return false;
    if (this.positions.size >= CONFIG.MAX_POSITIONS) return false;
    return true;
  }
  
  openPosition(symbol, positionData) {
    this.totalOrders++;
    
    if (!this.canOpenPosition()) {
      this.rejectedOrders++;
      return false;
    }
    
    const marginUsed = CONFIG.FIXED_POSITION_SIZE;
    this.availableCapital -= marginUsed;
    this.lockedCapital += marginUsed;
    this.positions.set(symbol, { marginUsed, ...positionData });
    
    if (this.positions.size > this.maxConcurrentPositions) {
      this.maxConcurrentPositions = this.positions.size;
    }
    this.positionCountHistory.push(this.positions.size);
    
    return true;
  }
  
  closePosition(symbol, pnlUsd) {
    const position = this.positions.get(symbol);
    if (!position) return;
    
    this.availableCapital += position.marginUsed + pnlUsd;
    this.lockedCapital -= position.marginUsed;
    this.totalCapital += pnlUsd;
    
    if (this.totalCapital > this.peakCapital) this.peakCapital = this.totalCapital;
    if (this.totalCapital < this.minCapital) this.minCapital = this.totalCapital;
    
    const currentDD = ((this.peakCapital - this.totalCapital) / this.peakCapital) * 100;
    if (currentDD > this.maxDrawdown) this.maxDrawdown = currentDD;
    
    this.positions.delete(symbol);
    this.positionCountHistory.push(this.positions.size);
  }
  
  getStats() {
    const avgPositions = this.positionCountHistory.length > 0 
      ? this.positionCountHistory.reduce((a, b) => a + b, 0) / this.positionCountHistory.length 
      : 0;
    return {
      totalCapital: this.totalCapital,
      roi: ((this.totalCapital - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100,
      totalOrders: this.totalOrders,
      rejectedOrders: this.rejectedOrders,
      rejectionRate: this.totalOrders > 0 ? (this.rejectedOrders / this.totalOrders * 100) : 0,
      peakCapital: this.peakCapital,
      minCapital: this.minCapital,
      maxDrawdown: this.maxDrawdown,
      maxConcurrentPositions: this.maxConcurrentPositions,
      avgConcurrentPositions: avgPositions.toFixed(2),
    };
  }
}

// ============================================================================
// MAIN BACKTEST
// ============================================================================

async function main() {
  console.log('═'.repeat(90));
  console.log('🔬 BACKTEST MULTI-AGENT V2 - Position Size Fixe (Réaliste)');
  console.log('═'.repeat(90));
  console.log(`\n💰 Capital Initial: $${INITIAL_CAPITAL}`);
  console.log(`📊 Position Size FIXE: $${CONFIG.FIXED_POSITION_SIZE} par trade`);
  console.log(`🔢 Max Positions Simultanées: ${CONFIG.MAX_POSITIONS}`);
  console.log(`📈 Leverage: ${CONFIG.LEVERAGE}x`);
  console.log(`🪙 Agents/Symboles: ${SYMBOLS.length}`);
  
  console.log('\n📂 Chargement des données...');
  const allData = loadLocalData(SYMBOLS);
  
  const btcCandles = allData['BTC/USDT:USDT'];
  if (!btcCandles) { console.error('❌ BTC data required'); return; }
  const btcCloses = btcCandles.map(c => c.close);
  
  const pool = new CapitalPool(INITIAL_CAPITAL);
  
  const agents = {};
  SYMBOLS.forEach(s => {
    agents[s] = { position: null, cooldown: 0, trades: [], signals: 0, executed: 0, rejected: 0 };
  });
  
  const allTrades = [];
  const monthlyPnl = {};
  const weeklyCapital = [];
  let lastWeek = '';
  
  console.log('\n⏳ Running backtest...\n');
  
  for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
    const btcPrice = btcCloses[btcIdx - 1];
    const isBullRegime = btcPrice > btcSma200;
    const isBearRegime = btcPrice < btcSma200;
    
    const timestamp = btcCandle.timestamp;
    const date = new Date(timestamp);
    const month = date.toISOString().slice(0, 7);
    const week = `${date.getFullYear()}-W${Math.ceil((date.getDate() + new Date(date.getFullYear(), date.getMonth(), 1).getDay()) / 7)}`;
    
    if (!monthlyPnl[month]) monthlyPnl[month] = { pnl: 0, trades: 0, rejected: 0 };
    
    if (week !== lastWeek) {
      weeklyCapital.push({ week, capital: pool.totalCapital, positions: pool.getPositionCount() });
      lastWeek = week;
    }
    
    for (const symbol of SYMBOLS) {
      const candles = allData[symbol];
      if (!candles) continue;
      
      const idx = candles.findIndex(c => c.timestamp >= timestamp);
      if (idx < 50) continue;
      
      const agent = agents[symbol];
      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];
      
      // MANAGE EXISTING POSITION
      if (agent.position) {
        const pos = agent.position;
        const holdBars = idx - pos.entryIdx;
        let exitReason = null, exitPrice = current.close;
        
        if (pos.side === 'long') {
          const pnlPct = ((current.close - pos.entryPrice) / pos.entryPrice) * 100;
          pos.hwm = Math.max(pos.hwm || pos.entryPrice, current.high);
          const hwmPct = ((pos.hwm - pos.entryPrice) / pos.entryPrice) * 100;
          
          if (pnlPct <= -CONFIG.EXIT.STOP_LOSS) { exitReason = 'SL'; exitPrice = pos.entryPrice * (1 - CONFIG.EXIT.STOP_LOSS / 100); }
          else if (pnlPct >= CONFIG.EXIT.TAKE_PROFIT) { exitReason = 'TP'; exitPrice = pos.entryPrice * (1 + CONFIG.EXIT.TAKE_PROFIT / 100); }
          else if (hwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION && current.low <= pos.hwm * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100)) { exitReason = 'TRAIL'; exitPrice = pos.hwm * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100); }
          else if (holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) { exitReason = 'TIME'; }
        } else {
          const pnlPct = ((pos.entryPrice - current.close) / pos.entryPrice) * 100;
          pos.lwm = Math.min(pos.lwm || pos.entryPrice, current.low);
          const lwmPct = ((pos.entryPrice - pos.lwm) / pos.entryPrice) * 100;
          
          if (pnlPct <= -CONFIG.EXIT.STOP_LOSS) { exitReason = 'SL'; exitPrice = pos.entryPrice * (1 + CONFIG.EXIT.STOP_LOSS / 100); }
          else if (pnlPct >= CONFIG.EXIT.TAKE_PROFIT) { exitReason = 'TP'; exitPrice = pos.entryPrice * (1 - CONFIG.EXIT.TAKE_PROFIT / 100); }
          else if (lwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION && current.high >= pos.lwm * (1 + CONFIG.EXIT.TRAILING_DISTANCE / 100)) { exitReason = 'TRAIL'; exitPrice = pos.lwm * (1 + CONFIG.EXIT.TRAILING_DISTANCE / 100); }
          else if (holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) { exitReason = 'TIME'; }
        }
        
        if (exitReason) {
          const pnl = calculatePnl(pos.entryPrice, exitPrice, pos.side, pos.marginUsed, holdBars);
          pool.closePosition(symbol, pnl.netPnlUsd);
          
          const trade = {
            symbol, side: pos.side, entryPrice: pos.entryPrice, exitPrice, holdBars,
            marginUsed: pos.marginUsed, netPnlPct: pnl.netPnlPct, netPnlUsd: pnl.netPnlUsd,
            exitReason, capitalAfter: pool.totalCapital, month,
          };
          
          agent.trades.push(trade);
          allTrades.push(trade);
          monthlyPnl[month].pnl += pnl.netPnlUsd;
          monthlyPnl[month].trades++;
          
          agent.position = null;
          agent.cooldown = 8;
        }
      }
      
      // CHECK FOR NEW ENTRY
      if (!agent.position && agent.cooldown <= 0) {
        let signal = null;
        
        if (isBullRegime && checkLongEntry(windowCandles)) signal = 'long';
        else if (isBearRegime && checkShortEntry(windowCandles)) signal = 'short';
        
        if (signal) {
          agent.signals++;
          
          const opened = pool.openPosition(symbol, {
            side: signal, entryPrice: current.close, entryIdx: idx, entryTime: timestamp,
          });
          
          if (opened) {
            agent.executed++;
            agent.position = {
              side: signal, entryPrice: current.close, entryIdx: idx, entryTime: timestamp,
              marginUsed: CONFIG.FIXED_POSITION_SIZE,
              hwm: signal === 'long' ? current.close : undefined,
              lwm: signal === 'short' ? current.close : undefined,
            };
          } else {
            agent.rejected++;
            monthlyPnl[month].rejected++;
          }
        }
      }
      
      if (agent.cooldown > 0) agent.cooldown--;
    }
  }
  
  // ============================================================================
  // RESULTS
  // ============================================================================
  
  const poolStats = pool.getStats();
  
  console.log('\n' + '═'.repeat(90));
  console.log('📊 RÉSULTATS - 12 Agents, $2000 Capital Partagé, Position Fixe $200');
  console.log('═'.repeat(90));
  
  console.log(`
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                                 PERFORMANCE GLOBALE                                       │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  💰 Capital: $${INITIAL_CAPITAL} → $${poolStats.totalCapital.toFixed(0).padStart(6)}                                                  │
│  📈 ROI:     ${poolStats.roi >= 0 ? '+' : ''}${poolStats.roi.toFixed(1)}% sur 24 mois                                                     │
│  💹 ROI/an: ~${(poolStats.roi / 2).toFixed(1)}%                                                                │
│  📉 Max DD:  ${poolStats.maxDrawdown.toFixed(1)}%                                                                  │
│  🏆 Peak:    $${poolStats.peakCapital.toFixed(0)}                                                                   │
│  📉 Min:     $${poolStats.minCapital.toFixed(0)}                                                                   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
`);

  console.log(`
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                            GESTION DU CAPITAL PARTAGÉ                                     │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  📊 Signaux totaux:         ${String(poolStats.totalOrders).padStart(5)}                                                   │
│  ✅ Ordres exécutés:        ${String(poolStats.totalOrders - poolStats.rejectedOrders).padStart(5)} (${(100 - poolStats.rejectionRate).toFixed(1)}%)                                         │
│  ❌ Ordres rejetés:         ${String(poolStats.rejectedOrders).padStart(5)} (${poolStats.rejectionRate.toFixed(1)}%)                                           │
│                                                                                           │
│  🔢 Max positions simult.:  ${String(poolStats.maxConcurrentPositions).padStart(5)} / ${CONFIG.MAX_POSITIONS}                                                │
│  📊 Avg positions simult.:  ${poolStats.avgConcurrentPositions.padStart(5)}                                                   │
│                                                                                           │
│  💵 Capital utilisé/trade:  $${CONFIG.FIXED_POSITION_SIZE} (fixe)                                              │
│  💵 Exposition max:         $${CONFIG.FIXED_POSITION_SIZE * CONFIG.MAX_POSITIONS} (${CONFIG.MAX_POSITIONS} × $${CONFIG.FIXED_POSITION_SIZE})                                        │
└──────────────────────────────────────────────────────────────────────────────────────────┘
`);

  // Symbol stats
  console.log('\n📊 PERFORMANCE PAR SYMBOLE (trié par PnL):');
  console.log('─'.repeat(95));
  console.log('  Symbol           │ Trades │ Signaux │ Rejetés │  WR%  │    PnL     │ Avg Trade │ Contrib%');
  console.log('─'.repeat(95));
  
  const symbolStats = SYMBOLS.map(symbol => {
    const agent = agents[symbol];
    const wins = agent.trades.filter(t => t.netPnlPct > 0).length;
    const pnl = agent.trades.reduce((a, t) => a + t.netPnlUsd, 0);
    const wr = agent.trades.length > 0 ? (wins / agent.trades.length * 100) : 0;
    const avgTrade = agent.trades.length > 0 ? (pnl / agent.trades.length) : 0;
    return { symbol, trades: agent.trades.length, signals: agent.signals, rejected: agent.rejected, wr, pnl, avgTrade };
  }).sort((a, b) => b.pnl - a.pnl);
  
  const totalPnl = symbolStats.reduce((a, s) => a + s.pnl, 0);
  
  for (const s of symbolStats) {
    const contrib = totalPnl !== 0 ? (s.pnl / Math.abs(totalPnl) * 100) : 0;
    const pnlStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(0)}` : `-$${Math.abs(s.pnl).toFixed(0)}`;
    const avgStr = s.avgTrade >= 0 ? `+$${s.avgTrade.toFixed(2)}` : `-$${Math.abs(s.avgTrade).toFixed(2)}`;
    console.log(`  ${s.symbol.padEnd(16)} │  ${String(s.trades).padStart(4)}  │   ${String(s.signals).padStart(4)}  │   ${String(s.rejected).padStart(4)}  │ ${s.wr.toFixed(0).padStart(5)} │ ${pnlStr.padStart(10)} │ ${avgStr.padStart(9)} │ ${contrib >= 0 ? '+' : ''}${contrib.toFixed(1).padStart(6)}%`);
  }
  
  // Monthly breakdown
  console.log('\n\n📅 PERFORMANCE MENSUELLE:');
  console.log('─'.repeat(75));
  console.log('  Mois      │    PnL     │ Trades │ Rejetés │   Capital   │   ROI');
  console.log('─'.repeat(75));
  
  const months = Object.keys(monthlyPnl).sort();
  let cumulCapital = INITIAL_CAPITAL;
  let positiveMonths = 0;
  
  for (const m of months) {
    const data = monthlyPnl[m];
    cumulCapital += data.pnl;
    const roi = ((cumulCapital - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100);
    const pnlStr = data.pnl >= 0 ? `+$${data.pnl.toFixed(0)}` : `-$${Math.abs(data.pnl).toFixed(0)}`;
    if (data.pnl > 0) positiveMonths++;
    console.log(`  ${m}  │ ${pnlStr.padStart(10)} │  ${String(data.trades).padStart(4)}  │   ${String(data.rejected).padStart(4)}  │ $${cumulCapital.toFixed(0).padStart(9)} │ ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`);
  }
  
  // Global stats
  const wins = allTrades.filter(t => t.netPnlPct > 0).length;
  const winRate = allTrades.length > 0 ? (wins / allTrades.length * 100) : 0;
  const avgWin = allTrades.filter(t => t.netPnlPct > 0).reduce((a, t) => a + t.netPnlUsd, 0) / wins;
  const losses = allTrades.filter(t => t.netPnlPct <= 0);
  const avgLoss = losses.reduce((a, t) => a + Math.abs(t.netPnlUsd), 0) / losses.length;
  const profitFactor = losses.length > 0 ? (avgWin * wins) / (avgLoss * losses.length) : 0;
  
  const exitReasons = {};
  allTrades.forEach(t => { exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1; });
  
  console.log('\n\n📊 STATISTIQUES DÉTAILLÉES:');
  console.log('─'.repeat(60));
  console.log(`  Trades totaux:   ${allTrades.length}`);
  console.log(`  Win Rate:        ${winRate.toFixed(1)}%`);
  console.log(`  Mois positifs:   ${positiveMonths}/${months.length} (${(positiveMonths/months.length*100).toFixed(0)}%)`);
  console.log(`  Avg Win:         +$${avgWin.toFixed(2)}`);
  console.log(`  Avg Loss:        -$${avgLoss.toFixed(2)}`);
  console.log(`  Profit Factor:   ${profitFactor.toFixed(2)}`);
  console.log(`  Avg trade PnL:   $${(totalPnl / allTrades.length).toFixed(2)}`);
  
  console.log('\n  Raisons de sortie:');
  for (const [reason, count] of Object.entries(exitReasons)) {
    console.log(`    ${reason.padEnd(6)}: ${String(count).padStart(4)} (${(count/allTrades.length*100).toFixed(1)}%)`);
  }
  
  // CAPACITÉ ANALYSE
  console.log('\n\n' + '═'.repeat(90));
  console.log('💡 ANALYSE: PEUT-ON GÉRER 12 AGENTS SUR $2000?');
  console.log('═'.repeat(90));
  
  console.log(`
  ✅ VERDICT: ${poolStats.rejectionRate < 30 ? 'OUI' : poolStats.rejectionRate < 50 ? 'LIMITE' : 'NON'} - Le système peut gérer 12 agents
  
  📊 DONNÉES:
     - Taux de rejet: ${poolStats.rejectionRate.toFixed(1)}%
     - Max positions simultanées: ${poolStats.maxConcurrentPositions}/${CONFIG.MAX_POSITIONS}
     - Avg positions: ${poolStats.avgConcurrentPositions}
  
  💰 PROJECTION ANNUELLE (basée sur 24 mois):
     - ROI/an moyen: ~${(poolStats.roi / 2).toFixed(1)}%
     - PnL/an moyen: ~$${(totalPnl / 2).toFixed(0)}
     - PnL/mois moyen: ~$${(totalPnl / 24).toFixed(0)}
  
  📈 AVEC $2000 ET 12 AGENTS:
     - Position size: $${CONFIG.FIXED_POSITION_SIZE}/trade
     - Max exposition: $${CONFIG.FIXED_POSITION_SIZE * CONFIG.MAX_POSITIONS}
     - Capital de réserve: $${INITIAL_CAPITAL - CONFIG.FIXED_POSITION_SIZE * CONFIG.MAX_POSITIONS}
`);

  if (poolStats.rejectionRate > 40) {
    console.log(`  ⚠️  RECOMMANDATIONS:
     - Taux de rejet élevé (${poolStats.rejectionRate.toFixed(1)}%)
     - Options:
       1. Augmenter capital à $3000-4000
       2. Réduire à 6-8 agents (les meilleurs)
       3. Réduire position size à $150/trade`);
  } else if (poolStats.rejectionRate > 20) {
    console.log(`  ⚡ RECOMMANDATIONS:
     - Taux de rejet modéré (${poolStats.rejectionRate.toFixed(1)}%)
     - Configuration actuelle acceptable
     - Possible d'augmenter à $250/trade avec $2500`);
  } else {
    console.log(`  ✅ RECOMMANDATIONS:
     - Taux de rejet faible (${poolStats.rejectionRate.toFixed(1)}%)
     - Marge disponible pour augmenter position size
     - Possible d'augmenter à $300/trade`);
  }
  
  // Best 6 agents
  const best6 = symbolStats.slice(0, 6);
  const best6Pnl = best6.reduce((a, s) => a + s.pnl, 0);
  const best6Trades = best6.reduce((a, s) => a + s.trades, 0);
  
  console.log(`\n  📊 TOP 6 AGENTS (meilleure option si capital limité):
     - Symboles: ${best6.map(s => s.symbol.replace('/USDT:USDT', '')).join(', ')}
     - PnL combiné: $${best6Pnl.toFixed(0)} vs $${totalPnl.toFixed(0)} (12 agents)
     - Trades: ${best6Trades} vs ${allTrades.length}
     - Moins de rejets, meilleure utilisation du capital`);
  
  // Save results
  const outputPath = path.join(DATA_DIR, '..', 'multiagent-v2-results.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    config: { initialCapital: INITIAL_CAPITAL, positionSize: CONFIG.FIXED_POSITION_SIZE, maxPositions: CONFIG.MAX_POSITIONS, leverage: CONFIG.LEVERAGE },
    results: poolStats,
    bySymbol: symbolStats,
    monthlyPnl,
    trades: allTrades.length,
    winRate,
    profitFactor,
  }, null, 2));
  
  console.log(`\n\n📁 Résultats: ${outputPath}`);
}

main().catch(console.error);
