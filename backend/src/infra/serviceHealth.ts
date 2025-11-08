/**
 * Service Health Monitoring
 * 
 * Tracks availability and performance of external services (LLM, Python predictor)
 * Implements circuit breaker pattern to prevent cascading failures
 */

import { createAlert } from '../monitoring/alerting.js';

export type ServiceType = 'llm' | 'python_predictor';

export type ServiceStatus = 'available' | 'degraded' | 'unavailable';

export interface ServiceHealth {
  status: ServiceStatus;
  consecutiveFailures: number;
  lastSuccess: number | null;
  lastFailure: number | null;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  avgResponseTime: number;
  circuitBreakerOpen: boolean;
}

export interface FallbackMetrics {
  triggered: number;
  lastTriggeredAt: number | null;
  byReason: Record<string, number>;
}

// Circuit breaker configuration
const CIRCUIT_BREAKER_THRESHOLD = 5; // Open circuit after N consecutive failures
const CIRCUIT_BREAKER_TIMEOUT = 60_000; // Try again after 60 seconds
const CIRCUIT_BREAKER_HALF_OPEN_THRESHOLD = 2; // Allow 2 test calls when half-open

// Service health state
const serviceHealth = new Map<ServiceType, ServiceHealth>();
const fallbackMetrics = new Map<ServiceType, FallbackMetrics>();

// Response time tracking
const responseTimes = new Map<ServiceType, number[]>();
const MAX_RESPONSE_TIME_SAMPLES = 100;

function initServiceHealth(service: ServiceType): ServiceHealth {
  return {
    status: 'available',
    consecutiveFailures: 0,
    lastSuccess: null,
    lastFailure: null,
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    avgResponseTime: 0,
    circuitBreakerOpen: false,
  };
}

function getHealth(service: ServiceType): ServiceHealth {
  if (!serviceHealth.has(service)) {
    serviceHealth.set(service, initServiceHealth(service));
  }
  return serviceHealth.get(service)!;
}

function getFallbackMetrics(service: ServiceType): FallbackMetrics {
  if (!fallbackMetrics.has(service)) {
    fallbackMetrics.set(service, {
      triggered: 0,
      lastTriggeredAt: null,
      byReason: {},
    });
  }
  return fallbackMetrics.get(service)!;
}

/**
 * Check if a service is available (circuit breaker not open)
 */
export function isServiceAvailable(service: ServiceType): boolean {
  const health = getHealth(service);
  
  // If circuit breaker is open, check if timeout has passed
  if (health.circuitBreakerOpen) {
    const now = Date.now();
    const timeSinceLastFailure = health.lastFailure ? now - health.lastFailure : Infinity;
    
    if (timeSinceLastFailure >= CIRCUIT_BREAKER_TIMEOUT) {
      // Half-open: allow limited test calls
      return health.consecutiveFailures <= CIRCUIT_BREAKER_HALF_OPEN_THRESHOLD;
    }
    
    return false;
  }
  
  return health.status !== 'unavailable';
}

/**
 * Record a successful service call
 */
export function recordServiceSuccess(service: ServiceType, responseTimeMs?: number): void {
  const health = getHealth(service);
  const now = Date.now();
  
  health.lastSuccess = now;
  health.totalCalls++;
  health.successfulCalls++;
  health.consecutiveFailures = 0;
  
  // Update status
  if (health.circuitBreakerOpen) {
    // Circuit breaker can close after successful call
    health.circuitBreakerOpen = false;
    health.status = 'available';
    
    createAlert(
      'info',
      `ServiceHealth:${service}`,
      `Circuit breaker closed - service recovered`,
      {
        service,
        totalCalls: health.totalCalls,
        successRate: (health.successfulCalls / health.totalCalls * 100).toFixed(2) + '%',
      }
    );
  } else if (health.status !== 'available') {
    health.status = 'available';
  }
  
  // Track response time
  if (responseTimeMs !== undefined && Number.isFinite(responseTimeMs)) {
    const times = responseTimes.get(service) || [];
    times.push(responseTimeMs);
    
    if (times.length > MAX_RESPONSE_TIME_SAMPLES) {
      times.shift();
    }
    
    responseTimes.set(service, times);
    health.avgResponseTime = times.reduce((sum, t) => sum + t, 0) / times.length;
  }
}

/**
 * Record a failed service call
 */
export function recordServiceFailure(
  service: ServiceType,
  error: Error | string,
  isCritical = true
): void {
  const health = getHealth(service);
  const now = Date.now();
  
  health.lastFailure = now;
  health.totalCalls++;
  health.failedCalls++;
  health.consecutiveFailures++;
  
  // Determine if we should open circuit breaker
  if (isCritical && health.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    if (!health.circuitBreakerOpen) {
      health.circuitBreakerOpen = true;
      health.status = 'unavailable';
      
      createAlert(
        'critical',
        `ServiceHealth:${service}`,
        `Circuit breaker opened - service unavailable after ${health.consecutiveFailures} consecutive failures`,
        {
          service,
          consecutiveFailures: health.consecutiveFailures,
          error: error instanceof Error ? error.message : String(error),
          totalCalls: health.totalCalls,
          failureRate: (health.failedCalls / health.totalCalls * 100).toFixed(2) + '%',
        }
      );
    }
  } else if (health.consecutiveFailures >= 2 && health.status === 'available') {
    // Degraded state after 2 failures
    health.status = 'degraded';
    
    createAlert(
      'warning',
      `ServiceHealth:${service}`,
      `Service degraded after ${health.consecutiveFailures} consecutive failures`,
      {
        service,
        consecutiveFailures: health.consecutiveFailures,
        error: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

/**
 * Record that a fallback mechanism was triggered
 */
export function recordFallbackTriggered(
  service: ServiceType,
  reason: string,
  details?: Record<string, any>
): void {
  const metrics = getFallbackMetrics(service);
  const now = Date.now();
  
  metrics.triggered++;
  metrics.lastTriggeredAt = now;
  metrics.byReason[reason] = (metrics.byReason[reason] || 0) + 1;
  
  // Alert on frequent fallback usage
  if (metrics.triggered % 10 === 0) {
    createAlert(
      'warning',
      `ServiceHealth:${service}`,
      `Fallback mechanism triggered ${metrics.triggered} times`,
      {
        service,
        reason,
        fallbacksByReason: metrics.byReason,
        ...details,
      }
    );
  }
}

/**
 * Get current health status for a service
 */
export function getServiceHealth(service: ServiceType): Readonly<ServiceHealth> {
  return { ...getHealth(service) };
}

/**
 * Get fallback metrics for a service
 */
export function getServiceFallbackMetrics(service: ServiceType): Readonly<FallbackMetrics> {
  return { ...getFallbackMetrics(service) };
}

/**
 * Get health summary for all services
 */
export function getAllServiceHealth(): Record<ServiceType, Readonly<ServiceHealth>> {
  const summary: Record<string, Readonly<ServiceHealth>> = {};
  
  for (const service of ['llm', 'python_predictor'] as ServiceType[]) {
    summary[service] = getServiceHealth(service);
  }
  
  return summary as Record<ServiceType, Readonly<ServiceHealth>>;
}

/**
 * Reset service health (useful for testing)
 */
export function resetServiceHealth(service?: ServiceType): void {
  if (service) {
    serviceHealth.delete(service);
    fallbackMetrics.delete(service);
    responseTimes.delete(service);
  } else {
    serviceHealth.clear();
    fallbackMetrics.clear();
    responseTimes.clear();
  }
}

/**
 * Force open/close circuit breaker (for testing)
 */
export function setCircuitBreakerState(service: ServiceType, open: boolean): void {
  const health = getHealth(service);
  health.circuitBreakerOpen = open;
  health.status = open ? 'unavailable' : 'available';
}
