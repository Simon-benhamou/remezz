/**
 * Month Macro Analysis Service
 * Shows where current month stands vs historical performance
 */

import fs from 'fs';
import path from 'path';

// Types
interface Candle {
  timestamp: number | string;
  openTime?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Trade {
  symbol: string;
  entryTime: Date;
  exitTime: Date;
  pnlPct: number;
  pnlUsd: number;
  exitReason: 'SL' | 'TRAIL';
  month: number;
  year: number;
  day: number;
}

interface Position {
  entryPrice: number;
  entryTime: Date;
  stopLoss: number;
  highWaterMark: number;
  trailingActive: boolean;
  trailingStop: number;
}

export interface MonthMetrics {
  yearMonth: string;
  monthName: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  slCount: number;
  slRate: number;
}

export interface MonthOutlook {
  // Current month stats
  currentMonth: MonthMetrics;
  dayOfMonth: number;
  daysInMonth: number;
  
  // Ranking info
  ranking: {
    position: number;
    totalMonths: number;
    percentile: number; // 0-100, higher is better
    status: 'TOP_TIER' | 'GOOD' | 'AVERAGE' | 'POOR' | 'WORST';
  };
  
  // Projection based on current pace
  projection: {
    projectedTrades: number;
    projectedPnl: number;
    projectedWinRate: number;
    trend: 'IMPROVING' | 'STABLE' | 'DECLINING';
  };
  
  // Historical context
  allMonthsRanked: Array<{
    yearMonth: string;
    monthName: string;
    totalPnl: number;
    winRate: number;
    isCurrent: boolean;
  }>;
  
  // Stats
  averageMonthlyPnl: number;
  bestMonth: MonthMetrics;
  worstMonth: MonthMetrics;
  
  // December specific (if available)
  decemberHistory: MonthMetrics[];
}

// Strategy config
const CONFIG = {
  RSI_PERIOD: 14,
  RSI_OVERSOLD: 35,
  MACD_FAST: 12,
  MACD_SLOW: 26,
  MACD_SIGNAL: 9,
  ATR_PERIOD: 14,
  SL_ATR_MULT: 3.0,
  SL_MIN_PCT: 1.0,
  SL_MAX_PCT: 4.5,
  TRAIL_ACTIVATION_PCT: 0.5,
  TRAIL_DISTANCE_PCT: 0.3,
  FEE_PCT: 0.04,
};

const SYMBOLS = [
  'SOL/USDT:USDT', 'ETH/USDT:USDT', 'BTC/USDT:USDT', 
  'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'DOT/USDT:USDT',
  'DOGE/USDT:USDT', 'XRP/USDT:USDT', 'ATOM/USDT:USDT'
];

// Technical indicators
function calculateRSI(closes: number[], period = 14): number[] {
  const rsi: number[] = new Array(closes.length).fill(0);
  if (closes.length < period + 1) return rsi;
  
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

function calculateEMA(data: number[], period: number): number[] {
  const ema: number[] = new Array(data.length).fill(0);
  if (data.length < period) return ema;
  
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  ema[period - 1] = sum / period;
  
  const mult = 2 / (period + 1);
  for (let i = period; i < data.length; i++) {
    ema[i] = (data[i] - ema[i - 1]) * mult + ema[i - 1];
  }
  return ema;
}

function calculateMACD(closes: number[]): { histogram: number[] } {
  const emaFast = calculateEMA(closes, CONFIG.MACD_FAST);
  const emaSlow = calculateEMA(closes, CONFIG.MACD_SLOW);
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = calculateEMA(macdLine, CONFIG.MACD_SIGNAL);
  return { histogram: macdLine.map((m, i) => m - signalLine[i]) };
}

function calculateATR(candles: Candle[], period = 14): number[] {
  const atr: number[] = new Array(candles.length).fill(0);
  if (candles.length < period + 1) return atr;
  
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  atr[period - 1] = sum / period;
  
  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

function runBacktest(candles: Candle[], symbol: string): Trade[] {
  const closes = candles.map(c => c.close);
  const rsi = calculateRSI(closes, CONFIG.RSI_PERIOD);
  const macd = calculateMACD(closes);
  const atr = calculateATR(candles, CONFIG.ATR_PERIOD);
  
  const trades: Trade[] = [];
  let position: Position | null = null;
  
  for (let i = 50; i < candles.length; i++) {
    const candle = candles[i];
    const price = candle.close;
    const ts = new Date(candle.timestamp);
    
    if (position) {
      const highPrice = candle.high;
      const lowPrice = candle.low;
      
      if (highPrice > position.highWaterMark) {
        position.highWaterMark = highPrice;
        const pnlPct = ((highPrice - position.entryPrice) / position.entryPrice) * 100;
        if (pnlPct >= CONFIG.TRAIL_ACTIVATION_PCT && !position.trailingActive) {
          position.trailingActive = true;
          position.trailingStop = highPrice * (1 - CONFIG.TRAIL_DISTANCE_PCT / 100);
        }
        if (position.trailingActive) {
          position.trailingStop = Math.max(position.trailingStop, highPrice * (1 - CONFIG.TRAIL_DISTANCE_PCT / 100));
        }
      }
      
      let exitPrice: number | null = null;
      let exitReason: 'SL' | 'TRAIL' | null = null;
      
      if (lowPrice <= position.stopLoss) {
        exitPrice = position.stopLoss;
        exitReason = 'SL';
      } else if (position.trailingActive && lowPrice <= position.trailingStop) {
        exitPrice = position.trailingStop;
        exitReason = 'TRAIL';
      }
      
      if (exitPrice && exitReason) {
        const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
        const notional = 1000;
        const fees = notional * CONFIG.FEE_PCT / 100 * 2;
        const pnlUsd = (pnlPct / 100) * notional - fees;
        
        trades.push({
          symbol,
          entryTime: position.entryTime,
          exitTime: ts,
          pnlPct,
          pnlUsd,
          exitReason,
          month: position.entryTime.getMonth() + 1,
          year: position.entryTime.getFullYear(),
          day: position.entryTime.getDate(),
        });
        position = null;
      }
    }
    
    if (!position) {
      const prevRsi = rsi[i - 1];
      const currRsi = rsi[i];
      const prevHist = macd.histogram[i - 1];
      const currHist = macd.histogram[i];
      
      const rsiCrossUp = prevRsi < CONFIG.RSI_OVERSOLD && currRsi >= CONFIG.RSI_OVERSOLD;
      const macdCrossUp = prevHist < 0 && currHist >= 0;
      
      if (rsiCrossUp && macdCrossUp && atr[i] > 0) {
        const slPctRaw = (atr[i] / price) * 100 * CONFIG.SL_ATR_MULT;
        const slPct = Math.max(CONFIG.SL_MIN_PCT, Math.min(CONFIG.SL_MAX_PCT, slPctRaw));
        
        position = {
          entryPrice: price,
          entryTime: ts,
          stopLoss: price * (1 - slPct / 100),
          highWaterMark: price,
          trailingActive: false,
          trailingStop: 0,
        };
      }
    }
  }
  
  return trades;
}

function loadAllTrades(): Trade[] {
  const allTrades: Trade[] = [];
  const dataDir = path.join(process.cwd(), 'data');
  
  for (const symbol of SYMBOLS) {
    const filename = symbol.replace('/', '_').replace(':USDT', '') + '_1h.json';
    const filepath = path.join(dataDir, filename);
    
    if (!fs.existsSync(filepath)) continue;
    
    const rawCandles = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    const candles: Candle[] = rawCandles.map((c: Candle) => ({
      timestamp: c.timestamp || c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
    
    const trades = runBacktest(candles, symbol);
    allTrades.push(...trades);
  }
  
  return allTrades;
}

function getMonthMetrics(trades: Trade[]): MonthMetrics[] {
  const monthlyMap = new Map<string, Trade[]>();
  
  for (const trade of trades) {
    const key = `${trade.year}-${String(trade.month).padStart(2, '0')}`;
    if (!monthlyMap.has(key)) monthlyMap.set(key, []);
    monthlyMap.get(key)!.push(trade);
  }
  
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  return Array.from(monthlyMap.entries())
    .map(([yearMonth, monthTrades]) => {
      const wins = monthTrades.filter(t => t.pnlUsd > 0).length;
      const slCount = monthTrades.filter(t => t.exitReason === 'SL').length;
      const totalPnl = monthTrades.reduce((s, t) => s + t.pnlUsd, 0);
      const month = parseInt(yearMonth.split('-')[1]);
      
      return {
        yearMonth,
        monthName: monthNames[month - 1],
        trades: monthTrades.length,
        wins,
        losses: monthTrades.length - wins,
        winRate: monthTrades.length > 0 ? (wins / monthTrades.length) * 100 : 0,
        totalPnl,
        avgPnl: monthTrades.length > 0 ? totalPnl / monthTrades.length : 0,
        slCount,
        slRate: monthTrades.length > 0 ? (slCount / monthTrades.length) * 100 : 0,
      };
    })
    .sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

// Optional: pass current month stats from DB for live data
export interface CurrentMonthStats {
  trades: number;
  wins: number;
  totalPnl: number;
  slCount: number;
}

export function analyzeMonthOutlook(currentMonthFromDb?: CurrentMonthStats): MonthOutlook | null {
  const allTrades = loadAllTrades();
  if (allTrades.length === 0) return null;
  
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const dayOfMonth = now.getDate();
  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  
  const currentMonthKey = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  // Get all monthly metrics from backtest
  const allMonthlyMetrics = getMonthMetrics(allTrades);
  
  // Find or create current month metrics
  // Prefer DB data if available, otherwise use backtest data
  let currentMetrics: MonthMetrics;
  const backtestCurrent = allMonthlyMetrics.find(m => m.yearMonth === currentMonthKey);
  
  if (currentMonthFromDb && currentMonthFromDb.trades > 0) {
    // Use live data from DB
    const wins = currentMonthFromDb.wins;
    const losses = currentMonthFromDb.trades - wins;
    currentMetrics = {
      yearMonth: currentMonthKey,
      monthName: monthNames[currentMonth - 1],
      trades: currentMonthFromDb.trades,
      wins,
      losses,
      winRate: (wins / currentMonthFromDb.trades) * 100,
      totalPnl: currentMonthFromDb.totalPnl,
      avgPnl: currentMonthFromDb.totalPnl / currentMonthFromDb.trades,
      slCount: currentMonthFromDb.slCount,
      slRate: (currentMonthFromDb.slCount / currentMonthFromDb.trades) * 100,
    };
  } else if (backtestCurrent) {
    currentMetrics = backtestCurrent;
  } else {
    currentMetrics = {
      yearMonth: currentMonthKey,
      monthName: monthNames[currentMonth - 1],
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnl: 0,
      avgPnl: 0,
      slCount: 0,
      slRate: 0,
    };
  }
  
  // Rank all months by PnL (excluding current incomplete month for fair comparison)
  const completedMonths = allMonthlyMetrics.filter(m => m.yearMonth !== currentMonthKey);
  const allMonthsForRanking = [...completedMonths, currentMetrics];
  const rankedMonths = [...allMonthsForRanking].sort((a, b) => b.totalPnl - a.totalPnl);
  
  // Find current month position in ranking
  const currentPosition = rankedMonths.findIndex(m => m.yearMonth === currentMonthKey) + 1;
  const totalMonths = rankedMonths.length;
  const percentile = ((totalMonths - currentPosition) / (totalMonths - 1)) * 100;
  
  // Determine status
  let status: 'TOP_TIER' | 'GOOD' | 'AVERAGE' | 'POOR' | 'WORST';
  if (percentile >= 80) status = 'TOP_TIER';
  else if (percentile >= 60) status = 'GOOD';
  else if (percentile >= 40) status = 'AVERAGE';
  else if (percentile >= 20) status = 'POOR';
  else status = 'WORST';
  
  // Calculate projection based on current pace
  const tradesPerDay = currentMetrics.trades / dayOfMonth;
  const pnlPerDay = currentMetrics.totalPnl / dayOfMonth;
  const projectedTrades = Math.round(tradesPerDay * daysInMonth);
  const projectedPnl = pnlPerDay * daysInMonth;
  
  // Determine trend (compare first half pace to second half if applicable)
  let trend: 'IMPROVING' | 'STABLE' | 'DECLINING' = 'STABLE';
  if (dayOfMonth >= 6) {
    const currentTrades = allTrades.filter(t => 
      t.year === currentYear && t.month === currentMonth
    );
    const firstHalfTrades = currentTrades.filter(t => t.day <= dayOfMonth / 2);
    const secondHalfTrades = currentTrades.filter(t => t.day > dayOfMonth / 2);
    
    if (firstHalfTrades.length > 0 && secondHalfTrades.length > 0) {
      const firstHalfPnl = firstHalfTrades.reduce((s, t) => s + t.pnlUsd, 0);
      const secondHalfPnl = secondHalfTrades.reduce((s, t) => s + t.pnlUsd, 0);
      
      if (secondHalfPnl > firstHalfPnl + 10) trend = 'IMPROVING';
      else if (secondHalfPnl < firstHalfPnl - 10) trend = 'DECLINING';
    }
  }
  
  // Prepare ranked months for display
  const allMonthsRanked = rankedMonths.slice(0, 12).map(m => ({
    yearMonth: m.yearMonth,
    monthName: m.monthName,
    totalPnl: m.totalPnl,
    winRate: m.winRate,
    isCurrent: m.yearMonth === currentMonthKey,
  }));
  
  // Calculate average monthly PnL (excluding current)
  const averageMonthlyPnl = completedMonths.length > 0
    ? completedMonths.reduce((s, m) => s + m.totalPnl, 0) / completedMonths.length
    : 0;
  
  // Best and worst months
  const sortedByPnl = [...completedMonths].sort((a, b) => b.totalPnl - a.totalPnl);
  const bestMonth = sortedByPnl[0] || currentMetrics;
  const worstMonth = sortedByPnl[sortedByPnl.length - 1] || currentMetrics;
  
  // December history
  const decemberHistory = allMonthlyMetrics.filter(m => m.monthName === 'Dec');
  
  return {
    currentMonth: currentMetrics,
    dayOfMonth,
    daysInMonth,
    ranking: {
      position: currentPosition,
      totalMonths,
      percentile: Math.round(percentile),
      status,
    },
    projection: {
      projectedTrades,
      projectedPnl,
      projectedWinRate: currentMetrics.winRate,
      trend,
    },
    allMonthsRanked,
    averageMonthlyPnl,
    bestMonth,
    worstMonth,
    decemberHistory,
  };
}
