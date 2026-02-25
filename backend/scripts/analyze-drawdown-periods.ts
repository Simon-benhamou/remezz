/**
 * analyze-drawdown-periods.ts — Deep analysis of worst drawdown periods
 *
 * Identifies DD episodes, analyzes trade composition, BTC conditions,
 * and looks for filterable patterns.
 *
 * Usage:
 *   npx tsx scripts/analyze-drawdown-periods.ts
 */
import { runBacktestComputation, type BacktestComputationInput } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
} from '../src/services/backtest/localOhlcvJsonStore.js';
import { calcSMA, calcATR, calcADX } from '../src/strategies/momentumSimple.js';

// ============================================================================
// CONFIG
// ============================================================================
const SYMBOLS = [
  'DOGE/USDT:USDT', 'IMX/USDT:USDT', 'AVAX/USDT:USDT',
  'FET/USDT:USDT', 'WIF/USDT:USDT',
  'ADA/USDT:USDT', 'DOT/USDT:USDT', 'STX/USDT:USDT',
  'TIA/USDT:USDT',
];

const PARAMS = {
  startDate: new Date('2025-01-01T00:00:00.000Z'),
  endDate: new Date('2025-12-31T23:59:59.999Z'),
  initialCapital: 2000,
  symbols: SYMBOLS,
  leverage: 5,
};

// ============================================================================
// DATA LOADING
// ============================================================================
async function loadData() {
  const startMs = PARAMS.startDate.getTime();
  const endMs = PARAMS.endDate.getTime();
  const extraBarsMs = 250 * 15 * 60 * 1000;

  const since = startMs - extraBarsMs;

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  const btc1hLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '1h');
  if (!btcLocal || !btc1hLocal) throw new Error('No local BTC data');

  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);
  const btcCandlesRegime = sliceCandlesByTime(btcLocal.candles, since, endMs);
  const btcCandles1h = sliceCandlesByTime(btc1hLocal.candles, since - 250 * 60 * 60 * 1000, endMs);

  const allData: Record<string, any[]> = {};
  for (const symbol of SYMBOLS) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (!local) continue;
    allData[symbol] = sliceCandlesByTime(local.candles, since, endMs);
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);

  return { btcCandles, btcCandlesRegime, btcCandles1h, allData, CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000 };
}

// ============================================================================
// BTC MARKET ANALYSIS AT A GIVEN TIME
// ============================================================================
function analyzeBtcAt(btcCandles1h: any[], timestamp: number) {
  // Find the 1h candle closest to this timestamp
  let idx = 0;
  for (let i = btcCandles1h.length - 1; i >= 0; i--) {
    if (btcCandles1h[i].timestamp <= timestamp) {
      idx = i;
      break;
    }
  }

  const window = btcCandles1h.slice(Math.max(0, idx - 210), idx + 1);
  if (window.length < 50) return null;

  const closes = window.map((c: any) => c.close);
  const btcPrice = closes[closes.length - 1];

  // SMA200
  const sma200 = closes.length >= 200 ? calcSMA(closes.slice(-200), 200) : null;
  const distFromSma200 = sma200 ? ((btcPrice - sma200) / sma200) * 100 : null;

  // ATR (volatility)
  const atr14 = calcATR(window.slice(-20), 14);
  const atrPct = atr14 !== null ? (atr14 / btcPrice) * 100 : null;

  // ADX (trend strength)
  const adx = window.length >= 30 ? calcADX(window.slice(-30)) : null;

  // Recent BTC move (7-day ROC on 1h)
  const roc168 = closes.length >= 169 ? (closes[closes.length - 1] / closes[closes.length - 169] - 1) * 100 : null;
  // 24h ROC
  const roc24 = closes.length >= 25 ? (closes[closes.length - 1] / closes[closes.length - 25] - 1) * 100 : null;

  // Regime
  const regime = sma200 ? (btcPrice > sma200 ? 'BULL' : 'BEAR') : 'UNKNOWN';

  return { btcPrice, sma200, distFromSma200, atrPct, adx, roc168, roc24, regime };
}

// ============================================================================
// DRAWDOWN EPISODE DETECTION
// ============================================================================
interface DDEpisode {
  startDate: string;
  endDate: string;
  peakCapital: number;
  troughCapital: number;
  drawdownPct: number;
  durationDays: number;
  tradesInEpisode: any[];
}

function detectDDEpisodes(trades: any[], initialCapital: number, minDDPct: number = 10): DDEpisode[] {
  // Build equity curve from trades
  const sortedTrades = [...trades].sort((a, b) =>
    new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime()
  );

  let capital = initialCapital;
  let peak = initialCapital;
  let peakDate = '';
  let inDD = false;
  let currentEpisode: { peakCap: number; peakDate: string; trades: any[]; troughCap: number; troughDate: string } | null = null;
  const episodes: DDEpisode[] = [];

  for (const t of sortedTrades) {
    capital += t.netPnlUsd;
    const date = t.exitTime.slice(0, 10);

    if (capital > peak) {
      // New peak — close any existing episode
      if (currentEpisode && ((currentEpisode.peakCap - currentEpisode.troughCap) / currentEpisode.peakCap) * 100 >= minDDPct) {
        episodes.push({
          startDate: currentEpisode.peakDate,
          endDate: currentEpisode.troughDate,
          peakCapital: currentEpisode.peakCap,
          troughCapital: currentEpisode.troughCap,
          drawdownPct: ((currentEpisode.peakCap - currentEpisode.troughCap) / currentEpisode.peakCap) * 100,
          durationDays: Math.round((new Date(currentEpisode.troughDate).getTime() - new Date(currentEpisode.peakDate).getTime()) / 86400000),
          tradesInEpisode: currentEpisode.trades,
        });
      }
      peak = capital;
      peakDate = date;
      currentEpisode = null;
    } else {
      // In drawdown
      if (!currentEpisode) {
        currentEpisode = { peakCap: peak, peakDate, trades: [], troughCap: capital, troughDate: date };
      }
      currentEpisode.trades.push(t);
      if (capital < currentEpisode.troughCap) {
        currentEpisode.troughCap = capital;
        currentEpisode.troughDate = date;
      }
    }
  }

  // Close last episode if still in DD
  if (currentEpisode && ((currentEpisode.peakCap - currentEpisode.troughCap) / currentEpisode.peakCap) * 100 >= minDDPct) {
    episodes.push({
      startDate: currentEpisode.peakDate,
      endDate: currentEpisode.troughDate,
      peakCapital: currentEpisode.peakCap,
      troughCapital: currentEpisode.troughCap,
      drawdownPct: ((currentEpisode.peakCap - currentEpisode.troughCap) / currentEpisode.peakCap) * 100,
      durationDays: Math.round((new Date(currentEpisode.troughDate).getTime() - new Date(currentEpisode.peakDate).getTime()) / 86400000),
      tradesInEpisode: currentEpisode.trades,
    });
  }

  return episodes.sort((a, b) => b.drawdownPct - a.drawdownPct);
}

// ============================================================================
// WEEKLY PERFORMANCE ANALYSIS
// ============================================================================
function weeklyAnalysis(trades: any[], initialCapital: number) {
  const sortedTrades = [...trades].sort((a, b) =>
    new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime()
  );

  const weeks: Record<string, { trades: any[]; pnl: number; wins: number; losses: number; longPnl: number; shortPnl: number; longCount: number; shortCount: number }> = {};

  for (const t of sortedTrades) {
    const exitDate = new Date(t.exitTime);
    // Get ISO week start (Monday)
    const d = new Date(exitDate);
    const dayOfWeek = d.getUTCDay() || 7; // Monday = 1
    d.setUTCDate(d.getUTCDate() - dayOfWeek + 1);
    const weekKey = d.toISOString().slice(0, 10);

    if (!weeks[weekKey]) {
      weeks[weekKey] = { trades: [], pnl: 0, wins: 0, losses: 0, longPnl: 0, shortPnl: 0, longCount: 0, shortCount: 0 };
    }
    weeks[weekKey].trades.push(t);
    weeks[weekKey].pnl += t.netPnlUsd;
    if (t.netPnlUsd > 0) weeks[weekKey].wins++;
    else weeks[weekKey].losses++;
    if (t.side === 'long') {
      weeks[weekKey].longPnl += t.netPnlUsd;
      weeks[weekKey].longCount++;
    } else {
      weeks[weekKey].shortPnl += t.netPnlUsd;
      weeks[weekKey].shortCount++;
    }
  }

  return weeks;
}

// ============================================================================
// MONTHLY BREAKDOWN
// ============================================================================
function monthlyBreakdown(trades: any[]) {
  const months: Record<string, { trades: any[]; pnl: number; wins: number; losses: number; longPnl: number; shortPnl: number; longCount: number; shortCount: number }> = {};

  for (const t of trades) {
    const month = t.exitTime.slice(0, 7);
    if (!months[month]) {
      months[month] = { trades: [], pnl: 0, wins: 0, losses: 0, longPnl: 0, shortPnl: 0, longCount: 0, shortCount: 0 };
    }
    months[month].trades.push(t);
    months[month].pnl += t.netPnlUsd;
    if (t.netPnlUsd > 0) months[month].wins++;
    else months[month].losses++;
    if (t.side === 'long') {
      months[month].longPnl += t.netPnlUsd;
      months[month].longCount++;
    } else {
      months[month].shortPnl += t.netPnlUsd;
      months[month].shortCount++;
    }
  }
  return months;
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('=== Drawdown Period Deep Analysis ===\n');
  console.log('Loading data...');
  const data = await loadData();

  console.log('Running full year backtest (Config A: 15m prod)...');
  const input: BacktestComputationInput = {
    params: PARAMS,
    btcCandles: data.btcCandles,
    btcCandlesRegime: data.btcCandlesRegime,
    allData: data.allData,
    CANDLE_REGIME_INTERVAL_MS: data.CANDLE_REGIME_INTERVAL_MS,
  };

  const result = await runBacktestComputation(input);
  const trades = result.trades;
  console.log(`  ${trades.length} trades, $${result.summary.totalPnlUsd.toFixed(0)} PnL, ${result.summary.winRate.toFixed(1)}% WR, DD ${result.summary.maxDrawdownPct.toFixed(1)}%\n`);

  // ========================================================================
  // 1. MONTHLY BREAKDOWN
  // ========================================================================
  console.log('=== MONTHLY BREAKDOWN ===\n');
  const months = monthlyBreakdown(trades);
  const padR = (s: string, n: number) => s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length);
  const padL = (s: string, n: number) => s.length >= n ? s.substring(0, n) : ' '.repeat(n - s.length) + s;

  console.log([padR('Month', 10), padL('#Trades', 8), padL('WR%', 7), padL('PnL$', 10), padL('L_PnL$', 10), padL('S_PnL$', 10), padL('L/S', 8)].join(' | '));
  console.log('-'.repeat(80));

  let cumPnl = 0;
  for (const [month, m] of Object.entries(months).sort()) {
    cumPnl += m.pnl;
    const wr = m.trades.length > 0 ? ((m.wins / m.trades.length) * 100).toFixed(1) : '0.0';
    console.log([
      padR(month, 10),
      padL(String(m.trades.length), 8),
      padL(wr, 7),
      padL((m.pnl >= 0 ? '+' : '') + m.pnl.toFixed(0), 10),
      padL((m.longPnl >= 0 ? '+' : '') + m.longPnl.toFixed(0), 10),
      padL((m.shortPnl >= 0 ? '+' : '') + m.shortPnl.toFixed(0), 10),
      padL(`${m.longCount}/${m.shortCount}`, 8),
    ].join(' | '));
  }

  // ========================================================================
  // 2. DRAWDOWN EPISODES
  // ========================================================================
  console.log('\n\n=== DRAWDOWN EPISODES (>10%) ===\n');
  const episodes = detectDDEpisodes(trades, PARAMS.initialCapital, 10);

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    console.log(`--- Episode #${i + 1}: DD ${ep.drawdownPct.toFixed(1)}% ---`);
    console.log(`  Period: ${ep.startDate} → ${ep.endDate} (${ep.durationDays} days)`);
    console.log(`  Capital: $${ep.peakCapital.toFixed(0)} → $${ep.troughCapital.toFixed(0)} (lost $${(ep.peakCapital - ep.troughCapital).toFixed(0)})`);
    console.log(`  Trades: ${ep.tradesInEpisode.length}`);

    const wins = ep.tradesInEpisode.filter(t => t.netPnlUsd > 0).length;
    const wr = ep.tradesInEpisode.length > 0 ? (wins / ep.tradesInEpisode.length * 100).toFixed(1) : '0';
    console.log(`  Win Rate: ${wr}%`);

    // Split by side
    const longTrades = ep.tradesInEpisode.filter(t => t.side === 'long');
    const shortTrades = ep.tradesInEpisode.filter(t => t.side === 'short');
    const longPnl = longTrades.reduce((s, t) => s + t.netPnlUsd, 0);
    const shortPnl = shortTrades.reduce((s, t) => s + t.netPnlUsd, 0);
    const longWR = longTrades.length > 0 ? (longTrades.filter(t => t.netPnlUsd > 0).length / longTrades.length * 100).toFixed(1) : 'N/A';
    const shortWR = shortTrades.length > 0 ? (shortTrades.filter(t => t.netPnlUsd > 0).length / shortTrades.length * 100).toFixed(1) : 'N/A';
    console.log(`  LONG:  ${longTrades.length} trades, WR ${longWR}%, PnL $${longPnl.toFixed(0)}`);
    console.log(`  SHORT: ${shortTrades.length} trades, WR ${shortWR}%, PnL $${shortPnl.toFixed(0)}`);

    // Exit reasons distribution
    const exitReasons: Record<string, { count: number; pnl: number }> = {};
    for (const t of ep.tradesInEpisode) {
      const r = t.exitReason || 'UNKNOWN';
      if (!exitReasons[r]) exitReasons[r] = { count: 0, pnl: 0 };
      exitReasons[r].count++;
      exitReasons[r].pnl += t.netPnlUsd;
    }
    console.log(`  Exit reasons:`);
    for (const [reason, data] of Object.entries(exitReasons).sort((a, b) => a[1].pnl - b[1].pnl)) {
      console.log(`    ${padR(reason, 25)} ${padL(String(data.count), 4)} trades, PnL $${data.pnl.toFixed(0)}`);
    }

    // Per-symbol breakdown
    const symbolPnl: Record<string, { count: number; pnl: number; wr: number }> = {};
    for (const t of ep.tradesInEpisode) {
      if (!symbolPnl[t.symbol]) symbolPnl[t.symbol] = { count: 0, pnl: 0, wr: 0 };
      symbolPnl[t.symbol].count++;
      symbolPnl[t.symbol].pnl += t.netPnlUsd;
      if (t.netPnlUsd > 0) symbolPnl[t.symbol].wr++;
    }
    console.log(`  Per-symbol:`);
    for (const [sym, data] of Object.entries(symbolPnl).sort((a, b) => a[1].pnl - b[1].pnl)) {
      const wr = data.count > 0 ? (data.wr / data.count * 100).toFixed(0) : '0';
      console.log(`    ${padR(sym, 20)} ${padL(String(data.count), 4)} trades, WR ${padL(wr + '%', 5)}, PnL $${data.pnl.toFixed(0)}`);
    }

    // BTC conditions at start and trough of episode
    const btcAtStart = analyzeBtcAt(data.btcCandles1h, new Date(ep.startDate).getTime());
    const btcAtTrough = analyzeBtcAt(data.btcCandles1h, new Date(ep.endDate).getTime());
    if (btcAtStart && btcAtTrough) {
      console.log(`  BTC at peak (${ep.startDate}):`);
      console.log(`    Price: $${btcAtStart.btcPrice.toFixed(0)}, Regime: ${btcAtStart.regime}, Dist SMA200: ${btcAtStart.distFromSma200?.toFixed(1)}%`);
      console.log(`    ATR%: ${btcAtStart.atrPct?.toFixed(2)}%, ADX: ${btcAtStart.adx?.toFixed(0)}, 7d ROC: ${btcAtStart.roc168?.toFixed(1)}%, 24h ROC: ${btcAtStart.roc24?.toFixed(1)}%`);
      console.log(`  BTC at trough (${ep.endDate}):`);
      console.log(`    Price: $${btcAtTrough.btcPrice.toFixed(0)}, Regime: ${btcAtTrough.regime}, Dist SMA200: ${btcAtTrough.distFromSma200?.toFixed(1)}%`);
      console.log(`    ATR%: ${btcAtTrough.atrPct?.toFixed(2)}%, ADX: ${btcAtTrough.adx?.toFixed(0)}, 7d ROC: ${btcAtTrough.roc168?.toFixed(1)}%, 24h ROC: ${btcAtTrough.roc24?.toFixed(1)}%`);
      console.log(`    BTC move during episode: ${((btcAtTrough.btcPrice - btcAtStart.btcPrice) / btcAtStart.btcPrice * 100).toFixed(1)}%`);
    }

    // Top 5 worst trades
    const worstTrades = [...ep.tradesInEpisode].sort((a, b) => a.netPnlUsd - b.netPnlUsd).slice(0, 5);
    console.log(`  Top 5 worst trades:`);
    for (const t of worstTrades) {
      console.log(`    ${t.symbol} ${t.side} ${t.exitTime.slice(0, 10)} | PnL $${t.netPnlUsd.toFixed(0)} (${t.netPnlPct.toFixed(1)}%) | Exit: ${t.exitReason} | Hold: ${Math.round(t.holdMinutes / 60)}h`);
    }

    console.log('');
  }

  // ========================================================================
  // 3. WORST WEEKS (bottom 10)
  // ========================================================================
  console.log('\n=== WORST 10 WEEKS ===\n');
  const weeks = weeklyAnalysis(trades, PARAMS.initialCapital);
  const sortedWeeks = Object.entries(weeks).sort((a, b) => a[1].pnl - b[1].pnl);

  console.log([padR('Week of', 12), padL('#Tr', 5), padL('WR%', 7), padL('PnL$', 10), padL('L_PnL$', 10), padL('S_PnL$', 10), padL('L/S', 8)].join(' | '));
  console.log('-'.repeat(80));

  for (const [week, w] of sortedWeeks.slice(0, 10)) {
    const wr = w.trades.length > 0 ? ((w.wins / w.trades.length) * 100).toFixed(1) : '0.0';
    console.log([
      padR(week, 12),
      padL(String(w.trades.length), 5),
      padL(wr, 7),
      padL((w.pnl >= 0 ? '+' : '') + w.pnl.toFixed(0), 10),
      padL((w.longPnl >= 0 ? '+' : '') + w.longPnl.toFixed(0), 10),
      padL((w.shortPnl >= 0 ? '+' : '') + w.shortPnl.toFixed(0), 10),
      padL(`${w.longCount}/${w.shortCount}`, 8),
    ].join(' | '));

    // BTC conditions at start of this week
    const btcInfo = analyzeBtcAt(data.btcCandles1h, new Date(week).getTime());
    if (btcInfo) {
      console.log(`    BTC: $${btcInfo.btcPrice.toFixed(0)}, ${btcInfo.regime}, dist SMA200: ${btcInfo.distFromSma200?.toFixed(1)}%, ADX: ${btcInfo.adx?.toFixed(0)}, 7d ROC: ${btcInfo.roc168?.toFixed(1)}%`);
    }
  }

  // ========================================================================
  // 4. LOSING STREAK ANALYSIS
  // ========================================================================
  console.log('\n\n=== CONSECUTIVE LOSER STREAKS (>=4) ===\n');
  const sortedTrades = [...trades].sort((a, b) =>
    new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime()
  );

  let streakStart = 0;
  let streakLen = 0;
  const streaks: { start: number; length: number; pnl: number; trades: any[] }[] = [];

  for (let i = 0; i < sortedTrades.length; i++) {
    if (sortedTrades[i].netPnlUsd < 0) {
      if (streakLen === 0) streakStart = i;
      streakLen++;
    } else {
      if (streakLen >= 4) {
        const streakTrades = sortedTrades.slice(streakStart, streakStart + streakLen);
        streaks.push({
          start: streakStart,
          length: streakLen,
          pnl: streakTrades.reduce((s, t) => s + t.netPnlUsd, 0),
          trades: streakTrades,
        });
      }
      streakLen = 0;
    }
  }
  // Close last streak
  if (streakLen >= 4) {
    const streakTrades = sortedTrades.slice(streakStart, streakStart + streakLen);
    streaks.push({
      start: streakStart,
      length: streakLen,
      pnl: streakTrades.reduce((s, t) => s + t.netPnlUsd, 0),
      trades: streakTrades,
    });
  }

  streaks.sort((a, b) => a.pnl - b.pnl);
  for (const streak of streaks.slice(0, 10)) {
    const first = streak.trades[0];
    const last = streak.trades[streak.trades.length - 1];
    const longCount = streak.trades.filter(t => t.side === 'long').length;
    const shortCount = streak.trades.filter(t => t.side === 'short').length;
    const symbols = [...new Set(streak.trades.map(t => t.symbol))];

    console.log(`  ${streak.length} consecutive losers (${first.exitTime.slice(0, 10)} → ${last.exitTime.slice(0, 10)}) | PnL $${streak.pnl.toFixed(0)} | L/S: ${longCount}/${shortCount}`);
    console.log(`    Symbols: ${symbols.map(s => s.replace('/USDT:USDT', '')).join(', ')}`);
    console.log(`    Exits: ${streak.trades.map(t => t.exitReason).join(', ')}`);

    const btcInfo = analyzeBtcAt(data.btcCandles1h, new Date(first.entryTime).getTime());
    if (btcInfo) {
      console.log(`    BTC: $${btcInfo.btcPrice.toFixed(0)}, ${btcInfo.regime}, dist SMA200: ${btcInfo.distFromSma200?.toFixed(1)}%, ADX: ${btcInfo.adx?.toFixed(0)}, 7d ROC: ${btcInfo.roc168?.toFixed(1)}%`);
    }
  }

  // ========================================================================
  // 5. PATTERN SUMMARY
  // ========================================================================
  console.log('\n\n=== PATTERN ANALYSIS: LOSING vs WINNING TRADES ===\n');

  // Compare BTC conditions for winners vs losers
  const winTrades = sortedTrades.filter(t => t.netPnlUsd > 0);
  const lossTrades = sortedTrades.filter(t => t.netPnlUsd <= 0);

  // Analyze BTC conditions at entry for wins vs losses
  const analyzeGroup = (group: any[], label: string) => {
    const btcConditions = group.map(t => {
      const btc = analyzeBtcAt(data.btcCandles1h, new Date(t.entryTime).getTime());
      return btc;
    }).filter(b => b !== null);

    const avgDistSma200 = btcConditions.reduce((s, b) => s + (b!.distFromSma200 ?? 0), 0) / btcConditions.length;
    const avgAdx = btcConditions.reduce((s, b) => s + (b!.adx ?? 0), 0) / btcConditions.length;
    const avgAtr = btcConditions.reduce((s, b) => s + (b!.atrPct ?? 0), 0) / btcConditions.length;
    const avgRoc7d = btcConditions.reduce((s, b) => s + (b!.roc168 ?? 0), 0) / btcConditions.length;
    const avgRoc24h = btcConditions.reduce((s, b) => s + (b!.roc24 ?? 0), 0) / btcConditions.length;

    // Close to SMA200 (<1%)
    const nearSma = btcConditions.filter(b => Math.abs(b!.distFromSma200 ?? 100) < 1).length;
    const nearSmaPct = (nearSma / btcConditions.length * 100).toFixed(1);

    // Low ADX (<20)
    const lowAdx = btcConditions.filter(b => (b!.adx ?? 100) < 20).length;
    const lowAdxPct = (lowAdx / btcConditions.length * 100).toFixed(1);

    console.log(`  ${label} (${group.length} trades):`);
    console.log(`    Avg dist from SMA200: ${avgDistSma200.toFixed(2)}%`);
    console.log(`    Avg ADX: ${avgAdx.toFixed(1)}`);
    console.log(`    Avg ATR%: ${avgAtr.toFixed(3)}%`);
    console.log(`    Avg 7d ROC: ${avgRoc7d.toFixed(2)}%`);
    console.log(`    Avg 24h ROC: ${avgRoc24h.toFixed(2)}%`);
    console.log(`    Near SMA200 (<1%): ${nearSmaPct}%`);
    console.log(`    Low ADX (<20): ${lowAdxPct}%`);
  };

  analyzeGroup(winTrades, 'WINNERS');
  console.log('');
  analyzeGroup(lossTrades, 'LOSERS');

  // ADX bucket analysis
  console.log('\n\n=== ADX BUCKET ANALYSIS (at entry) ===\n');
  const adxBuckets = [
    { label: 'ADX < 15 (trendless)', min: 0, max: 15 },
    { label: 'ADX 15-20 (weak trend)', min: 15, max: 20 },
    { label: 'ADX 20-25 (moderate)', min: 20, max: 25 },
    { label: 'ADX 25-35 (strong)', min: 25, max: 35 },
    { label: 'ADX > 35 (very strong)', min: 35, max: 999 },
  ];

  for (const bucket of adxBuckets) {
    const bucketTrades = sortedTrades.filter(t => {
      const btc = analyzeBtcAt(data.btcCandles1h, new Date(t.entryTime).getTime());
      if (!btc || btc.adx === null) return false;
      return btc.adx >= bucket.min && btc.adx < bucket.max;
    });
    if (bucketTrades.length < 5) continue;
    const wins = bucketTrades.filter(t => t.netPnlUsd > 0).length;
    const pnl = bucketTrades.reduce((s, t) => s + t.netPnlUsd, 0);
    console.log(`  ${padR(bucket.label, 30)} ${padL(String(bucketTrades.length), 5)} trades, WR ${(wins / bucketTrades.length * 100).toFixed(1)}%, PnL $${pnl.toFixed(0)}`);
  }

  // SMA200 distance bucket analysis
  console.log('\n\n=== SMA200 DISTANCE BUCKET ANALYSIS (at entry) ===\n');
  const smaBuckets = [
    { label: 'Very close (<1%)', min: 0, max: 1 },
    { label: 'Close (1-3%)', min: 1, max: 3 },
    { label: 'Moderate (3-5%)', min: 3, max: 5 },
    { label: 'Far (5-10%)', min: 5, max: 10 },
    { label: 'Very far (>10%)', min: 10, max: 999 },
  ];

  for (const bucket of smaBuckets) {
    const bucketTrades = sortedTrades.filter(t => {
      const btc = analyzeBtcAt(data.btcCandles1h, new Date(t.entryTime).getTime());
      if (!btc || btc.distFromSma200 === null) return false;
      const absDist = Math.abs(btc.distFromSma200);
      return absDist >= bucket.min && absDist < bucket.max;
    });
    if (bucketTrades.length < 5) continue;
    const wins = bucketTrades.filter(t => t.netPnlUsd > 0).length;
    const pnl = bucketTrades.reduce((s, t) => s + t.netPnlUsd, 0);
    console.log(`  ${padR(bucket.label, 30)} ${padL(String(bucketTrades.length), 5)} trades, WR ${(wins / bucketTrades.length * 100).toFixed(1)}%, PnL $${pnl.toFixed(0)}`);
  }

  console.log('\n\nDone.');
}

main().catch(console.error);
