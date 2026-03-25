/**
 * COMPARE EXIT STRATEGIES - Backtest Comparatif
 * ==============================================
 *
 * Compare 3 stratégies de sortie trailing pour mesurer l'impact sur la performance:
 *
 * 1. BASELINE (actuel): 2 closes confirmation, exit au trailing stop exact
 * 2. NFS_HYBRID: Si NFS >= 70 → 1 close, sinon 2 closes
 * 3. REALTIME_SIM: Simule sortie intra-candle au premier touch du trailing stop
 *
 * L'objectif est de déterminer quelle approche maximise la parité avec le backtest idéal.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Trade {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  exitPrice: number;
  exitTime: number;
  exitReason: string;
  pnlPct: number;
  holdBars: number;
  nfsScore?: number;
}

interface SimPosition {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  entryIdx: number;
  entryTime: number;
  highWaterMark: number;
  lowWaterMark: number;
  trailingActive: boolean;
  trailingBreachCandles: number;
  stopLossPct: number;
  maxPnlPct: number;
}

interface BacktestResult {
  strategyName: string;
  trades: Trade[];
  totalPnlPct: number;
  winRate: number;
  avgTradePnl: number;
  avgHoldBars: number;
  trailExits: number;
  slExits: number;
  avgSlippage: number; // vs ideal trailing stop price
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  SYMBOLS: [
    'BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'DOGE_USDT', 'XRP_USDT',
    'ADA_USDT', 'AVAX_USDT', 'LINK_USDT'
  ],
  START_DATE: new Date('2024-06-01'),
  END_DATE: new Date('2025-01-10'),
  DATA_DIR: path.join(process.cwd(), 'data'),

  // Trailing configuration
  TRAILING_ACTIVATION_PCT: 0.8,
  TRAILING_DISTANCE_PCT: 0.5,
  TRAILING_WIDEN_AT_PCT: 3.0,
  TRAILING_WIDE_DISTANCE_PCT: 0.8,
  STOP_LOSS_PCT: 2.5,
  MAX_HOLD_BARS: 192, // 48h

  // Entry thresholds
  ENTRY: {
    ROC_MIN_LONG: 1.75,
    ROC_MAX_SHORT: -1.5,
    VOLUME_MIN: 1.15,
  },

  // NFS Thresholds (from analysis)
  NFS: {
    BREACH_ATR_THRESHOLD: 0.40,
    BREACH_DEPTH_THRESHOLD: 0.25,
    VOLUME_THRESHOLD: 1.2,
    HIGH_CONFIDENCE_SCORE: 70,
  },

  // Slippage simulation for non-RT exits
  SLIPPAGE_PCT: 0.05, // 5 bps per trade
};

// ═══════════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════════════

function loadCandles(symbol: string): Candle[] {
  const filepath = path.join(CONFIG.DATA_DIR, `${symbol}_15m.json`);
  if (!fs.existsSync(filepath)) return [];

  const raw = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  // Handle multiple formats: array, {data: []}, {candles: []}
  const data = Array.isArray(raw) ? raw : (raw.candles || raw.data || []);

  return data.map((c: any) => ({
    timestamp: Array.isArray(c) ? c[0] : c.timestamp,
    open: Array.isArray(c) ? c[1] : c.open,
    high: Array.isArray(c) ? c[2] : c.high,
    low: Array.isArray(c) ? c[3] : c.low,
    close: Array.isArray(c) ? c[4] : c.close,
    volume: Array.isArray(c) ? c[5] : c.volume,
  })).filter((c: Candle) =>
    c.timestamp >= CONFIG.START_DATE.getTime() &&
    c.timestamp <= CONFIG.END_DATE.getTime()
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// INDICATORS
// ═══════════════════════════════════════════════════════════════════════════

function calcSMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcROC(closes: number[], period: number): number {
  if (closes.length < period + 1) return 0;
  const curr = closes[closes.length - 1];
  const prev = closes[closes.length - 1 - period];
  return prev === 0 ? 0 : ((curr - prev) / prev) * 100;
}

function calcVolRatio(volumes: number[]): number {
  if (volumes.length < 21) return 1;
  const current = volumes[volumes.length - 1];
  const avg = calcSMA(volumes.slice(0, -1), 20);
  return avg === 0 ? 1 : current / avg;
}

function calcATR(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  const trueRanges: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trueRanges.push(tr);
  }
  return trueRanges.reduce((a, b) => a + b, 0) / period;
}

// ═══════════════════════════════════════════════════════════════════════════
// NFS (NOISE FILTER SCORE) CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

interface NFSResult {
  score: number;
  exitImmediately: boolean;
  breachATRRatio: number;
  breachDepthPct: number;
  volumeRatio: number;
}

function computeNFS(
  candle: Candle,
  prevCandles: Candle[],
  side: 'long' | 'short',
  trailingStopPrice: number
): NFSResult {
  const allCandles = [...prevCandles.slice(-20), candle];
  const volumes = allCandles.map(c => c.volume);

  // Breach depth
  let breachDepthPct: number;
  let breachDepthAbs: number;
  if (side === 'long') {
    breachDepthAbs = trailingStopPrice - candle.close;
    breachDepthPct = (breachDepthAbs / trailingStopPrice) * 100;
  } else {
    breachDepthAbs = candle.close - trailingStopPrice;
    breachDepthPct = (breachDepthAbs / trailingStopPrice) * 100;
  }

  // ATR
  const atrAbs = calcATR(allCandles, 14);
  const breachATRRatio = atrAbs === 0 ? 0 : breachDepthAbs / atrAbs;

  // Volume
  const volumeRatio = calcVolRatio(volumes);

  // Score calculation (weighted)
  let score = 0;
  const maxScore = 10;

  // Breach/ATR (weight 4)
  if (breachATRRatio >= CONFIG.NFS.BREACH_ATR_THRESHOLD) score += 4;
  else if (breachATRRatio >= CONFIG.NFS.BREACH_ATR_THRESHOLD * 0.5) score += 2;

  // Breach Depth (weight 3)
  if (breachDepthPct >= CONFIG.NFS.BREACH_DEPTH_THRESHOLD) score += 3;
  else if (breachDepthPct >= CONFIG.NFS.BREACH_DEPTH_THRESHOLD * 0.5) score += 1.5;

  // Volume (weight 3)
  if (volumeRatio >= CONFIG.NFS.VOLUME_THRESHOLD) score += 3;
  else if (volumeRatio >= CONFIG.NFS.VOLUME_THRESHOLD * 0.8) score += 1.5;

  const normalizedScore = (score / maxScore) * 100;

  return {
    score: normalizedScore,
    exitImmediately: normalizedScore >= CONFIG.NFS.HIGH_CONFIDENCE_SCORE,
    breachATRRatio,
    breachDepthPct,
    volumeRatio,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXIT STRATEGY IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════

type ExitStrategy = 'BASELINE_2CLOSE' | 'NFS_HYBRID' | 'NFS_REALTIME' | 'REALTIME_NAIVE';

interface ExitCheckResult {
  shouldExit: boolean;
  exitPrice: number;
  exitReason: string;
  slippageVsIdeal: number; // % difference vs ideal trailing stop price
  nfsScore?: number;
}

function checkExit(
  pos: SimPosition,
  current: Candle,
  prevCandles: Candle[],
  strategy: ExitStrategy
): ExitCheckResult {
  const holdBars = prevCandles.length - pos.entryIdx;

  // Calculate PnL
  const pnlPct = pos.side === 'long'
    ? ((current.close - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - current.close) / pos.entryPrice) * 100;

  // Update max PnL
  pos.maxPnlPct = Math.max(pos.maxPnlPct, pnlPct);

  // Update water marks
  if (pos.side === 'long') {
    pos.highWaterMark = Math.max(pos.highWaterMark, current.high);
  } else {
    pos.lowWaterMark = Math.min(pos.lowWaterMark, current.low);
  }

  // Check stop loss
  if (pos.side === 'long') {
    const slPrice = pos.entryPrice * (1 - pos.stopLossPct / 100);
    if (current.low <= slPrice) {
      return {
        shouldExit: true,
        exitPrice: slPrice,
        exitReason: 'SL',
        slippageVsIdeal: 0,
      };
    }
  } else {
    const slPrice = pos.entryPrice * (1 + pos.stopLossPct / 100);
    if (current.high >= slPrice) {
      return {
        shouldExit: true,
        exitPrice: slPrice,
        exitReason: 'SL',
        slippageVsIdeal: 0,
      };
    }
  }

  // Check max hold time
  if (holdBars >= CONFIG.MAX_HOLD_BARS) {
    return {
      shouldExit: true,
      exitPrice: current.close,
      exitReason: 'TIME',
      slippageVsIdeal: 0,
    };
  }

  // Check trailing activation
  const hwmPct = pos.side === 'long'
    ? ((pos.highWaterMark - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - pos.lowWaterMark) / pos.entryPrice) * 100;

  if (!pos.trailingActive && hwmPct >= CONFIG.TRAILING_ACTIVATION_PCT) {
    pos.trailingActive = true;
  }

  if (!pos.trailingActive) {
    return { shouldExit: false, exitPrice: 0, exitReason: '', slippageVsIdeal: 0 };
  }

  // Calculate trailing stop
  let trailingDistance = CONFIG.TRAILING_DISTANCE_PCT;
  if (hwmPct >= CONFIG.TRAILING_WIDEN_AT_PCT) {
    trailingDistance = CONFIG.TRAILING_WIDE_DISTANCE_PCT;
  }

  let trailingStopPrice: number;
  let wickBreached: boolean;
  let closeBreached: boolean;

  if (pos.side === 'long') {
    trailingStopPrice = pos.highWaterMark * (1 - trailingDistance / 100);
    wickBreached = current.low <= trailingStopPrice;
    closeBreached = current.close <= trailingStopPrice;
  } else {
    trailingStopPrice = pos.lowWaterMark * (1 + trailingDistance / 100);
    wickBreached = current.high >= trailingStopPrice;
    closeBreached = current.close >= trailingStopPrice;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY-SPECIFIC EXIT LOGIC
  // ═══════════════════════════════════════════════════════════════════════════

  if (strategy === 'REALTIME_NAIVE') {
    // NAIVE: Sortie au premier touch du trailing (DANGEREUX - wicks!)
    // Simule un ordre LIMIT passif - se déclenche sur n'importe quel wick
    if (wickBreached) {
      return {
        shouldExit: true,
        exitPrice: trailingStopPrice,
        exitReason: 'TRAIL_NAIVE',
        slippageVsIdeal: 0,
      };
    }
  } else if (strategy === 'NFS_REALTIME') {
    // ═══════════════════════════════════════════════════════════════════════════
    // NFS REALTIME: Monitoring continu + NFS pour valider le breach intra-candle
    // ═══════════════════════════════════════════════════════════════════════════
    //
    // Simule le comportement suivant:
    // 1. WebSocket monitore le prix en continu
    // 2. Quand le prix touche le trailing stop, on calcule le NFS
    // 3. Si NFS >= seuil: market order immédiat
    // 4. Le prix de sortie est proche du trailing mais pas exact (réaliste)
    //
    if (wickBreached) {
      // Calculer le NFS avec les données disponibles à ce moment
      const nfs = computeNFS(current, prevCandles, pos.side, trailingStopPrice);

      if (nfs.exitImmediately) {
        // NFS confirme le signal → sortie immédiate avec market order
        // Le prix de sortie est réaliste: entre le trailing stop et le close
        // Plus le breach est profond (NFS élevé), plus on sort proche du trailing
        const breachRatio = Math.min(1, nfs.breachATRRatio / 0.8); // 0 to 1

        // Prix de sortie réaliste: interpolation entre trailing et close
        // Si breach profond (ratio=1): sortie proche du trailing (90% vers trailing)
        // Si breach faible (ratio=0.5): sortie à mi-chemin
        let exitPrice: number;
        if (pos.side === 'long') {
          // Pour long: trailing < close (on veut sortir haut)
          const worstPrice = Math.min(current.close, trailingStopPrice);
          const bestPrice = trailingStopPrice;
          // Plus le NFS est élevé, plus on sort proche du trailing (meilleur prix)
          const exitQuality = 0.5 + (nfs.score / 100) * 0.4; // 0.5 to 0.9
          exitPrice = worstPrice + (bestPrice - worstPrice) * exitQuality;
        } else {
          // Pour short: trailing > close (on veut sortir bas)
          const worstPrice = Math.max(current.close, trailingStopPrice);
          const bestPrice = trailingStopPrice;
          const exitQuality = 0.5 + (nfs.score / 100) * 0.4;
          exitPrice = worstPrice - (worstPrice - bestPrice) * exitQuality;
        }

        const slippage = Math.abs((exitPrice - trailingStopPrice) / trailingStopPrice) * 100;

        return {
          shouldExit: true,
          exitPrice,
          exitReason: 'TRAIL_NFS_RT',
          slippageVsIdeal: slippage,
          nfsScore: nfs.score,
        };
      } else if (closeBreached) {
        // NFS ne confirme pas mais le close breach → incrémenter compteur
        pos.trailingBreachCandles++;

        if (pos.trailingBreachCandles >= 2) {
          // Fallback: 2 closes comme backup
          const slippage = Math.abs((current.close - trailingStopPrice) / trailingStopPrice) * 100;
          return {
            shouldExit: true,
            exitPrice: current.close * (1 - CONFIG.SLIPPAGE_PCT / 100),
            exitReason: 'TRAIL_2C_FB',
            slippageVsIdeal: slippage + CONFIG.SLIPPAGE_PCT,
            nfsScore: nfs.score,
          };
        }
      }
      // Wick a touché mais NFS pas confirmé → attendre
    }

    // Reset si pas de breach
    if (!wickBreached || (wickBreached && !closeBreached)) {
      pos.trailingBreachCandles = 0;
    }

    return { shouldExit: false, exitPrice: 0, exitReason: '', slippageVsIdeal: 0 };

  } else if (strategy === 'NFS_HYBRID') {
    if (wickBreached && closeBreached) {
      // Calculate NFS
      const nfs = computeNFS(current, prevCandles, pos.side, trailingStopPrice);
      pos.trailingBreachCandles++;

      if (nfs.exitImmediately) {
        // High confidence - exit on 1 close
        const slippage = Math.abs((current.close - trailingStopPrice) / trailingStopPrice) * 100;
        return {
          shouldExit: true,
          exitPrice: current.close * (1 - CONFIG.SLIPPAGE_PCT / 100), // Add execution slippage
          exitReason: 'TRAIL_NFS',
          slippageVsIdeal: slippage + CONFIG.SLIPPAGE_PCT,
          nfsScore: nfs.score,
        };
      } else if (pos.trailingBreachCandles >= 2) {
        // Low confidence - wait for 2 closes
        const slippage = Math.abs((current.close - trailingStopPrice) / trailingStopPrice) * 100;
        return {
          shouldExit: true,
          exitPrice: current.close * (1 - CONFIG.SLIPPAGE_PCT / 100),
          exitReason: 'TRAIL_2C',
          slippageVsIdeal: slippage + CONFIG.SLIPPAGE_PCT,
          nfsScore: nfs.score,
        };
      }
    } else if (wickBreached && !closeBreached) {
      pos.trailingBreachCandles = 0;
    } else {
      pos.trailingBreachCandles = 0;
    }
  } else {
    // BASELINE_2CLOSE
    if (wickBreached && closeBreached) {
      pos.trailingBreachCandles++;
      if (pos.trailingBreachCandles >= 2) {
        // Exit au trailing stop exact (comme le backtest actuel)
        return {
          shouldExit: true,
          exitPrice: trailingStopPrice,
          exitReason: 'TRAIL',
          slippageVsIdeal: 0,
        };
      }
    } else if (wickBreached && !closeBreached) {
      pos.trailingBreachCandles = 0;
    } else {
      pos.trailingBreachCandles = 0;
    }
  }

  return { shouldExit: false, exitPrice: 0, exitReason: '', slippageVsIdeal: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE
// ═══════════════════════════════════════════════════════════════════════════

function runBacktest(
  candles: Candle[],
  btcCandles: Candle[],
  symbol: string,
  strategy: ExitStrategy
): Trade[] {
  const trades: Trade[] = [];
  let position: SimPosition | null = null;
  let cooldown = 0;

  for (let idx = 50; idx < candles.length; idx++) {
    const current = candles[idx];
    const prevCandles = candles.slice(0, idx);

    if (cooldown > 0) cooldown--;

    // Manage position
    if (position) {
      const exitResult = checkExit(position, current, prevCandles, strategy);

      if (exitResult.shouldExit) {
        const pnlPct = position.side === 'long'
          ? ((exitResult.exitPrice - position.entryPrice) / position.entryPrice) * 100
          : ((position.entryPrice - exitResult.exitPrice) / position.entryPrice) * 100;

        trades.push({
          symbol,
          side: position.side,
          entryPrice: position.entryPrice,
          entryTime: position.entryTime,
          exitPrice: exitResult.exitPrice,
          exitTime: current.timestamp,
          exitReason: exitResult.exitReason,
          pnlPct,
          holdBars: idx - position.entryIdx,
          nfsScore: exitResult.nfsScore,
        });

        position = null;
        cooldown = exitResult.exitReason === 'SL' ? 8 : 4;
      }
    }

    // Check for entry
    if (!position && cooldown <= 0) {
      const window = candles.slice(Math.max(0, idx - 50), idx + 1);
      const closes = window.map(c => c.close);
      const volumes = window.map(c => c.volume);

      const roc10 = calcROC(closes, 10);
      const volRatio = calcVolRatio(volumes);

      // BTC regime
      const btcWindow = btcCandles.filter(c => c.timestamp <= current.timestamp).slice(-200);
      if (btcWindow.length < 200) continue;
      const btcCloses = btcWindow.map(c => c.close);
      const btcSma200 = calcSMA(btcCloses, 200);
      const isBullRegime = btcCloses[btcCloses.length - 1] > btcSma200;

      // Entry logic
      if (isBullRegime && roc10 >= CONFIG.ENTRY.ROC_MIN_LONG && volRatio >= CONFIG.ENTRY.VOLUME_MIN) {
        position = {
          symbol,
          side: 'long',
          entryPrice: current.close,
          entryIdx: idx,
          entryTime: current.timestamp,
          highWaterMark: current.high,
          lowWaterMark: current.low,
          trailingActive: false,
          trailingBreachCandles: 0,
          stopLossPct: CONFIG.STOP_LOSS_PCT,
          maxPnlPct: 0,
        };
      } else if (!isBullRegime && roc10 <= CONFIG.ENTRY.ROC_MAX_SHORT && volRatio >= CONFIG.ENTRY.VOLUME_MIN) {
        position = {
          symbol,
          side: 'short',
          entryPrice: current.close,
          entryIdx: idx,
          entryTime: current.timestamp,
          highWaterMark: current.high,
          lowWaterMark: current.low,
          trailingActive: false,
          trailingBreachCandles: 0,
          stopLossPct: CONFIG.STOP_LOSS_PCT,
          maxPnlPct: 0,
        };
      }
    }
  }

  return trades;
}

function analyzeResults(trades: Trade[], strategyName: string): BacktestResult {
  if (trades.length === 0) {
    return {
      strategyName,
      trades: [],
      totalPnlPct: 0,
      winRate: 0,
      avgTradePnl: 0,
      avgHoldBars: 0,
      trailExits: 0,
      slExits: 0,
      avgSlippage: 0,
    };
  }

  const totalPnlPct = trades.reduce((sum, t) => sum + t.pnlPct, 0);
  const wins = trades.filter(t => t.pnlPct > 0).length;
  const trailExits = trades.filter(t => t.exitReason.startsWith('TRAIL')).length;
  const slExits = trades.filter(t => t.exitReason === 'SL').length;
  const avgHoldBars = trades.reduce((sum, t) => sum + t.holdBars, 0) / trades.length;

  return {
    strategyName,
    trades,
    totalPnlPct,
    winRate: (wins / trades.length) * 100,
    avgTradePnl: totalPnlPct / trades.length,
    avgHoldBars,
    trailExits,
    slExits,
    avgSlippage: 0, // Calculated separately
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('  EXIT STRATEGY COMPARISON');
  console.log('  Period: ' + CONFIG.START_DATE.toISOString().slice(0, 10) + ' to ' + CONFIG.END_DATE.toISOString().slice(0, 10));
  console.log('═══════════════════════════════════════════════════════════════════════════\n');

  const strategies: ExitStrategy[] = ['BASELINE_2CLOSE', 'NFS_HYBRID', 'NFS_REALTIME', 'REALTIME_NAIVE'];
  const btcCandles = loadCandles('BTC_USDT');

  const allResults: Map<ExitStrategy, BacktestResult[]> = new Map();
  for (const s of strategies) allResults.set(s, []);

  for (const symbol of CONFIG.SYMBOLS) {
    console.log(`\nTesting ${symbol}...`);
    const candles = loadCandles(symbol);
    if (candles.length < 100) {
      console.log(`  Skipped (${candles.length} candles)`);
      continue;
    }

    for (const strategy of strategies) {
      const trades = runBacktest(candles, btcCandles, symbol, strategy);
      const result = analyzeResults(trades, strategy);
      allResults.get(strategy)!.push(result);
      console.log(`  ${strategy}: ${trades.length} trades, PnL ${result.totalPnlPct.toFixed(1)}%`);
    }
  }

  // Aggregate results
  console.log('\n\n═══════════════════════════════════════════════════════════════════════════');
  console.log('  AGGREGATE RESULTS');
  console.log('═══════════════════════════════════════════════════════════════════════════\n');

  console.log('┌─────────────────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
  console.log('│ Strategy            │ Trades   │ Total PnL│ Win Rate │ Avg PnL  │ Trail Ex │ SL Exits │');
  console.log('├─────────────────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤');

  for (const strategy of strategies) {
    const results = allResults.get(strategy)!;
    const totalTrades = results.reduce((sum, r) => sum + r.trades.length, 0);
    const totalPnl = results.reduce((sum, r) => sum + r.totalPnlPct, 0);
    const avgWinRate = results.reduce((sum, r) => sum + r.winRate, 0) / results.length;
    const avgTradePnl = totalTrades > 0 ? totalPnl / totalTrades : 0;
    const totalTrail = results.reduce((sum, r) => sum + r.trailExits, 0);
    const totalSl = results.reduce((sum, r) => sum + r.slExits, 0);

    console.log(
      `│ ${strategy.padEnd(19)} │ ${totalTrades.toString().padStart(8)} │ ${(totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(1).padStart(7)}% │ ${avgWinRate.toFixed(1).padStart(7)}% │ ${(avgTradePnl >= 0 ? '+' : '') + avgTradePnl.toFixed(2).padStart(6)}% │ ${totalTrail.toString().padStart(8)} │ ${totalSl.toString().padStart(8)} │`
    );
  }

  console.log('└─────────────────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');

  // Compare strategies vs BASELINE
  console.log('\n\n═══════════════════════════════════════════════════════════════════════════');
  console.log('  DETAILED COMPARISON vs BASELINE');
  console.log('═══════════════════════════════════════════════════════════════════════════\n');

  const baselineResults = allResults.get('BASELINE_2CLOSE')!;
  const hybridResults = allResults.get('NFS_HYBRID')!;
  const nfsRtResults = allResults.get('NFS_REALTIME')!;
  const naiveResults = allResults.get('REALTIME_NAIVE')!;

  let baselinePnl = 0, hybridPnl = 0, nfsRtPnl = 0, naivePnl = 0;
  let baselineTrades = 0, hybridTrades = 0, nfsRtTrades = 0, naiveTrades = 0;

  for (let i = 0; i < baselineResults.length; i++) {
    baselinePnl += baselineResults[i].totalPnlPct;
    baselineTrades += baselineResults[i].trades.length;
    hybridPnl += hybridResults[i].totalPnlPct;
    hybridTrades += hybridResults[i].trades.length;
    nfsRtPnl += nfsRtResults[i].totalPnlPct;
    nfsRtTrades += nfsRtResults[i].trades.length;
    naivePnl += naiveResults[i].totalPnlPct;
    naiveTrades += naiveResults[i].trades.length;
  }

  console.log('Key Insights:\n');

  const naiveVsBaseline = naivePnl - baselinePnl;
  const hybridVsBaseline = hybridPnl - baselinePnl;
  const nfsRtVsBaseline = nfsRtPnl - baselinePnl;

  console.log(`1. REALTIME_NAIVE (ordre LIMIT passif - DANGEREUX):`);
  console.log(`   - PnL: ${naivePnl.toFixed(1)}% (${naiveVsBaseline >= 0 ? '+' : ''}${naiveVsBaseline.toFixed(1)}% vs baseline)`);
  console.log(`   - Trades: ${naiveTrades}`);
  if (naiveVsBaseline < -10) {
    console.log(`   → CONFIRME: Les wicks causent des sorties prématurées massives!`);
  } else if (naiveVsBaseline > 5) {
    console.log(`   → Surprenant: sorties rapides bénéfiques malgré les wicks`);
  }

  console.log(`\n2. NFS_REALTIME (WebSocket + NFS pour valider les breaches):`);
  console.log(`   - PnL: ${nfsRtPnl.toFixed(1)}% (${nfsRtVsBaseline >= 0 ? '+' : ''}${nfsRtVsBaseline.toFixed(1)}% vs baseline)`);
  console.log(`   - Trades: ${nfsRtTrades}`);
  if (nfsRtVsBaseline > 5) {
    console.log(`   → MEILLEUR: Le NFS filtre efficacement les faux signaux!`);
  } else if (nfsRtVsBaseline > 0) {
    console.log(`   → Légèrement meilleur: filtrage NFS aide`);
  } else {
    console.log(`   → Pas d'amélioration significative`);
  }

  console.log(`\n3. NFS_HYBRID (NFS au close, pas intra-candle):`);
  console.log(`   - PnL: ${hybridPnl.toFixed(1)}% (${hybridVsBaseline >= 0 ? '+' : ''}${hybridVsBaseline.toFixed(1)}% vs baseline)`);
  console.log(`   - Trades: ${hybridTrades}`);

  // NFS_REALTIME Exit Breakdown
  console.log(`\n4. NFS_REALTIME Exit Breakdown:`);
  const allNfsRtTrades = nfsRtResults.flatMap(r => r.trades);
  const nfsRtImmediateExits = allNfsRtTrades.filter(t => t.exitReason === 'TRAIL_NFS_RT').length;
  const nfsRtFallbackExits = allNfsRtTrades.filter(t => t.exitReason === 'TRAIL_2C_FB').length;
  const totalNfsRtTrailExits = nfsRtImmediateExits + nfsRtFallbackExits;
  console.log(`   - Immediate exits (NFS confirme): ${nfsRtImmediateExits} (${(nfsRtImmediateExits / Math.max(totalNfsRtTrailExits, 1) * 100).toFixed(0)}%)`);
  console.log(`   - Fallback 2-close (NFS pas confirmé): ${nfsRtFallbackExits} (${(nfsRtFallbackExits / Math.max(totalNfsRtTrailExits, 1) * 100).toFixed(0)}%)`);

  // NFS score analysis for RT
  const nfsRtScores = allNfsRtTrades.filter(t => t.nfsScore !== undefined && t.exitReason === 'TRAIL_NFS_RT').map(t => t.nfsScore!);
  if (nfsRtScores.length > 0) {
    const avgNfsRt = nfsRtScores.reduce((a, b) => a + b, 0) / nfsRtScores.length;
    console.log(`   - Average NFS score on RT exits: ${avgNfsRt.toFixed(1)}`);
  }

  // Calculate slippage savings
  const baselineTrailTrades = baselineResults.flatMap(r => r.trades).filter(t => t.exitReason === 'TRAIL');
  const nfsRtTrailTrades = allNfsRtTrades.filter(t => t.exitReason.startsWith('TRAIL'));

  console.log(`\n5. Slippage Analysis:`);
  console.log(`   - Baseline: sort au trailing stop exact (slippage théorique 0)`);
  console.log(`   - NFS_REALTIME: sort proche du trailing avec market order`);

  // RECOMMENDATIONS
  console.log('\n\n═══════════════════════════════════════════════════════════════════════════');
  console.log('  RECOMMENDATIONS');
  console.log('═══════════════════════════════════════════════════════════════════════════\n');

  // Determine best strategy
  const bestPnl = Math.max(baselinePnl, hybridPnl, nfsRtPnl);
  const bestStrategy = bestPnl === nfsRtPnl ? 'NFS_REALTIME' :
                       bestPnl === hybridPnl ? 'NFS_HYBRID' : 'BASELINE';

  if (bestStrategy === 'NFS_REALTIME' && nfsRtVsBaseline > 3) {
    console.log('RECOMMENDED: NFS_REALTIME STRATEGY');
    console.log('');
    console.log('Cette stratégie combine le meilleur des deux mondes:');
    console.log('- Réactivité du temps réel');
    console.log('- Filtrage NFS pour éviter les faux signaux (wicks)');
    console.log('');
    console.log('Implémentation suggérée:');
    console.log('1. Activer WebSocket pour monitoring prix en continu');
    console.log('2. Sur chaque tick où prix touche trailing:');
    console.log('   a. Calculer NFS (breach/ATR, volume, depth)');
    console.log('   b. Si NFS >= 70: exécuter market order immédiat');
    console.log('   c. Sinon: logger et continuer monitoring');
    console.log('3. Fallback: si 2 closes sous trailing, sortir quand même');
    console.log('');
    console.log('Avantages:');
    console.log('- Sortie plus proche du trailing que 2-close');
    console.log('- Filtrage des wicks par le NFS');
    console.log('- Meilleure parité backtest/live');
  } else if (bestStrategy === 'NFS_HYBRID' && hybridVsBaseline > 2) {
    console.log('RECOMMENDED: NFS_HYBRID STRATEGY');
    console.log('');
    console.log('Implémentation suggérée:');
    console.log('1. À chaque close qui breach le trailing:');
    console.log('   - Calculer NFS');
    console.log('   - Si NFS >= 70: sortir immédiatement');
    console.log('   - Sinon: attendre 2ème close');
    console.log('');
    console.log('Avantages:');
    console.log('- Pas besoin de WebSocket temps réel');
    console.log('- Plus simple à implémenter');
    console.log('- Bon compromis réactivité/fiabilité');
  } else {
    console.log('KEEP: BASELINE 2-CLOSE CONFIRMATION');
    console.log('');
    console.log('Les données montrent que la stratégie actuelle reste optimale.');
    console.log('Les gains de réactivité ne compensent pas les faux signaux.');
    console.log('');
    console.log('Alternative à considérer:');
    console.log('- Réduire le trailing distance pour sorties plus précoces');
    console.log('- Ajuster l\'activation threshold');
  }

  // Compare naive vs NFS_RT
  if (naiveVsBaseline < nfsRtVsBaseline - 5) {
    console.log('\n\nVALIDATION: Le NFS est ESSENTIEL');
    console.log('Sans NFS (REALTIME_NAIVE): PnL = ' + naivePnl.toFixed(1) + '%');
    console.log('Avec NFS (NFS_REALTIME):   PnL = ' + nfsRtPnl.toFixed(1) + '%');
    console.log('→ Le NFS évite ' + (nfsRtPnl - naivePnl).toFixed(1) + '% de pertes dues aux faux signaux!');
  }

  // Save detailed results
  const outputPath = path.join(__dirname, '../output/exit-strategy-comparison.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    config: CONFIG,
    results: Object.fromEntries(
      strategies.map(s => [
        s,
        {
          aggregate: {
            totalTrades: allResults.get(s)!.reduce((sum, r) => sum + r.trades.length, 0),
            totalPnlPct: allResults.get(s)!.reduce((sum, r) => sum + r.totalPnlPct, 0),
            avgWinRate: allResults.get(s)!.reduce((sum, r) => sum + r.winRate, 0) / allResults.get(s)!.length,
          },
          bySymbol: allResults.get(s)!.map(r => ({
            totalPnlPct: r.totalPnlPct,
            trades: r.trades.length,
            winRate: r.winRate,
            trailExits: r.trailExits,
            slExits: r.slExits,
          })),
        },
      ])
    ),
  }, null, 2));

  console.log(`\n\nResults saved to: ${outputPath}`);
}

main().catch(console.error);
