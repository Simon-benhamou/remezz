/**
 * 🔬 Backtest Service - Unified Realistic Backtest Engine
 *
 * Uses momentumSimple strategy helpers for entries.
 * Uses intrabar execution for stops/trailing/TP (realistic).
 * Single mode - no legacy/agent split.
 */

import ccxt from 'ccxt';
import {
  loadLocalJsonCandles,
  mergeDedupCandles,
  sliceCandlesByTime,
  type BacktestCandle,
} from './backtest/localOhlcvJsonStore.js';

import {
  MomentumConfig,
  checkMomentumSignal,
  calcSafeLeverage,
  calculatePositionSize,
  calcDynamicStopLoss as calcDynamicStopLossStrategy,
} from '../strategies/momentumSimple.js';

// ============================================================================
// TYPES
// ============================================================================

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface BacktestSimPosition {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  entryIdx: number;
  qty: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  capitalBefore: number;
  wasCapped: boolean;
  stopLossPct: number;
  highWaterMark?: number;
  lowWaterMark?: number;
  appTrailingStop?: number;
}

export interface BacktestParams {
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  symbols: string[];
  leverage: number;
  mode?: 'legacy' | 'agent'; // Ignored - kept for API compatibility
}

export interface BacktestTrade {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  holdMinutes: number;
  grossPnlPct: number;
  netPnlPct: number;
  netPnlUsd: number;
  feesUsd: number;
  exitReason: string;
  capitalBefore: number;
  capitalAfter: number;
  month: string;
  day: string;
  wasCapped: boolean;
  slippagePct: number;
}

export interface MonthlyStats {
  month: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnlUsd: number;
  pnlPct: number;
  longTrades: number;
  shortTrades: number;
  avgTradeUsd: number;
  maxWinUsd: number;
  maxLossUsd: number;
  capitalStart: number;
  capitalEnd: number;
}

export interface BacktestResult {
  params: BacktestParams;
  summary: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnlUsd: number;
    totalPnlPct: number;
    maxDrawdownPct: number;
    avgTradeUsd: number;
    avgWinUsd: number;
    avgLossUsd: number;
    profitFactor: number;
    sharpeRatio: number;
    finalCapital: number;
    longTrades: number;
    shortTrades: number;
    avgHoldMinutes: number;
    totalFeesUsd: number;
  };
  trades: BacktestTrade[];
  monthlyStats: MonthlyStats[];
  equityCurve: { date: string; equity: number }[];
  drawdownCurve: { date: string; drawdown: number }[];
}

// ============================================================================
// CONFIG (synced with MomentumConfig)
// ============================================================================

const CONFIG = {
  EXIT: {
    STOP_LOSS_PCT: MomentumConfig.EXIT.STOP_LOSS_PCT,
    TAKE_PROFIT_PCT: MomentumConfig.EXIT.PROFIT_TARGET_PCT,
    TRAILING_ACTIVATION_PCT: MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT,
    TRAILING_DISTANCE_PCT: MomentumConfig.EXIT.TRAILING_DISTANCE_PCT,
    TRAILING_WIDEN_AT_PCT: MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT,
    TRAILING_WIDE_DISTANCE_PCT: MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT,
    MAX_HOLD_BARS: 192, // 48h in 15m bars
  },
  COSTS: {
    TRADING_FEE_PCT: 0.04, // Binance taker fee
    SLIPPAGE_PCT: 0.05, // Realistic slippage
    FUNDING_RATE_PCT: 0.01, // 8h funding
    FUNDING_INTERVAL_BARS: 32, // 32 × 15min = 8h
  },
};

// ============================================================================
// INDICATORS
// ============================================================================

function calcATR(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1]?.close || high;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrSum += tr;
  }

  return atrSum / period;
}

// Adaptive trailing: tighter in low vol, wider in high vol
function calcAdaptiveTrailing(candles: Candle[]): { activation: number; distance: number } {
  const atr = calcATR(candles, 14);
  
  if (!atr || candles.length === 0) {
    return {
      activation: CONFIG.EXIT.TRAILING_ACTIVATION_PCT,
      distance: CONFIG.EXIT.TRAILING_DISTANCE_PCT,
    };
  }
  
  const currentPrice = candles[candles.length - 1].close;
  const atrPct = (atr / currentPrice) * 100;
  
  // Low volatility (ATR < 2%): tighter trailing
  if (atrPct < 2.0) {
    return { activation: 0.6, distance: 0.3 };
  }
  
  // High volatility (ATR > 3.5%): wider trailing
  if (atrPct > 3.5) {
    return { activation: 1.2, distance: 0.8 };
  }
  
  // Medium: default
  return {
    activation: CONFIG.EXIT.TRAILING_ACTIVATION_PCT,
    distance: CONFIG.EXIT.TRAILING_DISTANCE_PCT,
  };
}

// ============================================================================
// DATA FETCHING
// ============================================================================

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

async function fetchCandlesFromCcxt(symbol: string, since: number, until: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = since;

  while (cursor < until) {
    try {
      const ohlcv = await exchange.fetchOHLCV(symbol, '15m', cursor, 1000);
      if (!ohlcv || ohlcv.length === 0) break;

      let progressed = false;
      for (const c of ohlcv) {
        const ts = c[0] as number;
        if (!Number.isFinite(ts)) continue;
        if (ts > until) break;
        if (out.length && ts <= out[out.length - 1].timestamp) continue;
        out.push({
          timestamp: ts,
          open: c[1] as number,
          high: c[2] as number,
          low: c[3] as number,
          close: c[4] as number,
          volume: c[5] as number,
        });
        progressed = true;
      }

      if (!progressed) break;
      cursor = (ohlcv[ohlcv.length - 1][0] as number) + 1;
      await new Promise((r) => setTimeout(r, 100));
    } catch (e) {
      console.error(`Error fetching ${symbol}:`, e);
      break;
    }
  }

  return out;
}

async function fetchCandles(symbol: string, startDate: Date, endDate: Date): Promise<Candle[]> {
  const until = endDate.getTime();
  const extraBarsMs = 200 * 15 * 60 * 1000; // 200 bars × 15min
  const since = startDate.getTime() - extraBarsMs;

  const local = await loadLocalJsonCandles(symbol, '15m');
  if (!local) {
    return await fetchCandlesFromCcxt(symbol, since, until);
  }

  const needBefore = since < local.startTs;
  const needAfter = until > local.endTs;

  const localSlice = sliceCandlesByTime(local.candles, since, until);
  const parts: BacktestCandle[][] = [localSlice];

  if (needBefore) {
    const beforeCandles = await fetchCandlesFromCcxt(symbol, since, local.startTs - 1);
    parts.unshift(beforeCandles);
  }
  if (needAfter) {
    const afterCandles = await fetchCandlesFromCcxt(symbol, local.endTs + 1, until);
    parts.push(afterCandles);
  }

  return mergeDedupCandles(parts);
}

// ============================================================================
// PNL CALCULATION
// ============================================================================

function calculatePnl(
  entryPrice: number,
  exitPrice: number,
  side: 'long' | 'short',
  marginUsd: number,
  leverage: number,
  holdBars: number,
): { grossPnlPct: number; netPnlPct: number; netPnlUsd: number; feesUsd: number } {
  const pricePct =
    side === 'long'
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;

  const grossPnlPct = pricePct * leverage;

  // Costs
  const tradingFees = CONFIG.COSTS.TRADING_FEE_PCT * 2; // Entry + Exit
  const slippage = CONFIG.COSTS.SLIPPAGE_PCT * 2;
  const fundingPeriods = Math.floor(holdBars / CONFIG.COSTS.FUNDING_INTERVAL_BARS);
  const funding = fundingPeriods * CONFIG.COSTS.FUNDING_RATE_PCT;

  const totalCostsPct = (tradingFees + slippage + funding) * leverage;
  const netPnlPct = grossPnlPct - totalCostsPct;

  const feesUsd = (totalCostsPct / 100) * marginUsd;
  const netPnlUsd = (netPnlPct / 100) * marginUsd;

  return { grossPnlPct, netPnlPct, netPnlUsd, feesUsd };
}

// ============================================================================
// MAIN BACKTEST FUNCTION
// ============================================================================

export async function runBacktest(params: BacktestParams): Promise<BacktestResult> {
  const { startDate, endDate, initialCapital, symbols, leverage } = params;

  console.log(`[Backtest] Fetching data for ${symbols.length} symbols...`);

  // Fetch BTC for regime detection
  const btcCandles = await fetchCandles('BTC/USDT:USDT', startDate, endDate);
  const btcCloses = btcCandles.map((c) => c.close);
  console.log(`[Backtest] BTC: ${btcCandles.length} candles`);

  // Fetch all symbol data
  const allData: Record<string, Candle[]> = {};
  for (const symbol of symbols) {
    allData[symbol] = await fetchCandles(symbol, startDate, endDate);
    console.log(`[Backtest] ${symbol}: ${allData[symbol].length} candles`);
  }

  // Track per-symbol candle cursor (avoid O(n²) findIndex)
  const symbolIdx: Record<string, number> = {};
  for (const symbol of symbols) symbolIdx[symbol] = -1;

  // Initialize state
  let capital = initialCapital;
  let capitalInUse = 0;
  let peakCapital = initialCapital;
  let maxDrawdown = 0;
  const trades: BacktestTrade[] = [];
  const equityCurve: { date: string; equity: number }[] = [];
  const drawdownCurve: { date: string; drawdown: number }[] = [];
  let tradeId = 0;

  const positions: Record<string, BacktestSimPosition | null> = {};
  const cooldowns: Record<string, number> = {};
  symbols.forEach((s) => {
    positions[s] = null;
    cooldowns[s] = 0;
  });

  // Find start index (need 200 bars for SMA200)
  const startTimestamp = startDate.getTime();
  let startIdx = btcCandles.findIndex((c) => c.timestamp >= startTimestamp);
  if (startIdx < 200) startIdx = 200;

  console.log(`[Backtest] Starting simulation at index ${startIdx}...`);

  // Main loop - iterate over BTC candles
  for (let btcIdx = startIdx; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];

    if (btcCandle.timestamp < startTimestamp) continue;
    if (btcCandle.timestamp > endDate.getTime()) break;

    // BTC context for regime detection (uses PRIOR close, not current)
    const btcWindowEnd = btcIdx; // Exclude current (in-progress) candle
    const btcWindowCandles = btcCandles.slice(Math.max(0, btcWindowEnd - 300), btcWindowEnd);

    // Prevent event-loop starvation
    if (btcIdx % 25 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const day = new Date(btcCandle.timestamp).toISOString().slice(0, 10);

    // Track equity
    const totalEquity = capital + capitalInUse;
    if (equityCurve.length === 0 || equityCurve[equityCurve.length - 1].date !== day) {
      equityCurve.push({ date: day, equity: totalEquity });

      if (totalEquity > peakCapital) peakCapital = totalEquity;
      const drawdownPct = ((peakCapital - totalEquity) / peakCapital) * 100;
      if (drawdownPct > maxDrawdown) maxDrawdown = drawdownPct;
      drawdownCurve.push({ date: day, drawdown: drawdownPct });
    }

    // Process each symbol
    for (const symbol of symbols) {
      const candles = allData[symbol];
      let idx = symbolIdx[symbol];

      // Find the latest CLOSED candle for this symbol
      // Candle timestamps are open-times, so "closed" means timestamp < btcCandle.timestamp
      while (idx + 1 < candles.length && candles[idx + 1].timestamp < btcCandle.timestamp) {
        idx += 1;
      }

      symbolIdx[symbol] = idx;
      if (idx < 50) continue;
      if (idx >= candles.length) continue;

      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];

      // Decrement cooldown
      if (cooldowns[symbol] > 0) cooldowns[symbol]--;

      // ═══════════════════════════════════════════════════════════════════
      // MANAGE EXISTING POSITION
      // ═══════════════════════════════════════════════════════════════════
      if (positions[symbol]) {
        const pos = positions[symbol]!;
        const holdBars = idx - pos.entryIdx;

        let shouldExit = false;
        let exitPrice = current.close;
        let exitReason = 'UNKNOWN';

        // Calculate current PnL %
        const pnlPct =
          pos.side === 'long'
            ? ((current.close - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - current.close) / pos.entryPrice) * 100;

        // Update water marks with candle extremes
        if (pos.side === 'long') {
          pos.highWaterMark = Math.max(pos.highWaterMark ?? pos.entryPrice, current.high);
        } else {
          pos.lowWaterMark = Math.min(pos.lowWaterMark ?? pos.entryPrice, current.low);
        }

        // Get adaptive trailing params
        const { activation, distance } = calcAdaptiveTrailing(windowCandles);

        // Check exits in priority order:
        // 1. Stop Loss (intrabar - check if wick hit stop)
        // 2. Take Profit (intrabar - check if wick hit TP)
        // 3. Trailing Stop (intrabar - if activated, check if wick hit trail)
        // 4. Max Hold Time

        const slPct = pos.stopLossPct;
        const tpPct = CONFIG.EXIT.TAKE_PROFIT_PCT;

        if (pos.side === 'long') {
          const slPrice = pos.entryPrice * (1 - slPct / 100);
          const tpPrice = pos.entryPrice * (1 + tpPct / 100);

          // SL hit? (wick went below stop)
          if (current.low <= slPrice) {
            shouldExit = true;
            exitReason = 'SL';
            exitPrice = slPrice;
          }
          // TP hit?
          else if (current.high >= tpPrice) {
            shouldExit = true;
            exitReason = 'TP';
            exitPrice = tpPrice;
          }
          // Trailing?
          else {
            const hwm = pos.highWaterMark!;
            const hwmPct = ((hwm - pos.entryPrice) / pos.entryPrice) * 100;

            if (hwmPct >= activation) {
              // V5.12: Smart trailing - widen distance at higher profits
              let trailDist = distance;
              if (hwmPct >= CONFIG.EXIT.TRAILING_WIDEN_AT_PCT) {
                trailDist = CONFIG.EXIT.TRAILING_WIDE_DISTANCE_PCT;
              }
              
              const trailStop = hwm * (1 - trailDist / 100);
              pos.appTrailingStop = trailStop;

              if (current.low <= trailStop) {
                shouldExit = true;
                exitReason = 'TRAIL';
                exitPrice = trailStop;
              }
            }
          }
        } else {
          // SHORT
          const slPrice = pos.entryPrice * (1 + slPct / 100);
          const tpPrice = pos.entryPrice * (1 - tpPct / 100);

          // SL hit?
          if (current.high >= slPrice) {
            shouldExit = true;
            exitReason = 'SL';
            exitPrice = slPrice;
          }
          // TP hit?
          else if (current.low <= tpPrice) {
            shouldExit = true;
            exitReason = 'TP';
            exitPrice = tpPrice;
          }
          // Trailing?
          else {
            const lwm = pos.lowWaterMark!;
            const lwmPct = ((pos.entryPrice - lwm) / pos.entryPrice) * 100;

            if (lwmPct >= activation) {
              let trailDist = distance;
              if (lwmPct >= CONFIG.EXIT.TRAILING_WIDEN_AT_PCT) {
                trailDist = CONFIG.EXIT.TRAILING_WIDE_DISTANCE_PCT;
              }
              
              const trailStop = lwm * (1 + trailDist / 100);
              pos.appTrailingStop = trailStop;

              if (current.high >= trailStop) {
                shouldExit = true;
                exitReason = 'TRAIL';
                exitPrice = trailStop;
              }
            }
          }
        }

        // Max hold time
        if (!shouldExit && holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) {
          shouldExit = true;
          exitReason = 'TIME';
          exitPrice = current.close;
        }

        if (shouldExit) {
          const pnl = calculatePnl(
            pos.entryPrice,
            exitPrice,
            pos.side,
            pos.marginUsd,
            pos.leverage,
            holdBars,
          );
          capital += pnl.netPnlUsd + pos.marginUsd;
          capitalInUse -= pos.marginUsd;

          const month = new Date(current.timestamp).toISOString().slice(0, 7);
          const exitDay = new Date(current.timestamp).toISOString().slice(0, 10);

          trades.push({
            id: `trade_${++tradeId}`,
            symbol,
            side: pos.side,
            entryTime: new Date(pos.entryTime).toISOString(),
            exitTime: new Date(current.timestamp).toISOString(),
            entryPrice: pos.entryPrice,
            exitPrice,
            qty: pos.qty,
            notionalUsd: pos.notionalUsd,
            marginUsd: pos.marginUsd,
            leverage: pos.leverage,
            holdMinutes: holdBars * 15,
            grossPnlPct: pnl.grossPnlPct,
            netPnlPct: pnl.netPnlPct,
            netPnlUsd: pnl.netPnlUsd,
            feesUsd: pnl.feesUsd,
            exitReason,
            capitalBefore: pos.capitalBefore,
            capitalAfter: capital,
            month,
            day: exitDay,
            wasCapped: pos.wasCapped,
            slippagePct: CONFIG.COSTS.SLIPPAGE_PCT * 2,
          });

          positions[symbol] = null;
          cooldowns[symbol] = 8; // 2h cooldown
        }
      }

      // ═══════════════════════════════════════════════════════════════════
      // CHECK FOR NEW ENTRY
      // ═══════════════════════════════════════════════════════════════════
      if (!positions[symbol] && cooldowns[symbol] <= 0) {
        const availableCapital = capital - capitalInUse;
        if (availableCapital < 100) continue;

        // Max positions check
        const openPositions = symbols.reduce((acc, s) => acc + (positions[s] ? 1 : 0), 0);
        const maxPositions = Math.max(1, Number(MomentumConfig.RISK.MAX_POSITIONS ?? 4));
        if (openPositions >= maxPositions) continue;

        // Use momentumSimple's checkMomentumSignal for entry
        const signal = checkMomentumSignal(symbol, windowCandles, btcWindowCandles, {
          nowMs: btcCandle.timestamp,
        });
        if (!signal.valid || !signal.side) continue;

        // Calculate position size using momentumSimple helpers
        const baseLev = leverage || MomentumConfig.LEVERAGE[symbol] || 5;
        const levCalc = calcSafeLeverage(windowCandles, baseLev);

        const sizing = calculatePositionSize({
          symbol,
          currentPrice: current.close,
          totalCapitalUsd: availableCapital,
          riskPerTradePct: MomentumConfig.RISK.RISK_PCT_PER_TRADE,
          stopLossPct: MomentumConfig.EXIT.STOP_LOSS_PCT,
          safeLeverage: levCalc.leverage,
          volume24h: undefined,
        });

        if (!sizing.notionalUsd || sizing.notionalUsd < 20 || !sizing.marginUsd) continue;

        const slCalc = calcDynamicStopLossStrategy(windowCandles);
        const slPct = slCalc.slPct;

        const wasCapped = Boolean(sizing.wasLiquidityCapped);
        const notionalUsd = sizing.notionalUsd;
        const marginUsd = sizing.marginUsd;
        const qty = sizing.qty;
        const posLeverage = sizing.suggestedLeverage;

        capitalInUse += marginUsd;
        capital -= marginUsd;

        positions[symbol] = {
          symbol,
          side: signal.side,
          entryPrice: current.close,
          entryTime: current.timestamp,
          entryIdx: idx,
          qty,
          notionalUsd,
          marginUsd,
          leverage: posLeverage,
          capitalBefore: capital + marginUsd,
          wasCapped,
          stopLossPct: slPct,
          highWaterMark: signal.side === 'long' ? current.close : undefined,
          lowWaterMark: signal.side === 'short' ? current.close : undefined,
        };
      }
    }
  }

  // Close any remaining positions at market
  for (const symbol of symbols) {
    if (positions[symbol]) {
      const pos = positions[symbol]!;
      const candles = allData[symbol];
      const lastCandle = candles[candles.length - 1];
      const holdBars = candles.length - pos.entryIdx;

      const pnl = calculatePnl(
        pos.entryPrice,
        lastCandle.close,
        pos.side,
        pos.marginUsd,
        pos.leverage,
        holdBars,
      );
      capital += pnl.netPnlUsd + pos.marginUsd;

      trades.push({
        id: `trade_${++tradeId}`,
        symbol,
        side: pos.side,
        entryTime: new Date(pos.entryTime).toISOString(),
        exitTime: new Date(lastCandle.timestamp).toISOString(),
        entryPrice: pos.entryPrice,
        exitPrice: lastCandle.close,
        qty: pos.qty,
        notionalUsd: pos.notionalUsd,
        marginUsd: pos.marginUsd,
        leverage: pos.leverage,
        holdMinutes: holdBars * 15,
        grossPnlPct: pnl.grossPnlPct,
        netPnlPct: pnl.netPnlPct,
        netPnlUsd: pnl.netPnlUsd,
        feesUsd: pnl.feesUsd,
        exitReason: 'END',
        capitalBefore: pos.capitalBefore,
        capitalAfter: capital,
        month: new Date(lastCandle.timestamp).toISOString().slice(0, 7),
        day: new Date(lastCandle.timestamp).toISOString().slice(0, 10),
        wasCapped: pos.wasCapped,
        slippagePct: CONFIG.COSTS.SLIPPAGE_PCT * 2,
      });
    }
  }

  // Calculate monthly stats
  const monthlyMap = new Map<string, BacktestTrade[]>();
  trades.forEach((t) => {
    if (!monthlyMap.has(t.month)) monthlyMap.set(t.month, []);
    monthlyMap.get(t.month)!.push(t);
  });

  const monthlyStats: MonthlyStats[] = [];
  let prevCapital = initialCapital;

  for (const [month, monthTrades] of [...monthlyMap.entries()].sort()) {
    const wins = monthTrades.filter((t) => t.netPnlUsd > 0).length;
    const losses = monthTrades.filter((t) => t.netPnlUsd <= 0).length;
    const pnlUsd = monthTrades.reduce((sum, t) => sum + t.netPnlUsd, 0);
    const longTrades = monthTrades.filter((t) => t.side === 'long').length;
    const shortTrades = monthTrades.filter((t) => t.side === 'short').length;

    const capitalEnd =
      monthTrades.length > 0 ? monthTrades[monthTrades.length - 1].capitalAfter : prevCapital;

    monthlyStats.push({
      month,
      trades: monthTrades.length,
      wins,
      losses,
      winRate: monthTrades.length > 0 ? (wins / monthTrades.length) * 100 : 0,
      pnlUsd,
      pnlPct: prevCapital > 0 ? (pnlUsd / prevCapital) * 100 : 0,
      longTrades,
      shortTrades,
      avgTradeUsd: monthTrades.length > 0 ? pnlUsd / monthTrades.length : 0,
      maxWinUsd: monthTrades.length > 0 ? Math.max(...monthTrades.map((t) => t.netPnlUsd)) : 0,
      maxLossUsd: monthTrades.length > 0 ? Math.min(...monthTrades.map((t) => t.netPnlUsd)) : 0,
      capitalStart: prevCapital,
      capitalEnd,
    });

    prevCapital = capitalEnd;
  }

  // Calculate summary
  const wins = trades.filter((t) => t.netPnlUsd > 0);
  const losses = trades.filter((t) => t.netPnlUsd <= 0);
  const totalPnlUsd = trades.reduce((sum, t) => sum + t.netPnlUsd, 0);
  const totalFeesUsd = trades.reduce((sum, t) => sum + t.feesUsd, 0);
  const grossWins = wins.reduce((sum, t) => sum + t.netPnlUsd, 0);
  const grossLosses = Math.abs(losses.reduce((sum, t) => sum + t.netPnlUsd, 0));

  // Calculate Sharpe Ratio
  const dailyReturns = equityCurve
    .map((e, i) => {
      if (i === 0) return 0;
      return ((e.equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity) * 100;
    })
    .slice(1);

  const avgReturn =
    dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const stdReturn =
    dailyReturns.length > 1
      ? Math.sqrt(
          dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) /
            dailyReturns.length,
        )
      : 1;
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(365) : 0;

  const result: BacktestResult = {
    params,
    summary: {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      totalPnlUsd,
      totalPnlPct: (totalPnlUsd / initialCapital) * 100,
      maxDrawdownPct: maxDrawdown,
      avgTradeUsd: trades.length > 0 ? totalPnlUsd / trades.length : 0,
      avgWinUsd: wins.length > 0 ? grossWins / wins.length : 0,
      avgLossUsd: losses.length > 0 ? grossLosses / losses.length : 0,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
      sharpeRatio,
      finalCapital: capital,
      longTrades: trades.filter((t) => t.side === 'long').length,
      shortTrades: trades.filter((t) => t.side === 'short').length,
      avgHoldMinutes:
        trades.length > 0 ? trades.reduce((sum, t) => sum + t.holdMinutes, 0) / trades.length : 0,
      totalFeesUsd,
    },
    trades,
    monthlyStats,
    equityCurve,
    drawdownCurve,
  };

  console.log(
    `[Backtest] Completed: ${trades.length} trades, ${wins.length} wins, ROI: ${result.summary.totalPnlPct.toFixed(1)}%`,
  );

  return result;
}
