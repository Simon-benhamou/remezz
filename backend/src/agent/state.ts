import { PlanJson } from './planSchema.js';
import { validatePlan, ValidatedPlan } from './validator.js';
import { PaperBroker } from '../broker/paper.js';
import { LiveBroker } from '../broker/live.js';
import { Broker } from '../broker/types.js';
import { assessRisk, computeQtyNotional, defaultLimits } from '../risk/manager.js';
import { buildTechSnapshot } from '../ai/tech.js';
import { broadcast } from '../ws/hub.js';
import { recordEnter, recordExit } from './persistence.js';

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
};

export type ActivePosition = {
  side: 'buy'|'sell';
  entry: number;
  qty: number;
  stop: number;
  tp: number[];
  openedAt: number;
  extended: boolean;
};

export class ReboundRejectionAgent {
  state: AgentState = 'IDLE';
  profile: ActivationProfile | null = null;
  plan: ValidatedPlan | null = null;
  broker: Broker | null = null;
  pos: ActivePosition | null = null;
  extendedOnce = false;

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
    broadcast('agent_state', { state: this.state, plan: this.plan }, this.profile.symbol);
  }

  // On new candles/ticks, check trigger and possibly enter
  async onTick() {
    if (!this.profile || !this.plan) return;
    if (this.state !== 'ARMED' && this.state !== 'MANAGE') return;
    const snap = await buildTechSnapshot(this.profile.symbol);
    const price = snap.last;
    const { from, to, mid } = this.plan.zone;

    if (this.state === 'ARMED') {
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
    const bal = await this.broker.balance();
    const side = this.plan.bias === 'long' ? 'buy' : 'sell';
    const entry = mktPrice;
    const stop = this.plan.bias === 'long' ? entry - this.plan.stopDistance : entry + this.plan.stopDistance;
    const tp = this.plan.rPrices.map(x => x.price);
    const notional = computeQtyNotional({ balanceUsd: bal.equityUsd, riskPct: this.profile.riskPerTradePct, stopDistanceAbs: Math.abs(entry - stop), entryPrice: entry, maxLev: this.profile.maxLeverage });
    const qty = notional / entry;
    const placed = await this.broker.place({ symbol: this.profile.symbol, side, type: 'market', qty, takeProfit: tp[0], stopLoss: stop });
    this.pos = { side, entry: placed.avgPrice!, qty: placed.filledQty!, stop, tp, openedAt: Date.now(), extended: false };
    // Persist order/fill/position
    await recordEnter({ symbol: this.profile.symbol, side, qty: this.pos.qty, entryPrice: this.pos.entry, stop: this.pos.stop, tp: this.pos.tp, leverage: this.profile.maxLeverage }).catch(()=>{});
    this.state = 'MANAGE';
    this.tradesToday += 1;
    broadcast('agent_state', { state: this.state, pos: this.pos }, this.profile.symbol);
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

    // TP hit
    const firstTp = this.pos.tp[0];
    const tpHit = this.pos.side === 'buy' ? price >= firstTp : price <= firstTp;
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

    if (tpHit || stopHit || age > maxHoldMs) {
      await this.exit(price, tpHit ? 'tp' : (stopHit ? 'sl' : 'time'));
      return;
    }
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
    await recordExit({ symbol: this.profile.symbol, side: this.pos.side, exitPrice: price, qty: this.pos.qty, realizedPnl: pnl }).catch(()=>{});
    this.state = 'EXIT';
    broadcast('agent_state', { state: this.state, exit: { price, reason, pnl, pnlPct } }, this.profile.symbol);
    this.pos = null;
    this.state = 'REPORT';
    broadcast('agent_state', { state: this.state }, this.profile.symbol);
    // back to SCAN unless guardrails trip
    const guard = await assessRisk({ sessionId: 'n/a', dateKey: new Date().toISOString().slice(0,10), realizedPnlPctToday: this.realizedPnlTodayPct, consecutiveStops: this.consecutiveStops, tradesToday: this.tradesToday });
    this.state = guard.ok ? 'SCAN' : (guard.action === 'halt' ? 'HALT' : 'COOLDOWN');
    broadcast('agent_state', { state: this.state }, this.profile.symbol);
  }

  halt() { this.state = 'HALT'; }
}

// Singleton agent instance to be used by routes/engine
export const Agent = new ReboundRejectionAgent();
