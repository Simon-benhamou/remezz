/**
 * Upgrade and Test Optimized Strategies Script
 * 
 * This script:
 * 1. Finds all existing optimized strategies that are missing meta-adaptive thresholds
 * 2. Upgrades them to include all required thresholds using regime defaults
 * 3. Validates the format consistency between default and optimized strategies
 * 4. Performs backtesting to verify if the optimized strategies would have performed better
 */

import { prisma, Prisma } from '../src/db/client.js';
import { 
  getDefaultParamsByRegime, 
  type OptimalParams, 
  type RegimeAwareParams,
  DEFAULT_PARAMS,
} from '../src/learning/personalityProfile.js';
import { getSymbolEvaluations } from '../src/learning/tradeEvaluationLogger.js';
import type { InputMetrics, MarketOutcome } from '../src/learning/tradeEvaluationLogger.js';

type EvaluationData = {
  inputMetrics: InputMetrics;
  marketOutcome: MarketOutcome;
};

/**
 * Check if OptimalParams has all required meta-adaptive thresholds
 */
function hasCompleteThresholds(params: OptimalParams): boolean {
  const required = ['adx', 'trendStrength', 'minConfidence', 'atr', 'cmf', 'eligibility', 'rrMin', 'minAtrPct', 'maxAtrPct'];
  return required.every(key => key in params.thresholds && params.thresholds[key as keyof typeof params.thresholds] !== undefined);
}

/**
 * Upgrade OptimalParams to include all meta-adaptive thresholds
 */
function upgradeOptimalParams(params: OptimalParams, regimeName: string): OptimalParams {
  // Get regime-specific defaults for missing thresholds
  const regimeDefaults = getDefaultParamsByRegime(regimeName);
  
  return {
    weights: params.weights,
    thresholds: {
      // Preserve existing optimized thresholds
      adx: params.thresholds.adx,
      trendStrength: params.thresholds.trendStrength,
      minConfidence: params.thresholds.minConfidence,
      // Add missing meta-adaptive thresholds from regime defaults
      atr: params.thresholds.atr ?? regimeDefaults.thresholds.atr,
      cmf: params.thresholds.cmf ?? regimeDefaults.thresholds.cmf,
      eligibility: params.thresholds.eligibility ?? regimeDefaults.thresholds.eligibility,
      rrMin: params.thresholds.rrMin ?? regimeDefaults.thresholds.rrMin,
      minAtrPct: params.thresholds.minAtrPct ?? regimeDefaults.thresholds.minAtrPct,
      maxAtrPct: params.thresholds.maxAtrPct ?? regimeDefaults.thresholds.maxAtrPct,
    },
  };
}

/**
 * Upgrade RegimeAwareParams to include all meta-adaptive thresholds
 */
function upgradeRegimeAwareParams(params: RegimeAwareParams): RegimeAwareParams {
  const upgraded: RegimeAwareParams = {
    default: upgradeOptimalParams(params.default, 'default'),
  };
  
  // Upgrade each regime if present
  const regimes: Array<keyof RegimeAwareParams> = [
    'low_volatility', 'medium_volatility', 'high_volatility',
    'long_bias', 'short_bias',
    'low_volume', 'normal_volume', 'high_volume',
    'trending', 'ranging',
    'bull_market', 'bear_market', 'choppy_market',
  ];
  
  regimes.forEach(regime => {
    if (params[regime]) {
      upgraded[regime] = upgradeOptimalParams(params[regime] as OptimalParams, regime);
    }
  });
  
  return upgraded;
}

/**
 * Calculate confidence score using given parameters
 */
function calculateConfidence(metrics: InputMetrics, params: OptimalParams): number {
  const adx = metrics.adx ?? 0;
  const trendStrength = metrics.trendStrength ?? 0;
  const ema20 = metrics.ema20 ?? 0;
  const ema50 = metrics.ema50 ?? 0;
  const slope = metrics.slope ?? 0;
  const cmf = metrics.cmf ?? 0;

  const adxScore = Math.max(0, Math.min(1, (adx - 15) / 22));
  const strengthScore = Math.max(0, Math.min(1, (trendStrength - 0.2) / 0.8));
  
  const alignment = ema50 !== 0 ? Math.abs((ema20 - ema50) / ema50) : 0;
  const alignmentScore = Math.max(0, Math.min(1, alignment / 0.018));
  
  const slopeNorm = ema20 !== 0 ? Math.abs(slope / ema20) : 0;
  const slopeScore = Math.max(0, Math.min(1, slopeNorm * 220));
  
  const flowScore = Math.max(0, Math.min(1, (cmf + 0.2) / 0.6));

  const score =
    adxScore * params.weights.adx +
    strengthScore * params.weights.strength +
    alignmentScore * params.weights.alignment +
    slopeScore * params.weights.slope +
    flowScore * params.weights.flow;

  return Number(score.toFixed(4));
}

/**
 * Check if trade would pass filters with given parameters
 */
function wouldExecute(metrics: InputMetrics, params: OptimalParams): boolean {
  const adx = metrics.adx ?? 0;
  const trendStrength = metrics.trendStrength ?? 0;
  const confidence = calculateConfidence(metrics, params);

  return (
    adx >= params.thresholds.adx &&
    trendStrength >= params.thresholds.trendStrength &&
    confidence >= params.thresholds.minConfidence
  );
}

/**
 * Backtest parameters against historical evaluations
 */
function backtestParameters(
  evaluations: EvaluationData[],
  params: OptimalParams,
  label: string
): {
  totalTrades: number;
  avgPnl: number;
  stdDev: number;
  sharpe: number;
  winRate: number;
  totalPnl: number;
} {
  const trades: number[] = [];

  for (const evaluation of evaluations) {
    if (wouldExecute(evaluation.inputMetrics, params)) {
      const pnl = evaluation.marketOutcome.pnl_1h ?? 0;
      trades.push(pnl);
    }
  }

  if (trades.length === 0) {
    return {
      totalTrades: 0,
      avgPnl: 0,
      stdDev: 0,
      sharpe: 0,
      winRate: 0,
      totalPnl: 0,
    };
  }

  const avgPnl = trades.reduce((sum, pnl) => sum + pnl, 0) / trades.length;
  const variance = trades.reduce((sum, pnl) => sum + Math.pow(pnl - avgPnl, 2), 0) / trades.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? avgPnl / stdDev : 0;
  const wins = trades.filter(pnl => pnl > 0).length;
  const winRate = wins / trades.length;
  const totalPnl = trades.reduce((sum, pnl) => sum + pnl, 0);

  return {
    totalTrades: trades.length,
    avgPnl,
    stdDev,
    sharpe,
    winRate,
    totalPnl,
  };
}

async function main() {
  console.log('🔧 Upgrade and Test Optimized Strategies\n');

  try {
    // Step 1: Find all existing optimized strategies
    console.log('📊 Step 1: Finding existing optimized strategies...');
    const profiles = await prisma.cryptoPersonalityProfile.findMany({
      orderBy: { updatedAt: 'desc' },
    });

    console.log(`   Found ${profiles.length} personality profiles`);

    let incompleteCount = 0;
    let completeCount = 0;
    const symbolsToUpgrade: string[] = [];

    // Check which ones need upgrading
    for (const profile of profiles) {
      const params = profile.optimalParams as OptimalParams | RegimeAwareParams;
      
      if (params && typeof params === 'object' && 'default' in params) {
        // Regime-aware params
        const regimeParams = params as RegimeAwareParams;
        const hasAllComplete = Object.values(regimeParams).every(p => 
          p && typeof p === 'object' && hasCompleteThresholds(p as OptimalParams)
        );
        
        if (!hasAllComplete) {
          incompleteCount++;
          symbolsToUpgrade.push(profile.symbol);
        } else {
          completeCount++;
        }
      } else if (params && typeof params === 'object') {
        // Single OptimalParams
        if (!hasCompleteThresholds(params as OptimalParams)) {
          incompleteCount++;
          symbolsToUpgrade.push(profile.symbol);
        } else {
          completeCount++;
        }
      }
    }

    console.log(`   ✅ Complete: ${completeCount}`);
    console.log(`   ⚠️  Incomplete: ${incompleteCount}`);
    
    if (symbolsToUpgrade.length > 0) {
      console.log('\n   Symbols needing upgrade:');
      symbolsToUpgrade.forEach(symbol => console.log(`      - ${symbol}`));
    }

    // Step 2: Upgrade incomplete strategies
    if (symbolsToUpgrade.length > 0) {
      console.log('\n🔨 Step 2: Upgrading incomplete strategies...');
      
      for (const symbol of symbolsToUpgrade) {
        const profile = await prisma.cryptoPersonalityProfile.findUnique({
          where: { symbol },
        });

        if (!profile) continue;

        const params = profile.optimalParams as OptimalParams | RegimeAwareParams;
        let upgradedParams: OptimalParams | RegimeAwareParams;

        if (params && typeof params === 'object' && 'default' in params) {
          // Regime-aware params
          upgradedParams = upgradeRegimeAwareParams(params as RegimeAwareParams);
        } else if (params && typeof params === 'object') {
          // Single OptimalParams - upgrade to default regime
          upgradedParams = upgradeOptimalParams(params as OptimalParams, 'default');
        } else {
          console.log(`   ⚠️  Skipping ${symbol}: Invalid params format`);
          continue;
        }

        // Save upgraded params
        await prisma.cryptoPersonalityProfile.update({
          where: { symbol },
          data: {
            optimalParams: upgradedParams as any,
            updatedAt: new Date(),
          },
        });

        console.log(`   ✅ Upgraded ${symbol}`);
      }

      console.log(`\n   Upgraded ${symbolsToUpgrade.length} strategies`);
    } else {
      console.log('\n✅ Step 2: All strategies already have complete format');
    }

    // Step 3: Validate format consistency
    console.log('\n🔍 Step 3: Validating format consistency...');
    
    const validatedProfiles = await prisma.cryptoPersonalityProfile.findMany();
    let validationErrors = 0;

    for (const profile of validatedProfiles) {
      const params = profile.optimalParams as OptimalParams | RegimeAwareParams;
      
      if (params && typeof params === 'object' && 'default' in params) {
        const regimeParams = params as RegimeAwareParams;
        
        for (const [regimeName, regimeParam] of Object.entries(regimeParams)) {
          if (regimeParam && typeof regimeParam === 'object') {
            if (!hasCompleteThresholds(regimeParam as OptimalParams)) {
              console.log(`   ❌ ${profile.symbol}.${regimeName}: Missing thresholds`);
              validationErrors++;
            }
          }
        }
      } else if (params && typeof params === 'object') {
        if (!hasCompleteThresholds(params as OptimalParams)) {
          console.log(`   ❌ ${profile.symbol}: Missing thresholds`);
          validationErrors++;
        }
      }
    }

    if (validationErrors === 0) {
      console.log('   ✅ All strategies have complete format');
    } else {
      console.log(`   ⚠️  Found ${validationErrors} validation errors`);
    }

    // Step 4: Backtest performance comparison
    console.log('\n📈 Step 4: Backtesting performance comparison...');
    console.log('   Comparing optimized vs default parameters on historical data\n');

    const comparisonResults: Array<{
      symbol: string;
      defaultResults: ReturnType<typeof backtestParameters>;
      optimizedResults: ReturnType<typeof backtestParameters>;
      improvement: number;
    }> = [];

    // Test up to 5 symbols with sufficient data
    const testSymbols = validatedProfiles.slice(0, 5);

    for (const profile of testSymbols) {
      console.log(`   Testing ${profile.symbol}...`);
      
      // Get historical evaluations
      const evaluations = await getSymbolEvaluations(profile.symbol, 500);
      
      if (evaluations.length < 50) {
        console.log(`      ⚠️  Insufficient data (${evaluations.length} evaluations)\n`);
        continue;
      }

      const evaluationData: EvaluationData[] = evaluations
        .filter(e => e.marketOutcome && typeof e.marketOutcome === 'object')
        .map(e => ({
          inputMetrics: e.inputMetrics as InputMetrics,
          marketOutcome: e.marketOutcome as MarketOutcome,
        }));

      if (evaluationData.length < 50) {
        console.log(`      ⚠️  Insufficient complete data (${evaluationData.length} evaluations)\n`);
        continue;
      }

      // Backtest with default params
      const defaultResults = backtestParameters(evaluationData, DEFAULT_PARAMS, 'Default');
      
      // Backtest with optimized params (use default regime)
      const params = profile.optimalParams as OptimalParams | RegimeAwareParams;
      const optimizedParams = (params && typeof params === 'object' && 'default' in params)
        ? (params as RegimeAwareParams).default
        : (params as OptimalParams);
      
      const optimizedResults = backtestParameters(evaluationData, optimizedParams, 'Optimized');
      
      // Calculate improvement
      const improvement = optimizedResults.sharpe > 0 && defaultResults.sharpe > 0
        ? ((optimizedResults.sharpe - defaultResults.sharpe) / Math.abs(defaultResults.sharpe)) * 100
        : 0;

      comparisonResults.push({
        symbol: profile.symbol,
        defaultResults,
        optimizedResults,
        improvement,
      });

      // Display results
      console.log(`      Default Parameters:`);
      console.log(`         Trades: ${defaultResults.totalTrades}`);
      console.log(`         Win Rate: ${(defaultResults.winRate * 100).toFixed(1)}%`);
      console.log(`         Avg PnL: ${defaultResults.avgPnl.toFixed(4)}`);
      console.log(`         Sharpe: ${defaultResults.sharpe.toFixed(4)}`);
      console.log(`         Total PnL: ${defaultResults.totalPnl.toFixed(2)}`);
      
      console.log(`      Optimized Parameters:`);
      console.log(`         Trades: ${optimizedResults.totalTrades}`);
      console.log(`         Win Rate: ${(optimizedResults.winRate * 100).toFixed(1)}%`);
      console.log(`         Avg PnL: ${optimizedResults.avgPnl.toFixed(4)}`);
      console.log(`         Sharpe: ${optimizedResults.sharpe.toFixed(4)}`);
      console.log(`         Total PnL: ${optimizedResults.totalPnl.toFixed(2)}`);
      
      console.log(`      Improvement: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(1)}%\n`);
    }

    // Summary
    console.log('\n📊 Summary:\n');
    console.log(`   Total profiles: ${profiles.length}`);
    console.log(`   Upgraded: ${symbolsToUpgrade.length}`);
    console.log(`   Validation errors: ${validationErrors}`);
    console.log(`   Backtested symbols: ${comparisonResults.length}\n`);

    if (comparisonResults.length > 0) {
      const avgImprovement = comparisonResults.reduce((sum, r) => sum + r.improvement, 0) / comparisonResults.length;
      const improved = comparisonResults.filter(r => r.improvement > 0).length;
      
      console.log(`   Average Sharpe improvement: ${avgImprovement >= 0 ? '+' : ''}${avgImprovement.toFixed(1)}%`);
      console.log(`   Symbols with improvement: ${improved}/${comparisonResults.length}\n`);
      
      // Show best and worst performers
      const sorted = [...comparisonResults].sort((a, b) => b.improvement - a.improvement);
      
      if (sorted.length > 0) {
        console.log(`   Best performer: ${sorted[0].symbol} (+${sorted[0].improvement.toFixed(1)}%)`);
        console.log(`   Worst performer: ${sorted[sorted.length - 1].symbol} (${sorted[sorted.length - 1].improvement >= 0 ? '+' : ''}${sorted[sorted.length - 1].improvement.toFixed(1)}%)`);
      }
    }

    console.log('\n✅ Upgrade and test completed successfully!');

  } catch (error) {
    console.error('\n❌ Script failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
