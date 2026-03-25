/**
 * TRAILING BREACH NOISE ANALYSIS
 * ================================
 *
 * Objectif: Extraire et classifier tous les trailing breaches pour:
 * - Vrais signaux (confirmés par 2 bougies → sortie)
 * - Faux signaux (1 breach puis récupération)
 *
 * Puis comparer les caractéristiques de chaque groupe pour développer
 * des filtres permettant de sortir immédiatement (sans attendre 2 bougies)
 * sur les "vrais" breaches.
 *
 * FILTRES À TESTER:
 * 1. Breach Depth: breach > X% du stop = signal fort
 * 2. Volume Confirmation: volume >= 1.2x moyenne = confirmé
 * 3. Momentum Alignment: ROC5 < -0.5% (long) = momentum négatif
 * 4. Body vs Wick: corps > 60% de la bougie = conviction
 * 5. ATR Ratio: breach > 0.5 ATR = significatif
 * 6. Consecutive Direction: 2+ bougies même direction = trend
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

interface TrailingBreachEvent {
  // Basic info
  symbol: string;
  side: 'long' | 'short';
  breachTimestamp: number;
  breachIndex: number;

  // Position context
  entryPrice: number;
  highWaterMark: number;
  lowWaterMark: number;
  trailingStopPrice: number;
  pnlPctAtBreach: number;
  holdBarsAtBreach: number;

  // Breach details
  breachCandle: Candle;
  prevCandles: Candle[]; // 5 previous candles for pattern analysis

  // Classification (determined later)
  isConfirmed: boolean; // true = exit after 2 candles, false = recovery
  candlesUntilResolution: number; // How many candles until exit or recovery
  finalOutcome: 'EXIT' | 'RECOVERY';
  exitPnlPct?: number; // Final PnL if exit

  // Filter metrics (computed at breach time)
  filters: FilterMetrics;
}

interface FilterMetrics {
  // 1. Breach Depth
  breachDepthPct: number;         // How far below trailing stop (%)
  breachDepthAbs: number;         // Absolute breach distance ($)

  // 2. Volume
  volumeRatio: number;            // Current volume / 20-period average
  volumeZScore: number;           // Standardized volume

  // 3. Momentum
  roc5: number;                   // 5-period rate of change (%)
  roc1: number;                   // 1-period (current candle) change (%)
  rsiAtBreach: number | null;     // RSI at breach time

  // 4. Candle Structure
  bodyVsWickRatio: number;        // |close - open| / (high - low), 0-1
  isEngulfing: boolean;           // Current candle engulfs previous
  candleDirection: 'bullish' | 'bearish' | 'doji';

  // 5. ATR-based
  atr14: number;                  // 14-period ATR in %
  breachOverATR: number;          // breachDepthAbs / ATR
  candleRangeOverATR: number;     // (high - low) / ATR

  // 6. Consecutive Direction
  consecutiveAgainstPosition: number; // Red candles for long, green for short
  consecutiveSameDirection: number;   // Green candles for long, red for short

  // 7. Time context
  hourOfDay: number;              // 0-23 UTC
  dayOfWeek: number;              // 0 = Sunday

  // 8. Trend context
  priceVsSMA20: number;           // Price position relative to SMA20 (%)
  sma20Slope: number;             // SMA20 slope (%)
}

interface NoiseFilterScore {
  score: number;           // 0-100, higher = more confidence to exit
  exitImmediately: boolean;
  reasons: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  SYMBOLS: [
    'BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'DOGE_USDT', 'XRP_USDT',
    'ADA_USDT', 'AVAX_USDT', 'LINK_USDT', 'DOT_USDT', 'ATOM_USDT',
    'SUI_USDT', 'SEI_USDT', 'APT_USDT', 'IMX_USDT'
  ],
  START_DATE: new Date('2024-01-01'),
  END_DATE: new Date('2025-01-10'),
  DATA_DIR: path.join(__dirname, '../data'),

  // Trailing configuration (must match backtest)
  TRAILING_ACTIVATION_PCT: 0.8,
  TRAILING_DISTANCE_PCT: 0.5,
  TRAILING_WIDEN_AT_PCT: 3.0,
  TRAILING_WIDE_DISTANCE_PCT: 0.8,
  STOP_LOSS_PCT: 2.5,

  // Entry signal thresholds (simplified for breach analysis)
  ENTRY: {
    ROC_MIN_LONG: 1.75,
    ROC_MAX_SHORT: -1.5,
    VOLUME_MIN: 1.15,
  },

  // In-sample / Out-of-sample split
  IN_SAMPLE_RATIO: 0.7,
};

// ═══════════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════════════

function loadCandles(symbol: string, timeframe: '15m' | '1h' = '15m'): Candle[] {
  const filename = `${symbol}_${timeframe}.json`;
  const filepath = path.join(CONFIG.DATA_DIR, filename);

  if (!fs.existsSync(filepath)) {
    console.warn(`[WARN] Missing data: ${filepath}`);
    return [];
  }

  const raw = JSON.parse(fs.readFileSync(filepath, 'utf-8'));

  // Handle both array format and object format
  const data = Array.isArray(raw) ? raw : raw.data || raw.candles || [];

  return data.map((c: any) => {
    if (Array.isArray(c)) {
      return {
        timestamp: c[0],
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5],
      };
    }
    return c as Candle;
  }).filter((c: Candle) =>
    c.timestamp >= CONFIG.START_DATE.getTime() &&
    c.timestamp <= CONFIG.END_DATE.getTime()
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// INDICATOR CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════

function calcSMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
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

function calcStdDev(values: number[], period: number): number {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const squaredDiffs = slice.map(v => Math.pow(v - mean, 2));
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / period);
}

function calcATR(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;

  const trueRanges: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  return trueRanges.reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function countConsecutive(candles: Candle[], direction: 'up' | 'down'): number {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const isUp = candles[i].close > candles[i].open;
    if ((direction === 'up' && isUp) || (direction === 'down' && !isUp)) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// ═══════════════════════════════════════════════════════════════════════════
// FILTER COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════

function computeFilterMetrics(
  candle: Candle,
  prevCandles: Candle[],
  side: 'long' | 'short',
  trailingStopPrice: number
): FilterMetrics {
  const allCandles = [...prevCandles, candle];
  const closes = allCandles.map(c => c.close);
  const volumes = allCandles.map(c => c.volume);

  // 1. Breach Depth
  let breachDepthPct: number;
  let breachDepthAbs: number;

  if (side === 'long') {
    breachDepthAbs = trailingStopPrice - candle.close;
    breachDepthPct = (breachDepthAbs / trailingStopPrice) * 100;
  } else {
    breachDepthAbs = candle.close - trailingStopPrice;
    breachDepthPct = (breachDepthAbs / trailingStopPrice) * 100;
  }

  // 2. Volume
  const volumeRatio = calcVolRatio(volumes);
  const volStd = calcStdDev(volumes.slice(0, -1), 20);
  const volMean = calcSMA(volumes.slice(0, -1), 20);
  const volumeZScore = volStd === 0 ? 0 : (candle.volume - volMean) / volStd;

  // 3. Momentum
  const roc5 = calcROC(closes, 5);
  const roc1 = closes.length >= 2
    ? ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100
    : 0;
  const rsiAtBreach = calcRSI(closes, 14);

  // 4. Candle Structure
  const bodySize = Math.abs(candle.close - candle.open);
  const candleRange = candle.high - candle.low;
  const bodyVsWickRatio = candleRange === 0 ? 0 : bodySize / candleRange;

  const prevCandle = prevCandles[prevCandles.length - 1];
  const isEngulfing = prevCandle
    ? (candle.close < candle.open && // bearish
       candle.open >= prevCandle.close &&
       candle.close <= prevCandle.open)
    : false;

  const candleDirection =
    candle.close > candle.open ? 'bullish' :
    candle.close < candle.open ? 'bearish' : 'doji';

  // 5. ATR-based
  const atrAbs = calcATR(allCandles, 14);
  const atr14 = candle.close === 0 ? 0 : (atrAbs / candle.close) * 100;
  const breachOverATR = atrAbs === 0 ? 0 : breachDepthAbs / atrAbs;
  const candleRangeOverATR = atrAbs === 0 ? 0 : candleRange / atrAbs;

  // 6. Consecutive Direction
  const againstDirection = side === 'long' ? 'down' : 'up';
  const sameDirection = side === 'long' ? 'up' : 'down';
  const consecutiveAgainstPosition = countConsecutive(allCandles, againstDirection);
  const consecutiveSameDirection = countConsecutive(allCandles, sameDirection);

  // 7. Time context
  const date = new Date(candle.timestamp);
  const hourOfDay = date.getUTCHours();
  const dayOfWeek = date.getUTCDay();

  // 8. Trend context
  const sma20 = calcSMA(closes, 20);
  const priceVsSMA20 = sma20 === 0 ? 0 : ((candle.close - sma20) / sma20) * 100;

  // SMA20 slope: compare current SMA20 to 5 bars ago
  const closes5BarsAgo = closes.slice(0, -5);
  const sma20_5ago = closes5BarsAgo.length >= 20 ? calcSMA(closes5BarsAgo, 20) : sma20;
  const sma20Slope = sma20_5ago === 0 ? 0 : ((sma20 - sma20_5ago) / sma20_5ago) * 100;

  return {
    breachDepthPct,
    breachDepthAbs,
    volumeRatio,
    volumeZScore,
    roc5,
    roc1,
    rsiAtBreach,
    bodyVsWickRatio,
    isEngulfing,
    candleDirection,
    atr14,
    breachOverATR,
    candleRangeOverATR,
    consecutiveAgainstPosition,
    consecutiveSameDirection,
    hourOfDay,
    dayOfWeek,
    priceVsSMA20,
    sma20Slope,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SIMULATED POSITION TRACKING
// ═══════════════════════════════════════════════════════════════════════════

interface SimPosition {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  entryIdx: number;
  highWaterMark: number;
  lowWaterMark: number;
  trailingActive: boolean;
  trailingBreachCandles: number;
  stopLossPct: number;
}

function shouldEnterPosition(
  candles: Candle[],
  btcCandles: Candle[],
  idx: number
): { enter: boolean; side: 'long' | 'short' } | null {
  if (idx < 50) return null;

  const window = candles.slice(idx - 50, idx + 1);
  const current = candles[idx];
  const closes = window.map(c => c.close);
  const volumes = window.map(c => c.volume);

  const roc10 = calcROC(closes, 10);
  const volRatio = calcVolRatio(volumes);

  // Simplified BTC regime detection
  const btcWindow = btcCandles.filter(c => c.timestamp <= current.timestamp).slice(-200);
  if (btcWindow.length < 200) return null;

  const btcCloses = btcWindow.map(c => c.close);
  const btcSma200 = calcSMA(btcCloses, 200);
  const btcPrice = btcCloses[btcCloses.length - 1];
  const isBullRegime = btcPrice > btcSma200;

  // Simplified entry logic (just for position generation)
  if (isBullRegime && roc10 >= CONFIG.ENTRY.ROC_MIN_LONG && volRatio >= CONFIG.ENTRY.VOLUME_MIN) {
    return { enter: true, side: 'long' };
  }

  if (!isBullRegime && roc10 <= CONFIG.ENTRY.ROC_MAX_SHORT && volRatio >= CONFIG.ENTRY.VOLUME_MIN) {
    return { enter: true, side: 'short' };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ANALYSIS: Extract all trailing breaches
// ═══════════════════════════════════════════════════════════════════════════

function analyzeTrailingBreaches(
  candles: Candle[],
  btcCandles: Candle[],
  symbol: string
): TrailingBreachEvent[] {
  const breachEvents: TrailingBreachEvent[] = [];
  let position: SimPosition | null = null;
  let cooldown = 0;

  for (let idx = 50; idx < candles.length; idx++) {
    const current = candles[idx];

    if (cooldown > 0) {
      cooldown--;
    }

    // ───────────────────────────────────────────────────────────────────────
    // MANAGE EXISTING POSITION
    // ───────────────────────────────────────────────────────────────────────
    if (position) {
      const holdBars = idx - position.entryIdx;

      // Calculate PnL
      const pnlPct = position.side === 'long'
        ? ((current.close - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - current.close) / position.entryPrice) * 100;

      // Update water marks
      if (position.side === 'long') {
        position.highWaterMark = Math.max(position.highWaterMark, current.high);
      } else {
        position.lowWaterMark = Math.min(position.lowWaterMark, current.low);
      }

      // Check stop loss
      const slBreached = position.side === 'long'
        ? current.low <= position.entryPrice * (1 - position.stopLossPct / 100)
        : current.high >= position.entryPrice * (1 + position.stopLossPct / 100);

      if (slBreached) {
        position = null;
        cooldown = 8;
        continue;
      }

      // Check max hold time (48 hours = 192 bars @ 15min)
      if (holdBars >= 192) {
        position = null;
        cooldown = 4;
        continue;
      }

      // Check trailing activation
      const hwmPct = position.side === 'long'
        ? ((position.highWaterMark - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - position.lowWaterMark) / position.entryPrice) * 100;

      if (!position.trailingActive && hwmPct >= CONFIG.TRAILING_ACTIVATION_PCT) {
        position.trailingActive = true;
      }

      // Check trailing breach
      if (position.trailingActive) {
        let trailingDistance = CONFIG.TRAILING_DISTANCE_PCT;
        if (hwmPct >= CONFIG.TRAILING_WIDEN_AT_PCT) {
          trailingDistance = CONFIG.TRAILING_WIDE_DISTANCE_PCT;
        }

        let trailingStopPrice: number;
        let wickBreached: boolean;
        let closeBreached: boolean;

        if (position.side === 'long') {
          trailingStopPrice = position.highWaterMark * (1 - trailingDistance / 100);
          wickBreached = current.low <= trailingStopPrice;
          closeBreached = current.close <= trailingStopPrice;
        } else {
          trailingStopPrice = position.lowWaterMark * (1 + trailingDistance / 100);
          wickBreached = current.high >= trailingStopPrice;
          closeBreached = current.close >= trailingStopPrice;
        }

        if (wickBreached && closeBreached) {
          // ═══════════════════════════════════════════════════════════════════
          // TRAILING BREACH DETECTED! Record and analyze
          // ═══════════════════════════════════════════════════════════════════

          position.trailingBreachCandles++;

          // Get previous candles for pattern analysis
          const prevCandles = candles.slice(Math.max(0, idx - 20), idx);

          // Compute filter metrics at breach time
          const filters = computeFilterMetrics(
            current,
            prevCandles,
            position.side,
            trailingStopPrice
          );

          // Create breach event (we'll determine outcome later)
          const breachEvent: TrailingBreachEvent = {
            symbol,
            side: position.side,
            breachTimestamp: current.timestamp,
            breachIndex: idx,
            entryPrice: position.entryPrice,
            highWaterMark: position.highWaterMark,
            lowWaterMark: position.lowWaterMark,
            trailingStopPrice,
            pnlPctAtBreach: pnlPct,
            holdBarsAtBreach: holdBars,
            breachCandle: current,
            prevCandles: prevCandles.slice(-5),
            isConfirmed: false,
            candlesUntilResolution: 0,
            finalOutcome: 'RECOVERY',
            filters,
          };

          // Look ahead to determine outcome
          let candlesUntilResolution = 0;
          let consecutiveBreaches = position.trailingBreachCandles;

          for (let futureIdx = idx + 1; futureIdx < Math.min(idx + 50, candles.length); futureIdx++) {
            const futureCandle = candles[futureIdx];
            candlesUntilResolution++;

            // Update water mark
            if (position.side === 'long') {
              const newHWM = Math.max(position.highWaterMark, futureCandle.high);
              if (hwmPct >= CONFIG.TRAILING_WIDEN_AT_PCT) {
                trailingDistance = CONFIG.TRAILING_WIDE_DISTANCE_PCT;
              }
              const newTrailingStop = newHWM * (1 - trailingDistance / 100);

              // Check if breach continues
              if (futureCandle.close <= newTrailingStop) {
                consecutiveBreaches++;
                if (consecutiveBreaches >= 2) {
                  // CONFIRMED EXIT
                  breachEvent.isConfirmed = true;
                  breachEvent.finalOutcome = 'EXIT';
                  breachEvent.candlesUntilResolution = candlesUntilResolution;
                  breachEvent.exitPnlPct = ((newTrailingStop - position.entryPrice) / position.entryPrice) * 100;
                  break;
                }
              } else {
                // RECOVERY - close recovered above trailing stop
                breachEvent.isConfirmed = false;
                breachEvent.finalOutcome = 'RECOVERY';
                breachEvent.candlesUntilResolution = candlesUntilResolution;
                break;
              }
            } else {
              const newLWM = Math.min(position.lowWaterMark, futureCandle.low);
              if (hwmPct >= CONFIG.TRAILING_WIDEN_AT_PCT) {
                trailingDistance = CONFIG.TRAILING_WIDE_DISTANCE_PCT;
              }
              const newTrailingStop = newLWM * (1 + trailingDistance / 100);

              if (futureCandle.close >= newTrailingStop) {
                consecutiveBreaches++;
                if (consecutiveBreaches >= 2) {
                  breachEvent.isConfirmed = true;
                  breachEvent.finalOutcome = 'EXIT';
                  breachEvent.candlesUntilResolution = candlesUntilResolution;
                  breachEvent.exitPnlPct = ((position.entryPrice - newTrailingStop) / position.entryPrice) * 100;
                  break;
                }
              } else {
                breachEvent.isConfirmed = false;
                breachEvent.finalOutcome = 'RECOVERY';
                breachEvent.candlesUntilResolution = candlesUntilResolution;
                break;
              }
            }
          }

          breachEvents.push(breachEvent);

          // If confirmed, close position
          if (breachEvent.isConfirmed) {
            position = null;
            cooldown = 4;
            continue;
          }

        } else if (wickBreached && !closeBreached) {
          // Wick hit but close recovered - reset breach counter
          position.trailingBreachCandles = 0;
        } else {
          // No breach at all
          position.trailingBreachCandles = 0;
        }
      }
    }

    // ───────────────────────────────────────────────────────────────────────
    // CHECK FOR NEW ENTRY
    // ───────────────────────────────────────────────────────────────────────
    if (!position && cooldown <= 0) {
      const entrySignal = shouldEnterPosition(candles, btcCandles, idx);

      if (entrySignal) {
        position = {
          symbol,
          side: entrySignal.side,
          entryPrice: current.close,
          entryIdx: idx,
          highWaterMark: current.high,
          lowWaterMark: current.low,
          trailingActive: false,
          trailingBreachCandles: 0,
          stopLossPct: CONFIG.STOP_LOSS_PCT,
        };
      }
    }
  }

  return breachEvents;
}

// ═══════════════════════════════════════════════════════════════════════════
// STATISTICAL ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

interface GroupStats {
  count: number;
  mean: number;
  median: number;
  std: number;
  min: number;
  max: number;
  p25: number;
  p75: number;
}

function computeStats(values: number[]): GroupStats {
  if (values.length === 0) {
    return { count: 0, mean: 0, median: 0, std: 0, min: 0, max: 0, p25: 0, p75: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;

  const variance = sorted.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / n;
  const std = Math.sqrt(variance);

  const median = n % 2 === 0
    ? (sorted[n/2 - 1] + sorted[n/2]) / 2
    : sorted[Math.floor(n/2)];

  const p25 = sorted[Math.floor(n * 0.25)];
  const p75 = sorted[Math.floor(n * 0.75)];

  return {
    count: n,
    mean,
    median,
    std,
    min: sorted[0],
    max: sorted[n - 1],
    p25,
    p75,
  };
}

interface FilterComparison {
  filterName: string;
  trueSignals: GroupStats;
  falseSignals: GroupStats;
  separation: number; // Cohen's d or similar measure
  optimalThreshold: number;
  accuracy: number;
  precision: number;
  recall: number;
}

function analyzeFilterSeparation(
  trueEvents: TrailingBreachEvent[],
  falseEvents: TrailingBreachEvent[],
  getMetric: (e: TrailingBreachEvent) => number,
  filterName: string,
  higherIsTrueSignal: boolean = true
): FilterComparison {
  const trueValues = trueEvents.map(getMetric).filter(v => !isNaN(v));
  const falseValues = falseEvents.map(getMetric).filter(v => !isNaN(v));

  const trueStats = computeStats(trueValues);
  const falseStats = computeStats(falseValues);

  // Cohen's d for effect size
  const pooledStd = Math.sqrt(
    (Math.pow(trueStats.std, 2) * (trueStats.count - 1) +
     Math.pow(falseStats.std, 2) * (falseStats.count - 1)) /
    (trueStats.count + falseStats.count - 2)
  );
  const cohenD = pooledStd === 0 ? 0 : (trueStats.mean - falseStats.mean) / pooledStd;

  // Find optimal threshold
  const allValues = [...trueValues, ...falseValues].sort((a, b) => a - b);
  let bestThreshold = 0;
  let bestAccuracy = 0;
  let bestPrecision = 0;
  let bestRecall = 0;

  for (const threshold of allValues) {
    let tp = 0, fp = 0, tn = 0, fn = 0;

    for (const v of trueValues) {
      if (higherIsTrueSignal ? v >= threshold : v <= threshold) tp++;
      else fn++;
    }
    for (const v of falseValues) {
      if (higherIsTrueSignal ? v >= threshold : v <= threshold) fp++;
      else tn++;
    }

    const accuracy = (tp + tn) / (tp + tn + fp + fn);
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);

    if (accuracy > bestAccuracy) {
      bestAccuracy = accuracy;
      bestThreshold = threshold;
      bestPrecision = precision;
      bestRecall = recall;
    }
  }

  return {
    filterName,
    trueSignals: trueStats,
    falseSignals: falseStats,
    separation: Math.abs(cohenD),
    optimalThreshold: bestThreshold,
    accuracy: bestAccuracy,
    precision: bestPrecision,
    recall: bestRecall,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// NOISE FILTER SCORING SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

interface FilterWeights {
  breachDepth: { threshold: number; weight: number; higherBetter: boolean };
  volumeRatio: { threshold: number; weight: number; higherBetter: boolean };
  momentumAlignment: { threshold: number; weight: number; higherBetter: boolean };
  bodyVsWick: { threshold: number; weight: number; higherBetter: boolean };
  atrRatio: { threshold: number; weight: number; higherBetter: boolean };
  consecutiveDirection: { threshold: number; weight: number; higherBetter: boolean };
}

function computeNoiseFilterScore(
  event: TrailingBreachEvent,
  weights: FilterWeights
): NoiseFilterScore {
  const reasons: string[] = [];
  let score = 0;
  let maxScore = 0;

  const f = event.filters;

  // 1. Breach Depth
  maxScore += weights.breachDepth.weight;
  if (f.breachDepthPct >= weights.breachDepth.threshold) {
    score += weights.breachDepth.weight;
    reasons.push(`breachDepth=${f.breachDepthPct.toFixed(2)}% >= ${weights.breachDepth.threshold}%`);
  }

  // 2. Volume Ratio
  maxScore += weights.volumeRatio.weight;
  if (f.volumeRatio >= weights.volumeRatio.threshold) {
    score += weights.volumeRatio.weight;
    reasons.push(`volumeRatio=${f.volumeRatio.toFixed(2)}x >= ${weights.volumeRatio.threshold}x`);
  }

  // 3. Momentum Alignment (ROC5 should be negative for LONG breach, positive for SHORT)
  maxScore += weights.momentumAlignment.weight;
  const momentumAligned = event.side === 'long'
    ? f.roc5 <= weights.momentumAlignment.threshold
    : f.roc5 >= -weights.momentumAlignment.threshold;
  if (momentumAligned) {
    score += weights.momentumAlignment.weight;
    reasons.push(`momentum aligned: ROC5=${f.roc5.toFixed(2)}%`);
  }

  // 4. Body vs Wick Ratio
  maxScore += weights.bodyVsWick.weight;
  if (f.bodyVsWickRatio >= weights.bodyVsWick.threshold) {
    score += weights.bodyVsWick.weight;
    reasons.push(`bodyRatio=${(f.bodyVsWickRatio * 100).toFixed(0)}% >= ${weights.bodyVsWick.threshold * 100}%`);
  }

  // 5. ATR Ratio
  maxScore += weights.atrRatio.weight;
  if (f.breachOverATR >= weights.atrRatio.threshold) {
    score += weights.atrRatio.weight;
    reasons.push(`atrRatio=${f.breachOverATR.toFixed(2)} >= ${weights.atrRatio.threshold}`);
  }

  // 6. Consecutive Direction
  maxScore += weights.consecutiveDirection.weight;
  if (f.consecutiveAgainstPosition >= weights.consecutiveDirection.threshold) {
    score += weights.consecutiveDirection.weight;
    reasons.push(`consecutiveAgainst=${f.consecutiveAgainstPosition} >= ${weights.consecutiveDirection.threshold}`);
  }

  const normalizedScore = maxScore === 0 ? 0 : (score / maxScore) * 100;

  return {
    score: normalizedScore,
    exitImmediately: normalizedScore >= 60, // Configurable threshold
    reasons,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('  TRAILING BREACH NOISE ANALYSIS');
  console.log('  Period: ' + CONFIG.START_DATE.toISOString().slice(0, 10) + ' to ' + CONFIG.END_DATE.toISOString().slice(0, 10));
  console.log('═══════════════════════════════════════════════════════════════════════════\n');

  // Load BTC candles for regime detection
  const btcCandles = loadCandles('BTC_USDT', '15m');
  console.log(`Loaded ${btcCandles.length} BTC candles\n`);

  // Collect all breach events across all symbols
  const allBreachEvents: TrailingBreachEvent[] = [];

  for (const symbol of CONFIG.SYMBOLS) {
    console.log(`Analyzing ${symbol}...`);
    const candles = loadCandles(symbol, '15m');

    if (candles.length < 100) {
      console.log(`  - Skipping (insufficient data: ${candles.length} candles)`);
      continue;
    }

    const events = analyzeTrailingBreaches(candles, btcCandles, symbol);
    console.log(`  - Found ${events.length} trailing breach events`);

    allBreachEvents.push(...events);
  }

  console.log(`\n${'═'.repeat(75)}`);
  console.log(`  TOTAL BREACH EVENTS: ${allBreachEvents.length}`);
  console.log(`${'═'.repeat(75)}\n`);

  // Split into true signals (confirmed exits) and false signals (recoveries)
  const trueSignals = allBreachEvents.filter(e => e.isConfirmed);
  const falseSignals = allBreachEvents.filter(e => !e.isConfirmed);

  console.log(`TRUE SIGNALS (Confirmed Exits): ${trueSignals.length} (${(trueSignals.length / allBreachEvents.length * 100).toFixed(1)}%)`);
  console.log(`FALSE SIGNALS (Recoveries):     ${falseSignals.length} (${(falseSignals.length / allBreachEvents.length * 100).toFixed(1)}%)`);

  // ─────────────────────────────────────────────────────────────────────────
  // SPLIT INTO IN-SAMPLE / OUT-OF-SAMPLE
  // ─────────────────────────────────────────────────────────────────────────

  const sortedEvents = [...allBreachEvents].sort((a, b) => a.breachTimestamp - b.breachTimestamp);
  const splitIdx = Math.floor(sortedEvents.length * CONFIG.IN_SAMPLE_RATIO);

  const inSampleEvents = sortedEvents.slice(0, splitIdx);
  const outOfSampleEvents = sortedEvents.slice(splitIdx);

  const inSampleTrue = inSampleEvents.filter(e => e.isConfirmed);
  const inSampleFalse = inSampleEvents.filter(e => !e.isConfirmed);
  const outOfSampleTrue = outOfSampleEvents.filter(e => e.isConfirmed);
  const outOfSampleFalse = outOfSampleEvents.filter(e => !e.isConfirmed);

  console.log(`\nIN-SAMPLE (70%): ${inSampleEvents.length} events (${inSampleTrue.length} true, ${inSampleFalse.length} false)`);
  console.log(`OUT-OF-SAMPLE (30%): ${outOfSampleEvents.length} events (${outOfSampleTrue.length} true, ${outOfSampleFalse.length} false)`);

  // ─────────────────────────────────────────────────────────────────────────
  // ANALYZE INDIVIDUAL FILTERS (IN-SAMPLE)
  // ─────────────────────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(75)}`);
  console.log(`  FILTER ANALYSIS (In-Sample)`);
  console.log(`${'═'.repeat(75)}\n`);

  const filterResults: FilterComparison[] = [
    analyzeFilterSeparation(inSampleTrue, inSampleFalse, e => e.filters.breachDepthPct, 'Breach Depth (%)', true),
    analyzeFilterSeparation(inSampleTrue, inSampleFalse, e => e.filters.volumeRatio, 'Volume Ratio', true),
    analyzeFilterSeparation(inSampleTrue, inSampleFalse, e => Math.abs(e.filters.roc5), 'Momentum (|ROC5|)', true),
    analyzeFilterSeparation(inSampleTrue, inSampleFalse, e => e.filters.bodyVsWickRatio, 'Body/Wick Ratio', true),
    analyzeFilterSeparation(inSampleTrue, inSampleFalse, e => e.filters.breachOverATR, 'Breach/ATR Ratio', true),
    analyzeFilterSeparation(inSampleTrue, inSampleFalse, e => e.filters.consecutiveAgainstPosition, 'Consecutive Against', true),
    analyzeFilterSeparation(inSampleTrue, inSampleFalse, e => e.filters.candleRangeOverATR, 'Candle Range/ATR', true),
  ];

  // Sort by separation (most discriminative first)
  filterResults.sort((a, b) => b.separation - a.separation);

  console.log('┌─────────────────────────┬───────────────────────┬───────────────────────┬──────────┬──────────┬──────────┐');
  console.log('│ Filter                  │ True Signals          │ False Signals         │ Cohen\'s d│ Accuracy │ Threshold│');
  console.log('├─────────────────────────┼───────────────────────┼───────────────────────┼──────────┼──────────┼──────────┤');

  for (const f of filterResults) {
    const trueMean = `${f.trueSignals.mean.toFixed(2)} ±${f.trueSignals.std.toFixed(2)}`;
    const falseMean = `${f.falseSignals.mean.toFixed(2)} ±${f.falseSignals.std.toFixed(2)}`;
    console.log(
      `│ ${f.filterName.padEnd(23)} │ ${trueMean.padEnd(21)} │ ${falseMean.padEnd(21)} │ ${f.separation.toFixed(3).padStart(8)} │ ${(f.accuracy * 100).toFixed(1).padStart(7)}% │ ${f.optimalThreshold.toFixed(3).padStart(8)} │`
    );
  }

  console.log('└─────────────────────────┴───────────────────────┴───────────────────────┴──────────┴──────────┴──────────┘');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST FILTER COMBINATIONS
  // ─────────────────────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(75)}`);
  console.log(`  COMBINED FILTER TESTING`);
  console.log(`${'═'.repeat(75)}\n`);

  // Define filter weight configurations to test
  const weightConfigs: { name: string; weights: FilterWeights }[] = [
    {
      name: 'Baseline (equal weights)',
      weights: {
        breachDepth: { threshold: 0.1, weight: 1, higherBetter: true },
        volumeRatio: { threshold: 1.2, weight: 1, higherBetter: true },
        momentumAlignment: { threshold: -0.5, weight: 1, higherBetter: true },
        bodyVsWick: { threshold: 0.6, weight: 1, higherBetter: true },
        atrRatio: { threshold: 0.3, weight: 1, higherBetter: true },
        consecutiveDirection: { threshold: 2, weight: 1, higherBetter: true },
      },
    },
    {
      name: 'Depth + Volume focused',
      weights: {
        breachDepth: { threshold: 0.15, weight: 3, higherBetter: true },
        volumeRatio: { threshold: 1.3, weight: 3, higherBetter: true },
        momentumAlignment: { threshold: -0.5, weight: 1, higherBetter: true },
        bodyVsWick: { threshold: 0.6, weight: 1, higherBetter: true },
        atrRatio: { threshold: 0.3, weight: 1, higherBetter: true },
        consecutiveDirection: { threshold: 2, weight: 1, higherBetter: true },
      },
    },
    {
      name: 'Momentum + Structure focused',
      weights: {
        breachDepth: { threshold: 0.1, weight: 1, higherBetter: true },
        volumeRatio: { threshold: 1.2, weight: 1, higherBetter: true },
        momentumAlignment: { threshold: -0.3, weight: 3, higherBetter: true },
        bodyVsWick: { threshold: 0.5, weight: 3, higherBetter: true },
        atrRatio: { threshold: 0.3, weight: 1, higherBetter: true },
        consecutiveDirection: { threshold: 2, weight: 2, higherBetter: true },
      },
    },
    {
      name: 'ATR-based (volatility aware)',
      weights: {
        breachDepth: { threshold: 0.1, weight: 1, higherBetter: true },
        volumeRatio: { threshold: 1.2, weight: 2, higherBetter: true },
        momentumAlignment: { threshold: -0.5, weight: 1, higherBetter: true },
        bodyVsWick: { threshold: 0.5, weight: 1, higherBetter: true },
        atrRatio: { threshold: 0.4, weight: 4, higherBetter: true },
        consecutiveDirection: { threshold: 2, weight: 1, higherBetter: true },
      },
    },
  ];

  console.log('┌────────────────────────────────┬─────────────┬─────────────┬─────────────┬─────────────┐');
  console.log('│ Configuration                  │ In-Sample   │ Out-Sample  │ Precision   │ Recall      │');
  console.log('│                                │ Accuracy    │ Accuracy    │             │             │');
  console.log('├────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────────┤');

  for (const config of weightConfigs) {
    // Test on in-sample
    let inTP = 0, inFP = 0, inTN = 0, inFN = 0;
    for (const event of inSampleEvents) {
      const nfs = computeNoiseFilterScore(event, config.weights);
      if (nfs.exitImmediately && event.isConfirmed) inTP++;
      else if (nfs.exitImmediately && !event.isConfirmed) inFP++;
      else if (!nfs.exitImmediately && !event.isConfirmed) inTN++;
      else inFN++;
    }
    const inAccuracy = (inTP + inTN) / inSampleEvents.length;
    const inPrecision = inTP + inFP === 0 ? 0 : inTP / (inTP + inFP);
    const inRecall = inTP + inFN === 0 ? 0 : inTP / (inTP + inFN);

    // Test on out-of-sample
    let outTP = 0, outFP = 0, outTN = 0, outFN = 0;
    for (const event of outOfSampleEvents) {
      const nfs = computeNoiseFilterScore(event, config.weights);
      if (nfs.exitImmediately && event.isConfirmed) outTP++;
      else if (nfs.exitImmediately && !event.isConfirmed) outFP++;
      else if (!nfs.exitImmediately && !event.isConfirmed) outTN++;
      else outFN++;
    }
    const outAccuracy = (outTP + outTN) / outOfSampleEvents.length;

    console.log(
      `│ ${config.name.padEnd(30)} │ ${(inAccuracy * 100).toFixed(1).padStart(10)}% │ ${(outAccuracy * 100).toFixed(1).padStart(10)}% │ ${(inPrecision * 100).toFixed(1).padStart(10)}% │ ${(inRecall * 100).toFixed(1).padStart(10)}% │`
    );
  }

  console.log('└────────────────────────────────┴─────────────┴─────────────┴─────────────┴─────────────┘');

  // ─────────────────────────────────────────────────────────────────────────
  // DETAILED BREACH EXAMPLES
  // ─────────────────────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(75)}`);
  console.log(`  EXAMPLE TRUE SIGNALS (Top 5 most confident)`);
  console.log(`${'═'.repeat(75)}\n`);

  const trueWithScores = trueSignals.slice(0, 20).map(e => ({
    event: e,
    score: computeNoiseFilterScore(e, weightConfigs[0].weights),
  })).sort((a, b) => b.score.score - a.score.score);

  for (const { event, score } of trueWithScores.slice(0, 5)) {
    console.log(`[${event.symbol}] ${new Date(event.breachTimestamp).toISOString()}`);
    console.log(`  Side: ${event.side.toUpperCase()}, PnL at breach: ${event.pnlPctAtBreach.toFixed(2)}%`);
    console.log(`  Score: ${score.score.toFixed(0)}/100 - ${score.exitImmediately ? 'EXIT NOW' : 'WAIT'}`);
    console.log(`  Reasons: ${score.reasons.join(', ')}`);
    console.log(`  Filters: depth=${event.filters.breachDepthPct.toFixed(2)}%, vol=${event.filters.volumeRatio.toFixed(2)}x, ROC5=${event.filters.roc5.toFixed(2)}%, body=${(event.filters.bodyVsWickRatio * 100).toFixed(0)}%`);
    console.log();
  }

  console.log(`\n${'═'.repeat(75)}`);
  console.log(`  EXAMPLE FALSE SIGNALS (Recoveries that would have been bad exits)`);
  console.log(`${'═'.repeat(75)}\n`);

  const falseWithScores = falseSignals.slice(0, 20).map(e => ({
    event: e,
    score: computeNoiseFilterScore(e, weightConfigs[0].weights),
  })).sort((a, b) => b.score.score - a.score.score);

  for (const { event, score } of falseWithScores.slice(0, 5)) {
    console.log(`[${event.symbol}] ${new Date(event.breachTimestamp).toISOString()}`);
    console.log(`  Side: ${event.side.toUpperCase()}, PnL at breach: ${event.pnlPctAtBreach.toFixed(2)}%`);
    console.log(`  Score: ${score.score.toFixed(0)}/100 - ${score.exitImmediately ? 'EXIT NOW (BAD!)' : 'WAIT (CORRECT)'}`);
    console.log(`  Reasons: ${score.reasons.join(', ')}`);
    console.log(`  Filters: depth=${event.filters.breachDepthPct.toFixed(2)}%, vol=${event.filters.volumeRatio.toFixed(2)}x, ROC5=${event.filters.roc5.toFixed(2)}%, body=${(event.filters.bodyVsWickRatio * 100).toFixed(0)}%`);
    console.log(`  Resolution: ${event.candlesUntilResolution} candles until recovery`);
    console.log();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SAVE DETAILED RESULTS TO JSON
  // ─────────────────────────────────────────────────────────────────────────

  const outputPath = path.join(__dirname, '../output/trailing-breach-analysis.json');
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const output = {
    metadata: {
      startDate: CONFIG.START_DATE.toISOString(),
      endDate: CONFIG.END_DATE.toISOString(),
      symbols: CONFIG.SYMBOLS,
      totalEvents: allBreachEvents.length,
      trueSignals: trueSignals.length,
      falseSignals: falseSignals.length,
    },
    filterAnalysis: filterResults,
    configResults: weightConfigs.map(config => {
      let tp = 0, fp = 0, tn = 0, fn = 0;
      for (const event of allBreachEvents) {
        const nfs = computeNoiseFilterScore(event, config.weights);
        if (nfs.exitImmediately && event.isConfirmed) tp++;
        else if (nfs.exitImmediately && !event.isConfirmed) fp++;
        else if (!nfs.exitImmediately && !event.isConfirmed) tn++;
        else fn++;
      }
      return {
        name: config.name,
        weights: config.weights,
        metrics: {
          accuracy: (tp + tn) / allBreachEvents.length,
          precision: tp + fp === 0 ? 0 : tp / (tp + fp),
          recall: tp + fn === 0 ? 0 : tp / (tp + fn),
          f1: 2 * (tp / (tp + fp)) * (tp / (tp + fn)) / ((tp / (tp + fp)) + (tp / (tp + fn))),
          tp, fp, tn, fn,
        },
      };
    }),
    // Sample of events for inspection
    sampleEvents: allBreachEvents.slice(0, 100).map(e => ({
      ...e,
      score: computeNoiseFilterScore(e, weightConfigs[0].weights),
    })),
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n\nDetailed results saved to: ${outputPath}`);

  // ─────────────────────────────────────────────────────────────────────────
  // RECOMMENDATIONS
  // ─────────────────────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(75)}`);
  console.log(`  RECOMMENDATIONS`);
  console.log(`${'═'.repeat(75)}\n`);

  const bestFilter = filterResults[0];
  console.log(`1. BEST INDIVIDUAL FILTER: ${bestFilter.filterName}`);
  console.log(`   - Cohen's d: ${bestFilter.separation.toFixed(3)} (${bestFilter.separation > 0.8 ? 'LARGE' : bestFilter.separation > 0.5 ? 'MEDIUM' : 'SMALL'} effect)`);
  console.log(`   - Optimal threshold: ${bestFilter.optimalThreshold.toFixed(3)}`);
  console.log(`   - Accuracy: ${(bestFilter.accuracy * 100).toFixed(1)}%\n`);

  console.log(`2. STRATEGY RECOMMENDATION:`);
  if (trueSignals.length / allBreachEvents.length > 0.6) {
    console.log(`   - Most breaches are TRUE signals (${(trueSignals.length / allBreachEvents.length * 100).toFixed(0)}%)`);
    console.log(`   - Consider exiting immediately on HIGH confidence scores (>70)`);
    console.log(`   - Fall back to 2-candle confirmation for lower scores`);
  } else {
    console.log(`   - Most breaches are FALSE signals (recoveries)`);
    console.log(`   - Keep 2-candle confirmation as default`);
    console.log(`   - Only exit immediately when ALL filters align (score >80)`);
  }

  console.log(`\n3. IMPLEMENTATION:`);
  console.log(`   - Add NoiseFilterScore calculation to shouldExitPosition()`);
  console.log(`   - If score >= 70: exit immediately (1 candle)`);
  console.log(`   - If score < 70: use 2-candle confirmation`);
  console.log(`   - Log filter scores for monitoring\n`);
}

// Run
main().catch(console.error);
