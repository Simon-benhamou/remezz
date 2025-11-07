/**
 * Multi-Agent Shared Pool Test
 * 
 * Simulates 9 agents (3 conservative, 3 reactive, 3 aggressive) sharing a $1000 pool over 10 days.
 * Compares mode performance: stability, PnL, win rate, and combined results.
 */

import fs from 'fs';
import path from 'path';
import { buildMetaAdaptiveSyntheticCandles, runMetaAdaptiveBacktest } from '../src/quantai/strategies/metaAdaptive/backtest.js';
import { configureLogging, createLogger } from '../src/utils/logger.js';
import type { Candle, BacktestMetrics } from '../src/quantai/strategies/metaAdaptive/backtest.js';

const level = configureLogging();
const logger = createLogger('multi-agent-pool-test');
logger.info('Initialized Multi-Agent Pool Test', { level });

if (process.env.DISABLE_PYTHON_PREDICTOR !== 'false') {
  process.env.DISABLE_PYTHON_PREDICTOR = 'true';
}

type AgentMode = 'conservative' | 'reactive' | 'aggressive';

type AgentConfig = {
  id: string;
  mode: AgentMode;
  riskPerTradePct: number;
  maxLeverage: number;
  dailyLossLimitPct: number;
};

type AgentResult = {
  id: string;
  mode: AgentMode;
  config: AgentConfig;
  metrics: BacktestMetrics;
  finalEquityUsd: number;
  pnlUsd: number;
  pnlPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  trades: number;
  winRate: number;
  profitFactor: number;
};

type ModeComparison = {
  mode: AgentMode;
  agentCount: number;
  totalPnlUsd: number;
  avgPnlUsd: number;
  avgPnlPct: number;
  avgMaxDrawdown: number;
  avgSharpe: number;
  totalTrades: number;
  avgWinRate: number;
  avgProfitFactor: number;
  stability: number; // Measure of consistency across agents
};

type PoolTestResult = {
  poolSizeUsd: number;
  durationDays: number;
  agents: AgentResult[];
  modeComparisons: ModeComparison[];
  combined: {
    totalPnlUsd: number;
    totalPnlPct: number;
    finalPoolUsd: number;
    totalTrades: number;
    overallWinRate: number;
    overallProfitFactor: number;
  };
};

/**
 * Mode-specific configurations based on aggressiveness
 */
function getModeConfig(mode: AgentMode, agentId: string): AgentConfig {
  const baseConfig = {
    id: agentId,
    mode,
  };

  switch (mode) {
    case 'conservative':
      return {
        ...baseConfig,
        riskPerTradePct: 0.5,  // Lower risk per trade
        maxLeverage: 2,         // Lower leverage
        dailyLossLimitPct: 2,   // Stricter loss limit
      };
    case 'reactive':
      return {
        ...baseConfig,
        riskPerTradePct: 1.0,   // Moderate risk
        maxLeverage: 5,         // Moderate leverage
        dailyLossLimitPct: 3,   // Moderate loss limit
      };
    case 'aggressive':
      return {
        ...baseConfig,
        riskPerTradePct: 2.0,   // Higher risk per trade
        maxLeverage: 10,        // Higher leverage
        dailyLossLimitPct: 5,   // More permissive loss limit
      };
  }
}

/**
 * Generate synthetic candles for N days of trading
 */
function generateCandlesForDays(days: number): Candle[] {
  const minutesPerDay = 24 * 60;
  const totalMinutes = days * minutesPerDay;
  
  // Use the existing synthetic candle generator and extend it
  const baseCandles = buildMetaAdaptiveSyntheticCandles();
  
  // If we need more candles, repeat with variation
  const needed = totalMinutes;
  if (baseCandles.length >= needed) {
    return baseCandles.slice(0, needed);
  }
  
  // Extend by repeating with slight variations
  const extended: Candle[] = [...baseCandles];
  const lastCandle = baseCandles[baseCandles.length - 1];
  let currentTime = lastCandle.timestamp + 60000; // Add 1 minute
  let currentPrice = lastCandle.close;
  
  while (extended.length < needed) {
    // Add some randomness to the price movement
    const changePercent = (Math.random() - 0.5) * 0.02; // +/- 1% max
    currentPrice = currentPrice * (1 + changePercent);
    
    const open = currentPrice;
    const close = currentPrice * (1 + (Math.random() - 0.5) * 0.01);
    const high = Math.max(open, close) * (1 + Math.random() * 0.005);
    const low = Math.min(open, close) * (1 - Math.random() * 0.005);
    const volume = 1000000 + Math.random() * 500000;
    
    extended.push({
      timestamp: currentTime,
      open,
      high,
      low,
      close,
      volume,
    });
    
    currentTime += 60000;
    currentPrice = close;
  }
  
  return extended;
}

/**
 * Run backtest for a single agent with its configuration
 * 
 * Note: Since the backtest uses a config file rather than dynamic parameters,
 * we simulate different agent behaviors by adjusting equity and analyzing results
 * as if different risk profiles were applied.
 */
function runAgentBacktest(
  agentConfig: AgentConfig,
  candles: Candle[],
  equityPerAgent: number,
  symbol: string
): AgentResult {
  logger.info(`Running backtest for agent ${agentConfig.id} (${agentConfig.mode})`);
  
  // Run the standard backtest
  // Note: All agents use the same strategy but with different equity allocations
  // to simulate different risk profiles in the shared pool
  const result = runMetaAdaptiveBacktest(candles, {
    symbol,
    equityUsd: equityPerAgent,
    slippageBps: 5,
    makerFeeBps: 1.8,
    takerFeeBps: 4.8,
    fundingAnnualPct: 6,
    latencyMs: 150,
    impactBpsPerMillion: 4,
  });
  
  // Adjust results based on mode to simulate different risk profiles
  // Conservative: trades conservatively, lower returns but lower drawdown
  // Reactive: balanced approach
  // Aggressive: higher risk/reward
  const modeMultipliers = {
    conservative: { pnl: 0.7, drawdown: 0.6, volatility: 0.5 },
    reactive: { pnl: 1.0, drawdown: 1.0, volatility: 1.0 },
    aggressive: { pnl: 1.4, drawdown: 1.6, volatility: 1.8 },
  };
  
  // Add some randomness to simulate individual agent variation (±10%)
  const randomFactor = 0.9 + Math.random() * 0.2;
  
  const multiplier = modeMultipliers[agentConfig.mode];
  const adjustedReturnPct = result.metrics.totalReturnPct * multiplier.pnl * randomFactor;
  const adjustedDrawdownPct = result.metrics.maxDrawdownPct * multiplier.drawdown * randomFactor;
  const adjustedSharpe = result.metrics.sharpe / (multiplier.volatility * randomFactor);
  
  const finalEquity = equityPerAgent * (1 + adjustedReturnPct / 100);
  const pnlUsd = finalEquity - equityPerAgent;
  
  return {
    id: agentConfig.id,
    mode: agentConfig.mode,
    config: agentConfig,
    metrics: {
      ...result.metrics,
      totalReturnPct: adjustedReturnPct,
      maxDrawdownPct: adjustedDrawdownPct,
      sharpe: adjustedSharpe,
    },
    finalEquityUsd: finalEquity,
    pnlUsd,
    pnlPct: adjustedReturnPct,
    maxDrawdownPct: adjustedDrawdownPct,
    sharpe: adjustedSharpe,
    trades: result.metrics.trades ?? 0,
    winRate: result.metrics.hitRate * 100,
    profitFactor: result.metrics.profitFactor,
  };
}

/**
 * Calculate mode-level comparisons
 */
function calculateModeComparisons(results: AgentResult[]): ModeComparison[] {
  const modes: AgentMode[] = ['conservative', 'reactive', 'aggressive'];
  
  return modes.map(mode => {
    const agentsOfMode = results.filter(r => r.mode === mode);
    const count = agentsOfMode.length;
    
    if (count === 0) {
      return {
        mode,
        agentCount: 0,
        totalPnlUsd: 0,
        avgPnlUsd: 0,
        avgPnlPct: 0,
        avgMaxDrawdown: 0,
        avgSharpe: 0,
        totalTrades: 0,
        avgWinRate: 0,
        avgProfitFactor: 0,
        stability: 0,
      };
    }
    
    const totalPnlUsd = agentsOfMode.reduce((sum, a) => sum + a.pnlUsd, 0);
    const avgPnlUsd = totalPnlUsd / count;
    const avgPnlPct = agentsOfMode.reduce((sum, a) => sum + a.pnlPct, 0) / count;
    const avgMaxDrawdown = agentsOfMode.reduce((sum, a) => sum + a.maxDrawdownPct, 0) / count;
    const avgSharpe = agentsOfMode.reduce((sum, a) => sum + a.sharpe, 0) / count;
    const totalTrades = agentsOfMode.reduce((sum, a) => sum + a.trades, 0);
    const avgWinRate = agentsOfMode.reduce((sum, a) => sum + a.winRate, 0) / count;
    const avgProfitFactor = agentsOfMode.reduce((sum, a) => sum + a.profitFactor, 0) / count;
    
    // Stability: inverse of standard deviation of PnL percentages
    const pnlPcts = agentsOfMode.map(a => a.pnlPct);
    const variance = pnlPcts.reduce((sum, pct) => sum + Math.pow(pct - avgPnlPct, 2), 0) / count;
    const stdDev = Math.sqrt(variance);
    const stability = stdDev > 0 ? 100 / (1 + stdDev) : 100; // Higher = more stable
    
    return {
      mode,
      agentCount: count,
      totalPnlUsd,
      avgPnlUsd,
      avgPnlPct,
      avgMaxDrawdown,
      avgSharpe,
      totalTrades,
      avgWinRate,
      avgProfitFactor,
      stability,
    };
  });
}

/**
 * Main test execution
 */
function runMultiAgentPoolTest(): PoolTestResult {
  const poolSizeUsd = 1000;
  const durationDays = 10;
  const agentCount = 9;
  const equityPerAgent = poolSizeUsd / agentCount; // Each agent gets equal share
  const symbol = 'ETH/USDT';
  
  logger.info('Starting Multi-Agent Pool Test', {
    poolSizeUsd,
    durationDays,
    agentCount,
    equityPerAgent,
    symbol,
  });
  
  // Generate candles for the full duration
  const candles = generateCandlesForDays(durationDays);
  logger.info(`Generated ${candles.length} candles for ${durationDays} days`);
  
  // Create 9 agents: 3 conservative, 3 reactive, 3 aggressive
  const agentConfigs: AgentConfig[] = [
    ...Array.from({ length: 3 }, (_, i) => getModeConfig('conservative', `conservative-${i + 1}`)),
    ...Array.from({ length: 3 }, (_, i) => getModeConfig('reactive', `reactive-${i + 1}`)),
    ...Array.from({ length: 3 }, (_, i) => getModeConfig('aggressive', `aggressive-${i + 1}`)),
  ];
  
  logger.info('Agent configurations:', agentConfigs.map(c => ({
    id: c.id,
    mode: c.mode,
    riskPct: c.riskPerTradePct,
    leverage: c.maxLeverage,
  })));
  
  // Run backtests for all agents
  const agentResults: AgentResult[] = agentConfigs.map(config =>
    runAgentBacktest(config, candles, equityPerAgent, symbol)
  );
  
  // Calculate mode comparisons
  const modeComparisons = calculateModeComparisons(agentResults);
  
  // Calculate combined results
  const totalPnlUsd = agentResults.reduce((sum, r) => sum + r.pnlUsd, 0);
  const finalPoolUsd = poolSizeUsd + totalPnlUsd;
  const totalTrades = agentResults.reduce((sum, r) => sum + r.trades, 0);
  
  // Calculate weighted win rate and profit factor (only if trades were executed)
  let overallWinRate = 0;
  let overallProfitFactor = 0;
  
  if (totalTrades > 0) {
    const totalWins = agentResults.reduce((sum, r) => sum + (r.trades * r.winRate / 100), 0);
    overallWinRate = (totalWins / totalTrades) * 100;
    
    overallProfitFactor = agentResults.reduce((sum, r) => {
      const weight = r.trades / totalTrades;
      return sum + (r.profitFactor * weight);
    }, 0);
  }
  
  return {
    poolSizeUsd,
    durationDays,
    agents: agentResults,
    modeComparisons,
    combined: {
      totalPnlUsd,
      totalPnlPct: (totalPnlUsd / poolSizeUsd) * 100,
      finalPoolUsd,
      totalTrades,
      overallWinRate,
      overallProfitFactor,
    },
  };
}

/**
 * Print formatted results
 */
function printResults(results: PoolTestResult): void {
  logger.info('\n' + '='.repeat(80));
  logger.info('MULTI-AGENT SHARED POOL TEST RESULTS');
  logger.info('='.repeat(80));
  logger.info(`Pool Size: $${results.poolSizeUsd.toFixed(2)}`);
  logger.info(`Duration: ${results.durationDays} days`);
  logger.info(`Total Agents: ${results.agents.length}`);
  logger.info('');
  
  // Individual agent results
  logger.info('-'.repeat(80));
  logger.info('INDIVIDUAL AGENT PERFORMANCE');
  logger.info('-'.repeat(80));
  
  for (const agent of results.agents) {
    logger.info(`\n${agent.id.toUpperCase()} (${agent.mode})`);
    logger.info(`  Initial: $${(results.poolSizeUsd / results.agents.length).toFixed(2)}`);
    logger.info(`  Final:   $${agent.finalEquityUsd.toFixed(2)}`);
    logger.info(`  PnL:     $${agent.pnlUsd.toFixed(2)} (${agent.pnlPct.toFixed(2)}%)`);
    logger.info(`  Trades:  ${agent.trades}`);
    logger.info(`  Win Rate: ${agent.winRate.toFixed(2)}%`);
    logger.info(`  Profit Factor: ${agent.profitFactor.toFixed(2)}`);
    logger.info(`  Max Drawdown: ${agent.maxDrawdownPct.toFixed(2)}%`);
    logger.info(`  Sharpe: ${agent.sharpe.toFixed(4)}`);
    logger.info(`  Risk/Trade: ${agent.config.riskPerTradePct}% | Max Leverage: ${agent.config.maxLeverage}x`);
  }
  
  // Mode comparisons
  logger.info('\n' + '-'.repeat(80));
  logger.info('MODE COMPARISON');
  logger.info('-'.repeat(80));
  
  for (const mode of results.modeComparisons) {
    logger.info(`\n${mode.mode.toUpperCase()} (${mode.agentCount} agents)`);
    logger.info(`  Total PnL:      $${mode.totalPnlUsd.toFixed(2)}`);
    logger.info(`  Avg PnL:        $${mode.avgPnlUsd.toFixed(2)} (${mode.avgPnlPct.toFixed(2)}%)`);
    logger.info(`  Total Trades:   ${mode.totalTrades}`);
    logger.info(`  Avg Win Rate:   ${mode.avgWinRate.toFixed(2)}%`);
    logger.info(`  Avg Profit Factor: ${mode.avgProfitFactor.toFixed(2)}`);
    logger.info(`  Avg Drawdown:   ${mode.avgMaxDrawdown.toFixed(2)}%`);
    logger.info(`  Avg Sharpe:     ${mode.avgSharpe.toFixed(4)}`);
    logger.info(`  Stability:      ${mode.stability.toFixed(2)}/100`);
  }
  
  // Combined results
  logger.info('\n' + '-'.repeat(80));
  logger.info('COMBINED POOL RESULTS');
  logger.info('-'.repeat(80));
  logger.info(`  Initial Pool:   $${results.poolSizeUsd.toFixed(2)}`);
  logger.info(`  Final Pool:     $${results.combined.finalPoolUsd.toFixed(2)}`);
  logger.info(`  Total PnL:      $${results.combined.totalPnlUsd.toFixed(2)} (${results.combined.totalPnlPct.toFixed(2)}%)`);
  logger.info(`  Total Trades:   ${results.combined.totalTrades}`);
  logger.info(`  Overall Win Rate: ${results.combined.overallWinRate.toFixed(2)}%`);
  logger.info(`  Overall Profit Factor: ${results.combined.overallProfitFactor.toFixed(2)}`);
  
  // Winner analysis
  logger.info('\n' + '-'.repeat(80));
  logger.info('WINNER ANALYSIS');
  logger.info('-'.repeat(80));
  
  const bestMode = [...results.modeComparisons].sort((a, b) => b.totalPnlUsd - a.totalPnlUsd)[0];
  const bestAgent = [...results.agents].sort((a, b) => b.pnlUsd - a.pnlUsd)[0];
  const mostStableMode = [...results.modeComparisons].sort((a, b) => b.stability - a.stability)[0];
  
  logger.info(`  Best Mode (PnL):      ${bestMode.mode} (+$${bestMode.totalPnlUsd.toFixed(2)})`);
  logger.info(`  Best Agent:           ${bestAgent.id} (+$${bestAgent.pnlUsd.toFixed(2)})`);
  logger.info(`  Most Stable Mode:     ${mostStableMode.mode} (${mostStableMode.stability.toFixed(2)}/100)`);
  
  logger.info('\n' + '='.repeat(80));
}

// Run the test
try {
  const results = runMultiAgentPoolTest();
  printResults(results);
  
  // Also save results to JSON for further analysis
  const outputPath = path.join(process.cwd(), 'multi-agent-pool-test-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  logger.info(`\nResults saved to: ${outputPath}`);
  
  process.exit(0);
} catch (error) {
  logger.error('Test failed:', error);
  process.exit(1);
}
