/**
 * Peak Drawdown Exit Manager Tests
 * 
 * Tests for the peak price tracking and adaptive drawdown protection logic
 * that prevents large losses after profitable moves.
 */

import { describe, it, expect } from '@jest/globals';
import { maybeAdjustOrExit, type ExitDirective } from '../../src/quantai/strategies/metaAdaptive/exitManager.js';
import type { QuantAIExitConfig } from '../../src/quantai/config.js';

describe('Peak Drawdown Exit Protection', () => {
  const baseConfig: QuantAIExitConfig = {
    atrPeriod: 14,
    slAtrMult: 1.5,
    tpRMultiples: [2.0, 3.0],
    trailAfterR: 1.0,
    trailAtrMult: 1.0,
    peakDrawdown: {
      enabled: true,
      thresholds: {
        1.0: 0.05,  // 5% drawdown at 1R
        2.0: 0.04,  // 4% drawdown at 2R
        3.0: 0.03,  // 3% drawdown at 3R
        5.0: 0.02,  // 2% drawdown at 5R+
      },
    },
    earlyExit: {
      adxBelow: 18,
      cmfNegative: true,
      tightenProfitR: 0.2,
      cutLossR: 0.5,
    },
  };

  describe('Long Position Drawdown Detection', () => {
    it('should exit long position when drawdown exceeds 5% threshold at 1R', () => {
      const entryPrice = 644;
      const stopDistance = 36; // Risk per unit
      const peakPrice = 680;  // At ~1.0R
      const currentPrice = 646; // 5% down from peak, but still in profit
      const stopPrice = entryPrice - stopDistance;
      const atr = 20;

      const directive = maybeAdjustOrExit({
        side: 'long',
        entryPrice,
        stop: stopPrice,
        targets: [entryPrice + stopDistance * 2],
        lastPrice: currentPrice,
        atr,
        cfg: baseConfig,
        peakPrice,
        initialStopDistance: stopDistance,
      });

      expect(directive.action).toBe('exit');
      expect(directive.reason).toContain('Peak drawdown exit');
      expect(directive.reason).toContain('5.'); // Drawdown percentage
    });

    it('should exit long position when drawdown exceeds 4% threshold at 2R', () => {
      const entryPrice = 644;
      const stopDistance = 44; // Stop at 600
      const peakPrice = 720;  // At 2R (entry + 2*stopDistance)
      const currentPrice = 691; // ~4.0% down from peak at 720
      const stopPrice = entryPrice - stopDistance;
      const atr = 40;

      const directive = maybeAdjustOrExit({
        side: 'long',
        entryPrice,
        stop: stopPrice,
        targets: [entryPrice + stopDistance * 2, entryPrice + stopDistance * 3],
        lastPrice: currentPrice,
        atr,
        cfg: baseConfig,
        peakPrice,
        initialStopDistance: stopDistance,
      });

      expect(directive.action).toBe('exit');
      expect(directive.reason).toContain('Peak drawdown exit');
      expect(directive.reason).toContain('at 1.'); // Should show R-multiple ~1.06R
    });

    it('should exit long position when drawdown exceeds 3% threshold at 3R (ZEC case)', () => {
      // This simulates the actual ZEC issue from the bug report
      const entryPrice = 644;
      const stopDistance = 44; // 1.5 ATR stop
      const peakPrice = 720;  // Reached ~1.73R
      const currentPrice = 570; // Large reversal - 20.8% down from peak
      const stopPrice = entryPrice - stopDistance;
      const atr = 29.33;

      const directive = maybeAdjustOrExit({
        side: 'long',
        entryPrice,
        stop: stopPrice,
        targets: [entryPrice + stopDistance * 2, entryPrice + stopDistance * 3],
        lastPrice: currentPrice,
        atr,
        cfg: baseConfig,
        peakPrice,
        initialStopDistance: stopDistance,
      });

      expect(directive.action).toBe('exit');
      expect(directive.reason).toContain('Peak drawdown exit');
      // Drawdown should be ~20.8%, well above 3% threshold
    });

    it('should NOT exit if drawdown is below threshold', () => {
      const entryPrice = 644;
      const peakPrice = 680;
      const currentPrice = 676; // Only 0.6% down from peak
      const stopPrice = 620;
      const atr = 20;

      const directive = maybeAdjustOrExit({
        side: 'long',
        entryPrice,
        stop: stopPrice,
        targets: [entryPrice + (entryPrice - stopPrice) * 2],
        lastPrice: currentPrice,
        atr,
        cfg: baseConfig,
        peakPrice,
      });

      expect(directive.action).not.toBe('exit');
    });

    it('should NOT exit if peak price is not above entry (no profit to protect)', () => {
      const entryPrice = 644;
      const peakPrice = 640;  // Below entry
      const currentPrice = 630; // Further below
      const stopPrice = 620;
      const atr = 20;

      const directive = maybeAdjustOrExit({
        side: 'long',
        entryPrice,
        stop: stopPrice,
        targets: [entryPrice + (entryPrice - stopPrice) * 2],
        lastPrice: currentPrice,
        atr,
        cfg: baseConfig,
        peakPrice,
      });

      // Should not exit via peak drawdown (still losing, not protecting profit)
      expect(directive.reason).not.toContain('Peak drawdown');
    });
  });

  describe('Short Position Drawdown Detection', () => {
    it('should exit short position when drawdown exceeds threshold', () => {
      const entryPrice = 644;
      const stopDistance = 44;
      const peakPrice = 600;  // Low for short (good)
      const currentPrice = 625; // 4.2% up from peak (bad for short)
      const stopPrice = entryPrice + stopDistance;
      const atr = 40;

      const directive = maybeAdjustOrExit({
        side: 'short',
        entryPrice,
        stop: stopPrice,
        targets: [entryPrice - stopDistance * 2, entryPrice - stopDistance * 3],
        lastPrice: currentPrice,
        atr,
        cfg: baseConfig,
        peakPrice,
        initialStopDistance: stopDistance,
      });

      expect(directive.action).toBe('exit');
      expect(directive.reason).toContain('Peak drawdown exit');
    });

    it('should NOT exit short if peak is above entry (no profit)', () => {
      const entryPrice = 644;
      const peakPrice = 650;  // Above entry (no profit for short)
      const currentPrice = 660;
      const stopPrice = 688;
      const atr = 40;

      const directive = maybeAdjustOrExit({
        side: 'short',
        entryPrice,
        stop: stopPrice,
        targets: [entryPrice - (stopPrice - entryPrice) * 2],
        lastPrice: currentPrice,
        atr,
        cfg: baseConfig,
        peakPrice,
      });

      expect(directive.reason).not.toContain('Peak drawdown');
    });
  });

  describe('Drawdown Threshold Selection', () => {
    it('should use 5% threshold when R-multiple is between 1.0 and 2.0', () => {
      const entryPrice = 100;
      const stopDistance = 10;
      const peakPrice = 112; // At ~1.2R
      const currentPrice = 106.4; // 5% down from peak
      const stopPrice = entryPrice - stopDistance;

      const directive = maybeAdjustOrExit({
        side: 'long',
        entryPrice,
        stop: stopPrice,
        targets: [entryPrice + stopDistance * 2],
        lastPrice: currentPrice,
        atr: 10,
        cfg: baseConfig,
        peakPrice,
        initialStopDistance: stopDistance,
      });

      expect(directive.action).toBe('exit');
      expect(directive.reason).toContain('threshold 5.0%');
    });

    it('should use 4% threshold when R-multiple is between 2.0 and 3.0', () => {
      const entryPrice = 100;
      const stopDistance = 10;
      const peakPrice = 122; // At ~2.2R
      const currentPrice = 117.12; // 4% down from peak
      const stopPrice = entryPrice - stopDistance;

      const directive = maybeAdjustOrExit({
        side: 'long',
        entryPrice,
        stop: stopPrice,
        targets: [entryPrice + stopDistance * 2, entryPrice + stopDistance * 3],
        lastPrice: currentPrice,
        atr: 10,
        cfg: baseConfig,
        peakPrice,
        initialStopDistance: stopDistance,
      });

      expect(directive.action).toBe('exit');
      expect(directive.reason).toContain('threshold 4.0%');
    });

    it('should use 2% threshold when R-multiple is 5.0 or higher', () => {
      const entryPrice = 100;
      const stopDistance = 10;
      const peakPrice = 152; // At ~5.2R
      const currentPrice = 148.96; // 2% down from peak
      const stopPrice = entryPrice - stopDistance;

      const directive = maybeAdjustOrExit({
        side: 'long',
        entryPrice,
        stop: stopPrice,
        targets: [entryPrice + stopDistance * 2],
        lastPrice: currentPrice,
        atr: 10,
        cfg: baseConfig,
        peakPrice,
        initialStopDistance: stopDistance,
      });

      expect(directive.action).toBe('exit');
      expect(directive.reason).toContain('threshold 2.0%');
    });
  });

  describe('Configuration Control', () => {
    it('should NOT check drawdown if peakDrawdown is disabled', () => {
      const configDisabled: QuantAIExitConfig = {
        ...baseConfig,
        peakDrawdown: {
          enabled: false,
          thresholds: baseConfig.peakDrawdown!.thresholds,
        },
      };

      const entryPrice = 644;
      const peakPrice = 720;
      const currentPrice = 570; // Massive drawdown
      const stopPrice = 600;

      const directive = maybeAdjustOrExit({
        side: 'long',
        entryPrice,
        stop: stopPrice,
        targets: [entryPrice + (entryPrice - stopPrice) * 2],
        lastPrice: currentPrice,
        atr: 30,
        cfg: configDisabled,
        peakPrice,
      });

      expect(directive.reason).not.toContain('Peak drawdown');
    });

    it('should NOT exit if peakPrice is not provided', () => {
      const entryPrice = 644;
      const currentPrice = 570;
      const stopPrice = 600;

      const directive = maybeAdjustOrExit({
        side: 'long',
        entryPrice,
        stop: stopPrice,
        targets: [entryPrice + (entryPrice - stopPrice) * 2],
        lastPrice: currentPrice,
        atr: 30,
        cfg: baseConfig,
        // peakPrice not provided
      });

      expect(directive.reason).not.toContain('Peak drawdown');
    });
  });
});
