/**
 * Month Macro Analysis Service
 * Compares current month's early signals to historical patterns
 * to predict if we're trending like a good month (Oct) or bad month (Sep)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  side: 'long' | 'short';
  entryTime: Date;
  exitTime: Date;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  pnlUsd: number;
  exitReason: 'SL' | 'TRAIL';
  leverage: number;
  month: number;
  year: number;
  day: number;
}

interface Position {
  side: 'long' | 'short';
  entryPrice: number;
  entryTime: Date;
  qty: number;
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
  trailCount: number;
  slRatio: number;
}

export interface SimilarMonth {
  month: MonthMetrics;
  similarity: number;
  finalOutcome: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
}

export interface MonthOutlook {
  currentMonth: MonthMetrics;
  dayOfMonth: number;
  similarMonths: SimilarMonth[];
  prediction: {
    outlook: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    confidence: number;
    expectedWinRate: number;
    expectedPnl: number;
    reasoning: string;
  };
  historicalBest: MonthMetrics;
  historicalWorst: MonthMetrics;
}

// V5.11 Strategy Config
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
  LEVERAGE: {
    'SOL/USDT:USDT': 4.5,
    'ETH/USDT:USDT': 4.5,
    'BTC/USDT:USDT': 4,
    'AVAX/USDT:USDT': 4,
    'LINK/USDT:USDT': 4,
    'DOT/USDT:USDT': 4,
    'DOGE/USDT:USDT': 4,
    'XRP/USDT:USDT': 4,
    'ATOM/USDT:USDT': 4,
  } as Record<string, number>
};

const SYMBOLS = Object.keys(CONFIG.LEVERAGE);

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

function calculateMACD(closes: number[]): { macd: number[]; signal: number[]; histogram: number[] } {
  const emaFast = calculateEMA(closes, CONFIG.MACD_FAST);
  const emaSlow = calculateEMA(closes, CONFIG.MACD_SLOW);
  
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = calculateEMA(macdLine, CONFIG.MACD_SIGNAL);
  const histogram = macdLine.map((m, i) => m - signalLine[i]);
  
  return { macd: macdLine, signal: signalLine, histogram };
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
  const leverage = CONFIG.LEVERAGE[symbol] || 4;
  
  for (let i = 50; i < candles.length; i++) {
    const candle = candles[i];
    const price = candle.close;
    const ts = new Date(candle.timestamp);
    
    // Check exits first
    if (position) {
      const highPrice = candle.high;
      const lowPrice = candle.low;
      
      if (position.side === 'long' && highPrice > position.highWaterMark) {
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
      
      if (position.side === 'long' && lowPrice <= position.stopLoss) {
        exitPrice = position.stopLoss;
        exitReason = 'SL';
      } else if (position.trailingActive && position.side === 'long' && lowPrice <= position.trailingStop) {
        exitPrice = position.trailingStop;
        exitReason = 'TRAIL';
      }
      
      if (exitPrice && exitReason) {
        const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
        const notional = position.qty * position.entryPrice;
        const fees = notional * CONFIG.FEE_PCT / 100 * 2;
        const pnlUsd = (pnlPct / 100) * notional - fees;
        
        trades.push({
          symbol,
          side: position.side,
          entryTime: position.entryTime,
          exitTime: ts,
          entryPrice: position.entryPrice,
          exitPrice,
          pnlPct,
          pnlUsd,
          exitReason,
          leverage,
          month: position.entryTime.getMonth() + 1,
          year: position.entryTime.getFullYear(),
          day: position.entryTime.getDate(),
        });
        position = null;
      }
    }
    
    // Check entry signals (LONG only)
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
          side: 'long',
          entryPrice: price,
          entryTime: ts,
          qty: 1000 / price,
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
  // Go up from dist/services to backend/data
  const dataDir = path.join(__dirname, '..', '..', 'data');
  
  for (const symbol of SYMBOLS) {
    let filename = symbol.replace('/', '_').replace(':USDT', '') + '_15m.json';
    let filepath = path.join(dataDir, filename);
    
    if (!fs.existsSync(filepath)) {
      filename = symbol.replace('/', '_').replace(':USDT', '') + '_1h.json';
      filepath = path.join(dataDir, filename);
    }
    
    if (!fs.existsSync(filepath)) continue;
    
    const rawCandles = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    
    let candles: Candle[];
    if (filename.includes('15m')) {
      candles = [];
      for (let i = 0; i < rawCandles.length; i += 4) {
        if (i + 3 >= rawCandles.length) break;
        const chunk = rawCandles.slice(i, i + 4);
        candles.push({
          timestamp: chunk[0].openTime || chunk[0].timestamp,
          open: chunk[0].open,
          high: Math.max(...chunk.map((c: Candle) => c.high)),
          low: Math.min(...chunk.map((c: Candle) => c.low)),
          close: chunk[3].close,
          volume: chunk.reduce((s: number, c: Candle) => s + c.volume, 0),
        });
      }
    } else {
      candles = rawCandles.map((c: Candle) => ({
        timestamp: c.timestamp || c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
    }
    
    const trades = runBacktest(candles, symbol);
    allTrades.push(...trades);
  }
  
  return allTrades;
}

function getMonthMetrics(trades: Trade[], upToDay?: number): MonthMetrics[] {
  const monthlyMap = new Map<string, Trade[]>();
  
  for (const trade of trades) {
    if (upToDay && trade.day > upToDay) continue;
    
    const key = `${trade.year}-${String(trade.month).padStart(2, '0')}`;
    if (!monthlyMap.has(key)) monthlyMap.set(key, []);
    monthlyMap.get(key)!.push(trade);
  }
  
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  return Array.from(monthlyMap.entries())
    .map(([yearMonth, monthTrades]) => {
      const wins = monthTrades.filter(t => t.pnlUsd > 0).length;
      const losses = monthTrades.filter(t => t.pnlUsd <= 0).length;
      const slCount = monthTrades.filter(t => t.exitReason === 'SL').length;
      const trailCount = monthTrades.filter(t => t.exitReason === 'TRAIL').length;
      const totalPnl = monthTrades.reduce((s, t) => s + t.pnlUsd, 0);
      const month = parseInt(yearMonth.split('-')[1]);
      
      return {
        yearMonth,
        monthName: monthNames[month - 1],
        trades: monthTrades.length,
        wins,
        losses,
        winRate: monthTrades.length > 0 ? (wins / monthTrades.length) * 100 : 0,
        totalPnl,
        avgPnl: monthTrades.length > 0 ? totalPnl / monthTrades.length : 0,
        slCount,
        trailCount,
        slRatio: monthTrades.length > 0 ? slCount / monthTrades.length : 0,
      };
    })
    .sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
}

function calculateSimilarity(current: MonthMetrics, historical: MonthMetrics): number {
  const weights = {
    winRate: 0.35,
    avgPnl: 0.25,
    slRatio: 0.25,
    tradeCount: 0.15,
  };
  
  const winRateDiff = Math.abs(current.winRate - historical.winRate) / 100;
  const avgPnlDiff = Math.min(Math.abs(current.avgPnl - historical.avgPnl) / 20, 1);
  const slRatioDiff = Math.abs(current.slRatio - historical.slRatio);
  const tradeCountDiff = Math.min(Math.abs(current.trades - historical.trades) / 10, 1);
  
  const similarity = 1 - (
    weights.winRate * winRateDiff +
    weights.avgPnl * avgPnlDiff +
    weights.slRatio * slRatioDiff +
    weights.tradeCount * tradeCountDiff
  );
  
  return Math.max(0, Math.min(100, similarity * 100));
}

export function analyzeMonthOutlook(): MonthOutlook | null {
  const allTrades = loadAllTrades();
  if (allTrades.length === 0) return null;
  
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const dayOfMonth = now.getDate();
  
  const currentMonthKey = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
  const currentMonthTrades = allTrades.filter(t => 
    t.year === currentYear && t.month === currentMonth && t.day <= dayOfMonth
  );
  
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  // Build current metrics
  const wins = currentMonthTrades.filter(t => t.pnlUsd > 0).length;
  const losses = currentMonthTrades.filter(t => t.pnlUsd <= 0).length;
  const slCount = currentMonthTrades.filter(t => t.exitReason === 'SL').length;
  const trailCount = currentMonthTrades.filter(t => t.exitReason === 'TRAIL').length;
  const totalPnl = currentMonthTrades.reduce((s, t) => s + t.pnlUsd, 0);
  
  const currentMetrics: MonthMetrics = {
    yearMonth: currentMonthKey,
    monthName: monthNames[currentMonth - 1],
    trades: currentMonthTrades.length,
    wins,
    losses,
    winRate: currentMonthTrades.length > 0 ? (wins / currentMonthTrades.length) * 100 : 0,
    totalPnl,
    avgPnl: currentMonthTrades.length > 0 ? totalPnl / currentMonthTrades.length : 0,
    slCount,
    trailCount,
    slRatio: currentMonthTrades.length > 0 ? slCount / currentMonthTrades.length : 0,
  };
  
  // Get historical metrics
  const allMonthlyFull = getMonthMetrics(allTrades);
  const allMonthlyPartial = getMonthMetrics(allTrades, dayOfMonth);
  
  const historicalPartialMetrics: MonthMetrics[] = [];
  const fullMonthMetrics: MonthMetrics[] = [];
  
  for (const partial of allMonthlyPartial) {
    if (partial.yearMonth === currentMonthKey) continue;
    if (partial.trades === 0) continue;
    
    const full = allMonthlyFull.find(m => m.yearMonth === partial.yearMonth);
    if (full && full.trades > 0) {
      historicalPartialMetrics.push(partial);
      fullMonthMetrics.push(full);
    }
  }
  
  // Find similar months
  const similarMonthsWithPartial = historicalPartialMetrics
    .map((partial, idx) => {
      const full = fullMonthMetrics[idx];
      const similarity = calculateSimilarity(currentMetrics, partial);
      const finalOutcome: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' = 
        full.totalPnl > 10 ? 'POSITIVE' : full.totalPnl < -10 ? 'NEGATIVE' : 'NEUTRAL';
      
      return {
        month: full,
        partial,
        similarity,
        finalOutcome,
      };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);
  
  // Calculate prediction
  const topSimilar = similarMonthsWithPartial.slice(0, 3);
  const positiveCount = topSimilar.filter(m => m.finalOutcome === 'POSITIVE').length;
  const negativeCount = topSimilar.filter(m => m.finalOutcome === 'NEGATIVE').length;
  
  const totalSimilarity = topSimilar.reduce((s, m) => s + m.similarity, 0) || 1;
  const weightedWinRate = topSimilar.reduce((s, m) => s + m.month.winRate * m.similarity, 0) / totalSimilarity;
  const weightedPnl = topSimilar.reduce((s, m) => s + m.month.totalPnl * m.similarity, 0) / totalSimilarity;
  
  let outlook: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  let confidence: number;
  let reasoning: string;
  
  if (positiveCount >= 2 && weightedPnl > 0) {
    outlook = 'BULLISH';
    confidence = Math.min(85, 50 + (topSimilar[0]?.similarity || 0) * 0.35);
    reasoning = `Similar to ${topSimilar.filter(m => m.finalOutcome === 'POSITIVE').map(m => m.month.monthName + ' ' + m.month.yearMonth.split('-')[0]).join(', ')} which ended positive`;
  } else if (negativeCount >= 2 || weightedPnl < -20) {
    outlook = 'BEARISH';
    confidence = Math.min(85, 50 + (topSimilar[0]?.similarity || 0) * 0.35);
    reasoning = `Similar to ${topSimilar.filter(m => m.finalOutcome === 'NEGATIVE').map(m => m.month.monthName + ' ' + m.month.yearMonth.split('-')[0]).join(', ')} which ended negative`;
  } else {
    outlook = 'NEUTRAL';
    confidence = 40;
    reasoning = 'Mixed signals from similar historical months';
  }
  
  const sortedByPnl = [...allMonthlyFull].sort((a, b) => b.totalPnl - a.totalPnl);
  
  // Handle edge case where we might not have enough months
  if (sortedByPnl.length === 0) return null;
  
  const similarMonths: SimilarMonth[] = similarMonthsWithPartial.map(m => ({
    month: m.month,
    similarity: m.similarity,
    finalOutcome: m.finalOutcome,
  }));
  
  return {
    currentMonth: currentMetrics,
    dayOfMonth,
    similarMonths,
    prediction: {
      outlook,
      confidence,
      expectedWinRate: weightedWinRate,
      expectedPnl: weightedPnl,
      reasoning,
    },
    historicalBest: sortedByPnl[0],
    historicalWorst: sortedByPnl[sortedByPnl.length - 1],
  };
}
