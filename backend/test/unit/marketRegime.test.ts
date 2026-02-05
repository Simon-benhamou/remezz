import {
  calcADX,
  detectMarketRegime,
  shouldSkipEntryForRegime,
  MomentumConfig,
  type Candle,
  type MarketRegime,
} from '../../src/strategies/momentumSimple.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Generate synthetic candles with a given trend and volatility */
function makeCandles(
  count: number,
  opts: {
    startPrice?: number;
    trendPctPerBar?: number;   // e.g. 0.001 = +0.1% per bar
    volatilityPct?: number;    // intrabar high/low range as pct of close
    startTs?: number;
    intervalMs?: number;
    volume?: number;
  } = {},
): Candle[] {
  const {
    startPrice = 50000,
    trendPctPerBar = 0,
    volatilityPct = 0.005,
    startTs = Date.now() - count * 900_000,
    intervalMs = 900_000,  // 15m
    volume = 100,
  } = opts;

  const candles: Candle[] = [];
  let price = startPrice;

  for (let i = 0; i < count; i++) {
    const close = price * (1 + trendPctPerBar);
    const high = Math.max(price, close) * (1 + volatilityPct);
    const low = Math.min(price, close) * (1 - volatilityPct);
    candles.push({
      timestamp: startTs + i * intervalMs,
      open: price,
      high,
      low,
      close,
      volume,
      isFinal: true,
    });
    price = close;
  }

  return candles;
}

/** Make 1h candles (4x interval of 15m) */
function make1hCandles(
  count: number,
  opts: Parameters<typeof makeCandles>[1] = {},
): Candle[] {
  return makeCandles(count, { ...opts, intervalMs: 3_600_000 });
}

/** Flat / ranging candles (alternating up/down, low vol) */
function makeFlatCandles(count: number, basePrice = 50000): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    // Alternate +0.05% / -0.05% so price goes nowhere
    const dir = i % 2 === 0 ? 1 : -1;
    const open = basePrice;
    const close = basePrice * (1 + dir * 0.0005);
    candles.push({
      timestamp: Date.now() - (count - i) * 900_000,
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume: 50,
      isFinal: true,
    });
  }
  return candles;
}

// ── calcADX Tests ──────────────────────────────────────────────────────────

describe('calcADX', () => {
  it('should return 0 for insufficient candles', () => {
    const candles = makeCandles(5);
    expect(calcADX(candles)).toBe(0);
  });

  it('should return > 25 for strongly trending candles', () => {
    // Strong uptrend: +0.5% per bar for 60 bars
    const candles = makeCandles(60, { trendPctPerBar: 0.005, volatilityPct: 0.002 });
    const adx = calcADX(candles);
    expect(adx).toBeGreaterThan(25);
  });

  it('should return < 20 for flat / ranging candles', () => {
    const candles = makeFlatCandles(60);
    const adx = calcADX(candles);
    expect(adx).toBeLessThan(20);
  });

  it('should accept custom period parameter', () => {
    const candles = makeCandles(50, { trendPctPerBar: 0.003 });
    const adx7 = calcADX(candles, 7);
    const adx14 = calcADX(candles, 14);
    // Both should return valid numbers (not NaN)
    expect(Number.isFinite(adx7)).toBe(true);
    expect(Number.isFinite(adx14)).toBe(true);
  });

  it('should return between 0 and 100', () => {
    const candles = makeCandles(60, { trendPctPerBar: 0.003 });
    const adx = calcADX(candles);
    expect(adx).toBeGreaterThanOrEqual(0);
    expect(adx).toBeLessThanOrEqual(100);
  });
});

// ── detectMarketRegime Tests ───────────────────────────────────────────────

describe('detectMarketRegime', () => {
  it('should return TRENDING_BULL when price is above SMA200 with strong ADX', () => {
    // Uptrend: price well above SMA200, ADX > 20
    const btc15m = makeCandles(250, { trendPctPerBar: 0.001, volatilityPct: 0.003 });
    const btc1h = make1hCandles(250, { trendPctPerBar: 0.001, volatilityPct: 0.003 });
    const regime = detectMarketRegime(btc15m, btc1h);
    expect(regime).toBe('TRENDING_BULL');
  });

  it('should return TRENDING_BEAR when price is below SMA200 with strong ADX', () => {
    // Downtrend: price well below SMA200
    const btc15m = makeCandles(250, { startPrice: 60000, trendPctPerBar: -0.001, volatilityPct: 0.003 });
    const btc1h = make1hCandles(250, { startPrice: 60000, trendPctPerBar: -0.001, volatilityPct: 0.003 });
    const regime = detectMarketRegime(btc15m, btc1h);
    expect(regime).toBe('TRENDING_BEAR');
  });

  it('should return LOW_VOL when ADX < 20 and ATR is declining', () => {
    // Build candles: first half volatile, second half very low vol (ATR declining)
    const volCandles = makeCandles(30, { volatilityPct: 0.015, trendPctPerBar: 0 });
    const flatEnd = makeCandles(30, {
      startPrice: volCandles[volCandles.length - 1].close,
      volatilityPct: 0.001,
      trendPctPerBar: 0,
      startTs: volCandles[volCandles.length - 1].timestamp + 900_000,
    });
    const btc15m = [...volCandles, ...flatEnd];
    const btc1h = makeFlatCandles(40);
    const regime = detectMarketRegime(btc15m, btc1h);
    expect(regime).toBe('LOW_VOL');
  });

  it('should return CHOPPY when ADX < 20 and SMA200 slope is flat', () => {
    // Flat SMA200 + low ADX
    const btc15m = makeFlatCandles(250);
    const btc1h = makeFlatCandles(250);
    const regime = detectMarketRegime(btc15m, btc1h);
    expect(['CHOPPY', 'LOW_VOL']).toContain(regime); // Could be either depending on ATR
  });

  it('should fall back to 15m data when 1h candles insufficient', () => {
    const btc15m = makeCandles(250, { trendPctPerBar: 0.001 });
    const btc1h: Candle[] = []; // No 1h data
    const regime = detectMarketRegime(btc15m, btc1h);
    // Should still classify (fallback to 15m)
    expect(['TRENDING_BULL', 'TRENDING_BEAR', 'CHOPPY', 'LOW_VOL']).toContain(regime);
  });

  it('should default to TRENDING_BULL with insufficient data', () => {
    const btc15m = makeCandles(10);
    const btc1h: Candle[] = [];
    const regime = detectMarketRegime(btc15m, btc1h);
    expect(regime).toBe('TRENDING_BULL');
  });
});

// ── shouldSkipEntryForRegime Tests ─────────────────────────────────────────

describe('shouldSkipEntryForRegime', () => {
  it('should skip entry for CHOPPY regime', () => {
    expect(shouldSkipEntryForRegime('CHOPPY', 'long')).toBe(true);
    expect(shouldSkipEntryForRegime('CHOPPY', 'short')).toBe(true);
  });

  it('should skip entry for LOW_VOL regime', () => {
    expect(shouldSkipEntryForRegime('LOW_VOL', 'long')).toBe(true);
    expect(shouldSkipEntryForRegime('LOW_VOL', 'short')).toBe(true);
  });

  it('should allow entry for TRENDING_BULL regime', () => {
    expect(shouldSkipEntryForRegime('TRENDING_BULL', 'long')).toBe(false);
    expect(shouldSkipEntryForRegime('TRENDING_BULL', 'short')).toBe(false);
  });

  it('should allow entry for TRENDING_BEAR regime', () => {
    expect(shouldSkipEntryForRegime('TRENDING_BEAR', 'long')).toBe(false);
    expect(shouldSkipEntryForRegime('TRENDING_BEAR', 'short')).toBe(false);
  });

  it('should always allow entry when CASH_MODE is disabled', () => {
    const origEnabled = MomentumConfig.CASH_MODE.ENABLED;
    try {
      MomentumConfig.CASH_MODE.ENABLED = false;
      expect(shouldSkipEntryForRegime('CHOPPY', 'long')).toBe(false);
      expect(shouldSkipEntryForRegime('LOW_VOL', 'short')).toBe(false);
    } finally {
      MomentumConfig.CASH_MODE.ENABLED = origEnabled;
    }
  });
});
