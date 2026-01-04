/**
 * 🔬 Multi-Position Backtest Service
 *
 * Extension of backtestService.ts that supports multiple positions per symbol.
 * This allows testing the V5.30 multi-position scaling strategy.
 *
 * Key Differences from standard backtest:
 * - positions: Record<string, BacktestSimPosition[]> instead of BacktestSimPosition | null
 * - Opens multiple positions with staggered entries
 * - Manages each position independently with its own stops
 * - Aggregates results for comparison
 */

import { calculateMultiPositionAllocation, DEFAULT_MULTI_POSITION_CONFIG } from '../strategies/multiPositionScaling.js';
import { MomentumConfig } from '../strategies/momentumSimple.js';
import type { BacktestParams, BacktestTrade, BacktestResult } from './backtestService.js';

// Extend the standard backtest position to support multi-position
interface MultiPositionEntry {
  positionId: string;      // Unique ID for this position
  groupId: string;         // Group ID for related positions (same signal)
  entryIndex: number;      // Index within the group (0, 1, 2...)
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  qty: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  stopLossPct: number;
  stopLoss: number;
  appTrailingStop?: number;
  highWaterMark?: number;
  lowWaterMark?: number;
  trailingActive?: boolean;
  maxPnlPct?: number;
}

/**
 * Parameters for multi-position backtest
 */
export interface MultiPositionBacktestParams extends BacktestParams {
  enableMultiPosition: boolean;  // If false, use single position (for comparison)
  multiPositionConfig?: typeof DEFAULT_MULTI_POSITION_CONFIG;
}

/**
 * Results with multi-position metrics
 */
export interface MultiPositionBacktestResults extends BacktestResult {
  // Additional multi-position metrics
  totalPositionsOpened: number;
  avgPositionsPerSignal: number;
  multiPositionTrades: number;  // Trades that used multiple positions
  capitalEfficiency: number;    // Avg % of capital actually used
}

/**
 * Run a backtest with multi-position support
 *
 * This is a simplified version focused on demonstrating the multi-position benefits.
 * For production backtests, integrate multi-position logic into backtestService.ts.
 */
export async function runMultiPositionBacktest(
  params: MultiPositionBacktestParams
): Promise<MultiPositionBacktestResults> {
  const {
    initialCapital,
    symbols,
    leverage: defaultLeverage,
    enableMultiPosition,
    multiPositionConfig = DEFAULT_MULTI_POSITION_CONFIG,
  } = params;

  console.log('\n🚀 Starting Multi-Position Backtest...');
  console.log(`   Mode: ${enableMultiPosition ? 'MULTI-POSITION' : 'SINGLE-POSITION'}`);
  console.log(`   Symbols: ${symbols.join(', ')}`);
  console.log(`   Initial Capital: $${initialCapital.toLocaleString()}`);

  // State
  let capital = initialCapital;
  const positions: Record<string, MultiPositionEntry[]> = {};
  symbols.forEach(s => { positions[s] = []; });

  const trades: BacktestTrade[] = [];
  let totalPositionsOpened = 0;
  let multiPositionSignalsCount = 0;

  // For this demo, we'll simulate a few signals and show how multi-position works
  // In real backtest, this would iterate over candle data

  // Simulate signals for different capital levels and cryptos
  const testScenarios = [
    { symbol: 'SEI/USDT:USDT', price: 0.45, capital: initialCapital },
    { symbol: 'SOL/USDT:USDT', price: 120, capital: initialCapital },
    { symbol: 'BTC/USDT:USDT', price: 45000, capital: initialCapital },
  ];

  console.log('\n📊 Processing Signals...\n');

  for (const scenario of testScenarios) {
    const { symbol, price, capital: currentCapital } = scenario;

    // Calculate position sizing
    const positionSizePct = Math.min(
      MomentumConfig.RISK.POSITION_SIZE_PCT_BASE +
        (currentCapital / 5000) * MomentumConfig.RISK.POSITION_SIZE_PCT_BOOST_PER_5K,
      MomentumConfig.RISK.POSITION_SIZE_PCT_MAX
    );

    const symbolLeverage = MomentumConfig.LEVERAGE[symbol] || defaultLeverage;

    if (enableMultiPosition) {
      // Multi-position allocation
      const allocation = calculateMultiPositionAllocation(
        symbol,
        currentCapital,
        price,
        positionSizePct,
        symbolLeverage,
        multiPositionConfig
      );

      console.log(`${symbol}:`);
      console.log(`   Capital: $${currentCapital.toLocaleString()}`);
      console.log(`   Positions: ${allocation.totalPositions}x`);
      console.log(`   Size per position: $${allocation.positionSizeUsd.toLocaleString()}`);
      console.log(`   Total notional: $${allocation.totalNotionalUsd.toLocaleString()}`);
      console.log(`   Efficiency: ${(allocation.efficiency * 100).toFixed(1)}%`);

      if (allocation.totalPositions > 1) {
        multiPositionSignalsCount++;
      }

      totalPositionsOpened += allocation.totalPositions;

      // Create position entries
      const groupId = `group_${Date.now()}_${symbol}`;
      for (let i = 0; i < allocation.totalPositions; i++) {
        const entryPrice = allocation.entryPrices[i];
        const positionEntry: MultiPositionEntry = {
          positionId: `${groupId}_${i}`,
          groupId,
          entryIndex: i,
          symbol,
          side: 'long',
          entryPrice,
          entryTime: Date.now(),
          qty: allocation.positionSizeUsd / entryPrice,
          notionalUsd: allocation.positionSizeUsd,
          marginUsd: allocation.marginPerPositionUsd,
          leverage: symbolLeverage,
          stopLossPct: MomentumConfig.EXIT.STOP_LOSS_PCT,
          stopLoss: entryPrice * (1 - MomentumConfig.EXIT.STOP_LOSS_PCT / 100),
          maxPnlPct: 0,
        };

        positions[symbol].push(positionEntry);
      }

      console.log(`   Entry prices: ${allocation.entryPrices.map(p => p.toFixed(4)).join(', ')}\n`);
    } else {
      // Single position (old behavior)
      const targetMargin = currentCapital * positionSizePct;
      const targetNotional = targetMargin * symbolLeverage;

      // Apply liquidity cap (simplified - not checking actual tier here)
      const notional = targetNotional; // In real backtest, would check caps

      console.log(`${symbol}:`);
      console.log(`   Capital: $${currentCapital.toLocaleString()}`);
      console.log(`   Positions: 1x`);
      console.log(`   Notional: $${notional.toLocaleString()}`);
      console.log(`   Margin: $${targetMargin.toLocaleString()}\n`);

      totalPositionsOpened += 1;

      const groupId = `group_${Date.now()}_${symbol}`;
      const positionEntry: MultiPositionEntry = {
        positionId: `${groupId}_0`,
        groupId,
        entryIndex: 0,
        symbol,
        side: 'long',
        entryPrice: price,
        entryTime: Date.now(),
        qty: notional / price,
        notionalUsd: notional,
        marginUsd: targetMargin,
        leverage: symbolLeverage,
        stopLossPct: MomentumConfig.EXIT.STOP_LOSS_PCT,
        stopLoss: price * (1 - MomentumConfig.EXIT.STOP_LOSS_PCT / 100),
        maxPnlPct: 0,
      };

      positions[symbol].push(positionEntry);
    }
  }

  // Calculate metrics
  const avgPositionsPerSignal = totalPositionsOpened / testScenarios.length;

  // For demo purposes, return simplified results matching BacktestResult interface
  const results: MultiPositionBacktestResults = {
    params: params as BacktestParams,
    summary: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnlUsd: 0,
      totalPnlPct: 0,
      maxDrawdownPct: 0,
      avgTradeUsd: 0,
      avgWinUsd: 0,
      avgLossUsd: 0,
      profitFactor: 0,
      sharpeRatio: 0,
      finalCapital: capital,
      longTrades: 0,
      shortTrades: 0,
      avgHoldMinutes: 0,
      totalFeesUsd: 0,
    },
    trades,
    monthlyStats: [],
    equityCurve: [],
    drawdownCurve: [],
    // Multi-position specific
    totalPositionsOpened,
    avgPositionsPerSignal,
    multiPositionTrades: multiPositionSignalsCount,
    capitalEfficiency: 0, // Would calculate from actual position data
  };

  console.log('\n✅ Backtest Complete!\n');
  console.log(`Total Positions Opened: ${totalPositionsOpened}`);
  console.log(`Avg Positions Per Signal: ${avgPositionsPerSignal.toFixed(2)}`);
  console.log(`Multi-Position Signals: ${multiPositionSignalsCount}\n`);

  return results;
}

/**
 * Compare single-position vs multi-position backtests
 */
export async function compareBacktests(
  params: Omit<MultiPositionBacktestParams, 'enableMultiPosition'>
): Promise<{
  singlePosition: MultiPositionBacktestResults;
  multiPosition: MultiPositionBacktestResults;
  improvement: {
    positionsPerSignal: number;
    capitalEfficiency: number;
  };
}> {
  console.log('\n' + '='.repeat(80));
  console.log('BACKTEST COMPARISON: Single-Position vs Multi-Position');
  console.log('='.repeat(80));

  // Run single-position backtest
  console.log('\n📊 Running SINGLE-POSITION backtest...');
  const singlePosition = await runMultiPositionBacktest({
    ...params,
    enableMultiPosition: false,
  });

  // Run multi-position backtest
  console.log('\n📊 Running MULTI-POSITION backtest...');
  const multiPosition = await runMultiPositionBacktest({
    ...params,
    enableMultiPosition: true,
  });

  // Calculate improvements
  const improvement = {
    positionsPerSignal:
      ((multiPosition.avgPositionsPerSignal / singlePosition.avgPositionsPerSignal) - 1) * 100,
    capitalEfficiency:
      (multiPosition.capitalEfficiency - singlePosition.capitalEfficiency) * 100,
  };

  console.log('\n' + '='.repeat(80));
  console.log('COMPARISON RESULTS');
  console.log('='.repeat(80));
  console.log(`\nSingle-Position:`);
  console.log(`   Avg Positions Per Signal: ${singlePosition.avgPositionsPerSignal.toFixed(2)}`);
  console.log(`\nMulti-Position:`);
  console.log(`   Avg Positions Per Signal: ${multiPosition.avgPositionsPerSignal.toFixed(2)}`);
  console.log(`   Multi-Position Signals: ${multiPosition.multiPositionTrades}`);
  console.log(`\nImprovement:`);
  console.log(`   Positions Per Signal: +${improvement.positionsPerSignal.toFixed(1)}%`);
  console.log('\n' + '='.repeat(80) + '\n');

  return {
    singlePosition,
    multiPosition,
    improvement,
  };
}
