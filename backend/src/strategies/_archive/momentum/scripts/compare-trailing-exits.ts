/**
 * Compare different trailing exit strategies via backtesting
 *
 * Goal: Find the optimal exit strategy that captures profits close to the
 * theoretical trailing stop level while filtering out noise/false signals.
 *
 * Exit strategies tested:
 * 1. THEORETICAL: Exit at trailing stop price (perfect, unrealistic)
 * 2. CLOSE_2C: Exit at candle close with 2-candle confirmation (current V5.61)
 * 3. CLOSE_1C: Exit at candle close with 1-candle confirmation
 * 4. EXTREME_2C: Exit at candle extreme (high for SHORT, low for LONG) with 2-candle
 * 5. EXTREME_1C: Exit at candle extreme with 1-candle confirmation
 * 6. IMMEDIATE: Exit immediately at trailing stop (no confirmation)
 * 7. NFS_ADAPTIVE: NFS-based adaptive exit (high=immediate, medium=1C, low=2C)
 */

import * as ccxt from 'ccxt';
import { createLogger } from '../src/utils/logger.js';

const logger = createLogger('trailing-comparison');

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Position {
  side: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  size: number;
  leverage: number;
  highWaterMark: number;
  lowWaterMark: number;
  trailingActive: boolean;
  trailingStopPrice: number | null;
  breachCandles: number;
  firstBreachCandle: Candle | null;
}

interface Trade {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  pnlPct: number;
  leverage: number;
  exitReason: string;
  trailingStopPrice: number | null;
  exitStrategy: string;
}

interface StrategyResult {
  name: string;
  trades: Trade[];
  totalTrades: number;
  winRate: number;
  avgPnlPct: number;
  totalPnlPct: number;
  maxDrawdown: number;
  sharpeRatio: number;
  avgGapFromTheoretical: number;
}

// Exit strategy types
type ExitStrategy =
  | 'THEORETICAL'      // Exit at trailing stop price
  | 'CLOSE_2C'         // Exit at close with 2-candle confirmation
  | 'CLOSE_1C'         // Exit at close with 1-candle confirmation
  | 'EXTREME_2C'       // Exit at candle extreme with 2-candle
  | 'EXTREME_1C'       // Exit at candle extreme with 1-candle
  | 'IMMEDIATE'        // Exit immediately at first breach
  | 'NFS_ADAPTIVE';    // NFS-based adaptive

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Entry conditions (simplified for testing)
  ROC_MIN: 0.3,
  ROC_MAX: 1.5,

  // Trailing stop settings
  TRAILING_ACTIVATION_PCT: 0.8,  // Activate at 0.8% profit
  TRAILING_DISTANCE_PCT: 0.8,    // 0.8% distance from HWM/LWM

  // Leverage
  LEVERAGE: 5,

  // NFS thresholds (for NFS_ADAPTIVE strategy)
  NFS_HIGH_THRESHOLD: 70,
  NFS_MEDIUM_THRESHOLD: 40,

  // Symbols and timeframe
  SYMBOLS: ['DOGE/USDT:USDT', 'SUI/USDT:USDT', 'SEI/USDT:USDT'],
  TIMEFRAME: '15m',
};

// ═══════════════════════════════════════════════════════════════════════════
// DATA FETCHING
// ═══════════════════════════════════════════════════════════════════════════

async function fetchHistoricalData(
  exchange: ccxt.binanceusdm,
  symbol: string,
  startDate: Date,
  endDate: Date
): Promise<Candle[]> {
  const candles: Candle[] = [];
  let since = startDate.getTime();
  const until = endDate.getTime();

  while (since < until) {
    const ohlcv = await exchange.fetchOHLCV(symbol, CONFIG.TIMEFRAME, since, 1000);
    if (!ohlcv || ohlcv.length === 0) break;

    for (const c of ohlcv) {
      if (c[0] >= until) break;
      candles.push({
        timestamp: c[0] as number,
        open: c[1] as number,
        high: c[2] as number,
        low: c[3] as number,
        close: c[4] as number,
        volume: c[5] as number,
      });
    }

    since = ohlcv[ohlcv.length - 1][0] as number + 1;
    await new Promise(resolve => setTimeout(resolve, 100)); // Rate limit
  }

  return candles;
}

// ═══════════════════════════════════════════════════════════════════════════
// NFS SCORE CALCULATION (Simplified)
// ═══════════════════════════════════════════════════════════════════════════

function calculateNfsScore(
  candle: Candle,
  prevCandles: Candle[],
  side: 'long' | 'short',
  trailingStopPrice: number
): number {
  // Calculate breach depth
  let breachDepthPct: number;
  if (side === 'long') {
    breachDepthPct = ((trailingStopPrice - candle.close) / trailingStopPrice) * 100;
  } else {
    breachDepthPct = ((candle.close - trailingStopPrice) / trailingStopPrice) * 100;
  }

  // Calculate ATR
  const atrPeriod = Math.min(14, prevCandles.length);
  let atrSum = 0;
  for (let i = prevCandles.length - atrPeriod; i < prevCandles.length; i++) {
    const c = prevCandles[i];
    const prevClose = i > 0 ? prevCandles[i - 1].close : c.open;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
    atrSum += tr;
  }
  const atr = atrSum / atrPeriod;
  const breachAtrRatio = Math.abs(breachDepthPct / 100 * trailingStopPrice) / atr;

  // Calculate volume ratio
  const avgVolume = prevCandles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
  const volumeRatio = candle.volume / avgVolume;

  // Calculate candle body ratio
  const bodySize = Math.abs(candle.close - candle.open);
  const candleRange = candle.high - candle.low;
  const bodyRatio = candleRange > 0 ? bodySize / candleRange : 0;

  // Calculate ROC5 momentum
  const roc5Close = prevCandles[prevCandles.length - 5]?.close ?? candle.open;
  const roc5 = ((candle.close - roc5Close) / roc5Close) * 100;
  const momentumAligned = side === 'long' ? roc5 <= -0.5 : roc5 >= 0.5;

  // Score calculation (simplified)
  let score = 0;

  // Breach/ATR (35 points)
  if (breachAtrRatio >= 0.4) score += 35;
  else if (breachAtrRatio >= 0.2) score += 17;

  // Breach depth (25 points)
  if (breachDepthPct >= 0.25) score += 25;
  else if (breachDepthPct >= 0.12) score += 12;

  // Volume (20 points)
  if (volumeRatio >= 1.5) score += 20;
  else if (volumeRatio >= 1.2) score += 10;

  // Body ratio (10 points)
  if (bodyRatio >= 0.5) score += 10;

  // Momentum (10 points)
  if (momentumAligned) score += 10;

  return score;
}

// ═══════════════════════════════════════════════════════════════════════════
// TRAILING EXIT SIMULATION
// ═══════════════════════════════════════════════════════════════════════════

function simulateTrailingExit(
  position: Position,
  candles: Candle[],
  startIdx: number,
  strategy: ExitStrategy
): { exitPrice: number; exitIdx: number; exitReason: string; theoreticalPrice: number } | null {
  const { side, entryPrice } = position;
  let hwm = position.highWaterMark;
  let lwm = position.lowWaterMark;
  let trailingActive = false;
  let trailingStopPrice = 0;
  let breachCount = 0;
  let firstBreachCandle: Candle | null = null;

  for (let i = startIdx; i < candles.length; i++) {
    const candle = candles[i];
    const prevCandles = candles.slice(Math.max(0, i - 20), i);

    // Update HWM/LWM
    if (side === 'long') {
      if (candle.high > hwm) hwm = candle.high;
    } else {
      if (candle.low < lwm) lwm = candle.low;
    }

    // Calculate PnL
    const pnlPct = side === 'long'
      ? ((candle.close - entryPrice) / entryPrice) * 100
      : ((entryPrice - candle.close) / entryPrice) * 100;

    // Activate trailing
    if (!trailingActive && pnlPct >= CONFIG.TRAILING_ACTIVATION_PCT) {
      trailingActive = true;
    }

    if (!trailingActive) continue;

    // Calculate trailing stop
    if (side === 'long') {
      trailingStopPrice = hwm * (1 - CONFIG.TRAILING_DISTANCE_PCT / 100);
    } else {
      trailingStopPrice = lwm * (1 + CONFIG.TRAILING_DISTANCE_PCT / 100);
    }

    // Check breach
    const isBreach = side === 'long'
      ? candle.close <= trailingStopPrice
      : candle.close >= trailingStopPrice;

    if (isBreach) {
      if (breachCount === 0) {
        firstBreachCandle = candle;
      }
      breachCount++;

      // Determine exit based on strategy
      const nfsScore = calculateNfsScore(candle, prevCandles, side, trailingStopPrice);

      switch (strategy) {
        case 'THEORETICAL':
          // Exit at trailing stop price (perfect)
          return {
            exitPrice: trailingStopPrice,
            exitIdx: i,
            exitReason: 'TRAIL_THEORETICAL',
            theoreticalPrice: trailingStopPrice,
          };

        case 'IMMEDIATE':
          // Exit at candle close on first breach
          return {
            exitPrice: candle.close,
            exitIdx: i,
            exitReason: 'TRAIL_IMMEDIATE',
            theoreticalPrice: trailingStopPrice,
          };

        case 'CLOSE_1C':
          // Exit at close on first breach (same as IMMEDIATE but different name)
          return {
            exitPrice: candle.close,
            exitIdx: i,
            exitReason: 'TRAIL_1C_CLOSE',
            theoreticalPrice: trailingStopPrice,
          };

        case 'EXTREME_1C':
          // Exit at candle extreme on first breach
          const extreme1c = side === 'long' ? candle.low : candle.high;
          return {
            exitPrice: extreme1c,
            exitIdx: i,
            exitReason: 'TRAIL_1C_EXTREME',
            theoreticalPrice: trailingStopPrice,
          };

        case 'CLOSE_2C':
          // Exit at close on second breach
          if (breachCount >= 2) {
            return {
              exitPrice: candle.close,
              exitIdx: i,
              exitReason: 'TRAIL_2C_CLOSE',
              theoreticalPrice: trailingStopPrice,
            };
          }
          break;

        case 'EXTREME_2C':
          // Exit at candle extreme on second breach
          if (breachCount >= 2) {
            const extreme2c = side === 'long' ? candle.low : candle.high;
            return {
              exitPrice: extreme2c,
              exitIdx: i,
              exitReason: 'TRAIL_2C_EXTREME',
              theoreticalPrice: trailingStopPrice,
            };
          }
          break;

        case 'NFS_ADAPTIVE':
          // Adaptive based on NFS score
          if (nfsScore >= CONFIG.NFS_HIGH_THRESHOLD) {
            // High confidence: exit at trailing stop price
            return {
              exitPrice: trailingStopPrice,
              exitIdx: i,
              exitReason: `TRAIL_NFS_HIGH_${nfsScore}`,
              theoreticalPrice: trailingStopPrice,
            };
          } else if (nfsScore >= CONFIG.NFS_MEDIUM_THRESHOLD) {
            // Medium confidence: exit at close on first breach
            return {
              exitPrice: candle.close,
              exitIdx: i,
              exitReason: `TRAIL_NFS_MED_${nfsScore}`,
              theoreticalPrice: trailingStopPrice,
            };
          } else {
            // Low confidence: wait for 2-candle confirmation
            if (breachCount >= 2) {
              return {
                exitPrice: candle.close,
                exitIdx: i,
                exitReason: `TRAIL_NFS_LOW_${nfsScore}`,
                theoreticalPrice: trailingStopPrice,
              };
            }
          }
          break;
      }
    } else {
      // Reset breach count if price recovers
      breachCount = 0;
      firstBreachCandle = null;
    }

    // Stop loss check (for safety - never hit in well-managed trades)
    const stopLossPct = -5;
    if (pnlPct <= stopLossPct) {
      return {
        exitPrice: candle.close,
        exitIdx: i,
        exitReason: 'STOP_LOSS',
        theoreticalPrice: trailingStopPrice,
      };
    }
  }

  // No exit found in data
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SIMPLIFIED ENTRY SIGNAL DETECTION
// ═══════════════════════════════════════════════════════════════════════════

function detectEntrySignal(
  candles: Candle[],
  idx: number
): { side: 'long' | 'short' } | null {
  if (idx < 10) return null;

  const current = candles[idx];
  const prev = candles[idx - 1];
  const roc = ((current.close - prev.close) / prev.close) * 100;

  // Simplified entry: strong directional move
  if (roc >= CONFIG.ROC_MIN && roc <= CONFIG.ROC_MAX) {
    return { side: 'short' }; // Against the move (mean reversion style)
  } else if (roc <= -CONFIG.ROC_MIN && roc >= -CONFIG.ROC_MAX) {
    return { side: 'long' };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKTEST RUNNER
// ═══════════════════════════════════════════════════════════════════════════

async function runBacktestForStrategy(
  candles: Candle[],
  symbol: string,
  strategy: ExitStrategy
): Promise<Trade[]> {
  const trades: Trade[] = [];
  let inPosition = false;
  let position: Position | null = null;

  for (let i = 20; i < candles.length; i++) {
    const candle = candles[i];

    if (!inPosition) {
      // Look for entry
      const entry = detectEntrySignal(candles, i);
      if (entry) {
        position = {
          side: entry.side,
          entryPrice: candle.close,
          entryTime: candle.timestamp,
          size: 1,
          leverage: CONFIG.LEVERAGE,
          highWaterMark: candle.close,
          lowWaterMark: candle.close,
          trailingActive: false,
          trailingStopPrice: null,
          breachCandles: 0,
          firstBreachCandle: null,
        };
        inPosition = true;

        // Simulate the trailing exit
        const exitResult = simulateTrailingExit(position, candles, i + 1, strategy);

        if (exitResult) {
          const exitCandle = candles[exitResult.exitIdx];
          const pnlPct = position.side === 'long'
            ? ((exitResult.exitPrice - position.entryPrice) / position.entryPrice) * 100 * CONFIG.LEVERAGE
            : ((position.entryPrice - exitResult.exitPrice) / position.entryPrice) * 100 * CONFIG.LEVERAGE;

          trades.push({
            symbol,
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice: exitResult.exitPrice,
            entryTime: position.entryTime,
            exitTime: exitCandle.timestamp,
            pnlPct,
            leverage: CONFIG.LEVERAGE,
            exitReason: exitResult.exitReason,
            trailingStopPrice: exitResult.theoreticalPrice,
            exitStrategy: strategy,
          });

          // Skip to after exit
          i = exitResult.exitIdx;
          inPosition = false;
          position = null;
        }
      }
    }
  }

  return trades;
}

// ═══════════════════════════════════════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════════════════════════════════════

function calculateStats(trades: Trade[], strategyName: string): StrategyResult {
  if (trades.length === 0) {
    return {
      name: strategyName,
      trades: [],
      totalTrades: 0,
      winRate: 0,
      avgPnlPct: 0,
      totalPnlPct: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      avgGapFromTheoretical: 0,
    };
  }

  const wins = trades.filter(t => t.pnlPct > 0);
  const winRate = (wins.length / trades.length) * 100;
  const avgPnlPct = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
  const totalPnlPct = trades.reduce((s, t) => s + t.pnlPct, 0);

  // Calculate max drawdown
  let peak = 0;
  let maxDD = 0;
  let cumPnl = 0;
  for (const t of trades) {
    cumPnl += t.pnlPct;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe ratio (simplified)
  const returns = trades.map(t => t.pnlPct);
  const mean = avgPnlPct;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? mean / stdDev * Math.sqrt(252 * 4) : 0; // Annualized for 15m

  // Average gap from theoretical
  const gaps = trades
    .filter(t => t.trailingStopPrice && t.exitReason.startsWith('TRAIL'))
    .map(t => {
      const theoreticalPnl = t.side === 'long'
        ? ((t.trailingStopPrice! - t.entryPrice) / t.entryPrice) * 100 * t.leverage
        : ((t.entryPrice - t.trailingStopPrice!) / t.entryPrice) * 100 * t.leverage;
      return theoreticalPnl - t.pnlPct;
    });
  const avgGap = gaps.length > 0 ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;

  return {
    name: strategyName,
    trades,
    totalTrades: trades.length,
    winRate,
    avgPnlPct,
    totalPnlPct,
    maxDrawdown: maxDD,
    sharpeRatio: sharpe,
    avgGapFromTheoretical: avgGap,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('='.repeat(100));
  console.log('TRAILING EXIT STRATEGY COMPARISON');
  console.log('='.repeat(100));

  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();

  const startDate = new Date('2025-10-01T00:00:00Z');
  const endDate = new Date('2026-01-01T00:00:00Z');

  console.log(`\nBacktest period: ${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}`);
  console.log(`Symbols: ${CONFIG.SYMBOLS.join(', ')}`);
  console.log(`Leverage: ${CONFIG.LEVERAGE}x`);
  console.log(`Trailing activation: ${CONFIG.TRAILING_ACTIVATION_PCT}%`);
  console.log(`Trailing distance: ${CONFIG.TRAILING_DISTANCE_PCT}%`);

  const strategies: ExitStrategy[] = [
    'THEORETICAL',
    'CLOSE_2C',
    'CLOSE_1C',
    'EXTREME_2C',
    'EXTREME_1C',
    'IMMEDIATE',
    'NFS_ADAPTIVE',
  ];

  const allResults: Map<ExitStrategy, StrategyResult> = new Map();

  for (const strategy of strategies) {
    const allTrades: Trade[] = [];

    for (const symbol of CONFIG.SYMBOLS) {
      console.log(`\n  Fetching ${symbol}...`);
      const candles = await fetchHistoricalData(exchange, symbol, startDate, endDate);
      console.log(`    ${candles.length} candles loaded`);

      const trades = await runBacktestForStrategy(candles, symbol, strategy);
      allTrades.push(...trades);
    }

    const stats = calculateStats(allTrades, strategy);
    allResults.set(strategy, stats);
  }

  // Print comparison table
  console.log('\n' + '='.repeat(100));
  console.log('RESULTS COMPARISON');
  console.log('='.repeat(100));

  console.log('\n' + '-'.repeat(120));
  console.log(
    'Strategy'.padEnd(15) +
    '| Trades'.padEnd(10) +
    '| Win %'.padEnd(10) +
    '| Avg PnL'.padEnd(12) +
    '| Total PnL'.padEnd(14) +
    '| Max DD'.padEnd(12) +
    '| Sharpe'.padEnd(10) +
    '| Gap from Theory'
  );
  console.log('-'.repeat(120));

  for (const strategy of strategies) {
    const r = allResults.get(strategy)!;
    console.log(
      strategy.padEnd(15) +
      `| ${r.totalTrades}`.padEnd(10) +
      `| ${r.winRate.toFixed(1)}%`.padEnd(10) +
      `| ${r.avgPnlPct >= 0 ? '+' : ''}${r.avgPnlPct.toFixed(2)}%`.padEnd(12) +
      `| ${r.totalPnlPct >= 0 ? '+' : ''}${r.totalPnlPct.toFixed(1)}%`.padEnd(14) +
      `| ${r.maxDrawdown.toFixed(1)}%`.padEnd(12) +
      `| ${r.sharpeRatio.toFixed(2)}`.padEnd(10) +
      `| ${r.avgGapFromTheoretical >= 0 ? '+' : ''}${r.avgGapFromTheoretical.toFixed(2)}%`
    );
  }
  console.log('-'.repeat(120));

  // Calculate improvements vs CLOSE_2C
  const baseline = allResults.get('CLOSE_2C')!;
  console.log('\n' + '='.repeat(100));
  console.log('IMPROVEMENT vs CLOSE_2C (current V5.61 approach)');
  console.log('='.repeat(100));

  for (const strategy of strategies) {
    if (strategy === 'CLOSE_2C') continue;
    const r = allResults.get(strategy)!;
    const pnlImprove = r.totalPnlPct - baseline.totalPnlPct;
    const wrImprove = r.winRate - baseline.winRate;
    const gapImprove = baseline.avgGapFromTheoretical - r.avgGapFromTheoretical;

    console.log(`\n${strategy}:`);
    console.log(`  Total PnL: ${pnlImprove >= 0 ? '+' : ''}${pnlImprove.toFixed(1)}% vs baseline`);
    console.log(`  Win Rate:  ${wrImprove >= 0 ? '+' : ''}${wrImprove.toFixed(1)}pp vs baseline`);
    console.log(`  Gap:       ${gapImprove >= 0 ? '-' : '+'}${Math.abs(gapImprove).toFixed(2)}% closer to theory`);
  }

  // Show sample trades with different exits
  console.log('\n' + '='.repeat(100));
  console.log('SAMPLE TRADE COMPARISON (First 5 TRAIL exits)');
  console.log('='.repeat(100));

  const theoreticalTrades = allResults.get('THEORETICAL')!.trades.filter(t => t.exitReason.startsWith('TRAIL')).slice(0, 5);

  for (let i = 0; i < theoreticalTrades.length; i++) {
    const baseTrade = theoreticalTrades[i];
    console.log(`\nTrade ${i + 1}: ${baseTrade.symbol} ${baseTrade.side.toUpperCase()}`);
    console.log(`  Entry: $${baseTrade.entryPrice.toFixed(4)} @ ${new Date(baseTrade.entryTime).toISOString().slice(0, 16)}`);
    console.log(`  Trailing Stop: $${baseTrade.trailingStopPrice?.toFixed(4)}`);

    for (const strategy of strategies) {
      const trades = allResults.get(strategy)!.trades.filter(t => t.exitReason.startsWith('TRAIL'));
      const matchingTrade = trades.find(t =>
        t.symbol === baseTrade.symbol &&
        Math.abs(t.entryTime - baseTrade.entryTime) < 900000 // Within 15 min
      );

      if (matchingTrade) {
        const gap = baseTrade.pnlPct - matchingTrade.pnlPct;
        console.log(`  ${strategy.padEnd(15)}: Exit $${matchingTrade.exitPrice.toFixed(4)} | PnL: ${matchingTrade.pnlPct >= 0 ? '+' : ''}${matchingTrade.pnlPct.toFixed(2)}% | Gap: ${gap >= 0 ? '+' : ''}${gap.toFixed(2)}%`);
      }
    }
  }

  // Recommendations
  console.log('\n' + '='.repeat(100));
  console.log('RECOMMENDATIONS');
  console.log('='.repeat(100));

  const bestStrategy = [...allResults.entries()]
    .filter(([s]) => s !== 'THEORETICAL')
    .sort((a, b) => b[1].totalPnlPct - a[1].totalPnlPct)[0];

  const closestToTheory = [...allResults.entries()]
    .filter(([s]) => s !== 'THEORETICAL')
    .sort((a, b) => Math.abs(a[1].avgGapFromTheoretical) - Math.abs(b[1].avgGapFromTheoretical))[0];

  console.log(`\n1. BEST OVERALL PnL: ${bestStrategy[0]}`);
  console.log(`   - Total PnL: ${bestStrategy[1].totalPnlPct.toFixed(1)}%`);
  console.log(`   - Win Rate: ${bestStrategy[1].winRate.toFixed(1)}%`);

  console.log(`\n2. CLOSEST TO THEORETICAL: ${closestToTheory[0]}`);
  console.log(`   - Gap from theory: ${closestToTheory[1].avgGapFromTheoretical.toFixed(2)}%`);
  console.log(`   - Total PnL: ${closestToTheory[1].totalPnlPct.toFixed(1)}%`);

  console.log(`\n3. NFS_ADAPTIVE ANALYSIS:`);
  const nfsResult = allResults.get('NFS_ADAPTIVE')!;
  const nfsTrades = nfsResult.trades.filter(t => t.exitReason.startsWith('TRAIL_NFS'));
  const highExits = nfsTrades.filter(t => t.exitReason.includes('HIGH'));
  const medExits = nfsTrades.filter(t => t.exitReason.includes('MED'));
  const lowExits = nfsTrades.filter(t => t.exitReason.includes('LOW'));

  console.log(`   - HIGH confidence exits: ${highExits.length} (${(highExits.length / nfsTrades.length * 100).toFixed(1)}%)`);
  console.log(`   - MEDIUM confidence exits: ${medExits.length} (${(medExits.length / nfsTrades.length * 100).toFixed(1)}%)`);
  console.log(`   - LOW confidence exits: ${lowExits.length} (${(lowExits.length / nfsTrades.length * 100).toFixed(1)}%)`);

  if (highExits.length > 0) {
    const highAvgPnl = highExits.reduce((s, t) => s + t.pnlPct, 0) / highExits.length;
    console.log(`   - HIGH exits avg PnL: ${highAvgPnl.toFixed(2)}%`);
  }
  if (medExits.length > 0) {
    const medAvgPnl = medExits.reduce((s, t) => s + t.pnlPct, 0) / medExits.length;
    console.log(`   - MEDIUM exits avg PnL: ${medAvgPnl.toFixed(2)}%`);
  }
  if (lowExits.length > 0) {
    const lowAvgPnl = lowExits.reduce((s, t) => s + t.pnlPct, 0) / lowExits.length;
    console.log(`   - LOW exits avg PnL: ${lowAvgPnl.toFixed(2)}%`);
  }
}

main().catch(console.error);
