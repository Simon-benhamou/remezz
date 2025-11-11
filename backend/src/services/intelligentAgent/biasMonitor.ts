/**
 * Bias Monitoring Service
 * 
 * Tracks long/short bias selection and provides statistics
 * to ensure the system is balanced and not favoring one direction
 */

import { prisma } from '../../db/client.js';

export type BiasStats = {
  totalDecisions: number;
  longCount: number;
  shortCount: number;
  noneCount: number;
  longPercentage: number;
  shortPercentage: number;
  nonePercentage: number;
  avgLongConfidence: number;
  avgShortConfidence: number;
  periodStart: Date;
  periodEnd: Date;
};

/**
 * Get bias statistics for a given period
 * @param days Number of days to look back (default 30)
 */
export async function getBiasStatistics(days: number = 30): Promise<BiasStats> {
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - days);
  const periodEnd = new Date();

  try {
    // Get all decision memories from the period
    const decisions = await prisma.decisionMemory.findMany({
      where: {
        createdAt: {
          gte: periodStart,
          lte: periodEnd,
        },
      },
      select: {
        bias: true,
        confidence: true,
        biasConfidence: true,
      },
    });

    let longCount = 0;
    let shortCount = 0;
    let noneCount = 0;
    let longConfidenceSum = 0;
    let shortConfidenceSum = 0;

    for (const decision of decisions) {
      const bias = decision.bias || 'none';
      const confidence = decision.biasConfidence || decision.confidence || 0;

      if (bias === 'long') {
        longCount++;
        longConfidenceSum += confidence;
      } else if (bias === 'short') {
        shortCount++;
        shortConfidenceSum += confidence;
      } else {
        noneCount++;
      }
    }

    const totalDecisions = decisions.length;
    const longPercentage = totalDecisions > 0 ? (longCount / totalDecisions) * 100 : 0;
    const shortPercentage = totalDecisions > 0 ? (shortCount / totalDecisions) * 100 : 0;
    const nonePercentage = totalDecisions > 0 ? (noneCount / totalDecisions) * 100 : 0;
    const avgLongConfidence = longCount > 0 ? longConfidenceSum / longCount : 0;
    const avgShortConfidence = shortCount > 0 ? shortConfidenceSum / shortCount : 0;

    return {
      totalDecisions,
      longCount,
      shortCount,
      noneCount,
      longPercentage,
      shortPercentage,
      nonePercentage,
      avgLongConfidence,
      avgShortConfidence,
      periodStart,
      periodEnd,
    };
  } catch (error) {
    console.error('Error fetching bias statistics:', error);
    return {
      totalDecisions: 0,
      longCount: 0,
      shortCount: 0,
      noneCount: 0,
      longPercentage: 0,
      shortPercentage: 0,
      nonePercentage: 0,
      avgLongConfidence: 0,
      avgShortConfidence: 0,
      periodStart,
      periodEnd,
    };
  }
}

/**
 * Log bias statistics to console with formatting
 */
export async function logBiasStatistics(days: number = 30): Promise<void> {
  const stats = await getBiasStatistics(days);

  console.log('\n' + '='.repeat(80));
  console.log(`📊 BIAS STATISTICS (Last ${days} days)`);
  console.log('='.repeat(80));
  console.log(`Period: ${stats.periodStart.toISOString()} to ${stats.periodEnd.toISOString()}`);
  console.log(`Total Decisions: ${stats.totalDecisions}`);
  console.log('');
  console.log(`🟢 LONG:  ${stats.longCount.toString().padStart(4)} (${stats.longPercentage.toFixed(1)}%) - Avg Confidence: ${stats.avgLongConfidence.toFixed(1)}%`);
  console.log(`🔴 SHORT: ${stats.shortCount.toString().padStart(4)} (${stats.shortPercentage.toFixed(1)}%) - Avg Confidence: ${stats.avgShortConfidence.toFixed(1)}%`);
  console.log(`⚪ NONE:  ${stats.noneCount.toString().padStart(4)} (${stats.nonePercentage.toFixed(1)}%)`);
  console.log('');

  // Warn if imbalance detected (>70% one direction is concerning)
  if (stats.totalDecisions >= 20) {
    if (stats.longPercentage > 70) {
      console.log(`⚠️ WARNING: LONG BIAS DETECTED (${stats.longPercentage.toFixed(1)}% long positions)`);
      console.log(`   Expected: ~40-60% range for balanced strategy`);
    } else if (stats.shortPercentage > 70) {
      console.log(`⚠️ WARNING: SHORT BIAS DETECTED (${stats.shortPercentage.toFixed(1)}% short positions)`);
      console.log(`   Expected: ~40-60% range for balanced strategy`);
    } else if (stats.longPercentage >= 40 && stats.longPercentage <= 60) {
      console.log(`✅ BALANCED: System showing healthy long/short distribution`);
    } else {
      console.log(`ℹ️ INFO: Moderate bias detected. Monitor if this persists.`);
    }
  } else {
    console.log(`ℹ️ INFO: Insufficient data (${stats.totalDecisions} decisions) for bias analysis. Need 20+ decisions.`);
  }

  console.log('='.repeat(80) + '\n');
}

/**
 * Check if system has concerning bias (for automated alerts)
 */
export async function hasSignificantBias(days: number = 30, threshold: number = 70): Promise<{
  hasImbalance: boolean;
  direction: 'long' | 'short' | 'none';
  percentage: number;
  stats: BiasStats;
}> {
  const stats = await getBiasStatistics(days);

  if (stats.totalDecisions < 20) {
    return {
      hasImbalance: false,
      direction: 'none',
      percentage: 0,
      stats,
    };
  }

  if (stats.longPercentage > threshold) {
    return {
      hasImbalance: true,
      direction: 'long',
      percentage: stats.longPercentage,
      stats,
    };
  }

  if (stats.shortPercentage > threshold) {
    return {
      hasImbalance: true,
      direction: 'short',
      percentage: stats.shortPercentage,
      stats,
    };
  }

  return {
    hasImbalance: false,
    direction: 'none',
    percentage: Math.max(stats.longPercentage, stats.shortPercentage),
    stats,
  };
}

/**
 * Record bias decision for monitoring (called when autoBias is determined)
 */
export function logBiasDecision(
  symbol: string,
  bias: 'long' | 'short' | 'none',
  confidence: number,
  reasoning: string,
  scores: { bullScore: number; bearScore: number }
): void {
  const timestamp = new Date().toISOString();
  console.log(
    `📊 [${timestamp}] BIAS: ${symbol} → ${bias.toUpperCase()} ` +
    `(confidence: ${confidence.toFixed(1)}%, bull: ${scores.bullScore.toFixed(0)}, bear: ${scores.bearScore.toFixed(0)}) ` +
    `| ${reasoning}`
  );
}
