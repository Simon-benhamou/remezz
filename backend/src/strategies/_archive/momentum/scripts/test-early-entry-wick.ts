/**
 * TEST: Early Entry on Wick + Volume vs Classic Candle Close Entry
 *
 * OBJECTIVE: Measure if entering earlier (when high > BB_upper) improves entry price
 * without sacrificing signal quality.
 *
 * METHODOLOGY:
 * 1. For each classic LONG signal (close > BB_upper + ROC + Vol)
 * 2. Check if high > BB_upper earlier in the candle with volume confirmation
 * 3. Simulate early entry price vs close price
 * 4. Calculate PnL improvement using same exit (trailing stop)
 */

import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';

import {
  MomentumConfig,
  calcSMA,
  calcBB,
  calcROC,
  calcVolRatio,
  countConsecUp,
} from '../src/strategies/momentumSimple.js';

// ============================================================================
// CONFIG
// ============================================================================

const TEST_CONFIG = {
  // Test period
  START_DATE: new Date('2024-01-01T00:00:00Z'),
  END_DATE: new Date('2025-01-01T00:00:00Z'),

  // Symbols to test (comprehensive list for statistical significance)
  SYMBOLS: [
    'DOGE/USDT:USDT',
    'SUI/USDT:USDT',
    'SEI/USDT:USDT',
    'IMX/USDT:USDT',
    'XRP/USDT:USDT',
    'ETH/USDT:USDT',
    'SOL/USDT:USDT',
    'ADA/USDT:USDT',
    'AVAX/USDT:USDT',
    'LINK/USDT:USDT',
    'APT/USDT:USDT',
    'DOT/USDT:USDT',
  ],

  // Classic entry thresholds (from MomentumConfig)
  CLASSIC: {
    ROC_MIN: MomentumConfig.ENTRY_LONG.ROC_MIN,           // 0.0175 = 1.75%
    VOL_MULTIPLIER: MomentumConfig.ENTRY_LONG.VOL_MULTIPLIER, // 1.15
    MAX_CONSEC_UP: MomentumConfig.ENTRY_LONG.MAX_CONSEC_UP,   // 5
  },

  // Early entry thresholds (to test)
  EARLY: {
    // How much above BB_upper must HIGH be? (fraction, e.g., 0.005 = 0.5%)
    BB_BREAKOUT_BUFFER: 0.005,  // high > BB_upper × 1.005
    // What volume ratio is required mid-candle?
    VOL_MULTIPLIER: 1.2,        // Vol > 1.2x (slightly higher than classic 1.15x)
    // What ROC5 is required? (current candle momentum)
    ROC5_MIN: 0.015,            // 1.5% (relaxed from ROC10 > 1.75%)
    // Simulated early entry price: BB_upper × (1 + this)
    ENTRY_PRICE_BUFFER: 0.003,  // Entry at BB_upper × 1.003
    // Require bullish candle? (false = enter on wick even if candle reverses)
    REQUIRE_BULLISH: true,      // TEST: Require bullish close to filter wick traps
  },

  // Exit simulation
  EXIT: {
    TRAILING_ACTIVATION_PCT: MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT, // 0.8%
    TRAILING_DISTANCE_PCT: MomentumConfig.EXIT.TRAILING_DISTANCE_PCT,     // 0.5%
    STOP_LOSS_PCT: MomentumConfig.EXIT.STOP_LOSS_PCT,                     // 2.5%
    PROFIT_TARGET_PCT: MomentumConfig.EXIT.PROFIT_TARGET_PCT,             // 3.0%
    MAX_HOLD_BARS: 192, // 48h
  },
};

// ============================================================================
// TYPES
// ============================================================================

interface TradeComparison {
  symbol: string;
  entryTime: string;

  // Classic entry
  classicEntryPrice: number;
  classicExitPrice: number;
  classicPnlPct: number;
  classicExitReason: string;

  // Early entry
  earlyEntryPossible: boolean;
  earlyEntryPrice: number | null;
  earlyExitPrice: number | null;
  earlyPnlPct: number | null;

  // Improvement
  entryPriceImprovement: number | null; // % better entry (positive = earlier is better)
  pnlImprovement: number | null;        // % PnL improvement

  // Candle context
  candleOpen: number;
  candleHigh: number;
  candleLow: number;
  candleClose: number;
  bbUpper: number;
  volumeRatio: number;
  roc5: number;
  roc10: number;
}

// FALSE SIGNALS: Wicks that break out but close DOESN'T (classic signal would NOT trigger)
interface FalseSignal {
  symbol: string;
  entryTime: string;
  earlyEntryPrice: number;
  earlyExitPrice: number;
  earlyPnlPct: number;
  earlyExitReason: string;
  candleHigh: number;
  candleClose: number;
  bbUpper: number;
  wouldHaveBeenClassicWin: boolean;  // If we had waited, would close have triggered?
}

interface TestResults {
  totalClassicSignals: number;
  earlyEntryPossible: number;
  earlyEntryPossiblePct: number;

  // Entry price stats
  avgEntryImprovement: number;
  medianEntryImprovement: number;
  maxEntryImprovement: number;

  // PnL stats
  classicTotalPnl: number;
  earlyTotalPnl: number;
  pnlImprovement: number;

  // Win rate
  classicWinRate: number;
  earlyWinRate: number;

  // FALSE SIGNALS (critical for risk assessment)
  falseSignals: FalseSignal[];
  falseSignalCount: number;
  falseSignalWinRate: number;
  falseSignalAvgPnl: number;

  // Trades detail
  trades: TradeComparison[];
}

// ============================================================================
// INDICATORS (simplified from momentumSimple)
// ============================================================================

function calcIndicators(candles: BacktestCandle[]) {
  if (candles.length < 61) return null;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const bb = calcBB(closes, 20, 2);
  const sma20 = calcSMA(closes, 20);
  const sma50 = calcSMA(closes, 50);
  const roc5 = calcROC(closes, 5);
  const roc10 = calcROC(closes, 10);
  const volRatio = calcVolRatio(volumes, 19);
  const consecUp = countConsecUp(closes, 5);

  const currentCandle = candles[candles.length - 1];
  const prevCandle = candles.length > 1 ? candles[candles.length - 2] : null;

  // ROC5 of previous candle (for early entry check)
  const prevCloses = closes.slice(0, -1);
  const roc5Prev = prevCloses.length >= 6 ? calcROC(prevCloses, 5) : 0;

  return {
    bb,
    sma20,
    sma50,
    roc5,
    roc10,
    volRatio,
    consecUp,
    currentCandle,
    prevCandle,
    roc5Prev,
    close: currentCandle.close,
    high: currentCandle.high,
    low: currentCandle.low,
    open: currentCandle.open,
    isBullish: currentCandle.close > currentCandle.open,
  };
}

// ============================================================================
// ENTRY CHECKS
// ============================================================================

function checkClassicLongEntry(ind: NonNullable<ReturnType<typeof calcIndicators>>): boolean {
  const { bb, close, roc10, volRatio, consecUp, isBullish } = ind;

  return (
    isBullish &&
    close > bb.upper &&
    roc10 >= TEST_CONFIG.CLASSIC.ROC_MIN &&
    volRatio >= TEST_CONFIG.CLASSIC.VOL_MULTIPLIER &&
    consecUp <= TEST_CONFIG.CLASSIC.MAX_CONSEC_UP
  );
}

function checkEarlyLongEntry(ind: NonNullable<ReturnType<typeof calcIndicators>>): {
  possible: boolean;
  entryPrice: number | null;
  reason: string;
  wouldHaveBeenFalseSignal?: boolean;  // NEW: Track if candle reversed (wick trap)
} {
  const { bb, high, open, close, volRatio, roc5, isBullish } = ind;
  const cfg = TEST_CONFIG.EARLY;

  // 1. Did high break above BB_upper + buffer?
  const breakoutTarget = bb.upper * (1 + cfg.BB_BREAKOUT_BUFFER);
  const highBrokeOut = high >= breakoutTarget;

  if (!highBrokeOut) {
    return { possible: false, entryPrice: null, reason: 'high_below_bb_buffer' };
  }

  // 2. Was volume already high mid-candle?
  // We use the candle's final volume as proxy (in reality would check mid-candle)
  const volOk = volRatio >= cfg.VOL_MULTIPLIER;
  if (!volOk) {
    return { possible: false, entryPrice: null, reason: 'vol_too_low_mid_candle' };
  }

  // 3. Was momentum strong? (ROC5 on CURRENT candle - measures if move was real)
  const roc5Ok = roc5 >= cfg.ROC5_MIN;
  if (!roc5Ok) {
    return { possible: false, entryPrice: null, reason: 'roc5_too_low' };
  }

  // 4. Optionally require bullish candle (body followed the wick)
  // If REQUIRE_BULLISH=false, we test the aggressive approach
  if (cfg.REQUIRE_BULLISH && !isBullish) {
    return { possible: false, entryPrice: null, reason: 'bearish_candle_wick_reversed' };
  }

  // Calculate simulated early entry price
  // Best case: we catch it right at BB_upper + small buffer
  const earlyEntryPrice = bb.upper * (1 + cfg.ENTRY_PRICE_BUFFER);

  // Sanity check: entry price should be between open and high
  const finalEntryPrice = Math.max(open, Math.min(high, earlyEntryPrice));

  return {
    possible: true,
    entryPrice: finalEntryPrice,
    reason: 'early_entry_conditions_met',
    wouldHaveBeenFalseSignal: !isBullish,  // Track wick traps for analysis
  };
}

// ============================================================================
// EXIT SIMULATION (simplified trailing stop)
// ============================================================================

function simulateExit(
  entryPrice: number,
  side: 'long',
  candles: BacktestCandle[],
  entryIdx: number
): { exitPrice: number; exitReason: string; holdBars: number } {
  const cfg = TEST_CONFIG.EXIT;

  let highWaterMark = entryPrice;
  let trailingActive = false;
  let trailingStop = 0;

  const stopLoss = entryPrice * (1 - cfg.STOP_LOSS_PCT / 100);
  const takeProfit = entryPrice * (1 + cfg.PROFIT_TARGET_PCT / 100);

  for (let i = entryIdx + 1; i < candles.length && i < entryIdx + cfg.MAX_HOLD_BARS; i++) {
    const candle = candles[i];
    const holdBars = i - entryIdx;

    // Check stop loss (intrabar)
    if (candle.low <= stopLoss) {
      return { exitPrice: stopLoss, exitReason: 'STOP_LOSS', holdBars };
    }

    // Check take profit (intrabar)
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

    // Calculate trailing stop
    if (trailingActive) {
      trailingStop = highWaterMark * (1 - cfg.TRAILING_DISTANCE_PCT / 100);

      // Check trailing hit (intrabar)
      if (candle.low <= trailingStop) {
        return { exitPrice: trailingStop, exitReason: 'TRAILING_STOP', holdBars };
      }
    }
  }

  // Max hold reached - exit at close
  const lastIdx = Math.min(entryIdx + cfg.MAX_HOLD_BARS - 1, candles.length - 1);
  return {
    exitPrice: candles[lastIdx].close,
    exitReason: 'MAX_HOLD',
    holdBars: lastIdx - entryIdx,
  };
}

// ============================================================================
// MAIN TEST
// ============================================================================

async function runTest(): Promise<TestResults> {
  console.log('='.repeat(100));
  console.log('EARLY ENTRY WICK + VOLUME TEST');
  console.log('='.repeat(100));
  console.log(`\nTest period: ${TEST_CONFIG.START_DATE.toISOString().slice(0, 10)} to ${TEST_CONFIG.END_DATE.toISOString().slice(0, 10)}`);
  console.log(`Symbols: ${TEST_CONFIG.SYMBOLS.join(', ')}`);
  console.log(`\nEarly Entry Config:`);
  console.log(`  BB Breakout Buffer: ${(TEST_CONFIG.EARLY.BB_BREAKOUT_BUFFER * 100).toFixed(2)}% (high > BB_upper × 1.005)`);
  console.log(`  Volume Multiplier: ${TEST_CONFIG.EARLY.VOL_MULTIPLIER}x`);
  console.log(`  ROC5 Min: ${(TEST_CONFIG.EARLY.ROC5_MIN * 100).toFixed(2)}%`);
  console.log(`  Entry Price Buffer: ${(TEST_CONFIG.EARLY.ENTRY_PRICE_BUFFER * 100).toFixed(2)}% (entry at BB_upper × 1.003)`);
  console.log(`  Require Bullish: ${TEST_CONFIG.EARLY.REQUIRE_BULLISH}`);

  const trades: TradeComparison[] = [];
  const falseSignals: FalseSignal[] = [];  // Track early entries that wouldn't be classic signals

  // Load BTC for regime detection (simplified - we'll just use bull regime for testing)
  const btcResult = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcResult) {
    throw new Error('Failed to load BTC candles');
  }
  const btcCandles = sliceCandlesByTime(
    btcResult.candles,
    TEST_CONFIG.START_DATE.getTime() - 200 * 15 * 60 * 1000,
    TEST_CONFIG.END_DATE.getTime()
  );

  // Calculate BTC SMA200 for regime detection
  const btcCloses = btcCandles.map(c => c.close);

  for (const symbol of TEST_CONFIG.SYMBOLS) {
    console.log(`\nProcessing ${symbol}...`);

    const symbolResult = await loadLocalJsonCandles(symbol, '15m');
    if (!symbolResult) {
      console.log(`  ⚠️ No data for ${symbol}`);
      continue;
    }

    const candles = sliceCandlesByTime(
      symbolResult.candles,
      TEST_CONFIG.START_DATE.getTime() - 200 * 15 * 60 * 1000,
      TEST_CONFIG.END_DATE.getTime()
    );

    console.log(`  Loaded ${candles.length} candles`);

    let signalCount = 0;
    let earlyPossibleCount = 0;
    let falseSignalCount = 0;

    // Process each candle
    for (let i = 60; i < candles.length; i++) {
      const windowCandles = candles.slice(Math.max(0, i - 60), i + 1);
      const ind = calcIndicators(windowCandles);
      if (!ind) continue;

      // Find corresponding BTC candle for regime check
      const currentTs = candles[i].timestamp;
      const btcIdx = btcCandles.findIndex(c => c.timestamp >= currentTs);
      if (btcIdx < 200) continue; // Not enough BTC history

      // Simple bull regime check: BTC price > SMA200
      const btcClose = btcCandles[btcIdx]?.close || 0;
      const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx + 1), 200);
      const inBullRegime = btcClose > btcSma200;

      if (!inBullRegime) continue; // Only test LONG in bull regime

      // Check early entry conditions FIRST (this is the key test)
      const earlyCheck = checkEarlyLongEntry(ind);
      const classicWouldTrigger = checkClassicLongEntry(ind);

      // ========== FALSE SIGNAL DETECTION ==========
      // Cases where early entry would trigger but classic would NOT
      // These are "wick traps" - the most dangerous scenario
      if (earlyCheck.possible && earlyCheck.entryPrice && !classicWouldTrigger) {
        falseSignalCount++;
        const earlyExit = simulateExit(earlyCheck.entryPrice, 'long', candles, i);
        const earlyPnl = ((earlyExit.exitPrice - earlyCheck.entryPrice) / earlyCheck.entryPrice) * 100;

        falseSignals.push({
          symbol,
          entryTime: new Date(candles[i].timestamp).toISOString(),
          earlyEntryPrice: earlyCheck.entryPrice,
          earlyExitPrice: earlyExit.exitPrice,
          earlyPnlPct: earlyPnl,
          earlyExitReason: earlyExit.exitReason,
          candleHigh: ind.high,
          candleClose: ind.close,
          bbUpper: ind.bb.upper,
          wouldHaveBeenClassicWin: false,  // Classic wouldn't have triggered
        });
        continue; // Don't count as regular trade
      }

      // Skip if classic entry wouldn't trigger
      if (!classicWouldTrigger) continue;

      signalCount++;

      // Simulate classic exit
      const classicExit = simulateExit(ind.close, 'long', candles, i);
      const classicPnl = ((classicExit.exitPrice - ind.close) / ind.close) * 100;

      // Simulate early exit (if possible)
      let earlyPnl: number | null = null;
      let earlyExitPrice: number | null = null;
      let entryImprovement: number | null = null;
      let pnlImprovement: number | null = null;

      if (earlyCheck.possible && earlyCheck.entryPrice) {
        earlyPossibleCount++;
        const earlyExit = simulateExit(earlyCheck.entryPrice, 'long', candles, i);
        earlyExitPrice = earlyExit.exitPrice;
        earlyPnl = ((earlyExit.exitPrice - earlyCheck.entryPrice) / earlyCheck.entryPrice) * 100;

        // Entry improvement: how much better is early entry?
        // Positive = early entry was at a lower price (better for LONG)
        entryImprovement = ((ind.close - earlyCheck.entryPrice) / ind.close) * 100;

        // PnL improvement
        pnlImprovement = earlyPnl - classicPnl;
      }

      trades.push({
        symbol,
        entryTime: new Date(candles[i].timestamp).toISOString(),

        classicEntryPrice: ind.close,
        classicExitPrice: classicExit.exitPrice,
        classicPnlPct: classicPnl,
        classicExitReason: classicExit.exitReason,

        earlyEntryPossible: earlyCheck.possible,
        earlyEntryPrice: earlyCheck.entryPrice,
        earlyExitPrice,
        earlyPnlPct: earlyPnl,

        entryPriceImprovement: entryImprovement,
        pnlImprovement,

        candleOpen: ind.open,
        candleHigh: ind.high,
        candleLow: ind.low,
        candleClose: ind.close,
        bbUpper: ind.bb.upper,
        volumeRatio: ind.volRatio,
        roc5: ind.roc5 * 100,
        roc10: ind.roc10 * 100,
      });
    }

    console.log(`  Found ${signalCount} classic signals, ${earlyPossibleCount} with early entry possible, ${falseSignalCount} false signals (wick traps)`);
  }

  // Calculate statistics
  const earlyPossibleTrades = trades.filter(t => t.earlyEntryPossible);
  const entryImprovements = earlyPossibleTrades
    .map(t => t.entryPriceImprovement!)
    .filter(v => v !== null)
    .sort((a, b) => a - b);

  const classicWins = trades.filter(t => t.classicPnlPct > 0).length;
  const earlyWins = earlyPossibleTrades.filter(t => t.earlyPnlPct! > 0).length;

  const classicTotalPnl = trades.reduce((sum, t) => sum + t.classicPnlPct, 0);
  const earlyTotalPnl = earlyPossibleTrades.reduce((sum, t) => sum + (t.earlyPnlPct || 0), 0);

  // FALSE SIGNAL stats - critical for risk assessment
  const falseSignalWins = falseSignals.filter(f => f.earlyPnlPct > 0).length;
  const falseSignalTotalPnl = falseSignals.reduce((sum, f) => sum + f.earlyPnlPct, 0);

  const results: TestResults = {
    totalClassicSignals: trades.length,
    earlyEntryPossible: earlyPossibleTrades.length,
    earlyEntryPossiblePct: trades.length > 0 ? (earlyPossibleTrades.length / trades.length) * 100 : 0,

    avgEntryImprovement: entryImprovements.length > 0
      ? entryImprovements.reduce((a, b) => a + b, 0) / entryImprovements.length
      : 0,
    medianEntryImprovement: entryImprovements.length > 0
      ? entryImprovements[Math.floor(entryImprovements.length / 2)]
      : 0,
    maxEntryImprovement: entryImprovements.length > 0
      ? Math.max(...entryImprovements)
      : 0,

    classicTotalPnl,
    earlyTotalPnl,
    pnlImprovement: trades.length > 0
      ? earlyTotalPnl - (classicTotalPnl * (earlyPossibleTrades.length / trades.length))
      : 0,

    classicWinRate: trades.length > 0 ? (classicWins / trades.length) * 100 : 0,
    earlyWinRate: earlyPossibleTrades.length > 0
      ? (earlyWins / earlyPossibleTrades.length) * 100
      : 0,

    // FALSE SIGNALS - wick traps that would NOT have been classic signals
    falseSignals,
    falseSignalCount: falseSignals.length,
    falseSignalWinRate: falseSignals.length > 0
      ? (falseSignalWins / falseSignals.length) * 100
      : 0,
    falseSignalAvgPnl: falseSignals.length > 0
      ? falseSignalTotalPnl / falseSignals.length
      : 0,

    trades,
  };

  return results;
}

// ============================================================================
// OUTPUT RESULTS
// ============================================================================

function printResults(results: TestResults) {
  console.log('\n' + '='.repeat(100));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(100));

  console.log(`\n📊 SIGNAL ANALYSIS:`);
  console.log(`  Total classic signals: ${results.totalClassicSignals}`);
  console.log(`  Early entry possible: ${results.earlyEntryPossible} (${results.earlyEntryPossiblePct.toFixed(1)}%)`);

  console.log(`\n💰 ENTRY PRICE IMPROVEMENT (early vs classic):`);
  console.log(`  Average: ${results.avgEntryImprovement >= 0 ? '+' : ''}${results.avgEntryImprovement.toFixed(3)}%`);
  console.log(`  Median:  ${results.medianEntryImprovement >= 0 ? '+' : ''}${results.medianEntryImprovement.toFixed(3)}%`);
  console.log(`  Max:     ${results.maxEntryImprovement >= 0 ? '+' : ''}${results.maxEntryImprovement.toFixed(3)}%`);

  console.log(`\n📈 PNL COMPARISON:`);
  console.log(`  Classic total PnL: ${results.classicTotalPnl >= 0 ? '+' : ''}${results.classicTotalPnl.toFixed(2)}%`);
  console.log(`  Early total PnL:   ${results.earlyTotalPnl >= 0 ? '+' : ''}${results.earlyTotalPnl.toFixed(2)}% (on ${results.earlyEntryPossible} trades)`);
  console.log(`  Normalized comparison: Early entry adds ${results.pnlImprovement >= 0 ? '+' : ''}${results.pnlImprovement.toFixed(2)}% PnL`);

  console.log(`\n🎯 WIN RATE:`);
  console.log(`  Classic: ${results.classicWinRate.toFixed(1)}%`);
  console.log(`  Early:   ${results.earlyWinRate.toFixed(1)}%`);

  // ========== FALSE SIGNALS (CRITICAL) ==========
  console.log('\n' + '='.repeat(100));
  console.log('⚠️  FALSE SIGNALS ANALYSIS (Wick Traps)');
  console.log('='.repeat(100));
  console.log(`\n These are cases where EARLY entry would trigger but CLASSIC would NOT.`);
  console.log(` If we enter on these, we're entering on "false breakouts".\n`);

  console.log(`  Total false signals detected: ${results.falseSignalCount}`);
  console.log(`  False signal win rate: ${results.falseSignalWinRate.toFixed(1)}%`);
  console.log(`  False signal avg PnL: ${results.falseSignalAvgPnl >= 0 ? '+' : ''}${results.falseSignalAvgPnl.toFixed(2)}%`);

  if (results.falseSignalCount > 0) {
    // Show worst false signals
    const worstFalseSignals = results.falseSignals
      .sort((a, b) => a.earlyPnlPct - b.earlyPnlPct)
      .slice(0, 10);

    console.log('\n  Worst 10 False Signals (would have been losers):');
    console.log('  ' + 'Symbol'.padEnd(15) + 'Date'.padEnd(20) + 'Entry'.padEnd(12) + 'Exit'.padEnd(12) + 'PnL'.padEnd(12) + 'Exit Reason');
    console.log('  ' + '-'.repeat(85));

    for (const f of worstFalseSignals) {
      const pnlStr = f.earlyPnlPct >= 0 ? `+${f.earlyPnlPct.toFixed(2)}%` : `${f.earlyPnlPct.toFixed(2)}%`;
      console.log(
        '  ' +
        f.symbol.replace('/USDT:USDT', '').padEnd(15) +
        f.entryTime.slice(0, 16).padEnd(20) +
        `$${f.earlyEntryPrice.toFixed(4)}`.padEnd(12) +
        `$${f.earlyExitPrice.toFixed(4)}`.padEnd(12) +
        pnlStr.padEnd(12) +
        f.earlyExitReason
      );
    }
  }

  // Show top 10 best early entry improvements
  const sortedByImprovement = results.trades
    .filter(t => t.earlyEntryPossible && t.entryPriceImprovement !== null)
    .sort((a, b) => (b.entryPriceImprovement || 0) - (a.entryPriceImprovement || 0))
    .slice(0, 10);

  if (sortedByImprovement.length > 0) {
    console.log('\n' + '='.repeat(100));
    console.log('TOP 10 BEST EARLY ENTRIES');
    console.log('='.repeat(100));
    console.log('\n' + 'Symbol'.padEnd(15) + 'Date'.padEnd(20) + 'Entry Δ'.padEnd(12) + 'Classic PnL'.padEnd(14) + 'Early PnL'.padEnd(14) + 'Δ PnL');
    console.log('-'.repeat(90));

    for (const t of sortedByImprovement) {
      console.log(
        t.symbol.replace('/USDT:USDT', '').padEnd(15) +
        t.entryTime.slice(0, 16).padEnd(20) +
        `+${t.entryPriceImprovement?.toFixed(2)}%`.padEnd(12) +
        `${t.classicPnlPct >= 0 ? '+' : ''}${t.classicPnlPct.toFixed(2)}%`.padEnd(14) +
        `${t.earlyPnlPct! >= 0 ? '+' : ''}${t.earlyPnlPct?.toFixed(2)}%`.padEnd(14) +
        `${t.pnlImprovement! >= 0 ? '+' : ''}${t.pnlImprovement?.toFixed(2)}%`
      );
    }
  }

  // Show cases where early entry would have been WORSE
  const earlyWorse = results.trades.filter(
    t => t.earlyEntryPossible && t.pnlImprovement !== null && t.pnlImprovement < -0.5
  );

  if (earlyWorse.length > 0) {
    console.log('\n' + '='.repeat(100));
    console.log(`⚠️ WARNING: ${earlyWorse.length} trades where early entry was WORSE (>0.5% PnL loss)`);
    console.log('='.repeat(100));

    const worst5 = earlyWorse.sort((a, b) => (a.pnlImprovement || 0) - (b.pnlImprovement || 0)).slice(0, 5);
    console.log('\n' + 'Symbol'.padEnd(15) + 'Date'.padEnd(20) + 'Classic PnL'.padEnd(14) + 'Early PnL'.padEnd(14) + 'Δ PnL');
    console.log('-'.repeat(80));

    for (const t of worst5) {
      console.log(
        t.symbol.replace('/USDT:USDT', '').padEnd(15) +
        t.entryTime.slice(0, 16).padEnd(20) +
        `${t.classicPnlPct >= 0 ? '+' : ''}${t.classicPnlPct.toFixed(2)}%`.padEnd(14) +
        `${t.earlyPnlPct! >= 0 ? '+' : ''}${t.earlyPnlPct?.toFixed(2)}%`.padEnd(14) +
        `${t.pnlImprovement! >= 0 ? '+' : ''}${t.pnlImprovement?.toFixed(2)}%`
      );
    }
  }

  // VERDICT
  console.log('\n' + '='.repeat(100));
  console.log('VERDICT');
  console.log('='.repeat(100));

  // Check for false signal danger
  const falseSignalRatio = results.falseSignalCount / (results.totalClassicSignals + results.falseSignalCount);
  const falseSignalDanger = results.falseSignalCount > 10 && results.falseSignalWinRate < 45;

  if (falseSignalDanger) {
    console.log('\n❌ DANGER: TOO MANY FALSE SIGNALS (Wick Traps)');
    console.log(`   - ${results.falseSignalCount} false signals detected (${(falseSignalRatio * 100).toFixed(1)}% of potential entries)`);
    console.log(`   - False signal win rate: ${results.falseSignalWinRate.toFixed(1)}% (poor)`);
    console.log(`   - False signal avg PnL: ${results.falseSignalAvgPnl.toFixed(2)}%`);
    console.log(`   - DO NOT USE: Would enter on breakouts that reverse`);
    console.log(`   - RECOMMENDATION: Keep using classic candle close entry`);
  } else if (results.avgEntryImprovement > 0.1 && results.earlyWinRate >= results.classicWinRate - 2 && !falseSignalDanger) {
    console.log('\n✅ EARLY ENTRY SHOWS PROMISE:');
    console.log(`   - Average ${results.avgEntryImprovement.toFixed(2)}% better entry price`);
    console.log(`   - Win rate maintained (${results.earlyWinRate.toFixed(1)}% vs ${results.classicWinRate.toFixed(1)}%)`);
    if (results.falseSignalCount > 0) {
      console.log(`   - ⚠️ ${results.falseSignalCount} false signals detected but manageable (${results.falseSignalWinRate.toFixed(1)}% WR)`);
    }
    console.log(`   - RECOMMENDATION: Consider implementing with strict volume filter`);
  } else if (results.avgEntryImprovement > 0) {
    console.log('\n⚠️ MARGINAL IMPROVEMENT:');
    console.log(`   - Small entry improvement (${results.avgEntryImprovement.toFixed(3)}%)`);
    console.log(`   - May not be worth the complexity`);
    if (results.falseSignalCount > 0) {
      console.log(`   - ${results.falseSignalCount} false signals add risk`);
    }
  } else {
    console.log('\n❌ NO IMPROVEMENT DETECTED:');
    console.log(`   - Early entry does not improve results`);
    console.log(`   - Classic candle close entry remains optimal`);
  }

  // Show NET IMPACT if we used early entry for ALL possible cases
  if (results.earlyEntryPossible > 0 || results.falseSignalCount > 0) {
    console.log('\n' + '='.repeat(100));
    console.log('NET IMPACT ANALYSIS (if we switched to early entry)');
    console.log('='.repeat(100));

    const totalEarlyTrades = results.earlyEntryPossible + results.falseSignalCount;
    const totalEarlyPnl = results.earlyTotalPnl + (results.falseSignalCount * results.falseSignalAvgPnl);
    const avgEarlyPnl = totalEarlyPnl / totalEarlyTrades;

    const classicAvgPnl = results.classicTotalPnl / results.totalClassicSignals;

    console.log(`\n  Classic approach: ${results.totalClassicSignals} trades, avg PnL ${classicAvgPnl.toFixed(2)}%`);
    console.log(`  Early approach: ${totalEarlyTrades} trades (${results.earlyEntryPossible} valid + ${results.falseSignalCount} false signals)`);
    console.log(`  Early avg PnL: ${avgEarlyPnl.toFixed(2)}%`);

    const netDiff = avgEarlyPnl - classicAvgPnl;
    if (netDiff > 0.1) {
      console.log(`\n  📈 NET BENEFIT: +${netDiff.toFixed(2)}% per trade on average`);
    } else if (netDiff < -0.1) {
      console.log(`\n  📉 NET LOSS: ${netDiff.toFixed(2)}% per trade on average`);
    } else {
      console.log(`\n  ➡️ NEUTRAL: Similar performance (~${netDiff.toFixed(2)}% difference)`);
    }
  }
}

// ============================================================================
// RUN
// ============================================================================

async function main() {
  try {
    const results = await runTest();
    printResults(results);
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

main();
