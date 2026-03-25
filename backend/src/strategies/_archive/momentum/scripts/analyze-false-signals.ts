/**
 * Analyze False Signals - Entries that don't follow momentum
 *
 * Goal: Identify common patterns in trades that end as:
 * - STAGNANT_TRADE (price doesn't move in our direction)
 * - SL (stop loss hit)
 *
 * We want to find filtering criteria that would have rejected these
 * entries WITHOUT affecting winning trades.
 */

import { runBacktest, type BacktestTrade } from '../src/services/backtestService.js';
import * as ccxt from 'ccxt';

interface TradeWithContext extends BacktestTrade {
  // Entry context
  entryRocPct: number;          // Rate of change at entry
  entryVolRatio: number;        // Volume vs avg at entry
  entryBbPosition: number;      // Position in BB (0=lower, 1=upper)
  entryConsecCandles: number;   // Consecutive candles in direction
  entryAtrPct: number;          // ATR as % of price
  entryHourUtc: number;         // Hour of entry (UTC)
  entryDayOfWeek: number;       // Day of week (0=Sunday)

  // BTC context at entry
  btcRoc1hPct: number;          // BTC 1h ROC
  btcVolatility: number;        // BTC recent volatility

  // Candle pattern at entry
  entryCandleBodyPct: number;   // Body as % of range
  entryCandleWickPct: number;   // Wick opposite to direction
  entryGapFromMa20Pct: number;  // Distance from MA20

  // Market regime
  recentWinRate: number;        // Win rate of last 10 trades
  recentAvgPnl: number;         // Avg PnL of last 10 trades
}

async function fetchCandlesForAnalysis(
  exchange: ccxt.binanceusdm,
  symbol: string,
  startDate: Date,
  endDate: Date
): Promise<Map<number, any>> {
  const candles = new Map<number, any>();
  let since = startDate.getTime();
  const until = endDate.getTime();

  while (since < until) {
    const ohlcv = await exchange.fetchOHLCV(symbol, '15m', since, 1000);
    if (!ohlcv || ohlcv.length === 0) break;

    for (const c of ohlcv) {
      if (c[0] as number >= until) break;
      candles.set(c[0] as number, {
        timestamp: c[0],
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5],
      });
    }

    since = ohlcv[ohlcv.length - 1][0] as number + 1;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  return candles;
}

function calcSMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcATR(candles: any[], period: number): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prevC = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - (prevC?.close || c.open)),
      Math.abs(c.low - (prevC?.close || c.open))
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

function calcBB(closes: number[], period: number, stdDev: number): { upper: number; middle: number; lower: number } {
  const ma = calcSMA(closes, period);
  if (closes.length < period) return { upper: ma, middle: ma, lower: ma };
  const slice = closes.slice(-period);
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - ma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: ma + stdDev * std,
    middle: ma,
    lower: ma - stdDev * std,
  };
}

async function main() {
  console.log('='.repeat(100));
  console.log('FALSE SIGNAL ANALYSIS');
  console.log('='.repeat(100));

  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();

  const startDate = new Date('2025-01-01T00:00:00Z');
  const endDate = new Date('2026-01-01T00:00:00Z');
  const symbols = ['DOGE/USDT:USDT', 'SUI/USDT:USDT', 'SEI/USDT:USDT'];

  console.log(`\nPeriod: ${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}`);
  console.log(`Symbols: ${symbols.join(', ')}`);

  // Run backtest with NFS_ADAPTIVE
  console.log('\nRunning backtest...');
  const result = await runBacktest({
    startDate,
    endDate,
    initialCapital: 2000,
    symbols,
    leverage: 4.5,
    nfsAdaptiveTrailing: true,
  });

  console.log(`Total trades: ${result.trades.length}`);

  // Categorize trades
  const winners = result.trades.filter(t => t.netPnlPct > 0);
  const losers = result.trades.filter(t => t.netPnlPct <= 0);
  const stagnant = result.trades.filter(t => t.exitReason === 'STAGNANT_TRADE' || t.exitReason === 'STAGNANT_PROFIT_EXIT');
  const stopLoss = result.trades.filter(t => t.exitReason === 'SL');
  const trailing = result.trades.filter(t => t.exitReason.startsWith('TRAIL'));

  console.log(`\n=== TRADE CATEGORIES ===`);
  console.log(`Winners: ${winners.length} (${(winners.length / result.trades.length * 100).toFixed(1)}%)`);
  console.log(`Losers: ${losers.length} (${(losers.length / result.trades.length * 100).toFixed(1)}%)`);
  console.log(`  - STAGNANT: ${stagnant.length}`);
  console.log(`  - SL: ${stopLoss.length}`);
  console.log(`  - TRAIL (losers): ${trailing.filter(t => t.netPnlPct <= 0).length}`);

  // Fetch candle data for context analysis
  console.log('\nFetching candle data for analysis...');
  const candlesBySymbol = new Map<string, Map<number, any>>();
  const btcCandles = await fetchCandlesForAnalysis(exchange, 'BTC/USDT:USDT', startDate, endDate);
  console.log(`BTC: ${btcCandles.size} candles`);

  for (const symbol of symbols) {
    const candles = await fetchCandlesForAnalysis(exchange, symbol, startDate, endDate);
    candlesBySymbol.set(symbol, candles);
    console.log(`${symbol}: ${candles.size} candles`);
  }

  // Analyze each trade's entry context
  console.log('\nAnalyzing entry contexts...');

  const analyzeEntryContext = (trade: BacktestTrade, pastTrades: BacktestTrade[]): TradeWithContext => {
    const candles = candlesBySymbol.get(trade.symbol);
    if (!candles) {
      return trade as TradeWithContext;
    }

    // Find candles before entry
    const entryTs = new Date(trade.entryTime).getTime();
    const candleList = Array.from(candles.values())
      .filter(c => c.timestamp < entryTs)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (candleList.length < 50) {
      return trade as TradeWithContext;
    }

    const recentCandles = candleList.slice(-50);
    const entryCandle = recentCandles[recentCandles.length - 1];
    const closes = recentCandles.map(c => c.close);

    // Calculate indicators at entry
    const prevClose = recentCandles[recentCandles.length - 2]?.close || entryCandle.open;
    const rocPct = ((entryCandle.close - prevClose) / prevClose) * 100;

    const avgVolume = recentCandles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
    const volRatio = entryCandle.volume / avgVolume;

    const bb = calcBB(closes, 20, 2);
    const bbPosition = bb.upper !== bb.lower
      ? (entryCandle.close - bb.lower) / (bb.upper - bb.lower)
      : 0.5;

    const atr = calcATR(recentCandles, 14);
    const atrPct = (atr / entryCandle.close) * 100;

    // Consecutive candles in direction
    let consec = 0;
    for (let i = recentCandles.length - 1; i >= 0; i--) {
      const c = recentCandles[i];
      const isBullish = c.close > c.open;
      const isEntryBullish = trade.side === 'long';
      if (isBullish === isEntryBullish) {
        consec++;
      } else {
        break;
      }
    }

    // Candle pattern
    const bodySize = Math.abs(entryCandle.close - entryCandle.open);
    const candleRange = entryCandle.high - entryCandle.low;
    const bodyPct = candleRange > 0 ? bodySize / candleRange : 0;

    // Wick opposite to direction (bad if large)
    let oppWickPct = 0;
    if (candleRange > 0) {
      if (trade.side === 'long') {
        // For long, upper wick is bad (rejection)
        oppWickPct = (entryCandle.high - Math.max(entryCandle.open, entryCandle.close)) / candleRange;
      } else {
        // For short, lower wick is bad
        oppWickPct = (Math.min(entryCandle.open, entryCandle.close) - entryCandle.low) / candleRange;
      }
    }

    const ma20 = calcSMA(closes, 20);
    const gapFromMa20Pct = ((entryCandle.close - ma20) / ma20) * 100;

    // BTC context
    const btcCandleList = Array.from(btcCandles.values())
      .filter(c => c.timestamp < entryTs)
      .sort((a, b) => a.timestamp - b.timestamp);

    let btcRoc1h = 0;
    let btcVolatility = 0;
    if (btcCandleList.length >= 4) {
      const btcRecent = btcCandleList.slice(-4);
      const btcClose4h = btcRecent[0]?.close || 0;
      const btcCloseNow = btcRecent[btcRecent.length - 1]?.close || 0;
      btcRoc1h = btcClose4h > 0 ? ((btcCloseNow - btcClose4h) / btcClose4h) * 100 : 0;

      // BTC volatility (range as % of price)
      const btcRanges = btcRecent.map(c => (c.high - c.low) / c.close * 100);
      btcVolatility = btcRanges.reduce((a, b) => a + b, 0) / btcRanges.length;
    }

    // Time context
    const entryDate = new Date(trade.entryTime);
    const entryHourUtc = entryDate.getUTCHours();
    const entryDayOfWeek = entryDate.getUTCDay();

    // Recent performance
    const recentTrades = pastTrades.slice(-10);
    const recentWins = recentTrades.filter(t => t.netPnlPct > 0).length;
    const recentWinRate = recentTrades.length > 0 ? recentWins / recentTrades.length : 0.5;
    const recentAvgPnl = recentTrades.length > 0
      ? recentTrades.reduce((s, t) => s + t.netPnlPct, 0) / recentTrades.length
      : 0;

    return {
      ...trade,
      entryRocPct: rocPct,
      entryVolRatio: volRatio,
      entryBbPosition: bbPosition,
      entryConsecCandles: consec,
      entryAtrPct: atrPct,
      entryHourUtc,
      entryDayOfWeek,
      btcRoc1hPct: btcRoc1h,
      btcVolatility,
      entryCandleBodyPct: bodyPct,
      entryCandleWickPct: oppWickPct,
      entryGapFromMa20Pct: gapFromMa20Pct,
      recentWinRate,
      recentAvgPnl,
    };
  };

  // Analyze all trades
  const analyzedTrades: TradeWithContext[] = [];
  for (let i = 0; i < result.trades.length; i++) {
    const trade = result.trades[i];
    const pastTrades = result.trades.slice(0, i);
    const analyzed = analyzeEntryContext(trade, pastTrades);
    analyzedTrades.push(analyzed);
  }

  // Separate winners and losers
  const analyzedWinners = analyzedTrades.filter(t => t.netPnlPct > 0);
  const analyzedLosers = analyzedTrades.filter(t => t.netPnlPct <= 0);
  const analyzedStagnant = analyzedTrades.filter(t =>
    t.exitReason === 'STAGNANT_TRADE' || t.exitReason === 'STAGNANT_PROFIT_EXIT'
  );
  const analyzedSL = analyzedTrades.filter(t => t.exitReason === 'SL');

  // Calculate statistics for each group
  const calcStats = (trades: TradeWithContext[]) => {
    if (trades.length === 0) return null;
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const p25 = (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.25)] || 0;
    };
    const p75 = (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.75)] || 0;
    };

    return {
      count: trades.length,
      avgPnl: avg(trades.map(t => t.netPnlPct)),
      avgRoc: avg(trades.map(t => t.entryRocPct || 0)),
      avgVolRatio: avg(trades.map(t => t.entryVolRatio || 1)),
      avgBbPos: avg(trades.map(t => t.entryBbPosition || 0.5)),
      avgConsec: avg(trades.map(t => t.entryConsecCandles || 0)),
      avgAtrPct: avg(trades.map(t => t.entryAtrPct || 0)),
      avgBodyPct: avg(trades.map(t => t.entryCandleBodyPct || 0)),
      avgWickPct: avg(trades.map(t => t.entryCandleWickPct || 0)),
      avgGapMa20: avg(trades.map(t => t.entryGapFromMa20Pct || 0)),
      avgBtcRoc: avg(trades.map(t => t.btcRoc1hPct || 0)),
      avgBtcVol: avg(trades.map(t => t.btcVolatility || 0)),
      rocP25: p25(trades.map(t => t.entryRocPct || 0)),
      rocP75: p75(trades.map(t => t.entryRocPct || 0)),
      volP25: p25(trades.map(t => t.entryVolRatio || 1)),
      volP75: p75(trades.map(t => t.entryVolRatio || 1)),
    };
  };

  const winnerStats = calcStats(analyzedWinners);
  const loserStats = calcStats(analyzedLosers);
  const stagnantStats = calcStats(analyzedStagnant);
  const slStats = calcStats(analyzedSL);

  // Print comparison
  console.log('\n' + '='.repeat(100));
  console.log('ENTRY CONTEXT COMPARISON: WINNERS vs LOSERS');
  console.log('='.repeat(100));

  const printRow = (label: string, getValue: (s: any) => string) => {
    const w = winnerStats ? getValue(winnerStats) : 'N/A';
    const l = loserStats ? getValue(loserStats) : 'N/A';
    const st = stagnantStats ? getValue(stagnantStats) : 'N/A';
    const sl = slStats ? getValue(slStats) : 'N/A';
    console.log(`${label.padEnd(20)} | ${w.padEnd(12)} | ${l.padEnd(12)} | ${st.padEnd(12)} | ${sl.padEnd(12)}`);
  };

  console.log('\n' + '-'.repeat(85));
  console.log(`${'Metric'.padEnd(20)} | ${'Winners'.padEnd(12)} | ${'Losers'.padEnd(12)} | ${'Stagnant'.padEnd(12)} | ${'SL'.padEnd(12)}`);
  console.log('-'.repeat(85));

  printRow('Count', s => s.count.toString());
  printRow('Avg PnL %', s => s.avgPnl.toFixed(2) + '%');
  printRow('Avg ROC %', s => s.avgRoc.toFixed(3) + '%');
  printRow('Avg Vol Ratio', s => s.avgVolRatio.toFixed(2) + 'x');
  printRow('Avg BB Position', s => s.avgBbPos.toFixed(2));
  printRow('Avg Consec Candles', s => s.avgConsec.toFixed(1));
  printRow('Avg ATR %', s => s.avgAtrPct.toFixed(2) + '%');
  printRow('Avg Body %', s => (s.avgBodyPct * 100).toFixed(1) + '%');
  printRow('Avg Opp Wick %', s => (s.avgWickPct * 100).toFixed(1) + '%');
  printRow('Avg Gap MA20 %', s => s.avgGapMa20.toFixed(2) + '%');
  printRow('Avg BTC ROC 1h', s => s.avgBtcRoc.toFixed(2) + '%');
  printRow('Avg BTC Vol', s => s.avgBtcVol.toFixed(2) + '%');
  console.log('-'.repeat(85));

  // Identify discriminating factors
  console.log('\n' + '='.repeat(100));
  console.log('DISCRIMINATING FACTORS (Winners vs Losers)');
  console.log('='.repeat(100));

  if (winnerStats && loserStats) {
    const factors: { name: string; winnerVal: number; loserVal: number; diff: number; direction: string }[] = [
      { name: 'ROC %', winnerVal: winnerStats.avgRoc, loserVal: loserStats.avgRoc, diff: 0, direction: '' },
      { name: 'Vol Ratio', winnerVal: winnerStats.avgVolRatio, loserVal: loserStats.avgVolRatio, diff: 0, direction: '' },
      { name: 'BB Position', winnerVal: winnerStats.avgBbPos, loserVal: loserStats.avgBbPos, diff: 0, direction: '' },
      { name: 'Consec Candles', winnerVal: winnerStats.avgConsec, loserVal: loserStats.avgConsec, diff: 0, direction: '' },
      { name: 'ATR %', winnerVal: winnerStats.avgAtrPct, loserVal: loserStats.avgAtrPct, diff: 0, direction: '' },
      { name: 'Body %', winnerVal: winnerStats.avgBodyPct, loserVal: loserStats.avgBodyPct, diff: 0, direction: '' },
      { name: 'Opp Wick %', winnerVal: winnerStats.avgWickPct, loserVal: loserStats.avgWickPct, diff: 0, direction: '' },
      { name: 'Gap MA20 %', winnerVal: winnerStats.avgGapMa20, loserVal: loserStats.avgGapMa20, diff: 0, direction: '' },
      { name: 'BTC ROC 1h', winnerVal: winnerStats.avgBtcRoc, loserVal: loserStats.avgBtcRoc, diff: 0, direction: '' },
      { name: 'BTC Vol', winnerVal: winnerStats.avgBtcVol, loserVal: loserStats.avgBtcVol, diff: 0, direction: '' },
    ];

    for (const f of factors) {
      f.diff = Math.abs(f.winnerVal - f.loserVal);
      f.direction = f.winnerVal > f.loserVal ? 'Winners HIGHER' : 'Winners LOWER';
    }

    factors.sort((a, b) => b.diff - a.diff);

    console.log('\nFactors sorted by discriminating power:\n');
    for (const f of factors) {
      const diffPct = loserStats ? (f.diff / Math.abs(loserStats.avgRoc || 1) * 100) : 0;
      console.log(`${f.name.padEnd(15)}: Winners=${f.winnerVal.toFixed(3).padEnd(8)} Losers=${f.loserVal.toFixed(3).padEnd(8)} | ${f.direction}`);
    }
  }

  // Test potential filters
  console.log('\n' + '='.repeat(100));
  console.log('FILTER TESTING - Find filters that reject losers without affecting winners');
  console.log('='.repeat(100));

  const testFilter = (
    name: string,
    filter: (t: TradeWithContext) => boolean
  ) => {
    const passedWinners = analyzedWinners.filter(filter);
    const passedLosers = analyzedLosers.filter(filter);
    const rejectedLosers = analyzedLosers.filter(t => !filter(t));

    const winnersKept = passedWinners.length / analyzedWinners.length * 100;
    const losersRejected = rejectedLosers.length / analyzedLosers.length * 100;

    const totalPassed = passedWinners.length + passedLosers.length;
    const newWinRate = totalPassed > 0 ? passedWinners.length / totalPassed * 100 : 0;

    const originalWinRate = analyzedWinners.length / analyzedTrades.length * 100;

    // Calculate PnL impact
    const originalPnl = analyzedTrades.reduce((s, t) => s + t.netPnlPct, 0);
    const newPnl = [...passedWinners, ...passedLosers].reduce((s, t) => s + t.netPnlPct, 0);
    const pnlSaved = originalPnl - newPnl < 0 ? newPnl - originalPnl : 0;
    const rejectedLossPnl = rejectedLosers.reduce((s, t) => s + t.netPnlPct, 0);

    console.log(`\n${name}:`);
    console.log(`  Winners kept: ${passedWinners.length}/${analyzedWinners.length} (${winnersKept.toFixed(1)}%)`);
    console.log(`  Losers rejected: ${rejectedLosers.length}/${analyzedLosers.length} (${losersRejected.toFixed(1)}%)`);
    console.log(`  Win rate: ${originalWinRate.toFixed(1)}% → ${newWinRate.toFixed(1)}% (${(newWinRate - originalWinRate) >= 0 ? '+' : ''}${(newWinRate - originalWinRate).toFixed(1)}pp)`);
    console.log(`  Loss avoided: ${Math.abs(rejectedLossPnl).toFixed(1)}%`);

    return {
      name,
      winnersKept,
      losersRejected,
      newWinRate,
      pnlImpact: -rejectedLossPnl, // Positive means loss avoided
    };
  };

  // Test various filters
  const filterResults: any[] = [];

  // Volume filters
  filterResults.push(testFilter('Vol Ratio > 1.0', t => (t.entryVolRatio || 1) > 1.0));
  filterResults.push(testFilter('Vol Ratio > 1.2', t => (t.entryVolRatio || 1) > 1.2));
  filterResults.push(testFilter('Vol Ratio > 1.5', t => (t.entryVolRatio || 1) > 1.5));

  // ROC filters
  filterResults.push(testFilter('|ROC| > 0.2%', t => Math.abs(t.entryRocPct || 0) > 0.2));
  filterResults.push(testFilter('|ROC| > 0.3%', t => Math.abs(t.entryRocPct || 0) > 0.3));
  filterResults.push(testFilter('|ROC| < 1.0%', t => Math.abs(t.entryRocPct || 0) < 1.0));

  // Body ratio filter
  filterResults.push(testFilter('Body > 50%', t => (t.entryCandleBodyPct || 0) > 0.5));
  filterResults.push(testFilter('Body > 60%', t => (t.entryCandleBodyPct || 0) > 0.6));

  // Wick filter (reject if large opposite wick)
  filterResults.push(testFilter('Opp Wick < 30%', t => (t.entryCandleWickPct || 0) < 0.3));
  filterResults.push(testFilter('Opp Wick < 20%', t => (t.entryCandleWickPct || 0) < 0.2));

  // BB position filter
  filterResults.push(testFilter('BB pos 0.2-0.8', t => {
    const bb = t.entryBbPosition || 0.5;
    return bb > 0.2 && bb < 0.8;
  }));

  // Consecutive candles
  filterResults.push(testFilter('Consec < 4', t => (t.entryConsecCandles || 0) < 4));
  filterResults.push(testFilter('Consec < 3', t => (t.entryConsecCandles || 0) < 3));

  // BTC context
  filterResults.push(testFilter('|BTC ROC 1h| < 2%', t => Math.abs(t.btcRoc1hPct || 0) < 2));
  filterResults.push(testFilter('BTC Vol < 1%', t => (t.btcVolatility || 0) < 1));

  // Combo filters
  filterResults.push(testFilter('Vol>1.2 AND Body>50%', t =>
    (t.entryVolRatio || 1) > 1.2 && (t.entryCandleBodyPct || 0) > 0.5
  ));
  filterResults.push(testFilter('Vol>1.2 AND OppWick<30%', t =>
    (t.entryVolRatio || 1) > 1.2 && (t.entryCandleWickPct || 0) < 0.3
  ));
  filterResults.push(testFilter('Vol>1.0 AND Body>50% AND Wick<30%', t =>
    (t.entryVolRatio || 1) > 1.0 &&
    (t.entryCandleBodyPct || 0) > 0.5 &&
    (t.entryCandleWickPct || 0) < 0.3
  ));

  // Summary
  console.log('\n' + '='.repeat(100));
  console.log('BEST FILTERS (sorted by loss avoided while keeping >90% winners)');
  console.log('='.repeat(100));

  const goodFilters = filterResults
    .filter(f => f.winnersKept >= 90)
    .sort((a, b) => b.pnlImpact - a.pnlImpact);

  console.log('\n' + '-'.repeat(90));
  console.log(`${'Filter'.padEnd(35)} | ${'Win%'.padEnd(8)} | ${'LossRej%'.padEnd(10)} | ${'NewWR'.padEnd(8)} | ${'LossAvoided'.padEnd(12)}`);
  console.log('-'.repeat(90));

  for (const f of goodFilters.slice(0, 10)) {
    console.log(
      `${f.name.padEnd(35)} | ${f.winnersKept.toFixed(1).padEnd(8)} | ${f.losersRejected.toFixed(1).padEnd(10)} | ${f.newWinRate.toFixed(1).padEnd(8)} | ${f.pnlImpact.toFixed(1)}%`
    );
  }

  // Sample of rejected losers
  console.log('\n' + '='.repeat(100));
  console.log('SAMPLE REJECTED LOSERS (with best filter)');
  console.log('='.repeat(100));

  if (goodFilters.length > 0) {
    const bestFilterName = goodFilters[0].name;
    console.log(`\nBest filter: ${bestFilterName}`);

    // Find rejected losers for best filter
    let bestFilter: (t: TradeWithContext) => boolean;
    if (bestFilterName.includes('Vol>1.2 AND OppWick<30%')) {
      bestFilter = t => (t.entryVolRatio || 1) > 1.2 && (t.entryCandleWickPct || 0) < 0.3;
    } else if (bestFilterName.includes('Vol>1.0 AND Body>50% AND Wick<30%')) {
      bestFilter = t => (t.entryVolRatio || 1) > 1.0 && (t.entryCandleBodyPct || 0) > 0.5 && (t.entryCandleWickPct || 0) < 0.3;
    } else {
      bestFilter = () => true;
    }

    const rejectedLosers = analyzedLosers.filter(t => !bestFilter(t)).slice(0, 10);

    console.log('\nSample rejected trades:');
    for (const t of rejectedLosers) {
      console.log(`\n  ${t.symbol} ${t.side.toUpperCase()} @ ${t.entryTime.slice(0, 16)}`);
      console.log(`    PnL: ${t.netPnlPct.toFixed(2)}% | Exit: ${t.exitReason}`);
      console.log(`    Vol: ${(t.entryVolRatio || 0).toFixed(2)}x | Body: ${((t.entryCandleBodyPct || 0) * 100).toFixed(0)}% | OppWick: ${((t.entryCandleWickPct || 0) * 100).toFixed(0)}%`);
    }
  }
}

main().catch(console.error);
