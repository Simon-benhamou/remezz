/**
 * Entry Decision Visibility Service
 * 
 * Provides detailed insights into why trades are blocked or allowed,
 * making the meta-adaptive entry system transparent to traders.
 */

import { prisma } from '../db/client.js';
import type { RegimeAwareThresholds } from './regimeAwareThresholds.js';

export type EntryCheckStatus = 'pass' | 'fail' | 'n/a' | 'warning';

export type EntryCheckComponent = {
  key: string;
  label: string;
  status: EntryCheckStatus;
  detail: string;
  score: number | null;
  threshold?: number;
  actual?: number;
  impact: 'blocker' | 'moderate' | 'minor';
};

export type EntryDecisionSummary = {
  sessionId: string;
  symbol: string;
  timestamp: number;
  decision: 'allowed' | 'blocked' | 'warning';
  overallScore: number;
  confidence: number;
  components: EntryCheckComponent[];
  blockingReasons: string[];
  warnings: string[];
  thresholds: Partial<RegimeAwareThresholds>;
  regimeInfo?: {
    regime: string;
    direction: string;
    volatility: string;
    tags: string[];
  };
  recommendation?: string;
};

export type EntryHistoryEntry = {
  timestamp: number;
  symbol: string;
  decision: 'allowed' | 'blocked';
  confidence: number;
  eligibilityScore: number;
  primaryReason?: string;
  tradeExecuted: boolean;
  tradeProfitable?: boolean | null;
};

/**
 * Store entry decision for historical analysis
 */
export async function recordEntryDecision(
  sessionId: string,
  summary: EntryDecisionSummary
): Promise<void> {
  try {
    // Store in ops telemetry for queryability
    const { recordOpsEvent } = await import('../monitor/ops.js');
    
    recordOpsEvent({
      level: summary.decision === 'blocked' ? 'warn' : 'info',
      source: 'entry_decision_visibility',
      message: `entry_${summary.decision}`,
      sessionId,
      symbol: summary.symbol,
      details: {
        confidence: summary.confidence,
        overallScore: summary.overallScore,
        blockingReasons: summary.blockingReasons,
        warnings: summary.warnings,
        components: summary.components.map(c => ({
          key: c.key,
          status: c.status,
          score: c.score,
          impact: c.impact,
        })),
        thresholds: summary.thresholds,
        regime: summary.regimeInfo,
      },
    });
  } catch (error) {
    console.warn('Failed to record entry decision:', error);
  }
}

/**
 * Get recent entry decisions for a session
 */
export async function getRecentEntryDecisions(
  sessionId: string,
  limit: number = 20
): Promise<EntryHistoryEntry[]> {
  try {
    const { recentOpsEvents } = await import('../monitor/ops.js');
    const events = recentOpsEvents(limit * 2, { sessionId })
      .filter(e => e.source === 'entry_decision_visibility');

    return events.slice(0, limit).map(event => {
      const details = event.details as any || {};
      return {
        timestamp: event.ts,
        symbol: event.symbol || '',
        decision: event.message?.includes('blocked') ? 'blocked' : 'allowed',
        confidence: details.confidence || 0,
        eligibilityScore: details.overallScore || 0,
        primaryReason: details.blockingReasons?.[0],
        tradeExecuted: false, // TODO: Link with actual trades
        tradeProfitable: null,
      };
    });
  } catch (error) {
    console.error('Failed to get recent entry decisions:', error);
    return [];
  }
}

/**
 * Get entry decision statistics for a session
 */
export async function getEntryDecisionStats(sessionId: string): Promise<{
  total: number;
  allowed: number;
  blocked: number;
  blockRate: number;
  topBlockingReasons: Array<{ reason: string; count: number }>;
  avgConfidenceAllowed: number;
  avgConfidenceBlocked: number;
}> {
  try {
    const { recentOpsEvents } = await import('../monitor/ops.js');
    const events = recentOpsEvents(200, { sessionId })
      .filter(e => e.source === 'entry_decision_visibility');

    const total = events.length;
    const allowed = events.filter(e => e.message?.includes('allowed')).length;
    const blocked = events.filter(e => e.message?.includes('blocked')).length;

    // Collect blocking reasons
    const reasonCounts = new Map<string, number>();
    let confidenceSumAllowed = 0;
    let confidenceSumBlocked = 0;

    events.forEach(event => {
      const details = event.details as any || {};
      const isBlocked = event.message?.includes('blocked');
      
      if (isBlocked && details.blockingReasons) {
        details.blockingReasons.forEach((reason: string) => {
          reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
        });
        confidenceSumBlocked += details.confidence || 0;
      } else {
        confidenceSumAllowed += details.confidence || 0;
      }
    });

    const topBlockingReasons = Array.from(reasonCounts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      total,
      allowed,
      blocked,
      blockRate: total > 0 ? (blocked / total) * 100 : 0,
      topBlockingReasons,
      avgConfidenceAllowed: allowed > 0 ? confidenceSumAllowed / allowed : 0,
      avgConfidenceBlocked: blocked > 0 ? confidenceSumBlocked / blocked : 0,
    };
  } catch (error) {
    console.error('Failed to get entry decision stats:', error);
    return {
      total: 0,
      allowed: 0,
      blocked: 0,
      blockRate: 0,
      topBlockingReasons: [],
      avgConfidenceAllowed: 0,
      avgConfidenceBlocked: 0,
    };
  }
}

/**
 * Generate recommendation based on entry decision pattern
 */
export function generateRecommendation(
  stats: Awaited<ReturnType<typeof getEntryDecisionStats>>
): string {
  if (stats.total < 10) {
    return 'Collecting data... Need more entry attempts for analysis.';
  }

  const { blockRate, topBlockingReasons } = stats;

  if (blockRate > 90) {
    const mainReason = topBlockingReasons[0]?.reason || 'unknown';
    return `⚠️ Very high block rate (${blockRate.toFixed(0)}%). Main issue: ${mainReason}. Consider lowering thresholds.`;
  }

  if (blockRate > 70) {
    return `🟡 High block rate (${blockRate.toFixed(0)}%). System is very selective. Review threshold configuration.`;
  }

  if (blockRate < 20) {
    return `✅ Good balance (${blockRate.toFixed(0)}% blocked). Entry filters are well-calibrated.`;
  }

  return `🟢 Moderate selectivity (${blockRate.toFixed(0)}% blocked). Monitor performance and adjust as needed.`;
}

/**
 * Format entry decision for console/log output
 */
export function formatEntryDecisionLog(summary: EntryDecisionSummary): string {
  const lines = [
    `📊 Entry Decision for ${summary.symbol}`,
    `   Decision: ${summary.decision.toUpperCase()}`,
    `   Confidence: ${(summary.confidence * 100).toFixed(1)}%`,
    `   Overall Score: ${(summary.overallScore * 100).toFixed(1)}%`,
  ];

  if (summary.regimeInfo) {
    lines.push(
      `   Regime: ${summary.regimeInfo.regime} (${summary.regimeInfo.direction})`
    );
  }

  if (summary.blockingReasons.length > 0) {
    lines.push('   Blocking Reasons:');
    summary.blockingReasons.forEach(reason => {
      lines.push(`     - ${reason}`);
    });
  }

  if (summary.warnings.length > 0) {
    lines.push('   Warnings:');
    summary.warnings.forEach(warning => {
      lines.push(`     - ${warning}`);
    });
  }

  lines.push('   Components:');
  summary.components
    .filter(c => c.status === 'fail' || c.impact === 'blocker')
    .forEach(c => {
      const icon = c.status === 'pass' ? '✅' : c.status === 'fail' ? '❌' : '⚠️';
      lines.push(`     ${icon} ${c.label}: ${c.detail}`);
    });

  if (summary.recommendation) {
    lines.push(`   💡 ${summary.recommendation}`);
  }

  return lines.join('\n');
}
