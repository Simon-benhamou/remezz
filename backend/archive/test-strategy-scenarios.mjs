#!/usr/bin/env node
/**
 * 🧪 COMPREHENSIVE STRATEGY SCENARIO TESTER
 * 
 * Tests various market conditions with different indicator combinations to evaluate:
 * - When the agent would take a trade vs pass
 * - If the decision was wise given the market context
 * - How Big Move Mode, RSI extremes, ADX, volume, etc. affect decisions
 * 
 * Run: node backend/test-strategy-scenarios.mjs
 */

// ============================================
// 🎯 INLINE DETECTION FUNCTIONS (mirror of reboundDetection.ts logic)
// ============================================

/**
 * Detect if we're in a "big move" day where extreme RSI = momentum, not exhaustion
 */
function detectBigMoveMode(snap, change24hPct) {
  const reasons = [];
  const adx = snap.adx14;
  const volumeRatio = snap.volumeRatio ?? 1;
  
  // Estimate 24h change from price vs EMA200 if not provided
  const price = snap.last;
  const ema200 = snap.ema200 ?? price;
  const estimatedChange = change24hPct ?? (ema200 > 0 ? ((price - ema200) / ema200) * 100 : 0);
  const absChange = Math.abs(estimatedChange);
  
  let isBigMove = false;
  let strength = 0;
  let direction = null;
  
  if (absChange >= 10) {
    direction = estimatedChange > 0 ? 'pump' : 'dump';
    strength = Math.min(absChange / 20, 1);
    reasons.push(`24h_change_${absChange.toFixed(1)}%_${direction}`);
    
    if (adx >= 30) {
      strength += 0.3;
      reasons.push(`strong_trend_adx_${adx.toFixed(1)}`);
      isBigMove = true;
    } else if (adx >= 25) {
      strength += 0.15;
      reasons.push(`moderate_trend_adx_${adx.toFixed(1)}`);
      isBigMove = absChange >= 15;
    }
    
    if (volumeRatio >= 1.5) {
      strength += 0.2;
      reasons.push(`high_volume_${volumeRatio.toFixed(1)}x`);
      isBigMove = true;
    } else if (volumeRatio >= 1.2) {
      strength += 0.1;
      reasons.push(`elevated_volume_${volumeRatio.toFixed(1)}x`);
    }
    
    if (absChange >= 20) {
      isBigMove = true;
      strength = Math.min(strength + 0.3, 1.5);
      reasons.push('extreme_move_override');
    }
  }
  
  return { isBigMove, direction, strength: Number(strength.toFixed(2)), reasons };
}

/**
 * Detect potential rebounds for SHORT positions
 */
function detectReboundForShort(snap, change24hPct) {
  const bigMove = detectBigMoveMode(snap, change24hPct);
  
  const components = {
    rsi: 0,
    priceStructure: 0,
    volume: 0,
    momentum: 0,
    bigMoveBoost: 0,
  };
  
  const reasons = [];
  
  // BIG MOVE MODE: If we're in a DUMP, extreme RSI is an OPPORTUNITY
  if (bigMove.isBigMove && bigMove.direction === 'dump') {
    reasons.push('🚀 BIG_MOVE_MODE: Dump in progress - extreme RSI = trend continuation');
    reasons.push(...bigMove.reasons);
    
    const rsi14 = snap.rsi14 ?? 50;
    if (rsi14 < 30) {
      components.bigMoveBoost = -0.5 * bigMove.strength;
      reasons.push(`extreme_RSI_${rsi14.toFixed(0)}_confirms_dump_strength`);
    }
    
    const probability = Math.max(0, 0.15 - (bigMove.strength * 0.1));
    return {
      probability: Number(probability.toFixed(4)),
      severity: 'low',
      reasons,
      shouldBlock: false,
      tradeBias: 'favor_short',
      isBigMoveMode: true,
      bigMoveDirection: 'dump',
      components,
    };
  }
  
  // NORMAL MODE
  const rsi14 = snap.rsi14 ?? 50;
  
  if (rsi14 < 25) {
    components.rsi = 0.95;
    reasons.push(`rsi14_extreme_oversold(${rsi14.toFixed(1)})`);
  } else if (rsi14 < 30) {
    components.rsi = 0.75;
    reasons.push(`rsi14_oversold(${rsi14.toFixed(1)})`);
  } else if (rsi14 < 35) {
    components.rsi = 0.55;
    reasons.push(`rsi14_low(${rsi14.toFixed(1)})`);
  } else if (rsi14 < 40) {
    components.rsi = 0.35;
    reasons.push(`rsi14_weak(${rsi14.toFixed(1)})`);
  } else {
    components.rsi = 0.05;
  }
  
  const rsiSlope = snap.rsiSlope ?? 0;
  if (rsi14 < 40 && rsiSlope > 1.5) {
    components.rsi = Math.min(1, components.rsi + 0.25);
    reasons.push('rsi_bullish_divergence_detected');
  }
  
  const price = snap.last;
  const ema20 = snap.ema20 ?? price;
  
  let distBelowEma20 = 0;
  if (price > 0 && ema20 > 0 && price < ema20) {
    distBelowEma20 = ((ema20 - price) / price) * 100;
  }
  
  if (distBelowEma20 > 3) {
    components.priceStructure = 0.8;
    reasons.push(`stretched_below_ema20(-${distBelowEma20.toFixed(1)}%)`);
  } else if (distBelowEma20 > 2) {
    components.priceStructure = 0.6;
  } else if (distBelowEma20 > 1) {
    components.priceStructure = 0.4;
  }
  
  const volumeRatio = snap.volumeRatio ?? 1;
  const cmf = snap.cmf20 ?? 0;
  
  if (volumeRatio < 0.7 && cmf < 0) {
    components.volume = 0.6;
    reasons.push('low_volume_downmove');
  } else if (volumeRatio < 0.9) {
    components.volume = 0.3;
  }
  
  if (cmf > 0.05 && price < ema20) {
    components.volume = Math.min(1, components.volume + 0.3);
    reasons.push('positive_cmf_on_dip');
  }
  
  const adx = snap.adx14;
  
  if (adx < 15) {
    components.momentum = 0.6;
    reasons.push(`weak_momentum(adx=${adx.toFixed(1)})`);
  } else if (adx < 20) {
    components.momentum = 0.4;
  }
  
  const probability = 
    components.rsi * 0.35 +
    components.priceStructure * 0.30 +
    components.volume * 0.20 +
    components.momentum * 0.15;
  
  let severity = 'low';
  if (probability >= 0.75) severity = 'critical';
  else if (probability >= 0.6) severity = 'high';
  else if (probability >= 0.4) severity = 'medium';
  
  const shouldBlock = probability >= 0.85 && rsi14 < 20 && components.priceStructure >= 0.8;
  
  let tradeBias = 'neutral';
  if (probability >= 0.70) tradeBias = 'favor_long';
  else if (probability >= 0.55) tradeBias = 'avoid_short';
  
  return {
    probability: Number(probability.toFixed(4)),
    severity,
    reasons,
    shouldBlock,
    tradeBias,
    isBigMoveMode: false,
    bigMoveDirection: null,
    components,
  };
}

/**
 * Detect potential reversals for LONG positions
 */
function detectReversalForLong(snap, change24hPct) {
  const bigMove = detectBigMoveMode(snap, change24hPct);
  
  // BIG MOVE MODE: If we're in a PUMP, extreme RSI is an OPPORTUNITY
  if (bigMove.isBigMove && bigMove.direction === 'pump') {
    const reasons = ['🚀 BIG_MOVE_MODE: Pump in progress - extreme RSI = trend continuation'];
    reasons.push(...bigMove.reasons);
    
    const components = {
      rsi: 0,
      priceStructure: 0,
      volume: 0,
      momentum: 0,
      bigMoveBoost: 0,
    };
    
    const rsi14 = snap.rsi14 ?? 50;
    if (rsi14 > 70) {
      components.bigMoveBoost = -0.5 * bigMove.strength;
      reasons.push(`extreme_RSI_${rsi14.toFixed(0)}_confirms_pump_strength`);
    }
    
    const probability = Math.max(0, 0.15 - (bigMove.strength * 0.1));
    return {
      probability: Number(probability.toFixed(4)),
      severity: 'low',
      reasons,
      shouldBlock: false,
      tradeBias: 'favor_long',
      isBigMoveMode: true,
      bigMoveDirection: 'pump',
      components,
    };
  }
  
  // NORMAL MODE
  const components = {
    rsi: 0,
    priceStructure: 0,
    volume: 0,
    momentum: 0,
    bigMoveBoost: 0,
  };
  
  const reasons = [];
  const rsi14 = snap.rsi14 ?? 50;
  
  if (rsi14 > 75) {
    components.rsi = 0.9;
    reasons.push(`rsi14_extreme_overbought(${rsi14.toFixed(1)})`);
  } else if (rsi14 > 70) {
    components.rsi = 0.7;
    reasons.push(`rsi14_overbought(${rsi14.toFixed(1)})`);
  } else if (rsi14 > 65) {
    components.rsi = 0.5;
  } else if (rsi14 > 60) {
    components.rsi = 0.3;
  }
  
  const rsiSlope = snap.rsiSlope ?? 0;
  if (rsi14 > 65 && rsiSlope < -1.5) {
    components.rsi = Math.min(1, components.rsi + 0.2);
    reasons.push('rsi_bearish_divergence_detected');
  }
  
  const price = snap.last;
  const ema20 = snap.ema20 ?? price;
  
  let distAboveEma20 = 0;
  if (price > 0 && ema20 > 0 && price > ema20) {
    distAboveEma20 = ((price - ema20) / price) * 100;
  }
  
  if (distAboveEma20 > 3) {
    components.priceStructure = 0.8;
    reasons.push(`stretched_above_ema20(+${distAboveEma20.toFixed(1)}%)`);
  } else if (distAboveEma20 > 2) {
    components.priceStructure = 0.6;
  } else if (distAboveEma20 > 1) {
    components.priceStructure = 0.4;
  }
  
  const volumeRatio = snap.volumeRatio ?? 1;
  const cmf = snap.cmf20 ?? 0;
  
  if (volumeRatio < 0.7 && cmf > 0) {
    components.volume = 0.6;
    reasons.push('low_volume_rally');
  }
  
  if (cmf < -0.05 && price > ema20) {
    components.volume = Math.min(1, components.volume + 0.3);
    reasons.push('negative_cmf_on_rally');
  }
  
  const adx = snap.adx14;
  
  if (adx < 15) {
    components.momentum = 0.6;
    reasons.push(`weak_momentum(adx=${adx.toFixed(1)})`);
  } else if (adx < 20) {
    components.momentum = 0.4;
  }
  
  const probability = 
    components.rsi * 0.35 +
    components.priceStructure * 0.30 +
    components.volume * 0.20 +
    components.momentum * 0.15;
  
  let severity = 'low';
  if (probability >= 0.75) severity = 'critical';
  else if (probability >= 0.6) severity = 'high';
  else if (probability >= 0.4) severity = 'medium';
  
  const shouldBlock = probability >= 0.85 && rsi14 > 80 && components.priceStructure >= 0.8;
  
  let tradeBias = 'neutral';
  if (probability >= 0.70) tradeBias = 'favor_short';
  else if (probability >= 0.55) tradeBias = 'avoid_long';
  
  return {
    probability: Number(probability.toFixed(4)),
    severity,
    reasons,
    shouldBlock,
    tradeBias,
    isBigMoveMode: false,
    bigMoveDirection: null,
    components,
  };
}

// ============================================
// 🎯 SCENARIO DEFINITIONS
// ============================================

/**
 * Create a technical snapshot with customizable indicators
 */
function createSnapshot(overrides = {}) {
  const defaults = {
    symbol: 'BTCUSDT',
    last: 100000,
    bid: 99995,
    ask: 100005,
    volume: 1000000,
    volumeMA: 900000,
    volumeRatio: 1.1,
    volumeZScore: 0.5,
    atr14: 2500,
    atrPct: 2.5,
    adx14: 25,
    rsi14: 50,
    rsi7: 50,
    rsiSlope: 0,
    ema20: 99500,
    ema50: 99000,
    ema200: 95000,
    sma200: 94000,
    macdLine: 100,
    macdSignal: 80,
    macdHistogram: 20,
    bbUpper: 102000,
    bbMiddle: 100000,
    bbLower: 98000,
    cmf20: 0.05,
    trend: 0.3,
    trendBias: 'neutral',
    srBias: 'none',
    obv: 5000000,
    ...overrides,
  };
  
  return defaults;
}

/**
 * Create ranking data with daily change
 */
function createRanking(change24hPct = 0, volumeUsd = 50000000) {
  return {
    change24hPct,
    volumeUsd,
    volatilityPct: 2.5,
    momentumScore: 0.5,
  };
}

// ============================================
// 📊 TEST SCENARIOS
// ============================================

const scenarios = [
  // ========== RSI EXTREME SCENARIOS ==========
  {
    name: '🔴 RSI 5 during -20% dump (BIG MOVE SHORT OPPY)',
    description: 'Extreme oversold during massive dump - should be SHORT opportunity, NOT rebound warning',
    expected: 'TRADE SHORT (momentum continuation)',
    isWise: true,
    snap: createSnapshot({
      rsi14: 5,
      rsi7: 8,
      adx14: 45,
      trend: -0.9,
      trendBias: 'bearish',
      volumeRatio: 2.5,
      volumeZScore: 3.0,
      cmf20: -0.3,
      last: 80000,
      ema20: 90000,
      ema50: 95000,
      ema200: 100000,
    }),
    ranking: createRanking(-20),
  },
  {
    name: '🟢 RSI 95 during +20% pump (BIG MOVE LONG OPPY)',
    description: 'Extreme overbought during massive pump - should be LONG opportunity, NOT reversal warning',
    expected: 'TRADE LONG (momentum continuation)',
    isWise: true,
    snap: createSnapshot({
      rsi14: 95,
      rsi7: 92,
      adx14: 48,
      trend: 0.95,
      trendBias: 'bullish',
      volumeRatio: 3.0,
      volumeZScore: 3.5,
      cmf20: 0.4,
      last: 120000,
      ema20: 110000,
      ema50: 105000,
      ema200: 100000,
    }),
    ranking: createRanking(20),
  },
  {
    name: '⚠️ RSI 25 normal day (classic oversold)',
    description: 'Oversold on normal day with weak trend - potential rebound, be cautious',
    expected: 'CAUTION or NO TRADE',
    isWise: true,
    snap: createSnapshot({
      rsi14: 25,
      rsi7: 28,
      adx14: 18,
      trend: -0.2,
      trendBias: 'neutral',
      volumeRatio: 0.8,
      cmf20: -0.1,
    }),
    ranking: createRanking(-2),
  },
  {
    name: '⚠️ RSI 75 normal day (classic overbought)',
    description: 'Overbought on normal day with weak trend - potential reversal, be cautious',
    expected: 'CAUTION or NO TRADE',
    isWise: true,
    snap: createSnapshot({
      rsi14: 75,
      rsi7: 72,
      adx14: 15,
      trend: 0.15,
      trendBias: 'neutral',
      volumeRatio: 0.7,
      cmf20: 0.08,
    }),
    ranking: createRanking(2),
  },

  // ========== ADX SCENARIOS ==========
  {
    name: '💪 High ADX (40) + bullish trend',
    description: 'Strong trending market with clear direction - favor trend following',
    expected: 'TRADE LONG (trend following)',
    isWise: true,
    snap: createSnapshot({
      rsi14: 60,
      adx14: 40,
      trend: 0.7,
      trendBias: 'bullish',
      volumeRatio: 1.5,
      cmf20: 0.15,
      last: 105000,
      ema20: 103000,
      ema50: 100000,
    }),
    ranking: createRanking(5),
  },
  {
    name: '📉 High ADX (38) + bearish trend',
    description: 'Strong trending market bearish - favor SHORT positions',
    expected: 'TRADE SHORT (trend following)',
    isWise: true,
    snap: createSnapshot({
      rsi14: 40,
      adx14: 38,
      trend: -0.65,
      trendBias: 'bearish',
      volumeRatio: 1.4,
      cmf20: -0.12,
      last: 95000,
      ema20: 97000,
      ema50: 100000,
    }),
    ranking: createRanking(-4),
  },
  {
    name: '🔄 Low ADX (12) - ranging market',
    description: 'No clear trend, choppy conditions - favor mean reversion or avoid',
    expected: 'MEAN_REVERSION or NO TRADE',
    isWise: true,
    snap: createSnapshot({
      rsi14: 45,
      adx14: 12,
      trend: 0.05,
      trendBias: 'neutral',
      volumeRatio: 0.6,
      cmf20: 0.02,
    }),
    ranking: createRanking(0.5),
  },

  // ========== VOLUME SCENARIOS ==========
  {
    name: '🔊 Volume surge (3x) + breakout',
    description: 'Massive volume spike with price breaking out - strong signal',
    expected: 'TRADE BREAKOUT',
    isWise: true,
    snap: createSnapshot({
      rsi14: 65,
      adx14: 28,
      trend: 0.5,
      trendBias: 'bullish',
      volumeRatio: 3.0,
      volumeZScore: 2.8,
      cmf20: 0.25,
      last: 102500,
      ema20: 100000,
      bbUpper: 101500,
    }),
    ranking: createRanking(3),
  },
  {
    name: '🔇 Volume dead (0.3x) - no conviction',
    description: 'Very low volume, no market participation - avoid trading',
    expected: 'NO TRADE (low conviction)',
    isWise: true,
    snap: createSnapshot({
      rsi14: 55,
      adx14: 20,
      trend: 0.2,
      trendBias: 'neutral',
      volumeRatio: 0.3,
      volumeZScore: -1.5,
      cmf20: 0.01,
    }),
    ranking: createRanking(0.5),
  },

  // ========== BTC CORRELATION SCENARIOS ==========
  {
    name: '📈 BTC pumping + alt bullish setup',
    description: 'BTC momentum up, altcoin showing strength - strong long setup',
    expected: 'TRADE LONG (BTC tailwind)',
    isWise: true,
    snap: createSnapshot({
      symbol: 'ETHUSDT',
      rsi14: 62,
      adx14: 30,
      trend: 0.55,
      trendBias: 'bullish',
      volumeRatio: 1.8,
      cmf20: 0.18,
    }),
    ranking: createRanking(6),
    btcContext: { change24h: 4.5, momentum: 'bullish' },
  },
  {
    name: '📉 BTC dumping + alt short setup',
    description: 'BTC momentum down, altcoin breaking support - strong short setup',
    expected: 'TRADE SHORT (BTC headwind to longs)',
    isWise: true,
    snap: createSnapshot({
      symbol: 'ETHUSDT',
      rsi14: 38,
      adx14: 32,
      trend: -0.5,
      trendBias: 'bearish',
      volumeRatio: 1.6,
      cmf20: -0.15,
    }),
    ranking: createRanking(-5),
    btcContext: { change24h: -3.5, momentum: 'bearish' },
  },

  // ========== VOLATILITY SQUEEZE SCENARIOS ==========
  {
    name: '💥 Volatility squeeze (low ATR) + volume building',
    description: 'Compression before explosion - breakout imminent',
    expected: 'TRADE BREAKOUT (squeeze breakout setup)',
    isWise: true,
    snap: createSnapshot({
      rsi14: 52,
      adx14: 22,
      atrPct: 0.8,
      atr14: 800,
      trend: 0.1,
      trendBias: 'neutral',
      volumeRatio: 1.3,
      volumeZScore: 1.0,
      cmf20: 0.05,
      bbUpper: 100800,
      bbLower: 99200,
      bbMiddle: 100000,
    }),
    ranking: createRanking(0.3),
  },

  // ========== EXTREME VOLATILITY SCENARIOS ==========
  {
    name: '🌪️ Extreme volatility (10% ATR) + strong trend',
    description: 'Very volatile but trending - trade with wider stops',
    expected: 'TRADE (with adjusted risk)',
    isWise: true,
    snap: createSnapshot({
      rsi14: 58,
      adx14: 35,
      atrPct: 10.0,
      atr14: 10000,
      trend: 0.6,
      trendBias: 'bullish',
      volumeRatio: 2.0,
      cmf20: 0.2,
    }),
    ranking: createRanking(8),
  },
  {
    name: '🌪️ Extreme volatility + no direction (chaos)',
    description: 'Very volatile AND choppy - stay out',
    expected: 'NO TRADE (chaos conditions)',
    isWise: true,
    snap: createSnapshot({
      rsi14: 50,
      adx14: 10,
      atrPct: 12.0,
      atr14: 12000,
      trend: 0.02,
      trendBias: 'neutral',
      volumeRatio: 0.5,
      cmf20: 0.0,
    }),
    ranking: createRanking(-1),
  },

  // ========== SUPPORT/RESISTANCE SCENARIOS ==========
  {
    name: '🛡️ Price at strong support + bullish divergence',
    description: 'Testing support with RSI making higher lows - potential bounce',
    expected: 'TRADE LONG (support bounce)',
    isWise: true,
    snap: createSnapshot({
      rsi14: 32,
      rsiSlope: 2.0,
      adx14: 20,
      trend: -0.2,
      trendBias: 'neutral',
      volumeRatio: 1.2,
      cmf20: 0.08,
      srBias: 'nearSupport',
      last: 98000,
      ema50: 100000,
      ema200: 97500,
    }),
    ranking: createRanking(-1.5),
  },
  {
    name: '🚧 Price at strong resistance + bearish divergence',
    description: 'Testing resistance with RSI making lower highs - potential rejection',
    expected: 'TRADE SHORT (resistance rejection)',
    isWise: true,
    snap: createSnapshot({
      rsi14: 68,
      rsiSlope: -2.5,
      adx14: 18,
      trend: 0.2,
      trendBias: 'neutral',
      volumeRatio: 1.1,
      cmf20: -0.05,
      srBias: 'nearResistance',
      last: 105000,
      ema20: 103000,
      ema50: 100000,
    }),
    ranking: createRanking(1),
  },

  // ========== CMF (Money Flow) SCENARIOS ==========
  {
    name: '💰 Strong positive CMF (0.3) + uptrend',
    description: 'Institutions accumulating, money flowing in',
    expected: 'TRADE LONG (accumulation)',
    isWise: true,
    snap: createSnapshot({
      rsi14: 58,
      adx14: 26,
      trend: 0.45,
      trendBias: 'bullish',
      volumeRatio: 1.4,
      cmf20: 0.30,
    }),
    ranking: createRanking(3),
  },
  {
    name: '💸 Strong negative CMF (-0.25) + downtrend',
    description: 'Institutions distributing, money flowing out',
    expected: 'TRADE SHORT (distribution)',
    isWise: true,
    snap: createSnapshot({
      rsi14: 42,
      adx14: 28,
      trend: -0.4,
      trendBias: 'bearish',
      volumeRatio: 1.3,
      cmf20: -0.25,
    }),
    ranking: createRanking(-2.5),
  },
  {
    name: '⚠️ Bearish divergence: Price up but CMF negative',
    description: 'Hidden weakness - smart money exiting while price rises',
    expected: 'AVOID LONG or SHORT',
    isWise: true,
    snap: createSnapshot({
      rsi14: 65,
      adx14: 22,
      trend: 0.35,
      trendBias: 'bullish',
      volumeRatio: 0.9,
      cmf20: -0.15,
      last: 102000,
      ema20: 100000,
    }),
    ranking: createRanking(2),
  },

  // ========== EDGE CASES ==========
  {
    name: '🔥 Perfect storm LONG: All indicators aligned bullish',
    description: 'RSI momentum, high ADX, volume surge, positive CMF, bullish trend',
    expected: 'STRONG TRADE LONG',
    isWise: true,
    snap: createSnapshot({
      rsi14: 65,
      adx14: 42,
      trend: 0.85,
      trendBias: 'bullish',
      volumeRatio: 2.5,
      volumeZScore: 2.2,
      cmf20: 0.28,
      last: 108000,
      ema20: 105000,
      ema50: 102000,
      ema200: 95000,
    }),
    ranking: createRanking(7),
  },
  {
    name: '🔥 Perfect storm SHORT: All indicators aligned bearish',
    description: 'RSI weakness, high ADX, volume surge, negative CMF, bearish trend',
    expected: 'STRONG TRADE SHORT',
    isWise: true,
    snap: createSnapshot({
      rsi14: 35,
      adx14: 40,
      trend: -0.8,
      trendBias: 'bearish',
      volumeRatio: 2.3,
      volumeZScore: 2.0,
      cmf20: -0.24,
      last: 92000,
      ema20: 95000,
      ema50: 98000,
      ema200: 105000,
    }),
    ranking: createRanking(-6),
  },
  {
    name: '🤔 Mixed signals: Bullish trend but overbought RSI',
    description: 'Strong trend but extended - might pause/correct',
    expected: 'CAUTIOUS LONG or WAIT',
    isWise: true,
    snap: createSnapshot({
      rsi14: 78,
      adx14: 35,
      trend: 0.6,
      trendBias: 'bullish',
      volumeRatio: 1.0,
      cmf20: 0.12,
    }),
    ranking: createRanking(4),
  },
  {
    name: '🤔 Mixed signals: Bearish trend but oversold RSI',
    description: 'Strong downtrend but extended - might bounce',
    expected: 'CAUTIOUS SHORT or WAIT',
    isWise: true,
    snap: createSnapshot({
      rsi14: 22,
      adx14: 33,
      trend: -0.55,
      trendBias: 'bearish',
      volumeRatio: 0.9,
      cmf20: -0.08,
    }),
    ranking: createRanking(-3.5),
  },
];

// ============================================
// 🧪 RUN TESTS
// ============================================

async function runTests() {
  console.log('\n' + '='.repeat(100));
  console.log('🧪 COMPREHENSIVE STRATEGY SCENARIO TESTER');
  console.log('='.repeat(100) + '\n');
  
  const results = [];
  
  for (const scenario of scenarios) {
    console.log('\n' + '-'.repeat(80));
    console.log(`📋 SCENARIO: ${scenario.name}`);
    console.log(`📝 ${scenario.description}`);
    console.log(`🎯 Expected: ${scenario.expected}`);
    console.log('-'.repeat(80));
    
    // Test Big Move detection
    const bigMove = detectBigMoveMode(scenario.snap, scenario.ranking?.change24hPct);
    console.log(`\n🚀 BIG MOVE DETECTION:`);
    console.log(`   isBigMove: ${bigMove.isBigMove}`);
    console.log(`   direction: ${bigMove.direction || 'N/A'}`);
    console.log(`   strength: ${bigMove.strength}`);
    console.log(`   reasons: ${bigMove.reasons.join(', ') || 'none'}`);
    
    // Test Rebound/Reversal detection
    const reboundSignal = detectReboundForShort(scenario.snap, scenario.ranking?.change24hPct);
    const reversalSignal = detectReversalForLong(scenario.snap, scenario.ranking?.change24hPct);
    
    console.log(`\n📊 REBOUND FOR SHORT DETECTION:`);
    console.log(`   probability: ${(reboundSignal.probability * 100).toFixed(1)}%`);
    console.log(`   severity: ${reboundSignal.severity}`);
    console.log(`   shouldBlock: ${reboundSignal.shouldBlock}`);
    console.log(`   tradeBias: ${reboundSignal.tradeBias}`);
    console.log(`   isBigMoveMode: ${reboundSignal.isBigMoveMode}`);
    console.log(`   bigMoveDirection: ${reboundSignal.bigMoveDirection || 'N/A'}`);
    console.log(`   reasons: ${reboundSignal.reasons.slice(0, 3).join(', ')}`);
    
    console.log(`\n📊 REVERSAL FOR LONG DETECTION:`);
    console.log(`   probability: ${(reversalSignal.probability * 100).toFixed(1)}%`);
    console.log(`   severity: ${reversalSignal.severity}`);
    console.log(`   shouldBlock: ${reversalSignal.shouldBlock}`);
    console.log(`   tradeBias: ${reversalSignal.tradeBias}`);
    console.log(`   isBigMoveMode: ${reversalSignal.isBigMoveMode}`);
    console.log(`   bigMoveDirection: ${reversalSignal.bigMoveDirection || 'N/A'}`);
    console.log(`   reasons: ${reversalSignal.reasons.slice(0, 3).join(', ')}`);
    
    // Key indicators summary
    console.log(`\n📈 KEY INDICATORS:`);
    console.log(`   RSI14: ${scenario.snap.rsi14}`);
    console.log(`   ADX14: ${scenario.snap.adx14}`);
    console.log(`   Trend: ${scenario.snap.trend.toFixed(2)} (${scenario.snap.trendBias})`);
    console.log(`   Volume Ratio: ${scenario.snap.volumeRatio.toFixed(1)}x`);
    console.log(`   CMF: ${scenario.snap.cmf20.toFixed(2)}`);
    console.log(`   ATR%: ${scenario.snap.atrPct.toFixed(1)}%`);
    console.log(`   24h Change: ${scenario.ranking?.change24hPct || 0}%`);
    
    // Analyze the decision
    let decision = 'UNCLEAR';
    let wisdom = '⚪ NEUTRAL';
    
    // Decision logic based on signals
    if (bigMove.isBigMove) {
      if (bigMove.direction === 'pump') {
        decision = '🟢 FAVOR LONG (Big Move Mode)';
        wisdom = scenario.expected.includes('LONG') ? '✅ WISE' : '⚠️ CHECK';
      } else if (bigMove.direction === 'dump') {
        decision = '🔴 FAVOR SHORT (Big Move Mode)';
        wisdom = scenario.expected.includes('SHORT') ? '✅ WISE' : '⚠️ CHECK';
      }
    } else {
      // Normal mode decisions - improved with divergence and CMF detection
      const rsiSlope = scenario.snap.rsiSlope || 0;
      const cmf = scenario.snap.cmf20 || 0;
      const volumeRatio = scenario.snap.volumeRatio || 1;
      const atrPct = scenario.snap.atrPct || 2.5;
      const hasBullishDivergence = scenario.snap.rsi14 < 40 && rsiSlope > 1.5;
      const hasBearishDivergence = scenario.snap.rsi14 > 60 && rsiSlope < -1.5;
      const isSqueezing = atrPct < 1.2 && volumeRatio >= 1.0;
      const volumeSurge = volumeRatio >= 2.5;
      const strongPositiveCmf = cmf >= 0.15;
      const strongNegativeCmf = cmf <= -0.15;
      
      if (reboundSignal.shouldBlock && scenario.snap.trendBias !== 'bearish') {
        decision = '⛔ BLOCK SHORT (extreme rebound risk)';
      } else if (reversalSignal.shouldBlock && scenario.snap.trendBias !== 'bullish') {
        decision = '⛔ BLOCK LONG (extreme reversal risk)';
      } else if (hasBullishDivergence && (scenario.snap.srBias === 'nearSupport' || scenario.snap.rsi14 < 35)) {
        decision = '🟢 LONG (bullish divergence at support)';
      } else if (hasBearishDivergence && (scenario.snap.srBias === 'nearResistance' || scenario.snap.rsi14 > 65)) {
        decision = '🔴 SHORT (bearish divergence at resistance)';
      } else if (isSqueezing && volumeRatio >= 1.3) {
        decision = '💥 BREAKOUT (squeeze + volume building)';
      } else if (volumeSurge && scenario.snap.adx14 >= 25) {
        decision = scenario.snap.trend > 0 ? '🟢 BREAKOUT LONG' : '🔴 BREAKOUT SHORT';
      } else if (strongPositiveCmf && scenario.snap.trend > 0.3) {
        decision = '🟢 LONG (CMF accumulation)';
      } else if (strongNegativeCmf && scenario.snap.trend < -0.3) {
        decision = '🔴 SHORT (CMF distribution)';
      } else if (scenario.snap.adx14 >= 30 && Math.abs(scenario.snap.trend) >= 0.5) {
        decision = scenario.snap.trend > 0 ? '🟢 TREND LONG' : '🔴 TREND SHORT';
      } else if (scenario.snap.adx14 < 18 && Math.abs(scenario.snap.trend) < 0.2) {
        decision = '🔄 RANGE / NO TRADE';
      } else if (scenario.snap.volumeRatio < 0.5) {
        decision = '🔇 NO TRADE (low volume)';
      } else {
        decision = '🤔 MIXED SIGNALS';
      }
      
      // Check wisdom
      if (scenario.expected.includes('NO TRADE') && decision.includes('NO TRADE')) {
        wisdom = '✅ WISE';
      } else if (scenario.expected.includes('NO TRADE') && decision.includes('RANGE')) {
        wisdom = '✅ WISE';
      } else if (scenario.expected.includes('LONG') && decision.includes('LONG')) {
        wisdom = '✅ WISE';
      } else if (scenario.expected.includes('SHORT') && decision.includes('SHORT')) {
        wisdom = '✅ WISE';
      } else if (scenario.expected.includes('BREAKOUT') && decision.includes('BREAKOUT')) {
        wisdom = '✅ WISE';
      } else if (scenario.expected.includes('CAUTION') && (decision.includes('MIXED') || decision.includes('RANGE'))) {
        wisdom = '✅ WISE';
      } else if (scenario.expected.includes('AVOID') && (decision.includes('MIXED') || decision.includes('NO TRADE'))) {
        wisdom = '✅ WISE';
      } else if (scenario.expected.includes('TRADE') && !decision.includes('NO TRADE') && !decision.includes('MIXED') && !decision.includes('RANGE')) {
        wisdom = '✅ WISE';
      } else {
        wisdom = '⚠️ REVIEW';
      }
    }
    
    console.log(`\n🎲 AGENT DECISION: ${decision}`);
    console.log(`📊 WISDOM CHECK: ${wisdom}`);
    
    results.push({
      name: scenario.name,
      expected: scenario.expected,
      decision,
      wisdom,
      bigMove: bigMove.isBigMove,
      reboundProb: reboundSignal.probability,
      reversalProb: reversalSignal.probability,
    });
  }
  
  // Summary
  console.log('\n\n' + '='.repeat(100));
  console.log('📊 SUMMARY');
  console.log('='.repeat(100));
  
  const wise = results.filter(r => r.wisdom.includes('WISE')).length;
  const review = results.filter(r => r.wisdom.includes('REVIEW')).length;
  const check = results.filter(r => r.wisdom.includes('CHECK')).length;
  
  console.log(`\n✅ WISE decisions: ${wise}/${results.length}`);
  console.log(`⚠️ NEEDS REVIEW: ${review}/${results.length}`);
  console.log(`🔍 NEEDS CHECK: ${check}/${results.length}`);
  
  console.log('\n📋 DETAILED RESULTS:');
  console.log('-'.repeat(100));
  
  for (const r of results) {
    const icon = r.wisdom.includes('WISE') ? '✅' : r.wisdom.includes('REVIEW') ? '⚠️' : '🔍';
    console.log(`${icon} ${r.name.slice(0, 50).padEnd(52)} | ${r.decision.slice(0, 30).padEnd(32)} | BigMove: ${r.bigMove ? 'YES' : 'NO'}`);
  }
  
  console.log('\n' + '='.repeat(100));
  console.log('🏁 TEST COMPLETE');
  console.log('='.repeat(100) + '\n');
}

// Run
runTests().catch(console.error);
