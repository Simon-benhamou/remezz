import type { IStrategy, EntryContext, ExitContext, StrategySignal, StrategyExitSignal, StrategyConfig } from '../types.js';
import { FUNDING_CONFIG } from './config.js';

// ============================================================================
// FundingRateStrategy
//
// Proxy-based funding rate strategy: uses 8h momentum as a proxy for funding
// rate direction. When momentum is strongly positive, funding is likely positive
// (longs pay shorts) — we SHORT to collect the payment. Vice versa.
// ============================================================================

export class FundingRateStrategy implements IStrategy {
  readonly name = 'fundingRate';

  getConfig(): StrategyConfig {
    return {
      name: 'fundingRate',
      version: '1.0',
      symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
      leverage: 1,                // Conservative — funding arb is low risk
      maxPositions: 4,            // One per symbol
      positionSizePct: 0.05,
      minCandlesRequired: FUNDING_CONFIG.MOMENTUM_LOOKBACK + 10,
      timeframeMs: 15 * 60 * 1000,
      fees: { tradingPct: 0.04, slippagePct: 0.05, fundingPct: 0.01 },
    };
  }

  checkEntry(ctx: EntryContext): StrategySignal | null {
    const { candles } = ctx;
    const cfg = FUNDING_CONFIG;

    if (candles.length < cfg.MOMENTUM_LOOKBACK + 1) return null;

    // Calculate 8h momentum
    const currentClose = candles[candles.length - 1].close;
    const pastClose = candles[candles.length - 1 - cfg.MOMENTUM_LOOKBACK].close;

    if (pastClose <= 0) return null;

    const momentumPct = ((currentClose - pastClose) / pastClose) * 100;

    // SHORT when momentum is strongly positive (funding likely positive, collect payment)
    if (momentumPct > cfg.MOMENTUM_THRESHOLD_PCT) {
      const confidence = Math.min(0.5, 0.3 + (momentumPct - cfg.MOMENTUM_THRESHOLD_PCT) / 10);

      return {
        valid: true,
        side: 'short',
        confidence,
        reason: `FUNDING_SHORT momentum=${momentumPct.toFixed(2)}% (proxy: longs pay shorts)`,
        stopLossPct: cfg.STOP_LOSS_PCT,
        metadata: { momentumPct, direction: 'short' },
      };
    }

    // LONG when momentum is strongly negative (funding likely negative, collect payment)
    if (!cfg.SHORT_ONLY && momentumPct < -cfg.MOMENTUM_THRESHOLD_PCT) {
      const confidence = Math.min(0.5, 0.3 + (Math.abs(momentumPct) - cfg.MOMENTUM_THRESHOLD_PCT) / 10);

      return {
        valid: true,
        side: 'long',
        confidence,
        reason: `FUNDING_LONG momentum=${momentumPct.toFixed(2)}% (proxy: shorts pay longs)`,
        stopLossPct: cfg.STOP_LOSS_PCT,
        metadata: { momentumPct, direction: 'long' },
      };
    }

    return null;
  }

  checkExit(ctx: ExitContext): StrategyExitSignal {
    const { candles, unrealizedPnlPct, holdingMinutes } = ctx;
    const cfg = FUNDING_CONFIG;

    // 1. Hard stop loss
    if (unrealizedPnlPct <= -cfg.STOP_LOSS_PCT) {
      return { shouldExit: true, reason: 'STOP_LOSS' };
    }

    // 2. Max hold time
    const maxHoldMinutes = cfg.MAX_HOLD_HOURS * 60;
    if (holdingMinutes >= maxHoldMinutes) {
      return { shouldExit: true, reason: 'MAX_HOLD_TIME' };
    }

    // 3. Hold for one funding period (8h), then exit at market
    const holdHoursMinutes = cfg.HOLD_HOURS * 60;
    if (holdingMinutes >= holdHoursMinutes) {
      return { shouldExit: true, reason: 'FUNDING_PERIOD_COMPLETE' };
    }

    // 4. Momentum reversal — if momentum crosses zero, exit early
    if (candles.length >= cfg.MOMENTUM_LOOKBACK + 1) {
      const currentClose = candles[candles.length - 1].close;
      const pastClose = candles[candles.length - 1 - cfg.MOMENTUM_LOOKBACK].close;
      if (pastClose > 0) {
        const momentumPct = ((currentClose - pastClose) / pastClose) * 100;

        // If we're short (entered on positive momentum) and momentum flips negative, exit
        // If we're long (entered on negative momentum) and momentum flips positive, exit
        const { position } = ctx;
        if (position.side === 'short' && momentumPct < 0) {
          return { shouldExit: true, reason: 'MOMENTUM_REVERSAL' };
        }
        if (position.side === 'long' && momentumPct > 0) {
          return { shouldExit: true, reason: 'MOMENTUM_REVERSAL' };
        }
      }
    }

    return { shouldExit: false, reason: 'holding' };
  }
}

export const fundingRateStrategy = new FundingRateStrategy();
