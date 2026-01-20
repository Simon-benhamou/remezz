/**
 * REALISTIC WICK BREAKOUT TEST
 *
 * Tests if entering on wick breakout (intrabar) improves entry price
 * compared to waiting for candle close.
 *
 * APPROACH:
 * - Uses REAL checkMomentumSignal to find valid signals
 * - For LONG: Check if high > BB_upper × 1.005 (could have entered earlier)
 * - For SHORT: Check if low < BB_lower × 0.995 (could have entered earlier)
 * - Compare PnL with entry at close vs entry at BB × buffer
 *
 * CONSTRAINTS:
 * - Only applies to candles that ALREADY have valid signals
 * - Candle must still be bullish (LONG) or bearish (SHORT) - we're not changing signal logic
 * - We're just asking: "could we have entered earlier at a better price?"
 */

import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';

import {
  MomentumConfig,
  checkMomentumSignal,
  calcBollingerBands,
} from '../src/strategies/momentumSimple.js';

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  // Test period (2025 - 12 months)
  START_DATE: new Date('2025-01-01T00:00:00Z'),
  END_DATE: new Date('2026-01-01T00:00:00Z'),

  // All symbols from the trading list
  SYMBOLS: [
    'BTC/USDT:USDT',
    'ETH/USDT:USDT',
    'SOL/USDT:USDT',
    'XRP/USDT:USDT',
    'DOGE/USDT:USDT',
    'ADA/USDT:USDT',
    'AVAX/USDT:USDT',
    'LINK/USDT:USDT',
    'DOT/USDT:USDT',
    'SUI/USDT:USDT',
    'SEI/USDT:USDT',
    'APT/USDT:USDT',
    'IMX/USDT:USDT',
  ],

  // Wick breakout thresholds
  WICK: {
    // LONG: How much above BB_upper must high be to qualify for early entry?
    LONG_BB_BUFFER: 0.005,    // high > BB_upper × 1.005
    // SHORT: How much below BB_lower must low be to qualify for early entry?
    SHORT_BB_BUFFER: 0.005,   // low < BB_lower × 0.995

    // Early entry price simulation
    LONG_ENTRY_BUFFER: 0.003,   // Entry at BB_upper × 1.003
    SHORT_ENTRY_BUFFER: 0.003,  // Entry at BB_lower × 0.997
  },

  // Exit simulation (from MomentumConfig)
  EXIT: {
    TRAILING_ACTIVATION_PCT: MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT,
    TRAILING_DISTANCE_PCT: MomentumConfig.EXIT.TRAILING_DISTANCE_PCT,
    STOP_LOSS_PCT: MomentumConfig.EXIT.STOP_LOSS_PCT,
    PROFIT_TARGET_PCT: MomentumConfig.EXIT.PROFIT_TARGET_PCT,
    MAX_HOLD_BARS: 192,
  },
};

// ============================================================================
// TYPES
// ============================================================================

interface TradeResult {
  symbol: string;
  side: 'long' | 'short';
  entryTime: string;

  // Classic entry (at candle close)
  classicEntryPrice: number;
  classicExitPrice: number;
  classicPnlPct: number;
  classicExitReason: string;

  // Early entry (at wick breakout)
  earlyEntryPossible: boolean;
  earlyEntryPrice: number | null;
  earlyExitPrice: number | null;
  earlyPnlPct: number | null;

  // Improvement metrics
  entryPriceImprovement: number | null;  // % better entry (positive = early is better)
  pnlImprovement: number | null;

  // Context
  candle: {
    open: number;
    high: number;
    low: number;
    close: number;
  };
  bb: {
    upper: number;
    lower: number;
  };
}

// ============================================================================
// EXIT SIMULATION
// ============================================================================

function simulateExit(
  entryPrice: number,
  side: 'long' | 'short',
  candles: BacktestCandle[],
  entryIdx: number
): { exitPrice: number; exitReason: string; holdBars: number } {
  const cfg = CONFIG.EXIT;

  let highWaterMark = entryPrice;
  let lowWaterMark = entryPrice;
  let trailingActive = false;

  const stopLoss = side === 'long'
    ? entryPrice * (1 - cfg.STOP_LOSS_PCT / 100)
    : entryPrice * (1 + cfg.STOP_LOSS_PCT / 100);

  const takeProfit = side === 'long'
    ? entryPrice * (1 + cfg.PROFIT_TARGET_PCT / 100)
    : entryPrice * (1 - cfg.PROFIT_TARGET_PCT / 100);

  for (let i = entryIdx + 1; i < candles.length && i < entryIdx + cfg.MAX_HOLD_BARS; i++) {
    const candle = candles[i];
    const holdBars = i - entryIdx;

    if (side === 'long') {
      // Check stop loss
      if (candle.low <= stopLoss) {
        return { exitPrice: stopLoss, exitReason: 'STOP_LOSS', holdBars };
      }
      // Check take profit
      if (candle.high >= takeProfit) {
        return { exitPrice: takeProfit, exitReason: 'TAKE_PROFIT', holdBars };
      }
      // Update high water mark
      if (candle.high > highWaterMark) {
        highWaterMark = candle.high;
      }
      // Check trailing activation
      const pnlPct = ((highWaterMark - entryPrice) / entryPrice) * 100;
      if (pnlPct >= cfg.TRAILING_ACTIVATION_PCT && !trailingActive) {
        trailingActive = true;
      }
      // Check trailing stop
      if (trailingActive) {
        const trailingStop = highWaterMark * (1 - cfg.TRAILING_DISTANCE_PCT / 100);
        if (candle.low <= trailingStop) {
          return { exitPrice: trailingStop, exitReason: 'TRAILING_STOP', holdBars };
        }
      }
    } else {
      // SHORT logic
      // Check stop loss
      if (candle.high >= stopLoss) {
        return { exitPrice: stopLoss, exitReason: 'STOP_LOSS', holdBars };
      }
      // Check take profit
      if (candle.low <= takeProfit) {
        return { exitPrice: takeProfit, exitReason: 'TAKE_PROFIT', holdBars };
      }
      // Update low water mark
      if (candle.low < lowWaterMark) {
        lowWaterMark = candle.low;
      }
      // Check trailing activation
      const pnlPct = ((entryPrice - lowWaterMark) / entryPrice) * 100;
      if (pnlPct >= cfg.TRAILING_ACTIVATION_PCT && !trailingActive) {
        trailingActive = true;
      }
      // Check trailing stop
      if (trailingActive) {
        const trailingStop = lowWaterMark * (1 + cfg.TRAILING_DISTANCE_PCT / 100);
        if (candle.high >= trailingStop) {
          return { exitPrice: trailingStop, exitReason: 'TRAILING_STOP', holdBars };
        }
      }
    }
  }

  // Max hold reached
  const lastIdx = Math.min(entryIdx + cfg.MAX_HOLD_BARS - 1, candles.length - 1);
  return {
    exitPrice: candles[lastIdx].close,
    exitReason: 'MAX_HOLD',
    holdBars: lastIdx - entryIdx,
  };
}

// ============================================================================
// EARLY ENTRY CHECK
// ============================================================================

function checkEarlyEntry(
  candle: BacktestCandle,
  bb: { upper: number; lower: number },
  side: 'long' | 'short'
): { possible: boolean; entryPrice: number | null } {
  const cfg = CONFIG.WICK;

  if (side === 'long') {
    // For LONG: Did the high break above BB_upper + buffer?
    const breakoutTarget = bb.upper * (1 + cfg.LONG_BB_BUFFER);
    if (candle.high >= breakoutTarget) {
      // Early entry would be at BB_upper × 1.003
      const earlyPrice = bb.upper * (1 + cfg.LONG_ENTRY_BUFFER);
      // Sanity: entry price should be achievable (between open and high)
      const finalPrice = Math.min(candle.high, Math.max(candle.open, earlyPrice));
      return { possible: true, entryPrice: finalPrice };
    }
  } else {
    // For SHORT: Did the low break below BB_lower - buffer?
    const breakdownTarget = bb.lower * (1 - cfg.SHORT_BB_BUFFER);
    if (candle.low <= breakdownTarget) {
      // Early entry would be at BB_lower × 0.997
      const earlyPrice = bb.lower * (1 - cfg.SHORT_ENTRY_BUFFER);
      // Sanity: entry price should be achievable (between open and low)
      const finalPrice = Math.max(candle.low, Math.min(candle.open, earlyPrice));
      return { possible: true, entryPrice: finalPrice };
    }
  }

  return { possible: false, entryPrice: null };
}

// ============================================================================
// MAIN TEST
// ============================================================================

async function runTest() {
  console.log('='.repeat(100));
  console.log('REALISTIC WICK BREAKOUT TEST');
  console.log('='.repeat(100));
  console.log(`\nTest period: ${CONFIG.START_DATE.toISOString().slice(0, 10)} to ${CONFIG.END_DATE.toISOString().slice(0, 10)}`);
  console.log(`Symbols: ${CONFIG.SYMBOLS.length} tokens`);
  console.log(`\nWick Breakout Config:`);
  console.log(`  LONG: high > BB_upper × ${1 + CONFIG.WICK.LONG_BB_BUFFER} → entry at BB_upper × ${1 + CONFIG.WICK.LONG_ENTRY_BUFFER}`);
  console.log(`  SHORT: low < BB_lower × ${1 - CONFIG.WICK.SHORT_BB_BUFFER} → entry at BB_lower × ${1 - CONFIG.WICK.SHORT_ENTRY_BUFFER}`);

  const results: TradeResult[] = [];
  let totalSignals = 0;
  let longSignals = 0;
  let shortSignals = 0;

  // Load BTC candles for regime detection
  const btcResult = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  const btc1hResult = await loadLocalJsonCandles('BTC/USDT:USDT', '1h');

  if (!btcResult || !btc1hResult) {
    throw new Error('Failed to load BTC candles');
  }

  const btcCandles = sliceCandlesByTime(
    btcResult.candles,
    CONFIG.START_DATE.getTime() - 300 * 15 * 60 * 1000,
    CONFIG.END_DATE.getTime()
  );

  const btc1hCandles = sliceCandlesByTime(
    btc1hResult.candles,
    CONFIG.START_DATE.getTime() - 50 * 60 * 60 * 1000,
    CONFIG.END_DATE.getTime()
  );

  for (const symbol of CONFIG.SYMBOLS) {
    console.log(`\nProcessing ${symbol}...`);

    const symbolResult = await loadLocalJsonCandles(symbol, '15m');
    if (!symbolResult) {
      console.log(`  ⚠️ No data for ${symbol}`);
      continue;
    }

    const candles = sliceCandlesByTime(
      symbolResult.candles,
      CONFIG.START_DATE.getTime() - 300 * 15 * 60 * 1000,
      CONFIG.END_DATE.getTime()
    );

    console.log(`  Loaded ${candles.length} candles`);

    let symbolLong = 0;
    let symbolShort = 0;
    let symbolEarlyPossible = 0;

    // Process each candle
    for (let i = 250; i < candles.length - CONFIG.EXIT.MAX_HOLD_BARS; i++) {
      const current = candles[i];
      const currentTs = current.timestamp;

      // Skip if not in test period
      if (currentTs < CONFIG.START_DATE.getTime() || currentTs > CONFIG.END_DATE.getTime()) {
        continue;
      }

      // Get candle window for signal check
      const windowCandles = candles.slice(i - 200, i + 1);

      // Find corresponding BTC candles
      const btcIdx = btcCandles.findIndex(c => c.timestamp >= currentTs);
      if (btcIdx < 200) continue;
      const btcWindow = btcCandles.slice(btcIdx - 200, btcIdx + 1);

      // Find corresponding BTC 1h candles
      const btc1hIdx = btc1hCandles.findIndex(c => c.timestamp >= currentTs);
      const btc1hWindow = btc1hIdx >= 20 ? btc1hCandles.slice(btc1hIdx - 20, btc1hIdx + 1) : [];

      // Check for valid signal using REAL signal function
      const signal = checkMomentumSignal(symbol, windowCandles, btcWindow, {
        nowMs: currentTs,
        btcCandles1h: btc1hWindow,
      });

      if (!signal.valid || !signal.side) continue;

      totalSignals++;
      if (signal.side === 'long') {
        longSignals++;
        symbolLong++;
      } else {
        shortSignals++;
        symbolShort++;
      }

      // Calculate BB for early entry check
      const closes = windowCandles.map(c => c.close);
      const bb = calcBollingerBands(closes, 20, 2);

      // Check if early entry was possible
      const earlyCheck = checkEarlyEntry(current, bb, signal.side);

      // Simulate classic exit (entry at close)
      const classicExit = simulateExit(current.close, signal.side, candles, i);
      const classicPnl = signal.side === 'long'
        ? ((classicExit.exitPrice - current.close) / current.close) * 100
        : ((current.close - classicExit.exitPrice) / current.close) * 100;

      // Simulate early exit (if possible)
      let earlyPnl: number | null = null;
      let earlyExitPrice: number | null = null;
      let entryImprovement: number | null = null;
      let pnlImprovement: number | null = null;

      if (earlyCheck.possible && earlyCheck.entryPrice) {
        symbolEarlyPossible++;
        const earlyExit = simulateExit(earlyCheck.entryPrice, signal.side, candles, i);
        earlyExitPrice = earlyExit.exitPrice;

        earlyPnl = signal.side === 'long'
          ? ((earlyExit.exitPrice - earlyCheck.entryPrice) / earlyCheck.entryPrice) * 100
          : ((earlyCheck.entryPrice - earlyExit.exitPrice) / earlyCheck.entryPrice) * 100;

        // Entry improvement: how much better is early entry?
        // For LONG: positive if early price is lower
        // For SHORT: positive if early price is higher
        entryImprovement = signal.side === 'long'
          ? ((current.close - earlyCheck.entryPrice) / current.close) * 100
          : ((earlyCheck.entryPrice - current.close) / current.close) * 100;

        pnlImprovement = earlyPnl - classicPnl;
      }

      results.push({
        symbol,
        side: signal.side,
        entryTime: new Date(currentTs).toISOString(),

        classicEntryPrice: current.close,
        classicExitPrice: classicExit.exitPrice,
        classicPnlPct: classicPnl,
        classicExitReason: classicExit.exitReason,

        earlyEntryPossible: earlyCheck.possible,
        earlyEntryPrice: earlyCheck.entryPrice,
        earlyExitPrice,
        earlyPnlPct: earlyPnl,

        entryPriceImprovement: entryImprovement,
        pnlImprovement,

        candle: {
          open: current.open,
          high: current.high,
          low: current.low,
          close: current.close,
        },
        bb: { upper: bb.upper, lower: bb.lower },
      });
    }

    console.log(`  Found ${symbolLong} LONG, ${symbolShort} SHORT signals | ${symbolEarlyPossible} early entry possible`);
  }

  // ============================================================================
  // RESULTS ANALYSIS
  // ============================================================================

  console.log('\n' + '='.repeat(100));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(100));

  const longResults = results.filter(r => r.side === 'long');
  const shortResults = results.filter(r => r.side === 'short');

  const earlyPossibleLong = longResults.filter(r => r.earlyEntryPossible);
  const earlyPossibleShort = shortResults.filter(r => r.earlyEntryPossible);

  console.log(`\n📊 SIGNAL DISTRIBUTION:`);
  console.log(`  Total signals: ${results.length}`);
  console.log(`  LONG signals: ${longResults.length} (${(longResults.length / results.length * 100).toFixed(1)}%)`);
  console.log(`  SHORT signals: ${shortResults.length} (${(shortResults.length / results.length * 100).toFixed(1)}%)`);

  console.log(`\n📊 EARLY ENTRY OPPORTUNITIES:`);
  console.log(`  LONG early possible: ${earlyPossibleLong.length}/${longResults.length} (${longResults.length > 0 ? (earlyPossibleLong.length / longResults.length * 100).toFixed(1) : 0}%)`);
  console.log(`  SHORT early possible: ${earlyPossibleShort.length}/${shortResults.length} (${shortResults.length > 0 ? (earlyPossibleShort.length / shortResults.length * 100).toFixed(1) : 0}%)`);

  // ============================================================================
  // LONG ANALYSIS
  // ============================================================================

  if (longResults.length > 0) {
    console.log('\n' + '='.repeat(100));
    console.log('📈 LONG TRADES ANALYSIS');
    console.log('='.repeat(100));

    const classicLongWins = longResults.filter(r => r.classicPnlPct > 0).length;
    const classicLongPnl = longResults.reduce((sum, r) => sum + r.classicPnlPct, 0);

    console.log(`\n  Classic Entry (at close):`);
    console.log(`    Trades: ${longResults.length}`);
    console.log(`    Win rate: ${(classicLongWins / longResults.length * 100).toFixed(1)}%`);
    console.log(`    Total PnL: ${classicLongPnl >= 0 ? '+' : ''}${classicLongPnl.toFixed(2)}%`);
    console.log(`    Avg PnL: ${(classicLongPnl / longResults.length).toFixed(3)}%`);

    if (earlyPossibleLong.length > 0) {
      const earlyLongWins = earlyPossibleLong.filter(r => (r.earlyPnlPct || 0) > 0).length;
      const earlyLongPnl = earlyPossibleLong.reduce((sum, r) => sum + (r.earlyPnlPct || 0), 0);
      const avgEntryImprovement = earlyPossibleLong.reduce((sum, r) => sum + (r.entryPriceImprovement || 0), 0) / earlyPossibleLong.length;
      const avgPnlImprovement = earlyPossibleLong.reduce((sum, r) => sum + (r.pnlImprovement || 0), 0) / earlyPossibleLong.length;

      // Compare only trades where early was possible
      const classicSubsetPnl = earlyPossibleLong.reduce((sum, r) => sum + r.classicPnlPct, 0);
      const classicSubsetWins = earlyPossibleLong.filter(r => r.classicPnlPct > 0).length;

      console.log(`\n  Early Entry (where possible: ${earlyPossibleLong.length} trades):`);
      console.log(`    Win rate: ${(earlyLongWins / earlyPossibleLong.length * 100).toFixed(1)}% (vs classic ${(classicSubsetWins / earlyPossibleLong.length * 100).toFixed(1)}%)`);
      console.log(`    Total PnL: ${earlyLongPnl >= 0 ? '+' : ''}${earlyLongPnl.toFixed(2)}% (vs classic ${classicSubsetPnl >= 0 ? '+' : ''}${classicSubsetPnl.toFixed(2)}%)`);
      console.log(`    Avg Entry Improvement: ${avgEntryImprovement >= 0 ? '+' : ''}${avgEntryImprovement.toFixed(3)}%`);
      console.log(`    Avg PnL Improvement: ${avgPnlImprovement >= 0 ? '+' : ''}${avgPnlImprovement.toFixed(3)}%`);
    }
  }

  // ============================================================================
  // SHORT ANALYSIS
  // ============================================================================

  if (shortResults.length > 0) {
    console.log('\n' + '='.repeat(100));
    console.log('📉 SHORT TRADES ANALYSIS');
    console.log('='.repeat(100));

    const classicShortWins = shortResults.filter(r => r.classicPnlPct > 0).length;
    const classicShortPnl = shortResults.reduce((sum, r) => sum + r.classicPnlPct, 0);

    console.log(`\n  Classic Entry (at close):`);
    console.log(`    Trades: ${shortResults.length}`);
    console.log(`    Win rate: ${(classicShortWins / shortResults.length * 100).toFixed(1)}%`);
    console.log(`    Total PnL: ${classicShortPnl >= 0 ? '+' : ''}${classicShortPnl.toFixed(2)}%`);
    console.log(`    Avg PnL: ${(classicShortPnl / shortResults.length).toFixed(3)}%`);

    if (earlyPossibleShort.length > 0) {
      const earlyShortWins = earlyPossibleShort.filter(r => (r.earlyPnlPct || 0) > 0).length;
      const earlyShortPnl = earlyPossibleShort.reduce((sum, r) => sum + (r.earlyPnlPct || 0), 0);
      const avgEntryImprovement = earlyPossibleShort.reduce((sum, r) => sum + (r.entryPriceImprovement || 0), 0) / earlyPossibleShort.length;
      const avgPnlImprovement = earlyPossibleShort.reduce((sum, r) => sum + (r.pnlImprovement || 0), 0) / earlyPossibleShort.length;

      // Compare only trades where early was possible
      const classicSubsetPnl = earlyPossibleShort.reduce((sum, r) => sum + r.classicPnlPct, 0);
      const classicSubsetWins = earlyPossibleShort.filter(r => r.classicPnlPct > 0).length;

      console.log(`\n  Early Entry (where possible: ${earlyPossibleShort.length} trades):`);
      console.log(`    Win rate: ${(earlyShortWins / earlyPossibleShort.length * 100).toFixed(1)}% (vs classic ${(classicSubsetWins / earlyPossibleShort.length * 100).toFixed(1)}%)`);
      console.log(`    Total PnL: ${earlyShortPnl >= 0 ? '+' : ''}${earlyShortPnl.toFixed(2)}% (vs classic ${classicSubsetPnl >= 0 ? '+' : ''}${classicSubsetPnl.toFixed(2)}%)`);
      console.log(`    Avg Entry Improvement: ${avgEntryImprovement >= 0 ? '+' : ''}${avgEntryImprovement.toFixed(3)}%`);
      console.log(`    Avg PnL Improvement: ${avgPnlImprovement >= 0 ? '+' : ''}${avgPnlImprovement.toFixed(3)}%`);
    }
  }

  // ============================================================================
  // COMBINED ANALYSIS
  // ============================================================================

  const earlyPossibleAll = results.filter(r => r.earlyEntryPossible);

  if (earlyPossibleAll.length > 0) {
    console.log('\n' + '='.repeat(100));
    console.log('📊 COMBINED ANALYSIS (LONG + SHORT)');
    console.log('='.repeat(100));

    const classicTotalPnl = results.reduce((sum, r) => sum + r.classicPnlPct, 0);
    const classicWins = results.filter(r => r.classicPnlPct > 0).length;

    const earlyTotalPnl = earlyPossibleAll.reduce((sum, r) => sum + (r.earlyPnlPct || 0), 0);
    const earlyWins = earlyPossibleAll.filter(r => (r.earlyPnlPct || 0) > 0).length;

    const classicSubsetPnl = earlyPossibleAll.reduce((sum, r) => sum + r.classicPnlPct, 0);
    const classicSubsetWins = earlyPossibleAll.filter(r => r.classicPnlPct > 0).length;

    const avgEntryImprovement = earlyPossibleAll.reduce((sum, r) => sum + (r.entryPriceImprovement || 0), 0) / earlyPossibleAll.length;
    const avgPnlImprovement = earlyPossibleAll.reduce((sum, r) => sum + (r.pnlImprovement || 0), 0) / earlyPossibleAll.length;

    console.log(`\n  All Trades Classic: ${results.length} trades, ${(classicWins/results.length*100).toFixed(1)}% WR, ${(classicTotalPnl/results.length).toFixed(3)}% avg PnL`);
    console.log(`\n  Early Entry Subset (${earlyPossibleAll.length} trades where early was possible):`);
    console.log(`    Classic: ${(classicSubsetWins/earlyPossibleAll.length*100).toFixed(1)}% WR, ${(classicSubsetPnl/earlyPossibleAll.length).toFixed(3)}% avg PnL`);
    console.log(`    Early:   ${(earlyWins/earlyPossibleAll.length*100).toFixed(1)}% WR, ${(earlyTotalPnl/earlyPossibleAll.length).toFixed(3)}% avg PnL`);
    console.log(`\n    Entry Improvement: ${avgEntryImprovement >= 0 ? '+' : ''}${avgEntryImprovement.toFixed(3)}%`);
    console.log(`    PnL Improvement:   ${avgPnlImprovement >= 0 ? '+' : ''}${avgPnlImprovement.toFixed(3)}%`);

    // Show trades where early was significantly better or worse
    const significantlyBetter = earlyPossibleAll.filter(r => (r.pnlImprovement || 0) > 0.5);
    const significantlyWorse = earlyPossibleAll.filter(r => (r.pnlImprovement || 0) < -0.5);

    console.log(`\n    Trades where early was > 0.5% BETTER: ${significantlyBetter.length}`);
    console.log(`    Trades where early was > 0.5% WORSE:  ${significantlyWorse.length}`);
  }

  // ============================================================================
  // VERDICT
  // ============================================================================

  console.log('\n' + '='.repeat(100));
  console.log('VERDICT');
  console.log('='.repeat(100));

  if (earlyPossibleAll.length === 0) {
    console.log('\n❌ No early entry opportunities found.');
    return;
  }

  const avgPnlImprovement = earlyPossibleAll.reduce((sum, r) => sum + (r.pnlImprovement || 0), 0) / earlyPossibleAll.length;
  const avgEntryImprovement = earlyPossibleAll.reduce((sum, r) => sum + (r.entryPriceImprovement || 0), 0) / earlyPossibleAll.length;

  const earlyWins = earlyPossibleAll.filter(r => (r.earlyPnlPct || 0) > 0).length;
  const classicWins = earlyPossibleAll.filter(r => r.classicPnlPct > 0).length;
  const earlyWR = earlyWins / earlyPossibleAll.length * 100;
  const classicWR = classicWins / earlyPossibleAll.length * 100;

  if (avgPnlImprovement > 0.1 && earlyWR >= classicWR - 2) {
    console.log('\n✅ EARLY ENTRY SHOWS PROMISE:');
    console.log(`   - Entry improvement: ${avgEntryImprovement >= 0 ? '+' : ''}${avgEntryImprovement.toFixed(3)}%`);
    console.log(`   - PnL improvement: ${avgPnlImprovement >= 0 ? '+' : ''}${avgPnlImprovement.toFixed(3)}%`);
    console.log(`   - Win rate: ${earlyWR.toFixed(1)}% (vs ${classicWR.toFixed(1)}% classic)`);
    console.log(`   - Applicable to ${earlyPossibleAll.length}/${results.length} trades (${(earlyPossibleAll.length/results.length*100).toFixed(1)}%)`);
  } else if (avgPnlImprovement > 0) {
    console.log('\n⚠️ MARGINAL IMPROVEMENT:');
    console.log(`   - Entry improvement: ${avgEntryImprovement >= 0 ? '+' : ''}${avgEntryImprovement.toFixed(3)}%`);
    console.log(`   - PnL improvement: ${avgPnlImprovement >= 0 ? '+' : ''}${avgPnlImprovement.toFixed(3)}%`);
    console.log(`   - May not be worth implementation complexity`);
  } else {
    console.log('\n❌ NO IMPROVEMENT:');
    console.log(`   - PnL change: ${avgPnlImprovement.toFixed(3)}%`);
    console.log(`   - Early entry does not improve results`);
    console.log(`   - Keep using candle close entry`);
  }
}

// ============================================================================
// RUN
// ============================================================================

runTest().catch(console.error);
