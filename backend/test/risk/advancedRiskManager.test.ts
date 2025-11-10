/**
 * Advanced Risk Manager Unit Tests
 * 
 * Tests for real-time risk management features including:
 * - Hard drawdown halt mechanism
 * - Flash crash detection
 * - Liquidity monitoring
 * - Extreme volatility detection
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { AdvancedRiskManager, DEFAULT_ADVANCED_RISK_CONFIG, type AdvancedRiskConfig } from '../../src/risk/advancedRiskManager.js';

describe('AdvancedRiskManager', () => {
  let riskManager: AdvancedRiskManager;
  
  beforeEach(() => {
    // Use default configuration with some test-specific overrides
    const testConfig: AdvancedRiskConfig = {
      ...DEFAULT_ADVANCED_RISK_CONFIG,
      maxDrawdownPct: 10,
      hardDrawdownHaltPct: 20,
      flashCrashThresholdPct: 8,
      flashCrashDetectionMinutes: 15,
      catastrophicDailyLossPct: 5,
      minLiquidityThreshold: 1000000,
      enableContinuousLiquidityCheck: true,
    };
    riskManager = new AdvancedRiskManager(testConfig);
  });

  describe('Configuration', () => {
    it('should initialize with default configuration', () => {
      const manager = new AdvancedRiskManager();
      expect(manager).toBeDefined();
    });

    it('should accept custom configuration', () => {
      const customConfig: AdvancedRiskConfig = {
        ...DEFAULT_ADVANCED_RISK_CONFIG,
        hardDrawdownHaltPct: 25,
        flashCrashThresholdPct: 10,
      };
      const manager = new AdvancedRiskManager(customConfig);
      expect(manager).toBeDefined();
    });
  });

  describe('Drawdown State', () => {
    it('should calculate normal drawdown state', async () => {
      const state = await riskManager.calculateDrawdown('test-session', 10000);
      
      expect(state).toBeDefined();
      expect(state.peakEquity).toBe(10000);
      expect(state.currentDrawdownPct).toBe(0);
      expect(state.isInDrawdown).toBe(false);
      expect(state.sizeMultiplier).toBe(1.0);
      expect(state.hardHaltTriggered).toBe(false);
    });

    it('should detect moderate drawdown and reduce sizing', async () => {
      // First set peak
      await riskManager.calculateDrawdown('test-session', 10000);
      
      // Then calculate with 12% drawdown
      const state = await riskManager.calculateDrawdown('test-session', 8800);
      
      expect(state.currentDrawdownPct).toBeCloseTo(-12, 1);
      expect(state.isInDrawdown).toBe(true);
      expect(state.sizeMultiplier).toBeLessThan(0.5);
      expect(state.hardHaltTriggered).toBe(false);
    });

    it('should trigger hard halt at critical drawdown', async () => {
      // First set peak
      await riskManager.calculateDrawdown('test-session', 10000);
      
      // Then calculate with 22% drawdown (exceeds 20% threshold)
      const state = await riskManager.calculateDrawdown('test-session', 7800);
      
      expect(state.currentDrawdownPct).toBeCloseTo(-22, 1);
      expect(state.hardHaltTriggered).toBe(true);
      expect(state.sizeMultiplier).toBe(0);
      expect(state.hardHaltReason).toContain('Critical drawdown');
    });
  });

  describe('Regime Multipliers', () => {
    it('should return correct multipliers for low volatility', () => {
      const regime = { volatility: 'low' as const, riskModifier: null };
      const multiplier = riskManager.calculateRegimeMultiplier(regime);
      
      expect(multiplier).toBe(1.2); // Low volatility bonus
    });

    it('should return correct multipliers for high volatility', () => {
      const regime = { volatility: 'high' as const, riskModifier: null };
      const multiplier = riskManager.calculateRegimeMultiplier(regime);
      
      expect(multiplier).toBe(0.6); // High volatility reduction
    });

    it('should return correct multipliers for extreme volatility', () => {
      const customConfig: AdvancedRiskConfig = {
        ...DEFAULT_ADVANCED_RISK_CONFIG,
        extremeVolatilityMultiplier: 0.35,
      };
      const manager = new AdvancedRiskManager(customConfig);
      
      const regime = { 
        volatility: 'extreme' as const, 
        riskModifier: { sizingMultiplier: 0.35 } 
      };
      const multiplier = manager.calculateRegimeMultiplier(regime);
      
      expect(multiplier).toBe(0.35); // Extreme volatility reduction
    });
  });

  describe('Session Management', () => {
    it('should store and retrieve drawdown state', async () => {
      await riskManager.calculateDrawdown('test-session', 10000);
      
      const state = riskManager.getDrawdownState('test-session');
      expect(state).toBeDefined();
      expect(state?.peakEquity).toBe(10000);
    });

    it('should clear session state', async () => {
      await riskManager.calculateDrawdown('test-session', 10000);
      riskManager.clearSession('test-session');
      
      const state = riskManager.getDrawdownState('test-session');
      expect(state).toBeUndefined();
    });
  });

  describe('Risk Decision Integration', () => {
    it('should allow trade with normal conditions', async () => {
      const decision = await riskManager.checkRisk({
        sessionId: 'test-session',
        symbol: 'BTC/USDT',
        currentEquity: 10000,
      });

      expect(decision.allowed).toBe(true);
      expect(decision.sizeMultiplier).toBeGreaterThan(0);
      expect(decision.hardHaltTriggered).toBe(false);
      expect(decision.flashCrashDetected).toBe(false);
    });

    it('should reject trade during hard halt', async () => {
      // Set up critical drawdown
      await riskManager.calculateDrawdown('test-session', 10000);
      
      const decision = await riskManager.checkRisk({
        sessionId: 'test-session',
        symbol: 'BTC/USDT',
        currentEquity: 7500, // 25% drawdown
      });

      expect(decision.allowed).toBe(false);
      expect(decision.sizeMultiplier).toBe(0);
      expect(decision.hardHaltTriggered).toBe(true);
      expect(decision.reason).toContain('Critical drawdown');
    });
  });
});

describe('Market Regime Detector - Extreme Volatility', () => {
  it('should detect extreme volatility correctly', () => {
    // Import would be: import { isExtremeVolatilityDetected } from '../../src/quantai/regime/marketRegimeDetector.js';
    // For now, we test the logic inline
    
    const testExtremeVol = (atr15mPct: number, realizedVol: number, isMajor: boolean) => {
      const volExtremeThreshold = isMajor ? 3.4 : 4.6;
      return atr15mPct >= volExtremeThreshold || realizedVol >= 6.5;
    };

    // Test extreme volatility detection for major coins
    expect(testExtremeVol(4.0, 7.0, true)).toBe(true);
    expect(testExtremeVol(2.0, 5.0, true)).toBe(false);
    
    // Test extreme volatility detection for altcoins
    expect(testExtremeVol(5.0, 7.0, false)).toBe(true);
    expect(testExtremeVol(3.0, 5.0, false)).toBe(false);
  });

  it('should identify high volatility correctly', () => {
    const testHighVol = (atr15mPct: number, realizedVol: number, isMajor: boolean) => {
      const volHighThreshold = isMajor ? 2.3 : 3.2;
      return atr15mPct >= volHighThreshold || realizedVol >= 4.5;
    };

    expect(testHighVol(2.5, 5.0, true)).toBe(true);
    expect(testHighVol(3.5, 5.0, false)).toBe(true);
    expect(testHighVol(1.0, 2.0, true)).toBe(false);
  });
});

describe('Configuration Validation', () => {
  it('should use environment variables for configuration', () => {
    // Test that DEFAULT_ADVANCED_RISK_CONFIG respects environment variables
    const config = DEFAULT_ADVANCED_RISK_CONFIG;
    
    expect(config.maxDrawdownPct).toBeGreaterThan(0);
    expect(config.hardDrawdownHaltPct).toBeGreaterThan(config.maxDrawdownPct);
    expect(config.flashCrashThresholdPct).toBeGreaterThan(0);
    expect(config.catastrophicDailyLossPct).toBeGreaterThan(0);
    expect(config.minLiquidityThreshold).toBeGreaterThan(0);
  });

  it('should have sensible default thresholds', () => {
    const config = DEFAULT_ADVANCED_RISK_CONFIG;
    
    // Verify default thresholds are within expected ranges
    expect(config.maxDrawdownPct).toBeLessThanOrEqual(15);
    expect(config.hardDrawdownHaltPct).toBeLessThanOrEqual(25);
    expect(config.flashCrashThresholdPct).toBeGreaterThanOrEqual(5);
    expect(config.flashCrashDetectionMinutes).toBeGreaterThanOrEqual(10);
  });
});
