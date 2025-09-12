import { PlanJson } from './planSchema.js';
import { validatePlan, ValidatedPlan } from './validator.js';
import { PaperBroker } from '../broker/paper.js';
import { LiveBroker, inspectExposure } from '../broker/live.js';
import { Broker } from '../broker/types.js';
import { assessRisk, computeQtyNotional, defaultLimits } from '../risk/manager.js';
import { buildTechSnapshot } from '../ai/tech.js';
import { broadcast } from '../ws/hub.js';
import { recordEnter, recordExit } from './persistence.js';
import { recomputeKpi } from '../metrics/kpi.js';
import { getAICallsCount } from '../metrics/aiCalls.js';
import { requestStrategy } from '../ai/strategyManager.js';

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
    // If a position already exists, don't re-arm — keep managing
    if (this.pos) {
      this.state = 'MANAGE';
      broadcast('agent_state', { state: this.state, pos: this.pos }, this.profile.symbol, this.sessionId || undefined);
      return;
    }
    const limits = defaultLimits();
    const decision = await assessRisk({
      sessionId: 'n/a', dateKey: new Date().toISOString().slice(0,10),
      realizedPnlPctToday: this.realizedPnlTodayPct,
      consecutiveStops: this.consecutiveStops,
      tradesToday: this.tradesToday,
    }, limits);
    if (!decision.ok) {
      this.state = decision.action === 'halt' ? 'HALT' : 'COOLDOWN';
      return;
    }
    if (!this.plan.guards.spreadOk || !this.plan.guards.leverageOk) {
      this.state = 'COOLDOWN';
      return;
    }
    this.state = 'ARMED';
    const aiCalls = await getAICallsCount();
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
          this.pos = { side, entry, qty: expo.qty, stop, tp, openedAt: Date.now(), extended: false };
          this.state = 'MANAGE';
          broadcast('agent_state', { state: this.state, pos: this.pos }, this.profile.symbol, this.sessionId || undefined);
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
    const tp = this.plan.rPrices.map(x => round4(x.price));
    const budgetFrac = Math.max(0.1, Math.min(1, this.profile.budgetFraction ?? 1));
    const usableBalance = Math.max(0, Math.min(bal.freeUsd, bal.freeUsd * budgetFrac));
    const notional = computeQtyNotional({ balanceUsd: usableBalance, riskPct: this.profile.riskPerTradePct, stopDistanceAbs: Math.abs(entry - stop), entryPrice: entry, maxLev: this.profile.maxLeverage });
    const qty = notional / entry;
    const placed = await this.broker.place({ symbol: this.profile.symbol, side, type: 'market', qty, leverage: this.profile.maxLeverage, takeProfit: tp[0], stopLoss: stop });
    if (placed.status === 'rejected') {
      // Not enough margin/free capacity — go to cooldown briefly
      this.state = 'COOLDOWN';
      broadcast('agent_state', { state: this.state, reason: 'placement_rejected' }, this.profile.symbol, this.sessionId || undefined);
      this.entering = false;
      return;
    }
    this.pos = { side, entry: placed.avgPrice!, qty: placed.filledQty!, stop, tp, openedAt: Date.now(), extended: false };
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
    await recordEnter({ sessionId: this.sessionId!, symbol: this.profile.symbol, side, qty: this.pos.qty, entryPrice: this.pos.entry, stop: this.pos.stop, tp: this.pos.tp, leverage: this.profile.maxLeverage }).catch(()=>{});
    this.state = 'MANAGE';
    this.tradesToday += 1;
    broadcast('agent_state', { state: this.state, pos: this.pos, aiCalls: await getAICallsCount() }, this.profile.symbol, this.sessionId || undefined);
    this.entering = false;
  }

  async manage(price: number, snap: { ema20: number; atr14: number }) {
    if (!this.pos || !this.plan || !this.profile) return;
    const dir = this.pos.side === 'buy' ? 1 : -1;
    const upR = (dir * (price - this.pos.entry)) / this.plan.stopDistance; // current R

    // Trailing if > 1R: min(EMA20, price – 1*ATR)
    if (upR > 1) {
      const trailCandidate = Math.min(snap.ema20, price - (this.plan.atr));
      if (this.pos.side === 'buy') this.pos.stop = Math.max(this.pos.stop, trailCandidate);
      else this.pos.stop = Math.min(this.pos.stop, trailCandidate);
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
    }

    // Partial: on TP1 if not already taken
    if (tp1Hit && !this.pos.partialTaken) {
      try {
        const closeQty = Math.max(0, Math.min(this.pos.qty, Number((this.pos.qty * 0.5).toFixed(8))));
        if (closeQty > 0 && this.broker) {
          // Place market close for partial
          await this.broker.place({ symbol: this.profile.symbol, side: this.pos.side === 'buy' ? 'sell' : 'buy', type: 'market', qty: closeQty, leverage: this.profile.maxLeverage });
          await recordExit({ sessionId: this.sessionId!, symbol: this.profile.symbol, side: this.pos.side, exitPrice: price, qty: closeQty, realizedPnl: (dir * (price - this.pos.entry) * closeQty) }).catch(()=>{});
          // Reduce local pos.qty and mark partial
          this.pos.qty = Math.max(0, this.pos.qty - closeQty);
          this.pos.partialTaken = true;
          // Tighten stop to break-even after partial
          const be = this.pos.entry;
          if (this.pos.side === 'buy') this.pos.stop = Math.max(this.pos.stop, be);
          else this.pos.stop = Math.min(this.pos.stop, be);
          // Shift TP ladder to next target if any
          if (this.pos.tp.length > 1) this.pos.tp = this.pos.tp.slice(1);
          broadcast('agent_state', { state: this.state, pos: this.pos }, this.profile.symbol, this.sessionId || undefined);
        }
      } catch {}
      return; // wait next tick after partial
    }

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
    try {
      // In paper mode, free up committed capacity first to avoid margin check on the close
      try { (this.broker as any).releaseCommitted?.(Math.abs(price * this.pos.qty)); } catch {}
      await this.broker.place({
        symbol: this.profile.symbol,
        side: this.pos.side === 'buy' ? 'sell' : 'buy',
        type: 'market',
        qty: this.pos.qty,
        leverage: this.profile.maxLeverage,
      });
    } catch {}

    await recordExit({ sessionId: this.sessionId!, symbol: this.profile.symbol, side: this.pos.side, exitPrice: price, qty: this.pos.qty, realizedPnl: pnl }).catch(()=>{});
    // Update session KPIs (ROI%, realized/unrealized)
    try { if (this.sessionId) await recomputeKpi(this.sessionId); } catch {}
    // Release reserved notional capacity in paper broker
    try { (this.broker as any).releaseCommitted?.(Math.abs(price * this.pos.qty)); } catch {}
    this.state = 'EXIT';
    broadcast('agent_state', { state: this.state, exit: { price, reason, pnl, pnlPct, ts: Date.now() }, aiCalls: await getAICallsCount() }, this.profile.symbol, this.sessionId || undefined);
    this.pos = null;
    this.state = 'REPORT';
    broadcast('agent_state', { state: this.state, aiCalls: await getAICallsCount() }, this.profile.symbol, this.sessionId || undefined);
    // back to SCAN unless guardrails trip
    const guard = await assessRisk({ sessionId: 'n/a', dateKey: new Date().toISOString().slice(0,10), realizedPnlPctToday: this.realizedPnlTodayPct, consecutiveStops: this.consecutiveStops, tradesToday: this.tradesToday });
    this.state = guard.ok ? 'SCAN' : (guard.action === 'halt' ? 'HALT' : 'COOLDOWN');
    broadcast('agent_state', { state: this.state, aiCalls: await getAICallsCount() }, this.profile.symbol, this.sessionId || undefined);

    // Immediately request a fresh strategy after an exit (force to bypass cool-down)
    try {
      await requestStrategy({ symbol: this.profile.symbol, trigger: 'position-exit', sessionId: this.sessionId || undefined, priceHint: price, force: true });
    } catch {}
  }

  halt() { this.state = 'HALT'; }
}

// Singleton agent instance to be used by routes/engine
export const Agent = new ReboundRejectionAgent();
