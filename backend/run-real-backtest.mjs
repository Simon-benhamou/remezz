#!/usr/bin/env node
/**
 * Real Historical Data Backtest
 * Fetches actual market data and runs our strategy against it
 * 
 * ⚠️ WITH IMPROVEMENTS (Nov 25, 2025):
 *   - CMF requires ADX >= 20 (trend confirmation)
 *   - Squeeze Breakout requires volumeRatio >= 1.3
 *   - Ranging market penalty: ADX < 18 = -30% confidence
 */

import ccxt from 'ccxt';

// Configuration
const CONFIG = {
  symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
  timeframe: '15m',
  days: 60,  // 60 jours pour test de stabilité
  equityUsd: 10000,
  riskPerTrade: 0.01, // 1% risk per trade
};

// Fetch real OHLCV data from Binance with pagination for more than 1500 candles
async function fetchHistoricalData(symbol, timeframe, days) {
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();
  
  const timeframeMs = timeframe === '15m' ? 15 * 60 * 1000 : timeframe === '1h' ? 60 * 60 * 1000 : 5 * 60 * 1000;
  const totalCandles = Math.floor(days * 24 * 60 * 60 * 1000 / timeframeMs);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  
  console.log(`📥 Fetching ${symbol} ${timeframe} data (${days} days, ~${totalCandles} candles)...`);
  
  try {
    let allCandles = [];
    let currentSince = since;
    const batchSize = 1000;
    
    while (allCandles.length < totalCandles) {
      const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, currentSince, batchSize);
      if (ohlcv.length === 0) break;
      
      allCandles = allCandles.concat(ohlcv);
      currentSince = ohlcv[ohlcv.length - 1][0] + timeframeMs;
      
      // Avoid rate limiting
      await new Promise(r => setTimeout(r, 100));
      
      if (ohlcv.length < batchSize) break; // No more data
    }
    
    console.log(`   ✅ Got ${allCandles.length} candles from ${new Date(allCandles[0]?.[0]).toLocaleDateString()} to ${new Date(allCandles[allCandles.length-1]?.[0]).toLocaleDateString()}`);
    return allCandles;
  } catch (error) {
    console.error(`   ❌ Failed to fetch ${symbol}:`, error.message);
    return [];
  }
}

// Calculate technical indicators
function calculateIndicators(candles) {
  if (candles.length < 20) return null;
  
  const closes = candles.map(c => c[4]);
  const highs = candles.map(c => c[2]);
  const lows = candles.map(c => c[3]);
  const volumes = candles.map(c => c[5]);
  
  // EMA
  function ema(arr, period) {
    const k = 2 / (period + 1);
    let result = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      result.push(arr[i] * k + result[i-1] * (1 - k));
    }
    return result;
  }
  
  // RSI
  function rsi(arr, period = 14) {
    const changes = [];
    for (let i = 1; i < arr.length; i++) {
      changes.push(arr[i] - arr[i-1]);
    }
    
    let gains = [], losses = [];
    for (const change of changes) {
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? -change : 0);
    }
    
    const avgGain = ema(gains, period);
    const avgLoss = ema(losses, period);
    
    return avgGain.map((g, i) => {
      const l = avgLoss[i];
      if (l === 0) return 100;
      const rs = g / l;
      return 100 - (100 / (1 + rs));
    });
  }
  
  // ATR
  function atr(high, low, close, period = 14) {
    const tr = [];
    for (let i = 1; i < close.length; i++) {
      const hl = high[i] - low[i];
      const hpc = Math.abs(high[i] - close[i-1]);
      const lpc = Math.abs(low[i] - close[i-1]);
      tr.push(Math.max(hl, hpc, lpc));
    }
    return ema(tr, period);
  }
  
  // ADX
  function adx(high, low, close, period = 14) {
    const dmPlus = [], dmMinus = [], tr = [];
    
    for (let i = 1; i < close.length; i++) {
      const upMove = high[i] - high[i-1];
      const downMove = low[i-1] - low[i];
      
      dmPlus.push(upMove > downMove && upMove > 0 ? upMove : 0);
      dmMinus.push(downMove > upMove && downMove > 0 ? downMove : 0);
      
      const hl = high[i] - low[i];
      const hpc = Math.abs(high[i] - close[i-1]);
      const lpc = Math.abs(low[i] - close[i-1]);
      tr.push(Math.max(hl, hpc, lpc));
    }
    
    const smoothedTr = ema(tr, period);
    const smoothedDmPlus = ema(dmPlus, period);
    const smoothedDmMinus = ema(dmMinus, period);
    
    const diPlus = smoothedDmPlus.map((dp, i) => (dp / smoothedTr[i]) * 100);
    const diMinus = smoothedDmMinus.map((dm, i) => (dm / smoothedTr[i]) * 100);
    
    const dx = diPlus.map((dp, i) => {
      const sum = dp + diMinus[i];
      if (sum === 0) return 0;
      return Math.abs(dp - diMinus[i]) / sum * 100;
    });
    
    return ema(dx, period);
  }
  
  // CMF (Chaikin Money Flow)
  function cmf(high, low, close, volume, period = 20) {
    const mfm = close.map((c, i) => {
      const hl = high[i] - low[i];
      if (hl === 0) return 0;
      return ((c - low[i]) - (high[i] - c)) / hl;
    });
    
    const mfv = mfm.map((m, i) => m * volume[i]);
    
    const result = [];
    for (let i = period - 1; i < mfv.length; i++) {
      let sumMfv = 0, sumVol = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sumMfv += mfv[j];
        sumVol += volume[j];
      }
      result.push(sumVol > 0 ? sumMfv / sumVol : 0);
    }
    return result;
  }
  
  // Volume ratio
  const volumeMA = ema(volumes, 20);
  const currentVolume = volumes[volumes.length - 1];
  const avgVolume = volumeMA[volumeMA.length - 1];
  
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsiValues = rsi(closes, 14);
  const atrValues = atr(highs, lows, closes, 14);
  const adxValues = adx(highs, lows, closes, 14);
  const cmfValues = cmf(highs, lows, closes, volumes, 20);
  
  const last = closes[closes.length - 1];
  const atrVal = atrValues[atrValues.length - 1];
  
  // 24h change
  const barsIn24h = Math.min(96, candles.length - 1); // 96 x 15min = 24h
  const price24hAgo = closes[closes.length - 1 - barsIn24h];
  const change24h = ((last - price24hAgo) / price24hAgo) * 100;
  
  // 🚀 RECENT MOMENTUM: Last 4 candles (1 hour) price direction
  const recentBars = 4;
  const priceRecentAgo = closes[closes.length - 1 - recentBars] || closes[0];
  const recentMomentum = ((last - priceRecentAgo) / priceRecentAgo) * 100;
  
  // 🚀 CANDLE PATTERN: Is current candle bullish or bearish?
  const currentOpen = candles[candles.length - 1][1];
  const currentClose = candles[candles.length - 1][4];
  const currentHigh = candles[candles.length - 1][2];
  const currentLow = candles[candles.length - 1][3];
  const isBullishCandle = currentClose > currentOpen;
  const isBearishCandle = currentClose < currentOpen;
  const candleBody = Math.abs(currentClose - currentOpen);
  const candleRange = currentHigh - currentLow;
  const isStrongCandle = candleRange > 0 && candleBody / candleRange > 0.6; // Body > 60% of range
  
  return {
    last,
    ema20: ema20[ema20.length - 1],
    ema50: ema50[ema50.length - 1],
    rsi14: rsiValues[rsiValues.length - 1],
    atr14: atrVal,
    atrPct: (atrVal / last) * 100,
    adx14: adxValues[adxValues.length - 1] || 20,
    cmf20: cmfValues[cmfValues.length - 1] || 0,
    volumeRatio: avgVolume > 0 ? currentVolume / avgVolume : 1,
    change24h,
    recentMomentum, // 🆕 Last 1h momentum
    isBullishCandle, // 🆕 Current candle direction
    isBearishCandle,
    isStrongCandle, // 🆕 Strong body candle
    trend: ema20[ema20.length - 1] > ema50[ema50.length - 1] ? 1 : -1,
    // 🚀 HTF TREND: Use EMA100 vs EMA200 for higher timeframe trend
    htfTrend: (() => {
      const ema100 = ema(closes, Math.min(100, closes.length - 1));
      const ema200 = ema(closes, Math.min(200, closes.length - 1));
      if (ema100.length === 0 || ema200.length === 0) return 0;
      const e100 = ema100[ema100.length - 1];
      const e200 = ema200[ema200.length - 1];
      // Return normalized trend strength: positive = uptrend, negative = downtrend
      return (e100 - e200) / e200 * 10; // Scale for readability
    })(),
    timestamp: candles[candles.length - 1][0],
  };
}

// Simulate our strategy decision - MORE OPPORTUNITIES + BETTER DECISIONS
function makeDecision(indicators) {
  const {
    rsi14,
    adx14,
    cmf20,
    volumeRatio,
    change24h,
    trend,
    atrPct,
    recentMomentum,
    isBullishCandle,
    isBearishCandle,
    isStrongCandle,
    ema20,
    ema50,
    last,
    htfTrend,
  } = indicators;
  
  let decision = 'NO_TRADE';
  let confidence = 0;
  let reasons = [];
  
  // 🚀 MORE LENIENT MOMENTUM DETECTION
  const hasLongMomentum = recentMomentum > 0.08;  // Was 0.15 - too strict
  const hasShortMomentum = recentMomentum < -0.08;
  const hasAnyMomentum = Math.abs(recentMomentum) > 0.05;
  
  // Asset-specific volatility factor
  const isHighVolAsset = atrPct > 2.5;  // Was 2.0 - more lenient
  
  // 🆕 TREND ALIGNMENT SCORE (0-1): How aligned are all trend signals?
  const trendAlignment = (() => {
    let score = 0;
    // EMA trend
    if ((trend > 0 && hasLongMomentum) || (trend < 0 && hasShortMomentum)) score += 0.3;
    // CMF aligned with trend
    if ((trend > 0 && cmf20 > 0) || (trend < 0 && cmf20 < 0)) score += 0.25;
    // RSI in healthy zone (not extreme)
    if (rsi14 >= 35 && rsi14 <= 65) score += 0.25;
    // HTF trend aligned
    if ((trend > 0 && htfTrend > 0) || (trend < 0 && htfTrend < 0)) score += 0.2;
    return score;
  })();
  
  // ─────────────────────────────────────────────────────
  // STRATEGY 1: TREND FOLLOWING (balanced)
  // Simple: trade WITH the trend when confirmations align
  // ─────────────────────────────────────────────────────
  if (trendAlignment >= 0.60 && adx14 >= 18 && volumeRatio >= 1.25) {
    if (trend > 0 && hasLongMomentum && cmf20 > 0) {
      // LONG: Price above EMAs + momentum + positive CMF
      if (isBullishCandle && rsi14 < 68 && rsi14 > 35) {
        decision = 'LONG';
        confidence = 0.55 + trendAlignment * 0.12;
        reasons.push('TREND_FOLLOW');
      }
    } else if (trend < 0 && hasShortMomentum && cmf20 < 0) {
      // SHORT: Price below EMAs + momentum + negative CMF
      if (isBearishCandle && rsi14 > 32 && rsi14 < 65) {
        decision = 'SHORT';
        confidence = 0.58 + trendAlignment * 0.12;
        reasons.push('TREND_FOLLOW');
      }
    }
  }
  
  // ─────────────────────────────────────────────────────
  // STRATEGY 2: VOLUME SURGE (main edge strategy)
  // High volume = institutional interest
  // ─────────────────────────────────────────────────────
  const volumeThreshold = isHighVolAsset ? 1.6 : 1.45;
  if (volumeRatio >= volumeThreshold && adx14 >= 17) {
    // LONG: Strong volume with trend + positive CMF
    if (trend > 0 && cmf20 > 0.03 && hasLongMomentum && rsi14 < 68 && rsi14 > 32) {
      if (decision === 'NO_TRADE') {
        decision = 'LONG';
        confidence = 0.58 + (volumeRatio >= 2.0 ? 0.06 : 0);
      } else {
        confidence += 0.12;
      }
      reasons.push('VOLUME_SURGE');
    } 
    // SHORT: Works very well with momentum
    else if (trend < 0 && cmf20 < -0.02 && hasShortMomentum && rsi14 > 32 && rsi14 < 68) {
      if (decision === 'NO_TRADE') {
        decision = 'SHORT';
        confidence = 0.62 + Math.min(0.10, (volumeRatio - volumeThreshold) * 0.04);
      } else {
        confidence += 0.12;
      }
      reasons.push('VOLUME_SURGE');
    }
  }
  
  // ─────────────────────────────────────────────────────
  // STRATEGY 3: SQUEEZE BREAKOUT (needs stronger confirmation)
  // Only trade when multiple signals align
  // ─────────────────────────────────────────────────────
  const squeezeAtr = isHighVolAsset ? 2.2 : 1.8;
  const isSqueezing = atrPct < squeezeAtr && volumeRatio >= 1.5;  // Stricter volume
  if (isSqueezing && adx14 >= 20) {
    const cmfConfirms = (trend > 0 && cmf20 > 0.05) || (trend < 0 && cmf20 < -0.05);
    // Need CMF confirmation + candle pattern for squeeze
    if (cmfConfirms && isStrongCandle) {
      if (trend > 0 && hasLongMomentum && rsi14 >= 40 && rsi14 < 68) {
        if (decision === 'NO_TRADE') {
          decision = 'LONG';
          confidence = 0.58;
        } else {
          confidence += 0.10;
        }
        reasons.push('SQUEEZE_BREAKOUT');
      } 
      else if (trend < 0 && hasShortMomentum && rsi14 > 32 && rsi14 <= 60) {
        if (decision === 'NO_TRADE') {
          decision = 'SHORT';
          confidence = 0.60;
        } else {
          confidence += 0.10;
        }
        reasons.push('SQUEEZE_BREAKOUT');
      }
    }
  }
  
  // ─────────────────────────────────────────────────────
  // STRATEGY 4: MOMENTUM BREAKOUT (stronger requirements)
  // Strong recent momentum with volume = ride the wave
  // ─────────────────────────────────────────────────────
  if (Math.abs(recentMomentum) > 0.25 && volumeRatio >= 1.5 && isStrongCandle) {
    // LONG: Must have trend alignment + positive CMF
    if (recentMomentum > 0.25 && cmf20 > 0.05 && rsi14 >= 35 && rsi14 < 68 && trend > 0) {
      if (decision === 'NO_TRADE') {
        decision = 'LONG';
        confidence = 0.60;
        reasons.push('MOMENTUM_BREAKOUT');
      } else {
        confidence += 0.10;
        reasons.push('MOMENTUM_BREAKOUT');
      }
    // SHORT: Must have downtrend alignment + negative CMF
    } else if (recentMomentum < -0.25 && cmf20 < -0.05 && rsi14 > 32 && rsi14 <= 65 && trend < 0) {
      if (decision === 'NO_TRADE') {
        decision = 'SHORT';
        confidence = 0.62;
        reasons.push('MOMENTUM_BREAKOUT');
      } else {
        confidence += 0.10;
        reasons.push('MOMENTUM_BREAKOUT');
      }
    }
  }
  
  // ─────────────────────────────────────────────────────
  // STRATEGY 5: REVERSAL SETUPS (keep - works well)
  // RSI extreme + volume spike + candle confirmation
  // ─────────────────────────────────────────────────────
  if (volumeRatio >= 1.5 && isStrongCandle) {  // Was 2.0 - more trades
    // Oversold bounce
    if (rsi14 < 32 && cmf20 > 0.03 && isBullishCandle && recentMomentum > 0) {
      if (decision === 'NO_TRADE') {
        decision = 'LONG';
        confidence = 0.62;
        reasons.push('OVERSOLD_BOUNCE');
      }
    }
    // Overbought rejection
    else if (rsi14 > 68 && cmf20 < -0.03 && isBearishCandle && recentMomentum < 0) {
      if (decision === 'NO_TRADE') {
        decision = 'SHORT';
        confidence = 0.62;
        reasons.push('OVERBOUGHT_REJECTION');
      }
    }
  }
  
  // ─────────────────────────────────────────────────────
  // STRATEGY 6: EMA CROSSOVER (DISABLED - low WR)
  // Only use as very minor confidence boost, not tracked
  // ─────────────────────────────────────────────────────
  const priceAboveEma20 = last > ema20;
  const priceBelowEma20 = last < ema20;
  const nearEma20 = Math.abs(last - ema20) / ema20 < 0.003;
  
  // Only boost existing strong trades near EMA - don't track separately
  if (decision !== 'NO_TRADE' && nearEma20 && volumeRatio >= 1.5 && isStrongCandle) {
    if (priceAboveEma20 && decision === 'LONG' && cmf20 > 0.05) {
      confidence += 0.05;
      // Don't add as reason
    } else if (priceBelowEma20 && decision === 'SHORT' && cmf20 < -0.05) {
      confidence += 0.05;
      // Don't add as reason
    }
  }
  
  // ─────────────────────────────────────────────────────
  // STRATEGY 7: PULLBACK ENTRY (high WR strategy)
  // Buy dips in uptrends, sell rallies in downtrends
  // ─────────────────────────────────────────────────────
  const isPullbackLong = trend > 0 && htfTrend > 0.05 && rsi14 < 48 && rsi14 > 28 && cmf20 > -0.03;
  const isPullbackShort = trend < 0 && htfTrend < -0.05 && rsi14 > 52 && rsi14 < 72 && cmf20 < 0.03;
  
  if (volumeRatio >= 1.2 && adx14 >= 16) {
    if (isPullbackLong && isBullishCandle && recentMomentum > 0.05) {
      if (decision === 'NO_TRADE') {
        decision = 'LONG';
        confidence = 0.58;
        reasons.push('PULLBACK_ENTRY');
      } else {
        confidence += 0.07;
        reasons.push('PULLBACK_ENTRY');
      }
    } else if (isPullbackShort && isBearishCandle && recentMomentum < -0.05) {
      if (decision === 'NO_TRADE') {
        decision = 'SHORT';
        confidence = 0.60;
        reasons.push('PULLBACK_ENTRY');
      } else {
        confidence += 0.07;
        reasons.push('PULLBACK_ENTRY');
      }
    }
  }
  
  // ─────────────────────────────────────────────────────
  // STRATEGY 8: HIGH VOLUME + CANDLE PATTERN (NEW)
  // Engulfing-like patterns with volume = reversal
  // ─────────────────────────────────────────────────────
  if (volumeRatio >= 1.8 && isStrongCandle && adx14 >= 15) {
    // Strong bullish candle in potential reversal zone
    if (isBullishCandle && rsi14 < 50 && rsi14 > 25 && cmf20 > 0.02 && recentMomentum > 0.1) {
      if (decision === 'NO_TRADE') {
        decision = 'LONG';
        confidence = 0.57;
        reasons.push('CANDLE_BREAKOUT');
      } else {
        confidence += 0.06;
      }
    }
    // Strong bearish candle in potential reversal zone
    else if (isBearishCandle && rsi14 > 50 && rsi14 < 75 && cmf20 < -0.02 && recentMomentum < -0.1) {
      if (decision === 'NO_TRADE') {
        decision = 'SHORT';
        confidence = 0.59;
        reasons.push('CANDLE_BREAKOUT');
      } else {
        confidence += 0.06;
      }
    }
  }
  
  // ─────────────────────────────────────────────────────
  // STRATEGY 9: RSI DIVERGENCE SETUP (NEW)
  // RSI moving against price = potential reversal
  // ─────────────────────────────────────────────────────
  // Price making new lows but RSI higher = bullish divergence
  const bullishDivergence = rsi14 > 35 && rsi14 < 50 && change24h < -2 && recentMomentum > 0;
  // Price making new highs but RSI lower = bearish divergence  
  const bearishDivergence = rsi14 < 65 && rsi14 > 50 && change24h > 2 && recentMomentum < 0;
  
  if (volumeRatio >= 1.4 && isStrongCandle) {
    if (bullishDivergence && isBullishCandle && cmf20 > 0) {
      if (decision === 'NO_TRADE') {
        decision = 'LONG';
        confidence = 0.58;
        reasons.push('RSI_DIVERGENCE');
      } else {
        confidence += 0.06;
      }
    } else if (bearishDivergence && isBearishCandle && cmf20 < 0) {
      if (decision === 'NO_TRADE') {
        decision = 'SHORT';
        confidence = 0.60;
        reasons.push('RSI_DIVERGENCE');
      } else {
        confidence += 0.06;
      }
    }
  }
  
  // ─────────────────────────────────────────────────────
  // CONFIDENCE BOOSTERS (add-ons for quality)
  // CMF_STRONG should boost existing trades, not be a signal
  // ─────────────────────────────────────────────────────
  if (decision !== 'NO_TRADE') {
    // CMF strongly confirms direction - ONLY BOOST, don't add as reason
    if (Math.abs(cmf20) > 0.15 && adx14 >= 20) {
      if ((cmf20 > 0.15 && decision === 'LONG') || (cmf20 < -0.15 && decision === 'SHORT')) {
        confidence += 0.07;
        // Don't push CMF_STRONG as a reason - it's just a confirmation
      }
    }
    
    // HTF trend aligned = higher confidence
    if ((htfTrend > 0.15 && decision === 'LONG') || (htfTrend < -0.15 && decision === 'SHORT')) {
      confidence += 0.06;
      reasons.push('HTF_ALIGNED');
    }
    
    // Multiple confirmations bonus
    if (reasons.length >= 3) {
      confidence += 0.06;
    }
    
    // Volume confirmation bonus
    if (volumeRatio >= 2.0) {
      confidence += 0.04;
    }
  }
  
  // ─────────────────────────────────────────────────────
  // QUALITY FILTERS (minimal - avoid over-filtering)
  // ─────────────────────────────────────────────────────
  
  // Only filter EXTREME conditions
  if (rsi14 >= 82 && decision === 'LONG') {
    confidence *= 0.70;
    reasons.push('EXTREME_OVERBOUGHT');
  }
  if (rsi14 <= 18 && decision === 'SHORT') {
    confidence *= 0.70;
    reasons.push('EXTREME_OVERSOLD');
  }
  
  // Very low ADX = ranging, slight penalty only
  if (adx14 < 12) {
    confidence *= 0.80;
  }
  
  // CONFLUENCE BONUS: Multiple strategy signals = much higher quality
  // This rewards trades where multiple independent strategies agree
  const mainSignals = reasons.filter(r => 
    ['TREND_FOLLOW', 'VOLUME_SURGE', 'SQUEEZE_BREAKOUT', 'MOMENTUM_BREAKOUT', 'PULLBACK_ENTRY', 'RSI_DIVERGENCE', 'CANDLE_BREAKOUT'].includes(r)
  );
  if (mainSignals.length >= 3) {
    confidence += 0.08;  // Strong confluence bonus
  } else if (mainSignals.length >= 2) {
    confidence += 0.04;  // Moderate confluence bonus
  }
  
  return { decision, confidence, reasons };
}

// Simulate a trade - IMPROVED R:R with DYNAMIC STOP based on volatility
function simulateTrade(entry, candles, side, atrPct) {
  const entryPrice = entry.last;
  
  // 🚀 DYNAMIC STOP: Scale stop distance with volatility
  // Low vol assets (BTC): 2x ATR
  // High vol assets (SOL): 2.5x ATR to avoid noise
  const stopMultiplier = atrPct > 2.0 ? 2.5 : 2.0;
  const stopDistance = entryPrice * (atrPct / 100) * stopMultiplier;
  
  // Better R:R - TP1 at 2:1, TP2 at 3.5:1
  const tp1Distance = stopDistance * 2.0;
  const tp2Distance = stopDistance * 3.5;
  
  const stopPrice = side === 'LONG' 
    ? entryPrice - stopDistance 
    : entryPrice + stopDistance;
  const tp1Price = side === 'LONG'
    ? entryPrice + tp1Distance
    : entryPrice - tp1Distance;
  const tp2Price = side === 'LONG'
    ? entryPrice + tp2Distance
    : entryPrice - tp2Distance;
  
  // Simulate forward looking
  let exitPrice = null;
  let exitReason = null;
  let holdBars = 0;
  
  for (let i = 0; i < candles.length && i < 96; i++) { // Max 24h hold
    const candle = candles[i];
    const high = candle[2];
    const low = candle[3];
    holdBars++;
    
    // Check stop
    if (side === 'LONG' && low <= stopPrice) {
      exitPrice = stopPrice;
      exitReason = 'STOP_LOSS';
      break;
    }
    if (side === 'SHORT' && high >= stopPrice) {
      exitPrice = stopPrice;
      exitReason = 'STOP_LOSS';
      break;
    }
    
    // Check TP1 (take 50%)
    if (side === 'LONG' && high >= tp1Price && !exitPrice) {
      // Trailing after TP1
      const trailingStop = tp1Price - (stopDistance * 0.5);
      if (low <= trailingStop) {
        exitPrice = trailingStop;
        exitReason = 'TRAILING_STOP_AFTER_TP1';
        break;
      }
    }
    if (side === 'SHORT' && low <= tp1Price && !exitPrice) {
      const trailingStop = tp1Price + (stopDistance * 0.5);
      if (high >= trailingStop) {
        exitPrice = trailingStop;
        exitReason = 'TRAILING_STOP_AFTER_TP1';
        break;
      }
    }
    
    // Check TP2 (exit runner)
    if (side === 'LONG' && high >= tp2Price) {
      exitPrice = tp2Price;
      exitReason = 'TP2_RUNNER';
      break;
    }
    if (side === 'SHORT' && low <= tp2Price) {
      exitPrice = tp2Price;
      exitReason = 'TP2_RUNNER';
      break;
    }
  }
  
  // If still open after max bars, close at current price
  if (!exitPrice && candles.length > 0) {
    exitPrice = candles[Math.min(holdBars, candles.length - 1)][4];
    exitReason = 'TIME_EXIT';
  }
  
  if (!exitPrice) return null;
  
  const pnlPct = side === 'LONG'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  return {
    side,
    entryPrice,
    exitPrice,
    exitReason,
    pnlPct,
    holdBars,
    holdMinutes: holdBars * 15,
  };
}

// Run backtest on a symbol
async function backtestSymbol(symbol, candles) {
  const trades = [];
  let equity = CONFIG.equityUsd;
  let peakEquity = equity;
  let maxDrawdown = 0;
  
  // 🚀 ASSET-BASED CONFIDENCE ADJUSTMENT
  // Less aggressive - focus on decision quality, not filtering
  // BTC: full confidence (1.0)
  // ETH: slight adjustment (0.95)
  // Others: moderate adjustment (0.90) - still take good opportunities
  const assetConfidenceMultiplier = symbol.includes('BTC') ? 1.0 
    : symbol.includes('ETH') ? 0.95 
    : 0.90; // Less aggressive - don't over-filter
  
  const lookback = 100; // Need 100 candles for indicators
  
  for (let i = lookback; i < candles.length - 96; i++) {
    const historyCandles = candles.slice(i - lookback, i + 1);
    const futureCandles = candles.slice(i + 1, i + 97); // Next 24h for simulation
    
    const indicators = calculateIndicators(historyCandles);
    if (!indicators) continue;
    
    let { decision, confidence, reasons } = makeDecision(indicators);
    
    // Apply asset-based confidence adjustment
    confidence *= assetConfidenceMultiplier;
    
    // Lower threshold - we want MORE opportunities (0.45 instead of 0.50)
    if (decision === 'NO_TRADE' || confidence < 0.45) continue;
    
    const result = simulateTrade(indicators, futureCandles, decision, indicators.atrPct);
    if (!result) continue;
    
    // Position sizing: risk 1% of equity per trade
    const riskAmount = equity * CONFIG.riskPerTrade;
    const stopDistance = indicators.atrPct * 1.5;
    const positionSize = riskAmount / (indicators.last * (stopDistance / 100));
    
    const pnlUsd = positionSize * indicators.last * (result.pnlPct / 100);
    equity += pnlUsd;
    
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = (peakEquity - equity) / peakEquity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    
    trades.push({
      timestamp: new Date(indicators.timestamp).toISOString(),
      ...result,
      reasons: reasons.join(', '),
      confidence,
      pnlUsd: pnlUsd.toFixed(2),
      equity: equity.toFixed(2),
    });
    
    // Skip forward after a trade - but less aggressive to catch more opportunities
    i += Math.max(4, Math.floor(result.holdBars * 0.5));  // At least 1h, max half of hold time
  }
  
  return {
    symbol,
    trades,
    equity,
    maxDrawdown,
    peakEquity,
  };
}

// Main execution
async function main() {
  console.log('═'.repeat(80));
  console.log('📊 REAL HISTORICAL BACKTEST - Meta-Adaptive Strategy');
  console.log('═'.repeat(80));
  console.log(`📅 Period: Last ${CONFIG.days} days`);
  console.log(`💰 Starting Equity: $${CONFIG.equityUsd.toLocaleString()}`);
  console.log(`📈 Risk per Trade: ${CONFIG.riskPerTrade * 100}%`);
  console.log(`⏱️ Timeframe: ${CONFIG.timeframe}`);
  console.log('═'.repeat(80));
  
  const allResults = [];
  
  for (const symbol of CONFIG.symbols) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🔍 Backtesting ${symbol}...`);
    console.log('─'.repeat(60));
    
    const candles = await fetchHistoricalData(symbol, CONFIG.timeframe, CONFIG.days);
    if (candles.length < 200) {
      console.log(`   ⚠️ Not enough data for ${symbol}, skipping`);
      continue;
    }
    
    const result = await backtestSymbol(symbol, candles);
    allResults.push(result);
    
    // Print results for this symbol
    const wins = result.trades.filter(t => t.pnlPct > 0).length;
    const losses = result.trades.filter(t => t.pnlPct < 0).length;
    const winRate = result.trades.length > 0 ? (wins / result.trades.length) * 100 : 0;
    const totalPnlPct = ((result.equity - CONFIG.equityUsd) / CONFIG.equityUsd) * 100;
    const avgWin = wins > 0 
      ? result.trades.filter(t => t.pnlPct > 0).reduce((a, t) => a + t.pnlPct, 0) / wins 
      : 0;
    const avgLoss = losses > 0 
      ? result.trades.filter(t => t.pnlPct < 0).reduce((a, t) => a + t.pnlPct, 0) / losses 
      : 0;
    const profitFactor = Math.abs(avgLoss) > 0 
      ? (wins * avgWin) / (losses * Math.abs(avgLoss)) 
      : wins > 0 ? Infinity : 0;
    
    console.log(`\n📊 ${symbol} Results:`);
    console.log(`   Total Trades: ${result.trades.length}`);
    console.log(`   Win Rate: ${winRate.toFixed(1)}% (${wins}W / ${losses}L)`);
    console.log(`   Profit Factor: ${profitFactor.toFixed(2)}`);
    console.log(`   Avg Win: ${avgWin.toFixed(2)}%`);
    console.log(`   Avg Loss: ${avgLoss.toFixed(2)}%`);
    console.log(`   Total Return: ${totalPnlPct >= 0 ? '+' : ''}${totalPnlPct.toFixed(2)}%`);
    console.log(`   Max Drawdown: ${(result.maxDrawdown * 100).toFixed(2)}%`);
    console.log(`   Final Equity: $${result.equity.toFixed(2)}`);
    
    // Show last 5 trades
    if (result.trades.length > 0) {
      console.log(`\n   📋 Last 5 trades:`);
      for (const trade of result.trades.slice(-5)) {
        const emoji = trade.pnlPct > 0 ? '✅' : '❌';
        console.log(`   ${emoji} ${trade.side} | ${trade.exitReason} | PnL: ${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct.toFixed(2)}% | ${trade.reasons}`);
      }
    }
  }
  
  // Aggregate results
  console.log('\n' + '═'.repeat(80));
  console.log('📊 AGGREGATE RESULTS');
  console.log('═'.repeat(80));
  
  const totalTrades = allResults.reduce((a, r) => a + r.trades.length, 0);
  const allTrades = allResults.flatMap(r => r.trades);
  const allWins = allTrades.filter(t => t.pnlPct > 0).length;
  const allLosses = allTrades.filter(t => t.pnlPct < 0).length;
  const overallWinRate = totalTrades > 0 ? (allWins / totalTrades) * 100 : 0;
  
  // Combined equity simulation
  let combinedEquity = CONFIG.equityUsd * CONFIG.symbols.length;
  const combinedPnl = allResults.reduce((a, r) => a + (r.equity - CONFIG.equityUsd), 0);
  const combinedReturn = (combinedPnl / (CONFIG.equityUsd * CONFIG.symbols.length)) * 100;
  
  console.log(`\n📈 Overall Performance:`);
  console.log(`   Total Trades: ${totalTrades}`);
  console.log(`   Overall Win Rate: ${overallWinRate.toFixed(1)}% (${allWins}W / ${allLosses}L)`);
  console.log(`   Combined Return: ${combinedReturn >= 0 ? '+' : ''}${combinedReturn.toFixed(2)}%`);
  console.log(`   Avg Trade PnL: ${(allTrades.reduce((a, t) => a + t.pnlPct, 0) / totalTrades).toFixed(2)}%`);
  
  // Break down by strategy reason
  console.log(`\n📋 Performance by Strategy Signal:`);
  const reasonStats = {};
  for (const trade of allTrades) {
    for (const reason of trade.reasons.split(', ')) {
      if (!reasonStats[reason]) {
        reasonStats[reason] = { wins: 0, losses: 0, totalPnl: 0 };
      }
      if (trade.pnlPct > 0) {
        reasonStats[reason].wins++;
      } else {
        reasonStats[reason].losses++;
      }
      reasonStats[reason].totalPnl += trade.pnlPct;
    }
  }
  
  for (const [reason, stats] of Object.entries(reasonStats)) {
    const total = stats.wins + stats.losses;
    const winRate = (stats.wins / total) * 100;
    console.log(`   ${reason}: ${stats.wins}W/${stats.losses}L (${winRate.toFixed(0)}%) | Avg: ${(stats.totalPnl / total).toFixed(2)}%`);
  }
  
  console.log('\n' + '═'.repeat(80));
  console.log('🏁 BACKTEST COMPLETE');
  console.log('═'.repeat(80));
}

main().catch(console.error);
