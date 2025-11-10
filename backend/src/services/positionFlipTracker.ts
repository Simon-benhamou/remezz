/**
 * Position Flip Tracker
 * 
 * Tracks position flips per session to enforce cooldowns and prevent overtrading.
 * Implements both time-based cooldown (minutes since last flip) and count-based
 * cooldown (max flips per hour).
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('position-flip-tracker');

type FlipEvent = {
  timestamp: number;
  fromSide: 'long' | 'short';
  toSide: 'long' | 'short';
  price: number;
  confidence: number;
  rMultiple: number;
};

type SessionFlipState = {
  lastFlipTimestamp: number | null;
  flips: FlipEvent[];
};

// Track flip state per session
const sessionFlipStates = new Map<string, SessionFlipState>();

/**
 * Get or create flip state for a session
 */
function getFlipState(sessionId: string): SessionFlipState {
  let state = sessionFlipStates.get(sessionId);
  if (!state) {
    state = {
      lastFlipTimestamp: null,
      flips: [],
    };
    sessionFlipStates.set(sessionId, state);
  }
  return state;
}

/**
 * Check if a position flip is allowed based on cooldown rules
 */
export function canFlipPosition(
  sessionId: string,
  config: {
    cooldownMinutes: number;
    maxFlipsPerHour: number;
  }
): { allowed: boolean; reason?: string } {
  const state = getFlipState(sessionId);
  const now = Date.now();

  // Check time-based cooldown
  if (state.lastFlipTimestamp !== null) {
    const minutesSinceLastFlip = (now - state.lastFlipTimestamp) / (1000 * 60);
    if (minutesSinceLastFlip < config.cooldownMinutes) {
      const remainingMinutes = Math.ceil(config.cooldownMinutes - minutesSinceLastFlip);
      return {
        allowed: false,
        reason: `Flip cooldown active: ${remainingMinutes} minutes remaining`,
      };
    }
  }

  // Check count-based cooldown (flips in the last hour)
  const oneHourAgo = now - (60 * 60 * 1000);
  const recentFlips = state.flips.filter(flip => flip.timestamp >= oneHourAgo);
  
  if (recentFlips.length >= config.maxFlipsPerHour) {
    return {
      allowed: false,
      reason: `Maximum flips per hour reached: ${recentFlips.length}/${config.maxFlipsPerHour}`,
    };
  }

  return { allowed: true };
}

/**
 * Record a position flip
 */
export function recordPositionFlip(
  sessionId: string,
  flip: {
    fromSide: 'long' | 'short';
    toSide: 'long' | 'short';
    price: number;
    confidence: number;
    rMultiple: number;
  }
): void {
  const state = getFlipState(sessionId);
  const now = Date.now();

  const flipEvent: FlipEvent = {
    timestamp: now,
    ...flip,
  };

  state.lastFlipTimestamp = now;
  state.flips.push(flipEvent);

  // Clean up old flips (keep last 24 hours for statistics)
  const oneDayAgo = now - (24 * 60 * 60 * 1000);
  state.flips = state.flips.filter(f => f.timestamp >= oneDayAgo);

  logger.info(
    `[${sessionId}] Position flip recorded: ${flip.fromSide} -> ${flip.toSide} @ ${flip.price.toFixed(4)} (confidence=${flip.confidence.toFixed(2)}, R=${flip.rMultiple.toFixed(2)})`
  );
}

/**
 * Get flip statistics for a session
 */
export function getFlipStats(sessionId: string): {
  totalFlipsLast24h: number;
  totalFlipsLastHour: number;
  lastFlipTimestamp: number | null;
  minutesSinceLastFlip: number | null;
} {
  const state = getFlipState(sessionId);
  const now = Date.now();

  const oneHourAgo = now - (60 * 60 * 1000);
  const oneDayAgo = now - (24 * 60 * 60 * 1000);

  const flipsLastHour = state.flips.filter(f => f.timestamp >= oneHourAgo).length;
  const flipsLast24h = state.flips.filter(f => f.timestamp >= oneDayAgo).length;

  const minutesSinceLastFlip =
    state.lastFlipTimestamp !== null
      ? (now - state.lastFlipTimestamp) / (1000 * 60)
      : null;

  return {
    totalFlipsLast24h: flipsLast24h,
    totalFlipsLastHour: flipsLastHour,
    lastFlipTimestamp: state.lastFlipTimestamp,
    minutesSinceLastFlip,
  };
}

/**
 * Clear flip history for a session (e.g., when session ends)
 */
export function clearFlipHistory(sessionId: string): void {
  sessionFlipStates.delete(sessionId);
  logger.info(`[${sessionId}] Flip history cleared`);
}

/**
 * Get all sessions with flip history (for monitoring)
 */
export function getAllSessionStats(): Map<string, ReturnType<typeof getFlipStats>> {
  const stats = new Map<string, ReturnType<typeof getFlipStats>>();
  for (const sessionId of sessionFlipStates.keys()) {
    stats.set(sessionId, getFlipStats(sessionId));
  }
  return stats;
}
