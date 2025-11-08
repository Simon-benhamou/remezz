/**
 * A/B Testing Framework for Threshold Configurations
 * 
 * Allows comparing different threshold configurations to find
 * optimal settings through controlled experimentation.
 */

import { prisma } from '../db/client.js';
import { Prisma } from '.prisma/client';
import type { ThresholdSnapshot } from './adaptiveThresholdLearning.js';

export type ABTestVariant = {
  id: string;
  name: string;
  description: string;
  thresholds: ThresholdSnapshot;
  weight: number; // 0-1, allocation percentage
};

export type ABTest = {
  id: string;
  name: string;
  description: string;
  symbol?: string; // If null, applies to all symbols
  aggressiveness?: 'conservative' | 'reactive' | 'aggressive';
  variants: ABTestVariant[];
  status: 'draft' | 'active' | 'paused' | 'completed';
  startDate: number;
  endDate?: number;
  minSampleSize: number;
  createdAt: number;
  updatedAt: number;
};

export type ABTestResult = {
  testId: string;
  variantId: string;
  variantName: string;
  metrics: {
    totalEvaluations: number;
    entriesAllowed: number;
    tradesExecuted: number;
    winRate: number;
    avgPnlPct: number;
    profitFactor: number;
    sharpeRatio: number;
    maxDrawdown: number;
  };
  thresholds: ThresholdSnapshot;
  lastUpdated: number;
};

export type ABTestComparison = {
  testId: string;
  testName: string;
  winner?: string;
  confidence: number; // 0-1, statistical confidence in winner
  variants: ABTestResult[];
  recommendation: string;
};

/**
 * Create a new A/B test
 */
export async function createABTest(test: Omit<ABTest, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
  const id = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  try {
    await prisma.$executeRaw`
      INSERT INTO ab_tests (
        id, name, description, symbol, aggressiveness, variants,
        status, start_date, end_date, min_sample_size
      ) VALUES (
        ${id},
        ${test.name},
        ${test.description},
        ${test.symbol || null},
        ${test.aggressiveness || null},
        ${JSON.stringify(test.variants)},
        ${test.status},
        ${new Date(test.startDate)},
        ${test.endDate ? new Date(test.endDate) : null},
        ${test.minSampleSize}
      )
    `.catch(err => {
      console.warn('AB tests table not available:', err.message);
    });

    console.log(`✅ Created A/B test: ${id} (${test.name})`);
    return id;
  } catch (error) {
    console.error('Failed to create A/B test:', error);
    throw error;
  }
}

/**
 * Get active A/B test for a symbol/aggressiveness combination
 */
export async function getActiveTest(
  symbol: string,
  aggressiveness: 'conservative' | 'reactive' | 'aggressive'
): Promise<ABTest | null> {
  try {
    const tests = await prisma.$queryRaw<ABTest[]>`
      SELECT * FROM ab_tests
      WHERE status = 'active'
        AND (symbol = ${symbol} OR symbol IS NULL)
        AND (aggressiveness = ${aggressiveness} OR aggressiveness IS NULL)
      ORDER BY symbol DESC NULLS LAST, created_at DESC
      LIMIT 1
    `.catch(() => []);

    return tests.length > 0 ? tests[0] : null;
  } catch (error) {
    console.error('Failed to get active test:', error);
    return null;
  }
}

/**
 * Assign variant for an evaluation (weighted random)
 */
export function assignVariant(test: ABTest): ABTestVariant {
  const random = Math.random();
  let cumulative = 0;

  for (const variant of test.variants) {
    cumulative += variant.weight;
    if (random <= cumulative) {
      return variant;
    }
  }

  // Fallback to first variant
  return test.variants[0];
}

/**
 * Record A/B test evaluation
 */
export async function recordABTestEvaluation(
  testId: string,
  variantId: string,
  evaluation: {
    sessionId: string;
    symbol: string;
    allowed: boolean;
    executed: boolean;
    profitable?: boolean;
    pnlPct?: number;
  }
): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO ab_test_evaluations (
        test_id, variant_id, session_id, symbol,
        allowed, executed, profitable, pnl_pct, timestamp
      ) VALUES (
        ${testId}, ${variantId}, ${evaluation.sessionId}, ${evaluation.symbol},
        ${evaluation.allowed}, ${evaluation.executed},
        ${evaluation.profitable || null}, ${evaluation.pnlPct || null},
        NOW()
      )
    `.catch(err => {
      console.warn('AB test evaluations table not available:', err.message);
    });
  } catch (error) {
    console.warn('Failed to record A/B test evaluation:', error);
  }
}

/**
 * Get A/B test results
 */
export async function getABTestResults(testId: string): Promise<ABTestResult[]> {
  try {
    const results = await prisma.$queryRaw<any[]>`
      SELECT 
        variant_id,
        COUNT(*) as total_evaluations,
        SUM(CASE WHEN allowed THEN 1 ELSE 0 END) as entries_allowed,
        SUM(CASE WHEN executed THEN 1 ELSE 0 END) as trades_executed,
        AVG(CASE WHEN executed AND profitable IS NOT NULL THEN 
          CASE WHEN profitable THEN 1.0 ELSE 0.0 END 
        END) as win_rate,
        AVG(CASE WHEN executed THEN pnl_pct END) as avg_pnl_pct,
        MAX(timestamp) as last_updated
      FROM ab_test_evaluations
      WHERE test_id = ${testId}
      GROUP BY variant_id
    `.catch(() => []);

    // Get test details for variant info
    const test = await prisma.$queryRaw<ABTest[]>`
      SELECT * FROM ab_tests WHERE id = ${testId} LIMIT 1
    `.catch(() => []);

    if (test.length === 0 || !test[0].variants) {
      return [];
    }

    const variants = test[0].variants as ABTestVariant[];

    return results.map(r => {
      const variant = variants.find(v => v.id === r.variant_id);
      
      // Calculate additional metrics
      const grossProfit = r.total_profit || 0;
      const grossLoss = Math.abs(r.total_loss || 0);
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;

      return {
        testId,
        variantId: r.variant_id,
        variantName: variant?.name || r.variant_id,
        metrics: {
          totalEvaluations: parseInt(r.total_evaluations) || 0,
          entriesAllowed: parseInt(r.entries_allowed) || 0,
          tradesExecuted: parseInt(r.trades_executed) || 0,
          winRate: parseFloat(r.win_rate) || 0,
          avgPnlPct: parseFloat(r.avg_pnl_pct) || 0,
          profitFactor,
          sharpeRatio: 0, // TODO: Calculate from individual trades
          maxDrawdown: 0, // TODO: Calculate from equity curve
        },
        thresholds: variant?.thresholds || {} as ThresholdSnapshot,
        lastUpdated: r.last_updated ? new Date(r.last_updated).getTime() : Date.now(),
      };
    });
  } catch (error) {
    console.error('Failed to get A/B test results:', error);
    return [];
  }
}

/**
 * Compare A/B test variants and determine winner
 * 
 * Uses a simplified statistical confidence calculation based on:
 * - Performance gap between variants (effect size)
 * - Sample size (larger samples = higher confidence)
 * - Formula: confidence = min(0.95, performanceGap * sqrt(sampleSize / 100))
 * 
 * Note: This is a heuristic approximation. For rigorous statistical testing,
 * consider using proper t-tests or bootstrap methods.
 */
export async function compareABTestVariants(testId: string): Promise<ABTestComparison> {
  const results = await getABTestResults(testId);
  
  // Get test details
  const test = await prisma.$queryRaw<ABTest[]>`
    SELECT * FROM ab_tests WHERE id = ${testId} LIMIT 1
  `.catch(() => []);

  const testName = test.length > 0 ? test[0].name : testId;
  const minSampleSize = test.length > 0 ? test[0].minSampleSize : 30;

  // Confidence calculation constants
  const MAX_CONFIDENCE = 0.95; // Cap at 95% confidence
  const SAMPLE_SIZE_NORMALIZER = 100; // Normalizes sample size impact

  // Determine winner based on Sharpe ratio (or average PnL if Sharpe not available)
  let winner: string | undefined;
  let confidence = 0;

  if (results.length >= 2) {
    const allMeetMinSample = results.every(r => r.metrics.tradesExecuted >= minSampleSize);

    if (allMeetMinSample) {
      // Sort by Sharpe ratio (or avg PnL if Sharpe is 0)
      const sorted = [...results].sort((a, b) => {
        const aScore = a.metrics.sharpeRatio || a.metrics.avgPnlPct;
        const bScore = b.metrics.sharpeRatio || b.metrics.avgPnlPct;
        return bScore - aScore;
      });

      const best = sorted[0];
      const secondBest = sorted[1];

      // Calculate confidence based on performance gap and sample size
      const performanceGap = Math.abs(
        (best.metrics.sharpeRatio || best.metrics.avgPnlPct) -
        (secondBest.metrics.sharpeRatio || secondBest.metrics.avgPnlPct)
      );
      
      const avgSampleSize = (best.metrics.tradesExecuted + secondBest.metrics.tradesExecuted) / 2;
      confidence = Math.min(MAX_CONFIDENCE, performanceGap * Math.sqrt(avgSampleSize / SAMPLE_SIZE_NORMALIZER));

      if (confidence > 0.7) {
        winner = best.variantId;
      }
    }
  }

  // Generate recommendation
  let recommendation: string;
  if (!winner) {
    if (results.some(r => r.metrics.tradesExecuted < minSampleSize)) {
      recommendation = `⏳ Continue testing - need ${minSampleSize} trades per variant`;
    } else {
      recommendation = '🤷 No clear winner - variants perform similarly';
    }
  } else {
    const winnerResult = results.find(r => r.variantId === winner);
    recommendation = `🏆 Winner: ${winnerResult?.variantName} with ${(confidence * 100).toFixed(0)}% confidence`;
  }

  return {
    testId,
    testName,
    winner,
    confidence,
    variants: results,
    recommendation,
  };
}

/**
 * Initialize A/B testing tables
 */
export async function initializeABTesting(): Promise<void> {
  try {
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS ab_tests (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        symbol TEXT,
        aggressiveness TEXT,
        variants JSONB NOT NULL,
        status TEXT DEFAULT 'draft',
        start_date TIMESTAMP,
        end_date TIMESTAMP,
        min_sample_size INTEGER DEFAULT 30,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS ab_test_evaluations (
        id SERIAL PRIMARY KEY,
        test_id TEXT NOT NULL,
        variant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        allowed BOOLEAN NOT NULL,
        executed BOOLEAN NOT NULL,
        profitable BOOLEAN,
        pnl_pct DECIMAL(10, 4),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS idx_ab_test_evaluations_test_variant
      ON ab_test_evaluations (test_id, variant_id, timestamp DESC)
    `;

    console.log('✅ A/B testing tables initialized');
  } catch (error) {
    console.warn('⚠️ Failed to initialize A/B testing tables:', error);
  }
}
