/**
 * Session / Time-of-Day Awareness
 * 
 * Detects market sessions (Asian, European, US) and applies penalties to
 * reduce false breakouts during low-liquidity hours. Most crypto volume
 * occurs during US trading hours (15:00-23:00 UTC).
 * 
 * Low liquidity = fake breakouts = higher false entry rate
 */

export type SessionSignal = {
  session: 'asian' | 'european' | 'us' | 'off_hours';
  hour: number;                   // UTC hour (0-23)
  liquidityLevel: 'very_low' | 'low' | 'medium' | 'high' | 'very_high';
  isWeekend: boolean;
  penalty: number;                // Score multiplier for breakout/momentum strategies
  reason: string;
  recommendations: string[];
};

/**
 * Determine market session from UTC hour
 */
function getMarketSession(hour: number): {
  session: SessionSignal['session'];
  liquidityLevel: SessionSignal['liquidityLevel'];
} {
  // Asian session: 00:00 - 08:00 UTC (LOW liquidity in crypto)
  if (hour >= 0 && hour < 8) {
    return {
      session: 'asian',
      liquidityLevel: 'low',
    };
  }
  
  // European session: 08:00 - 15:00 UTC (MEDIUM liquidity)
  if (hour >= 8 && hour < 15) {
    return {
      session: 'european',
      liquidityLevel: 'medium',
    };
  }
  
  // US session: 15:00 - 23:00 UTC (HIGHEST liquidity)
  if (hour >= 15 && hour < 23) {
    return {
      session: 'us',
      liquidityLevel: 'very_high',
    };
  }
  
  // Off hours: 23:00 - 24:00 UTC (transition period)
  return {
    session: 'off_hours',
    liquidityLevel: 'very_low',
  };
}

/**
 * Check if current time is weekend
 * Weekends have lower liquidity in crypto (though trading continues)
 */
function isWeekend(): boolean {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

/**
 * Calculate penalty based on session and strategy type
 */
function calculateSessionPenalty(
  session: SessionSignal['session'],
  liquidityLevel: SessionSignal['liquidityLevel'],
  isWeekend: boolean,
  strategyFamily?: 'trend' | 'breakout' | 'momentum' | 'mean_reversion'
): {
  penalty: number;
  reason: string;
  recommendations: string[];
} {
  const recommendations: string[] = [];
  let basePenalty = 1.0;
  let reason = 'session_normal';
  
  // 🔄 CRYPTO MARKETS: 24/7 trading, no weekend penalty needed
  // Weekend often MORE volatile (retail traders active)
  // Removed: basePenalty *= 0.9 for weekends
  if (isWeekend) {
    recommendations.push('Weekend trading - retail activity may increase volatility');
  }
  
  // Session-specific penalties
  switch (session) {
    case 'us':
      // US session - best liquidity, no penalty
      reason = 'session_us_high_liquidity';
      break;
    
    case 'european':
      // European session - good liquidity, slight penalty for breakouts
      if (strategyFamily === 'breakout' || strategyFamily === 'momentum') {
        basePenalty *= 0.9;
        reason = 'session_eu_moderate_liquidity';
        recommendations.push('Moderate liquidity - breakouts may have less follow-through');
      } else {
        reason = 'session_eu_normal';
      }
      break;
    
    case 'asian':
      // Asian session - low liquidity, heavier penalty
      if (strategyFamily === 'breakout' || strategyFamily === 'momentum') {
        basePenalty *= 0.7;
        reason = 'session_asian_low_liquidity_breakout';
        recommendations.push('Low liquidity - avoid breakout/momentum strategies');
      } else if (strategyFamily === 'trend') {
        basePenalty *= 0.85;
        reason = 'session_asian_low_liquidity_trend';
        recommendations.push('Low liquidity - trend continuation may be weak');
      } else {
        // Mean reversion works better in low liquidity
        basePenalty *= 1.05;
        reason = 'session_asian_mean_reversion_favorable';
        recommendations.push('Low liquidity favors mean reversion strategies');
      }
      break;
    
    case 'off_hours':
      // Off hours - very low liquidity, heavy penalty
      if (strategyFamily === 'breakout' || strategyFamily === 'momentum') {
        basePenalty *= 0.5;
        reason = 'session_off_hours_very_low_liquidity';
        recommendations.push('Very low liquidity - avoid directional entries');
      } else if (strategyFamily === 'trend') {
        basePenalty *= 0.7;
        reason = 'session_off_hours_weak_trends';
      } else {
        // Mean reversion slightly better
        basePenalty *= 0.9;
        reason = 'session_off_hours_range_only';
        recommendations.push('Very low liquidity - only mean reversion viable');
      }
      break;
  }
  
  return {
    penalty: basePenalty,
    reason,
    recommendations,
  };
}

/**
 * Detect current market session and apply liquidity-based penalties
 * 
 * @param strategyFamily - Type of strategy being evaluated (optional)
 * @returns SessionSignal with penalty adjustment
 */
export function detectSessionAwareness(
  strategyFamily?: 'trend' | 'breakout' | 'momentum' | 'mean_reversion'
): SessionSignal {
  try {
    const now = new Date();
    const hour = now.getUTCHours();
    
    // Get session info
    const { session, liquidityLevel } = getMarketSession(hour);
    const weekend = isWeekend();
    
    // Calculate penalty
    const { penalty, reason, recommendations } = calculateSessionPenalty(
      session,
      liquidityLevel,
      weekend,
      strategyFamily
    );
    
    // Build signal
    const signal: SessionSignal = {
      session,
      hour,
      liquidityLevel,
      isWeekend: weekend,
      penalty,
      reason,
      recommendations,
    };
    
    // Log session changes (once per hour)
    const lastLoggedHour = (globalThis as any).__lastSessionLoggedHour ?? -1;
    if (hour !== lastLoggedHour && (penalty < 0.9 || recommendations.length > 0)) {
      console.log(JSON.stringify({
        event: 'session_awareness',
        session,
        hour,
        liquidityLevel,
        isWeekend: weekend,
        penalty,
        strategyFamily: strategyFamily || 'unknown',
        recommendations,
      }));
      (globalThis as any).__lastSessionLoggedHour = hour;
    }
    
    return signal;
  } catch (error) {
    console.error('[Session Awareness] Error in detectSessionAwareness:', error);
    
    // Return neutral signal on error
    return {
      session: 'us', // Assume best case
      hour: 12,
      liquidityLevel: 'high',
      isWeekend: false,
      penalty: 1.0,
      reason: 'session_check_failed',
      recommendations: [],
    };
  }
}

/**
 * Get detailed session statistics for monitoring
 */
export function getSessionStats(): {
  currentSession: string;
  currentHour: number;
  liquidityLevel: string;
  isWeekend: boolean;
  hoursUntilUSOpen: number;
  hoursUntilUSClose: number;
} {
  const now = new Date();
  const hour = now.getUTCHours();
  const { session, liquidityLevel } = getMarketSession(hour);
  const weekend = isWeekend();
  
  // Calculate hours until US session
  let hoursUntilUSOpen = 15 - hour;
  if (hoursUntilUSOpen < 0) hoursUntilUSOpen += 24;
  
  let hoursUntilUSClose = 23 - hour;
  if (hoursUntilUSClose < 0) hoursUntilUSClose += 24;
  
  return {
    currentSession: session,
    currentHour: hour,
    liquidityLevel,
    isWeekend: weekend,
    hoursUntilUSOpen,
    hoursUntilUSClose,
  };
}
