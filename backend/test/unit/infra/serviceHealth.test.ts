/**
 * Unit tests for Service Health monitoring
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  isServiceAvailable,
  recordServiceSuccess,
  recordServiceFailure,
  recordFallbackTriggered,
  getServiceHealth,
  getServiceFallbackMetrics,
  getAllServiceHealth,
  resetServiceHealth,
  setCircuitBreakerState,
} from '../../../src/infra/serviceHealth.js';

describe('ServiceHealth', () => {
  beforeEach(() => {
    // Reset health state before each test
    resetServiceHealth();
  });

  describe('isServiceAvailable', () => {
    it('should return true for newly initialized service', () => {
      expect(isServiceAvailable('llm')).toBe(true);
      expect(isServiceAvailable('python_predictor')).toBe(true);
    });

    it('should return false when circuit breaker is open', () => {
      setCircuitBreakerState('llm', true);
      expect(isServiceAvailable('llm')).toBe(false);
    });

    it('should return true when circuit breaker is closed', () => {
      setCircuitBreakerState('llm', false);
      expect(isServiceAvailable('llm')).toBe(true);
    });
  });

  describe('recordServiceSuccess', () => {
    it('should track successful calls', () => {
      recordServiceSuccess('llm', 100);
      recordServiceSuccess('llm', 150);

      const health = getServiceHealth('llm');
      expect(health.successfulCalls).toBe(2);
      expect(health.totalCalls).toBe(2);
      expect(health.consecutiveFailures).toBe(0);
      expect(health.status).toBe('available');
    });

    it('should reset consecutive failures on success', () => {
      recordServiceFailure('llm', new Error('test error'));
      recordServiceFailure('llm', new Error('test error'));
      expect(getServiceHealth('llm').consecutiveFailures).toBe(2);

      recordServiceSuccess('llm');
      expect(getServiceHealth('llm').consecutiveFailures).toBe(0);
    });

    it('should close circuit breaker after success', () => {
      // Force circuit breaker open
      for (let i = 0; i < 5; i++) {
        recordServiceFailure('llm', new Error('test error'));
      }
      expect(getServiceHealth('llm').circuitBreakerOpen).toBe(true);

      // Success should close it
      recordServiceSuccess('llm');
      expect(getServiceHealth('llm').circuitBreakerOpen).toBe(false);
      expect(getServiceHealth('llm').status).toBe('available');
    });
  });

  describe('recordServiceFailure', () => {
    it('should track failed calls', () => {
      recordServiceFailure('llm', new Error('test error'));
      recordServiceFailure('llm', new Error('test error'));

      const health = getServiceHealth('llm');
      expect(health.failedCalls).toBe(2);
      expect(health.totalCalls).toBe(2);
      expect(health.consecutiveFailures).toBe(2);
    });

    it('should open circuit breaker after threshold failures', () => {
      for (let i = 0; i < 5; i++) {
        recordServiceFailure('llm', new Error('test error'));
      }

      const health = getServiceHealth('llm');
      expect(health.consecutiveFailures).toBe(5);
      expect(health.circuitBreakerOpen).toBe(true);
      expect(health.status).toBe('unavailable');
    });

    it('should set status to degraded after 2 failures', () => {
      recordServiceFailure('llm', new Error('test error'));
      expect(getServiceHealth('llm').status).toBe('available');

      recordServiceFailure('llm', new Error('test error'));
      expect(getServiceHealth('llm').status).toBe('degraded');
    });

    it('should handle non-critical failures differently', () => {
      recordServiceFailure('llm', new Error('test error'), false);
      recordServiceFailure('llm', new Error('test error'), false);
      recordServiceFailure('llm', new Error('test error'), false);

      const health = getServiceHealth('llm');
      expect(health.consecutiveFailures).toBe(3);
      // Circuit breaker should not open for non-critical failures
      expect(health.circuitBreakerOpen).toBe(false);
    });
  });

  describe('recordFallbackTriggered', () => {
    it('should track fallback metrics', () => {
      recordFallbackTriggered('llm', 'circuit_breaker_open');
      recordFallbackTriggered('llm', 'circuit_breaker_open');
      recordFallbackTriggered('llm', 'timeout');

      const metrics = getServiceFallbackMetrics('llm');
      expect(metrics.triggered).toBe(3);
      expect(metrics.byReason['circuit_breaker_open']).toBe(2);
      expect(metrics.byReason['timeout']).toBe(1);
    });
  });

  describe('getAllServiceHealth', () => {
    it('should return health for all services', () => {
      recordServiceSuccess('llm');
      recordServiceFailure('python_predictor', new Error('test'));

      const allHealth = getAllServiceHealth();
      expect(allHealth.llm).toBeDefined();
      expect(allHealth.python_predictor).toBeDefined();
      expect(allHealth.llm.successfulCalls).toBe(1);
      expect(allHealth.python_predictor.failedCalls).toBe(1);
    });
  });

  describe('circuit breaker timeout behavior', () => {
    it('should not block calls before timeout', () => {
      // Open circuit breaker
      for (let i = 0; i < 5; i++) {
        recordServiceFailure('llm', new Error('test error'));
      }
      expect(isServiceAvailable('llm')).toBe(false);
    });
  });

  describe('response time tracking', () => {
    it('should calculate average response time', () => {
      recordServiceSuccess('llm', 100);
      recordServiceSuccess('llm', 200);
      recordServiceSuccess('llm', 300);

      const health = getServiceHealth('llm');
      expect(health.avgResponseTime).toBeCloseTo(200, 1);
    });
  });
});
