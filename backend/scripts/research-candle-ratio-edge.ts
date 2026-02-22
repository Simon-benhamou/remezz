/**
 * 🔬 Research: Pre-Breakout Candle Ratio Edge
 *
 * HYPOTHESIS: The ratio of bullish vs bearish candles in the N candles
 * before a breakout entry correlates with trade outcome.
 *
 * ANALYSIS:
 * - Lookback windows: 5, 10, 20, 40 candles before entry
 * - Categorized by: market regime (bull/bear) × volatility (LOW/MED/HIGH)
 * - Metrics per bucket: win rate, avg PnL, trade count, avg hold time
 * - Also tracks: green ratio ranges (0-30%, 30-50%, 50-70%, 70-100%)
 *
 * Run: npx tsx scripts/research-candle-ratio-edge.ts
 */

import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';

import {
  calcSMA,
  calcROC,
  calcBB,
  calcVolRatio,
  countConsecUp,
  countConsecDown,
  checkMomentumSignal,
  determineVolatilityRegime,
  shouldExitPosition,
  updatePositionWaterMarks,
  MomentumConfig,
  type Position,
  type ExitSignal,
} from '../src/strategies/momentumSimple.js';

import { calculateSignalScore } from '../src/strategies/signalRanker.js';

import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// TYPES
// ============================================================================

type Candle = BacktestCandle;

interface TradeWithContext {
  symbol: string;
  side: 'long' | 'short';
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  isWin: boolean;
  exitReason: string;
  holdBars: number;

  // Pre-breakout candle analysis
  greenRatio: Record<number, number>;  // lookback -> ratio of green candles (0-1)
  avgBodyPct: Record<number, number>;  // lookback -> avg candle body as % of price

  // Market context at entry
  regime: 'BULL' | 'BEAR';
  volatility: 'LOW' | 'MEDIUM' | 'HIGH';
  atrPct: number;
  btcRoc1h: number;
}

interface BucketStats {
  count: number;
  wins: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
  avgHoldBars: number;
  avgGreenRatio: number;
  trades: TradeWithContext[];
}

// ============================================================================
// CONFIG
// ============================================================================

const LOOKBACKS = [5, 10, 20, 40];
const GREEN_RATIO_BUCKETS = [
  { label: '0-30%', min: 0, max: 0.30 },
  { label: '30-50%', min: 0.30, max: 0.50 },
  { label: '50-70%', min: 0.50, max: 0.70 },
  { label: '70-100%', min: 0.70, max: 1.01 },
];

const SYMBOLS = [
  'BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT',
  'XRP/USDT:USDT', 'SUI/USDT:USDT', 'SEI/USDT:USDT', 'IMX/USDT:USDT',
  'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'ADA/USDT:USDT', 'DOT/USDT:USDT',
  'LTC/USDT:USDT', 'UNI/USDT:USDT', 'FTM/USDT:USDT', 'SONIC/USDT:USDT',
  'APT/USDT:USDT', 'ATOM/USDT:USDT', 'BCH/USDT:USDT', 'OP/USDT:USDT',
  'NEAR/USDT:USDT', 'ARB/USDT:USDT',
];

const LEVERAGE = 5;
const INITIAL_CAPITAL = 1000;
const FEES_BPS = 7;
const SLIPPAGE_PCT = 0.04;
const STOP_LOSS_PCT = 2.5;

// ============================================================================
// HELPERS
// ============================================================================

function calcATR(candles: { high: number; low: number; close: number }[], period: number): number {
  if (candles.length < period + 1) return 0;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    atrSum += tr;
  }
  return atrSum / period;
}

function isGreenCandle(c: Candle): boolean {
  return c.close > c.open;
}

function calcGreenRatio(candles: Candle[], lookback: number): number {
  if (candles.length < lookback) return 0.5;
  const window = candles.slice(-lookback);
  const greens = window.filter(isGreenCandle).length;
  return greens / lookback;
}

function calcAvgBodyPct(candles: Candle[], lookback: number): number {
  if (candles.length < lookback) return 0;
  const window = candles.slice(-lookback);
  let sum = 0;
  for (const c of window) {
    sum += Math.abs(c.close - c.open) / c.open * 100;
  }
  return sum / lookback;
}

function getVolatilityRegime(candles: Candle[]): { regime: 'LOW' | 'MEDIUM' | 'HIGH'; atrPct: number } {
  if (candles.length < 15) return { regime: 'MEDIUM', atrPct: 0 };
  const atr = calcATR(candles, 14);
  const price = candles[candles.length - 1].close;
  const atrPct = (atr / price) * 100;
  if (atrPct < 2) return { regime: 'LOW', atrPct };
  if (atrPct > 3.5) return { regime: 'HIGH', atrPct };
  return { regime: 'MEDIUM', atrPct };
}

function emptyBucketStats(): BucketStats {
  return { count: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0, avgHoldBars: 0, avgGreenRatio: 0, trades: [] };
}

// ============================================================================
// MAIN BACKTEST + ANALYSIS
// ============================================================================

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔬 RESEARCH: Pre-Breakout Candle Ratio Edge');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Load BTC candles for regime detection
  const btcData = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcData) { console.error('No BTC data'); process.exit(1); }
  const btcCandles = btcData.candles;
  console.log(`BTC 15m: ${btcCandles.length} candles (${new Date(btcData.startTs).toISOString().slice(0,10)} → ${new Date(btcData.endTs).toISOString().slice(0,10)})`);

  // Load BTC 1h for MTF filter
  const btcData1h = await loadLocalJsonCandles('BTC/USDT:USDT', '1h');
  const btcCandlesRegime = btcData1h?.candles ?? [];
  console.log(`BTC 1h: ${btcCandlesRegime.length} candles`);

  // Load all symbol candles
  const allCandles: Record<string, Candle[]> = {};
  const availableSymbols: string[] = [];
  for (const sym of SYMBOLS) {
    const data = await loadLocalJsonCandles(sym, '15m');
    if (data && data.candles.length > 200) {
      allCandles[sym] = data.candles;
      availableSymbols.push(sym);
      console.log(`${sym}: ${data.candles.length} candles`);
    }
  }
  console.log(`\nLoaded ${availableSymbols.length} symbols\n`);

  // ─────────────────────────────────────────────────────────────────────────
  // SIMULATE: Walk through BTC candles, detect entries, track exits
  // ─────────────────────────────────────────────────────────────────────────

  const trades: TradeWithContext[] = [];
  const btcCloses = btcCandles.map(c => c.close);

  // Track positions per symbol
  const positions: Record<string, {
    side: 'long' | 'short';
    entryPrice: number;
    entryTime: number;
    entryIdx: number;
    symbolIdx: number;
    hwm: number;
    lwm: number;
    maxPnl: number;
    preBreakoutCandles: Candle[];  // store the candles before entry for analysis
    regime: 'BULL' | 'BEAR';
    volatility: 'LOW' | 'MEDIUM' | 'HIGH';
    atrPct: number;
    btcRoc1h: number;
  } | null> = {};

  const symbolIdx: Record<string, number> = {};
  const cooldowns: Record<string, number> = {};
  for (const sym of availableSymbols) {
    positions[sym] = null;
    symbolIdx[sym] = -1;
    cooldowns[sym] = 0;
  }

  // Find start (need 200 bars for SMA200)
  const startIdx = 200;

  console.log(`Simulating from BTC candle ${startIdx} to ${btcCandles.length}...\n`);

  for (let btcIdx = startIdx; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];

    // BTC regime
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx + 1), 200);
    if (!btcSma200) continue;
    const isBull = btcCandle.close > btcSma200;

    // BTC 1h ROC for context
    let btcRoc1h = 0;
    const btc1hIdx = btcCandlesRegime.findIndex(c => c.timestamp > btcCandle.timestamp) - 1;
    if (btc1hIdx >= 4) {
      const btc1hCloses = btcCandlesRegime.slice(btc1hIdx - 4, btc1hIdx + 1).map(c => c.close);
      btcRoc1h = ((btc1hCloses[btc1hCloses.length - 1] - btc1hCloses[0]) / btc1hCloses[0]) * 100;
    }

    for (const symbol of availableSymbols) {
      const candles = allCandles[symbol];
      let idx = symbolIdx[symbol];

      while (idx + 1 < candles.length && candles[idx + 1].timestamp < btcCandle.timestamp) {
        idx += 1;
      }
      symbolIdx[symbol] = idx;
      if (idx < 50) continue;

      const current = candles[idx];
      if (cooldowns[symbol] > 0) cooldowns[symbol]--;

      // ─── CHECK EXIT ───
      if (positions[symbol]) {
        const pos = positions[symbol]!;
        const holdBars = idx - pos.entryIdx;
        const pnlPct = pos.side === 'long'
          ? ((current.close - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - current.close) / pos.entryPrice) * 100;

        // Update water marks
        if (pos.side === 'long') {
          pos.hwm = Math.max(pos.hwm, current.high);
        } else {
          pos.lwm = Math.min(pos.lwm, current.low);
        }
        pos.maxPnl = Math.max(pos.maxPnl, pnlPct);

        // Simple exit logic (matching core strategy)
        let shouldExit = false;
        let exitReason = '';
        let exitPrice = current.close;

        // Time exit
        if (holdBars >= 192) {
          shouldExit = true;
          exitReason = 'TIME_EXIT';
        }

        // Stop loss
        const slPnl = pos.side === 'long'
          ? ((current.low - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - current.high) / pos.entryPrice) * 100;
        if (slPnl <= -STOP_LOSS_PCT) {
          shouldExit = true;
          exitReason = 'SL';
          exitPrice = pos.side === 'long'
            ? pos.entryPrice * (1 - STOP_LOSS_PCT / 100)
            : pos.entryPrice * (1 + STOP_LOSS_PCT / 100);
        }

        // Trailing stop (simplified adaptive)
        const volInfo = getVolatilityRegime(candles.slice(Math.max(0, idx - 20), idx + 1));
        const trailActivation = volInfo.regime === 'LOW' ? 0.6 : volInfo.regime === 'HIGH' ? 1.2 : 0.8;
        const trailDistance = volInfo.regime === 'LOW' ? 0.3 : volInfo.regime === 'HIGH' ? 0.8 : 0.5;

        if (pos.maxPnl >= trailActivation) {
          const trailPrice = pos.side === 'long'
            ? pos.hwm * (1 - trailDistance / 100)
            : pos.lwm * (1 + trailDistance / 100);

          const hitTrail = pos.side === 'long'
            ? current.low <= trailPrice
            : current.high >= trailPrice;

          if (hitTrail && !shouldExit) {
            shouldExit = true;
            exitReason = 'TRAIL';
            exitPrice = trailPrice;
          }
        }

        // Regime change
        if (!shouldExit) {
          const regimeNow = isBull;
          const expectedRegime = pos.side === 'long';
          if (regimeNow !== expectedRegime && holdBars > 4) {
            shouldExit = true;
            exitReason = 'REGIME_CHANGE';
          }
        }

        if (shouldExit) {
          const finalPnl = pos.side === 'long'
            ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;

          // Apply leverage and fees
          const grossPnl = finalPnl * LEVERAGE;
          const feesPct = (FEES_BPS / 10000) * LEVERAGE * 2 * 100;
          const netPnl = grossPnl - feesPct - (SLIPPAGE_PCT * 2);

          // Calculate green ratios for all lookbacks
          const greenRatios: Record<number, number> = {};
          const avgBodyPcts: Record<number, number> = {};
          for (const lb of LOOKBACKS) {
            greenRatios[lb] = calcGreenRatio(pos.preBreakoutCandles, lb);
            avgBodyPcts[lb] = calcAvgBodyPct(pos.preBreakoutCandles, lb);
          }

          trades.push({
            symbol,
            side: pos.side,
            entryTime: pos.entryTime,
            exitTime: current.timestamp,
            entryPrice: pos.entryPrice,
            exitPrice,
            pnlPct: netPnl,
            isWin: netPnl > 0,
            exitReason,
            holdBars,
            greenRatio: greenRatios,
            avgBodyPct: avgBodyPcts,
            regime: pos.regime,
            volatility: pos.volatility,
            atrPct: pos.atrPct,
            btcRoc1h: pos.btcRoc1h,
          });

          positions[symbol] = null;
          cooldowns[symbol] = 4;
        }
        continue; // skip entry if we have a position
      }

      // ─── CHECK ENTRY ───
      if (cooldowns[symbol] > 0) continue;

      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const closes = windowCandles.map(c => c.close);
      const volumes = windowCandles.map(c => c.volume);

      // Calculate indicators
      const bb = calcBB(closes, 20);
      const roc10 = calcROC(closes, 10) * 100;  // Convert to percentage
      const roc5 = calcROC(closes, 5) * 100;    // Convert to percentage
      const volRatio = calcVolRatio(volumes);
      const sma200 = calcSMA(closes, 200);
      const ma20 = calcSMA(closes, 20);
      const consecUp = countConsecUp(windowCandles);
      const consecDown = countConsecDown(windowCandles);

      if (!sma200 || !ma20) continue;

      let signal: { valid: boolean; side: 'long' | 'short' } = { valid: false, side: 'long' };

      // LONG signal (bull regime)
      if (isBull) {
        if (
          current.close > bb.upper &&
          roc10 > 1.75 &&
          volRatio > 1.15 &&
          consecUp <= 5
        ) {
          signal = { valid: true, side: 'long' };
        }
      }
      // SHORT signal (bear regime)
      else {
        if (
          roc5 < -1.5 &&
          volRatio > 2.0 &&
          current.close < ma20 &&
          current.close < bb.lower &&
          consecDown <= 4
        ) {
          signal = { valid: true, side: 'short' };
        }
      }

      if (!signal.valid) continue;

      if (trades.length === 0 && Object.values(positions).every(p => p === null)) {
        console.log(`  First signal: ${symbol} ${signal.side} @ ${current.close} | roc10=${roc10.toFixed(2)}% volR=${volRatio.toFixed(2)} bb.upper=${bb.upper.toFixed(2)} close=${current.close.toFixed(2)} consecUp=${consecUp}`);
      }

      // BTC volatility filter
      const btcWindow = btcCandles.slice(Math.max(0, btcIdx - 20), btcIdx + 1);
      const btcAtr = calcATR(btcWindow, 14);
      const btcAtrPct = (btcAtr / btcCandle.close) * 100;
      if (btcAtrPct < 0.15) continue; // skip dead markets

      // Get volatility regime
      const volRegime = getVolatilityRegime(windowCandles);

      // Store pre-breakout candles (up to 40 before entry, excluding current)
      const preBreakout = candles.slice(Math.max(0, idx - 40), idx);

      positions[symbol] = {
        side: signal.side,
        entryPrice: current.close,
        entryTime: current.timestamp,
        entryIdx: idx,
        symbolIdx: idx,
        hwm: current.high,
        lwm: current.low,
        maxPnl: 0,
        preBreakoutCandles: preBreakout,
        regime: isBull ? 'BULL' : 'BEAR',
        volatility: volRegime.regime,
        atrPct: volRegime.atrPct,
        btcRoc1h,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ANALYSIS
  // ─────────────────────────────────────────────────────────────────────────

  console.log(`\n════════════════════════════════════════════════════════════`);
  console.log(`📊 RESULTS: ${trades.length} trades analyzed`);
  console.log(`════════════════════════════════════════════════════════════\n`);

  const wins = trades.filter(t => t.isWin).length;
  console.log(`Overall: ${wins}/${trades.length} wins (${(wins/trades.length*100).toFixed(1)}% WR) | Avg PnL: ${(trades.reduce((s,t) => s + t.pnlPct, 0) / trades.length).toFixed(2)}%\n`);

  // ─── BY LOOKBACK × GREEN RATIO BUCKET ───
  for (const lb of LOOKBACKS) {
    console.log(`\n┌─────────────────────────────────────────────────────────┐`);
    console.log(`│  LOOKBACK: ${lb} candles (${lb*15}min)                          │`);
    console.log(`├──────────────┬───────┬─────────┬──────────┬─────────────┤`);
    console.log(`│ Green Ratio  │ Count │ Win Rate│ Avg PnL  │ Total PnL   │`);
    console.log(`├──────────────┼───────┼─────────┼──────────┼─────────────┤`);

    for (const bucket of GREEN_RATIO_BUCKETS) {
      const matching = trades.filter(t => t.greenRatio[lb] >= bucket.min && t.greenRatio[lb] < bucket.max);
      if (matching.length === 0) {
        console.log(`│ ${bucket.label.padEnd(12)} │   0   │    -    │     -    │      -      │`);
        continue;
      }
      const bWins = matching.filter(t => t.isWin).length;
      const bWr = (bWins / matching.length * 100).toFixed(1);
      const bAvg = (matching.reduce((s,t) => s + t.pnlPct, 0) / matching.length).toFixed(2);
      const bTotal = matching.reduce((s,t) => s + t.pnlPct, 0).toFixed(1);
      console.log(`│ ${bucket.label.padEnd(12)} │ ${String(matching.length).padStart(5)} │ ${bWr.padStart(6)}% │ ${bAvg.padStart(7)}% │ ${bTotal.padStart(10)}% │`);
    }
    console.log(`└──────────────┴───────┴─────────┴──────────┴─────────────┘`);
  }

  // ─── BY REGIME × VOLATILITY × GREEN RATIO ───
  console.log(`\n\n══════════════════════════════════════════════════════════════`);
  console.log(`📊 BREAKDOWN BY REGIME × VOLATILITY (Lookback=10)`);
  console.log(`══════════════════════════════════════════════════════════════`);

  const LB = 10; // primary lookback for detailed analysis
  for (const regime of ['BULL', 'BEAR'] as const) {
    for (const vol of ['LOW', 'MEDIUM', 'HIGH'] as const) {
      const subset = trades.filter(t => t.regime === regime && t.volatility === vol);
      if (subset.length < 3) continue;

      const subWins = subset.filter(t => t.isWin).length;
      console.log(`\n── ${regime} / ${vol} VOL (${subset.length} trades, ${(subWins/subset.length*100).toFixed(1)}% WR) ──`);

      for (const bucket of GREEN_RATIO_BUCKETS) {
        const matching = subset.filter(t => t.greenRatio[LB] >= bucket.min && t.greenRatio[LB] < bucket.max);
        if (matching.length === 0) continue;
        const bWins = matching.filter(t => t.isWin).length;
        const bWr = (bWins / matching.length * 100).toFixed(1);
        const bAvg = (matching.reduce((s,t) => s + t.pnlPct, 0) / matching.length).toFixed(2);
        const avgHold = (matching.reduce((s,t) => s + t.holdBars, 0) / matching.length * 15).toFixed(0);
        console.log(`  ${bucket.label}: ${matching.length} trades | WR ${bWr}% | Avg ${bAvg}% | Hold ~${avgHold}min`);
      }
    }
  }

  // ─── CORRELATION ANALYSIS ───
  console.log(`\n\n══════════════════════════════════════════════════════════════`);
  console.log(`📊 CORRELATION: Green Ratio vs PnL`);
  console.log(`══════════════════════════════════════════════════════════════`);

  for (const lb of LOOKBACKS) {
    const ratios = trades.map(t => t.greenRatio[lb]);
    const pnls = trades.map(t => t.pnlPct);

    // Pearson correlation
    const n = ratios.length;
    const sumX = ratios.reduce((a,b) => a+b, 0);
    const sumY = pnls.reduce((a,b) => a+b, 0);
    const sumXY = ratios.reduce((acc, x, i) => acc + x * pnls[i], 0);
    const sumX2 = ratios.reduce((acc, x) => acc + x * x, 0);
    const sumY2 = pnls.reduce((acc, y) => acc + y * y, 0);

    const num = n * sumXY - sumX * sumY;
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    const corr = den === 0 ? 0 : num / den;

    console.log(`  Lookback ${String(lb).padStart(2)}: r = ${corr.toFixed(4)} (${Math.abs(corr) < 0.1 ? 'negligible' : Math.abs(corr) < 0.3 ? 'weak' : Math.abs(corr) < 0.5 ? 'moderate' : 'strong'})`);
  }

  // ─── LONG vs SHORT breakdown ───
  console.log(`\n\n══════════════════════════════════════════════════════════════`);
  console.log(`📊 LONG vs SHORT (Lookback=10)`);
  console.log(`══════════════════════════════════════════════════════════════`);

  for (const side of ['long', 'short'] as const) {
    const subset = trades.filter(t => t.side === side);
    if (subset.length === 0) continue;
    const subWins = subset.filter(t => t.isWin).length;
    console.log(`\n── ${side.toUpperCase()} (${subset.length} trades, ${(subWins/subset.length*100).toFixed(1)}% WR) ──`);

    for (const bucket of GREEN_RATIO_BUCKETS) {
      const matching = subset.filter(t => t.greenRatio[LB] >= bucket.min && t.greenRatio[LB] < bucket.max);
      if (matching.length === 0) continue;
      const bWins = matching.filter(t => t.isWin).length;
      const bWr = (bWins / matching.length * 100).toFixed(1);
      const bAvg = (matching.reduce((s,t) => s + t.pnlPct, 0) / matching.length).toFixed(2);
      console.log(`  ${bucket.label}: ${matching.length} trades | WR ${bWr}% | Avg ${bAvg}%`);
    }
  }

  // ─── EXIT REASON breakdown by green ratio ───
  console.log(`\n\n══════════════════════════════════════════════════════════════`);
  console.log(`📊 EXIT REASON by Green Ratio (Lookback=10)`);
  console.log(`══════════════════════════════════════════════════════════════`);

  const exitReasons = [...new Set(trades.map(t => t.exitReason))];
  for (const bucket of GREEN_RATIO_BUCKETS) {
    const matching = trades.filter(t => t.greenRatio[LB] >= bucket.min && t.greenRatio[LB] < bucket.max);
    if (matching.length === 0) continue;
    console.log(`\n  ${bucket.label} (${matching.length} trades):`);
    for (const reason of exitReasons) {
      const count = matching.filter(t => t.exitReason === reason).length;
      if (count === 0) continue;
      const pct = (count / matching.length * 100).toFixed(1);
      console.log(`    ${reason.padEnd(16)}: ${String(count).padStart(4)} (${pct}%)`);
    }
  }

  // ─── OPTIMAL GREEN RATIO RANGE (potential filter) ───
  console.log(`\n\n══════════════════════════════════════════════════════════════`);
  console.log(`🎯 POTENTIAL FILTER: Optimal Green Ratio Ranges`);
  console.log(`══════════════════════════════════════════════════════════════`);

  for (const lb of LOOKBACKS) {
    // Find the bucket with best WR and enough samples
    let bestBucket = '';
    let bestWR = 0;
    let bestCount = 0;
    let worstBucket = '';
    let worstWR = 100;
    let worstCount = 0;

    for (const bucket of GREEN_RATIO_BUCKETS) {
      const matching = trades.filter(t => t.greenRatio[lb] >= bucket.min && t.greenRatio[lb] < bucket.max);
      if (matching.length < 10) continue;
      const wr = matching.filter(t => t.isWin).length / matching.length * 100;
      if (wr > bestWR) { bestWR = wr; bestBucket = bucket.label; bestCount = matching.length; }
      if (wr < worstWR) { worstWR = wr; worstBucket = bucket.label; worstCount = matching.length; }
    }

    console.log(`  Lookback ${String(lb).padStart(2)}: BEST ${bestBucket} (${bestWR.toFixed(1)}% WR, n=${bestCount}) | WORST ${worstBucket} (${worstWR.toFixed(1)}% WR, n=${worstCount})`);
  }

  // ─── SAVE RAW DATA ───
  const outputPath = path.resolve(process.cwd(), 'scripts', 'research-candle-ratio-results.json');
  const output = {
    generatedAt: new Date().toISOString(),
    totalTrades: trades.length,
    wins,
    overallWR: (wins / trades.length * 100).toFixed(1),
    lookbacks: LOOKBACKS,
    trades: trades.map(t => ({
      symbol: t.symbol,
      side: t.side,
      entryTime: new Date(t.entryTime).toISOString(),
      pnlPct: +t.pnlPct.toFixed(3),
      isWin: t.isWin,
      exitReason: t.exitReason,
      holdBars: t.holdBars,
      regime: t.regime,
      volatility: t.volatility,
      atrPct: +t.atrPct.toFixed(3),
      greenRatio: Object.fromEntries(LOOKBACKS.map(lb => [lb, +t.greenRatio[lb].toFixed(3)])),
    })),
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n💾 Raw data saved to: ${outputPath}`);
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
