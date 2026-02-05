import {
  EXIT_TRAIL, EXIT_TRAIL_NFS_HIGH, EXIT_TRAIL_NFS_MED, EXIT_TRAIL_NFS_LOW,
  EXIT_TRAIL_RT, EXIT_TRAIL_PROACTIVE, EXIT_SL, EXIT_SL_RT, EXIT_SL_EXCHANGE,
  EXIT_TRAIL_EXCHANGE, EXIT_TIME, EXIT_REGIME_CHANGE, EXIT_MOMENTUM_REVERSAL,
  EXIT_STAGNANT, EXIT_STAGNANT_PROFIT, EXIT_EMERGENCY, EXIT_UNKNOWN,
  EXIT_TRAIL_NFS_HIGH_15M, EXIT_TRAIL_NFS_MED_15M, EXIT_TRAIL_NFS_LOW_15M,
  EXIT_TRAIL_PROACTIVE_15M, EXIT_END,
  toCanonical, normalizeToFamily, EXIT_SIGNAL_REASON_MAP,
} from '../../src/types/exitReasons.js';

describe('exitReasons', () => {
  describe('toCanonical', () => {
    it('converts legacy lowercase simpleAgent strings', () => {
      expect(toCanonical('trailing_nfs_high')).toBe('TRAIL_NFS_HIGH');
      expect(toCanonical('trailing_nfs_medium')).toBe('TRAIL_NFS_MED');
      expect(toCanonical('trailing_nfs_low')).toBe('TRAIL_NFS_LOW');
      expect(toCanonical('trailing')).toBe('TRAIL');
      expect(toCanonical('trailing_rt')).toBe('TRAIL_RT');
      expect(toCanonical('trailing_proactive_limit')).toBe('TRAIL_PROACTIVE');
      expect(toCanonical('stoploss')).toBe('SL');
      expect(toCanonical('stoploss_rt')).toBe('SL_RT');
      expect(toCanonical('stagnant_trade')).toBe('STAGNANT_TRADE');
      expect(toCanonical('emergency_unprotected')).toBe('EMERGENCY_UNPROTECTED');
      expect(toCanonical('regime_change')).toBe('REGIME_CHANGE');
      expect(toCanonical('momentum_reversal')).toBe('MOMENTUM_REVERSAL');
      expect(toCanonical('time')).toBe('TIME');
    });

    it('converts DB uppercase legacy strings', () => {
      expect(toCanonical('TRAILING_NFS_HIGH')).toBe('TRAIL_NFS_HIGH');
      expect(toCanonical('TRAILING_NFS_MEDIUM')).toBe('TRAIL_NFS_MED');
      expect(toCanonical('STOPLOSS')).toBe('SL');
      expect(toCanonical('TRAILING')).toBe('TRAIL');
      expect(toCanonical('TRAILING_PROACTIVE_LIMIT')).toBe('TRAIL_PROACTIVE');
    });

    it('passes through already canonical strings', () => {
      expect(toCanonical('TRAIL_NFS_HIGH')).toBe('TRAIL_NFS_HIGH');
      expect(toCanonical('TRAIL_NFS_MED')).toBe('TRAIL_NFS_MED');
      expect(toCanonical('SL')).toBe('SL');
      expect(toCanonical('TRAIL')).toBe('TRAIL');
      expect(toCanonical('END')).toBe('END');
    });

    it('uppercases unknown strings', () => {
      expect(toCanonical('some_custom_reason')).toBe('SOME_CUSTOM_REASON');
    });

    it('handles 15m exit reasons', () => {
      expect(toCanonical('trailing_nfs_high_15m')).toBe('TRAIL_NFS_HIGH_15M');
      expect(toCanonical('trailing_nfs_med_15m')).toBe('TRAIL_NFS_MED_15M');
      expect(toCanonical('trailing_nfs_low_15m')).toBe('TRAIL_NFS_LOW_15M');
      expect(toCanonical('trailing_proactive_limit_15m')).toBe('TRAIL_PROACTIVE_15M');
    });

    it('handles exchange-detected exits', () => {
      expect(toCanonical('stop_loss_exchange')).toBe('SL_EXCHANGE');
      expect(toCanonical('trailing_stop_exchange')).toBe('TRAIL_EXCHANGE');
    });
  });

  describe('normalizeToFamily', () => {
    it('groups all trailing variants to TRAIL', () => {
      expect(normalizeToFamily('TRAIL')).toBe('TRAIL');
      expect(normalizeToFamily('TRAIL_NFS_HIGH')).toBe('TRAIL');
      expect(normalizeToFamily('TRAIL_NFS_MED')).toBe('TRAIL');
      expect(normalizeToFamily('TRAIL_NFS_LOW')).toBe('TRAIL');
      expect(normalizeToFamily('TRAIL_RT')).toBe('TRAIL');
      expect(normalizeToFamily('TRAIL_PROACTIVE')).toBe('TRAIL');
      expect(normalizeToFamily('TRAIL_EXCHANGE')).toBe('TRAIL');
      // Legacy strings should also work
      expect(normalizeToFamily('trailing_nfs_high')).toBe('TRAIL');
      expect(normalizeToFamily('trailing')).toBe('TRAIL');
      expect(normalizeToFamily('TRAILING_NFS_MEDIUM')).toBe('TRAIL');
    });

    it('groups all stop loss variants to SL', () => {
      expect(normalizeToFamily('SL')).toBe('SL');
      expect(normalizeToFamily('SL_RT')).toBe('SL');
      expect(normalizeToFamily('SL_EXCHANGE')).toBe('SL');
      expect(normalizeToFamily('stoploss')).toBe('SL');
      expect(normalizeToFamily('stoploss_rt')).toBe('SL');
    });

    it('maps regime and momentum families', () => {
      expect(normalizeToFamily('REGIME_CHANGE')).toBe('REGIME_CHANGE');
      expect(normalizeToFamily('regime_change')).toBe('REGIME_CHANGE');
      expect(normalizeToFamily('MOMENTUM_REVERSAL')).toBe('MOMENTUM_REVERSAL');
    });

    it('maps stagnant family', () => {
      expect(normalizeToFamily('STAGNANT_TRADE')).toBe('STAGNANT_TRADE');
      expect(normalizeToFamily('STAGNANT_PROFIT_EXIT')).toBe('STAGNANT_TRADE');
      expect(normalizeToFamily('stagnant_trade')).toBe('STAGNANT_TRADE');
    });

    it('maps time family', () => {
      expect(normalizeToFamily('TIME')).toBe('TIME');
      expect(normalizeToFamily('time')).toBe('TIME');
    });

    it('maps emergency', () => {
      expect(normalizeToFamily('EMERGENCY_UNPROTECTED')).toBe('EMERGENCY');
      expect(normalizeToFamily('emergency_unprotected')).toBe('EMERGENCY');
    });

    it('returns UNKNOWN for unrecognized', () => {
      expect(normalizeToFamily('something_else')).toBe('UNKNOWN');
    });
  });

  describe('EXIT_SIGNAL_REASON_MAP', () => {
    it('maps all shouldExitPosition() reason strings', () => {
      expect(EXIT_SIGNAL_REASON_MAP['time']).toBe('TIME');
      expect(EXIT_SIGNAL_REASON_MAP['regime_change']).toBe('REGIME_CHANGE');
      expect(EXIT_SIGNAL_REASON_MAP['momentum_reversal']).toBe('MOMENTUM_REVERSAL');
      expect(EXIT_SIGNAL_REASON_MAP['stoploss']).toBe('SL');
      expect(EXIT_SIGNAL_REASON_MAP['stagnant_trade']).toBe('STAGNANT_TRADE');
      expect(EXIT_SIGNAL_REASON_MAP['stagnant_profit_exit']).toBe('STAGNANT_PROFIT_EXIT');
      expect(EXIT_SIGNAL_REASON_MAP['trailing']).toBe('TRAIL');
      expect(EXIT_SIGNAL_REASON_MAP['trailing_breach']).toBe('TRAIL');
    });
  });

  describe('constants are correct values', () => {
    it('trail constants', () => {
      expect(EXIT_TRAIL).toBe('TRAIL');
      expect(EXIT_TRAIL_NFS_HIGH).toBe('TRAIL_NFS_HIGH');
      expect(EXIT_TRAIL_NFS_MED).toBe('TRAIL_NFS_MED');
      expect(EXIT_TRAIL_NFS_LOW).toBe('TRAIL_NFS_LOW');
      expect(EXIT_TRAIL_RT).toBe('TRAIL_RT');
      expect(EXIT_TRAIL_PROACTIVE).toBe('TRAIL_PROACTIVE');
      expect(EXIT_TRAIL_NFS_HIGH_15M).toBe('TRAIL_NFS_HIGH_15M');
      expect(EXIT_TRAIL_NFS_MED_15M).toBe('TRAIL_NFS_MED_15M');
      expect(EXIT_TRAIL_NFS_LOW_15M).toBe('TRAIL_NFS_LOW_15M');
      expect(EXIT_TRAIL_PROACTIVE_15M).toBe('TRAIL_PROACTIVE_15M');
      expect(EXIT_TRAIL_EXCHANGE).toBe('TRAIL_EXCHANGE');
    });

    it('stop loss constants', () => {
      expect(EXIT_SL).toBe('SL');
      expect(EXIT_SL_RT).toBe('SL_RT');
      expect(EXIT_SL_EXCHANGE).toBe('SL_EXCHANGE');
    });

    it('other constants', () => {
      expect(EXIT_TIME).toBe('TIME');
      expect(EXIT_REGIME_CHANGE).toBe('REGIME_CHANGE');
      expect(EXIT_MOMENTUM_REVERSAL).toBe('MOMENTUM_REVERSAL');
      expect(EXIT_STAGNANT).toBe('STAGNANT_TRADE');
      expect(EXIT_STAGNANT_PROFIT).toBe('STAGNANT_PROFIT_EXIT');
      expect(EXIT_EMERGENCY).toBe('EMERGENCY_UNPROTECTED');
      expect(EXIT_END).toBe('END');
      expect(EXIT_UNKNOWN).toBe('UNKNOWN');
    });
  });
});
