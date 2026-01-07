/**
 * 🔬 Detailed Parity Analysis for ADA and SEI
 * 
 * Checks if trades match on:
 * - Same entry candle (15m)
 * - Same exit candle (15m)  
 * - Same exit reason
 * 
 * PnL differences are expected due to live execution (slippage, fees, timing)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CANDLE_15M_MS = 15 * 60 * 1000;

// Round timestamp to 15m candle boundary
function getCandleTime(ts) {
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime();
  return Math.floor(t / CANDLE_15M_MS) * CANDLE_15M_MS;
}

function formatTs(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

function normalizeExitReason(reason) {
  if (!reason) return 'UNKNOWN';
  const upper = reason.toUpperCase();
  const mappings = {
    'TRAIL': 'TRAIL',
    'TRAILING': 'TRAIL',
    'TRAILING_STOP': 'TRAIL',
    'SL': 'SL',
    'STOP_LOSS': 'SL',
    'STOPLOSS': 'SL',
    'TIME': 'TIME',
    'MAX_HOLD': 'TIME',
    'REGIME_CHANGE': 'REGIME_CHANGE',
    'MOMENTUM_REVERSAL': 'MOMENTUM_REVERSAL',
    'STAGNANT_TRADE': 'STAGNANT_TRADE',
    'STAGNANT': 'STAGNANT_TRADE',
    'TP': 'TP',
    'TAKE_PROFIT': 'TP',
  };
  return mappings[upper] || upper;
}

async function main() {
  console.log('='.repeat(80));
  console.log('🔬 DETAILED PARITY ANALYSIS: ADA & SEI');
  console.log('='.repeat(80));
  console.log();

  // Get recent trades for ADA and SEI
  const trades = await prisma.trade.findMany({
    where: {
      symbol: {
        in: ['ADA/USDT:USDT', 'SEI/USDT:USDT']
      },
      exitTs: {
        gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
      }
    },
    include: {
      session: true
    },
    orderBy: { exitTs: 'desc' }
  });

  console.log(`Found ${trades.length} trades for ADA/SEI in last 7 days\n`);

  // Get parity results for these trades
  const parityResults = await prisma.tradeParityResult.findMany({
    where: {
      tradeId: { in: trades.map(t => t.id) }
    }
  });

  const parityByTradeId = new Map(parityResults.map(p => [p.tradeId, p]));

  // Group trades by symbol
  const bySymbol = {};
  for (const trade of trades) {
    const sym = trade.symbol.replace('/USDT:USDT', '');
    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push(trade);
  }

  // Analyze each symbol
  for (const [symbol, symbolTrades] of Object.entries(bySymbol)) {
    console.log('─'.repeat(80));
    console.log(`📊 ${symbol} - ${symbolTrades.length} trades`);
    console.log('─'.repeat(80));

    for (let i = 0; i < Math.min(symbolTrades.length, 4); i++) { // Last 4 trades per symbol
      const trade = symbolTrades[i];
      const parity = parityByTradeId.get(trade.id);
      
      console.log();
      console.log(`  Trade #${i + 1}: ${trade.positionSide.toUpperCase()} | ${trade.session?.mode || 'unknown'} mode`);
      console.log(`  ${'─'.repeat(70)}`);
      
      // Live data
      const liveEntryCandle = getCandleTime(trade.entryTs);
      const liveExitCandle = getCandleTime(trade.exitTs);
      const liveExitReason = normalizeExitReason(trade.exitReason);
      const livePnl = trade.roiPct || 0;
      const liveHoldMinutes = Math.round((trade.exitTs - trade.entryTs) / 60000);
      
      console.log(`  📍 LIVE/PAPER:`);
      console.log(`     Entry:  ${formatTs(trade.entryTs)} (candle: ${formatTs(liveEntryCandle)})`);
      console.log(`     Exit:   ${formatTs(trade.exitTs)} (candle: ${formatTs(liveExitCandle)})`);
      console.log(`     Reason: ${liveExitReason}`);
      console.log(`     PnL:    ${livePnl >= 0 ? '+' : ''}${livePnl.toFixed(3)}%`);
      console.log(`     Hold:   ${liveHoldMinutes}m (${(liveHoldMinutes/15).toFixed(1)} candles)`);

      if (parity) {
        // Backtest data
        const btEntryCandle = parity.btEntryTs ? getCandleTime(parity.btEntryTs) : null;
        const btExitCandle = parity.btExitTs ? getCandleTime(parity.btExitTs) : null;
        const btExitReason = normalizeExitReason(parity.btExitReason);
        const btPnl = parity.btPnlPct;
        const btHoldMinutes = parity.btEntryTs && parity.btExitTs 
          ? Math.round((new Date(parity.btExitTs) - new Date(parity.btEntryTs)) / 60000)
          : null;

        console.log();
        console.log(`  🔄 BACKTEST:`);
        if (parity.btEntryTs) {
          console.log(`     Entry:  ${formatTs(parity.btEntryTs)} (candle: ${formatTs(btEntryCandle)})`);
          console.log(`     Exit:   ${formatTs(parity.btExitTs)} (candle: ${formatTs(btExitCandle)})`);
          console.log(`     Reason: ${btExitReason}`);
          console.log(`     PnL:    ${btPnl >= 0 ? '+' : ''}${btPnl?.toFixed(3)}%`);
          console.log(`     Hold:   ${btHoldMinutes}m (${(btHoldMinutes/15).toFixed(1)} candles)`);
        } else {
          console.log(`     ❌ No matching backtest trade found!`);
        }

        // Comparison
        console.log();
        console.log(`  ⚖️  COMPARISON:`);
        
        const sameEntryCandle = btEntryCandle === liveEntryCandle;
        const sameExitCandle = btExitCandle === liveExitCandle;
        const sameReason = btExitReason === liveExitReason;
        const pnlDiff = btPnl != null ? (livePnl - btPnl) : null;

        console.log(`     Entry Candle:  ${sameEntryCandle ? '✅ SAME' : '❌ DIFFERENT'}`);
        console.log(`     Exit Candle:   ${sameExitCandle ? '✅ SAME' : '❌ DIFFERENT'}`);
        console.log(`     Exit Reason:   ${sameReason ? '✅ SAME' : `❌ DIFFERENT (${liveExitReason} vs ${btExitReason})`}`);
        
        if (pnlDiff != null) {
          const pnlDiffAbs = Math.abs(pnlDiff);
          console.log(`     PnL Diff:      ${pnlDiff >= 0 ? '+' : ''}${pnlDiff.toFixed(3)}% (live execution variance)`);
        }

        // Verdict based on YOUR criteria
        const isMatch = sameEntryCandle && sameExitCandle && sameReason;
        console.log();
        if (isMatch) {
          console.log(`  ✅ VERDICT: PARITY MATCH (entry/exit/reason identical)`);
          if (pnlDiff != null && Math.abs(pnlDiff) > 0.1) {
            console.log(`     ℹ️  PnL diff of ${pnlDiff.toFixed(3)}% is expected from live execution`);
          }
        } else {
          console.log(`  ❌ VERDICT: PARITY MISMATCH`);
          if (!sameEntryCandle) console.log(`     ⚠️  Entry candle differs`);
          if (!sameExitCandle) console.log(`     ⚠️  Exit candle differs`);
          if (!sameReason) console.log(`     ⚠️  Exit reason differs`);
        }

      } else {
        console.log();
        console.log(`  ⚠️  No parity verification run yet for this trade.`);
        console.log(`     Run "Verify All" in the Reports page to check.`);
      }
    }
    console.log();
  }

  // Summary
  console.log('='.repeat(80));
  console.log('📋 SUMMARY');
  console.log('='.repeat(80));
  
  let totalChecked = 0;
  let totalMatched = 0;
  
  for (const trade of trades) {
    const parity = parityByTradeId.get(trade.id);
    if (parity && parity.btEntryTs) {
      totalChecked++;
      const liveEntryCandle = getCandleTime(trade.entryTs);
      const liveExitCandle = getCandleTime(trade.exitTs);
      const btEntryCandle = getCandleTime(parity.btEntryTs);
      const btExitCandle = getCandleTime(parity.btExitTs);
      const sameEntry = liveEntryCandle === btEntryCandle;
      const sameExit = liveExitCandle === btExitCandle;
      const sameReason = normalizeExitReason(trade.exitReason) === normalizeExitReason(parity.btExitReason);
      
      if (sameEntry && sameExit && sameReason) {
        totalMatched++;
      }
    }
  }

  console.log(`\nTrades analyzed: ${trades.length}`);
  console.log(`With parity data: ${totalChecked}`);
  console.log(`Entry/Exit/Reason match: ${totalMatched}/${totalChecked} (${totalChecked > 0 ? (totalMatched/totalChecked*100).toFixed(1) : 0}%)`);
  console.log();
  console.log('Note: PnL differences are EXPECTED due to live execution factors');
  console.log('      (slippage, exact fill price, fee variations, micro-timing)');
  console.log();

  await prisma.$disconnect();
}

main().catch(console.error);
