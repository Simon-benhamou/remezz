/**
 * Canonical Exit Reason Constants
 *
 * Single source of truth for all exit reason strings across live/paper,
 * backtest, and parity verification. Uses short uppercase format (backtest-style).
 *
 * Legacy strings (lowercase from simpleAgent, mixed case from DB) are
 * converted via toCanonical(). Family-level comparison uses normalizeToFamily().
 */

// ── Canonical Exit Reason Constants ──────────────────────────────────────────

// Trailing stop exits
export const EXIT_TRAIL = 'TRAIL';
export const EXIT_TRAIL_NFS_HIGH = 'TRAIL_NFS_HIGH';
export const EXIT_TRAIL_NFS_MED = 'TRAIL_NFS_MED';
export const EXIT_TRAIL_NFS_LOW = 'TRAIL_NFS_LOW';
export const EXIT_TRAIL_RT = 'TRAIL_RT';
export const EXIT_TRAIL_PROACTIVE = 'TRAIL_PROACTIVE';
export const EXIT_TRAIL_CRASH_SAFETY = 'TRAIL_CRASH_SAFETY';  // V5.136: Flash crash safety net

// 15m candle-based trailing exits
export const EXIT_TRAIL_NFS_HIGH_15M = 'TRAIL_NFS_HIGH_15M';
export const EXIT_TRAIL_NFS_MED_15M = 'TRAIL_NFS_MED_15M';
export const EXIT_TRAIL_NFS_LOW_15M = 'TRAIL_NFS_LOW_15M';
export const EXIT_TRAIL_PROACTIVE_15M = 'TRAIL_PROACTIVE_15M';

// Stop loss exits
export const EXIT_SL = 'SL';
export const EXIT_SL_RT = 'SL_RT';
export const EXIT_SL_EXCHANGE = 'SL_EXCHANGE';

// Exchange-detected exits
export const EXIT_TRAIL_EXCHANGE = 'TRAIL_EXCHANGE';

// Time / hold exits
export const EXIT_TIME = 'TIME';

// Regime / signal exits
export const EXIT_REGIME_CHANGE = 'REGIME_CHANGE';
export const EXIT_MOMENTUM_REVERSAL = 'MOMENTUM_REVERSAL';

// Stagnant trade exits
export const EXIT_STAGNANT = 'STAGNANT_TRADE';
export const EXIT_STAGNANT_PROFIT = 'STAGNANT_PROFIT_EXIT';

// Emergency
export const EXIT_EMERGENCY = 'EMERGENCY_UNPROTECTED';

// Backtest end-of-data
export const EXIT_END = 'END';

// Unknown / fallback
export const EXIT_UNKNOWN = 'UNKNOWN';

// ── Legacy → Canonical Mapping ───────────────────────────────────────────────

const LEGACY_MAP: Record<string, string> = {
  // simpleAgent lowercase strings
  'trailing': EXIT_TRAIL,
  'trail_crash_safety': EXIT_TRAIL_CRASH_SAFETY,
  'trailing_rt': EXIT_TRAIL_RT,
  'trailing_nfs_high': EXIT_TRAIL_NFS_HIGH,
  'trailing_nfs_medium': EXIT_TRAIL_NFS_MED,
  'trailing_nfs_low': EXIT_TRAIL_NFS_LOW,
  'trailing_proactive_limit': EXIT_TRAIL_PROACTIVE,
  'trailing_proactive_limit_15m': EXIT_TRAIL_PROACTIVE_15M,
  'trailing_nfs_high_15m': EXIT_TRAIL_NFS_HIGH_15M,
  'trailing_nfs_med_15m': EXIT_TRAIL_NFS_MED_15M,
  'trailing_nfs_low_15m': EXIT_TRAIL_NFS_LOW_15M,
  'stoploss': EXIT_SL,
  'stoploss_rt': EXIT_SL_RT,
  'stop_loss_exchange': EXIT_SL_EXCHANGE,
  'trailing_stop_exchange': EXIT_TRAIL_EXCHANGE,
  'stagnant_trade': EXIT_STAGNANT,
  'stagnant_profit_exit': EXIT_STAGNANT_PROFIT,
  'emergency_unprotected': EXIT_EMERGENCY,
  'regime_change': EXIT_REGIME_CHANGE,
  'momentum_reversal': EXIT_MOMENTUM_REVERSAL,
  'time': EXIT_TIME,
  'unknown': EXIT_UNKNOWN,
  // DB uppercase legacy strings
  'TRAILING': EXIT_TRAIL,
  'TRAILING_NFS_HIGH': EXIT_TRAIL_NFS_HIGH,
  'TRAILING_NFS_MEDIUM': EXIT_TRAIL_NFS_MED,
  'TRAILING_NFS_LOW': EXIT_TRAIL_NFS_LOW,
  'TRAILING_RT': EXIT_TRAIL_RT,
  'TRAILING_PROACTIVE_LIMIT': EXIT_TRAIL_PROACTIVE,
  'TRAIL_CRASH_SAFETY': EXIT_TRAIL_CRASH_SAFETY,
  'STOPLOSS': EXIT_SL,
  'STOPLOSS_RT': EXIT_SL_RT,
  'STOP_LOSS_EXCHANGE': EXIT_SL_EXCHANGE,
  'TRAILING_STOP_EXCHANGE': EXIT_TRAIL_EXCHANGE,
  'STAGNANT_TRADE': EXIT_STAGNANT,
  'STAGNANT_PROFIT_EXIT': EXIT_STAGNANT_PROFIT,
  'EMERGENCY_UNPROTECTED': EXIT_EMERGENCY,
  'REGIME_CHANGE': EXIT_REGIME_CHANGE,
  'MOMENTUM_REVERSAL': EXIT_MOMENTUM_REVERSAL,
  'TIME': EXIT_TIME,
  'UNKNOWN': EXIT_UNKNOWN,
  // Already canonical
  'TRAIL': EXIT_TRAIL,
  'TRAIL_NFS_HIGH': EXIT_TRAIL_NFS_HIGH,
  'TRAIL_NFS_MED': EXIT_TRAIL_NFS_MED,
  'TRAIL_NFS_LOW': EXIT_TRAIL_NFS_LOW,
  'TRAIL_RT': EXIT_TRAIL_RT,
  'TRAIL_PROACTIVE': EXIT_TRAIL_PROACTIVE,
  'SL': EXIT_SL,
  'SL_RT': EXIT_SL_RT,
  'SL_EXCHANGE': EXIT_SL_EXCHANGE,
  'TRAIL_EXCHANGE': EXIT_TRAIL_EXCHANGE,
  'END': EXIT_END,
};

/**
 * Convert any exit reason string (legacy or canonical) to canonical format.
 * Returns uppercase original if not found in the mapping.
 */
export function toCanonical(reason: string): string {
  return LEGACY_MAP[reason] ?? LEGACY_MAP[reason.toUpperCase()] ?? reason.toUpperCase();
}

// ── ExitSignal reason → Canonical Mapping ────────────────────────────────────

/**
 * Maps ExitSignal.reason lowercase values (from shouldExitPosition()) to canonical.
 * Used in both backtestService and simpleAgent for consistent exit reason strings.
 */
export const EXIT_SIGNAL_REASON_MAP: Record<string, string> = {
  'time': EXIT_TIME,
  'regime_change': EXIT_REGIME_CHANGE,
  'momentum_reversal': EXIT_MOMENTUM_REVERSAL,
  'stoploss': EXIT_SL,
  'stagnant_trade': EXIT_STAGNANT,
  'stagnant_profit_exit': EXIT_STAGNANT_PROFIT,
  'trailing': EXIT_TRAIL,
  'trailing_breach': EXIT_TRAIL,
};

// ── Family Normalization ─────────────────────────────────────────────────────

export type ExitFamily = 'TRAIL' | 'SL' | 'REGIME_CHANGE' | 'MOMENTUM_REVERSAL' | 'STAGNANT_TRADE' | 'TIME' | 'EMERGENCY' | 'END' | 'UNKNOWN';

/**
 * Normalize an exit reason to its broad family for comparison.
 * Used in parity verification where exact reason doesn't matter,
 * only the family (e.g., TRAIL_NFS_HIGH and TRAIL are both 'TRAIL').
 */
export function normalizeToFamily(reason: string): ExitFamily {
  const r = toCanonical(reason);
  if (r.startsWith('TRAIL')) return 'TRAIL';
  if (r.startsWith('SL') || r.includes('STOP')) return 'SL';
  if (r.includes('REGIME')) return 'REGIME_CHANGE';
  if (r.includes('MOMENTUM') || r.includes('REVERSAL')) return 'MOMENTUM_REVERSAL';
  if (r.includes('STAGNANT')) return 'STAGNANT_TRADE';
  if (r.includes('TIME') || r.includes('MAX_HOLD')) return 'TIME';
  if (r.includes('EMERGENCY')) return 'EMERGENCY';
  if (r === 'END') return 'END';
  return 'UNKNOWN';
}
