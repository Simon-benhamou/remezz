import { PlanJson } from './planSchema.js';
import { validatePlan, ValidatedPlan } from './validator.js';
import { PaperBroker } from '../broker/paper.js';
import { LiveBroker, inspectExposure } from '../broker/live.js';
import { Broker } from '../broker/types.js';
import { assessRisk, computeQtyNotional, defaultLimits } from '../risk/manager.js';
import { buildTechSnapshot } from '../ai/tech.js';
import { broadcast } from '../ws/hub.js';
import { recordEnter, recordExit, updateProtectiveSnapshot, loadActivePosition } from './persistence.js';
import { recomputeKpi } from '../metrics/kpi.js';
import { getConfig } from '../utils/env.js';
import { getAICallsCount } from '../metrics/aiCalls.js';
import { requestStrategy } from '../ai/strategyManager.js';
import { proposePlan } from '../ai/planOrchestrator.js';
import { recordOpsEvent } from '../monitor/ops.js';

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

  // simplistic counters for risk
  consecutiveStops = 0;
  tradesToday = 0;
  realizedPnlTodayPct = 0;

  async activate(profile: ActivationProfile) {
    // PREFLIGHT
    this.state = 'PREFLIGHT';
    this.profile = profile;
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
    this.state = 'VALIDATE';
  }

  async validateAndArm() {
    if (!this.profile || !this.plan) throw new Error('no plan');
    await this.restorePersistedPosition();
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
    broadcast('agent_state', { state: this.state, plan: this.plan, aiCalls }, this.profile.symbol, this.sessionId || undefined);

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
    const price = snap.last;
    const { from, to, mid } = this.plan.zone;

    if (this.state === 'ARMED') {
      // Safety: if a position is somehow set, switch to MANAGE
      if (this.pos) { this.state = 'MANAGE'; broadcast('agent_state', { state: this.state, pos: this.pos }, this.profile.symbol, this.sessionId || undefined); return; }
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
      // simple confirmation: bias-aligned close beyond zone mid
      const confirm = this.plan.plan.entry_rule.confirm_close && ((this.plan.bias === 'long' && price > mid) || (this.plan.bias === 'short' && price < mid));
      if (inZone && confirm) await this.enter(price);
    } else if (this.state === 'MANAGE') {
      await this.manage(price, snap);
    }
  }

  async enter(mktPrice: number) {
    if (!this.broker || !this.plan || !this.profile) return;
    // Prevent duplicate entries
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
    const usableBalance = Math.max(0, Math.min(bal.freeUsd, bal.freeUsd * budgetFrac));
    const notional = computeQtyNotional({ balanceUsd: usableBalance, riskPct: this.profile.riskPerTradePct, stopDistanceAbs: Math.abs(entry - stop), entryPrice: entry, maxLev: this.profile.maxLeverage });
    const qty = notional / entry;
    const startTs = Date.now();
    const placed = await this.broker.place({ symbol: this.profile.symbol, side, type: 'market', qty, leverage: this.profile.maxLeverage, takeProfit: tp[0], stopLoss: stop });
    if (placed.status === 'rejected') {
      // Not enough margin/free capacity — go to cooldown briefly
      this.state = 'COOLDOWN';
      broadcast('agent_state', { state: this.state, reason: 'placement_rejected' }, this.profile.symbol, this.sessionId || undefined);
      this.entering = false;
      return;
    }
    const telemetry = this.computeTelemetry(startTs, placed, { expectedPrice: entry, requestedQty: qty, side });
    const now = Date.now();
    this.pos = {
      side,
      entry: placed.avgPrice!,
      qty: placed.filledQty!,
      stop,
      tp,
      openedAt: now,
      extended: false,
      slOrderId: (placed as any).slOrderId,
      tpOrderId: (placed as any).tpOrderId,
      trail: [{ ts: now, price: stop }],
      maeR: 0,
      mfeR: 0,
      breakeven: placed.avgPrice!,
      partialInfo: null,
    };
    // Ensure at least two TP levels (for partial then runner)
    if (!Array.isArray(this.pos.tp) || this.pos.tp.length === 0) {
      const baseTp = side === 'buy' ? (this.pos.entry + (this.plan.stopDistance * 2)) : (this.pos.entry - (this.plan.stopDistance * 2));
      this.pos.tp = [baseTp];
    }
    if (this.pos.tp.length === 1) {
      const runnerTp = side === 'buy' ? (this.pos.entry + (this.plan.stopDistance * 3)) : (this.pos.entry - (this.plan.stopDistance * 3));
      this.pos.tp.push(runnerTp);
    }
    // Persist order/fill/position
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
    broadcast('agent_state', { state: this.state, pos: this.pos, aiCalls: await getAICallsCount(this.sessionId || undefined) }, this.profile.symbol, this.sessionId || undefined);
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
        },
      });
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

  async exit(price: number, reason: 'tp'|'sl'|'time') {
    if (!this.pos || !this.broker || !this.profile) return;
    const dir = this.pos.side === 'buy' ? 1 : -1;
    const pnl = dir * (price - this.pos.entry) * this.pos.qty;
    const bal = await this.broker.balance();
    const startEquity = bal.equityUsd;
    // For the simple paper broker, we simulate balance update via fees only; here we track pct for guards
    const pnlPct = (pnl / Math.max(1, startEquity)) * 100;
    this.realizedPnlTodayPct += pnlPct;
    this.consecutiveStops = reason === 'sl' ? (this.consecutiveStops + 1) : 0;
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
  // After removal of entry limiting logic, still respect catastrophic halt, otherwise go to SCAN
  this.state = guard.ok ? 'SCAN' : (guard.action === 'halt' ? 'HALT' : 'SCAN');
    broadcast('agent_state', { state: this.state, aiCalls: await getAICallsCount(this.sessionId || undefined) }, this.profile.symbol, this.sessionId || undefined);

    // Immediately request a fresh strategy after an exit (force to bypass cool-down)
    try {
      await requestStrategy({ symbol: this.profile.symbol, trigger: 'position-exit', sessionId: this.sessionId || undefined, priceHint: price, force: true });
    } catch {}

    // Auto-propose and arm a new plan once back to SCAN
    try {
      if (this.state === 'SCAN' && this.profile) {
        const plan = await proposePlan(this.profile.symbol, { sessionId: this.sessionId || undefined });
        await this.propose(plan as any);
        await this.validateAndArm();
      }
    } catch {}
  }

  halt() { this.state = 'HALT'; }

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
