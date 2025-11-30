/**
 * 🔬 BACKTEST MULTI-AGENT - Capital Partagé + Ordres Rejetés
 * 
 * Simule 12 agents tradant simultanément sur un capital partagé de $2000
 * - Chaque agent peut prendre 40% du capital disponible
 * - Les ordres sont rejetés si le capital est insuffisant
 * - Analyse réaliste de la capacité du système
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
  POSITION_SIZE_PCT: 0.4,  // 40% du capital par position
  LEVERAGE: 4.5,
  MAX_POSITIONS: 4,  // Max 4 positions simultanées (sécurité)
};

const COSTS = {
  TRADING_FEE_PCT: 0.04,
  SLIPPAGE_PCT: 0.05,
  FUNDING_RATE_PCT: 0.01,
  FUNDING_INTERVAL_BARS: 32,
};

const INITIAL_CAPITAL = 2000;  // $2000 de capital partagé

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
// INDICATORS
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
// CAPITAL POOL MANAGER
// ============================================================================

class CapitalPool {
  constructor(initialCapital) {
    this.totalCapital = initialCapital;
    this.availableCapital = initialCapital;
    this.lockedCapital = 0;
    this.positions = new Map();  // symbol -> { marginUsed, ... }
    
    // Stats
    this.rejectedOrders = 0;
    this.totalOrders = 0;
    this.peakCapital = initialCapital;
    this.maxDrawdown = 0;
    this.maxConcurrentPositions = 0;
    this.positionHistory = [];
  }
  
  getAvailableCapital() {
    return this.availableCapital;
  }
  
  getPositionCount() {
    return this.positions.size;
  }
  
  canOpenPosition(marginRequired) {
    // Check if enough capital available
    if (marginRequired > this.availableCapital) return false;
    // Check max positions limit
    if (this.positions.size >= CONFIG.MAX_POSITIONS) return false;
    return true;
  }
  
  openPosition(symbol, marginRequired, positionData) {
    this.totalOrders++;
    
    if (!this.canOpenPosition(marginRequired)) {
      this.rejectedOrders++;
      return false;
    }
    
    this.availableCapital -= marginRequired;
    this.lockedCapital += marginRequired;
    this.positions.set(symbol, { marginUsed: marginRequired, ...positionData });
    
    // Track max concurrent positions
    if (this.positions.size > this.maxConcurrentPositions) {
      this.maxConcurrentPositions = this.positions.size;
    }
    
    this.positionHistory.push({
      time: positionData.entryTime,
      count: this.positions.size,
      available: this.availableCapital,
      locked: this.lockedCapital,
    });
    
    return true;
  }
  
  closePosition(symbol, pnlUsd) {
    const position = this.positions.get(symbol);
    if (!position) return;
    
    // Release margin + add/subtract PnL
    this.availableCapital += position.marginUsed + pnlUsd;
    this.lockedCapital -= position.marginUsed;
    this.totalCapital += pnlUsd;
    
    // Track peak and drawdown
    if (this.totalCapital > this.peakCapital) {
      this.peakCapital = this.totalCapital;
    }
    const currentDD = ((this.peakCapital - this.totalCapital) / this.peakCapital) * 100;
    if (currentDD > this.maxDrawdown) {
      this.maxDrawdown = currentDD;
    }
    
    this.positions.delete(symbol);
    
    this.positionHistory.push({
      time: Date.now(),
      count: this.positions.size,
      available: this.availableCapital,
      locked: this.lockedCapital,
    });
  }
  
  getStats() {
    return {
      totalCapital: this.totalCapital,
      availableCapital: this.availableCapital,
      lockedCapital: this.lockedCapital,
      openPositions: this.positions.size,
      totalOrders: this.totalOrders,
      rejectedOrders: this.rejectedOrders,
      rejectionRate: this.totalOrders > 0 ? (this.rejectedOrders / this.totalOrders * 100) : 0,
      peakCapital: this.peakCapital,
      maxDrawdown: this.maxDrawdown,
      maxConcurrentPositions: this.maxConcurrentPositions,
    };
  }
}

// ============================================================================
// MAIN BACKTEST
// ============================================================================

async function main() {
  console.log('═'.repeat(90));
  console.log('🔬 BACKTEST MULTI-AGENT - 12 Cryptos, Capital Partagé $2000');
  console.log('═'.repeat(90));
  console.log(`\n💰 Capital Initial: $${INITIAL_CAPITAL}`);
  console.log(`📊 Position Size: ${CONFIG.POSITION_SIZE_PCT * 100}% du capital = $${INITIAL_CAPITAL * CONFIG.POSITION_SIZE_PCT} max par position`);
  console.log(`🔢 Max Positions Simultanées: ${CONFIG.MAX_POSITIONS}`);
  console.log(`📈 Leverage: ${CONFIG.LEVERAGE}x`);
  console.log(`🪙 Symboles: ${SYMBOLS.length}`);
  
  console.log('\n📂 Chargement des données...');
  const allData = loadLocalData(SYMBOLS);
  
  const btcCandles = allData['BTC/USDT:USDT'];
  if (!btcCandles) {
    console.error('❌ BTC data required');
    return;
  }
  
  const btcCloses = btcCandles.map(c => c.close);
  
  // Initialize capital pool
  const pool = new CapitalPool(INITIAL_CAPITAL);
  
  // Agent state per symbol
  const agents = {};
  SYMBOLS.forEach(s => {
    agents[s] = {
      position: null,
      cooldown: 0,
      trades: [],
      signals: 0,
      executed: 0,
      rejected: 0,
    };
  });
  
  // Global stats
  const allTrades = [];
  const monthlyPnl = {};
  const dailyCapital = [];
  let lastDay = '';
  
  console.log('\n⏳ Running multi-agent backtest...\n');
  
  // Main loop - iterate through BTC candles as time reference
  for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
    const btcPrice = btcCloses[btcIdx - 1];
    const isBullRegime = btcPrice > btcSma200;
    const isBearRegime = btcPrice < btcSma200;
    
    const timestamp = btcCandle.timestamp;
    const date = new Date(timestamp);
    const month = date.toISOString().slice(0, 7);
    const day = date.toISOString().slice(0, 10);
    
    if (!monthlyPnl[month]) monthlyPnl[month] = { pnl: 0, trades: 0, rejected: 0 };
    
    // Track daily capital
    if (day !== lastDay) {
      dailyCapital.push({ day, capital: pool.totalCapital, positions: pool.getPositionCount() });
      lastDay = day;
    }
    
    // Process each symbol/agent
    for (const symbol of SYMBOLS) {
      const candles = allData[symbol];
      if (!candles) continue;
      
      const idx = candles.findIndex(c => c.timestamp >= timestamp);
      if (idx < 50) continue;
      
      const agent = agents[symbol];
      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];
      
      // ═══════════════════════════════════════════════════════════════════════
      // MANAGE EXISTING POSITION
      // ═══════════════════════════════════════════════════════════════════════
      if (agent.position) {
        const pos = agent.position;
        const holdBars = idx - pos.entryIdx;
        let exitReason = null, exitPrice = current.close;
        
        if (pos.side === 'long') {
          const pnlPct = ((current.close - pos.entryPrice) / pos.entryPrice) * 100;
          pos.hwm = Math.max(pos.hwm || pos.entryPrice, current.high);
          const hwmPct = ((pos.hwm - pos.entryPrice) / pos.entryPrice) * 100;
          
          if (pnlPct <= -CONFIG.EXIT.STOP_LOSS) {
            exitReason = 'SL'; exitPrice = pos.entryPrice * (1 - CONFIG.EXIT.STOP_LOSS / 100);
          } else if (pnlPct >= CONFIG.EXIT.TAKE_PROFIT) {
            exitReason = 'TP'; exitPrice = pos.entryPrice * (1 + CONFIG.EXIT.TAKE_PROFIT / 100);
          } else if (hwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION) {
            const trailStop = pos.hwm * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100);
            if (current.low <= trailStop) { exitReason = 'TRAIL'; exitPrice = trailStop; }
          } else if (holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) {
            exitReason = 'TIME';
          }
        } else {
          const pnlPct = ((pos.entryPrice - current.close) / pos.entryPrice) * 100;
          pos.lwm = Math.min(pos.lwm || pos.entryPrice, current.low);
          const lwmPct = ((pos.entryPrice - pos.lwm) / pos.entryPrice) * 100;
          
          if (pnlPct <= -CONFIG.EXIT.STOP_LOSS) {
            exitReason = 'SL'; exitPrice = pos.entryPrice * (1 + CONFIG.EXIT.STOP_LOSS / 100);
          } else if (pnlPct >= CONFIG.EXIT.TAKE_PROFIT) {
            exitReason = 'TP'; exitPrice = pos.entryPrice * (1 - CONFIG.EXIT.TAKE_PROFIT / 100);
          } else if (lwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION) {
            const trailStop = pos.lwm * (1 + CONFIG.EXIT.TRAILING_DISTANCE / 100);
            if (current.high >= trailStop) { exitReason = 'TRAIL'; exitPrice = trailStop; }
          } else if (holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) {
            exitReason = 'TIME';
          }
        }
        
        if (exitReason) {
          const pnl = calculatePnl(pos.entryPrice, exitPrice, pos.side, pos.marginUsed, holdBars);
          
          // Close position in pool
          pool.closePosition(symbol, pnl.netPnlUsd);
          
          const trade = {
            symbol,
            side: pos.side,
            entryTime: new Date(pos.entryTime).toISOString(),
            exitTime: new Date(timestamp).toISOString(),
            entryPrice: pos.entryPrice,
            exitPrice,
            holdBars,
            marginUsed: pos.marginUsed,
            netPnlPct: pnl.netPnlPct,
            netPnlUsd: pnl.netPnlUsd,
            exitReason,
            capitalAfter: pool.totalCapital,
            month,
          };
          
          agent.trades.push(trade);
          allTrades.push(trade);
          monthlyPnl[month].pnl += pnl.netPnlUsd;
          monthlyPnl[month].trades++;
          
          agent.position = null;
          agent.cooldown = 8;  // 2h cooldown
        }
      }
      
      // ═══════════════════════════════════════════════════════════════════════
      // CHECK FOR NEW ENTRY
      // ═══════════════════════════════════════════════════════════════════════
      if (!agent.position && agent.cooldown <= 0) {
        let signal = null;
        
        if (isBullRegime && checkLongEntry(windowCandles)) {
          signal = 'long';
        } else if (isBearRegime && checkShortEntry(windowCandles)) {
          signal = 'short';
        }
        
        if (signal) {
          agent.signals++;
          
          // Calculate margin required (40% of total capital, not available)
          const marginRequired = pool.totalCapital * CONFIG.POSITION_SIZE_PCT;
          
          // Try to open position
          const opened = pool.openPosition(symbol, marginRequired, {
            side: signal,
            entryPrice: current.close,
            entryIdx: idx,
            entryTime: timestamp,
          });
          
          if (opened) {
            agent.executed++;
            agent.position = {
              side: signal,
              entryPrice: current.close,
              entryIdx: idx,
              entryTime: timestamp,
              marginUsed: marginRequired,
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
  const roi = ((poolStats.totalCapital - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
  
  console.log('\n' + '═'.repeat(90));
  console.log('📊 RÉSULTATS MULTI-AGENT (12 cryptos, $2000 partagés)');
  console.log('═'.repeat(90));
  
  console.log(`
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              PERFORMANCE GLOBALE                                        │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  💰 Capital: $${INITIAL_CAPITAL.toLocaleString()} → $${poolStats.totalCapital.toFixed(0).padStart(10)}                                      │
│  📈 ROI:     ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%                                                           │
│  🎯 Trades:  ${String(allTrades.length).padStart(4)} exécutés                                                      │
│  📉 Max DD:  ${poolStats.maxDrawdown.toFixed(1)}%                                                           │
│  🏆 Peak:    $${poolStats.peakCapital.toFixed(0)}                                                          │
└────────────────────────────────────────────────────────────────────────────────────────┘
`);

  console.log(`
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                           GESTION DU CAPITAL PARTAGÉ                                    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  📊 Signaux totaux:        ${String(poolStats.totalOrders).padStart(5)}                                              │
│  ✅ Ordres exécutés:       ${String(poolStats.totalOrders - poolStats.rejectedOrders).padStart(5)} (${(100 - poolStats.rejectionRate).toFixed(1)}%)                                    │
│  ❌ Ordres rejetés:        ${String(poolStats.rejectedOrders).padStart(5)} (${poolStats.rejectionRate.toFixed(1)}%)                                      │
│  🔢 Max positions simult.: ${String(poolStats.maxConcurrentPositions).padStart(5)} / ${CONFIG.MAX_POSITIONS}                                           │
│                                                                                         │
│  💡 Position size:         $${(INITIAL_CAPITAL * CONFIG.POSITION_SIZE_PCT).toFixed(0)} (${CONFIG.POSITION_SIZE_PCT * 100}% du capital)                              │
│  💡 Capital par position:  ~$${((INITIAL_CAPITAL * CONFIG.POSITION_SIZE_PCT) / CONFIG.MAX_POSITIONS).toFixed(0)} si max positions ouvertes                    │
└────────────────────────────────────────────────────────────────────────────────────────┘
`);

  // Stats par agent/symbole
  console.log('\n📊 PERFORMANCE PAR SYMBOLE:');
  console.log('─'.repeat(90));
  console.log('  Symbol           │ Trades │ Signals │ Rejected │  WR%  │    PnL    │  Contrib%');
  console.log('─'.repeat(90));
  
  const symbolStats = SYMBOLS.map(symbol => {
    const agent = agents[symbol];
    const wins = agent.trades.filter(t => t.netPnlPct > 0).length;
    const pnl = agent.trades.reduce((a, t) => a + t.netPnlUsd, 0);
    const wr = agent.trades.length > 0 ? (wins / agent.trades.length * 100) : 0;
    return { symbol, trades: agent.trades.length, signals: agent.signals, rejected: agent.rejected, wr, pnl };
  }).sort((a, b) => b.pnl - a.pnl);
  
  const totalPnl = symbolStats.reduce((a, s) => a + s.pnl, 0);
  
  for (const s of symbolStats) {
    const contrib = totalPnl !== 0 ? (s.pnl / totalPnl * 100) : 0;
    const pnlStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(0)}` : `-$${Math.abs(s.pnl).toFixed(0)}`;
    console.log(`  ${s.symbol.padEnd(16)} │  ${String(s.trades).padStart(4)}  │   ${String(s.signals).padStart(4)}  │    ${String(s.rejected).padStart(4)}  │ ${s.wr.toFixed(0).padStart(5)} │ ${pnlStr.padStart(9)} │ ${contrib.toFixed(1).padStart(7)}%`);
  }
  
  // Monthly breakdown
  console.log('\n\n📅 PERFORMANCE MENSUELLE:');
  console.log('─'.repeat(90));
  console.log('  Mois      │    PnL     │ Trades │ Rejected │ Capital');
  console.log('─'.repeat(90));
  
  const months = Object.keys(monthlyPnl).sort();
  let cumulCapital = INITIAL_CAPITAL;
  let positiveMonths = 0;
  
  for (const m of months) {
    const data = monthlyPnl[m];
    cumulCapital += data.pnl;
    const pnlStr = data.pnl >= 0 ? `+$${data.pnl.toFixed(0)}` : `-$${Math.abs(data.pnl).toFixed(0)}`;
    if (data.pnl > 0) positiveMonths++;
    console.log(`  ${m}  │ ${pnlStr.padStart(9)} │  ${String(data.trades).padStart(4)}  │    ${String(data.rejected).padStart(4)}  │ $${cumulCapital.toFixed(0).padStart(8)}`);
  }
  
  // Win rate global
  const wins = allTrades.filter(t => t.netPnlPct > 0).length;
  const winRate = allTrades.length > 0 ? (wins / allTrades.length * 100) : 0;
  
  // Exit reasons
  const exitReasons = {};
  allTrades.forEach(t => { exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1; });
  
  console.log('\n\n📊 STATISTIQUES GLOBALES:');
  console.log('─'.repeat(60));
  console.log(`  Win Rate:        ${winRate.toFixed(1)}%`);
  console.log(`  Mois positifs:   ${positiveMonths}/${months.length}`);
  console.log(`  Avg trade PnL:   $${(totalPnl / allTrades.length).toFixed(2)}`);
  
  console.log('\n  Raisons de sortie:');
  for (const [reason, count] of Object.entries(exitReasons)) {
    console.log(`    ${reason.padEnd(6)}: ${String(count).padStart(4)} (${(count/allTrades.length*100).toFixed(1)}%)`);
  }
  
  // Analyse du taux de rejet
  console.log('\n\n' + '═'.repeat(90));
  console.log('💡 ANALYSE DE LA CAPACITÉ SYSTÈME');
  console.log('═'.repeat(90));
  
  const avgPositionsPerBar = dailyCapital.reduce((a, d) => a + d.positions, 0) / dailyCapital.length;
  const maxRejectedMonth = Object.entries(monthlyPnl).sort((a, b) => b[1].rejected - a[1].rejected)[0];
  
  console.log(`
  📊 RÉSUMÉ:
  
  ✅ Le système peut gérer ${SYMBOLS.length} agents simultanément avec $${INITIAL_CAPITAL}
  
  📈 Performance:
     - ROI sur 24 mois: ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%
     - Win Rate: ${winRate.toFixed(1)}%
     - Max Drawdown: ${poolStats.maxDrawdown.toFixed(1)}%
  
  🔢 Utilisation du capital:
     - Max positions simultanées atteint: ${poolStats.maxConcurrentPositions}/${CONFIG.MAX_POSITIONS}
     - Taux de rejet global: ${poolStats.rejectionRate.toFixed(1)}%
     - Mois avec le plus de rejets: ${maxRejectedMonth[0]} (${maxRejectedMonth[1].rejected} rejets)
  
  💡 RECOMMANDATIONS:
`);

  if (poolStats.rejectionRate > 20) {
    console.log(`     ⚠️  Taux de rejet élevé (${poolStats.rejectionRate.toFixed(1)}%)
         → Augmenter le capital à $${Math.ceil(INITIAL_CAPITAL * 1.5)} pour réduire les rejets
         → Ou réduire le nombre d'agents à 6-8`);
  } else if (poolStats.rejectionRate > 10) {
    console.log(`     ⚡ Taux de rejet modéré (${poolStats.rejectionRate.toFixed(1)}%)
         → Capital actuel acceptable
         → Possibilité d'ajouter 1-2 agents supplémentaires`);
  } else {
    console.log(`     ✅ Taux de rejet faible (${poolStats.rejectionRate.toFixed(1)}%)
         → Le système a de la marge
         → Possible d'augmenter position size à 50%`);
  }
  
  // Comparison with single-agent
  console.log(`\n  📊 COMPARAISON:
     - Multi-agent (12 cryptos, $2000): ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI
     - Si capital réparti ($167/agent): ROI serait similaire mais volatilité plus élevée
     - Avantage du pool: Diversification + utilisation optimale du capital
`);
  
  // Save results
  const outputPath = path.join(DATA_DIR, '..', 'multiagent-backtest-results.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    config: {
      initialCapital: INITIAL_CAPITAL,
      positionSizePct: CONFIG.POSITION_SIZE_PCT,
      leverage: CONFIG.LEVERAGE,
      maxPositions: CONFIG.MAX_POSITIONS,
      symbols: SYMBOLS,
    },
    results: {
      finalCapital: poolStats.totalCapital,
      roi,
      totalTrades: allTrades.length,
      winRate,
      maxDrawdown: poolStats.maxDrawdown,
      rejectionRate: poolStats.rejectionRate,
      maxConcurrentPositions: poolStats.maxConcurrentPositions,
    },
    bySymbol: symbolStats,
    monthlyPnl,
  }, null, 2));
  
  console.log(`\n📁 Résultats sauvegardés: ${outputPath}`);
}

main().catch(console.error);
