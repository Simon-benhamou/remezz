/**
 * SymbolEngine Unit Tests
 *
 * Tests the core tick pipeline: data guards, candle filtering, regime timeframe
 * branching (V5.105), new-candle detection, event emission, signal delegation,
 * re-entrancy guard, and state management.
 *
 * Strategy functions (checkMomentumSignal, etc.) are mocked — their correctness
 * is tested separately. These tests verify SymbolEngine's own orchestration logic.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ─── Constants ──────────────────────────────────────────────────────────────────

const CANDLE_15M_MS = 900_000;
const CANDLE_1H_MS = 3_600_000;

// ─── Mutable mock state ─────────────────────────────────────────────────────────

let mockSymbolCandles: any[] | null = null;
let mockBtc15mCandles: any[] | null = null;
let mockBtc1hCandles: any[] | null = null;

/** What checkMomentumSignal returns (configurable per test) */
let mockSignalResult: any = {
  valid: false,
  reason: 'no_bb_breakout',
  features: { roc5: 0.1, roc: 0.05, volRatio: 1.2, btcInBullRegime: true, bbUpper: 51000, bbLower: 49000 },
};

/** Captures calls to checkMomentumSignal for argument verification */
let checkMomentumSignalCalls: any[] = [];

/** Stored MomentumConfig reference */
let savedBtcRegimeTF: string;

// ─── jest.mock (hoisted by ts-jest before imports) ──────────────────────────────

jest.mock('../../src/services/binanceWebSocket.js', () => ({
  getKlinesWithMeta: (..._args: any[]) => mockSymbolCandles,
  toBinanceSymbolId: (u: string) =>
    (u.split(':')[0] || u).replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
  getBinanceWebSocket: () => ({ subscribeToKline: () => {}, getKlines: () => null }),
}));

jest.mock('../../src/strategies/cacheManager.js', () => ({
  globalCacheManager: {
    getBtc15mCache: () =>
      mockBtc15mCandles ? { candles: mockBtc15mCandles, updatedAt: Date.now() } : null,
    getBtc1hCache: () =>
      mockBtc1hCandles ? { candles: mockBtc1hCandles, updatedAt: Date.now() } : null,
  },
}));

jest.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

jest.mock('../../src/strategies/momentumSimple.js', () => {
  // Provide a real MomentumConfig-like object (mutable, shared across tests)
  const config = {
    ENTRY: { BTC_REGIME_TIMEFRAME: '15m' },
    EXIT: {},
    SR_FILTER: { ENABLED: false },
    CASH_MODE: { ENABLED: false },
  };
  return {
    checkMomentumSignal: (...args: any[]) => {
      checkMomentumSignalCalls.push(args);
      return mockSignalResult;
    },
    getMarketConditions: () => ({ btcTrend: 'BULLISH', volatilityRegime: 'MEDIUM' }),
    detectMarketRegime: () => 'TRENDING_UP',
    calcROC: () => 0.5,
    calcATR: () => 150,
    calcBBPosition: () => 0.8,
    calcVolRatio: () => 1.3,
    calcTrendStrength: () => 0.6,
    MomentumConfig: config,
  };
});

jest.mock('../../src/strategies/signalRanker.js', () => ({
  calculateSignalScore: () => 72.5,
}));

// ─── Static imports (use mocked modules) ────────────────────────────────────────

import { SymbolEngine } from '../../src/strategies/symbolEngine.js';
import { MomentumConfig } from '../../src/strategies/momentumSimple.js';

// ─── Candle helpers ─────────────────────────────────────────────────────────────

function makeCandles(count: number, intervalMs: number, startPrice = 50000): any[] {
  const startTs = Date.now() - count * intervalMs;
  const candles: any[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const move = Math.sin(i * 0.1) * 0.002 + 0.0002;
    const close = price * (1 + move);
    const range = price * 0.004;
    candles.push({
      timestamp: startTs + i * intervalMs,
      open: price,
      high: Math.max(price, close) + range,
      low: Math.min(price, close) - range,
      close,
      volume: 800 + Math.sin(i * 0.3) * 400,
      isFinal: true,
    });
    price = close;
  }
  return candles;
}

const make15m = (n: number, p = 50000) => makeCandles(n, CANDLE_15M_MS, p);
const make1h = (n: number, p = 50000) => makeCandles(n, CANDLE_1H_MS, p);

function appendInProgress(candles: any[], intervalMs = CANDLE_15M_MS): any[] {
  const last = candles[candles.length - 1];
  return [
    ...candles,
    {
      timestamp: last.timestamp + intervalMs,
      open: last.close,
      high: last.close * 1.001,
      low: last.close * 0.999,
      close: last.close * 1.0005,
      volume: 500,
      isFinal: false,
    },
  ];
}

/** Standard data: 250 symbol 15m + 250 BTC 15m (above all minimum thresholds) */
function setupStandardData() {
  mockSymbolCandles = make15m(250);
  mockBtc15mCandles = make15m(250);
}

// ─── Tick helper (calls private method directly) ────────────────────────────────

async function tick(engine: SymbolEngine): Promise<void> {
  await (engine as any).tick();
}

// ─── Test suite ─────────────────────────────────────────────────────────────────

describe('SymbolEngine', () => {
  beforeEach(() => {
    mockSymbolCandles = null;
    mockBtc15mCandles = null;
    mockBtc1hCandles = null;
    mockSignalResult = {
      valid: false,
      reason: 'no_bb_breakout',
      features: {
        roc5: 0.1, roc: 0.05, volRatio: 1.2,
        btcInBullRegime: true, bbUpper: 51000, bbLower: 49000,
      },
    };
    checkMomentumSignalCalls = [];
    savedBtcRegimeTF = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  });

  afterEach(() => {
    MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME = savedBtcRegimeTF;
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('lifecycle', () => {
    it('reports running state correctly', () => {
      const e = new SymbolEngine('DOGE/USDT:USDT');
      expect(e.isRunning()).toBe(false);
      e.start();
      expect(e.isRunning()).toBe(true);
      e.stop();
      expect(e.isRunning()).toBe(false);
    });

    it('start is idempotent (no double intervals)', () => {
      const e = new SymbolEngine('DOGE/USDT:USDT');
      e.start();
      e.start();
      expect(e.isRunning()).toBe(true);
      e.stop();
    });

    it('stop removes all listeners', () => {
      const e = new SymbolEngine('DOGE/USDT:USDT');
      e.start();
      const fn = jest.fn();
      e.on('signal', fn);
      e.stop();
      e.emit('signal', {});
      expect(fn).not.toHaveBeenCalled();
    });

    it('getSymbol returns constructor argument', () => {
      expect(new SymbolEngine('WIF/USDT:USDT').getSymbol()).toBe('WIF/USDT:USDT');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // Data guards (early returns)
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('data guards', () => {
    it('no signal when symbol candles < 61', async () => {
      mockSymbolCandles = make15m(30);
      mockBtc15mCandles = make15m(250);
      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);
      expect(out).toHaveLength(0);
      expect(e.getCandles()).toHaveLength(0); // candles not set below threshold
    });

    it('no signal when BTC 15m cache is null', async () => {
      mockSymbolCandles = make15m(250);
      mockBtc15mCandles = null;
      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);
      expect(out).toHaveLength(0);
    });

    it('no signal when BTC 15m candles < 201', async () => {
      mockSymbolCandles = make15m(250);
      mockBtc15mCandles = make15m(100);
      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);
      expect(out).toHaveLength(0);
    });

    it('symbol candles stored when >= 61 (even if BTC insufficient)', async () => {
      mockSymbolCandles = make15m(100);
      mockBtc15mCandles = make15m(50); // too few
      const e = new SymbolEngine('X/USDT:USDT');
      await tick(e);
      expect(e.getCandles()).toHaveLength(100);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // isFinal candle filtering
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('candle filtering', () => {
    it('excludes in-progress symbol candle from closedCandles', async () => {
      const final = make15m(250);
      mockSymbolCandles = appendInProgress(final);
      mockBtc15mCandles = make15m(250);
      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);

      expect(out).toHaveLength(1);
      expect(out[0].closedCandles).toHaveLength(250);
      expect(out[0].closedCandles.every((c: any) => c.isFinal !== false)).toBe(true);
    });

    it('excludes in-progress BTC 15m candle', async () => {
      mockSymbolCandles = make15m(250);
      mockBtc15mCandles = appendInProgress(make15m(250));
      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);

      expect(out).toHaveLength(1);
      expect(out[0].btcCandles).toHaveLength(250);
      expect(out[0].btcCandles.every((c: any) => c.isFinal !== false)).toBe(true);
    });

    it('currentPrice from latest candle including in-progress', async () => {
      const base = make15m(250);
      mockSymbolCandles = appendInProgress(base);
      mockBtc15mCandles = make15m(250);
      const ipCandle = mockSymbolCandles[mockSymbolCandles.length - 1];

      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);

      expect(out).toHaveLength(1);
      expect(out[0].currentPrice).toBeCloseTo(ipCandle.close, 2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // V5.105: Regime timeframe branching
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('V5.105 regime timeframe branching', () => {
    it('15m regime: btcCandles1h is same reference as btcCandles', async () => {
      MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME = '15m';
      setupStandardData();
      mockBtc1hCandles = make1h(250); // should be ignored

      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);

      expect(out).toHaveLength(1);
      // Same reference — engine reuses btcCandles for btcCandles1h
      expect(out[0].btcCandles1h).toBe(out[0].btcCandles);
    });

    it('15m regime: works without 1h cache', async () => {
      MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME = '15m';
      setupStandardData();
      mockBtc1hCandles = null;

      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);

      expect(out).toHaveLength(1);
    });

    it('1h regime: btcCandles1h uses real 1h data', async () => {
      MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME = '1h';
      setupStandardData();
      mockBtc1hCandles = make1h(250);

      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);

      expect(out).toHaveLength(1);
      expect(out[0].btcCandles1h).not.toBe(out[0].btcCandles);
      // Verify it's 1h interval data
      const c1h = out[0].btcCandles1h;
      if (c1h.length >= 2) {
        expect(c1h[1].timestamp - c1h[0].timestamp).toBe(CANDLE_1H_MS);
      }
    });

    it('1h regime: skips when 1h cache < 201', async () => {
      MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME = '1h';
      setupStandardData();
      mockBtc1hCandles = make1h(50);

      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);
      expect(out).toHaveLength(0);
    });

    it('1h regime: filters in-progress 1h candles', async () => {
      MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME = '1h';
      setupStandardData();
      mockBtc1hCandles = appendInProgress(make1h(250), CANDLE_1H_MS);

      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);

      expect(out).toHaveLength(1);
      expect(out[0].btcCandles1h).toHaveLength(250);
      expect(out[0].btcCandles1h.every((c: any) => c.isFinal !== false)).toBe(true);
    });

    it('15m regime: checkMomentumSignal receives btcCandles as btcCandles1h', async () => {
      MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME = '15m';
      setupStandardData();

      const e = new SymbolEngine('X/USDT:USDT');
      await tick(e);

      expect(checkMomentumSignalCalls).toHaveLength(1);
      const [_symbol, _closedCandles, btcCandles, opts] = checkMomentumSignalCalls[0];
      // btcCandles1h in opts should be same reference as btcCandles arg
      expect(opts.btcCandles1h).toBe(btcCandles);
    });

    it('1h regime: checkMomentumSignal receives real 1h candles as btcCandles1h', async () => {
      MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME = '1h';
      setupStandardData();
      mockBtc1hCandles = make1h(250);

      const e = new SymbolEngine('X/USDT:USDT');
      await tick(e);

      expect(checkMomentumSignalCalls).toHaveLength(1);
      const [_symbol, _closedCandles, btcCandles, opts] = checkMomentumSignalCalls[0];
      // btcCandles1h should NOT be same reference as btcCandles (15m)
      expect(opts.btcCandles1h).not.toBe(btcCandles);
      // Should have 1h interval
      if (opts.btcCandles1h.length >= 2) {
        expect(opts.btcCandles1h[1].timestamp - opts.btcCandles1h[0].timestamp).toBe(CANDLE_1H_MS);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // New candle detection
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('new candle detection', () => {
    it('emits signal on first tick', async () => {
      setupStandardData();
      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);
      expect(out).toHaveLength(1);
    });

    it('does not re-emit when candles unchanged', async () => {
      setupStandardData();
      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);
      await tick(e);
      expect(out).toHaveLength(1);
    });

    it('emits again when new candle arrives', async () => {
      const candles = make15m(250);
      mockSymbolCandles = candles;
      mockBtc15mCandles = make15m(250);
      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));

      await tick(e);
      expect(out).toHaveLength(1);

      // Add a new candle
      const last = candles[candles.length - 1];
      mockSymbolCandles = [
        ...candles,
        {
          timestamp: last.timestamp + CANDLE_15M_MS,
          open: last.close, high: last.close + 100, low: last.close - 100,
          close: last.close + 50, volume: 1000, isFinal: true,
        },
      ];
      await tick(e);
      expect(out).toHaveLength(2);
      expect(out[1].candleCloseTs).toBeGreaterThan(out[0].candleCloseTs);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // Signal result structure
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('signal result', () => {
    it('has all required fields', async () => {
      setupStandardData();
      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);

      expect(out).toHaveLength(1);
      const r = out[0];
      for (const key of [
        'signal', 'score', 'features', 'marketConditions', 'regime',
        'timestamp', 'candleCloseTs', 'closedCandles', 'btcCandles',
        'btcCandles1h', 'currentPrice',
      ]) {
        expect(r).toHaveProperty(key);
      }
    });

    it('signal field comes from checkMomentumSignal', async () => {
      mockSignalResult = { valid: true, side: 'LONG', reason: 'test_signal', features: { volRatio: 2.0 } };
      setupStandardData();
      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);

      expect(out[0].signal.valid).toBe(true);
      expect(out[0].signal.side).toBe('LONG');
      expect(out[0].signal.reason).toBe('test_signal');
    });

    it('score is non-zero for valid signal with features', async () => {
      mockSignalResult = {
        valid: true, side: 'LONG', reason: 'breakout',
        features: { roc5: 0.5, volRatio: 1.5, btcInBullRegime: true, bbUpper: 51000, bbLower: 49000 },
      };
      setupStandardData();
      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);

      // calculateSignalScore is mocked to return 72.5
      expect(out[0].score).toBe(72.5);
    });

    it('stored in getLastSignal()', async () => {
      setupStandardData();
      const e = new SymbolEngine('X/USDT:USDT');
      expect(e.getLastSignal()).toBeNull();
      await tick(e);
      expect(e.getLastSignal()).not.toBeNull();
      expect(e.getLastSignal()!.closedCandles.length).toBeGreaterThan(0);
    });

    it('currentPrice is a positive number', async () => {
      setupStandardData();
      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);

      expect(typeof out[0].currentPrice).toBe('number');
      expect(out[0].currentPrice).toBeGreaterThan(0);
    });

    it('closedCandles exclude in-progress candle', async () => {
      mockSymbolCandles = appendInProgress(make15m(250));
      mockBtc15mCandles = make15m(250);
      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));
      await tick(e);

      // 250 final + 1 in-progress → closedCandles = 250
      expect(out[0].closedCandles).toHaveLength(250);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // checkMomentumSignal invocation
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('signal computation args', () => {
    it('passes symbol, closed candles, BTC 15m candles, and opts with btcCandles1h', async () => {
      setupStandardData();
      const e = new SymbolEngine('DOGE/USDT:USDT');
      await tick(e);

      expect(checkMomentumSignalCalls).toHaveLength(1);
      const [symbol, closedCandles, btcCandles, opts] = checkMomentumSignalCalls[0];
      expect(symbol).toBe('DOGE/USDT:USDT');
      expect(closedCandles.length).toBe(250);
      expect(btcCandles.length).toBe(250);
      expect(opts).toHaveProperty('nowMs');
      expect(opts).toHaveProperty('btcCandles1h');
    });

    it('passes only closed candles (not in-progress)', async () => {
      mockSymbolCandles = appendInProgress(make15m(250));
      mockBtc15mCandles = make15m(250);
      const e = new SymbolEngine('X/USDT:USDT');
      await tick(e);

      const [, closedCandles] = checkMomentumSignalCalls[0];
      expect(closedCandles).toHaveLength(250);
      expect(closedCandles.every((c: any) => c.isFinal !== false)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // Tick event
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('tick event', () => {
    it('emitted on every tick with symbol, price, timestamp, isNewCandle', async () => {
      setupStandardData();
      const e = new SymbolEngine('DOGE/USDT:USDT');
      const ticks: any[] = [];
      e.on('tick', (t: any) => ticks.push(t));
      await tick(e);

      expect(ticks).toHaveLength(1);
      expect(ticks[0].symbol).toBe('DOGE/USDT:USDT');
      expect(ticks[0].isNewCandle).toBe(true);
      expect(typeof ticks[0].price).toBe('number');
      expect(ticks[0].price).toBeGreaterThan(0);
      expect(typeof ticks[0].timestamp).toBe('number');
    });

    it('isNewCandle is true on first tick, false on same candles', async () => {
      setupStandardData();
      const e = new SymbolEngine('X/USDT:USDT');
      const ticks: any[] = [];
      e.on('tick', (t: any) => ticks.push(t));
      await tick(e);
      await tick(e);

      expect(ticks).toHaveLength(2);
      expect(ticks[0].isNewCandle).toBe(true);
      expect(ticks[1].isNewCandle).toBe(false);
    });

    it('fires even when no signal emitted (same candle)', async () => {
      setupStandardData();
      const e = new SymbolEngine('X/USDT:USDT');
      const signals: any[] = [];
      const ticks: any[] = [];
      e.on('signal', (s: any) => signals.push(s));
      e.on('tick', (t: any) => ticks.push(t));

      await tick(e); // first tick: signal + tick
      await tick(e); // second tick: tick only (same candle)

      expect(signals).toHaveLength(1);
      expect(ticks).toHaveLength(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // Re-entrancy guard
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('re-entrancy', () => {
    it('concurrent ticks are deduplicated', async () => {
      setupStandardData();
      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));

      // Fire two ticks concurrently — second should be skipped by guard
      await Promise.all([tick(e), tick(e)]);
      expect(out).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // Error handling
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('error handling', () => {
    it('signal computation error does not crash engine', async () => {
      mockSignalResult = null; // will cause a throw when accessing .features
      setupStandardData();
      const e = new SymbolEngine('X/USDT:USDT');
      const out: any[] = [];
      e.on('signal', (s: any) => out.push(s));

      // checkMomentumSignal returns null, code will throw accessing null.features
      // The try-catch in tickInner should catch it
      await expect(tick(e)).resolves.toBeUndefined();
      expect(out).toHaveLength(0); // no signal emitted on error
      expect(e.getTickCount()).toBe(1); // tick still counted
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // State management
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('state', () => {
    it('getMarketConditions null before tick', () => {
      expect(new SymbolEngine('X/USDT:USDT').getMarketConditions()).toBeNull();
    });

    it('getMarketConditions populated after tick', async () => {
      setupStandardData();
      const e = new SymbolEngine('X/USDT:USDT');
      await tick(e);
      const mc = e.getMarketConditions();
      expect(mc).not.toBeNull();
      expect(mc).toHaveProperty('btcTrend');
    });

    it('tickCount increments on every tick', async () => {
      setupStandardData();
      const e = new SymbolEngine('X/USDT:USDT');
      expect(e.getTickCount()).toBe(0);
      await tick(e);
      expect(e.getTickCount()).toBe(1);
      await tick(e);
      expect(e.getTickCount()).toBe(2);
    });

    it('getCandles populated after tick', async () => {
      setupStandardData();
      const e = new SymbolEngine('X/USDT:USDT');
      expect(e.getCandles()).toHaveLength(0);
      await tick(e);
      expect(e.getCandles()).toHaveLength(250);
    });

    it('getLastSignal null before tick', () => {
      expect(new SymbolEngine('X/USDT:USDT').getLastSignal()).toBeNull();
    });
  });
});
