import { PlanJson } from './planSchema.js';
import { validatePlan, ValidatedPlan } from './validator.js';
import { PaperBroker } from '../broker/paper.js';
import { LiveBroker, inspectExposure, getCapacityPressure } from '../broker/live.js';
import { Broker } from '../broker/types.js';
import { assessRisk, computeQtyNotional, defaultLimits } from '../risk/manager.js';
import { computeAdaptiveRisk, AdaptiveRiskResult } from '../risk/adaptive.js';
import { buildTechSnapshot, TechnicalSnapshot } from '../ai/tech.js';
import { broadcast } from '../ws/hub.js';
import { recordEnter, recordExit, updateProtectiveSnapshot, loadActivePosition } from './persistence.js';
import { recomputeKpi } from '../metrics/kpi.js';
import { getConfig } from '../utils/env.js';
import { getAICallsCount } from '../metrics/aiCalls.js';
import { requestStrategy } from '../ai/strategyManager.js';
import { proposePlan } from '../ai/planOrchestrator.js';
import { recordOpsEvent } from '../monitor/ops.js';
import { logImprovementAuto } from '../monitor/backlog.js';
import type { RegimeProfile } from '../ai/regime.js';
import { getTicker } from '../data/market.js';
import type { PlacedOrder } from '../broker/types.js';
import { prisma } from '../db/client.js';

export type AgentMode = 'paper'|'live';
export type AgentState = 'IDLE'|'PREFLIGHT'|'SCAN'|'PROPOSE'|'VALIDATE'|'ARMED'|'ENTERED'|'MANAGE'|'EXIT'|'REPORT'|'COOLDOWN'|'HALT';

export type ActivationProfile = {
  symbol: string;
  mode: AgentMode;
  maxLeverage: number; // <= 5
  riskPerTradePct: number; // 1..2
  dailyLossLimitPct: number; // 3..4
  timestamp: string; // ISO, acts as a signed "freeze"
  startBalanceUsd?: number;
  budgetFraction?: number; // 0..1 fraction of free balance usable by the agent
};

export type ActivePosition = {
  side: 'buy'|'sell';
  entry: number;
  qty: number;
  stop: number;
  tp: number[];
  openedAt: number;
  extended: boolean;
  partialTaken?: boolean;
  slOrderId?: string;
  tpOrderId?: string;
  trail?: { ts: number; price: number }[];
  maeR?: number;
  mfeR?: number;
  breakeven?: number;
  partialInfo?: { ts: number; price: number } | null;
};

export class ReboundRejectionAgent {
  state: AgentState = 'IDLE';
  profile: ActivationProfile | null = null;
  plan: ValidatedPlan | null = null;
  broker: Broker | null = null;
  pos: ActivePosition | null = null;
  extendedOnce = false;
  private entering = false;
  sessionId: string | null = null;
  private breakoutTicks = 0; // consecutive ticks confirming breakout
  regime: RegimeProfile | null = null;
  private adaptiveRisk: AdaptiveRiskResult | null = null;
  private protectiveErrorCount = 0;
  private killSwitchContext: { reason: string; details?: any } | null = null;
  private haltAckRequired = false;
  private recoveryTimer: NodeJS.Timeout | null = null;

  // simplistic counters for risk
  consecutiveStops = 0;
  tradesToday = 0;
  realizedPnlTodayPct = 0;

  async activate(profile: ActivationProfile) {
    // PREFLIGHT
    this.state = 'PREFLIGHT';
    this.profile = profile;
    this.haltAckRequired = false;
    if (this.recoveryTimer) { try { clearTimeout(this.recoveryTimer); } catch {} this.recoveryTimer = null; }
    if (profile.maxLeverage > 5) throw new Error('maxLeverage>5 not allowed');
    if (profile.riskPerTradePct < 1 || profile.riskPerTradePct > 2) throw new Error('risk/trade must be 1-2%');
    if (profile.dailyLossLimitPct < 3 || profile.dailyLossLimitPct > 4) throw new Error('daily loss must be 3-4%');

    // init broker (paper only for now)
    this.broker = profile.mode === 'live'
      ? new LiveBroker()
      : new PaperBroker(profile.startBalanceUsd);
    this.state = 'SCAN';
  }

  async propose(plan: PlanJson) {
    if (this.state !== 'SCAN' && this.state !== 'PROPOSE') return;
    this.state = 'PROPOSE';
    this.plan = await validatePlan(plan);
    this.regime = this.plan.regime ?? null;
    this.state = 'VALIDATE';
  }

  async validateAndArm() {
    if (!this.profile || !this.plan) throw new Error('no plan');
    await this.restorePersistedPosition();
    this.regime = this.plan.regime ?? null;
    if (this.regime && this.regime.playbook === 'standby') {
      this.state = 'COOLDOWN';
      broadcast('agent_state', { state: this.state, plan: this.plan, reason: 'regime_standby' }, this.profile.symbol, this.sessionId || undefined);
      recordOpsEvent({ level: 'info', source: 'regime', message: 'Standby regime detected - pausing entries', sessionId: this.sessionId || undefined, symbol: this.profile.symbol, details: this.regime });
      return;
    }
    // If a position already exists, don't re-arm — keep managing
    if (this.pos) {
      this.state = 'MANAGE';
      broadcast('agent_state', { state: this.state, pos: this.pos }, this.profile.symbol, this.sessionId || undefined);
      await this.syncProtectiveOrders('startup');
      return;
    }
    // Bypass risk / spread / leverage gating per user request
    this.state = 'ARMED';
    const aiCalls = await getAICallsCount(this.sessionId || undefined);
    broadcast('agent_state', { state: this.state, plan: this.plan, regime: this.regime, aiCalls }, this.profile.symbol, this.sessionId || undefined);

    // Live exposure inspection: if in live mode and a position already exists, adopt it and switch to MANAGE
    if (this.profile.mode === 'live' && !this.pos) {
      try {
        const expo = await inspectExposure(this.profile.symbol);
        if (expo && expo.qty > 0) {
          const side = expo.side;
          const entry = expo.entry || (await buildTechSnapshot(this.profile.symbol)).last;
          const stop = side === 'buy' ? (entry - this.plan.stopDistance) : (entry + this.plan.stopDistance);
          // Rebase TP ladder from entry using R multiples
          const dir = side === 'buy' ? 1 : -1;
          const tp = (this.plan.rPrices || []).map(x => entry + dir * x.r * this.plan!.stopDistance);
          const now = Date.now();
          this.pos = {
            side,
            entry,
            qty: expo.qty,
            stop,
            tp,
            openedAt: now,
            extended: false,
            partialTaken: false,
            slOrderId: undefined,
            tpOrderId: undefined,
            trail: [{ ts: now, price: stop }],
            breakeven: entry,
            partialInfo: null,
          } as any;
          this.state = 'MANAGE';
          broadcast('agent_state', { state: this.state, pos: this.pos }, this.profile.symbol, this.sessionId || undefined);
          await this.syncProtectiveOrders('adopt');
        }
      } catch {}
    }
  }

  // On new candles/ticks, check trigger and possibly enter
  async onTick() {
    if (!this.profile || !this.plan) return;
    if (this.state !== 'ARMED' && this.state !== 'MANAGE') return;
    const snap = await buildTechSnapshot(this.profile.symbol);
    if (snap.regime) this.regime = snap.regime;
    if (this.regime && !this.regime.shouldTrade) {
      if (this.state === 'ARMED') {
        this.state = 'COOLDOWN';
        broadcast('agent_state', { state: this.state, plan: this.plan, reason: 'regime_standby' }, this.profile.symbol, this.sessionId || undefined);
      }
      return;
    }
    const price = snap.last;
    const { from, to, mid } = this.plan.zone;
    const playbook = this.plan.plan.meta?.playbook || this.regime?.playbook || 'mean_reversion';

    if (this.state === 'ARMED') {
      // Safety: if a position is somehow set, switch to MANAGE
      if (this.pos) { this.state = 'MANAGE'; broadcast('agent_state', { state: this.state, pos: this.pos }, this.profile.symbol, this.sessionId || undefined); return; }
      if (this.plan.bias === 'none') return;
      const inZone = price >= Math.min(from,to) && price <= Math.max(from,to);
      // Entry filters: basic RSI/ADX gates to avoid weak/contrarian entries
      const cfg = getConfig();
      if (this.plan.bias === 'short') {
        if ((snap as any).adx14 != null && (snap as any).adx14 < cfg.ENTRY_SHORT_MIN_ADX) return;
        if ((snap as any).rsi14 != null && (snap as any).rsi14 < cfg.ENTRY_SHORT_MIN_RSI) return;
      } else if (this.plan.bias === 'long') {
        if ((snap as any).adx14 != null && (snap as any).adx14 < cfg.ENTRY_LONG_MIN_ADX) return;
        if ((snap as any).rsi14 != null && (snap as any).rsi14 > cfg.ENTRY_LONG_MAX_RSI) return;
      }
      if (playbook === 'momentum_breakout') {
        const upper = Math.max(from, to);
        const lower = Math.min(from, to);
        const breakoutLong = this.plan.bias === 'long' && price > upper;
        const breakoutShort = this.plan.bias === 'short' && price < lower;
        if (breakoutLong || breakoutShort) await this.enter(price, snap);
      } else {
        // simple confirmation: bias-aligned close beyond zone mid
        const confirm = this.plan.plan.entry_rule.confirm_close && ((this.plan.bias === 'long' && price > mid) || (this.plan.bias === 'short' && price < mid));
        if (inZone && confirm) await this.enter(price, snap);
      }
    } else if (this.state === 'MANAGE') {
      await this.manage(price, snap);
    }
  }

  async enter(mktPrice: number, _snap?: TechnicalSnapshot) {
    if (!this.broker || !this.plan || !this.profile) return;
    if (this.regime && !this.regime.shouldTrade) return;
    if (this.pos || this.entering) return;
    this.entering = true;
    const bal = await this.broker.balance();
    const side = this.plan.bias === 'long' ? 'buy' : 'sell';
    const entry = mktPrice;
    const round4 = (n:number)=> Math.round(n*1e4)/1e4;
    const stopRaw = this.plan.bias === 'long' ? entry - this.plan.stopDistance : entry + this.plan.stopDistance;
    const stop = round4(stopRaw);
    const dir0 = side === 'buy' ? 1 : -1;
    const tp = this.plan.rPrices.map(x => round4(entry + dir0 * x.r * this.plan!.stopDistance));
    const budgetFrac = Math.max(0.1, Math.min(1, this.profile.budgetFraction ?? 1));
    const availableMargin = Math.max(0, bal.equityUsd - bal.committedUsd);
    const usableBalance = Math.max(0, Math.min(bal.freeUsd, availableMargin) * budgetFrac);
    const planPosition: any = this.plan.plan?.position || {};
    let planRiskMinPct: number | undefined;
    let planRiskMaxPct: number | undefined;
    let planRiskRecommendedPct: number | undefined;
    if (typeof planPosition?.risk_fraction === 'number') {
      planRiskRecommendedPct = planPosition.risk_fraction * 100;
    }
    if (planPosition?.risk_fraction_range) {
      const range = planPosition.risk_fraction_range;
      if (typeof range.min === 'number') planRiskMinPct = range.min * 100;
      if (typeof range.max === 'number') planRiskMaxPct = range.max * 100;
      if (typeof range.recommended === 'number') planRiskRecommendedPct = range.recommended * 100;
    }
    let dynamicRiskPct = planRiskRecommendedPct ?? this.profile.riskPerTradePct;
    if (!(dynamicRiskPct > 0)) dynamicRiskPct = this.profile.riskPerTradePct;
    try {
      this.adaptiveRisk = await computeAdaptiveRisk(this.sessionId, this.profile.riskPerTradePct);
      dynamicRiskPct = this.adaptiveRisk.riskPct;
      if (this.adaptiveRisk.riskPct < this.profile.riskPerTradePct * 0.75) {
        recordOpsEvent({
          level: 'warn',
          source: 'risk_engine',
          message: 'Adaptive risk reduced',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: this.adaptiveRisk,
        });
      }
    } catch {}
    dynamicRiskPct = await this.applyDailyRoiThrottle(dynamicRiskPct);
    if (this.profile.mode === 'live') {
      const pressure = getCapacityPressure(this.profile.symbol);
      if (pressure > 0) {
        const reduction = Math.min(0.5, 0.2 * pressure);
        dynamicRiskPct *= (1 - reduction);
      }
    }
    if (planRiskMinPct != null) dynamicRiskPct = Math.max(planRiskMinPct, dynamicRiskPct);
    if (planRiskMaxPct != null) dynamicRiskPct = Math.min(planRiskMaxPct, dynamicRiskPct);
    if (this.adaptiveRisk) this.adaptiveRisk = { ...this.adaptiveRisk, riskPct: dynamicRiskPct };
    const notional = computeQtyNotional({ balanceUsd: usableBalance, riskPct: dynamicRiskPct, stopDistanceAbs: Math.abs(entry - stop), entryPrice: entry, maxLev: this.profile.maxLeverage });
    let qty = notional / Math.max(entry, 1e-8);
    if (this.profile.mode === 'live' && typeof (this.broker as any)?.estimateFillableQty === 'function') {
      try {
        const estimate = await (this.broker as any).estimateFillableQty({ symbol: this.profile.symbol, side, desiredQty: qty, maxImpactPct: Number(process.env.ORDER_MAX_IMPACT_PCT || '0.35') });
        if (estimate?.fillableQty != null) {
          if (estimate.fillableQty < qty) {
            const reductionNote = `Liquidity limit reduced qty from ${qty.toFixed(6)} to ${estimate.fillableQty.toFixed(6)} (impact ${(estimate.impactPct ?? 0).toFixed(2)}%).`;
            const planJson = this.plan.plan;
            planJson.notes = planJson.notes ? `${planJson.notes}\n${reductionNote}` : reductionNote;
          }
          qty = estimate.fillableQty;
          if (estimate.minQty != null && qty < estimate.minQty) {
            this.entering = false;
            return;
          }
        }
      } catch {}
    }
    if (!(qty > 0)) {
      this.entering = false;
      return;
    }

    const ticker = await getTicker(this.profile.symbol).catch(() => null as any);
    let spreadPct = 0;
    if (ticker?.bid && ticker?.ask) spreadPct = ((ticker.ask - ticker.bid) / ((ticker.ask + ticker.bid) / 2)) * 100;
    const playbook = this.plan.plan.meta?.playbook || this.regime?.playbook || 'mean_reversion';
    const limitSpreadThresh = 0.12;
    const twapSpreadThresh = 0.2;
    let executionMode: 'market'|'limit'|'twap' = 'market';
    if (ticker && playbook !== 'momentum_breakout') {
      if (spreadPct >= twapSpreadThresh && qty * entry > 5000) executionMode = 'twap';
      else if (spreadPct >= limitSpreadThresh) executionMode = 'limit';
    }
    const startTs = Date.now();

    if (executionMode !== 'market') {
      recordOpsEvent({
        level: 'info',
        source: 'execution',
        message: `adaptive_${executionMode}`,
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: { spreadPct, qty, playbook },
      });
    }

    let placed: PlacedOrder;
    if (executionMode === 'limit') {
      const limitPrice = this.computePassivePrice(side, entry, ticker);
      placed = await this.placeLimitAdaptive({ side, qty, limitPrice, stop, tp, entry });
    } else if (executionMode === 'twap') {
      placed = await this.executeTwapOrder({ side, totalQty: qty, slices: 3, intervalMs: 250, stop, tp, entry });
    } else {
      placed = await this.broker.place({ symbol: this.profile.symbol, side, type: 'market', qty, leverage: this.profile.maxLeverage, takeProfit: tp[0], stopLoss: stop });
    }

    if (placed.status === 'rejected' || !placed.filledQty || placed.filledQty <= 0) {
      this.state = 'COOLDOWN';
      broadcast('agent_state', { state: this.state, reason: 'execution_failed' }, this.profile.symbol, this.sessionId || undefined);
      this.entering = false;
      return;
    }

    const telemetry = this.computeTelemetry(startTs, placed, { expectedPrice: entry, requestedQty: qty, side });
    const now = Date.now();
    this.pos = {
      side,
      entry: placed.avgPrice ?? entry,
      qty: placed.filledQty,
      stop,
      tp,
      openedAt: now,
      extended: false,
      slOrderId: (placed as any).slOrderId,
      tpOrderId: (placed as any).tpOrderId,
      trail: [{ ts: now, price: stop }],
      maeR: 0,
      mfeR: 0,
      breakeven: placed.avgPrice ?? entry,
      partialInfo: null,
    };
    if (!Array.isArray(this.pos.tp) || this.pos.tp.length === 0) {
      const baseTp = side === 'buy' ? (this.pos.entry + (this.plan.stopDistance * 2)) : (this.pos.entry - (this.plan.stopDistance * 2));
      this.pos.tp = [baseTp];
    }
    if (this.pos.tp.length === 1) {
      const runnerTp = side === 'buy' ? (this.pos.entry + (this.plan.stopDistance * 3)) : (this.pos.entry - (this.plan.stopDistance * 3));
      this.pos.tp.push(runnerTp);
    }

    try {
      await recordEnter({
        sessionId: this.sessionId!,
        symbol: this.profile.symbol,
        side,
        qty: this.pos.qty,
        entryPrice: this.pos.entry,
        stop: this.pos.stop,
        tp: this.pos.tp,
        leverage: this.profile.maxLeverage,
        requestedPrice: telemetry.requestedPrice,
        requestedQty: qty,
        latencyMs: telemetry.latencyMs,
        slippageBps: telemetry.slippageBps,
        fillRatio: telemetry.fillRatio,
        cancelCount: telemetry.cancelCount,
        attempts: telemetry.attempts,
        slOrderId: this.pos.slOrderId,
        tpOrderId: this.pos.tpOrderId,
      });
    } catch {}

    this.state = 'MANAGE';
    this.tradesToday += 1;
    broadcast('agent_state', { state: this.state, pos: this.pos, regime: this.regime, adaptiveRisk: this.adaptiveRisk, aiCalls: await getAICallsCount(this.sessionId || undefined) }, this.profile.symbol, this.sessionId || undefined);
    await this.syncProtectiveOrders('entry');
    this.entering = false;
  }

  private noteTrail(price: number) {
    if (!this.pos) return;
    const now = Date.now();
    if (!this.pos.trail) this.pos.trail = [];
    const last = this.pos.trail[this.pos.trail.length - 1];
    if (!last || Math.abs(last.price - price) > 1e-6) {
      this.pos.trail.push({ ts: now, price });
      if (this.pos.trail.length > 200) this.pos.trail = this.pos.trail.slice(-200);
    } else {
      last.ts = now;
    }
  }

  private computePassivePrice(side: 'buy'|'sell', reference: number, ticker?: { bid?: number; ask?: number }) {
    const tolerance = 0.0005;
    if (!ticker) return reference;
    if (side === 'buy') {
      const bid = ticker.bid ?? reference;
      return Math.max(0, Math.min(reference, bid * (1 - tolerance)));
    }
    const ask = ticker.ask ?? reference;
    return Math.max(reference, ask * (1 + tolerance));
  }

  private computeDynamicTrail(price: number, snap: { atr14?: number; ema20?: number; ema20Slope?: number; realizedVol?: number }, upR: number, elapsedMs: number): number | null {
    if (!this.pos || !this.plan) return null;
    const side = this.pos.side;
    const dir = side === 'buy' ? 1 : -1;
    const planMeta: any = (this.plan.plan as any)?.meta || {};
    const playbook = planMeta.trailingTemplate || planMeta.playbook || this.regime?.playbook || 'mean_reversion';
    const stopDistance = this.plan.stopDistance || Math.max(1e-8, Math.abs(this.pos.entry * 0.005));
    const atrVal = Math.max(stopDistance * 0.6, snap.atr14 || stopDistance);
    const slope = snap.ema20Slope || 0;
    const realizedVol = snap.realizedVol || 0;
    let multiplier = playbook === 'momentum_breakout' ? 0.65 : playbook === 'mean_reversion' ? 1.05 : 0.85;
    if (upR > 1.5) multiplier *= 0.85;
    if (upR > 2.5) multiplier *= 0.75;
    if (playbook === 'momentum_breakout') {
      if (slope * dir > 0) multiplier *= 0.9;
      else multiplier *= 1.15;
    }
    if (realizedVol > 80) multiplier *= 0.85;
    const atrTrail = price - dir * (atrVal * multiplier);
    let candidate = atrTrail;

    if (snap.ema20) {
      const emaBuffer = snap.ema20 - dir * (atrVal * 0.3);
      candidate = side === 'buy' ? Math.max(candidate, emaBuffer) : Math.min(candidate, emaBuffer);
    }

    const entry = this.pos.entry;
    if (elapsedMs > 30 * 60 * 1000) {
      const tighten = entry + dir * (stopDistance * Math.min(0.5, Math.max(0.2, upR * 0.3)));
      candidate = side === 'buy' ? Math.max(candidate, tighten) : Math.min(candidate, tighten);
    }
    if (elapsedMs > 90 * 60 * 1000) {
      const deepTighten = entry + dir * (stopDistance * Math.min(1, upR));
      candidate = side === 'buy' ? Math.max(candidate, deepTighten) : Math.min(candidate, deepTighten);
    }

    if (upR > 1) {
      const lock = entry + dir * stopDistance * Math.min(1.5, upR);
      candidate = side === 'buy' ? Math.max(candidate, lock) : Math.min(candidate, lock);
    }

    return candidate;
  }

  private async placeLimitAdaptive(params: { side: 'buy'|'sell'; qty: number; limitPrice: number; stop: number; tp: number[]; entry: number }): Promise<PlacedOrder> {
    const order = await this.broker!.place({
      symbol: this.profile!.symbol,
      side: params.side,
      type: 'limit',
      qty: params.qty,
      price: params.limitPrice,
      leverage: this.profile!.maxLeverage,
      postOnly: true,
      timeInForce: 'GTC',
    });
    if (order.status === 'filled' && order.filledQty) return order;
    try { await this.broker!.cancel(order.id).catch(()=>{}); } catch {}
    const fallback = await this.broker!.place({
      symbol: this.profile!.symbol,
      side: params.side,
      type: 'market',
      qty: params.qty,
      leverage: this.profile!.maxLeverage,
    });
    fallback.attempts = (order.attempts || 1) + (fallback.attempts || 1);
    fallback.cancelCount = (order.cancelCount || 0) + (fallback.cancelCount || 0) + 1;
    return fallback;
  }

  private async executeTwapOrder(params: { side: 'buy'|'sell'; totalQty: number; slices: number; intervalMs: number; stop: number; tp: number[]; entry: number }): Promise<PlacedOrder> {
    const slices = Math.max(2, Math.min(5, params.slices));
    const remainingTarget = Math.max(params.totalQty, 0);
    let filled = 0;
    let cost = 0;
    let attempts = 0;
    const start = Date.now();
    for (let i = 0; i < slices; i++) {
      const remaining = remainingTarget - filled;
      if (remaining <= 0) break;
      let sliceQty = i === slices - 1 ? remaining : Math.max(remaining / (slices - i), remainingTarget * 0.15);
      if (this.profile?.mode === 'live' && typeof (this.broker as any)?.estimateFillableQty === 'function') {
        try {
          const estimate = await (this.broker as any).estimateFillableQty({ symbol: this.profile.symbol, side: params.side, desiredQty: sliceQty, maxImpactPct: Number(process.env.ORDER_MAX_IMPACT_PCT || '0.35') });
          if (estimate?.fillableQty != null && estimate.fillableQty > 0) sliceQty = estimate.fillableQty;
        } catch {}
      }
      if (!(sliceQty > 0)) continue;
      attempts += 1;
      const order = await this.broker!.place({
        symbol: this.profile!.symbol,
        side: params.side,
        type: 'market',
        qty: sliceQty,
        leverage: this.profile!.maxLeverage,
      });
      if ((order.status === 'filled' || order.status === 'partially_filled') && order.filledQty && order.avgPrice) {
        const fill = order.filledQty;
        filled += fill;
        cost += fill * order.avgPrice;
      }
      if (i < slices - 1) await new Promise(r => setTimeout(r, params.intervalMs));
    }
    if (filled <= 0) {
      const fallback = await this.broker!.place({
        symbol: this.profile!.symbol,
        side: params.side,
        type: 'market',
        qty: params.totalQty,
        leverage: this.profile!.maxLeverage,
      });
      fallback.attempts = (fallback.attempts || 1) + attempts;
      return fallback;
    }
    const avgPrice = cost / filled;
    return {
      symbol: this.profile!.symbol,
      side: params.side,
      type: 'market',
      qty: params.totalQty,
      leverage: this.profile!.maxLeverage,
      id: `twap_${Date.now()}`,
      status: 'filled',
      filledQty: filled,
      avgPrice,
      ts: Date.now(),
      attempts,
      cancelCount: 0,
      requestedQty: params.totalQty,
      requestedPrice: params.entry,
      stopLoss: params.stop,
      takeProfit: params.tp?.[0],
    } as PlacedOrder;
  }

  private async applyDailyRoiThrottle(baseRiskPct: number): Promise<number> {
    if (!this.sessionId) return baseRiskPct;
    try {
      const reports = await prisma.dailyReport.findMany({
        where: { sessionId: this.sessionId },
        orderBy: { day: 'desc' },
        take: 5,
      });
      if (!reports.length) return baseRiskPct;
      const rois: number[] = [];
      for (const report of reports) {
        const stats = report.stats as any;
        let roi = stats?.roiPct ?? stats?.roi;
        if (roi == null && stats?.pnlUsd != null && this.profile?.startBalanceUsd) {
          roi = (Number(stats.pnlUsd) / this.profile.startBalanceUsd) * 100;
        }
        if (roi != null && Number.isFinite(Number(roi))) rois.push(Number(roi));
      }
      if (!rois.length) return baseRiskPct;
      const avgRoi = rois.reduce((a, b) => a + b, 0) / rois.length;
      let negativeStreak = 0;
      for (const roi of rois) {
        if (roi < -0.5) negativeStreak += 1;
        else break;
      }
      let adjusted = baseRiskPct;
      if (negativeStreak >= 3 || avgRoi < -1.5) {
        adjusted = Math.max(0.3, baseRiskPct * 0.5);
      } else if (negativeStreak >= 2 || avgRoi < -0.8) {
        adjusted = Math.max(0.35, baseRiskPct * 0.7);
      } else if (avgRoi > 1.4 && negativeStreak === 0) {
        adjusted = Math.min(2, baseRiskPct * 1.05);
      }
      adjusted = Math.max(0.3, Math.min(2, adjusted));
      if (Math.abs(adjusted - baseRiskPct) > 0.01) {
        recordOpsEvent({
          level: adjusted < baseRiskPct ? 'warn' : 'info',
          source: 'roi_throttle',
          message: 'daily_roi_adjust',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { avgRoi, negativeStreak, from: baseRiskPct, to: adjusted },
        });
      }
      return adjusted;
    } catch {
      return baseRiskPct;
    }
  }

  private computeTelemetry(startedAt: number, placed: any, opts: { expectedPrice?: number; requestedQty: number; side: 'buy'|'sell' }) {
    const latencyMs = Math.max(0, (placed?.ts ?? Date.now()) - startedAt);
    const filledQty = typeof placed?.filledQty === 'number' ? placed.filledQty : opts.requestedQty;
    const fillRatio = opts.requestedQty > 0 ? Math.min(1, Math.max(0, filledQty / opts.requestedQty)) : undefined;
    let slippageBps: number|undefined;
    if (opts.expectedPrice && placed?.avgPrice) {
      const raw = ((placed.avgPrice - opts.expectedPrice) / opts.expectedPrice) * 10000;
      slippageBps = opts.side === 'buy' ? raw : -raw;
    }
    return {
      latencyMs,
      slippageBps,
      fillRatio,
      cancelCount: placed?.cancelCount ?? 0,
      attempts: placed?.attempts ?? 1,
      requestedPrice: opts.expectedPrice,
    };
  }

  private async restorePersistedPosition() {
    if (!this.sessionId || this.pos) return;
    try {
      const row = await loadActivePosition(this.sessionId);
      if (row && Number(row.qty || 0) > 0) {
        const entry = Number(row.entryPrice || 0);
        const stop = row.stopPrice != null ? Number(row.stopPrice) : entry;
        let tp: number[] = [];
        try {
          if (Array.isArray(row.takeProfit)) {
            tp = (row.takeProfit as unknown as number[]).map((x) => Number(x)).filter((x) => Number.isFinite(x));
          } else if (typeof row.takeProfit === 'number') {
            tp = [Number(row.takeProfit)];
          }
        } catch {}
        const partialTaken = typeof row.protectiveStatus === 'string' && row.protectiveStatus.includes('partial');
        this.pos = {
          side: (row.side as any) || 'buy',
          entry,
          qty: Number(row.qty || 0),
          stop,
          tp,
          openedAt: row.openedAt ? new Date(row.openedAt).getTime() : Date.now(),
          extended: false,
          partialTaken,
          trail: [],
          breakeven: partialTaken ? entry : stop,
          partialInfo: null,
          slOrderId: row.slOrderId || undefined,
          tpOrderId: row.tpOrderId || undefined,
        } as any;
        this.state = 'MANAGE';
      }
    } catch {}
  }

  private async syncProtectiveOrders(reason: 'entry'|'partial'|'trail'|'startup'|'adopt') {
    if (!this.profile || !this.sessionId || !this.pos) return;
    const qty = Number(this.pos.qty || 0);
    const stopLoss = typeof this.pos.stop === 'number' ? this.pos.stop : null;
    const takeProfitArr = Array.isArray(this.pos.tp) && this.pos.tp.length > 0
      ? this.pos.tp.map((x) => Number(x))
      : null;

    // If position effectively closed (qty <= 0), clear snapshot and exit early
    if (!(qty > 0)) {
      try {
        await updateProtectiveSnapshot({
          sessionId: this.sessionId,
          symbol: this.profile.symbol,
          stopPrice: null,
          takeProfit: null,
          slOrderId: null,
          tpOrderId: null,
          status: 'closed',
        });
      } catch {}
      return;
    }

    let status: 'synced'|'skipped'|'error' = 'skipped';
    if (this.broker && typeof this.broker.syncProtective === 'function') {
      try {
        const res = await this.broker.syncProtective({
          symbol: this.profile.symbol,
          side: this.pos.side,
          qty,
          stopLoss: stopLoss ?? undefined,
          takeProfit: takeProfitArr ? takeProfitArr[0] : undefined,
          slOrderId: this.pos.slOrderId,
          tpOrderId: this.pos.tpOrderId,
        }) as any;
        status = 'synced';
        if (res?.slOrderId !== undefined) this.pos.slOrderId = res.slOrderId || undefined;
        if (res?.tpOrderId !== undefined) this.pos.tpOrderId = res.tpOrderId || undefined;
      } catch {
        status = 'error';
      }
    }

    if (status === 'error') {
      this.protectiveErrorCount += 1;
      recordOpsEvent({
        level: 'warn',
        source: 'protective_sync',
        message: `Sync failure (${reason})`,
        sessionId: this.sessionId,
        symbol: this.profile.symbol,
        details: {
          stopLoss,
          takeProfit: takeProfitArr,
          slOrderId: this.pos.slOrderId,
          tpOrderId: this.pos.tpOrderId,
          consecutiveErrors: this.protectiveErrorCount,
        },
      });
      if (this.protectiveErrorCount >= 3) {
        await this.engageKillSwitch('protective_sync_failure', { consecutiveErrors: this.protectiveErrorCount });
      }
    } else if (status === 'synced') {
      this.protectiveErrorCount = 0;
    }

    // Persist latest protective snapshot regardless of live/paper mode outcome
    try {
      const statusTag = status === 'synced' ? `synced_${reason}` : status;
      await updateProtectiveSnapshot({
        sessionId: this.sessionId,
        symbol: this.profile.symbol,
        stopPrice: stopLoss,
        takeProfit: takeProfitArr,
        slOrderId: this.pos.slOrderId ?? null,
        tpOrderId: this.pos.tpOrderId ?? null,
        status: statusTag,
      });
    } catch {}
  }

  async manage(price: number, snap: { ema20: number; atr14: number }) {
    if (!this.pos || !this.plan || !this.profile) return;
    const dir = this.pos.side === 'buy' ? 1 : -1;
    const upR = (dir * (price - this.pos.entry)) / this.plan.stopDistance; // current R
    this.pos.mfeR = this.pos.mfeR != null ? Math.max(this.pos.mfeR, upR) : upR;
    this.pos.maeR = this.pos.maeR != null ? Math.min(this.pos.maeR, upR) : upR;

    const prevStop = this.pos.stop;

    // Stepwise + combo trailing
    if (upR > 0.5 && this.pos) {
      const be = this.pos.entry;
      let trailStep = this.pos.stop;
      if (upR > 1.0) trailStep = this.pos.side==='buy' ? Math.max(trailStep, be) : Math.min(trailStep, be);
      if (upR > 1.5) {
        const lock = this.pos.entry + (this.pos.side==='buy' ? 0.3 : -0.3) * this.plan.stopDistance;
        trailStep = this.pos.side==='buy' ? Math.max(trailStep, lock) : Math.min(trailStep, lock);
      }
      if (upR > 2.0) {
        const lock = this.pos.entry + (this.pos.side==='buy' ? 0.7 : -0.7) * this.plan.stopDistance;
        trailStep = this.pos.side==='buy' ? Math.max(trailStep, lock) : Math.min(trailStep, lock);
      }
      // ATR/EMA and optional percent trailing
      let candAtr: number;
      if (this.pos.side==='buy') candAtr = Math.min(snap.ema20, price - (this.plan.atr)); else candAtr = Math.max(snap.ema20, price + (this.plan.atr));
      let candPct = candAtr;
      try {
        const { TRAIL_PCT } = (await import('../utils/env.js')).getConfig();
        const pct = Math.max(0, Number(TRAIL_PCT || 0));
        if (pct > 0) candPct = this.pos.side==='buy' ? (price * (1 - pct/100)) : (price * (1 + pct/100));
      } catch {}
      const combo = this.pos.side==='buy' ? Math.max(trailStep, Math.max(candAtr, candPct)) : Math.min(trailStep, Math.min(candAtr, candPct));
      if (this.pos.side==='buy') this.pos.stop = Math.max(this.pos.stop, combo); else this.pos.stop = Math.min(this.pos.stop, combo);
    }

    if (this.pos) {
      const elapsedMs = Date.now() - this.pos.openedAt;
      const dynamic = this.computeDynamicTrail(price, snap as any, upR, elapsedMs);
      if (dynamic != null) {
        if (this.pos.side === 'buy') this.pos.stop = Math.max(this.pos.stop, dynamic);
        else this.pos.stop = Math.min(this.pos.stop, dynamic);
      }
    }

    const stopChanged = this.pos.stop !== prevStop;
    if (stopChanged) {
      this.noteTrail(this.pos.stop);
      await this.syncProtectiveOrders('trail');
    }

    // TP handling: partial at TP1, full at TP2 (if any), otherwise trailing/SL/time
    const firstTp = this.pos.tp[0];
    const secondTp = this.pos.tp[1];
    const tp1Hit = this.pos.side === 'buy' ? price >= firstTp : price <= firstTp;
    const tp2Hit = secondTp != null ? (this.pos.side === 'buy' ? price >= secondTp : price <= secondTp) : false;
    const stopHit = this.pos.side === 'buy' ? price <= this.pos.stop : price >= this.pos.stop;

    let maxHoldMs = (this.plan.plan.risk.max_hold_hours || 36) * 3600 * 1000;
    const age = Date.now() - this.pos.openedAt;

    // Extension rule: once, near end of max_hold, extend by +12–24h if strong trend and PnL>0
    // Conditions: ADX>20 and EMA20 slope aligned with direction, no blocking anomalies
    const nearEnd = age > 0.9 * maxHoldMs;
    const strongTrend = (snap as any).adx14 ? (snap as any).adx14 > 20 : true;
    const slopeOk = this.pos.side === 'buy' ? ((snap as any).ema20Slope ?? 0) > 0 : ((snap as any).ema20Slope ?? 0) < 0;
    if (!this.extendedOnce && nearEnd && upR > 0 && strongTrend && slopeOk) {
      this.extendedOnce = true;
      maxHoldMs += 12 * 3600 * 1000; // extend by +12h
      // tighten trailing to ATR*0.8
      const trailCandidate = this.pos.side === 'buy' ? (price - (this.plan.atr * 0.8)) : (price + (this.plan.atr * 0.8));
      if (this.pos.side === 'buy') this.pos.stop = Math.max(this.pos.stop, trailCandidate);
      else this.pos.stop = Math.min(this.pos.stop, trailCandidate);
      this.noteTrail(this.pos.stop);
    }

    // Partial: on TP1 if not already taken
    if (tp1Hit && !this.pos.partialTaken) {
      try {
        const closeQty = Math.max(0, Math.min(this.pos.qty, Number((this.pos.qty * 0.5).toFixed(8))));
        if (closeQty > 0 && this.broker) {
          const closeSide = this.pos.side === 'buy' ? 'sell' : 'buy';
          const startedAt = Date.now();
          const placed = await this.broker.place({
            symbol: this.profile.symbol,
            side: closeSide,
            type: 'market',
            qty: closeQty,
            leverage: this.profile.maxLeverage,
            reduceOnly: true,
          });
          const telemetry = this.computeTelemetry(startedAt, placed, { expectedPrice: price, requestedQty: closeQty, side: closeSide });
          const rawFilled = (placed && typeof placed.filledQty === 'number') ? placed.filledQty : undefined;
          const filledQty = rawFilled != null && rawFilled > 0 ? rawFilled : (placed.status !== 'rejected' ? closeQty : 0);
          if (placed.status !== 'rejected' && filledQty > 0) {
            await recordExit({
              sessionId: this.sessionId!,
              symbol: this.profile.symbol,
              side: this.pos.side,
              exitPrice: price,
              qty: filledQty,
              realizedPnl: (dir * (price - this.pos.entry) * filledQty),
              requestedQty: closeQty,
              latencyMs: telemetry.latencyMs,
              slippageBps: telemetry.slippageBps,
              fillRatio: telemetry.fillRatio,
              cancelCount: telemetry.cancelCount,
              attempts: telemetry.attempts,
            }).catch(()=>{});
            // Reduce local pos.qty based on actual fill and mark partial
            this.pos.qty = Math.max(0, this.pos.qty - filledQty);
            this.pos.partialTaken = true;
            this.pos.partialInfo = { ts: Date.now(), price };
            // Tighten stop to break-even after partial
            const be = this.pos.entry;
            if (this.pos.side === 'buy') this.pos.stop = Math.max(this.pos.stop, be);
            else this.pos.stop = Math.min(this.pos.stop, be);
            this.pos.breakeven = be;
            this.noteTrail(this.pos.stop);
            // Shift TP ladder to next target if any
            if (this.pos.tp.length > 1) this.pos.tp = this.pos.tp.slice(1);
            await this.syncProtectiveOrders('partial');
            broadcast('agent_state', { state: this.state, pos: this.pos }, this.profile.symbol, this.sessionId || undefined);
          }
        }
      } catch {}
      return; // wait next tick after partial
    }

    // Breakout invalidation: if price moves beyond the original zone against the position with hysteresis for N ticks
    try {
      const { BREAKOUT_HYSTERESIS_PCT, BREAKOUT_CONFIRM_TICKS, REVERSE_ON_BREAKOUT } = (await import('../utils/env.js')).getConfig();
      const from = Math.min(this.plan.zone.from, this.plan.zone.to);
      const to = Math.max(this.plan.zone.from, this.plan.zone.to);
      const above = price > to * (1 + (BREAKOUT_HYSTERESIS_PCT/100));
      const below = price < from * (1 - (BREAKOUT_HYSTERESIS_PCT/100));
      const invalidShort = (this.pos.side === 'sell') && above;
      const invalidLong = (this.pos.side === 'buy') && below;
      const invalid = invalidShort || invalidLong;
      if (invalid) this.breakoutTicks += 1; else this.breakoutTicks = 0;
      if (invalid && this.breakoutTicks >= Math.max(1, BREAKOUT_CONFIRM_TICKS)) {
        // Exit immediately on confirmed breakout
        await this.exit(price, 'sl');
        // Optional immediate reversal
        if (REVERSE_ON_BREAKOUT && this.state === 'SCAN' && this.profile && this.broker) {
          const side: 'buy'|'sell' = (invalidShort ? 'buy' : 'sell');
          try {
            await this.enterWithSide(price, side);
          } catch {}
        }
        return;
      }
    } catch {}

    // Full exit on TP2 (if defined) or on stop/time
    const tpHitFinal = tp2Hit || (tp1Hit && this.pos.partialTaken && this.pos.tp.length === 1);
    if (tpHitFinal || stopHit || age > maxHoldMs) {
      await this.exit(price, tpHitFinal ? 'tp' : (stopHit ? 'sl' : 'time'));
      return;
    }
  }

  // Force close current position at market using latest price snapshot
  async closeNow() {
    if (!this.profile || !this.broker || !this.pos) return;
    try {
      const snap = await buildTechSnapshot(this.profile.symbol);
      await this.exit(snap.last, 'time');
    } catch {}
  }

  async exit(price: number, reason: 'tp'|'sl'|'time', opts?: { suppressRearm?: boolean }) {
    if (!this.pos || !this.broker || !this.profile) return;
    const dir = this.pos.side === 'buy' ? 1 : -1;
    const pnl = dir * (price - this.pos.entry) * this.pos.qty;
    const bal = await this.broker.balance();
    const startEquity = bal.equityUsd;
    // For the simple paper broker, we simulate balance update via fees only; here we track pct for guards
    const pnlPct = (pnl / Math.max(1, startEquity)) * 100;
    this.realizedPnlTodayPct += pnlPct;
    this.consecutiveStops = reason === 'sl' ? (this.consecutiveStops + 1) : 0;
    // Cancel protective orders before exiting to avoid stray reduce-only orders on the exchange
    try {
      if (this.pos.slOrderId) await this.broker.cancel(this.pos.slOrderId).catch(()=>{});
      if (this.pos.tpOrderId) await this.broker.cancel(this.pos.tpOrderId).catch(()=>{});
    } catch {}
    this.pos.slOrderId = undefined;
    this.pos.tpOrderId = undefined;
    // Place actual closing order (market) with opposite side
    const exitSide = this.pos.side === 'buy' ? 'sell' : 'buy';
    const requestQty = this.pos.qty;
    let placed: any;
    const startedAt = Date.now();
    try {
      // In paper mode, free up committed capacity first to avoid margin check on the close
      try { (this.broker as any).releaseCommitted?.(Math.abs(price * requestQty)); } catch {}
      placed = await this.broker.place({
        symbol: this.profile.symbol,
        side: exitSide,
        type: 'market',
        qty: requestQty,
        leverage: this.profile.maxLeverage,
        reduceOnly: true,
      });
    } catch {
      placed = null;
    }

    const telemetry = placed ? this.computeTelemetry(startedAt, placed, { expectedPrice: price, requestedQty: requestQty, side: exitSide }) : null;
    const filledQty = placed && typeof placed.filledQty === 'number' && placed.filledQty > 0 ? placed.filledQty : requestQty;

    await recordExit({
      sessionId: this.sessionId!,
      symbol: this.profile.symbol,
      side: this.pos.side,
      exitPrice: price,
      qty: filledQty,
      realizedPnl: pnl,
      requestedQty: requestQty,
      latencyMs: telemetry?.latencyMs,
      slippageBps: telemetry?.slippageBps,
      fillRatio: telemetry?.fillRatio,
      cancelCount: telemetry?.cancelCount,
      attempts: telemetry?.attempts,
    }).catch(()=>{});
    // Update session KPIs (ROI%, realized/unrealized)
    try { if (this.sessionId) await recomputeKpi(this.sessionId); } catch {}
    // Release reserved notional capacity in paper broker
    try { (this.broker as any).releaseCommitted?.(Math.abs(price * requestQty)); } catch {}
    this.state = 'EXIT';
    broadcast('agent_state', { state: this.state, exit: { price, reason, pnl, pnlPct, ts: Date.now() }, aiCalls: await getAICallsCount(this.sessionId || undefined) }, this.profile.symbol, this.sessionId || undefined);
    try {
      if (this.sessionId && this.profile) {
        await updateProtectiveSnapshot({
          sessionId: this.sessionId,
          symbol: this.profile.symbol,
          stopPrice: null,
          takeProfit: null,
          slOrderId: null,
          tpOrderId: null,
          status: 'closed',
        });
      }
    } catch {}
    this.pos = null;
    this.state = 'REPORT';
    broadcast('agent_state', { state: this.state, aiCalls: await getAICallsCount(this.sessionId || undefined) }, this.profile.symbol, this.sessionId || undefined);
    // back to SCAN unless guardrails trip
    const guard = await assessRisk({ sessionId: 'n/a', dateKey: new Date().toISOString().slice(0,10), realizedPnlPctToday: this.realizedPnlTodayPct, consecutiveStops: this.consecutiveStops, tradesToday: this.tradesToday });
    if (!guard.ok && guard.action === 'halt') {
      await this.engageKillSwitch(guard.reason || 'risk_guard', { guard });
      return;
    }
    // After removal of entry limiting logic, still respect catastrophic halt, otherwise go to SCAN
    this.state = guard.ok ? 'SCAN' : (guard.action === 'halt' ? 'HALT' : 'SCAN');
    broadcast('agent_state', { state: this.state, aiCalls: await getAICallsCount(this.sessionId || undefined) }, this.profile.symbol, this.sessionId || undefined);

    if (!opts?.suppressRearm) {
      // Immediately request a fresh strategy after an exit (force to bypass cool-down)
      try {
        await requestStrategy({ symbol: this.profile.symbol, trigger: 'position-exit', sessionId: this.sessionId || undefined, priceHint: price, force: true });
      } catch {}

      // Auto-propose and arm a new plan once back to SCAN
      try {
        if (this.state === 'SCAN' && this.profile) {
          const plan = await this.buildPlan();
          await this.propose(plan as any);
          await this.validateAndArm();
        }
      } catch {}
    }
  }

  private async engageKillSwitch(reason: string, details?: any) {
    if (this.state === 'HALT') return;
    this.killSwitchContext = { reason, details };
    if (this.pos && this.profile) {
      try {
        const snap = await buildTechSnapshot(this.profile.symbol);
        await this.exit(snap.last, 'sl', { suppressRearm: true });
      } catch {}
    }
    this.state = 'HALT';
    this.haltAckRequired = true;
    try {
      recordOpsEvent({ level: 'error', source: 'kill_switch', message: reason, sessionId: this.sessionId || undefined, symbol: this.profile?.symbol, details: { ...(details || {}), mode: this.profile?.mode } });
    } catch {}
    await logImprovementAuto({
      title: `Kill switch triggered: ${reason}`,
      description: `Agent halted on symbol ${this.profile?.symbol || 'unknown'} due to ${reason}.`,
      severity: 'high',
      tags: ['risk', 'halt'],
      context: {
        sessionId: this.sessionId,
        symbol: this.profile?.symbol,
        mode: this.profile?.mode,
        details,
      },
    });
    broadcast('agent_state', { state: this.state, killSwitch: reason }, this.profile?.symbol, this.sessionId || undefined);
    this.scheduleRecovery(reason, details);
  }

  halt() { this.state = 'HALT'; }

  private async buildPlan(opts?: { fresh?: boolean; bypassAck?: boolean }) {
    if (this.haltAckRequired && !opts?.bypassAck) {
      throw new Error('halt_ack_required');
    }
    if (!this.profile) throw new Error('no profile');
    const plan = await proposePlan(this.profile.symbol, {
      sessionId: this.sessionId || undefined,
      fresh: opts?.fresh,
      context: this.killSwitchContext ? { killReason: this.killSwitchContext.reason, killDetails: this.killSwitchContext.details } : undefined,
    });
    this.killSwitchContext = null;
    const syncRiskRange = () => {
      const pos: any = plan.position;
      const base = typeof pos.risk_fraction === 'number' ? pos.risk_fraction : 0.015;
      const minDefault = Math.max(0.005, base * 0.8);
      const maxDefault = Math.min(0.03, base * 1.2);
      let min = minDefault;
      let max = maxDefault;
      let recommended = base;
      if (pos.risk_fraction_range) {
        const range = pos.risk_fraction_range;
        if (typeof range.min === 'number') min = Math.max(0.005, Math.min(range.min, 0.03));
        if (typeof range.max === 'number') max = Math.max(min + 0.001, Math.min(range.max, 0.03));
        if (typeof range.recommended === 'number') recommended = range.recommended;
      }
      min = Math.min(min, max);
      max = Math.max(max, min + 0.001);
      recommended = Math.min(max, Math.max(min, recommended));
      pos.risk_fraction_range = { min, max, recommended };
      pos.risk_fraction = recommended;
    };
    syncRiskRange();
    if (plan.bias !== 'none') {
      try {
        const mod = await import('../sim/quicktest.js');
        const runQuickTest = mod?.runQuickTest;
        if (typeof runQuickTest === 'function') {
          const sim = await runQuickTest(this.profile.symbol, 72, plan as any, {
            tf: '15m',
            trailingATRmult: 1.0,
            exitPolicy: plan.risk?.max_hold_hours && plan.risk.max_hold_hours > 36 ? 'trend' : 'time',
            maxHoldHours: plan.risk?.max_hold_hours || 36,
            feesBps: this.profile.mode === 'live' ? 8 : 0,
            slippagePct: this.profile.mode === 'live' ? 0.02 : 0,
          });
          const stats = sim?.stats;
          if (stats) {
            const meta:any = plan.meta || {};
            meta.quickTest = {
              winrate: stats.winrate,
              avgR: stats.avgR,
              count: stats.count,
              avgMAE_R: stats.avgMAE_R,
              avgMFE_R: stats.avgMFE_R,
            };
            plan.meta = meta;
            if (stats.count >= 8 && (stats.winrate < 30 || stats.avgR < 0)) {
              const original = plan.position.risk_fraction;
              plan.position.risk_fraction = Math.max(0.01, Math.min(0.02, original * 0.7));
              const note = 'QuickTest indicated weak edge (winrate ' + stats.winrate.toFixed(1) + '%, avgR ' + stats.avgR.toFixed(2) + '). Risk fraction trimmed.';
              plan.notes = plan.notes ? `${plan.notes}\n${note}` : note;
              syncRiskRange();
            }
          }
        }
      } catch (err) {
        try {
          await logImprovementAuto({
            title: 'QuickTest failed during plan build',
            description: `Unable to evaluate plan for ${this.profile.symbol}.`,
            severity: 'medium',
            tags: ['plan', 'simulation'],
            context: { error: String((err as any)?.message || err), symbol: this.profile.symbol },
          });
        } catch {}
      }
    }
    return plan;
  }

  async nextPlan(opts?: { fresh?: boolean }): Promise<PlanJson> {
    return this.buildPlan(opts);
  }

  acknowledgeHalt() {
    this.haltAckRequired = false;
    if (this.recoveryTimer) { try { clearTimeout(this.recoveryTimer); } catch {} this.recoveryTimer = null; }
  }

  private scheduleRecovery(reason: string, details?: any) {
    if (this.recoveryTimer) { try { clearTimeout(this.recoveryTimer); } catch {} }
    const delay = Number(process.env.HALT_RECOVERY_DELAY_MS || 5 * 60 * 1000);
    if (!this.profile) return;
    const symbol = this.profile.symbol;
    const sessionId = this.sessionId;
    this.recoveryTimer = setTimeout(async () => {
      try {
        const plan = await proposePlan(symbol, { fresh: true, sessionId: sessionId || undefined, context: { killReason: reason, killDetails: details } });
        await logImprovementAuto({
          title: `Post-mortem plan generated (${reason})`,
          description: `Recovery plan bias=${plan.bias}, risk=${(plan.position.risk_fraction * 100).toFixed(2)}%.`,
          severity: 'medium',
          tags: ['halt', 'recovery'],
          context: { sessionId, symbol, mode: this.profile?.mode, plan },
        });
      } catch (err) {
        await logImprovementAuto({
          title: 'Post-mortem plan generation failed',
          description: `Unable to generate recovery plan for ${symbol}.`,
          severity: 'medium',
          tags: ['halt', 'recovery'],
          context: { sessionId, symbol, mode: this.profile?.mode, error: String((err as any)?.message || err) },
        });
      }
    }, Math.max(60_000, delay));
  }

  // Internal helper: place an entry with an explicit side at a given market price (used for breakout reversal)
  private async enterWithSide(mktPrice: number, side: 'buy'|'sell') {
    if (!this.broker || !this.plan || !this.profile) return;
    if (this.pos || this.entering) return;
    this.entering = true;
    const bal = await this.broker.balance();
    const entry = mktPrice;
    const round4 = (n:number)=> Math.round(n*1e4)/1e4;
    const stopRaw = side === 'buy' ? entry - this.plan.stopDistance : entry + this.plan.stopDistance;
    const stop = round4(stopRaw);
    const dir = side === 'buy' ? 1 : -1;
    const tp = this.plan.rPrices.map(x => round4(entry + dir * x.r * this.plan!.stopDistance));
    const budgetFrac = Math.max(0.1, Math.min(1, this.profile.budgetFraction ?? 1));
    const usableBalance = Math.max(0, Math.min(bal.freeUsd, bal.freeUsd * budgetFrac));
    const { computeQtyNotional } = await import('../risk/manager.js');
    const notional = computeQtyNotional({ balanceUsd: usableBalance, riskPct: this.profile.riskPerTradePct, stopDistanceAbs: Math.abs(entry - stop), entryPrice: entry, maxLev: this.profile.maxLeverage });
    const qty = notional / entry;
    const placed = await this.broker.place({ symbol: this.profile.symbol, side, type: 'market', qty, leverage: this.profile.maxLeverage, takeProfit: tp[0], stopLoss: stop });
    if (placed.status === 'rejected') {
      this.state = 'COOLDOWN';
      this.entering = false;
      return;
    }
    const now = Date.now();
    this.pos = { side, entry: placed.avgPrice!, qty: placed.filledQty!, stop, tp, openedAt: now, extended: false, trail: [{ ts: now, price: stop }], maeR: 0, mfeR: 0, breakeven: placed.avgPrice!, partialInfo: null };
    await (await import('./persistence.js')).recordEnter({ sessionId: this.sessionId!, symbol: this.profile.symbol, side, qty: this.pos.qty, entryPrice: this.pos.entry, stop: this.pos.stop, tp: this.pos.tp, leverage: this.profile.maxLeverage }).catch(()=>{});
    this.state = 'MANAGE';
    this.tradesToday += 1;
    await (await import('../ws/hub.js')).broadcast('agent_state', { state: this.state, pos: this.pos, aiCalls: await (await import('../metrics/aiCalls.js')).getAICallsCount(this.sessionId || undefined) }, this.profile.symbol, this.sessionId || undefined);
    this.entering = false;
  }
}

// Singleton agent instance to be used by routes/engine
export const Agent = new ReboundRejectionAgent();
