/**
 * Data Quality Validation Module
 * Validates market data for anomalies, outliers, and corruption
 */

/**
 * Validation result type
 */
export type ValidationResult = {
  valid: boolean;
  issues: string[];
};

/**
 * OHLCV data point for validation
 */
export type OHLCVData = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Validate OHLC consistency (high >= low, close/open within range)
 */
export function validateOHLCConsistency(data: OHLCVData): ValidationResult {
  const issues: string[] = [];

  // Check high >= low
  if (data.high < data.low) {
    issues.push(`High (${data.high}) is less than Low (${data.low})`);
  }

  // Check close is between high and low
  if (data.close > data.high) {
    issues.push(`Close (${data.close}) is greater than High (${data.high})`);
  }
  if (data.close < data.low) {
    issues.push(`Close (${data.close}) is less than Low (${data.low})`);
  }

  // Check open is between high and low
  if (data.open > data.high) {
    issues.push(`Open (${data.open}) is greater than High (${data.high})`);
  }
  if (data.open < data.low) {
    issues.push(`Open (${data.open}) is less than Low (${data.low})`);
  }

  // Check all values are positive
  if (data.high <= 0 || data.low <= 0 || data.open <= 0 || data.close <= 0) {
    issues.push('Price values must be positive');
  }

  // Check volume is non-negative
  if (data.volume < 0) {
    issues.push(`Volume (${data.volume}) is negative`);
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Detect price outliers using statistical methods (Z-score)
 * Returns true if price change is beyond threshold (default 5 sigma)
 */
export function detectPriceOutlier(
  currentPrice: number,
  recentPrices: number[],
  threshold: number = 5
): ValidationResult {
  const issues: string[] = [];

  if (recentPrices.length < 2) {
    return { valid: true, issues: [] }; // Not enough data to determine outlier
  }

  // Calculate mean and standard deviation of recent prices
  const mean = recentPrices.reduce((sum, p) => sum + p, 0) / recentPrices.length;
  const variance =
    recentPrices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / recentPrices.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) {
    return { valid: true, issues: [] }; // No variance, can't detect outliers
  }

  // Calculate Z-score
  const zScore = Math.abs((currentPrice - mean) / stdDev);

  if (zScore > threshold) {
    issues.push(
      `Price outlier detected: ${currentPrice.toFixed(2)} (Z-score: ${zScore.toFixed(2)}, threshold: ${threshold})`
    );
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Detect volume anomalies using Z-score
 */
export function detectVolumeAnomaly(
  currentVolume: number,
  recentVolumes: number[],
  threshold: number = 5
): ValidationResult {
  const issues: string[] = [];

  if (recentVolumes.length < 2) {
    return { valid: true, issues: [] };
  }

  // Filter out zero volumes for statistics
  const nonZeroVolumes = recentVolumes.filter((v) => v > 0);
  if (nonZeroVolumes.length < 2) {
    return { valid: true, issues: [] };
  }

  // Calculate mean and standard deviation
  const mean = nonZeroVolumes.reduce((sum, v) => sum + v, 0) / nonZeroVolumes.length;
  const variance =
    nonZeroVolumes.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / nonZeroVolumes.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) {
    return { valid: true, issues: [] };
  }

  // Calculate Z-score
  const zScore = Math.abs((currentVolume - mean) / stdDev);

  if (zScore > threshold) {
    issues.push(
      `Volume anomaly detected: ${currentVolume.toFixed(2)} (Z-score: ${zScore.toFixed(2)}, threshold: ${threshold})`
    );
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Validate timestamp sequence (no gaps, no duplicates, chronological order)
 */
export function validateTimestampSequence(
  timestamps: number[],
  expectedInterval: number = 60000 // 1 minute default
): ValidationResult {
  const issues: string[] = [];

  if (timestamps.length < 2) {
    return { valid: true, issues: [] };
  }

  // Check chronological order
  for (let i = 1; i < timestamps.length; i++) {
    if (timestamps[i] <= timestamps[i - 1]) {
      issues.push(`Non-chronological timestamps at index ${i}: ${timestamps[i - 1]} -> ${timestamps[i]}`);
    }
  }

  // Check for large gaps (more than 2x expected interval)
  const maxGap = expectedInterval * 2;
  for (let i = 1; i < timestamps.length; i++) {
    const gap = timestamps[i] - timestamps[i - 1];
    if (gap > maxGap) {
      issues.push(`Large time gap detected: ${gap}ms at index ${i} (expected ~${expectedInterval}ms)`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Comprehensive validation of OHLCV array
 */
export function validateOHLCVArray(
  data: OHLCVData[],
  options: {
    checkOutliers?: boolean;
    checkVolumeAnomalies?: boolean;
    checkTimestamps?: boolean;
    outlierThreshold?: number;
    volumeThreshold?: number;
    expectedInterval?: number;
  } = {}
): ValidationResult {
  const {
    checkOutliers = true,
    checkVolumeAnomalies = true,
    checkTimestamps = true,
    outlierThreshold = 5,
    volumeThreshold = 5,
    expectedInterval = 60000,
  } = options;

  const allIssues: string[] = [];

  // Validate each OHLCV data point for consistency
  data.forEach((point, index) => {
    const result = validateOHLCConsistency(point);
    if (!result.valid) {
      allIssues.push(`[Index ${index}] ${result.issues.join(', ')}`);
    }
  });

  // Check for price outliers
  if (checkOutliers && data.length > 10) {
    const closePrices = data.map((d) => d.close);
    for (let i = 10; i < data.length; i++) {
      const recentPrices = closePrices.slice(i - 10, i);
      const result = detectPriceOutlier(closePrices[i], recentPrices, outlierThreshold);
      if (!result.valid) {
        allIssues.push(`[Index ${i}] ${result.issues.join(', ')}`);
      }
    }
  }

  // Check for volume anomalies
  if (checkVolumeAnomalies && data.length > 10) {
    const volumes = data.map((d) => d.volume);
    for (let i = 10; i < data.length; i++) {
      const recentVolumes = volumes.slice(i - 10, i);
      const result = detectVolumeAnomaly(volumes[i], recentVolumes, volumeThreshold);
      if (!result.valid) {
        allIssues.push(`[Index ${i}] ${result.issues.join(', ')}`);
      }
    }
  }

  // Check timestamp sequence
  if (checkTimestamps) {
    const timestamps = data.map((d) => d.timestamp);
    const result = validateTimestampSequence(timestamps, expectedInterval);
    if (!result.valid) {
      allIssues.push(...result.issues);
    }
  }

  return {
    valid: allIssues.length === 0,
    issues: allIssues,
  };
}

/**
 * Log validation issues with appropriate severity
 */
export function logValidationIssues(symbol: string, issues: string[], severity: 'warn' | 'error' = 'warn'): void {
  if (issues.length === 0) return;

  const message = `Data quality issues for ${symbol}: ${issues.length} problem(s) found`;
  
  if (severity === 'error') {
    console.error(message, { issues: issues.slice(0, 5) }); // Log first 5 issues
  } else {
    console.warn(message, { issues: issues.slice(0, 5) });
  }
}
