/**
 * V5.71: Signal Radar Service
 *
 * Smart logging system that tracks market state and logs only meaningful changes.
 * Instead of spamming every tick or every 15m check, we detect transitions:
 * - Symbol proximity to signal (warming up, cooling down, almost ready)
 * - Market regime changes (BULL → BEAR)
 * - Position state changes (trailing activated, approaching target)
 *
 * This reduces noise in the frontend feed while keeping users informed
 * of what actually matters.
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('signal-radar');

// ============================================================================
// TYPES
// ============================================================================

export interface SignalFeatures {
  roc: number;           // Rate of change %
  volRatio: number;      // Volume ratio vs average
  bbDistance: number;    // Distance from BB (+ above, - below)
  atrPct: number;        // ATR as % of price
  trendStrength: number; // Trend strength 0-100
}

export interface SymbolState {
  symbol: string;
  proximityScore: number;      // 0-100, how close to triggering a signal
  regime: 'BULL' | 'BEAR' | 'NEUTRAL';
  features: SignalFeatures | null;
  lastUpdate: number;

  // Position state (if in position)
  inPosition: boolean;
  positionSide?: 'long' | 'short';
  positionPnlPct?: number;
  trailingActive?: boolean;
  trailingStopPct?: number;
}

export interface MarketState {
  btcRegime: 'BULL' | 'BEAR' | 'NEUTRAL';
  volatility: 'HIGH' | 'MEDIUM' | 'LOW';
  activeSignals: number;       // How many symbols have high proximity
  lastUpdate: number;
}

export interface RadarEvent {
  type: 'symbol_proximity' | 'market_regime' | 'market_volatility' | 'position_update' | 'opportunity_alert';
  severity: 'info' | 'warning' | 'success';
  title: string;
  message: string;
  symbol?: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Proximity thresholds for logging
  PROXIMITY_CHANGE_THRESHOLD: 20,  // Log when score changes by this much
  PROXIMITY_HOT_THRESHOLD: 70,     // "Almost ready" threshold
  PROXIMITY_WARM_THRESHOLD: 50,    // "Warming up" threshold
  PROXIMITY_COLD_THRESHOLD: 30,    // Below this = cold

  // Cooldown between logs for same symbol (ms)
  LOG_COOLDOWN_MS: 5 * 60 * 1000,  // 5 minutes

  // Position update thresholds
  PNL_CHANGE_THRESHOLD: 1.0,       // Log when PnL changes by 1%
  TRAILING_PROXIMITY_ALERT: 0.5,   // Alert when within 0.5% of trailing stop
};

// ============================================================================
// STATE MEMORY
// ============================================================================

// Memory of last logged state per symbol
const symbolMemory: Map<string, {
  lastLoggedScore: number;
  lastLoggedRegime: string;
  lastLoggedAt: number;
  lastLoggedPnlPct: number;
  lastLoggedTrailingActive: boolean;
}> = new Map();

// Memory of last logged market state
let marketMemory: {
  lastLoggedRegime: string;
  lastLoggedVolatility: string;
  lastLoggedActiveSignals: number;
  lastLoggedAt: number;
} = {
  lastLoggedRegime: 'NEUTRAL',
  lastLoggedVolatility: 'MEDIUM',
  lastLoggedActiveSignals: 0,
  lastLoggedAt: 0,
};

// Broadcast function (set by server.ts)
let broadcastFn: ((type: string, data: unknown, symbol?: string) => void) | null = null;

// V5.72: Event buffer for activity feed (stores recent events)
const EVENT_BUFFER_MAX_SIZE = 100;
const eventBuffer: RadarEvent[] = [];

/**
 * V5.72: Add event to buffer and broadcast
 */
function emitEvent(event: RadarEvent): void {
  // Add to buffer
  eventBuffer.unshift(event);
  if (eventBuffer.length > EVENT_BUFFER_MAX_SIZE) {
    eventBuffer.pop();
  }

  // Broadcast to ALL connected clients (no symbol filter - radar is global feed)
  if (broadcastFn) {
    broadcastFn('radar_event', event);  // No symbol = broadcast to all
  }

  // Log to console for debugging
  logger.info(`[RADAR] ${event.title} - ${event.message}`);
}

/**
 * V5.72: Get recent radar events for activity feed
 */
export function getRecentRadarEvents(opts: {
  limit?: number;
  symbol?: string;
  sessionId?: string;
} = {}): RadarEvent[] {
  const limit = opts.limit || 50;
  let events = [...eventBuffer];

  // Filter by symbol if provided
  if (opts.symbol) {
    const targetSymbol = opts.symbol;
    events = events.filter(e => e.symbol === targetSymbol || e.symbol?.includes(targetSymbol));
  }

  return events.slice(0, limit);
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Set the broadcast function for sending events to frontend
 */
export function setRadarBroadcast(fn: (type: string, data: unknown, symbol?: string) => void): void {
  broadcastFn = fn;
}

/**
 * Calculate proximity score from signal features
 * Returns 0-100 representing how close to a valid entry signal
 */
export function calculateProximityScore(
  features: SignalFeatures | null,
  regime: 'BULL' | 'BEAR' | 'NEUTRAL',
  inPosition: boolean
): number {
  if (!features || inPosition) return 0;

  let score = 0;

  // ROC contribution (0-30 points)
  // Good ROC for entry: 0.3-1.5% for long, -0.3 to -1.5% for short
  const absRoc = Math.abs(features.roc);
  if (absRoc >= 0.3 && absRoc <= 2.0) {
    score += Math.min(30, absRoc * 20);
  }

  // Volume contribution (0-25 points)
  // Good volume: 1.2x - 3x average
  if (features.volRatio >= 1.2) {
    score += Math.min(25, (features.volRatio - 1) * 20);
  }

  // BB distance contribution (0-25 points)
  // For breakout, we want price near or beyond BB
  const absBB = Math.abs(features.bbDistance);
  if (absBB >= 0.5) {
    score += Math.min(25, absBB * 10);
  }

  // Regime alignment contribution (0-20 points)
  // Bull regime with positive ROC, or Bear regime with negative ROC
  if (regime === 'BULL' && features.roc > 0) {
    score += 20;
  } else if (regime === 'BEAR' && features.roc < 0) {
    score += 20;
  } else if (regime === 'NEUTRAL') {
    score += 10; // Partial credit
  }

  return Math.min(100, Math.round(score));
}

/**
 * Update symbol state and emit events if significant change
 */
export function updateSymbolState(state: SymbolState): RadarEvent[] {
  const events: RadarEvent[] = [];
  const now = Date.now();
  const shortSymbol = state.symbol.replace('/USDT:USDT', '');

  // Get or create memory for this symbol
  let memory = symbolMemory.get(state.symbol);
  if (!memory) {
    memory = {
      lastLoggedScore: 0,
      lastLoggedRegime: 'NEUTRAL',
      lastLoggedAt: 0,
      lastLoggedPnlPct: 0,
      lastLoggedTrailingActive: false,
    };
    symbolMemory.set(state.symbol, memory);
  }

  // Check cooldown
  const cooldownExpired = (now - memory.lastLoggedAt) > CONFIG.LOG_COOLDOWN_MS;

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. PROXIMITY SCORE CHANGES
  // ═══════════════════════════════════════════════════════════════════════════

  if (!state.inPosition) {
    const scoreDiff = state.proximityScore - memory.lastLoggedScore;
    const absScoreDiff = Math.abs(scoreDiff);

    // Log if significant change OR crossing a threshold
    const crossedHot = state.proximityScore >= CONFIG.PROXIMITY_HOT_THRESHOLD &&
                       memory.lastLoggedScore < CONFIG.PROXIMITY_HOT_THRESHOLD;
    const crossedWarm = state.proximityScore >= CONFIG.PROXIMITY_WARM_THRESHOLD &&
                        memory.lastLoggedScore < CONFIG.PROXIMITY_WARM_THRESHOLD;
    const crossedCold = state.proximityScore < CONFIG.PROXIMITY_COLD_THRESHOLD &&
                        memory.lastLoggedScore >= CONFIG.PROXIMITY_COLD_THRESHOLD;

    if (absScoreDiff >= CONFIG.PROXIMITY_CHANGE_THRESHOLD || crossedHot || crossedWarm) {
      let emoji = '🌡️';
      let status = '';

      if (crossedHot || state.proximityScore >= CONFIG.PROXIMITY_HOT_THRESHOLD) {
        emoji = '🔥';
        status = 'Almost ready';
      } else if (scoreDiff > 0) {
        emoji = '📈';
        status = 'Warming up';
      } else if (crossedCold) {
        emoji = '❄️';
        status = 'Cooling down';
      } else if (scoreDiff < 0) {
        emoji = '📉';
        status = 'Fading';
      }

      if (status && cooldownExpired) {
        const featureStr = state.features
          ? `ROC=${state.features.roc.toFixed(1)}% Vol=${state.features.volRatio.toFixed(1)}x BB=${state.features.bbDistance.toFixed(1)}%`
          : '';

        events.push({
          type: 'symbol_proximity',
          severity: crossedHot ? 'warning' : 'info',
          title: `${emoji} [${shortSymbol}] ${status}`,
          message: `${memory.lastLoggedScore}% → ${state.proximityScore}% | ${featureStr}`,
          symbol: state.symbol,
          data: {
            oldScore: memory.lastLoggedScore,
            newScore: state.proximityScore,
            features: state.features
          },
          timestamp: now,
        });

        memory.lastLoggedScore = state.proximityScore;
        memory.lastLoggedAt = now;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. POSITION STATE CHANGES
  // ═══════════════════════════════════════════════════════════════════════════

  if (state.inPosition) {
    // Trailing just activated
    if (state.trailingActive && !memory.lastLoggedTrailingActive) {
      events.push({
        type: 'position_update',
        severity: 'success',
        title: `📍 [${shortSymbol}] Trailing activated`,
        message: `${state.positionSide?.toUpperCase()} position now trailing at +${state.positionPnlPct?.toFixed(1)}%`,
        symbol: state.symbol,
        data: { pnlPct: state.positionPnlPct, trailingActive: true },
        timestamp: now,
      });
      memory.lastLoggedTrailingActive = true;
      memory.lastLoggedAt = now;
    }

    // Significant PnL change
    const pnlDiff = Math.abs((state.positionPnlPct || 0) - memory.lastLoggedPnlPct);
    if (pnlDiff >= CONFIG.PNL_CHANGE_THRESHOLD && cooldownExpired) {
      const pnl = state.positionPnlPct || 0;
      const emoji = pnl > memory.lastLoggedPnlPct ? '💹' : '📉';

      events.push({
        type: 'position_update',
        severity: pnl > 0 ? 'success' : 'warning',
        title: `${emoji} [${shortSymbol}] PnL update`,
        message: `${state.positionSide?.toUpperCase()} ${memory.lastLoggedPnlPct.toFixed(1)}% → ${pnl.toFixed(1)}%`,
        symbol: state.symbol,
        data: { oldPnl: memory.lastLoggedPnlPct, newPnl: pnl },
        timestamp: now,
      });
      memory.lastLoggedPnlPct = pnl;
      memory.lastLoggedAt = now;
    }
  } else {
    // Reset position memory when not in position
    memory.lastLoggedTrailingActive = false;
    memory.lastLoggedPnlPct = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. REGIME CHANGES (per symbol)
  // ═══════════════════════════════════════════════════════════════════════════

  if (state.regime !== memory.lastLoggedRegime) {
    events.push({
      type: 'symbol_proximity',
      severity: 'info',
      title: `🔄 [${shortSymbol}] Regime change`,
      message: `${memory.lastLoggedRegime} → ${state.regime}`,
      symbol: state.symbol,
      data: { oldRegime: memory.lastLoggedRegime, newRegime: state.regime },
      timestamp: now,
    });
    memory.lastLoggedRegime = state.regime;
    memory.lastLoggedAt = now;
  }

  // V5.72: Emit events (store in buffer + broadcast)
  for (const event of events) {
    emitEvent(event);
  }

  return events;
}

/**
 * Update market state and emit events if significant change
 */
export function updateMarketState(state: MarketState): RadarEvent[] {
  const events: RadarEvent[] = [];
  const now = Date.now();

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. BTC REGIME CHANGE
  // ═══════════════════════════════════════════════════════════════════════════

  if (state.btcRegime !== marketMemory.lastLoggedRegime) {
    const emoji = state.btcRegime === 'BULL' ? '🟢' : state.btcRegime === 'BEAR' ? '🔴' : '⚪';

    events.push({
      type: 'market_regime',
      severity: 'warning',
      title: `${emoji} [MARKET] BTC Regime Change`,
      message: `${marketMemory.lastLoggedRegime} → ${state.btcRegime}`,
      data: { oldRegime: marketMemory.lastLoggedRegime, newRegime: state.btcRegime },
      timestamp: now,
    });
    marketMemory.lastLoggedRegime = state.btcRegime;
    marketMemory.lastLoggedAt = now;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. VOLATILITY CHANGE
  // ═══════════════════════════════════════════════════════════════════════════

  if (state.volatility !== marketMemory.lastLoggedVolatility) {
    const emoji = state.volatility === 'HIGH' ? '⚡' : state.volatility === 'LOW' ? '😴' : '〰️';

    events.push({
      type: 'market_volatility',
      severity: 'info',
      title: `${emoji} [MARKET] Volatility Change`,
      message: `${marketMemory.lastLoggedVolatility} → ${state.volatility}`,
      data: { oldVolatility: marketMemory.lastLoggedVolatility, newVolatility: state.volatility },
      timestamp: now,
    });
    marketMemory.lastLoggedVolatility = state.volatility;
    marketMemory.lastLoggedAt = now;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. OPPORTUNITY ALERTS
  // ═══════════════════════════════════════════════════════════════════════════

  // Multiple symbols heating up
  if (state.activeSignals >= 3 && marketMemory.lastLoggedActiveSignals < 3) {
    events.push({
      type: 'opportunity_alert',
      severity: 'warning',
      title: `⚡ [MARKET] Multiple opportunities`,
      message: `${state.activeSignals} symbols with >70% proximity score`,
      data: { activeSignals: state.activeSignals },
      timestamp: now,
    });
    marketMemory.lastLoggedActiveSignals = state.activeSignals;
    marketMemory.lastLoggedAt = now;
  }

  // All quiet
  if (state.activeSignals === 0 && marketMemory.lastLoggedActiveSignals > 0) {
    const timeSinceLog = now - marketMemory.lastLoggedAt;
    if (timeSinceLog > 30 * 60 * 1000) { // Only log if >30min since last
      events.push({
        type: 'opportunity_alert',
        severity: 'info',
        title: `😴 [MARKET] All quiet`,
        message: `No symbols with high proximity. Market cooling down.`,
        data: { activeSignals: 0 },
        timestamp: now,
      });
      marketMemory.lastLoggedActiveSignals = 0;
      marketMemory.lastLoggedAt = now;
    }
  }

  // V5.72: Emit events (store in buffer + broadcast)
  for (const event of events) {
    emitEvent(event);
  }

  return events;
}

/**
 * Log entry event (always logged to feed + telegram)
 */
export function logEntry(params: {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  quantity: number;
  leverage: number;
  mode: 'paper' | 'live';
}): RadarEvent {
  const shortSymbol = params.symbol.replace('/USDT:USDT', '');
  const emoji = params.side === 'long' ? '🟢' : '🔴';

  const event: RadarEvent = {
    type: 'position_update',
    severity: 'success',
    title: `${emoji} [${shortSymbol}] ENTRY ${params.side.toUpperCase()}`,
    message: `@ $${params.entryPrice.toFixed(2)} | Qty: ${params.quantity.toFixed(4)} | Lev: ${params.leverage}x | ${params.mode}`,
    symbol: params.symbol,
    data: params,
    timestamp: Date.now(),
  };

  // V5.72: Use emitEvent to store in buffer + broadcast
  emitEvent(event);

  return event;
}

/**
 * Log exit event (always logged to feed + telegram)
 */
export function logExit(params: {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  pnlUsd: number;
  pnlPct: number;
  reason: string;
  mode: 'paper' | 'live';
}): RadarEvent {
  const shortSymbol = params.symbol.replace('/USDT:USDT', '');
  const emoji = params.pnlUsd >= 0 ? '✅' : '❌';
  const pnlSign = params.pnlUsd >= 0 ? '+' : '';

  const event: RadarEvent = {
    type: 'position_update',
    severity: params.pnlUsd >= 0 ? 'success' : 'warning',
    title: `${emoji} [${shortSymbol}] EXIT ${params.side.toUpperCase()}`,
    message: `${pnlSign}$${params.pnlUsd.toFixed(2)} (${pnlSign}${params.pnlPct.toFixed(1)}%) | ${params.reason} | ${params.mode}`,
    symbol: params.symbol,
    data: params,
    timestamp: Date.now(),
  };

  // V5.72: Use emitEvent to store in buffer + broadcast
  emitEvent(event);

  return event;
}

/**
 * Reset memory (useful for testing)
 */
export function resetRadarMemory(): void {
  symbolMemory.clear();
  marketMemory = {
    lastLoggedRegime: 'NEUTRAL',
    lastLoggedVolatility: 'MEDIUM',
    lastLoggedActiveSignals: 0,
    lastLoggedAt: 0,
  };
}
