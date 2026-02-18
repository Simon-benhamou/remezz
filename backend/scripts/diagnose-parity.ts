/**
 * DIAGNOSTIC PARITY: Tests the parity system end-to-end
 *
 * Mode 1 (default): Runs a short backtest, takes the first trade,
 * then runs the parity verification on it — shows every step.
 *
 * Mode 2 (--db): Uses a real trade from the database.
 *
 * Usage:
 *   npx tsx scripts/diagnose-parity.ts
 *   npx tsx scripts/diagnose-parity.ts --db          # use real DB trade
 *   npx tsx scripts/diagnose-parity.ts --db --id=xxx # specific trade
 */

import { PrismaClient } from '@prisma/client';
import { runBacktest, type BacktestResult, type BacktestTrade } from '../src/services/backtestService.js';
import { checkMomentumSignal, CANDLE_15M_MS, MomentumConfig, calcSMA } from '../src/strategies/momentumSimple.js';
import { preloadMarkets } from '../src/exchange/ccxtClient.js';
import { normalizeToFamily } from '../src/types/exitReasons.js';

const prisma = new PrismaClient();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ============================================================================
// STEP 1: Get a trade to test (from BT or DB)
// ============================================================================

async function getTradeFromBacktest(): Promise<{
  symbol: string;
  side: 'long' | 'short';
  entryTs: number;      // candle OPEN timestamp (like V5.46 stores)
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  roiPct: number;
  durationMin: number;
  leverage: number;
}> {
  console.log('\n🔍 STEP 1: Running backtest to find a trade...');

  // Use last 30 days
  const endDate = new Date();
  const startDate = new Date(Date.now() - 20 * DAY_MS);
  const dataStartDate = new Date(Date.now() - 30 * DAY_MS);

  const symbols = ['DOGE/USDT:USDT', 'SUI/USDT:USDT', 'XRP/USDT:USDT'];

  const result = await runBacktest({
    startDate,
    endDate,
    dataStartDate,
    initialCapital: 2000,
    symbols,
    leverage: 5,
  });

  console.log(`  → ${result.trades.length} trades found in backtest`);

  if (result.trades.length === 0) {
    throw new Error('No trades found in backtest — try different dates or symbols');
  }

  // Take the first trade
  const bt = result.trades[0];
  const entryTimestamp = new Date(bt.entryTime).getTime();

  // In the backtest, entryTime is calculated via calculateRealisticHoldMinutes
  // which uses candle close time (entryCandle.timestamp + 15min).
  // But in live (V5.46), entryTs = lastCandle.timestamp (candle OPEN time).
  // So we simulate what V5.46 stores: candle OPEN time = close - 15min
  const entryTsOpenTime = Math.floor(entryTimestamp / CANDLE_15M_MS) * CANDLE_15M_MS;
  // If entryTimestamp is already on a 15m boundary (= close time), go back one candle
  // Actually, backtest entry uses entryCandle.timestamp + candleDurationMs as close time
  // The candle OPEN time = floor of that minus 15 min
  // Let me just take the floor to nearest 15m

  console.log(`  → Using trade: ${bt.symbol} ${bt.side}`);
  console.log(`    Entry: ${new Date(entryTimestamp).toISOString()} (BT close time)`);
  console.log(`    Entry (as open time): ${new Date(entryTsOpenTime).toISOString()}`);
  console.log(`    Exit: ${new Date(bt.exitTime).toISOString()} reason=${bt.exitReason}`);
  console.log(`    PnL: ${bt.netPnlPct.toFixed(2)}%`);

  return {
    symbol: bt.symbol,
    side: bt.side as 'long' | 'short',
    entryTs: entryTsOpenTime,  // Simulate what V5.46 stores
    exitTs: new Date(bt.exitTime).getTime(),
    entryPrice: bt.entryPrice,
    exitPrice: bt.exitPrice,
    exitReason: bt.exitReason,
    roiPct: bt.netPnlPct / 5,  // approximate
    durationMin: bt.holdMinutes,
    leverage: 5,
  };
}

async function getTradeFromDb(tradeId?: string): Promise<{
  symbol: string;
  side: 'long' | 'short';
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  roiPct: number;
  durationMin: number;
  leverage: number;
}> {
  const trade = tradeId
    ? await prisma.trade.findUnique({ where: { id: tradeId } })
    : await prisma.trade.findFirst({ orderBy: { exitTs: 'desc' } });

  if (!trade) throw new Error('No trades in DB');

  console.log(`  → DB trade: ${trade.symbol} ${trade.positionSide}`);
  console.log(`    Entry: ${trade.entryTs.toISOString()}`);
  console.log(`    Exit: ${trade.exitTs.toISOString()} reason=${trade.exitReason}`);

  return {
    symbol: trade.symbol,
    side: trade.positionSide.toLowerCase() as 'long' | 'short',
    entryTs: trade.entryTs.getTime(),
    exitTs: trade.exitTs.getTime(),
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    exitReason: trade.exitReason || 'UNKNOWN',
    roiPct: trade.roiPct || 0,
    durationMin: trade.durationMinutes || 0,
    leverage: trade.leverage || 5,
  };
}

// ============================================================================
// STEP 2: Reproduce parity verification with verbose logging
// ============================================================================

async function runParityDiagnostic(trade: Awaited<ReturnType<typeof getTradeFromBacktest>>) {
  console.log('\n' + '═'.repeat(70));
  console.log('🔬 STEP 2: Reproducing parity verification (verbose)');
  console.log('═'.repeat(70));

  const { symbol, side, entryTs, exitTs, entryPrice, leverage } = trade;

  // === A. Compute forcedEntryTimestamp (same logic as parityVerificationServiceV2.ts) ===
  // V5.107: No +CANDLE_15M_MS — trade.entryTs is wall-clock (Date.now()), floor gives close boundary
  const forcedEntryTimestamp = Math.floor(entryTs / CANDLE_15M_MS) * CANDLE_15M_MS;

  console.log(`\n📐 A. Forced entry timestamp computation:`);
  console.log(`  entryTs (from DB/BT)      = ${entryTs} → ${new Date(entryTs).toISOString()}`);
  console.log(`  floor to 15m              = ${Math.floor(entryTs / CANDLE_15M_MS) * CANDLE_15M_MS} → ${new Date(Math.floor(entryTs / CANDLE_15M_MS) * CANDLE_15M_MS).toISOString()}`);
  console.log(`  + CANDLE_15M_MS (${CANDLE_15M_MS}ms) = ${forcedEntryTimestamp} → ${new Date(forcedEntryTimestamp).toISOString()}`);
  console.log(`  Interpretation: backtest should detect signal at this BTC candle timestamp`);

  // === B. Run backtest with forcedEntry ===
  console.log(`\n📊 B. Running parity backtest...`);
  const btStartDate = new Date(entryTs - 3 * DAY_MS);
  const btEndDate = new Date(exitTs + 4 * HOUR_MS);
  const btDataStartDate = new Date(entryTs - 11 * DAY_MS);

  console.log(`  startDate    = ${btStartDate.toISOString()}`);
  console.log(`  endDate      = ${btEndDate.toISOString()}`);
  console.log(`  dataStartDate = ${btDataStartDate.toISOString()}`);

  let btResult: BacktestResult;
  try {
    btResult = await runBacktest({
      startDate: btStartDate,
      endDate: btEndDate,
      dataStartDate: btDataStartDate,
      initialCapital: 2000,
      symbols: [symbol],
      leverage,
      parityMode: true,
      forcedEntry: {
        symbol,
        side,
        entryTimestamp: forcedEntryTimestamp,
        entryPrice,
      },
    });
  } catch (err: unknown) {
    console.error(`  ❌ BACKTEST FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // === C. Analyze backtest results ===
  console.log(`\n📋 C. Backtest results:`);
  console.log(`  Trades produced: ${btResult.trades.length}`);
  console.log(`  Valid signals: ${btResult.validSignals?.length || 0}`);

  if (btResult.validSignals && btResult.validSignals.length > 0) {
    console.log(`  Signal details:`);
    for (const sig of btResult.validSignals) {
      const tsStr = new Date(sig.timestamp).toISOString();
      console.log(`    ${sig.symbol} ${sig.side} @ ${tsStr} reason=${sig.reason || 'valid'}`);
    }
  }

  // Check for NO_SIGNAL_AT_FORCED_TIME
  const noSignalEntry = btResult.validSignals?.find(
    s => s.symbol === symbol && s.reason === 'NO_SIGNAL_AT_FORCED_TIME'
  );
  const hadValidSignal = !noSignalEntry;

  console.log(`\n🎯 D. Signal verdict:`);
  console.log(`  NO_SIGNAL marker found: ${!!noSignalEntry}`);
  console.log(`  hadValidSignal: ${hadValidSignal}`);

  if (noSignalEntry) {
    console.log(`  ⚠️  The backtest could NOT find a valid signal at the forced entry time!`);
    console.log(`     This is a NO_SIGNAL mismatch.`);
  }

  // === E. Check the BT trade ===
  const btTrade = btResult.trades[0] ?? null;
  if (btTrade) {
    console.log(`\n📈 E. Backtest trade details:`);
    console.log(`  Entry: ${btTrade.entryTime} @ ${btTrade.entryPrice.toFixed(4)}`);
    console.log(`  Exit:  ${btTrade.exitTime} @ ${btTrade.exitPrice.toFixed(4)}`);
    console.log(`  Reason: ${btTrade.exitReason}`);
    console.log(`  PnL: ${btTrade.netPnlPct.toFixed(2)}%`);
    console.log(`  Duration: ${btTrade.holdMinutes}min`);

    // Compare exit reasons
    const liveExitFamily = normalizeToFamily(trade.exitReason);
    const btExitFamily = normalizeToFamily(btTrade.exitReason);
    const exitMatch = liveExitFamily === btExitFamily;

    console.log(`\n🔄 F. Comparison:`);
    console.log(`  Live exit reason:     ${trade.exitReason} → family: ${liveExitFamily}`);
    console.log(`  BT exit reason:       ${btTrade.exitReason} → family: ${btExitFamily}`);
    console.log(`  Exit reason match:    ${exitMatch ? '✅' : '❌'}`);

    const livePnl = trade.roiPct * trade.leverage;
    const pnlDiff = Math.abs(livePnl - btTrade.netPnlPct);
    console.log(`  Live PnL:             ${livePnl.toFixed(2)}%`);
    console.log(`  BT PnL:               ${btTrade.netPnlPct.toFixed(2)}%`);
    console.log(`  PnL diff:             ${pnlDiff.toFixed(2)}% ${pnlDiff > 3 ? '❌ >3%' : '✅ ≤3%'}`);

    const durationDiff = Math.abs(trade.durationMin - btTrade.holdMinutes);
    const durationTolerance = Math.max(30, trade.durationMin * 0.2);
    console.log(`  Live duration:        ${trade.durationMin}min`);
    console.log(`  BT duration:          ${btTrade.holdMinutes}min`);
    console.log(`  Duration diff:        ${durationDiff}min (tol: ${durationTolerance.toFixed(0)}min) ${durationDiff <= durationTolerance ? '✅' : '❌'}`);

    // Final category
    let category: string;
    if (!hadValidSignal) category = 'NO_SIGNAL';
    else if (!exitMatch) category = 'EXIT_MISMATCH';
    else if (pnlDiff > 3) category = 'PNL_VARIANCE';
    else if (durationDiff > durationTolerance) category = 'DURATION_MISMATCH';
    else category = 'MATCH';

    console.log(`\n${'🏆'.repeat(3)} FINAL CATEGORY: ${category} ${'🏆'.repeat(3)}`);
  } else {
    console.log(`\n  ❌ No backtest trade produced!`);
  }

  // === G. Additional debug: run checkMomentumSignal directly ===
  console.log('\n' + '═'.repeat(70));
  console.log('🔬 STEP 3: Direct signal check at forced entry time');
  console.log('═'.repeat(70));

  // We need to load the candle data to do this
  // Let's run another backtest in normal mode (not forced) to see if there's a signal near the entry
  console.log(`\nRunning normal backtest (no forcedEntry) around the entry time to find nearby signals...`);

  const nearbyResult = await runBacktest({
    startDate: new Date(entryTs - 2 * DAY_MS),
    endDate: new Date(entryTs + 2 * DAY_MS),
    dataStartDate: new Date(entryTs - 12 * DAY_MS),
    initialCapital: 2000,
    symbols: [symbol],
    leverage,
    parityMode: true,  // Collect all signals
  });

  console.log(`\n  Nearby valid signals (parityMode, ±2 days around entry):`);
  if (nearbyResult.validSignals && nearbyResult.validSignals.length > 0) {
    // Find signals within ±2 candles of entry
    const entryCandle = Math.floor(entryTs / CANDLE_15M_MS) * CANDLE_15M_MS;
    const nearbySignals = nearbyResult.validSignals
      .filter(s => s.symbol === symbol)
      .sort((a, b) => Math.abs(a.timestamp - entryCandle) - Math.abs(b.timestamp - entryCandle));

    console.log(`  Total signals for ${symbol}: ${nearbySignals.length}`);
    console.log(`  Entry candle (open): ${new Date(entryCandle).toISOString()}`);
    console.log(`\n  Closest 10 signals:`);
    for (const sig of nearbySignals.slice(0, 10)) {
      const diffCandles = (sig.timestamp - entryCandle) / CANDLE_15M_MS;
      const marker = diffCandles === 0 ? ' ← EXACT MATCH' :
                     Math.abs(diffCandles) <= 1 ? ' ← ±1 candle' : '';
      console.log(`    ${sig.side.padEnd(5)} @ ${new Date(sig.timestamp).toISOString()} (${diffCandles >= 0 ? '+' : ''}${diffCandles} candles)${marker}`);
    }

    // Check: is there a signal at the EXACT entry candle?
    const exactMatch = nearbySignals.find(s => s.timestamp === entryCandle && s.side === side);
    if (exactMatch) {
      console.log(`\n  ✅ Exact signal found at entry candle for ${side}!`);
      console.log(`     → The normal backtest DOES find the signal.`);
      console.log(`     → If parity says NO_SIGNAL, the forcedEntry timing is wrong.`);
    } else {
      // Check if there's a signal at the close time (entry + 15min)
      const closeMatch = nearbySignals.find(s => s.timestamp === entryCandle + CANDLE_15M_MS && s.side === side);
      if (closeMatch) {
        console.log(`\n  ⚠️  Signal found at candle AFTER entry (close time + 1 candle).`);
        console.log(`     → entry candle open: ${new Date(entryCandle).toISOString()}`);
        console.log(`     → signal at: ${new Date(closeMatch.timestamp).toISOString()}`);
        console.log(`     → Suggests forcedEntryTimestamp might need +2 candles, not +1.`);
      } else {
        console.log(`\n  ❌ No ${side} signal found at or near the entry candle!`);
        console.log(`     → The backtest genuinely doesn't produce a signal here.`);
        console.log(`     → This is a real data/config divergence (not a timing bug).`);
      }
    }
  } else {
    console.log(`  No valid signals found in ±2 day window!`);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const useDb = args.includes('--db');
  const idArg = args.find(a => a.startsWith('--id='));
  const tradeId = idArg ? idArg.split('=')[1] : undefined;

  console.log('═'.repeat(70));
  console.log('  PARITY DIAGNOSTIC TOOL');
  console.log('═'.repeat(70));

  await preloadMarkets();

  let trade: Awaited<ReturnType<typeof getTradeFromBacktest>>;

  if (useDb) {
    trade = await getTradeFromDb(tradeId);
  } else {
    trade = await getTradeFromBacktest();
  }

  await runParityDiagnostic(trade);

  await prisma.$disconnect();
  console.log('\nDone.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
