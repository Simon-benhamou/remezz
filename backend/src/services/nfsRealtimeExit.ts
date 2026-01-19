/**
 * NFS (Noise Filter Score) Real-Time Exit System
 * ===============================================
 *
 * Objectif: Se rapprocher du backtest (sortie au trailing exact) en filtrant
 * les faux signaux (wicks) via un score de confiance.
 *
 * Le backtest reste l'objectif idéal - cette logique est UNIQUEMENT pour live/paper.
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('nfs');

// ═══════════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isFinal?: boolean;
}

export interface NfsConfig {
  // Seuils NFS
  HIGH_CONFIDENCE_THRESHOLD: number;  // Score >= this → exit immediately
  MEDIUM_CONFIDENCE_THRESHOLD: number; // Score >= this → pre-alert

  // Timeouts
  LIMIT_ORDER_TIMEOUT_MS: number;     // Time before fallback to market

  // Distance thresholds
  PRE_BREACH_DISTANCE_PCT: number;    // Enter PRE_BREACH state

  // Protection
  MAX_SLIPPAGE_PCT: number;           // Alert if exceeded
  PARTIAL_FILL_MIN_RATIO: number;     // Accept partial if >= this

  // NFS Weights (from statistical analysis)
  WEIGHTS: {
    breachATR: { threshold: number; weight: number };
    breachDepth: { threshold: number; weight: number };
    volumeRatio: { threshold: number; weight: number };
    candleBody: { threshold: number; weight: number };
    momentum: { threshold: number; weight: number };
  };
}

// V5.62: Aligned with backtestService.ts and parityVerificationServiceV2.ts
export const DEFAULT_NFS_CONFIG: NfsConfig = {
  HIGH_CONFIDENCE_THRESHOLD: 70,
  MEDIUM_CONFIDENCE_THRESHOLD: 40,   // V5.62 FIX: Was 50, now 40 to match backtest
  LIMIT_ORDER_TIMEOUT_MS: 30000,
  PRE_BREACH_DISTANCE_PCT: 0.3,
  MAX_SLIPPAGE_PCT: 2.0,
  PARTIAL_FILL_MIN_RATIO: 0.8,
  WEIGHTS: {
    breachATR: { threshold: 0.40, weight: 4 },
    breachDepth: { threshold: 0.25, weight: 2 },
    volumeRatio: { threshold: 1.5, weight: 2 },   // V5.62 FIX: Was 1.2, now 1.5 to match backtest
    candleBody: { threshold: 0.5, weight: 1 },    // V5.62 FIX: Was 0.6, now 0.5 to match backtest
    momentum: { threshold: 0.5, weight: 1 },
  },
};

export interface NfsResult {
  score: number;                    // 0-100
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  shouldExitImmediately: boolean;
  components: NfsComponents;
  recommendation: 'EXIT_NOW' | 'PLACE_LIMIT' | 'WAIT' | 'FALLBACK_2CLOSE';
}

export interface NfsComponents {
  breachATRRatio: number;
  breachDepthPct: number;
  volumeRatio: number;
  candleBodyRatio: number;
  momentumROC5: number;
  rawScores: {
    breachATR: number;
    breachDepth: number;
    volume: number;
    candleBody: number;
    momentum: number;
  };
}

// State machine states
export type NfsExitState =
  | 'MONITORING'      // Normal state, watching price
  | 'PRE_BREACH'      // Price approaching trailing (< 0.3%)
  | 'BREACH_DETECTED' // Price touched trailing, calculating NFS
  | 'LIMIT_PENDING'   // LIMIT order placed, waiting for fill
  | 'MARKET_FALLBACK' // LIMIT failed, executing market
  | 'WAITING_2CLOSE'  // Low NFS, waiting for 2-close confirmation
  | 'EXITING'         // Exit in progress
  | 'EXITED';         // Position closed

export interface NfsStateData {
  state: NfsExitState;
  enteredAt: number;

  // Breach tracking
  breachCount: number;
  lastBreachTimestamp: number | null;
  lastNfsResult: NfsResult | null;

  // Order tracking
  pendingLimitOrderId: string | null;
  limitOrderPlacedAt: number | null;
  limitOrderPrice: number | null;

  // Metrics
  trailingStopPrice: number | null;
  distanceToTrailingPct: number | null;
}

export interface TrailingExitLog {
  tradeId: string;
  symbol: string;
  side: 'long' | 'short';
  timestamp: number;

  // Prix
  trailingStopPrice: number;
  actualExitPrice: number;
  slippagePct: number;
  slippageUsd: number;

  // NFS
  nfsScore: number;
  nfsConfidence: string;
  nfsComponents: NfsComponents;

  // Execution
  exitMethod: 'LIMIT_FILLED' | 'LIMIT_PARTIAL' | 'MARKET_FALLBACK' | 'MARKET_DIRECT' | '2CLOSE_FALLBACK';
  orderAttempts: number;
  timeTakenMs: number;

  // Context
  wasWsConnected: boolean;
  state: NfsExitState;
}

// ═══════════════════════════════════════════════════════════════════════════
// NFS CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════

export class NfsCalculator {
  private config: NfsConfig;

  constructor(config: Partial<NfsConfig> = {}) {
    this.config = { ...DEFAULT_NFS_CONFIG, ...config };
  }

  /**
   * Calculate NFS score for a trailing breach
   *
   * V5.65: Added comprehensive error handling to prevent crashes
   */
  calculate(
    currentCandle: Candle,
    prevCandles: Candle[],
    side: 'long' | 'short',
    trailingStopPrice: number
  ): NfsResult {
    try {
      // Input validation
      if (!currentCandle || typeof currentCandle.close !== 'number' || !Number.isFinite(currentCandle.close)) {
        logger.warn('[NFS] Invalid currentCandle, returning safe LOW result');
        return this.createSafeResult('Invalid candle data');
      }

      if (!Number.isFinite(trailingStopPrice) || trailingStopPrice <= 0) {
        logger.warn(`[NFS] Invalid trailingStopPrice: ${trailingStopPrice}, returning safe LOW result`);
        return this.createSafeResult('Invalid trailing stop price');
      }

      if (!Array.isArray(prevCandles) || prevCandles.length === 0) {
        logger.warn('[NFS] No previous candles, returning safe LOW result');
        return this.createSafeResult('No previous candles');
      }

      const components = this.computeComponents(
        currentCandle,
        prevCandles,
        side,
        trailingStopPrice
      );

      const score = this.computeScore(components, side);

      // Validate computed score
      if (!Number.isFinite(score) || score < 0) {
        logger.warn(`[NFS] Invalid computed score: ${score}, returning safe LOW result`);
        return this.createSafeResult('Invalid computed score');
      }

      const confidence = this.determineConfidence(score);
      const recommendation = this.determineRecommendation(score, confidence);

      return {
        score,
        confidence,
        shouldExitImmediately: score >= this.config.HIGH_CONFIDENCE_THRESHOLD,
        components,
        recommendation,
      };
    } catch (error) {
      logger.error('[NFS] Critical error in calculate(), returning safe LOW result:', error);
      return this.createSafeResult('Calculation error');
    }
  }

  /**
   * Create a safe fallback result when calculation fails
   * Returns LOW confidence to trigger 2-close confirmation (safest approach)
   */
  private createSafeResult(reason: string): NfsResult {
    return {
      score: 0,
      confidence: 'LOW',
      shouldExitImmediately: false,
      components: {
        breachATRRatio: 0,
        breachDepthPct: 0,
        volumeRatio: 1,
        candleBodyRatio: 0,
        momentumROC5: 0,
        rawScores: {
          breachATR: 0,
          breachDepth: 0,
          volume: 0,
          candleBody: 0,
          momentum: 0,
        },
      },
      recommendation: 'FALLBACK_2CLOSE',
    };
  }

  private computeComponents(
    candle: Candle,
    prevCandles: Candle[],
    side: 'long' | 'short',
    trailingStopPrice: number
  ): NfsComponents {
    // V5.65: Add safety wrapper for component computation
    try {
      // Filter out invalid candles
      const validPrevCandles = prevCandles.filter(c =>
        c && typeof c.close === 'number' && Number.isFinite(c.close) &&
        typeof c.high === 'number' && Number.isFinite(c.high) &&
        typeof c.low === 'number' && Number.isFinite(c.low)
      );

      const allCandles = [...validPrevCandles.slice(-20), candle];

      // 1. Breach depth (with safety)
      let breachDepthAbs: number;
      let breachDepthPct: number;

      if (side === 'long') {
        breachDepthAbs = Math.max(0, trailingStopPrice - candle.close);
        breachDepthPct = trailingStopPrice > 0
          ? (breachDepthAbs / trailingStopPrice) * 100
          : 0;
      } else {
        breachDepthAbs = Math.max(0, candle.close - trailingStopPrice);
        breachDepthPct = trailingStopPrice > 0
          ? (breachDepthAbs / trailingStopPrice) * 100
          : 0;
      }

      // Clamp to reasonable range
      breachDepthPct = Math.min(breachDepthPct, 100);

      // 2. ATR calculation
      const atr = this.calcATR(allCandles, 14);
      const breachATRRatio = atr > 0 ? Math.min(breachDepthAbs / atr, 10) : 0; // Cap at 10x ATR

      // 3. Volume ratio (with safety)
      const volumes = allCandles.map(c => Math.max(0, c.volume || 0));
      const volumeRatio = Math.min(this.calcVolRatio(volumes), 100); // Cap at 100x average

      // 4. Candle body ratio (with division by zero protection)
      const bodySize = Math.abs(candle.close - candle.open);
      const candleRange = candle.high - candle.low;
      const candleBodyRatio = candleRange > 0 ? Math.min(bodySize / candleRange, 1) : 0;

      // 5. Momentum (ROC5) with safety
      const closes = allCandles.map(c => c.close).filter(c => Number.isFinite(c));
      const momentumROC5 = closes.length >= 6 ? this.calcROC(closes, 5) : 0;

      // Raw scores (0-1 normalized, with safety clamping)
      const w = this.config.WEIGHTS;

      const rawScores = {
        breachATR: Math.max(0, Math.min(1, breachATRRatio / (w.breachATR.threshold * 2))),
        breachDepth: Math.max(0, Math.min(1, breachDepthPct / (w.breachDepth.threshold * 2))),
        volume: Math.max(0, Math.min(1, volumeRatio / (w.volumeRatio.threshold * 2))),
        candleBody: Math.max(0, Math.min(1, candleBodyRatio)),
        momentum: Math.max(0, Math.min(1, Math.abs(momentumROC5) / (w.momentum.threshold * 2))),
      };

      return {
        breachATRRatio: Number.isFinite(breachATRRatio) ? breachATRRatio : 0,
        breachDepthPct: Number.isFinite(breachDepthPct) ? breachDepthPct : 0,
        volumeRatio: Number.isFinite(volumeRatio) ? volumeRatio : 1,
        candleBodyRatio: Number.isFinite(candleBodyRatio) ? candleBodyRatio : 0,
        momentumROC5: Number.isFinite(momentumROC5) ? momentumROC5 : 0,
        rawScores,
      };
    } catch (error) {
      logger.error('[NFS] Error in computeComponents:', error);
      // Return safe defaults
      return {
        breachATRRatio: 0,
        breachDepthPct: 0,
        volumeRatio: 1,
        candleBodyRatio: 0,
        momentumROC5: 0,
        rawScores: { breachATR: 0, breachDepth: 0, volume: 0, candleBody: 0, momentum: 0 },
      };
    }
  }

  private computeScore(components: NfsComponents, side: 'long' | 'short'): number {
    const w = this.config.WEIGHTS;
    let score = 0;
    let maxScore = 0;

    // 1. Breach/ATR (highest weight - best discriminator from analysis)
    maxScore += w.breachATR.weight;
    if (components.breachATRRatio >= w.breachATR.threshold) {
      score += w.breachATR.weight;
    } else if (components.breachATRRatio >= w.breachATR.threshold * 0.5) {
      score += w.breachATR.weight * 0.5;
    }

    // 2. Breach Depth
    maxScore += w.breachDepth.weight;
    if (components.breachDepthPct >= w.breachDepth.threshold) {
      score += w.breachDepth.weight;
    } else if (components.breachDepthPct >= w.breachDepth.threshold * 0.5) {
      score += w.breachDepth.weight * 0.5;
    }

    // 3. Volume
    maxScore += w.volumeRatio.weight;
    if (components.volumeRatio >= w.volumeRatio.threshold) {
      score += w.volumeRatio.weight;
    } else if (components.volumeRatio >= w.volumeRatio.threshold * 0.8) {
      score += w.volumeRatio.weight * 0.5;
    }

    // 4. Candle Body
    maxScore += w.candleBody.weight;
    if (components.candleBodyRatio >= w.candleBody.threshold) {
      score += w.candleBody.weight;
    }

    // 5. Momentum alignment
    maxScore += w.momentum.weight;
    const momentumAligned = side === 'long'
      ? components.momentumROC5 <= -w.momentum.threshold
      : components.momentumROC5 >= w.momentum.threshold;
    if (momentumAligned) {
      score += w.momentum.weight;
    }

    return maxScore > 0 ? (score / maxScore) * 100 : 0;
  }

  private determineConfidence(score: number): 'HIGH' | 'MEDIUM' | 'LOW' {
    if (score >= this.config.HIGH_CONFIDENCE_THRESHOLD) return 'HIGH';
    if (score >= this.config.MEDIUM_CONFIDENCE_THRESHOLD) return 'MEDIUM';
    return 'LOW';
  }

  private determineRecommendation(
    score: number,
    confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  ): 'EXIT_NOW' | 'PLACE_LIMIT' | 'WAIT' | 'FALLBACK_2CLOSE' {
    if (confidence === 'HIGH') {
      return 'EXIT_NOW';
    }
    if (confidence === 'MEDIUM') {
      return 'PLACE_LIMIT';
    }
    return 'FALLBACK_2CLOSE';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // INDICATOR HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  private calcATR(candles: Candle[], period: number = 14): number {
    if (candles.length < period + 1) return 0;

    const trueRanges: number[] = [];
    for (let i = candles.length - period; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1]?.close ?? candles[i].open;
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }

    return trueRanges.reduce((a, b) => a + b, 0) / period;
  }

  private calcVolRatio(volumes: number[]): number {
    if (volumes.length < 21) return 1;
    const current = volumes[volumes.length - 1];
    const avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    return avg > 0 ? current / avg : 1;
  }

  private calcROC(closes: number[], period: number): number {
    if (closes.length < period + 1) return 0;
    const curr = closes[closes.length - 1];
    const prev = closes[closes.length - 1 - period];
    return prev === 0 ? 0 : ((curr - prev) / prev) * 100;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// NFS EXIT STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════

export class NfsExitStateMachine {
  private state: NfsStateData;
  private config: NfsConfig;
  private calculator: NfsCalculator;
  private onStateChange?: (oldState: NfsExitState, newState: NfsExitState) => void;

  constructor(
    config: Partial<NfsConfig> = {},
    onStateChange?: (oldState: NfsExitState, newState: NfsExitState) => void
  ) {
    this.config = { ...DEFAULT_NFS_CONFIG, ...config };
    this.calculator = new NfsCalculator(this.config);
    this.onStateChange = onStateChange;
    this.state = this.createInitialState();
  }

  private createInitialState(): NfsStateData {
    return {
      state: 'MONITORING',
      enteredAt: Date.now(),
      breachCount: 0,
      lastBreachTimestamp: null,
      lastNfsResult: null,
      pendingLimitOrderId: null,
      limitOrderPlacedAt: null,
      limitOrderPrice: null,
      trailingStopPrice: null,
      distanceToTrailingPct: null,
    };
  }

  reset(): void {
    this.state = this.createInitialState();
  }

  getState(): NfsStateData {
    return { ...this.state };
  }

  getCurrentState(): NfsExitState {
    return this.state.state;
  }

  private transition(newState: NfsExitState): void {
    const oldState = this.state.state;
    if (oldState !== newState) {
      logger.debug(`[NFS] State transition: ${oldState} → ${newState}`);
      this.state.state = newState;
      this.state.enteredAt = Date.now();
      this.onStateChange?.(oldState, newState);
    }
  }

  /**
   * Main evaluation function - called on each price update
   *
   * V5.65: Added comprehensive error handling
   */
  evaluate(
    currentPrice: number,
    currentCandle: Candle,
    prevCandles: Candle[],
    side: 'long' | 'short',
    trailingStopPrice: number,
    highWaterMark: number,
    lowWaterMark: number
  ): NfsEvaluationResult {
    try {
      // V5.65: Input validation
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        logger.warn(`[NFS] Invalid currentPrice: ${currentPrice}`);
        return { action: 'NONE', reason: 'Invalid current price' };
      }

      if (!Number.isFinite(trailingStopPrice) || trailingStopPrice <= 0) {
        logger.warn(`[NFS] Invalid trailingStopPrice: ${trailingStopPrice}`);
        return { action: 'NONE', reason: 'Invalid trailing stop price' };
      }

      // Update tracking
      this.state.trailingStopPrice = trailingStopPrice;

      // Calculate distance to trailing (with division-by-zero protection)
      const distanceToTrailing = side === 'long'
        ? currentPrice - trailingStopPrice
        : trailingStopPrice - currentPrice;
      const distanceToTrailingPct = trailingStopPrice > 0
        ? (distanceToTrailing / trailingStopPrice) * 100
        : 0;
      this.state.distanceToTrailingPct = Number.isFinite(distanceToTrailingPct) ? distanceToTrailingPct : 0;

      // Check breach conditions
      const isBreaching = side === 'long'
        ? currentPrice <= trailingStopPrice
        : currentPrice >= trailingStopPrice;

      const isApproaching = !isBreaching &&
        distanceToTrailingPct <= this.config.PRE_BREACH_DISTANCE_PCT;

      // State machine logic
      switch (this.state.state) {
        case 'MONITORING':
          return this.handleMonitoring(isApproaching, isBreaching, currentCandle, prevCandles, side, trailingStopPrice);

        case 'PRE_BREACH':
          return this.handlePreBreach(isBreaching, currentCandle, prevCandles, side, trailingStopPrice);

        case 'BREACH_DETECTED':
          return this.handleBreachDetected(isBreaching, currentCandle, prevCandles, side, trailingStopPrice);

        case 'LIMIT_PENDING':
          return this.handleLimitPending(isBreaching);

        case 'WAITING_2CLOSE':
        return this.handleWaiting2Close(isBreaching, currentCandle);

      case 'MARKET_FALLBACK':
      case 'EXITING':
      case 'EXITED':
        return { action: 'NONE', reason: `In terminal state: ${this.state.state}` };

      default:
        return { action: 'NONE', reason: 'Unknown state' };
      }
    } catch (error) {
      // V5.65: Catch any errors in the state machine to prevent crashes
      logger.error('[NFS] Critical error in evaluate():', error);
      // Return safe action - wait for 2-close confirmation
      return { action: 'WAIT', reason: 'Error in state machine - falling back to 2-close' };
    }
  }

  private handleMonitoring(
    isApproaching: boolean,
    isBreaching: boolean,
    candle: Candle,
    prevCandles: Candle[],
    side: 'long' | 'short',
    trailingStopPrice: number
  ): NfsEvaluationResult {
    if (isBreaching) {
      // Direct breach - calculate NFS immediately
      const nfs = this.calculator.calculate(candle, prevCandles, side, trailingStopPrice);
      this.state.lastNfsResult = nfs;
      this.state.breachCount = 1;
      this.state.lastBreachTimestamp = Date.now();

      if (nfs.shouldExitImmediately) {
        this.transition('BREACH_DETECTED');
        return {
          action: 'EXIT_MARKET',
          reason: `NFS HIGH (${nfs.score.toFixed(0)}) - exit immediately`,
          nfsResult: nfs,
          targetPrice: trailingStopPrice,
        };
      } else if (nfs.confidence === 'MEDIUM') {
        this.transition('LIMIT_PENDING');
        return {
          action: 'PLACE_LIMIT',
          reason: `NFS MEDIUM (${nfs.score.toFixed(0)}) - try LIMIT`,
          nfsResult: nfs,
          targetPrice: trailingStopPrice,
        };
      } else {
        this.transition('WAITING_2CLOSE');
        return {
          action: 'WAIT',
          reason: `NFS LOW (${nfs.score.toFixed(0)}) - wait for 2-close`,
          nfsResult: nfs,
        };
      }
    }

    if (isApproaching) {
      this.transition('PRE_BREACH');
      return {
        action: 'ALERT',
        reason: `Approaching trailing (${this.state.distanceToTrailingPct?.toFixed(2)}%)`,
      };
    }

    return { action: 'NONE', reason: 'Normal monitoring' };
  }

  private handlePreBreach(
    isBreaching: boolean,
    candle: Candle,
    prevCandles: Candle[],
    side: 'long' | 'short',
    trailingStopPrice: number
  ): NfsEvaluationResult {
    if (isBreaching) {
      // Breach occurred - same logic as monitoring
      return this.handleMonitoring(false, true, candle, prevCandles, side, trailingStopPrice);
    }

    // Check if we moved away from trailing
    if ((this.state.distanceToTrailingPct ?? 0) > this.config.PRE_BREACH_DISTANCE_PCT * 1.5) {
      this.transition('MONITORING');
      return { action: 'NONE', reason: 'Moved away from trailing' };
    }

    return { action: 'ALERT', reason: 'Still approaching trailing' };
  }

  private handleBreachDetected(
    isBreaching: boolean,
    candle: Candle,
    prevCandles: Candle[],
    side: 'long' | 'short',
    trailingStopPrice: number
  ): NfsEvaluationResult {
    // This state is transient - should immediately result in action
    const nfs = this.state.lastNfsResult;

    if (nfs?.shouldExitImmediately) {
      this.transition('EXITING');
      return {
        action: 'EXIT_MARKET',
        reason: 'Executing immediate exit',
        nfsResult: nfs,
        targetPrice: trailingStopPrice,
      };
    }

    // Should not reach here normally
    this.transition('WAITING_2CLOSE');
    return { action: 'WAIT', reason: 'Fallback to 2-close' };
  }

  private handleLimitPending(isBreaching: boolean): NfsEvaluationResult {
    const elapsed = Date.now() - (this.state.limitOrderPlacedAt ?? Date.now());

    // Check timeout
    if (elapsed >= this.config.LIMIT_ORDER_TIMEOUT_MS) {
      this.transition('MARKET_FALLBACK');
      return {
        action: 'CANCEL_LIMIT_AND_MARKET',
        reason: `LIMIT timeout (${elapsed}ms) - market fallback`,
        orderId: this.state.pendingLimitOrderId ?? undefined,
      };
    }

    // If price recovered above trailing, cancel and reset
    if (!isBreaching) {
      this.transition('MONITORING');
      return {
        action: 'CANCEL_LIMIT',
        reason: 'Price recovered - cancel LIMIT',
        orderId: this.state.pendingLimitOrderId ?? undefined,
      };
    }

    return { action: 'NONE', reason: 'Waiting for LIMIT fill' };
  }

  private handleWaiting2Close(
    isBreaching: boolean,
    candle: Candle
  ): NfsEvaluationResult {
    if (!isBreaching) {
      // Price recovered - reset
      this.state.breachCount = 0;
      this.transition('MONITORING');
      return { action: 'NONE', reason: 'Price recovered - reset breach count' };
    }

    // Check if this is a new candle close
    if (candle.isFinal) {
      this.state.breachCount++;
      this.state.lastBreachTimestamp = Date.now();

      if (this.state.breachCount >= 2) {
        this.transition('EXITING');
        return {
          action: 'EXIT_MARKET',
          reason: `2-close confirmation (count=${this.state.breachCount})`,
          targetPrice: this.state.trailingStopPrice ?? undefined,
        };
      }

      return {
        action: 'WAIT',
        reason: `Breach ${this.state.breachCount}/2 - waiting for next close`,
      };
    }

    return { action: 'NONE', reason: 'Waiting for candle close' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ORDER TRACKING
  // ─────────────────────────────────────────────────────────────────────────

  setLimitOrderPending(orderId: string, price: number): void {
    this.state.pendingLimitOrderId = orderId;
    this.state.limitOrderPlacedAt = Date.now();
    this.state.limitOrderPrice = price;
    this.transition('LIMIT_PENDING');
  }

  onLimitOrderFilled(): void {
    this.state.pendingLimitOrderId = null;
    this.transition('EXITED');
  }

  onLimitOrderCancelled(): void {
    this.state.pendingLimitOrderId = null;
    this.state.limitOrderPlacedAt = null;
    this.state.limitOrderPrice = null;
    // Don't transition - let the next evaluate() decide
  }

  onLimitOrderRejected(): void {
    this.state.pendingLimitOrderId = null;
    this.transition('MARKET_FALLBACK');
  }

  onExitComplete(): void {
    this.transition('EXITED');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EVALUATION RESULT
// ═══════════════════════════════════════════════════════════════════════════

export interface NfsEvaluationResult {
  action: 'NONE' | 'ALERT' | 'PLACE_LIMIT' | 'EXIT_MARKET' | 'CANCEL_LIMIT' | 'CANCEL_LIMIT_AND_MARKET' | 'WAIT';
  reason: string;
  nfsResult?: NfsResult;
  targetPrice?: number;
  orderId?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export function createNfsExitSystem(
  config?: Partial<NfsConfig>,
  onStateChange?: (oldState: NfsExitState, newState: NfsExitState) => void
): {
  calculator: NfsCalculator;
  stateMachine: NfsExitStateMachine;
} {
  const mergedConfig = { ...DEFAULT_NFS_CONFIG, ...config };
  return {
    calculator: new NfsCalculator(mergedConfig),
    stateMachine: new NfsExitStateMachine(mergedConfig, onStateChange),
  };
}
