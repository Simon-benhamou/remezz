/**
 * 🔬 BACKTEST COMBINÉ V5.6 - LONG (Bull) + SHORT (Bear) + LIQUIDITY + ANTI-LIQUIDATION
 * 
 * Simulation réaliste avec capital variable sur 24 mois
 * - Détecte automatiquement le régime (BTC vs SMA200)
 * - Applique LONG en Bull, SHORT en Bear
 * - Frais réalistes: trading, slippage, funding
 * - V5.5: Position sizing limité par liquidité du marché
 * - V5.6: Dynamic leverage based on ATR volatility (anti-liquidation)
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

// ============================================================================
// CONFIGURATION V5.6 (exactement comme dans momentumSimple.ts)
// ============================================================================

const CONFIG = {
  // LONG Entry (Bull: BTC > SMA200)
  LONG: {
    BB_PERIOD: 20,
    BB_STD: 2,
    ROC_MIN: 2.5,           // ROC10 > 2.5%
    VOL_MULTIPLIER: 2.0,    // Volume > 2x
    MAX_CONSEC_UP: 3,
  },
  
  // SHORT Entry (Bear: BTC < SMA200) - BB Breakdown V5.4
  SHORT: {
    ROC_DROP_MIN: -1.5,     // ROC5 < -1.5%
    VOL_SPIKE: 2.0,         // Volume > 2x
    PRICE_BELOW_MA20: true,
    PRICE_BELOW_BB_LOWER: true,  // BB Breakdown
    MAX_CONSEC_DOWN: 5,
  },
  
  // Exit (même pour LONG et SHORT)
  EXIT: {
    STOP_LOSS: 1.5,
    TAKE_PROFIT: 3.0,
    TRAILING_ACTIVATION: 1.0,
    TRAILING_DISTANCE: 0.4,
    MAX_HOLD_BARS: 192,  // 48h
  },
  
  // Risk
  POSITION_SIZE_PCT: 0.4,  // 40% du capital par trade
  
  // V5.7: Leverage par actif (plus conservateur pour volatiles)
  LEVERAGE_BY_SYMBOL: {
    'BTC/USDT:USDT': 4.5,   // BTC - test 4.5x
    'ETH/USDT:USDT': 4.5,   // ETH
    'XRP/USDT:USDT': 4.5,   // XRP
    'SOL/USDT:USDT': 4.5,   // SOL
    'SEI/USDT:USDT': 4.5,   // SEI - test 4.5x
    'IMX/USDT:USDT': 4.5,   // IMX - test 4.5x
    'DOT/USDT:USDT': 4.5,   // DOT
    'DOGE/USDT:USDT': 4.5,  // DOGE
  },
  LEVERAGE: 4.5,  // Default fallback
  
  // V5.6: Liquidation Protection
  LIQUIDATION: {
    // Binance liquidation threshold (maintenance margin ~0.4% = liquidation at ~80% loss on margin)
    LIQUIDATION_THRESHOLD_PCT: 80,  // Liquidated if margin loss > 80%
    
    // Safety margin: don't allow positions where SL is > X% of distance to liquidation
    // With 5x leverage, liquidation = -20% price move
    // SL at 1.5% = 7.5% of 20% = 37.5% of liquidation distance ✅
    // If volatility high, reduce leverage to keep this ratio safe
    MAX_SL_TO_LIQUIDATION_RATIO: 0.5,  // SL should be max 50% of liquidation distance
    
    // Max acceptable gap (for simulation of worst case)
    MAX_SIMULATED_GAP_PCT: 5,  // Simulate 5% gaps to test robustness
    
    // Dynamic leverage based on ATR (volatility)
    DYNAMIC_LEVERAGE: true,
    ATR_PERIOD: 14,
    // If ATR/price > this threshold, reduce leverage
    HIGH_VOLATILITY_ATR_PCT: 2,   // ATR > 2% = high volatility (was 3%)
    REDUCED_LEVERAGE: 3,          // Use 3x instead of 5x in high volatility
  },
};

// ============================================================================
// V5.5: LIQUIDITY-AWARE POSITION SIZING CONFIG
// ============================================================================

const LIQUIDITY_CONFIG = {
  // Maximum position as percentage of symbol's 24h volume
  MAX_POSITION_PCT_OF_VOLUME: 0.5,  // 0.5% of 24h volume max
  
  // Absolute caps per symbol tier based on typical liquidity
  POSITION_CAPS: {
    HIGH: {
      symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
      maxPositionUsd: 500_000,
    },
    MEDIUM: {
      symbols: ['XRP/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT'],
      maxPositionUsd: 100_000,
    },
    LOW: {
      symbols: ['SEI/USDT:USDT', 'IMX/USDT:USDT', 'DOT/USDT:USDT'],
      maxPositionUsd: 25_000,
    },
  },
  
  SLIPPAGE_FACTOR: 50,  // 0.5% slippage for 1% of volume
};

function getLiquidityTier(symbol) {
  if (LIQUIDITY_CONFIG.POSITION_CAPS.HIGH.symbols.includes(symbol)) return 'HIGH';
  if (LIQUIDITY_CONFIG.POSITION_CAPS.MEDIUM.symbols.includes(symbol)) return 'MEDIUM';
  return 'LOW';
}

function getMaxSafePositionSize(symbol, volume24h) {
  const tier = getLiquidityTier(symbol);
  const config = LIQUIDITY_CONFIG.POSITION_CAPS[tier];
  
  if (volume24h && volume24h > 0) {
    const volumeBasedMax = volume24h * (LIQUIDITY_CONFIG.MAX_POSITION_PCT_OF_VOLUME / 100);
    return Math.min(volumeBasedMax, config.maxPositionUsd);
  }
  
  return config.maxPositionUsd;
}

function estimateSlippage(positionUsd, volume24h) {
  if (volume24h <= 0) return 0.5;
  const pctOfVolume = (positionUsd / volume24h) * 100;
  return pctOfVolume * (LIQUIDITY_CONFIG.SLIPPAGE_FACTOR / 100);
}

const COSTS = {
  TRADING_FEE_PCT: 0.04,      // 0.04% per side
  SLIPPAGE_PCT: 0.05,         // 0.05% per side (base slippage)
  FUNDING_RATE_PCT: 0.01,     // 0.01% every 8h
  FUNDING_INTERVAL_BARS: 32,  // 32 × 15min = 8h
};

// V5.5: Test with multiple capital levels
const TEST_CAPITALS = [1_000, 10_000, 100_000, 500_000, 1_000_000];
const INITIAL_CAPITAL = parseInt(process.env.INITIAL_CAPITAL) || 1000;

const SYMBOLS = ['SEI/USDT:USDT', 'XRP/USDT:USDT', 'ETH/USDT:USDT', 'IMX/USDT:USDT'];

// ============================================================================
// INDICATORS
// ============================================================================

function calcSMA(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcBB(closes, period = 20, std = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return { middle: sma, upper: sma + std * stdDev, lower: sma - std * stdDev };
}

function calcROC(closes, period) {
  if (closes.length < period + 1) return null;
  return ((closes[closes.length - 1] - closes[closes.length - 1 - period]) / closes[closes.length - 1 - period]) * 100;
}

function calcVolAvg(volumes, period = 20) {
  if (volumes.length < period) return null;
  return volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function countConsecUp(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > candles[i].open) count++;
    else break;
  }
  return count;
}

function countConsecDown(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close < candles[i].open) count++;
    else break;
  }
  return count;
}

// ============================================================================
// V5.6: ATR CALCULATION FOR VOLATILITY-BASED LEVERAGE
// ============================================================================

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1]?.close || candles[i].open;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    atrSum += tr;
  }
  
  return atrSum / period;
}

// V5.6: Calculate safe leverage based on volatility
function calcSafeLeverage(candles, baseLeverage = 5) {
  if (!CONFIG.LIQUIDATION.DYNAMIC_LEVERAGE) return baseLeverage;
  
  const atr = calcATR(candles, CONFIG.LIQUIDATION.ATR_PERIOD);
  if (!atr) return baseLeverage;
  
  const currentPrice = candles[candles.length - 1].close;
  const atrPct = (atr / currentPrice) * 100;
  
  // High volatility = reduce leverage
  if (atrPct > CONFIG.LIQUIDATION.HIGH_VOLATILITY_ATR_PCT) {
    return CONFIG.LIQUIDATION.REDUCED_LEVERAGE;
  }
  
  return baseLeverage;
}

// V5.6: Check if position is safe from liquidation with gap scenarios
function checkLiquidationSafety(entryPrice, side, leverage, slPct) {
  // Calculate liquidation price (simplified: ~100/leverage % move)
  const liquidationDistance = 100 / leverage;  // e.g., 5x = 20% move
  
  // SL distance with leverage
  const slDistanceFromEntry = slPct;  // e.g., 1.5%
  
  // Ratio of SL to liquidation distance
  const ratio = slDistanceFromEntry / liquidationDistance;
  
  // Also simulate a gap scenario
  const gapPct = CONFIG.LIQUIDATION.MAX_SIMULATED_GAP_PCT;
  const gapLoss = gapPct * leverage;  // 5% gap × 5x = 25% loss
  const wouldSurviveGap = gapLoss < CONFIG.LIQUIDATION.LIQUIDATION_THRESHOLD_PCT;
  
  return {
    safe: ratio <= CONFIG.LIQUIDATION.MAX_SL_TO_LIQUIDATION_RATIO && wouldSurviveGap,
    ratio,
    liquidationDistance,
    gapSurvival: wouldSurviveGap,
    recommendedLeverage: wouldSurviveGap ? leverage : Math.floor(CONFIG.LIQUIDATION.LIQUIDATION_THRESHOLD_PCT / gapPct / 1.5),
  };
}

// ============================================================================
// ENTRY CHECKS
// ============================================================================

function checkLongEntry(candles) {
  if (candles.length < 50) return false;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  // Must be bullish
  if (current.close <= current.open) return false;
  
  // BB Breakout
  const bb = calcBB(closes, CONFIG.LONG.BB_PERIOD, CONFIG.LONG.BB_STD);
  if (!bb || current.close <= bb.upper) return false;
  
  // ROC > 2.5%
  const roc = calcROC(closes, 10);
  if (!roc || roc < CONFIG.LONG.ROC_MIN) return false;
  
  // Volume > 2x
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * CONFIG.LONG.VOL_MULTIPLIER) return false;
  
  // ConsecUp <= 3
  if (countConsecUp(candles) > CONFIG.LONG.MAX_CONSEC_UP) return false;
  
  return true;
}

function checkShortEntry(candles) {
  if (candles.length < 50) return false;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  // Must be bearish
  if (current.close >= current.open) return false;
  
  // ROC5 < -1.5%
  const roc5 = calcROC(closes, 5);
  if (!roc5 || roc5 > CONFIG.SHORT.ROC_DROP_MIN) return false;
  
  // Volume > 2x
  const volAvg = calcVolAvg(volumes);
  if (!volAvg || current.volume < volAvg * CONFIG.SHORT.VOL_SPIKE) return false;
  
  // Price < MA20
  const ma20 = calcSMA(closes, 20);
  if (!ma20 || current.close >= ma20) return false;
  
  // Price < BB Lower (V5.4)
  if (CONFIG.SHORT.PRICE_BELOW_BB_LOWER) {
    const bb = calcBB(closes);
    if (!bb || current.close >= bb.lower) return false;
  }
  
  // ConsecDown <= 5
  if (countConsecDown(candles) > CONFIG.SHORT.MAX_CONSEC_DOWN) return false;
  
  return true;
}

// ============================================================================
// PNL CALCULATOR WITH ALL COSTS (V5.6: Dynamic slippage + dynamic leverage)
// ============================================================================

function calculatePnl(entryPrice, exitPrice, side, capitalUsed, holdBars, extraSlippage = 0, leverage = CONFIG.LEVERAGE) {
  // Gross PnL
  let pnlPct = side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  const leveragedPnlPct = pnlPct * leverage;  // V5.6: Use dynamic leverage
  
  // Costs (V5.5: Add dynamic slippage based on position size vs volume)
  const entryFee = COSTS.TRADING_FEE_PCT * leverage;
  const exitFee = COSTS.TRADING_FEE_PCT * leverage;
  const baseSlippage = COSTS.SLIPPAGE_PCT * 2 * leverage;
  const dynamicSlippage = extraSlippage * 2 * leverage;  // Entry + exit
  const totalSlippage = baseSlippage + dynamicSlippage;
  const fundingPeriods = Math.floor(holdBars / COSTS.FUNDING_INTERVAL_BARS);
  const totalFunding = fundingPeriods * COSTS.FUNDING_RATE_PCT * leverage;
  
  const totalCosts = entryFee + exitFee + totalSlippage + totalFunding;
  const netPnlPct = leveragedPnlPct - totalCosts;
  const netPnlUsd = (netPnlPct / 100) * capitalUsed;
  const costsUsd = (totalCosts / 100) * capitalUsed;
  
  return { 
    grossPnlPct: pnlPct, 
    leveragedPnlPct, 
    netPnlPct, 
    netPnlUsd, 
    costsUsd,
    totalCostsPct: totalCosts,
    slippagePct: totalSlippage / leverage,  // Per-side equivalent
    leverageUsed: leverage,  // V5.6: Track what leverage was actually used
  };
}

// ============================================================================
// DATA FETCHING (V5.5: Also fetch volume data)
// ============================================================================

async function fetchCandles(symbol, months = 12) {
  const since = Date.now() - months * 30 * 24 * 60 * 60 * 1000;
  const allCandles = [];
  let cursor = since;
  
  while (cursor < Date.now()) {
    const ohlcv = await exchange.fetchOHLCV(symbol, '15m', cursor, 1000);
    if (ohlcv.length === 0) break;
    for (const c of ohlcv) {
      allCandles.push({ timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] });
    }
    cursor = ohlcv[ohlcv.length - 1][0] + 1;
    await new Promise(r => setTimeout(r, 50));
  }
  return allCandles;
}

// V5.5: Calculate 24h volume from candles (96 × 15min bars)
function calc24hVolume(candles, idx) {
  const bars24h = 96;  // 24h × 4 bars/hour
  const startIdx = Math.max(0, idx - bars24h);
  let volume = 0;
  for (let i = startIdx; i <= idx; i++) {
    // Volume in quote currency (USDT) = volume × close price
    volume += candles[i].volume * candles[i].close;
  }
  return volume;
}

// ============================================================================
// MAIN BACKTEST V5.5
// ============================================================================

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 BACKTEST COMBINÉ V5.6 - LONG + SHORT + LIQUIDITY + ANTI-LIQUIDATION');
  console.log('═'.repeat(80));
  console.log(`\n💰 Capital initial: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log(`📊 Leverage: ${CONFIG.LEVERAGE}x (dynamic: ${CONFIG.LIQUIDATION.REDUCED_LEVERAGE}x in high ATR)`);
  console.log(`💸 Frais: Trading ${COSTS.TRADING_FEE_PCT}%, Slippage ${COSTS.SLIPPAGE_PCT}%+dynamic, Funding ${COSTS.FUNDING_RATE_PCT}%/8h`);
  console.log(`\n🔒 V5.5 LIQUIDITY CAPS:`);
  console.log(`   HIGH (BTC, ETH): Max $${LIQUIDITY_CONFIG.POSITION_CAPS.HIGH.maxPositionUsd.toLocaleString()}/position`);
  console.log(`   MEDIUM (XRP, SOL): Max $${LIQUIDITY_CONFIG.POSITION_CAPS.MEDIUM.maxPositionUsd.toLocaleString()}/position`);
  console.log(`   LOW (SEI, IMX): Max $${LIQUIDITY_CONFIG.POSITION_CAPS.LOW.maxPositionUsd.toLocaleString()}/position`);
  console.log(`\n⚡ V5.6 ANTI-LIQUIDATION:`);
  console.log(`   ATR threshold: ${CONFIG.LIQUIDATION.HIGH_VOLATILITY_ATR_PCT}% → Reduce to ${CONFIG.LIQUIDATION.REDUCED_LEVERAGE}x`);
  console.log(`   Gap simulation: ${CONFIG.LIQUIDATION.MAX_SIMULATED_GAP_PCT}% max gap scenario`);
  
  // Fetch data
  console.log('\n📊 Fetching 24 months of data...');
  const btcCandles = await fetchCandles('BTC/USDT:USDT', 24);
  const btcCloses = btcCandles.map(c => c.close);
  console.log(`   BTC: ${btcCandles.length} candles`);
  
  const allData = {};
  for (const symbol of SYMBOLS) {
    allData[symbol] = await fetchCandles(symbol, 24);
    console.log(`   ${symbol}: ${allData[symbol].length} candles (Tier: ${getLiquidityTier(symbol)})`);
  }
  
  // Initialize tracking
  let capital = INITIAL_CAPITAL;
  let capitalInUse = 0;  // Track capital locked in positions
  const trades = [];
  let totalCosts = 0;
  const monthlyPnl = {};
  const dailyEquity = [];
  let rejectedOrders = 0;  // Track rejected orders due to insufficient capital
  
  // V5.5: Track liquidity-related stats
  let liquidityCappedTrades = 0;
  let totalSlippageCost = 0;
  const liquidityStats = {};
  SYMBOLS.forEach(s => { liquidityStats[s] = { trades: 0, capped: 0, avgSlippage: 0, totalSlippage: 0 }; });
  
  const positions = {};
  const cooldowns = {};
  SYMBOLS.forEach(s => { positions[s] = null; cooldowns[s] = 0; });
  
  let bullBars = 0, bearBars = 0;
  let longSignals = 0, shortSignals = 0;
  
  // Main loop
  console.log('\n⏳ Running backtest...');
  
  for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
    const btcPrice = btcCloses[btcIdx - 1];
    
    // Determine regime
    const isBullRegime = btcPrice > btcSma200;
    const isBearRegime = btcPrice < btcSma200;
    
    if (isBullRegime) bullBars++;
    if (isBearRegime) bearBars++;
    
    const month = new Date(btcCandle.timestamp).toISOString().slice(0, 7);
    if (!monthlyPnl[month]) monthlyPnl[month] = { pnl: 0, longTrades: 0, shortTrades: 0 };
    
    // Track daily equity
    const day = new Date(btcCandle.timestamp).toISOString().slice(0, 10);
    if (dailyEquity.length === 0 || dailyEquity[dailyEquity.length - 1].day !== day) {
      dailyEquity.push({ day, equity: capital });
    }
    
    for (const symbol of SYMBOLS) {
      const candles = allData[symbol];
      const idx = candles.findIndex(c => c.timestamp >= btcCandle.timestamp);
      if (idx < 50) continue;
      
      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];
      
      // ═══════════════════════════════════════════════════════════════════════
      // MANAGE EXISTING POSITION
      // ═══════════════════════════════════════════════════════════════════════
      if (positions[symbol]) {
        const pos = positions[symbol];
        const holdBars = idx - pos.entryIdx;
        let exitReason = null, exitPrice = current.close;
        
        if (pos.side === 'long') {
          const pnlPct = ((current.close - pos.entryPrice) / pos.entryPrice) * 100;
          pos.hwm = Math.max(pos.hwm || pos.entryPrice, current.high);
          const hwmPct = ((pos.hwm - pos.entryPrice) / pos.entryPrice) * 100;
          
          if (pnlPct <= -CONFIG.EXIT.STOP_LOSS) {
            exitReason = 'SL';
            exitPrice = pos.entryPrice * (1 - CONFIG.EXIT.STOP_LOSS / 100);
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
          const pnlPct = ((pos.entryPrice - current.close) / pos.entryPrice) * 100;
          pos.lwm = Math.min(pos.lwm || pos.entryPrice, current.low);
          const lwmPct = ((pos.entryPrice - pos.lwm) / pos.entryPrice) * 100;
          
          if (pnlPct <= -CONFIG.EXIT.STOP_LOSS) {
            exitReason = 'SL';
            exitPrice = pos.entryPrice * (1 + CONFIG.EXIT.STOP_LOSS / 100);
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
          // V5.6: Include dynamic slippage + dynamic leverage from position
          const pnl = calculatePnl(pos.entryPrice, exitPrice, pos.side, pos.capitalUsed, holdBars, pos.extraSlippage || 0, pos.leverage || CONFIG.LEVERAGE);
          capital += pnl.netPnlUsd;
          capitalInUse -= pos.capitalUsed;  // Release capital back
          totalCosts += pnl.costsUsd;
          totalSlippageCost += (pnl.slippagePct / 100) * pos.capitalUsed;
          
          trades.push({
            symbol,
            side: pos.side,
            entryTime: new Date(pos.entryTime).toISOString(),
            exitTime: new Date(btcCandle.timestamp).toISOString(),
            entryPrice: pos.entryPrice,
            exitPrice,
            holdBars,
            grossPnlPct: pnl.grossPnlPct,
            netPnlPct: pnl.netPnlPct,
            netPnlUsd: pnl.netPnlUsd,
            costsUsd: pnl.costsUsd,
            exitReason,
            capitalAfter: capital,
            month,
            // V5.5: Liquidity info
            wasCapped: pos.wasCapped || false,
            positionSize: pos.capitalUsed,
            slippagePct: pnl.slippagePct,
            // V5.6: Leverage info
            leverage: pos.leverage || CONFIG.LEVERAGE,
            leverageReduced: pos.leverageReduced || false,
          });
          
          monthlyPnl[month].pnl += pnl.netPnlUsd;
          if (pos.side === 'long') monthlyPnl[month].longTrades++;
          else monthlyPnl[month].shortTrades++;
          
          positions[symbol] = null;
          cooldowns[symbol] = 8;  // 2h cooldown
        }
      }
      
      // ═══════════════════════════════════════════════════════════════════════
      // CHECK FOR NEW ENTRY (V5.6: With liquidity-aware sizing + dynamic leverage)
      // ═══════════════════════════════════════════════════════════════════════
      if (!positions[symbol] && cooldowns[symbol] <= 0 && capital > 100) {
        const availableCapital = capital - capitalInUse;
        
        // V5.7: Get base leverage for this symbol
        const baseLeverage = CONFIG.LEVERAGE_BY_SYMBOL[symbol] || CONFIG.LEVERAGE;
        
        // V5.6: Calculate safe leverage (may reduce further based on ATR volatility)
        const safeLeverage = calcSafeLeverage(windowCandles, baseLeverage);
        const leverageReduced = safeLeverage < baseLeverage;
        
        // Step 1: Calculate target margin (40% of capital)
        const targetMargin = capital * CONFIG.POSITION_SIZE_PCT;
        
        // Step 2: Calculate target notional (margin × leverage)
        const targetNotional = targetMargin * safeLeverage;
        
        // Step 3: Get liquidity cap (applies to NOTIONAL)
        const volume24h = calc24hVolume(candles, idx);
        const maxSafeNotional = getMaxSafePositionSize(symbol, volume24h);
        
        // Step 4: Apply liquidity cap to notional
        const wasCapped = targetNotional > maxSafeNotional;
        const notional = Math.min(targetNotional, maxSafeNotional);
        
        // Step 5: Calculate actual margin needed (margin = notional / leverage)
        const marginToUse = notional / safeLeverage;
        
        // V5.5: Calculate dynamic slippage based on notional vs volume
        const extraSlippage = volume24h > 0 ? estimateSlippage(notional, volume24h) : 0;
        
        // V5.6: Verify liquidation safety before entry
        const liquidationCheck = checkLiquidationSafety(
          current.close, 
          isBullRegime ? 'long' : 'short',
          safeLeverage,
          CONFIG.EXIT.STOP_LOSS
        );
        
        // Check if we have enough available capital (compare margin to available)
        if (marginToUse > availableCapital) {
          // Not enough capital - order would be rejected
          if (isBullRegime && checkLongEntry(windowCandles)) {
            rejectedOrders++;
          } else if (isBearRegime && checkShortEntry(windowCandles)) {
            rejectedOrders++;
          }
        } else {
          // BULL REGIME → LONG
          if (isBullRegime && checkLongEntry(windowCandles)) {
            longSignals++;
            if (wasCapped) liquidityCappedTrades++;
            liquidityStats[symbol].trades++;
            if (wasCapped) liquidityStats[symbol].capped++;
            liquidityStats[symbol].totalSlippage += extraSlippage;
            
            capitalInUse += marginToUse;  // Lock MARGIN (not notional)
            positions[symbol] = {
              side: 'long',
              entryPrice: current.close,
              entryIdx: idx,
              entryTime: btcCandle.timestamp,
              capitalUsed: marginToUse,   // Store MARGIN used
              notionalUsed: notional,     // Store NOTIONAL for reference
              leverage: safeLeverage,     // V5.6: Store actual leverage used
              leverageReduced,
              wasCapped,
              extraSlippage,
              volume24h,
              hwm: current.close,
              liquidationSafe: liquidationCheck.safe,
            };
          }
          // BEAR REGIME → SHORT
          else if (isBearRegime && checkShortEntry(windowCandles)) {
            shortSignals++;
            if (wasCapped) liquidityCappedTrades++;
            liquidityStats[symbol].trades++;
            if (wasCapped) liquidityStats[symbol].capped++;
            liquidityStats[symbol].totalSlippage += extraSlippage;
            
            capitalInUse += marginToUse;  // Lock MARGIN (not notional)
            positions[symbol] = {
              side: 'short',
              entryPrice: current.close,
              entryIdx: idx,
              entryTime: btcCandle.timestamp,
              capitalUsed: marginToUse,   // Store MARGIN used
              notionalUsed: notional,     // Store NOTIONAL for reference
              leverage: safeLeverage,     // V5.6: Store actual leverage used
              leverageReduced,
              wasCapped,
              extraSlippage,
              volume24h,
              lwm: current.close,
              liquidationSafe: liquidationCheck.safe,
            };
          }
        }
      }
      
      if (cooldowns[symbol] > 0) cooldowns[symbol]--;
    }
  }
  
  // ============================================================================
  // RESULTS
  // ============================================================================
  
  const longTrades = trades.filter(t => t.side === 'long');
  const shortTrades = trades.filter(t => t.side === 'short');
  const wins = trades.filter(t => t.netPnlPct > 0);
  const losses = trades.filter(t => t.netPnlPct <= 0);
  
  const longWins = longTrades.filter(t => t.netPnlPct > 0);
  const shortWins = shortTrades.filter(t => t.netPnlPct > 0);
  
  // V5.5: Count capped trades
  const cappedTrades = trades.filter(t => t.wasCapped);
  
  // V5.6: Count leverage-reduced trades
  const leverageReducedTrades = trades.filter(t => t.leverageReduced);
  const avgLeverage = trades.length > 0 
    ? trades.reduce((sum, t) => sum + (t.leverage || CONFIG.LEVERAGE), 0) / trades.length 
    : CONFIG.LEVERAGE;
  
  const roi = ((capital - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100);
  const winRate = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
  const longWR = longTrades.length > 0 ? (longWins.length / longTrades.length * 100) : 0;
  const shortWR = shortTrades.length > 0 ? (shortWins.length / shortTrades.length * 100) : 0;
  
  // Max drawdown
  let maxEquity = INITIAL_CAPITAL;
  let maxDrawdown = 0;
  for (const trade of trades) {
    if (trade.capitalAfter > maxEquity) maxEquity = trade.capitalAfter;
    const dd = (maxEquity - trade.capitalAfter) / maxEquity * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  
  // V5.5: Calculate average slippage
  const avgSlippage = trades.length > 0 
    ? trades.reduce((sum, t) => sum + (t.slippagePct || 0), 0) / trades.length 
    : 0;
  
  // Monthly stats
  const months = Object.keys(monthlyPnl).sort();
  const positiveMonths = months.filter(m => monthlyPnl[m].pnl > 0);
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS V5.6 - LONG + SHORT + LIQUIDITY + DYNAMIC LEVERAGE');
  console.log('═'.repeat(80));
  
  console.log(`
┌────────────────────────────────────────────────────────────────────────────────┐
│                              PERFORMANCE GLOBALE                                │
├────────────────────────────────────────────────────────────────────────────────┤
│  💰 Capital: $${INITIAL_CAPITAL.toLocaleString()} → $${capital.toFixed(0).padStart(10)}                                       │
│  📈 ROI:     ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%                                                          │
│  🎯 Trades:  ${String(trades.length).padStart(4)} total (${longTrades.length} LONG + ${shortTrades.length} SHORT)                          │
│  🚫 Rejected: ${rejectedOrders} (insufficient capital)                                       │
│  ✅ Win Rate: ${winRate.toFixed(1)}% global                                                    │
│  📉 Max DD:  ${maxDrawdown.toFixed(1)}%                                                         │
│  💸 Frais:   $${totalCosts.toFixed(2)} (${(totalCosts/INITIAL_CAPITAL*100).toFixed(1)}% du capital initial)                       │
└────────────────────────────────────────────────────────────────────────────────┘
`);

  // V5.5: Liquidity stats
  console.log(`
┌────────────────────────────────────────────────────────────────────────────────┐
│                       🔒 V5.5 LIQUIDITY-AWARE STATS                             │
├────────────────────────────────────────────────────────────────────────────────┤
│  📏 Positions cappées: ${String(cappedTrades.length).padStart(4)}/${trades.length} (${(cappedTrades.length/trades.length*100).toFixed(1)}%)                                │
│  📉 Slippage moyen:    ${avgSlippage.toFixed(3)}% per trade                                       │
│  💸 Coût slippage:     $${totalSlippageCost.toFixed(2)}                                            │
├────────────────────────────────────────────────────────────────────────────────┤
│  Par Symbole:                                                                   │`);
  
  for (const symbol of SYMBOLS) {
    const stats = liquidityStats[symbol];
    const tier = getLiquidityTier(symbol);
    const tierIcon = tier === 'HIGH' ? '🟢' : tier === 'MEDIUM' ? '🟡' : '🔴';
    const cappedPct = stats.trades > 0 ? (stats.capped / stats.trades * 100).toFixed(0) : '0';
    const avgSlip = stats.trades > 0 ? (stats.totalSlippage / stats.trades).toFixed(3) : '0.000';
    console.log(`│  ${tierIcon} ${symbol.padEnd(16)} │ ${String(stats.trades).padStart(3)} trades │ ${String(stats.capped).padStart(3)} capped (${cappedPct.padStart(3)}%) │ avg slip ${avgSlip}%  │`);
  }
  console.log(`└────────────────────────────────────────────────────────────────────────────────┘`);

  // V5.6: Leverage protection stats
  console.log(`
┌────────────────────────────────────────────────────────────────────────────────┐
│                  ⚡ V5.6 LEVERAGE PROTECTION STATS                              │
├────────────────────────────────────────────────────────────────────────────────┤
│  📊 Base Leverage:     ${CONFIG.LEVERAGE}x | Reduced Leverage: ${CONFIG.LIQUIDATION.REDUCED_LEVERAGE}x              │
│  🔄 Trades reduced:    ${String(leverageReducedTrades.length).padStart(4)}/${trades.length} (${(leverageReducedTrades.length/trades.length*100).toFixed(1)}%)                              │
│  📈 Avg leverage used: ${avgLeverage.toFixed(2)}x                                                 │
│                                                                                 │
│  ⚠️  ATR threshold:    ${CONFIG.LIQUIDATION.HIGH_VOLATILITY_ATR_PCT}% (ATR > ${CONFIG.LIQUIDATION.HIGH_VOLATILITY_ATR_PCT}% = reduce leverage)           │
│  🛡️  Liquidation:      Gap ${CONFIG.LIQUIDATION.MAX_SIMULATED_GAP_PCT}% simulated, threshold ${CONFIG.LIQUIDATION.LIQUIDATION_THRESHOLD_PCT}%                  │
└────────────────────────────────────────────────────────────────────────────────┘`);

  console.log(`
┌────────────────────────────────────────────────────────────────────────────────┐
│                              PAR STRATÉGIE                                      │
├────────────────────────────────────────────────────────────────────────────────┤
│  📈 LONG (Bull):                                                                │
│     Trades: ${String(longTrades.length).padStart(4)} | Win Rate: ${longWR.toFixed(1)}%                                        │
│     Signaux: ${longSignals} | Régime Bull: ${(bullBars/(bullBars+bearBars)*100).toFixed(1)}% du temps                         │
│                                                                                 │
│  📉 SHORT (Bear):                                                               │
│     Trades: ${String(shortTrades.length).padStart(4)} | Win Rate: ${shortWR.toFixed(1)}%                                       │
│     Signaux: ${shortSignals} | Régime Bear: ${(bearBars/(bullBars+bearBars)*100).toFixed(1)}% du temps                        │
└────────────────────────────────────────────────────────────────────────────────┘
`);

  // Monthly breakdown
  console.log('\n📅 PERFORMANCE MENSUELLE:');
  console.log('─'.repeat(80));
  console.log('  Mois      │    PnL     │ L Trades │ S Trades │ Cumul Capital');
  console.log('─'.repeat(80));
  
  let cumulCapital = INITIAL_CAPITAL;
  for (const m of months) {
    const data = monthlyPnl[m];
    cumulCapital += data.pnl;
    const pnlStr = data.pnl >= 0 ? `+$${data.pnl.toFixed(0)}` : `-$${Math.abs(data.pnl).toFixed(0)}`;
    const barScale = INITIAL_CAPITAL >= 100000 ? 5000 : 200;  // Scale bars based on capital
    const bar = data.pnl > 0 
      ? '█'.repeat(Math.min(15, Math.floor(data.pnl / barScale)))
      : '░'.repeat(Math.min(15, Math.floor(Math.abs(data.pnl) / barScale)));
    console.log(`  ${m}  │ ${pnlStr.padStart(9)} │    ${String(data.longTrades).padStart(3)}   │    ${String(data.shortTrades).padStart(3)}   │ $${cumulCapital.toFixed(0).padStart(10)} ${bar}`);
  }
  console.log('─'.repeat(80));
  console.log(`  TOTAL     │ ${roi >= 0 ? '+' : ''}$${(capital - INITIAL_CAPITAL).toFixed(0).padStart(8)} │    ${String(longTrades.length).padStart(3)}   │    ${String(shortTrades.length).padStart(3)}   │ $${capital.toFixed(0).padStart(8)}`);
  
  // Exit reasons
  console.log('\n📊 RAISONS DE SORTIE:');
  const exitReasons = {};
  trades.forEach(t => { exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1; });
  for (const [reason, count] of Object.entries(exitReasons)) {
    console.log(`   ${reason}: ${count} (${(count/trades.length*100).toFixed(1)}%)`);
  }
  
  // Best/Worst trades
  const sortedByPnl = [...trades].sort((a, b) => b.netPnlUsd - a.netPnlUsd);
  console.log('\n🏆 TOP 5 TRADES:');
  for (const t of sortedByPnl.slice(0, 5)) {
    const cappedTag = t.wasCapped ? ' 🔒' : '';
    console.log(`   ${t.side.toUpperCase().padEnd(5)} ${t.symbol.padEnd(16)} +$${t.netPnlUsd.toFixed(2)} (${t.netPnlPct.toFixed(1)}%) - ${t.exitReason}${cappedTag}`);
  }
  
  console.log('\n💀 WORST 5 TRADES:');
  for (const t of sortedByPnl.slice(-5).reverse()) {
    const cappedTag = t.wasCapped ? ' 🔒' : '';
    console.log(`   ${t.side.toUpperCase().padEnd(5)} ${t.symbol.padEnd(16)} $${t.netPnlUsd.toFixed(2)} (${t.netPnlPct.toFixed(1)}%) - ${t.exitReason}${cappedTag}`);
  }
  
  // Summary
  console.log('\n' + '═'.repeat(80));
  console.log('💡 RÉSUMÉ V5.5 - LIQUIDITY-AWARE');
  console.log('═'.repeat(80));
  console.log(`
   ✅ ROI sur 24 mois: ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%
   ✅ Win Rate global: ${winRate.toFixed(1)}%
   ✅ Mois positifs: ${positiveMonths.length}/${months.length}
   ✅ Max Drawdown: ${maxDrawdown.toFixed(1)}%
   
   📈 LONG: ${longTrades.length} trades, ${longWR.toFixed(1)}% WR (${(bullBars/(bullBars+bearBars)*100).toFixed(1)}% du temps en Bull)
   📉 SHORT: ${shortTrades.length} trades, ${shortWR.toFixed(1)}% WR (${(bearBars/(bullBars+bearBars)*100).toFixed(1)}% du temps en Bear)
   
   💸 Coûts totaux: $${totalCosts.toFixed(2)} (${(totalCosts/trades.length).toFixed(2)}$/trade en moyenne)
   
   🔒 V5.5 LIQUIDITY IMPACT:
   - Positions cappées: ${cappedTrades.length}/${trades.length} (${(cappedTrades.length/trades.length*100).toFixed(1)}%)
   - Slippage additionnel moyen: ${avgSlippage.toFixed(3)}%
   - Coût slippage total: $${totalSlippageCost.toFixed(2)}
   ${INITIAL_CAPITAL >= 100000 ? `
   ⚠️  ATTENTION: Avec $${INITIAL_CAPITAL.toLocaleString()} de capital:
   - Les positions sur SEI/IMX (LOW tier) sont cappées à $25K max
   - Les positions sur XRP (MEDIUM tier) sont cappées à $100K max
   - Seul ETH (HIGH tier) peut avoir des positions jusqu'à $500K
   ` : ''}
`);
}

main().catch(console.error);
