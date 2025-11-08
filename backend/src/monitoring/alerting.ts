/**
 * Production Alerting Module
 * Monitors critical system failures and sends alerts
 */

export type AlertLevel = 'info' | 'warning' | 'critical';

export type Alert = {
  level: AlertLevel;
  component: string;
  message: string;
  timestamp: number;
  metadata?: Record<string, any>;
};

// In-memory alert buffer
const alertBuffer: Alert[] = [];
const MAX_BUFFER_SIZE = 1000;

// Alert thresholds
const ALERT_THRESHOLDS = {
  optimizationFailureCount: 3, // Alert after 3 consecutive failures
  outcomeUpdaterLag: 2 * 60 * 60 * 1000, // 2 hours
  fallbackParameterUsage: 0.7, // Alert if >70% using fallback
  highFallbackUsageWindow: 100, // Check last 100 decisions
};

// Tracking metrics
const metrics = {
  optimizationFailures: [] as { symbol: string; timestamp: number }[],
  lastOutcomeUpdate: Date.now(),
  recentParameterSources: [] as string[],
};

/**
 * Create and log an alert
 */
export function createAlert(
  level: AlertLevel,
  component: string,
  message: string,
  metadata?: Record<string, any>
): void {
  const alert: Alert = {
    level,
    component,
    message,
    timestamp: Date.now(),
    metadata,
  };

  // Add to buffer
  alertBuffer.push(alert);
  if (alertBuffer.length > MAX_BUFFER_SIZE) {
    alertBuffer.shift(); // Remove oldest alert
  }

  // Log based on severity
  const logMessage = `[${level.toUpperCase()}] ${component}: ${message}`;
  if (level === 'critical') {
    console.error(logMessage, metadata || {});
  } else if (level === 'warning') {
    console.warn(logMessage, metadata || {});
  } else {
    console.info(logMessage, metadata || {});
  }

  // In production, this would send to alerting service (e.g., PagerDuty, Slack)
  // sendToAlertingService(alert);
}

/**
 * Track optimization failure and alert if threshold exceeded
 */
export function trackOptimizationFailure(symbol: string): void {
  const now = Date.now();
  metrics.optimizationFailures.push({ symbol, timestamp: now });

  // Clean old failures (older than 1 hour)
  const oneHourAgo = now - 60 * 60 * 1000;
  metrics.optimizationFailures = metrics.optimizationFailures.filter(
    (f) => f.timestamp > oneHourAgo
  );

  // Check if threshold exceeded
  if (metrics.optimizationFailures.length >= ALERT_THRESHOLDS.optimizationFailureCount) {
    createAlert(
      'critical',
      'StrategyOptimizer',
      `High optimization failure rate: ${metrics.optimizationFailures.length} failures in last hour`,
      { 
        symbols: metrics.optimizationFailures.map((f) => f.symbol),
        threshold: ALERT_THRESHOLDS.optimizationFailureCount 
      }
    );
  }
}

/**
 * Track outcome updater activity and alert if lagging
 */
export function trackOutcomeUpdate(): void {
  metrics.lastOutcomeUpdate = Date.now();
}

/**
 * Check outcome updater lag
 */
export function checkOutcomeUpdaterLag(): void {
  const now = Date.now();
  const lag = now - metrics.lastOutcomeUpdate;

  if (lag > ALERT_THRESHOLDS.outcomeUpdaterLag) {
    createAlert(
      'critical',
      'OutcomeUpdater',
      `Outcome updater is lagging: ${Math.round(lag / 60000)} minutes since last update`,
      { 
        lagMs: lag,
        threshold: ALERT_THRESHOLDS.outcomeUpdaterLag,
        lastUpdate: new Date(metrics.lastOutcomeUpdate).toISOString()
      }
    );
  }
}

/**
 * Track parameter source usage and alert if high fallback rate
 */
export function trackParameterSource(source: string): void {
  metrics.recentParameterSources.push(source);

  // Keep only recent window
  if (metrics.recentParameterSources.length > ALERT_THRESHOLDS.highFallbackUsageWindow) {
    metrics.recentParameterSources.shift();
  }

  // Check fallback usage rate
  if (metrics.recentParameterSources.length >= ALERT_THRESHOLDS.highFallbackUsageWindow) {
    const fallbackCount = metrics.recentParameterSources.filter(
      (s) => s === 'default' || s === 'single_profile'
    ).length;
    const fallbackRate = fallbackCount / metrics.recentParameterSources.length;

    if (fallbackRate > ALERT_THRESHOLDS.fallbackParameterUsage) {
      createAlert(
        'warning',
        'ParameterLoader',
        `High fallback parameter usage: ${(fallbackRate * 100).toFixed(1)}% of recent decisions`,
        { 
          fallbackRate,
          threshold: ALERT_THRESHOLDS.fallbackParameterUsage,
          recentSources: metrics.recentParameterSources.slice(-10)
        }
      );
      // Reset to avoid repeated alerts
      metrics.recentParameterSources = [];
    }
  }
}

/**
 * Get recent alerts for monitoring dashboard
 */
export function getRecentAlerts(limit: number = 100): Alert[] {
  return alertBuffer.slice(-limit);
}

/**
 * Get alerts by level
 */
export function getAlertsByLevel(level: AlertLevel, limit: number = 50): Alert[] {
  return alertBuffer.filter((a) => a.level === level).slice(-limit);
}

/**
 * Clear alert buffer (for testing or manual reset)
 */
export function clearAlerts(): void {
  alertBuffer.length = 0;
}

/**
 * Get current alert metrics for monitoring
 */
export function getAlertMetrics(): {
  totalAlerts: number;
  criticalAlerts: number;
  warningAlerts: number;
  infoAlerts: number;
  recentOptimizationFailures: number;
  lastOutcomeUpdate: string;
  fallbackParameterRate: number;
} {
  const critical = alertBuffer.filter((a) => a.level === 'critical').length;
  const warning = alertBuffer.filter((a) => a.level === 'warning').length;
  const info = alertBuffer.filter((a) => a.level === 'info').length;

  let fallbackRate = 0;
  if (metrics.recentParameterSources.length > 0) {
    const fallbackCount = metrics.recentParameterSources.filter(
      (s) => s === 'default' || s === 'single_profile'
    ).length;
    fallbackRate = fallbackCount / metrics.recentParameterSources.length;
  }

  return {
    totalAlerts: alertBuffer.length,
    criticalAlerts: critical,
    warningAlerts: warning,
    infoAlerts: info,
    recentOptimizationFailures: metrics.optimizationFailures.length,
    lastOutcomeUpdate: new Date(metrics.lastOutcomeUpdate).toISOString(),
    fallbackParameterRate: fallbackRate,
  };
}
