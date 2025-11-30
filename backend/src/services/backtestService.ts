/**
 * 🔬 Backtest Service - Detailed Trade-by-Trade Backtest Engine
 * 
 * Returns individual trades with full details for analysis
 */

import ccxt from 'ccxt';

// ============================================================================
// TYPES
// ============================================================================

export interface BacktestParams {
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  symbols: string[];
  leverage: number;
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
// CONFIG V5.7 (synced with momentumSimple.ts)
// ============================================================================

const CONFIG = {
  LONG: {
    BB_PERIOD: 20,
    BB_STD: 2,
    ROC_MIN: 2.5,           // V5.3: 2.5% (strict)
    VOL_MULTIPLIER: 2.0,    // V5.3: 2x (strict)
    MAX_CONSEC_UP: 3,       // V5.3: max 3 bougies vertes
  },
  SHORT: {
    ROC_DROP_MIN: -1.5,     // V5.4: ROC5 < -1.5%
    VOL_SPIKE: 2.0,         // V5.4: 2x volume
    PRICE_BELOW_MA20: true,
    PRICE_BELOW_BB_LOWER: true, // V5.4: BB breakdown
    MAX_CONSEC_DOWN: 5,
  },
  EXIT: {
    // V5.7: DYNAMIC ATR-BASED STOP LOSS
    // Backtested: +370% PnL vs fixed 1.5%, -20% stop hunts
    STOP_LOSS_TYPE: 'atr' as const,  // 'fixed' | 'atr'
    STOP_LOSS_FIXED: 1.5,            // Fallback si ATR non dispo
    STOP_LOSS_ATR_MULT: 2.0,         // ATR × 2.0 (optimal)
    STOP_LOSS_MIN: 0.8,              // Min 0.8%
    STOP_LOSS_MAX: 3.0,              // Max 3.0%
    
    TAKE_PROFIT: 3.0,
    TRAILING_ACTIVATION: 1.0,
    TRAILING_DISTANCE: 0.4,
    MAX_HOLD_BARS: 192,              // 48h
  },
  POSITION_SIZE_PCT: 0.4,            // 40% du capital disponible
  DEFAULT_LEVERAGE: 4.5,             // V5.7: 4.5x uniforme
  COSTS: {
    TRADING_FEE_PCT: 0.04,           // Binance taker fee
    SLIPPAGE_PCT: 0.05,              // Realistic slippage
    FUNDING_RATE_PCT: 0.01,          // 8h funding
    FUNDING_INTERVAL_BARS: 32,       // 32 × 15min = 8h
  },
  LIQUIDITY_CAPS: {
    'BTC/USDT:USDT': 500_000,
    'ETH/USDT:USDT': 500_000,
    'XRP/USDT:USDT': 100_000,
    'SOL/USDT:USDT': 100_000,
    'SEI/USDT:USDT': 25_000,
    'IMX/USDT:USDT': 25_000,
    'DOT/USDT:USDT': 25_000,
    'DOGE/USDT:USDT': 100_000,
    'SUI/USDT:USDT': 50_000,
    'ADA/USDT:USDT': 100_000,
    'LINK/USDT:USDT': 50_000,
    'AVAX/USDT:USDT': 50_000,
  } as Record<string, number>,
};

// ============================================================================
// INDICATORS
// ============================================================================

function calcSMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcBB(closes: number[], period = 20, mult = 2) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0 };
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - middle, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: middle + std * mult, middle, lower: middle - std * mult };
}

function calcROC(closes: number[], period: number): number {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - period - 1];
  return past > 0 ? ((current - past) / past) * 100 : 0;
}

function calcVolRatio(volumes: number[]): number {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avg > 0 ? current / avg : 0;
}

// V5.7: ATR calculation for dynamic stop loss
function calcATR(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1]?.close || high;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    atrSum += tr;
  }
  
  return atrSum / period;
}

// V5.7: Dynamic stop loss based on ATR
function calcDynamicStopLoss(candles: Candle[]): { slPct: number; atrPct: number | null } {
  if (CONFIG.EXIT.STOP_LOSS_TYPE !== 'atr') {
    return { slPct: CONFIG.EXIT.STOP_LOSS_FIXED, atrPct: null };
  }
  
  const atr = calcATR(candles, 14);
  if (!atr || candles.length === 0) {
    return { slPct: CONFIG.EXIT.STOP_LOSS_FIXED, atrPct: null };
  }
  
  const currentPrice = candles[candles.length - 1].close;
  const atrPct = (atr / currentPrice) * 100;
  
  // SL = ATR × multiplier, clamped between min and max
  const rawSlPct = atrPct * CONFIG.EXIT.STOP_LOSS_ATR_MULT;
  const slPct = Math.min(
    CONFIG.EXIT.STOP_LOSS_MAX,
    Math.max(CONFIG.EXIT.STOP_LOSS_MIN, rawSlPct)
  );
  
  return { slPct, atrPct };
}

function countConsecUp(candles: Candle[]): number {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > candles[i].open) count++;
    else break;
  }
  return count;
}

function countConsecDown(candles: any[]): number {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close < candles[i].open) count++;
    else break;
  }
  return count;
}

// ============================================================================
// DATA FETCHING
// ============================================================================

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchCandles(symbol: string, startDate: Date, endDate: Date): Promise<Candle[]> {
  const allCandles: Candle[] = [];
  let since = startDate.getTime();
  const until = endDate.getTime();
  
  // Fetch 200 extra candles before startDate for indicators
  const extraBars = 200 * 15 * 60 * 1000; // 200 bars × 15min
  since -= extraBars;
  
  while (since < until) {
    try {
      const ohlcv = await exchange.fetchOHLCV(symbol, '15m', since, 1000);
      if (!ohlcv || ohlcv.length === 0) break;
      
      for (const c of ohlcv) {
        allCandles.push({
          timestamp: c[0] as number,
          open: c[1] as number,
          high: c[2] as number,
          low: c[3] as number,
          close: c[4] as number,
          volume: c[5] as number,
        });
      }
      
      since = ohlcv[ohlcv.length - 1][0] as number + 1;
      await new Promise(r => setTimeout(r, 100)); // Rate limit
    } catch (e) {
      console.error(`Error fetching ${symbol}:`, e);
      break;
    }
  }
  
  return allCandles;
}

// ============================================================================
// SIGNAL DETECTION
// ============================================================================

interface Signal {
  valid: boolean;
  side?: 'long' | 'short';
  reason?: string;
}

function checkSignal(candles: Candle[], isBull: boolean): Signal {
  if (candles.length < 50) return { valid: false, reason: 'insufficient_data' };
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  const isBullish = current.close > current.open;
  const isBearish = current.close < current.open;
  
  const bb = calcBB(closes, CONFIG.LONG.BB_PERIOD, CONFIG.LONG.BB_STD);
  const ma20 = calcSMA(closes, 20);
  const volRatio = calcVolRatio(volumes);
  const roc10 = calcROC(closes, 10);
  const roc5 = calcROC(closes, 5);
  
  if (isBull) {
    // LONG conditions
    const breakoutOk = current.close > bb.upper;
    const rocOk = roc10 >= CONFIG.LONG.ROC_MIN;
    const volOk = volRatio >= CONFIG.LONG.VOL_MULTIPLIER;
    const consecOk = countConsecUp(candles) <= CONFIG.LONG.MAX_CONSEC_UP;
    
    if (isBullish && breakoutOk && rocOk && volOk && consecOk) {
      return { valid: true, side: 'long', reason: 'bull_breakout' };
    }
  } else {
    // SHORT conditions (bear market)
    const dropOk = roc5 <= CONFIG.SHORT.ROC_DROP_MIN;
    const volOk = volRatio >= CONFIG.SHORT.VOL_SPIKE;
    const belowMa20 = current.close < ma20;
    const belowBB = current.close < bb.lower;
    const consecOk = countConsecDown(candles) <= CONFIG.SHORT.MAX_CONSEC_DOWN;
    
    if (isBearish && dropOk && volOk && belowMa20 && belowBB && consecOk) {
      return { valid: true, side: 'short', reason: 'bear_breakdown' };
    }
  }
  
  return { valid: false, reason: 'no_signal' };
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
  holdBars: number
): { grossPnlPct: number; netPnlPct: number; netPnlUsd: number; feesUsd: number } {
  const pricePct = side === 'long'
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
  
  const notionalUsd = marginUsd * leverage;
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
  const btcCloses = btcCandles.map(c => c.close);
  console.log(`[Backtest] BTC: ${btcCandles.length} candles`);
  
  // Fetch all symbol data
  const allData: Record<string, Candle[]> = {};
  for (const symbol of symbols) {
    allData[symbol] = await fetchCandles(symbol, startDate, endDate);
    console.log(`[Backtest] ${symbol}: ${allData[symbol].length} candles`);
  }
  
  // Initialize state
  let capital = initialCapital;
  let capitalInUse = 0;
  let peakCapital = initialCapital;
  let maxDrawdown = 0;
  const trades: BacktestTrade[] = [];
  const equityCurve: { date: string; equity: number }[] = [];
  const drawdownCurve: { date: string; drawdown: number }[] = [];
  let tradeId = 0;
  
  const positions: Record<string, any> = {};
  const cooldowns: Record<string, number> = {};
  symbols.forEach(s => { positions[s] = null; cooldowns[s] = 0; });
  
  // Find start index (after 200 candles for indicators)
  const startTimestamp = startDate.getTime();
  let startIdx = btcCandles.findIndex(c => c.timestamp >= startTimestamp);
  if (startIdx < 200) startIdx = 200;
  
  console.log(`[Backtest] Starting simulation at index ${startIdx}...`);
  
  // Main loop
  for (let btcIdx = startIdx; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];
    
    // Skip if before start date
    if (btcCandle.timestamp < startTimestamp) continue;
    // Stop if after end date
    if (btcCandle.timestamp > endDate.getTime()) break;
    
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
    const btcPrice = btcCloses[btcIdx - 1];
    const isBullRegime = btcPrice > btcSma200;
    
    const day = new Date(btcCandle.timestamp).toISOString().slice(0, 10);
    
    // Track equity
    const totalEquity = capital + capitalInUse;
    if (equityCurve.length === 0 || equityCurve[equityCurve.length - 1].date !== day) {
      equityCurve.push({ date: day, equity: totalEquity });
      
      // Track drawdown
      if (totalEquity > peakCapital) peakCapital = totalEquity;
      const drawdownPct = ((peakCapital - totalEquity) / peakCapital) * 100;
      if (drawdownPct > maxDrawdown) maxDrawdown = drawdownPct;
      drawdownCurve.push({ date: day, drawdown: drawdownPct });
    }
    
    // Process each symbol
    for (const symbol of symbols) {
      const candles = allData[symbol];
      const idx = candles.findIndex(c => c.timestamp >= btcCandle.timestamp);
      if (idx < 50) continue;
      
      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];
      
      // Decrement cooldown
      if (cooldowns[symbol] > 0) cooldowns[symbol]--;
      
      // ═══════════════════════════════════════════════════════════════════
      // MANAGE EXISTING POSITION
      // ═══════════════════════════════════════════════════════════════════
      if (positions[symbol]) {
        const pos = positions[symbol];
        const holdBars = idx - pos.entryIdx;
        let exitReason: string | null = null;
        let exitPrice = current.close;
        
        // V5.7: Use dynamic SL stored in position
        const slPct = pos.slPct || CONFIG.EXIT.STOP_LOSS_FIXED;
        
        if (pos.side === 'long') {
          // Calculate PnL based on CLOSE price (matching backtest-local-analysis.mjs)
          const pnlPct = ((current.close - pos.entryPrice) / pos.entryPrice) * 100;
          pos.hwm = Math.max(pos.hwm || pos.entryPrice, current.high);
          const hwmPct = ((pos.hwm - pos.entryPrice) / pos.entryPrice) * 100;
          
          // V5.7: SL check using CLOSE price (matches backtest-combined-v54 & backtest-local-analysis)
          // This avoids false SL triggers from wicks that recover
          if (pnlPct <= -slPct) {
            exitReason = 'SL';
            exitPrice = pos.entryPrice * (1 - slPct / 100);
          } else if (pnlPct >= CONFIG.EXIT.TAKE_PROFIT) {
            exitReason = 'TP';
            exitPrice = pos.entryPrice * (1 + CONFIG.EXIT.TAKE_PROFIT / 100);
          } else if (hwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION) {
            const trailStop = pos.hwm * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100);
            if (current.low <= trailStop) {
              exitReason = 'TRAIL';
              exitPrice = trailStop;
            }
          } else if (holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) {
            exitReason = 'TIME';
          }
        } else {
          // SHORT
          // Calculate PnL based on CLOSE price (matching backtest-local-analysis.mjs)
          const pnlPct = ((pos.entryPrice - current.close) / pos.entryPrice) * 100;
          pos.lwm = Math.min(pos.lwm || pos.entryPrice, current.low);
          const lwmPct = ((pos.entryPrice - pos.lwm) / pos.entryPrice) * 100;
          
          // V5.7: SL check using CLOSE price (matches backtest-combined-v54 & backtest-local-analysis)
          // This avoids false SL triggers from wicks that recover
          if (pnlPct <= -slPct) {
            exitReason = 'SL';
            exitPrice = pos.entryPrice * (1 + slPct / 100);
          } else if (pnlPct >= CONFIG.EXIT.TAKE_PROFIT) {
            exitReason = 'TP';
            exitPrice = pos.entryPrice * (1 - CONFIG.EXIT.TAKE_PROFIT / 100);
          } else if (lwmPct >= CONFIG.EXIT.TRAILING_ACTIVATION) {
            const trailStop = pos.lwm * (1 + CONFIG.EXIT.TRAILING_DISTANCE / 100);
            if (current.high >= trailStop) {
              exitReason = 'TRAIL';
              exitPrice = trailStop;
            }
          } else if (holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) {
            exitReason = 'TIME';
          }
        }
        
        // Execute exit
        if (exitReason) {
          const pnl = calculatePnl(pos.entryPrice, exitPrice, pos.side, pos.marginUsd, pos.leverage, holdBars);
          capital += pnl.netPnlUsd + pos.marginUsd; // Return margin + PnL
          capitalInUse -= pos.marginUsd;
          
          const month = new Date(btcCandle.timestamp).toISOString().slice(0, 7);
          const exitDay = new Date(btcCandle.timestamp).toISOString().slice(0, 10);
          
          trades.push({
            id: `trade_${++tradeId}`,
            symbol,
            side: pos.side,
            entryTime: new Date(pos.entryTime).toISOString(),
            exitTime: new Date(btcCandle.timestamp).toISOString(),
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
        
        const signal = checkSignal(windowCandles, isBullRegime);
        if (!signal.valid || !signal.side) continue;
        
        // V5.7: Calculate dynamic stop loss based on ATR
        const { slPct, atrPct } = calcDynamicStopLoss(windowCandles);
        
        // V5.7: Use default leverage from config
        const posLeverage = leverage || CONFIG.DEFAULT_LEVERAGE;
        
        // Calculate position size
        const targetMargin = availableCapital * CONFIG.POSITION_SIZE_PCT;
        const targetNotional = targetMargin * posLeverage;
        const maxNotional = CONFIG.LIQUIDITY_CAPS[symbol] || 25_000;
        const wasCapped = targetNotional > maxNotional;
        const notionalUsd = Math.min(targetNotional, maxNotional);
        const marginUsd = notionalUsd / posLeverage;
        const qty = notionalUsd / current.close;
        
        // Block margin
        capitalInUse += marginUsd;
        capital -= marginUsd;
        
        positions[symbol] = {
          side: signal.side,
          entryPrice: current.close,
          entryTime: btcCandle.timestamp,
          entryIdx: idx,
          qty,
          notionalUsd,
          marginUsd,
          leverage: posLeverage,
          capitalBefore: capital + marginUsd,
          wasCapped,
          hwm: current.close,
          lwm: current.close,
          // V5.7: Store dynamic SL
          slPct,
          atrPct,
        };
      }
    }
  }
  
  // Close any remaining positions at market
  for (const symbol of symbols) {
    if (positions[symbol]) {
      const pos = positions[symbol];
      const candles = allData[symbol];
      const lastCandle = candles[candles.length - 1];
      const holdBars = candles.length - pos.entryIdx;
      
      const pnl = calculatePnl(pos.entryPrice, lastCandle.close, pos.side, pos.marginUsd, pos.leverage, holdBars);
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
  trades.forEach(t => {
    if (!monthlyMap.has(t.month)) monthlyMap.set(t.month, []);
    monthlyMap.get(t.month)!.push(t);
  });
  
  const monthlyStats: MonthlyStats[] = [];
  let prevCapital = initialCapital;
  
  for (const [month, monthTrades] of [...monthlyMap.entries()].sort()) {
    const wins = monthTrades.filter(t => t.netPnlUsd > 0).length;
    const losses = monthTrades.filter(t => t.netPnlUsd <= 0).length;
    const pnlUsd = monthTrades.reduce((sum, t) => sum + t.netPnlUsd, 0);
    const longTrades = monthTrades.filter(t => t.side === 'long').length;
    const shortTrades = monthTrades.filter(t => t.side === 'short').length;
    
    const capitalEnd = monthTrades.length > 0 ? monthTrades[monthTrades.length - 1].capitalAfter : prevCapital;
    
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
      maxWinUsd: monthTrades.length > 0 ? Math.max(...monthTrades.map(t => t.netPnlUsd)) : 0,
      maxLossUsd: monthTrades.length > 0 ? Math.min(...monthTrades.map(t => t.netPnlUsd)) : 0,
      capitalStart: prevCapital,
      capitalEnd,
    });
    
    prevCapital = capitalEnd;
  }
  
  // Calculate summary
  const wins = trades.filter(t => t.netPnlUsd > 0);
  const losses = trades.filter(t => t.netPnlUsd <= 0);
  const totalPnlUsd = trades.reduce((sum, t) => sum + t.netPnlUsd, 0);
  const totalFeesUsd = trades.reduce((sum, t) => sum + t.feesUsd, 0);
  const grossWins = wins.reduce((sum, t) => sum + t.netPnlUsd, 0);
  const grossLosses = Math.abs(losses.reduce((sum, t) => sum + t.netPnlUsd, 0));
  
  // Calculate Sharpe Ratio (simplified)
  const dailyReturns = equityCurve.map((e, i) => {
    if (i === 0) return 0;
    return ((e.equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity) * 100;
  }).slice(1);
  
  const avgReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const stdReturn = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / dailyReturns.length)
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
      longTrades: trades.filter(t => t.side === 'long').length,
      shortTrades: trades.filter(t => t.side === 'short').length,
      avgHoldMinutes: trades.length > 0 ? trades.reduce((sum, t) => sum + t.holdMinutes, 0) / trades.length : 0,
      totalFeesUsd,
    },
    trades,
    monthlyStats,
    equityCurve,
    drawdownCurve,
  };
  
  console.log(`[Backtest] Completed: ${trades.length} trades, ${wins.length} wins, ROI: ${result.summary.totalPnlPct.toFixed(1)}%`);
  
  return result;
}
