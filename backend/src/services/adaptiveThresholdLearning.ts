/**
 * Adaptive Threshold Learning Service
 * 
 * Tracks which threshold configurations lead to profitable trades
 * and gradually optimizes thresholds based on actual performance.
 */

import { prisma } from '../db/client.js';

export type ThresholdSnapshot = {
  confidence: number;
  atr: number;
  adx: number;
  eligibility: number;
  rrMin: number;
};

export type TradeOutcome = {
  tradeId: string;
  sessionId: string;
  symbol: string;
  entryTime: number;
  exitTime: number;
  profitable: boolean;
  pnlPct: number;
  holdTimeMinutes: number;
  thresholds: ThresholdSnapshot;
  regime?: string;
};

export type ThresholdPerformance = {
  thresholdKey: string;
  sampleSize: number;
  /** Win rate as a decimal (0.0 - 1.0, where 0.6 = 60% win rate) */
  winRate: number;
  /** Average profit/loss percentage per trade */
  avgPnlPct: number;
  /** Average holding time in minutes */
  avgHoldTime: number;
  /** Profit factor = gross profits / gross losses (higher is better, >1.0 is profitable) */
  profitFactor: number;
  /** Sharpe ratio = return / volatility (higher is better, >1.0 is good, >2.0 is excellent) */
  sharpeRatio: number;
  lastUpdated: number;
};

export type AdaptiveLearningState = {
  symbol: string;
  aggressiveness: 'conservative' | 'reactive' | 'aggressive';
  currentThresholds: ThresholdSnapshot;
  recommendedThresholds: ThresholdSnapshot;
  performance: ThresholdPerformance[];
  learningProgress: number; // 0-1, how much data we have
  lastOptimizedAt: number;
};

/**
 * Store trade outcome with threshold configuration
 */
export async function recordTradeOutcome(outcome: TradeOutcome): Promise<void> {
  try {
    // Store in database for analysis
    await prisma.$executeRaw`
      INSERT INTO trade_outcomes (
        trade_id, session_id, symbol, entry_time, exit_time,
        profitable, pnl_pct, hold_time_minutes,
        threshold_confidence, threshold_atr, threshold_adx,
        threshold_eligibility, threshold_rr_min, regime
      ) VALUES (
        ${outcome.tradeId}, ${outcome.sessionId}, ${outcome.symbol},
        ${new Date(outcome.entryTime)}, ${new Date(outcome.exitTime)},
        ${outcome.profitable}, ${outcome.pnlPct}, ${outcome.holdTimeMinutes},
        ${outcome.thresholds.confidence}, ${outcome.thresholds.atr},
        ${outcome.thresholds.adx}, ${outcome.thresholds.eligibility},
        ${outcome.thresholds.rrMin}, ${outcome.regime || null}
      )
      ON CONFLICT (trade_id) DO UPDATE SET
        profitable = EXCLUDED.profitable,
        pnl_pct = EXCLUDED.pnl_pct,
        exit_time = EXCLUDED.exit_time,
        hold_time_minutes = EXCLUDED.hold_time_minutes
    `.catch(err => {
      // Table might not exist yet, log but don't fail
      console.warn('Trade outcomes table not available:', err.message);
    });
  } catch (error) {
    console.warn('Failed to record trade outcome:', error);
  }
}

/**
 * Analyze threshold performance for a symbol
 */
export async function analyzeThresholdPerformance(
  symbol: string,
  lookbackDays: number = 30
): Promise<ThresholdPerformance[]> {
  try {
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    
    // Get trade outcomes for this symbol
    const outcomes = await prisma.$queryRaw<TradeOutcome[]>`
      SELECT * FROM trade_outcomes
      WHERE symbol = ${symbol}
        AND entry_time >= ${since}
      ORDER BY entry_time DESC
      LIMIT 200
    `.catch(() => []);

    if (outcomes.length < 10) {
      return []; // Not enough data
    }

    // Group by threshold combinations (bucketed)
    const buckets = new Map<string, TradeOutcome[]>();

    outcomes.forEach(outcome => {
      const key = createThresholdKey(outcome.thresholds);
      if (!buckets.has(key)) {
        buckets.set(key, []);
      }
      buckets.get(key)!.push(outcome);
    });

    // Calculate performance for each bucket
    const performances: ThresholdPerformance[] = [];

    buckets.forEach((trades, key) => {
      if (trades.length < 5) return; // Skip small samples

      const wins = trades.filter(t => t.profitable).length;
      const winRate = wins / trades.length;
      
      const avgPnl = trades.reduce((sum, t) => sum + t.pnlPct, 0) / trades.length;
      const avgHoldTime = trades.reduce((sum, t) => sum + t.holdTimeMinutes, 0) / trades.length;

      const grossProfit = trades.filter(t => t.profitable).reduce((sum, t) => sum + Math.abs(t.pnlPct), 0);
      const grossLoss = trades.filter(t => !t.profitable).reduce((sum, t) => sum + Math.abs(t.pnlPct), 0);
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;

      // Simple Sharpe estimate
      const returns = trades.map(t => t.pnlPct);
      const mean = avgPnl;
      const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
      const stdDev = Math.sqrt(variance);
      const sharpeRatio = stdDev > 0 ? mean / stdDev : 0;

      performances.push({
        thresholdKey: key,
        sampleSize: trades.length,
        winRate,
        avgPnlPct: avgPnl,
        avgHoldTime,
        profitFactor,
        sharpeRatio,
        lastUpdated: Date.now(),
      });
    });

    return performances.sort((a, b) => b.sharpeRatio - a.sharpeRatio);
  } catch (error) {
    console.error('Failed to analyze threshold performance:', error);
    return [];
  }
}

/**
 * Create a threshold key for bucketing (rounded values)
 */
function createThresholdKey(thresholds: ThresholdSnapshot): string {
  return [
    `conf${Math.round(thresholds.confidence * 100)}`,
    `atr${Math.round(thresholds.atr * 100)}`,
    `adx${Math.round(thresholds.adx)}`,
    `elig${Math.round(thresholds.eligibility * 100)}`,
  ].join('_');
}

/**
 * Get recommended thresholds based on learning
 */
export async function getRecommendedThresholds(
  symbol: string,
  currentThresholds: ThresholdSnapshot,
  aggressiveness: 'conservative' | 'reactive' | 'aggressive'
): Promise<ThresholdSnapshot> {
  try {
    const performances = await analyzeThresholdPerformance(symbol);

    if (performances.length === 0) {
      // No data yet, return current thresholds
      return currentThresholds;
    }

    // Find best performing threshold set
    const best = performances[0];

    if (best.sampleSize < 10 || best.sharpeRatio < 0.5) {
      // Not confident in recommendation
      return currentThresholds;
    }

    // Parse the best threshold key back to values
    const parts = best.thresholdKey.split('_');
    const learned: ThresholdSnapshot = {
      confidence: parseInt(parts[0].replace('conf', '')) / 100,
      atr: parseInt(parts[1].replace('atr', '')) / 100,
      adx: parseInt(parts[2].replace('adx', '')),
      eligibility: parseInt(parts[3].replace('elig', '')) / 100,
      rrMin: currentThresholds.rrMin, // Keep current RR min
    };

    // Blend with current thresholds (gradual adaptation)
    const blendFactor = Math.min(0.3, best.sampleSize / 50); // Max 30% adjustment

    return {
      confidence: currentThresholds.confidence * (1 - blendFactor) + learned.confidence * blendFactor,
      atr: currentThresholds.atr * (1 - blendFactor) + learned.atr * blendFactor,
      adx: currentThresholds.adx * (1 - blendFactor) + learned.adx * blendFactor,
      eligibility: currentThresholds.eligibility * (1 - blendFactor) + learned.eligibility * blendFactor,
      rrMin: currentThresholds.rrMin,
    };
  } catch (error) {
    console.error('Failed to get recommended thresholds:', error);
    return currentThresholds;
  }
}

/**
 * Get adaptive learning state for a symbol
 */
export async function getAdaptiveLearningState(
  symbol: string,
  currentThresholds: ThresholdSnapshot,
  aggressiveness: 'conservative' | 'reactive' | 'aggressive' = 'reactive'
): Promise<AdaptiveLearningState> {
  const performances = await analyzeThresholdPerformance(symbol);
  const recommendedThresholds = await getRecommendedThresholds(symbol, currentThresholds, aggressiveness);

  const totalTrades = performances.reduce((sum, p) => sum + p.sampleSize, 0);
  const learningProgress = Math.min(1.0, totalTrades / 50); // Need 50 trades for full confidence

  return {
    symbol,
    aggressiveness,
    currentThresholds,
    recommendedThresholds,
    performance: performances.slice(0, 5), // Top 5
    learningProgress,
    lastOptimizedAt: Date.now(),
  };
}

/**
 * Create trade_outcomes table if it doesn't exist
 */
export async function initializeAdaptiveLearning(): Promise<void> {
  try {
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS trade_outcomes (
        trade_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        entry_time TIMESTAMP NOT NULL,
        exit_time TIMESTAMP NOT NULL,
        profitable BOOLEAN NOT NULL,
        pnl_pct DECIMAL(10, 4) NOT NULL,
        hold_time_minutes INTEGER NOT NULL,
        threshold_confidence DECIMAL(5, 4),
        threshold_atr DECIMAL(5, 4),
        threshold_adx DECIMAL(5, 2),
        threshold_eligibility DECIMAL(5, 4),
        threshold_rr_min DECIMAL(5, 2),
        regime TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS idx_trade_outcomes_symbol_time
      ON trade_outcomes (symbol, entry_time DESC)
    `;

    console.log('✅ Adaptive learning tables initialized');
  } catch (error) {
    console.warn('⚠️ Failed to initialize adaptive learning tables:', error);
  }
}
