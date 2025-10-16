import type { TechnicalSnapshot } from '../../../ai/tech.js';
import { getConfig } from '../../../utils/env.js';
import { recordOpsEvent } from '../../../monitor/ops.js';
import type { ReboundRejectionAgent } from '../index.js';

function evaluateAntiWhaleFilters(this: ReboundRejectionAgent, snap: TechnicalSnapshot): {
  status: 'PASS' | 'FAIL' | 'QUARANTINE';
  reason: string;
  details: Record<string, any>;
} {
  try {
    const cfg = getConfig();
    if (!cfg.ANTI_WHALE_ENABLED) {
      return {
        status: 'PASS',
        reason: 'Anti-whale filters disabled',
        details: { enabled: false },
      };
    }

    const price = Number((snap as any)?.last ?? 0);
    const vol = Number((snap as any)?.volume ?? 0);
    const volMA = Number((snap as any)?.volumeMA ?? (snap as any)?.volumeAvg ?? 0);
    const atrPct = Number((snap as any)?.atrPct ?? 0);
    const adx = Number((snap as any)?.adx14 ?? 0);
    const now = Date.now();

    if (!(volMA > 0) || !(price > 0)) {
      return {
        status: 'PASS',
        reason: 'Insufficient volume data for anti-whale filters',
        details: { vol, volMA, atrPct, adx },
      };
    }

    let spikeThreshold = Math.max(1.2, cfg.ANTI_WHALE_VOL_SPIKE_MULT);
    const highVol = atrPct >= Math.max(0.8, cfg.ANTI_WHALE_ATR_PCT);
    if (highVol) {
      spikeThreshold = Math.max(spikeThreshold, 3.5);
    }

    const spikeRatio = volMA > 0 ? vol / volMA : 0;
    const weakTrend = adx < Math.max(10, cfg.ANTI_WHALE_MIN_ADX);

    if (this.whaleQuarantine && this.whaleQuarantine.active) {
      const { until, triggeredAt, adxAtTrigger, atrPctAtTrigger, threshold } = this.whaleQuarantine;
      if (now >= until) {
        const needsTrendRecovery = (atrPctAtTrigger >= Math.max(0.8, cfg.ANTI_WHALE_ATR_PCT))
          || (highVol && atrPct >= Math.max(0.8, cfg.ANTI_WHALE_ATR_PCT));
        if (needsTrendRecovery && adx < Math.max(10, cfg.ANTI_WHALE_MIN_ADX)) {
          const extensionMs = 60_000;
          this.whaleQuarantine = {
            ...this.whaleQuarantine,
            until: now + extensionMs,
          };
          return {
            status: 'QUARANTINE',
            reason: 'Volume spike quarantine extended while waiting for ADX recovery',
            details: {
              spikeRatio,
              vol,
              volMA,
              atrPct,
              adx,
              spikeThreshold,
              quarantineUntil: this.whaleQuarantine.until,
              triggeredAt,
              adxAtTrigger,
              atrPctAtTrigger,
              threshold,
            },
          };
        }
        this.whaleQuarantine = null;
      } else {
        return {
          status: 'QUARANTINE',
          reason: 'Volume spike quarantine active',
          details: {
            spikeRatio,
            vol,
            volMA,
            atrPct,
            adx,
            spikeThreshold,
            quarantineUntil: until,
            triggeredAt,
            adxAtTrigger,
            atrPctAtTrigger,
          },
        };
      }
    }

    if (spikeRatio >= spikeThreshold && highVol && weakTrend) {
      const reason = `Volume spike ${spikeRatio.toFixed(2)}x with weak trend (ADX ${adx.toFixed(1)}) during extreme volatility`;
      const quarantineMs = 4 * 60 * 1000;
      const until = now + quarantineMs;
      this.lastWhaleSpikeTs = now;
      this.whaleQuarantine = {
        active: true,
        triggeredAt: now,
        until,
        reason,
        adxAtTrigger: adx,
        atrPctAtTrigger: atrPct,
        spikeRatio,
        threshold: spikeThreshold,
        logged: false,
      };
      return {
        status: 'FAIL',
        reason,
        details: {
          spikeRatio,
          vol,
          volMA,
          atrPct,
          adx,
          spikeThreshold,
          quarantineUntil: until,
        },
      };
    }

    return {
      status: 'PASS',
      reason: 'No adverse whale activity detected',
      details: { spikeRatio, vol, volMA, atrPct, adx, spikeThreshold },
    };
  } catch (error) {
    return {
      status: 'PASS',
      reason: 'Anti-whale evaluation unavailable',
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function passesAntiWhaleFilters(this: ReboundRejectionAgent, snap: TechnicalSnapshot): boolean {
  const evaluation = this.evaluateAntiWhaleFilters(snap);
  if (evaluation.status === 'FAIL') {
    if (this.whaleQuarantine) {
      this.whaleQuarantine.logged = true;
    }
    recordOpsEvent({
      level: 'warn',
      source: 'anti_whale',
      message: 'blocked_due_to_volume_spike_in_extreme_vol',
      sessionId: this.sessionId || undefined,
      symbol: this.profile?.symbol,
      details: evaluation.details,
    });
    return false;
  }
  if (evaluation.status === 'QUARANTINE') {
    const alreadyLogged = this.whaleQuarantine?.logged ?? false;
    if (!alreadyLogged) {
      recordOpsEvent({
        level: 'warn',
        source: 'anti_whale',
        message: 'blocked_due_to_volume_spike_in_extreme_vol',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: evaluation.details,
      });
      if (this.whaleQuarantine) {
        this.whaleQuarantine.logged = true;
      }
    }
    return false;
  }
  return true;
}

async function executeVolumeProbe(this: ReboundRejectionAgent, params: {
  side: 'buy' | 'sell';
  zonePrice: number;
  currentPrice: number;
  targetRatio: number;
  currentRatio: number;
  rawRatio: number;
  tp1ProfitPct: number;
  adx: number;
  atrPct: number;
}): Promise<void> {
  if (!this.broker || !this.profile) return;
  const now = Date.now();
  const cooldownMs = 90_000;
  const existing = this.volumeProbeState;
  if (existing) {
    if (existing.active) return;
    if (now - existing.lastAttemptTs < cooldownMs) return;
  }
  if (!(params.targetRatio > 0) || !(params.currentRatio > 0)) return;
  let readiness = params.currentRatio / params.targetRatio;
  if (!Number.isFinite(readiness) || readiness < 0.7) return;
  readiness = Math.max(0, Math.min(2, readiness));

  const cfg = getConfig();
  const floorUsd = Math.max(30, Number(cfg.MIN_ORDER_NOTIONAL_USD || 0));
  const referencePrice = params.zonePrice > 0 ? params.zonePrice : params.currentPrice;
  const limitPrice = params.side === 'buy'
    ? Math.min(params.currentPrice, referencePrice)
    : Math.max(params.currentPrice, referencePrice);
  if (!(limitPrice > 0)) return;

  const qty = floorUsd / limitPrice;
  if (!(qty > 0)) return;

  const timeoutMs = 8_000;
  const targetNotional = qty * limitPrice;
  const attempt = {
    active: true,
    lastAttemptTs: now,
    orderId: null,
    side: params.side,
    status: 'new' as const,
    targetNotional,
    timeoutMs,
    readiness,
  };
  this.volumeProbeState = attempt;

  try {
    const order = await this.broker.place({
      symbol: this.profile.symbol,
      side: params.side,
      type: 'limit',
      qty,
      price: limitPrice,
      postOnly: true,
      timeInForce: 'GTC',
    });

    this.volumeProbeState = {
      ...attempt,
      orderId: order.id,
      status: order.status,
    };

    recordOpsEvent({
      level: 'info',
      source: 'entry_probe',
      message: order.status === 'filled' ? 'volume_probe_filled' : 'volume_probe_order_placed',
      sessionId: this.sessionId || undefined,
      symbol: this.profile.symbol,
      details: {
        side: params.side,
        price: limitPrice,
        qty,
        notional: targetNotional,
        targetRatio: params.targetRatio,
        currentRatio: params.currentRatio,
        rawRatio: params.rawRatio,
        tp1ProfitPct: params.tp1ProfitPct,
        adx: params.adx,
        atrPct: params.atrPct,
        status: order.status,
      },
    });

    if (order.status === 'filled') {
      this.volumeProbeState = {
        ...this.volumeProbeState!,
        active: false,
        status: 'filled',
        lastFillTs: now,
        fillNotional: (order as any)?.filledNotional ?? targetNotional,
      };
      return;
    }

    if (this.volumeProbeTimeout) {
      clearTimeout(this.volumeProbeTimeout);
    }
    this.volumeProbeTimeout = setTimeout(() => {
      void this.finalizeVolumeProbe(order.id);
    }, timeoutMs);
  } catch (error) {
    this.volumeProbeState = {
      ...attempt,
      active: false,
      status: 'rejected',
    };
    recordOpsEvent({
      level: 'warn',
      source: 'entry_probe',
      message: 'volume_probe_failed',
      sessionId: this.sessionId || undefined,
      symbol: this.profile?.symbol,
      details: {
        error: error instanceof Error ? error.message : String(error),
        side: params.side,
        price: limitPrice,
        qty,
        notional: targetNotional,
        targetRatio: params.targetRatio,
        currentRatio: params.currentRatio,
        rawRatio: params.rawRatio,
      },
    });
  }
}

async function finalizeVolumeProbe(this: ReboundRejectionAgent, orderId: string): Promise<void> {
  if (this.volumeProbeTimeout) {
    clearTimeout(this.volumeProbeTimeout);
    this.volumeProbeTimeout = null;
  }
  const state = this.volumeProbeState;
  if (!state || state.orderId !== orderId) {
    return;
  }
  if (!this.broker) {
    this.volumeProbeState = { ...state, active: false };
    return;
  }
  if (state.status === 'filled') {
    this.volumeProbeState = { ...state, active: false };
    return;
  }

  try {
    await this.broker.cancel(orderId);
    recordOpsEvent({
      level: 'info',
      source: 'entry_probe',
      message: 'volume_probe_cancelled',
      sessionId: this.sessionId || undefined,
      symbol: this.profile?.symbol,
      details: {
        orderId,
        side: state.side,
        notional: state.targetNotional,
      },
    });
    this.volumeProbeState = {
      ...state,
      active: false,
      status: 'canceled',
      orderId: null,
    };
  } catch (error) {
    recordOpsEvent({
      level: 'warn',
      source: 'entry_probe',
      message: 'volume_probe_cancel_failed',
      sessionId: this.sessionId || undefined,
      symbol: this.profile?.symbol,
      details: {
        orderId,
        side: state.side,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    this.volumeProbeState = { ...state, active: false };
  }
}


export interface LiquidityMethods {
  evaluateAntiWhaleFilters: typeof evaluateAntiWhaleFilters;
  passesAntiWhaleFilters: typeof passesAntiWhaleFilters;
  executeVolumeProbe: typeof executeVolumeProbe;
  finalizeVolumeProbe: typeof finalizeVolumeProbe;
}

export const liquidityMethods: LiquidityMethods = {
  evaluateAntiWhaleFilters,
  passesAntiWhaleFilters,
  executeVolumeProbe,
  finalizeVolumeProbe
};
