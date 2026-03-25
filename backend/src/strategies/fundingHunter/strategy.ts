import type { IStrategy, StrategyConfig, EntryContext, ExitContext, StrategySignal, StrategyExitSignal, Candle } from '../types.js';
import { FUNDING_HUNTER_CONFIG } from './config.js';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// Types
// ============================================================================

interface FundingEntry {
  fundingRate: number;  // decimal, e.g. 0.0001 = 0.01%
  fundingTime: number;  // ms timestamp
  markPrice?: number;
}

// ============================================================================
// FundingHunterStrategy
//
// Uses REAL historical funding rate data (not proxy).
// When funding rate is extremely positive, shorts collect funding AND benefit
// from liquidation cascades. When extremely negative, longs collect.
// ============================================================================

export class FundingHunterStrategy implements IStrategy {
  readonly name = 'fundingHunter';
  private fundingData: Map<string, FundingEntry[]> = new Map();

  constructor() {
    this.loadFundingData();
  }

  // --------------------------------------------------------------------------
  // Data loading
  // --------------------------------------------------------------------------

  private loadFundingData(): void {
    const dataDir = path.resolve(process.cwd(), 'data', 'positioning');
    const symbolMap: Record<string, string> = {
      'BTC/USDT:USDT': 'BTC',
      'ETH/USDT:USDT': 'ETH',
      'SOL/USDT:USDT': 'SOL',
      'XRP/USDT:USDT': 'XRP',
    };

    for (const [symbol, prefix] of Object.entries(symbolMap)) {
      const filepath = path.join(dataDir, `${prefix}_funding.json`);
      if (fs.existsSync(filepath)) {
        const raw = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        const entries: FundingEntry[] = raw.map((r: any) => ({
          fundingRate: parseFloat(r.fundingRate),
          fundingTime: r.fundingTime,
          markPrice: r.markPrice ? parseFloat(r.markPrice) : undefined,
        })).sort((a: FundingEntry, b: FundingEntry) => a.fundingTime - b.fundingTime);
        this.fundingData.set(symbol, entries);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Funding rate lookup (binary search, NO look-ahead)
  // --------------------------------------------------------------------------

  /** Get the most recent funding rate BEFORE or AT the given timestamp */
  private getFundingRate(symbol: string, timestamp: number): FundingEntry | null {
    const entries = this.fundingData.get(symbol);
    if (!entries || entries.length === 0) return null;

    // Binary search for last entry with fundingTime <= timestamp
    let lo = 0, hi = entries.length - 1;
    let result: FundingEntry | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (entries[mid].fundingTime <= timestamp) {
        result = entries[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }

  /** Expose for testing */
  getFundingDataForSymbol(symbol: string): FundingEntry[] | undefined {
    return this.fundingData.get(symbol);
  }

  /** Inject funding data for testing (avoids file I/O) */
  setFundingData(symbol: string, entries: FundingEntry[]): void {
    this.fundingData.set(symbol, entries.sort((a, b) => a.fundingTime - b.fundingTime));
  }

  // --------------------------------------------------------------------------
  // Config
  // --------------------------------------------------------------------------

  getConfig(): StrategyConfig {
    const cfg = FUNDING_HUNTER_CONFIG;
    return {
      name: 'fundingHunter',
      version: '1.0',
      symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
      leverage: cfg.LEVERAGE,
      maxPositions: 4,
      positionSizePct: cfg.BASE_POSITION_PCT,
      minCandlesRequired: 20,
      timeframeMs: 15 * 60 * 1000,
      fees: { tradingPct: 0.04, slippagePct: 0.05, fundingPct: 0.01 },
    };
  }

  // --------------------------------------------------------------------------
  // Entry
  // --------------------------------------------------------------------------

  checkEntry(ctx: EntryContext): StrategySignal | null {
    const { symbol, candles, currentPrice, timestamp } = ctx;
    const cfg = FUNDING_HUNTER_CONFIG;

    // 1. Basic sanity: need at least 20 candles for context
    if (candles.length < 20) return null;

    // 2. Get the most recent funding rate BEFORE current timestamp
    const fundingEntry = this.getFundingRate(symbol, timestamp);
    if (!fundingEntry) return null;

    // 3. Check staleness: funding must be within 9h (32400000ms)
    const ageMs = timestamp - fundingEntry.fundingTime;
    if (ageMs > 32_400_000) return null;

    // 4. Convert to percentage
    const fundingPct = fundingEntry.fundingRate * 100;

    // 5. Crash guard: don't enter into a crash
    //    Check last 4 candles (1h) for > 5% drop/rise
    const recentCandles = candles.slice(-4);
    const firstClose = recentCandles[0].close;
    const lastClose = recentCandles[recentCandles.length - 1].close;
    const recentChangePct = ((lastClose - firstClose) / firstClose) * 100;

    // 6. Determine signal
    if (fundingPct > cfg.HIGH_FUNDING_ENTRY) {
      // Don't short into a crash (price already dropping > 5%)
      if (recentChangePct < -5) return null;

      const confidence = Math.min(Math.abs(fundingPct) / cfg.EXTREME_FUNDING, 1.0);
      const isExtreme = Math.abs(fundingPct) >= cfg.EXTREME_FUNDING;

      return {
        valid: true,
        side: 'short',
        confidence,
        reason: `FUNDING_HUNTER_SHORT funding=${fundingPct.toFixed(4)}% age=${Math.round(ageMs / 60000)}m${isExtreme ? ' EXTREME' : ''}`,
        stopLossPct: cfg.STOP_LOSS_PCT,
        metadata: {
          fundingPct,
          fundingTime: fundingEntry.fundingTime,
          ageMs,
          isExtreme,
          positionPct: isExtreme ? cfg.EXTREME_POSITION_PCT : cfg.BASE_POSITION_PCT,
        },
      };
    }

    if (!cfg.SHORT_ONLY && fundingPct < cfg.LOW_FUNDING_ENTRY) {
      // Don't long into a pump (price already rising > 5%)
      if (recentChangePct > 5) return null;

      const confidence = Math.min(Math.abs(fundingPct) / cfg.EXTREME_FUNDING, 1.0);
      const isExtreme = Math.abs(fundingPct) >= cfg.EXTREME_FUNDING;

      return {
        valid: true,
        side: 'long',
        confidence,
        reason: `FUNDING_HUNTER_LONG funding=${fundingPct.toFixed(4)}% age=${Math.round(ageMs / 60000)}m${isExtreme ? ' EXTREME' : ''}`,
        stopLossPct: cfg.STOP_LOSS_PCT,
        metadata: {
          fundingPct,
          fundingTime: fundingEntry.fundingTime,
          ageMs,
          isExtreme,
          positionPct: isExtreme ? cfg.EXTREME_POSITION_PCT : cfg.BASE_POSITION_PCT,
        },
      };
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // Exit
  // --------------------------------------------------------------------------

  checkExit(ctx: ExitContext): StrategyExitSignal {
    const { symbol, position, candles, currentPrice, unrealizedPnlPct, holdingMinutes, timestamp } = ctx;
    const cfg = FUNDING_HUNTER_CONFIG;

    // 1. Hard stop loss
    if (unrealizedPnlPct <= -cfg.STOP_LOSS_PCT) {
      return { shouldExit: true, reason: 'STOP_LOSS' };
    }

    // 2. Max hold time
    const maxHoldMinutes = cfg.MAX_HOLD_CANDLES * 15;
    if (holdingMinutes >= maxHoldMinutes) {
      return { shouldExit: true, reason: 'MAX_HOLD_TIME' };
    }

    // 3. Trailing stop (if enabled)
    if (cfg.TRAILING_ENABLED) {
      const maxPnl = position.maxPnlPct ?? unrealizedPnlPct;
      if (maxPnl >= cfg.TRAILING_ACTIVATION_PCT) {
        const drawdownFromPeak = maxPnl - unrealizedPnlPct;
        if (drawdownFromPeak > cfg.TRAILING_DISTANCE_PCT) {
          return { shouldExit: true, reason: 'TRAILING_STOP' };
        }
      }
    }

    // 4. Hold period complete (one funding period)
    const holdCandlesMinutes = cfg.HOLD_CANDLES * 15;
    if (holdingMinutes >= holdCandlesMinutes) {
      return { shouldExit: true, reason: 'FUNDING_PERIOD_COMPLETE' };
    }

    // 5. Funding reversal: if funding has flipped sign, consider early exit
    const fundingEntry = this.getFundingRate(symbol, timestamp);
    if (fundingEntry) {
      const currentFundingPct = fundingEntry.fundingRate * 100;
      // Short entered on positive funding -> exit if funding went negative
      if (position.side === 'short' && currentFundingPct < 0) {
        return { shouldExit: true, reason: 'FUNDING_REVERSAL' };
      }
      // Long entered on negative funding -> exit if funding went positive
      if (position.side === 'long' && currentFundingPct > 0) {
        return { shouldExit: true, reason: 'FUNDING_REVERSAL' };
      }
    }

    return { shouldExit: false, reason: 'holding' };
  }
}

export const fundingHunterStrategy = new FundingHunterStrategy();
