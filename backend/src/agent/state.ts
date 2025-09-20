import { PlanJson } from './planSchema.js';
import { validatePlan, ValidatedPlan } from './validator.js';
import { PaperBroker } from '../broker/paper.js';
import { LiveBroker, inspectExposure, getCapacityPressure } from '../broker/live.js';
import { Broker } from '../broker/types.js';
import { assessRisk, computeQtyNotional, defaultLimits, RiskDecision } from '../risk/manager.js';
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
  maxLeverage: number; // <= 10
  riskPerTradePct: number; // 0.5..5
  dailyLossLimitPct: number; // 3..4
  timestamp: string; // ISO, acts as a signed "freeze"
  startBalanceUsd?: number;
  budgetFraction?: number; // 0..1 fraction of free balance usable by the agent
  aggressiveness?: 'conservative' | 'reactive' | 'aggressive';
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
  private cooldownTimer: NodeJS.Timeout | null = null;
  private cooldownContext: { reason: string; guard?: RiskDecision; triggeredAt: number } | null = null;

  // simplistic counters for risk
  consecutiveStops = 0;
  tradesToday = 0;
  realizedPnlTodayPct = 0;
  
  // Real-time performance tracking
  private recentTrades: { win: boolean; pnlPct: number; timestamp: number }[] = [];
  private qualityThresholdAdjustment = 0; // Dynamic adjustment to quality thresholds

  async activate(profile: ActivationProfile) {
    // PREFLIGHT
    this.state = 'PREFLIGHT';
    this.profile = profile;
    this.haltAckRequired = false;
    if (this.recoveryTimer) { try { clearTimeout(this.recoveryTimer); } catch {} this.recoveryTimer = null; }
    if (this.cooldownTimer) { try { clearTimeout(this.cooldownTimer); } catch {} this.cooldownTimer = null; }
    this.cooldownContext = null;
    if (profile.maxLeverage > 10) throw new Error('maxLeverage>10 not allowed');
    if (profile.riskPerTradePct < 0.5 || profile.riskPerTradePct > 5) throw new Error('risk/trade must be 0.5-5%');
    if (profile.dailyLossLimitPct < 3 || profile.dailyLossLimitPct > 4) throw new Error('daily loss must be 3-4%');

    // init broker (paper only for now)
    this.broker = profile.mode === 'live'
      ? new LiveBroker()
      : new PaperBroker(profile.startBalanceUsd);
    this.state = 'SCAN';
    this.logMovement('Agent activated', `Mode=${profile.mode}, symbol=${profile.symbol}`, {
      tags: ['agent', 'activation'],
      context: { profile },
      severity: 'low',
    }).catch(()=>{});
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
      // Entry filters: basic RSI/ADX gates to avoid weak/contrarian entries (aggressiveness-adjusted)
      const cfg = this.effectiveEntryThresholds();
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
    // Enhanced confirmation logic for better win rate with market regime detection
        const confirmRequired = this.plan.plan.entry_rule.confirm_close;
        const marketRegime = this.detectMarketRegime(snap);
        
        // Adapt confirmation requirements based on market regime
        let confirmationNeeded = confirmRequired;
        if (marketRegime === 'trending_strong') {
          // In strong trends, allow faster entries
          confirmationNeeded = false;
        } else if (marketRegime === 'choppy' || marketRegime === 'ranging') {
          // In choppy markets, require strict confirmation
          confirmationNeeded = true;
        }
        
        if (confirmationNeeded) {
          const confirm = (this.plan.bias === 'long' && price > mid) || (this.plan.bias === 'short' && price < mid);
          if (!confirm) return; // No entry without confirmation
        }
        
        // Additional quality check: price should be near zone edge for better R:R
        const zoneWidth = Math.abs(to - from);
        const distanceFromEntry = this.plan.bias === 'long' ? 
          (price - Math.min(from, to)) / zoneWidth : 
          (Math.max(from, to) - price) / zoneWidth;
          
        // Entry positioning based on market regime
        let maxDistanceAllowed = 0.4;
        if (marketRegime === 'trending_strong') {
          maxDistanceAllowed = 0.6; // Allow deeper entries in strong trends
        } else if (marketRegime === 'volatile') {
          maxDistanceAllowed = 0.3; // Require better entries in volatile markets
        }
          
        // Enter only in the optimal part of the zone
        if (inZone && distanceFromEntry <= maxDistanceAllowed) {
          await this.enter(price, snap);
        }
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
    let snap = _snap;
    if (!snap) {
      try {
        snap = await buildTechSnapshot(this.profile.symbol);
      } catch (err) {
        recordOpsEvent({
          level: 'warn',
          source: 'entry_gate',
          message: 'snapshot_failed',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: { error: String((err as any)?.message || err) },
        });
        this.entering = false;
        return;
      }
    }
    // Enhanced quality filters for 60%+ win rate
    if (!snap || !this.passesEntryMomentumGates(snap, 'enter') || !this.passesQualityFilters(snap)) {
      this.entering = false;
      return;
    }
    const bal = await this.broker.balance();
    const side = this.plan.bias === 'long' ? 'buy' : 'sell';
    const entry = mktPrice;
    const round4 = (n:number)=> Math.round(n*1e4)/1e4;
    const stopRaw = this.plan.bias === 'long' ? entry - this.plan.stopDistance : entry + this.plan.stopDistance;
    const stop = round4(stopRaw);
    const dir0 = side === 'buy' ? 1 : -1;
    const tp = this.plan.rPrices.map(x => round4(entry + dir0 * x.r * this.plan!.stopDistance));
    
    // CRYPTO PROFIT FILTER: Minimum profit threshold
    const cfg = getConfig();
    const minProfitPct = cfg.MIN_PROFIT_PCT;
    const firstTpProfitPct = Math.abs((tp[0] - entry) / entry) * 100;
    
    if (firstTpProfitPct < minProfitPct) {
      recordOpsEvent({
        level: 'info',
        source: 'profit_filter',
        message: 'Trade rejected - insufficient profit potential',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: { 
          expectedProfitPct: firstTpProfitPct, 
          minRequired: minProfitPct,
          tp1: tp[0],
          entry
        },
      });
      this.entering = false;
      return;
    }
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
    if (planRiskMinPct != null) planRiskMinPct = Math.min(planRiskMinPct, this.profile.riskPerTradePct);
    if (planRiskMaxPct != null) planRiskMaxPct = Math.max(planRiskMaxPct, this.profile.riskPerTradePct);
    let dynamicRiskPct = this.profile.riskPerTradePct;
    if (!(dynamicRiskPct > 0) && planRiskRecommendedPct != null) dynamicRiskPct = planRiskRecommendedPct;
    if (!(dynamicRiskPct > 0)) dynamicRiskPct = this.profile.riskPerTradePct;
    
    // Apply quality-based position sizing
    try {
      const qualityAdjustment = this.computeQualityBasedSizing(snap!);
      dynamicRiskPct *= qualityAdjustment;
      recordOpsEvent({
        level: 'info',
        source: 'position_sizing',
        message: 'quality_adjustment_applied',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: { 
          baseRisk: this.profile.riskPerTradePct, 
          qualityMultiplier: qualityAdjustment, 
          finalRisk: dynamicRiskPct,
          aggressiveness: this.profile.aggressiveness 
        },
      });
    } catch {}
    
    try {
      this.adaptiveRisk = await computeAdaptiveRisk(this.sessionId, this.profile.riskPerTradePct);
      dynamicRiskPct = Math.min(dynamicRiskPct, this.adaptiveRisk.riskPct); // Take the more conservative value
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

    this.logMovement('Position entered', `${side.toUpperCase()} ${this.profile.symbol} qty=${this.pos.qty.toFixed(6)} @ ${this.formatPrice(this.pos.entry)}`, {
      tags: ['movement', 'entry'],
      context: {
        sessionId: this.sessionId,
        symbol: this.profile.symbol,
        side,
        qty: this.pos.qty,
        entry: this.pos.entry,
        stop,
        tp,
        executionMode,
        telemetry,
        adaptiveRisk: this.adaptiveRisk,
      },
      severity: 'medium',
    }).catch(()=>{});

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
    
    // Special logic for normal 2-3% moves - optimize timing
    const unrealizedPct = Math.abs((price - this.pos.entry) / this.pos.entry) * 100;
    const isNormalMove = unrealizedPct >= 1.5 && unrealizedPct <= 4.0;
    
    let multiplier = playbook === 'momentum_breakout' ? 0.65 : playbook === 'mean_reversion' ? 1.05 : 0.85;
    
    // CRYPTO MOONSHOT: Adaptive trailing based on profit level
    const currentProfitPct = Math.abs((price - this.pos.entry) / this.pos.entry) * 100;
    const cfg = getConfig();
    const isBreakoutMode = currentProfitPct >= (cfg.CRYPTO_BREAKOUT_THRESHOLD || 5.0);
    const isMoonshotMode = currentProfitPct >= (cfg.CRYPTO_MOONSHOT_THRESHOLD || 15.0);
    
    if (isMoonshotMode) {
      multiplier *= (cfg.CRYPTO_MOONSHOT_TRAILING || 3.0);
      recordOpsEvent({
        level: 'info',
        source: 'crypto_moonshot',
        message: 'MOONSHOT mode - ultra loose trailing',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { currentProfitPct, multiplier, mode: 'moonshot' },
      });
    } else if (isBreakoutMode) {
      multiplier *= (cfg.CRYPTO_BREAKOUT_TRAILING || 2.0);
      recordOpsEvent({
        level: 'info',
        source: 'crypto_breakout',
        message: 'BREAKOUT mode - loose trailing',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { currentProfitPct, multiplier, mode: 'breakout' },
      });
    }
    if (upR > 1.5) multiplier *= 0.85;
    if (upR > 2.5) multiplier *= 0.75;
    
    // Tighten trailing for normal moves to secure profits around 2-3%
    if (isNormalMove && upR >= 1.5) {
      multiplier *= 0.7; // More aggressive trailing to lock profits
      recordOpsEvent({
        level: 'info',
        source: 'trail_optimizer',
        message: 'Tightened trailing for normal market movement',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { unrealizedPct: unrealizedPct.toFixed(2), upR: upR.toFixed(2), newMultiplier: multiplier.toFixed(3) },
      });
    }
    
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

  // Helper function to check if price is near key support/resistance levels
  private checkNearKeyLevel(price: number, snap: TechnicalSnapshot): boolean {
    try {
      const threshold = 0.008; // 0.8% threshold for "near"
      
      // Check support levels
      if (snap.supports) {
        for (const support of snap.supports.slice(0, 3)) { // Check top 3 supports
          if (support && support.price) {
            const distance = Math.abs((price - support.price) / price);
            if (distance <= threshold) return true;
          }
        }
      }
      
      // Check resistance levels  
      if (snap.resistances) {
        for (const resistance of snap.resistances.slice(0, 3)) { // Check top 3 resistances
          if (resistance && resistance.price) {
            const distance = Math.abs((price - resistance.price) / price);
            if (distance <= threshold) return true;
          }
        }
      }
      
      // Check pivot levels
      if (snap.pivots) {
        const pivotLevels = [snap.pivots.P, snap.pivots.S1, snap.pivots.S2, snap.pivots.R1, snap.pivots.R2];
        for (const level of pivotLevels) {
          if (level && typeof level === 'number') {
            const distance = Math.abs((price - level) / price);
            if (distance <= threshold) return true;
          }
        }
      }
      
      return false;
    } catch {
      return false;
    }
  }

  private effectiveEntryThresholds() {
    const cfg = getConfig();
    const level = this.profile?.aggressiveness || 'conservative';
    let ENTRY_SHORT_MIN_ADX = cfg.ENTRY_SHORT_MIN_ADX;
    let ENTRY_LONG_MIN_ADX = cfg.ENTRY_LONG_MIN_ADX;
    let ENTRY_SHORT_MIN_RSI = cfg.ENTRY_SHORT_MIN_RSI;
    let ENTRY_LONG_MAX_RSI = cfg.ENTRY_LONG_MAX_RSI;
    let ENTRY_MIN_ATR_PCT = cfg.ENTRY_MIN_ATR_PCT;
    let ENTRY_MIN_SLOPE_ABS_PCT = cfg.ENTRY_MIN_SLOPE_ABS_PCT;
    if (level === 'reactive') {
      ENTRY_SHORT_MIN_ADX = Math.max(10, ENTRY_SHORT_MIN_ADX - 2);
      ENTRY_LONG_MIN_ADX = Math.max(8, ENTRY_LONG_MIN_ADX - 2);
      ENTRY_MIN_ATR_PCT = Math.max(0.25, ENTRY_MIN_ATR_PCT * 0.75); // Plus flexible: 0.7 → 0.52%
      ENTRY_MIN_SLOPE_ABS_PCT = Math.max(0.008, ENTRY_MIN_SLOPE_ABS_PCT * 0.67);
    } else if (level === 'aggressive') {
      ENTRY_SHORT_MIN_ADX = Math.max(8, ENTRY_SHORT_MIN_ADX - 4);
      ENTRY_LONG_MIN_ADX = Math.max(6, ENTRY_LONG_MIN_ADX - 4);
      ENTRY_MIN_ATR_PCT = Math.max(0.15, ENTRY_MIN_ATR_PCT * 0.5); // Très flexible: 0.7 → 0.35%
      ENTRY_MIN_SLOPE_ABS_PCT = Math.max(0.006, ENTRY_MIN_SLOPE_ABS_PCT * 0.5);
    }
    return { ENTRY_SHORT_MIN_ADX, ENTRY_LONG_MIN_ADX, ENTRY_SHORT_MIN_RSI, ENTRY_LONG_MAX_RSI, ENTRY_MIN_ATR_PCT, ENTRY_MIN_SLOPE_ABS_PCT };
  }

  private passesEntryMomentumGates(snap: TechnicalSnapshot, reasonHint: 'enter'|'reverse'): boolean {
    const thresholds = this.effectiveEntryThresholds();
    let minAtr = thresholds.ENTRY_MIN_ATR_PCT;
    let minSlopeAbsPct = thresholds.ENTRY_MIN_SLOPE_ABS_PCT;
    
    // Per-symbol tweak: ETH tends to have lower ATR% → allow a lower floor
    try {
      const sym = this.profile?.symbol || '';
      if (sym.toUpperCase().startsWith('ETH/')) {
        // Lower the ATR threshold slightly for ETH
        minAtr = Math.max(0, minAtr - 0.15);
      }
    } catch {}
    
    const atrPct = Number((snap as any)?.atrPct ?? 0);
    
    // QUALITY OVERRIDE: If quality score is high, be more flexible with ATR requirements
    if (atrPct < minAtr) {
      // Calculate a quick quality score to see if we should be more flexible
      const adx = Number((snap as any)?.adx14 ?? 0);
      const rsi = Number((snap as any)?.rsi14 ?? 50);
      const ema20 = Number((snap as any)?.ema20 ?? snap.last);
      const ema50 = Number((snap as any)?.ema50 ?? snap.last);
      const bias: 'long'|'short' = (this.plan as any)?.bias || 'long';
      
      // Quick quality assessment
      const emaSpread = ((ema20 - ema50) / ema50) * 100;
      const trendAligned = bias === 'long' ? ema20 > ema50 && emaSpread > 0.5 : ema20 < ema50 && emaSpread < -0.5;
      const strongAdx = adx >= 25;
      const moderateAdx = adx >= 20;
      const rsiOptimal = bias === 'long' ? (rsi >= 45 && rsi <= 70) : (rsi >= 30 && rsi <= 55);
      
      let quickQualityScore = 0;
      if (trendAligned) quickQualityScore += 25;
      if (strongAdx) quickQualityScore += 30;
      else if (moderateAdx) quickQualityScore += 20;
      if (rsiOptimal) quickQualityScore += 15;
      if (atrPct >= 1.0) quickQualityScore += 10; // Some volatility points
      
      // CONSOLIDATION DETECTION: Special handling for low volatility periods
      const isConsolidation = atrPct < 0.5 && adx < 20;
      const nearKeyLevel = this.checkNearKeyLevel(snap.last, snap);
      
      // Adaptive threshold based on market conditions
      let adaptiveMinAtr = minAtr;
      if (isConsolidation) {
        adaptiveMinAtr *= 0.6; // 40% reduction in consolidation
        recordOpsEvent({
          level: 'info', source: 'entry_gate', message: 'consolidation_detected',
          sessionId: this.sessionId || undefined, symbol: this.profile?.symbol,
          details: { atrPct, originalThreshold: minAtr, adaptiveThreshold: adaptiveMinAtr }
        });
      }
      if (nearKeyLevel) {
        adaptiveMinAtr *= 0.8; // 20% reduction near key levels
      }
      
      const atrDeficit = adaptiveMinAtr - atrPct;
      
      // If quality score is high (≥50), be more flexible with ATR
      const qualityFlexibility = quickQualityScore >= 50; // Lowered from 60
      
      if (qualityFlexibility && atrDeficit <= 0.35) { // Increased from 0.25
        // Allow ATR to be up to 0.35% below threshold if quality is high
        recordOpsEvent({
          level: 'info',
          source: 'entry_gate',
          message: 'atr_relaxed_for_quality',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { atrPct, min: adaptiveMinAtr, qualityScore: quickQualityScore, reason: reasonHint },
        });
        // Continue to slope check
      } else if (atrDeficit <= 0) {
        // ATR meets adaptive threshold
        recordOpsEvent({
          level: 'info',
          source: 'entry_gate', 
          message: 'atr_adaptive_threshold_met',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { atrPct, adaptiveThreshold: adaptiveMinAtr, originalThreshold: minAtr }
        });
      } else {
        // Standard momentum override for near misses
        const emaValForOv = Number((snap as any)?.ema20 ?? snap.last ?? 0) || 1;
        const emaSlopeForOv = Number((snap as any)?.ema20Slope ?? 0);
        const slopePctAbsForOv = Math.abs((emaSlopeForOv / Math.abs(emaValForOv)) * 100);
        const slopeDirOk = bias === 'long' ? emaSlopeForOv > 0 : emaSlopeForOv < 0;
        const nearMiss = atrDeficit <= 0.15; // allow within 0.15% ATR of threshold
        const allowOverride = adx >= 24 && slopeDirOk && slopePctAbsForOv >= (minSlopeAbsPct * 1.1) && nearMiss;
        
        if (!allowOverride) {
          recordOpsEvent({
            level: 'info',
            source: 'entry_gate',
            message: 'atr_pct_too_low',
            sessionId: this.sessionId || undefined,
            symbol: this.profile?.symbol,
            details: { atrPct, min: adaptiveMinAtr, qualityScore: quickQualityScore, isConsolidation, nearKeyLevel, reason: reasonHint },
          });
          return false;
        }
      }
    }
    const emaVal = Number((snap as any)?.ema20 ?? snap.last ?? 0);
    const emaSlope = Number((snap as any)?.ema20Slope ?? 0);
    const slopePctAbs = emaVal !== 0 ? Math.abs((emaSlope / emaVal) * 100) : 0;
    if (slopePctAbs < minSlopeAbsPct) {
      recordOpsEvent({
        level: 'info',
        source: 'entry_gate',
        message: 'slope_too_flat',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { slopePctAbs, min: minSlopeAbsPct, reason: reasonHint },
      });
      return false;
    }
    return true;
  }

  // Advanced quality filters to achieve 60%+ win rate
  private passesQualityFilters(snap: TechnicalSnapshot): boolean {
    if (!this.plan) return false;
    const price = snap.last;
    const bias = this.plan.bias;
    if (bias === 'none') return false;

    const adx = Number((snap as any)?.adx14 ?? 0);
    const rsi = Number((snap as any)?.rsi14 ?? 50);
    const ema20 = Number((snap as any)?.ema20 ?? price);
    const ema50 = Number((snap as any)?.ema50 ?? price);
    const ema20Slope = Number((snap as any)?.ema20Slope ?? 0);
    const atrPct = Number((snap as any)?.atrPct ?? 0);
    const volume = Number((snap as any)?.volume ?? 0);
    const volumeMA = Number((snap as any)?.volumeMA ?? volume);
    const trendStrength = Number((snap as any)?.trendStrength ?? 0);

    let qualityScore = 0;
    const reasons: string[] = [];

    // 1. Trend Alignment (25% du score)
    const emaSpread = ((ema20 - ema50) / ema50) * 100;
    const trendAligned = bias === 'long' ? ema20 > ema50 && emaSpread > 0.5 : ema20 < ema50 && emaSpread < -0.5;
    if (trendAligned) {
      qualityScore += 25;
      reasons.push('trend_aligned');
    } else if (Math.abs(emaSpread) < 0.1) {
      // Reject only very flat sideways conditions (was 0.2%)
      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'sideways_market_rejected',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { emaSpread, bias },
      });
      return false;
    }

    // 2. Momentum Strength (30% du score)
    if (adx >= 25) {
      qualityScore += 30;
      reasons.push('strong_adx');
    } else if (adx >= 20) {
      qualityScore += 20;
      reasons.push('moderate_adx');
    } else if (adx < 12) {
      // Reject only very weak momentum (was 15)
      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'weak_momentum_rejected',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { adx, bias },
      });
      return false;
    }

    // 3. RSI Position (15% du score)
    const rsiOptimal = bias === 'long' ? (rsi >= 45 && rsi <= 70) : (rsi >= 30 && rsi <= 55);
    if (rsiOptimal) {
      qualityScore += 15;
      reasons.push('rsi_optimal');
    } else if (bias === 'long' && rsi > 75) {
      // Reject overbought longs
      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'overbought_long_rejected',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { rsi, bias },
      });
      return false;
    } else if (bias === 'short' && rsi < 25) {
      // Reject oversold shorts
      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'oversold_short_rejected',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { rsi, bias },
      });
      return false;
    }

    // 4. Volatility Context (15% du score)
    if (atrPct >= 1.5) {
      qualityScore += 15;
      reasons.push('high_volatility');
    } else if (atrPct >= 1.0) {
      qualityScore += 10;
      reasons.push('moderate_volatility');
    }

    // 5. Volume Confirmation (15% du score)
    const volumeRatio = volumeMA > 0 ? volume / volumeMA : 1;
    if (volumeRatio >= 1.3) {
      qualityScore += 15;
      reasons.push('high_volume');
    } else if (volumeRatio >= 1.1) {
      qualityScore += 10;
      reasons.push('elevated_volume');
    } else if (volumeRatio < 0.5) {
      // Reject only very low volume breakouts (was 0.7)
      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'low_volume_rejected',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { volumeRatio, bias },
      });
      return false;
    }

    // 6. Setup Quality Based on Plan Meta
    try {
      const quickTest = (this.plan.plan as any)?.meta?.quickTest;
      if (quickTest) {
        const winrate = Number(quickTest.winrate || 0);
        const avgR = Number(quickTest.avgR || 0);
        const count = Number(quickTest.count || 0);
        
        if (count >= 5) {
          if (winrate >= 65 && avgR >= 0.5) {
            qualityScore += 10;
            reasons.push('excellent_backtest');
          } else if (winrate >= 55 && avgR >= 0.3) {
            qualityScore += 5;
            reasons.push('good_backtest');
          } else if (winrate < 40 || avgR < 0) {
            // Reject poor historical performance
            recordOpsEvent({
              level: 'info',
              source: 'quality_filter',
              message: 'poor_backtest_rejected',
              sessionId: this.sessionId || undefined,
              symbol: this.profile?.symbol,
              details: { winrate, avgR, count, bias },
            });
            return false;
          }
        }
      }
    } catch {}

    // Required minimum quality score based on aggressiveness + dynamic adjustment
    const level = this.profile?.aggressiveness || 'conservative';
    let minScore = 55; // Conservative: still selective but more realistic
    if (level === 'reactive') minScore = 45; // More opportunities
    if (level === 'aggressive') minScore = 35; // Most opportunities
    
    // Special logic for normal market movements (2-3% potential)
    // Encourage learning on standard setups if agent has low experience
    const potentialMove = Math.abs((snap.last - ema20) / ema20) * 100;
    const hasLowExperience = this.recentTrades.length < 20;
    
    if (potentialMove >= 1.5 && potentialMove <= 4.0 && hasLowExperience) {
      // Lower threshold for learning on normal 2-3% moves
      minScore = Math.max(25, minScore - 15);
      recordOpsEvent({
        level: 'info',
        source: 'learning_mode',
        message: 'Reduced threshold for normal market movement learning',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { potentialMove: potentialMove.toFixed(2), originalMinScore: minScore + 15, adjustedMinScore: minScore },
      });
    }
    
    // Apply dynamic adjustment based on recent performance
    minScore += this.qualityThresholdAdjustment;
    minScore = Math.max(30, Math.min(75, minScore)); // Bounds: 30-75 (more reasonable)

    const passed = qualityScore >= minScore;
    
    recordOpsEvent({
      level: passed ? 'info' : 'warn',
      source: 'quality_filter',
      message: passed ? 'quality_filter_passed' : 'quality_filter_rejected',
      sessionId: this.sessionId || undefined,
      symbol: this.profile?.symbol,
      details: { 
        qualityScore, 
        minScore, 
        reasons, 
        bias,
        aggressiveness: level,
        adx,
        rsi,
        atrPct,
        volumeRatio,
        emaSpread
      },
    });

    return passed;
  }

  // Dynamic position sizing based on setup quality and market conditions
  private computeQualityBasedSizing(snap: TechnicalSnapshot): number {
    if (!this.plan) return 1.0;
    
    const price = snap.last;
    const bias = this.plan.bias;
    if (bias === 'none') return 0.5; // Minimal size for uncertain setups

    const adx = Number((snap as any)?.adx14 ?? 0);
    const rsi = Number((snap as any)?.rsi14 ?? 50);
    const atrPct = Number((snap as any)?.atrPct ?? 0);
    const volume = Number((snap as any)?.volume ?? 0);
    const volumeMA = Number((snap as any)?.volumeMA ?? volume);
    const ema20 = Number((snap as any)?.ema20 ?? price);
    const ema50 = Number((snap as any)?.ema50 ?? price);
    
    let sizeMultiplier = 1.0;
    const level = this.profile?.aggressiveness || 'conservative';
    
    // Base multiplier by aggressiveness
    const baseMultipliers = {
      'conservative': 0.8,  // More cautious sizing
      'reactive': 1.0,      // Standard sizing
      'aggressive': 1.2     // Larger positions on good setups
    };
    sizeMultiplier = baseMultipliers[level] || 1.0;
    
    // ADX strength bonus (up to +30%)
    if (adx >= 30) sizeMultiplier *= 1.3;
    else if (adx >= 25) sizeMultiplier *= 1.2;
    else if (adx >= 20) sizeMultiplier *= 1.1;
    else if (adx < 15) sizeMultiplier *= 0.7; // Reduce size in weak trends
    
    // Trend alignment bonus (up to +20%)
    const emaSpread = ((ema20 - ema50) / ema50) * 100;
    const trendAligned = bias === 'long' ? emaSpread > 0.5 : emaSpread < -0.5;
    if (trendAligned) {
      if (Math.abs(emaSpread) > 2.0) sizeMultiplier *= 1.2; // Strong trend
      else if (Math.abs(emaSpread) > 1.0) sizeMultiplier *= 1.1; // Moderate trend
    } else if (Math.abs(emaSpread) < 0.2) {
      sizeMultiplier *= 0.6; // Reduce size in sideways markets
    }
    
    // Volume confirmation bonus (up to +15%)
    const volumeRatio = volumeMA > 0 ? volume / volumeMA : 1;
    if (volumeRatio >= 1.5) sizeMultiplier *= 1.15;
    else if (volumeRatio >= 1.2) sizeMultiplier *= 1.1;
    else if (volumeRatio < 0.8) sizeMultiplier *= 0.8;
    
    // Volatility adjustment
    if (atrPct > 2.0) sizeMultiplier *= 0.9; // Reduce size in high volatility
    else if (atrPct < 0.5) sizeMultiplier *= 0.8; // Reduce size in low volatility
    
    // RSI position adjustment (avoid extremes)
    if (bias === 'long' && rsi > 70) sizeMultiplier *= 0.8;
    else if (bias === 'short' && rsi < 30) sizeMultiplier *= 0.8;
    
    // Backtest quality bonus
    try {
      const quickTest = (this.plan.plan as any)?.meta?.quickTest;
      if (quickTest) {
        const winrate = Number(quickTest.winrate || 0);
        const avgR = Number(quickTest.avgR || 0);
        const count = Number(quickTest.count || 0);
        
        if (count >= 10) {
          if (winrate >= 70 && avgR >= 0.8) sizeMultiplier *= 1.25; // Excellent backtest
          else if (winrate >= 60 && avgR >= 0.5) sizeMultiplier *= 1.15; // Good backtest
          else if (winrate < 45 || avgR < 0.2) sizeMultiplier *= 0.7; // Poor backtest
        }
      }
    } catch {}
    
    // Apply bounds (0.5x to 1.5x of base risk)
    sizeMultiplier = Math.max(0.5, Math.min(1.5, sizeMultiplier));
    
    return sizeMultiplier;
  }

  // Market regime detection for adaptive strategy
  private detectMarketRegime(snap: TechnicalSnapshot): 'trending_strong' | 'trending_weak' | 'ranging' | 'choppy' | 'volatile' {
    const adx = Number((snap as any)?.adx14 ?? 0);
    const atrPct = Number((snap as any)?.atrPct ?? 0);
    const ema20 = Number((snap as any)?.ema20 ?? snap.last);
    const ema50 = Number((snap as any)?.ema50 ?? snap.last);
    const ema20Slope = Number((snap as any)?.ema20Slope ?? 0);
    const realizedVol = Number((snap as any)?.realizedVol ?? 0);
    
    const emaSpread = Math.abs((ema20 - ema50) / ema50) * 100;
    const slopeStrength = Math.abs(ema20Slope / ema20) * 100;
    
    // High volatility regime
    if (atrPct > 2.5 || realizedVol > 80) {
      return 'volatile';
    }
    
    // Strong trending regime
    if (adx >= 25 && emaSpread > 1.0 && slopeStrength > 0.05) {
      return 'trending_strong';
    }
    
    // Weak trending regime  
    if (adx >= 18 && (emaSpread > 0.5 || slopeStrength > 0.03)) {
      return 'trending_weak';
    }
    
    // Ranging regime (sideways with structure)
    if (adx < 18 && emaSpread < 0.3 && atrPct > 0.8) {
      return 'ranging';
    }
    
    // Choppy regime (low volatility, no clear direction)
    return 'choppy';
  }

  // Dynamic threshold adjustment based on recent performance
  private adjustQualityThresholds(): void {
    if (this.recentTrades.length < 10) return; // Need sufficient data
    
    const recentWinRate = this.recentTrades.filter(t => t.win).length / this.recentTrades.length;
    const avgPnlPct = this.recentTrades.reduce((sum, t) => sum + t.pnlPct, 0) / this.recentTrades.length;
    
    const level = this.profile?.aggressiveness || 'conservative';
    let targetWinRate = 0.65; // Conservative: realistic for normal trading (was 0.7)
    if (level === 'reactive') targetWinRate = 0.58; // Reactive: more trades, good win rate (was 0.6)
    if (level === 'aggressive') targetWinRate = 0.52; // Aggressive: active trading, decent rate (was 0.55)
    
    // Adjust thresholds based on performance vs target
    const performanceDelta = recentWinRate - targetWinRate;
    
    if (recentWinRate < targetWinRate - 0.1 && avgPnlPct < 0) {
      // Performance below target, increase selectivity
      this.qualityThresholdAdjustment = Math.min(15, this.qualityThresholdAdjustment + 5);
      recordOpsEvent({
        level: 'warn',
        source: 'performance_optimizer',
        message: 'Increasing selectivity due to poor performance',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { 
          recentWinRate: recentWinRate.toFixed(3), 
          targetWinRate: targetWinRate.toFixed(3),
          avgPnlPct: avgPnlPct.toFixed(3),
          adjustment: this.qualityThresholdAdjustment 
        },
      });
    } else if (recentWinRate > targetWinRate + 0.1 && avgPnlPct > 0.5) {
      // Performance above target, can be less selective
      this.qualityThresholdAdjustment = Math.max(-10, this.qualityThresholdAdjustment - 3);
      recordOpsEvent({
        level: 'info',
        source: 'performance_optimizer',
        message: 'Decreasing selectivity due to good performance',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { 
          recentWinRate: recentWinRate.toFixed(3), 
          targetWinRate: targetWinRate.toFixed(3),
          avgPnlPct: avgPnlPct.toFixed(3),
          adjustment: this.qualityThresholdAdjustment 
        },
      });
    }
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

    // MOONSHOT: Skip TP1 if in breakout mode to let winners run
    const currentProfitPct = Math.abs((price - this.pos.entry) / this.pos.entry) * 100;
    const cfg = getConfig();
    const isBreakoutMode = currentProfitPct >= (cfg.CRYPTO_BREAKOUT_THRESHOLD || 5.0);
    
    // Partial: on TP1 if not already taken, UNLESS in breakout mode
    if (tp1Hit && !this.pos.partialTaken && !isBreakoutMode) {
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
            this.logMovement('Partial profit taken', `${this.pos.side.toUpperCase()} ${this.profile.symbol} partial qty=${filledQty.toFixed(6)} @ ${this.formatPrice(price)}`, {
              tags: ['movement', 'partial'],
              context: {
                sessionId: this.sessionId,
                symbol: this.profile.symbol,
                side: this.pos.side,
                filledQty,
                price,
                telemetry,
                remainingQty: this.pos.qty,
                stop: this.pos.stop,
                tp: this.pos.tp,
              },
              severity: 'low',
            }).catch(()=>{});
          }
        }
      } catch {}
      return; // wait next tick after partial
    } else if (tp1Hit && !this.pos.partialTaken && isBreakoutMode) {
      // MOONSHOT: Log TP1 skip and move to breakeven
      recordOpsEvent({
        level: 'info',
        source: 'crypto_moonshot',
        message: 'TP1 SKIPPED - letting moonshot run',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: { 
          currentProfitPct, 
          tp1: firstTp, 
          mode: currentProfitPct >= 15 ? 'moonshot' : 'breakout'
        },
      });
      
      // Mark as partial to avoid re-triggering
      this.pos.partialTaken = true;
      this.pos.partialInfo = { ts: Date.now(), price };
      
      // Move to breakeven for safety
      const be = this.pos.entry;
      if (this.pos.side === 'buy') this.pos.stop = Math.max(this.pos.stop, be);
      else this.pos.stop = Math.min(this.pos.stop, be);
      this.pos.breakeven = be;
      this.noteTrail(this.pos.stop);
      
      // Remove TP1 and continue to TP2
      if (this.pos.tp.length > 1) this.pos.tp = this.pos.tp.slice(1);
      await this.syncProtectiveOrders('partial');
      broadcast('agent_state', { state: this.state, pos: this.pos }, this.profile.symbol, this.sessionId || undefined);
      return; // wait next tick after TP1 skip
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
    
    // Track trade performance for dynamic adjustment
    const isWin = pnl > 0;
    this.recentTrades.push({ 
      win: isWin, 
      pnlPct, 
      timestamp: Date.now() 
    });
    
    // Keep only last 20 trades for rolling performance
    if (this.recentTrades.length > 20) {
      this.recentTrades = this.recentTrades.slice(-20);
    }
    
    // Dynamic threshold adjustment based on recent performance
    this.adjustQualityThresholds();
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
    this.logMovement('Position closed', `${this.pos.side.toUpperCase()} ${this.profile.symbol} exit reason=${reason} qty=${filledQty.toFixed(6)} @ ${this.formatPrice(price)}, pnl=${pnl.toFixed(2)}`, {
      tags: ['movement', 'exit'],
      context: {
        sessionId: this.sessionId,
        symbol: this.profile.symbol,
        side: this.pos.side,
        qty: filledQty,
        price,
        reason,
        pnl,
        pnlPct,
        telemetry,
        tradesToday: this.tradesToday,
        realizedPnlTodayPct: this.realizedPnlTodayPct,
      },
      severity: reason === 'sl' ? 'high' : 'medium',
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
    if (!guard.ok) {
      if (guard.action === 'halt') {
        await this.engageKillSwitch(guard.reason || 'risk_guard', { guard });
        return;
      }
      if (guard.action === 'cooldown') {
        this.enterRiskCooldown(guard);
        return;
      }
      if (guard.action === 'warn') {
        recordOpsEvent({
          level: 'warn',
          source: 'risk_guard',
          message: guard.reason || 'risk_guard_warn',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: guard,
        });
      }
    }

    this.state = 'SCAN';
    broadcast('agent_state', { state: this.state, aiCalls: await getAICallsCount(this.sessionId || undefined) }, this.profile.symbol, this.sessionId || undefined);

    const canRearm = guard.ok || guard.action === 'warn';
    if (!opts?.suppressRearm && canRearm) {
      // Immediately request a fresh strategy after an exit (force to bypass cool-down)
      try {
        await requestStrategy({ symbol: this.profile.symbol, trigger: 'position-exit', sessionId: this.sessionId || undefined, priceHint: price });
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

  private enterRiskCooldown(guard: RiskDecision) {
    recordOpsEvent({
      level: 'warn',
      source: 'risk_guard',
      message: guard.reason || 'risk_guard_cooldown',
      sessionId: this.sessionId || undefined,
      symbol: this.profile?.symbol,
      details: guard,
    });
    this.stopCooldownWatcher();
    this.state = 'COOLDOWN';
    this.cooldownContext = { reason: guard.reason || 'risk_guard', guard, triggeredAt: Date.now() };
    broadcast('agent_state', { state: this.state, reason: guard.reason || 'risk_guard', guard }, this.profile?.symbol, this.sessionId || undefined);
    this.startCooldownWatcher();
    this.logMovement('Cooldown engaged', `Reason=${guard.reason || 'risk_guard'} on ${this.profile?.symbol}`, {
      tags: ['movement', 'cooldown'],
      context: {
        sessionId: this.sessionId,
        symbol: this.profile?.symbol,
        guard,
      },
      severity: guard.action === 'halt' ? 'high' : 'medium',
    }).catch(()=>{});
  }

  private startCooldownWatcher(delayMs?: number) {
    if (!this.profile) return;
    if (this.cooldownTimer) { try { clearTimeout(this.cooldownTimer); } catch {} }
    const interval = Math.max(120_000, Number(process.env.AGENT_COOLDOWN_RECHECK_MS || 600_000));
    const wait = Math.max(15_000, delayMs ?? interval);
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.evaluateCooldownReactivation().catch(()=>{});
    }, wait);
  }

  private stopCooldownWatcher() {
    if (this.cooldownTimer) {
      try { clearTimeout(this.cooldownTimer); } catch {}
      this.cooldownTimer = null;
    }
  }

  private async evaluateCooldownReactivation() {
    if (!this.profile || this.state !== 'COOLDOWN') return;
    const interval = Math.max(120_000, Number(process.env.AGENT_COOLDOWN_RECHECK_MS || 600_000));
    try {
      const snap = await buildTechSnapshot(this.profile.symbol);
      const momentum = this.computeMomentumSnapshot(snap);
      const momentumThresh = this.getCooldownMomentumThreshold();
      if (momentum.score < momentumThresh) {
        // If momentum is decent but below threshold, shorten the next check based on aggressiveness
        const level = this.profile.aggressiveness || 'conservative';
        let next = interval;
        if (momentum.score > 0.5) {
          if (level === 'reactive') next = Math.max(60_000, Math.floor(interval * 0.5));
          if (level === 'aggressive') next = Math.max(30_000, Math.floor(interval * 0.33));
        }
        this.startCooldownWatcher(next);
        return;
      }
      const candidate = await this.computeCooldownCandidate({ snap, momentumScore: momentum.score });
      const minConfidence = this.getCooldownConfidenceThreshold();
      if (candidate && candidate.confidence >= minConfidence) {
        await this.exitCooldownWithPlan(candidate);
        return;
      }
    } catch (err) {
      recordOpsEvent({
        level: 'warn',
        source: 'risk_guard',
        message: 'cooldown_reactivate_failed',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: { error: String((err as any)?.message || err) },
      });
    }
    this.startCooldownWatcher(interval);
  }

  private getCooldownConfidenceThreshold() {
    const cfg = getConfig();
    const base = (() => {
      const raw = Number(process.env.AGENT_COOLDOWN_CONFIDENCE_MIN ?? cfg.COOLDOWN_CONFIDENCE_MIN ?? '');
      if (Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
      return 0.6;
    })();
    const level = this.profile?.aggressiveness || 'conservative';
    if (level === 'reactive') return Math.max(0.45, base - 0.05);
    if (level === 'aggressive') return Math.max(0.4, base - 0.08);
    return base;
  }

  private getCooldownMomentumThreshold() {
    const cfg = getConfig();
    const base = (() => {
      const raw = Number(process.env.COOLDOWN_MOMENTUM_THRESHOLD ?? cfg.COOLDOWN_MOMENTUM_THRESHOLD ?? '');
      if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
      return 0.3;
    })();
    const level = this.profile?.aggressiveness || 'conservative';
    if (level === 'reactive') return Math.max(0.15, base - 0.05);
    if (level === 'aggressive') return Math.max(0.1, base - 0.08);
    return base;
  }

  private async exitCooldownWithPlan(candidate: { plan: PlanJson; confidence: number; components: { planScore: number; momentumScore: number; quickTest?: any; momentum?: any } }): Promise<void> {
    if (!this.profile) return;
    this.stopCooldownWatcher();
    const prev = this.cooldownContext;
    this.cooldownContext = null;
    if (prev?.reason === 'consecutive_stops') this.consecutiveStops = 0;
    if (prev?.reason === 'trades_cap') this.tradesToday = Math.max(0, this.tradesToday - 1);
    recordOpsEvent({
      level: 'info',
      source: 'risk_guard',
      message: 'cooldown_reactivate',
      sessionId: this.sessionId || undefined,
      symbol: this.profile.symbol,
      details: { confidence: candidate.confidence, components: candidate.components, prev },
    });
    this.state = 'SCAN';
    broadcast('agent_state', { state: this.state, reason: 'cooldown_reactivate', confidence: candidate.confidence, components: candidate.components }, this.profile.symbol, this.sessionId || undefined);
    try {
      this.logMovement('Cooldown cleared', `Confidence=${candidate.confidence.toFixed(2)} -> rearming ${this.profile.symbol}`, {
        tags: ['movement', 'cooldown', 'reactivate'],
        context: {
          sessionId: this.sessionId,
          symbol: this.profile.symbol,
          confidence: candidate.confidence,
          components: candidate.components,
        },
        severity: 'medium',
      }).catch(()=>{});
      await this.propose(candidate.plan as any);
      await this.validateAndArm();
    } catch (err) {
      recordOpsEvent({
        level: 'error',
        source: 'risk_guard',
        message: 'cooldown_rearm_failed',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: { error: String((err as any)?.message || err), confidence: candidate.confidence },
      });
      this.logMovement('Cooldown rearm failed', `Failed to rearm ${this.profile.symbol}: ${(err as any)?.message || err}`, {
        tags: ['movement', 'cooldown', 'error'],
        context: {
          sessionId: this.sessionId,
          symbol: this.profile.symbol,
          error: String((err as any)?.message || err),
          confidence: candidate.confidence,
        },
        severity: 'high',
      }).catch(()=>{});
      this.startCooldownWatcher();
    }
  }

  private async computeCooldownCandidate(opts?: { snap?: TechnicalSnapshot; momentumScore?: number }): Promise<{ plan: PlanJson; confidence: number; components: { planScore: number; momentumScore: number; quickTest?: any; momentum?: any } } | null> {
    if (!this.profile) return null;
    let plan: PlanJson;
    try {
      plan = await this.buildPlan({ fresh: false });
    } catch (err) {
      recordOpsEvent({
        level: 'warn',
        source: 'risk_guard',
        message: 'cooldown_plan_failed',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: { error: String((err as any)?.message || err) },
      });
      return null;
    }
    if (!plan || (plan as any).bias === 'none') return null;
    const snap = opts?.snap ?? await buildTechSnapshot(this.profile.symbol);
    const planQuality = this.scorePlanQuality(plan);
    const momentum = this.scoreMomentum(plan, snap);
    const combinedMomentum = Math.max(momentum.score, opts?.momentumScore ?? 0);
    const confidence = Math.min(1, planQuality.score + combinedMomentum);
    return { plan, confidence, components: { planScore: planQuality.score, momentumScore: combinedMomentum, quickTest: planQuality.quickTest, momentum: momentum.details } };
  }

  private scorePlanQuality(plan: PlanJson): { score: number; quickTest?: any } {
    let score = 0;
    const planMeta: any = (plan as any)?.meta || (plan as any)?.plan?.meta || {};
    const quickTest = planMeta?.quickTest;
    if (quickTest) {
      const count = Number(quickTest.count ?? 0);
      const winrate = Number(quickTest.winrate ?? 0);
      const avgR = Number(quickTest.avgR ?? 0);
      const avgMAE = Number(quickTest.avgMAE_R ?? 0);
      const avgMFE = Number(quickTest.avgMFE_R ?? 0);
      if (count >= 6) score += 0.2;
      if (winrate >= 45) score += 0.2;
      if (winrate >= 55) score += 0.05;
      if (avgR >= 0.4) score += 0.2;
      if (avgR >= 0.7) score += 0.05;
      if (avgMAE > -1.1) score += 0.025;
      if (avgMFE >= 1.2) score += 0.025;
    } else {
      score += 0.1;
    }
    const riskFraction = Number((plan as any)?.position?.risk_fraction ?? 0);
    if (riskFraction > 0 && riskFraction <= 0.02) score += 0.05;
    if (riskFraction > 0 && riskFraction <= 0.015) score += 0.05;
    return { score: Math.min(score, 0.5), quickTest };
  }

  private scoreMomentum(plan: PlanJson, snap: TechnicalSnapshot): { score: number; details: { adx: number; slopePct: number; priceVsEmaPct: number; atrPct: number; realizedVol: number; trendStrength: number; srBias: any; reason?: string } } {
    let score = 0;
    const bias: 'long'|'short'|'none' = (plan as any)?.bias || 'none';
    const srBiasEarly = (snap as any)?.srBias;
    if (bias === 'none') return { score: 0, details: { adx: 0, slopePct: 0, priceVsEmaPct: 0, atrPct: 0, realizedVol: 0, trendStrength: 0, srBias: srBiasEarly, reason: 'no_bias' } };
    const adx = Number((snap as any)?.adx14 ?? 0);
    if (adx >= 18) score += 0.18;
    if (adx >= 24) score += 0.07;
    const emaSlope = Number((snap as any)?.ema20Slope ?? 0);
    const emaRaw = (snap as any)?.ema20 ?? snap.last ?? 1;
    const ema = typeof emaRaw === 'number' && Number.isFinite(emaRaw) ? emaRaw : 1;
    const slopePct = ema !== 0 ? (emaSlope / Math.abs(ema)) * 100 : 0;
    const slopeAligned = bias === 'long' ? slopePct > 0.02 : slopePct < -0.02;
    const slopeStrong = bias === 'long' ? slopePct > 0.06 : slopePct < -0.06;
    if (slopeAligned) score += 0.12;
    if (slopeStrong) score += 0.08;
    const priceVsEmaPct = ema !== 0 ? ((snap.last - ema) / Math.abs(ema)) * 100 : 0;
    const priceAligned = bias === 'long' ? priceVsEmaPct > 0.15 : priceVsEmaPct < -0.15;
    if (priceAligned) score += 0.07;
    const atrPct = Number((snap as any)?.atrPct ?? 0);
    if (atrPct >= 1.2) score += 0.05;
    else if (atrPct >= 0.8) score += 0.03;
    const realizedVol = Number((snap as any)?.realizedVol ?? 0);
    if (realizedVol >= 18) score += 0.05;
    else if (realizedVol >= 12) score += 0.03;
    const trendStrength = Number((snap as any)?.trendStrength ?? 0);
    if ((bias === 'long' && trendStrength > 0.2) || (bias === 'short' && trendStrength < -0.2)) score += 0.05;
    const srBias = srBiasEarly;
    if (bias === 'long' && srBias === 'nearSupport') score += 0.02;
    if (bias === 'short' && srBias === 'nearResistance') score += 0.02;
    return {
      score: Math.min(score, 0.5),
      details: {
        adx,
        slopePct,
        priceVsEmaPct,
        atrPct,
        realizedVol,
        trendStrength,
        srBias,
      },
    };
  }

  private computeMomentumSnapshot(snap: TechnicalSnapshot): { score: number; bias: 'long'|'short'; details: { adx: number; slopePct: number; priceVsEmaPct: number; atrPct: number; realizedVol: number; trendStrength: number; srBias: any } } {
    const trend = Number((snap as any)?.trendStrength ?? 0);
    const bias: 'long'|'short' = trend >= 0 ? 'long' : 'short';
    const adx = Number((snap as any)?.adx14 ?? 0);
    const atrPct = Number((snap as any)?.atrPct ?? 0);
    const ema = Number((snap as any)?.ema20 ?? snap.last ?? 1);
    const emaSlope = Number((snap as any)?.ema20Slope ?? 0);
    const slopePct = ema !== 0 ? (emaSlope / Math.abs(ema)) * 100 : 0;
    const priceVsEmaPct = ema !== 0 ? ((snap.last - ema) / Math.abs(ema)) * 100 : 0;
    const realizedVol = Number((snap as any)?.realizedVol ?? 0);
    const trendStrength = Number((snap as any)?.trendStrength ?? 0);
    const srBias = (snap as any)?.srBias;

    let score = 0;
    if (adx >= 18) score += 0.18;
    if (adx >= 24) score += 0.07;
    const slopeAligned = bias === 'long' ? slopePct > 0.02 : slopePct < -0.02;
    const slopeStrong = bias === 'long' ? slopePct > 0.06 : slopePct < -0.06;
    if (slopeAligned) score += 0.12;
    if (slopeStrong) score += 0.08;
    const priceAligned = bias === 'long' ? priceVsEmaPct > 0.15 : priceVsEmaPct < -0.15;
    if (priceAligned) score += 0.07;
    if (atrPct >= 1.2) score += 0.05;
    else if (atrPct >= 0.8) score += 0.03;
    if (realizedVol >= 18) score += 0.05;
    else if (realizedVol >= 12) score += 0.03;
    if ((bias === 'long' && trendStrength > 0.2) || (bias === 'short' && trendStrength < -0.2)) score += 0.05;
    if (bias === 'long' && srBias === 'nearSupport') score += 0.02;
    if (bias === 'short' && srBias === 'nearResistance') score += 0.02;

    return {
      score: Math.min(score, 0.5),
      bias,
      details: { adx, slopePct, priceVsEmaPct, atrPct, realizedVol, trendStrength, srBias },
    };
  }

  private formatPrice(value: number | null | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return value;
    return Math.round(value * 1e4) / 1e4;
  }

  private async logMovement(title: string, description: string, opts?: { severity?: 'low'|'medium'|'high'|'critical'; tags?: string[]; context?: any }) {
    try {
      const context = {
        sessionId: this.sessionId,
        symbol: this.profile?.symbol,
        state: this.state,
        ...(opts?.context || {}),
      };
      await logImprovementAuto({
        title,
        description,
        severity: opts?.severity,
        tags: opts?.tags,
        reporter: 'agent',
        context,
      });
    } catch {}
  }

  private async engageKillSwitch(reason: string, details?: any) {
    if (this.state === 'HALT') return;
    this.stopCooldownWatcher();
    this.cooldownContext = null;
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
    this.logMovement('Kill switch engaged', reason, {
      tags: ['movement', 'halt', 'risk'],
      context: {
        sessionId: this.sessionId,
        symbol: this.profile?.symbol,
        details,
      },
      severity: 'high',
    }).catch(()=>{});
  }

  halt() {
    this.state = 'HALT';
    this.stopCooldownWatcher();
    this.cooldownContext = null;
    this.logMovement('Agent halted', `Manual halt on ${this.profile?.symbol || 'unknown'}`, {
      tags: ['movement', 'halt'],
      context: {
        sessionId: this.sessionId,
        symbol: this.profile?.symbol,
      },
      severity: 'medium',
    }).catch(()=>{});
  }

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
    let snap: TechnicalSnapshot | null = null;
    try {
      snap = await buildTechSnapshot(this.profile.symbol);
    } catch (err) {
      recordOpsEvent({
        level: 'warn',
        source: 'entry_gate',
        message: 'snapshot_failed',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: { error: String((err as any)?.message || err), reason: 'reverse' },
      });
    }
    if (!snap || !this.passesEntryMomentumGates(snap, 'reverse')) {
      this.entering = false;
      return;
    }
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
    this.logMovement('Position entered', `${side.toUpperCase()} ${this.profile.symbol} qty=${this.pos.qty.toFixed(6)} @ ${this.formatPrice(this.pos.entry)}`, {
      tags: ['movement', 'entry'],
      context: {
        sessionId: this.sessionId,
        symbol: this.profile.symbol,
        side,
        qty: this.pos.qty,
        entry: this.pos.entry,
        stop: this.pos.stop,
        tp: this.pos.tp,
        mode: 'manual_side',
      },
      severity: 'medium',
    }).catch(()=>{});
    this.state = 'MANAGE';
    this.tradesToday += 1;
    await (await import('../ws/hub.js')).broadcast('agent_state', { state: this.state, pos: this.pos, aiCalls: await (await import('../metrics/aiCalls.js')).getAICallsCount(this.sessionId || undefined) }, this.profile.symbol, this.sessionId || undefined);
    this.entering = false;
  }

  // Public diagnostic method to check why agent is not trading
  async getDiagnostics(): Promise<any> {
    if (!this.plan || !this.profile) {
      return {
        canTrade: false,
        reason: 'No plan or profile configured',
        checks: {}
      };
    }

    let snap: TechnicalSnapshot | null = null;
    let realtimePrice: number | null = null;
    
    try {
      // Get both technical snapshot and real-time price
      const [techSnapshot, ticker] = await Promise.all([
        buildTechSnapshot(this.profile.symbol),
        (async () => {
          try {
            const { getTicker } = await import('../data/market.js');
            const tickerData = await getTicker(this.profile!.symbol);
            return tickerData?.last || null;
          } catch {
            return null;
          }
        })()
      ]);
      
      snap = techSnapshot;
      realtimePrice = ticker;
    } catch (err) {
      return {
        canTrade: false,
        reason: 'Failed to get market snapshot',
        checks: { snapshotError: String((err as any)?.message || err) }
      };
    }

    if (!snap) {
      return {
        canTrade: false,
        reason: 'No market data available',
        checks: {}
      };
    }

    // Use real-time price if available, fallback to snapshot price
    const price = realtimePrice ?? snap.last;
    const bias = this.plan.bias;
    const checks: any = {};

    // Basic state checks
    checks.hasPosition = {
      status: !this.pos ? 'PASS' : 'FAIL',
      reason: this.pos ? 'Already in position' : 'No position'
    };

    checks.isArmed = {
      status: this.state === 'ARMED' ? 'PASS' : 'FAIL',
      reason: `State is ${this.state}`
    };

    checks.isEntering = {
      status: !this.entering ? 'PASS' : 'FAIL',
      reason: this.entering ? 'Already entering position' : 'Not entering'
    };

    // Risk limits
    const limits = defaultLimits();
    checks.dailyTradeLimit = {
      status: this.tradesToday < limits.maxTradesPerDay ? 'PASS' : 'FAIL',
      reason: `${this.tradesToday}/${limits.maxTradesPerDay} trades today`
    };

    checks.consecutiveStopsLimit = {
      status: this.consecutiveStops < limits.maxConsecutiveStops ? 'PASS' : 'FAIL',
      reason: `${this.consecutiveStops}/${limits.maxConsecutiveStops} consecutive stops`
    };

    // Entry zone check with detailed info
    const entryZone = this.plan.zone;
    let inZone = false;
    let zoneDetails = '';
    if (entryZone && typeof entryZone.from === 'number' && typeof entryZone.to === 'number') {
      const zoneMin = Math.min(entryZone.from, entryZone.to);
      const zoneMax = Math.max(entryZone.from, entryZone.to);
      inZone = price >= zoneMin && price <= zoneMax;
      
      if (inZone) {
        zoneDetails = `Price ${price.toFixed(4)} in zone [${zoneMin.toFixed(4)}, ${zoneMax.toFixed(4)}]`;
      } else {
        const distanceToZone = price < zoneMin ? 
          ((zoneMin - price) / price * 100).toFixed(3) + '% below' :
          ((price - zoneMax) / price * 100).toFixed(3) + '% above';
        zoneDetails = `Price ${price.toFixed(4)} outside zone [${zoneMin.toFixed(4)}, ${zoneMax.toFixed(4)}] (${distanceToZone})`;
      }
    } else {
      zoneDetails = 'No entry zone defined';
    }
    
    checks.inEntryZone = {
      status: inZone ? 'PASS' : 'FAIL',
      reason: zoneDetails,
      details: {
        currentPrice: price,
        zoneFrom: entryZone?.from,
        zoneTo: entryZone?.to,
        inZone
      }
    };

    // Momentum gates
    checks.momentumGates = {
      status: this.passesEntryMomentumGates(snap, 'enter') ? 'PASS' : 'FAIL',
      reason: this.passesEntryMomentumGates(snap, 'enter') ? 'Momentum requirements met' : 'Momentum requirements not met'
    };

    // Quality filters detailed breakdown
    const adx = Number((snap as any)?.adx14 ?? 0);
    const rsi = Number((snap as any)?.rsi14 ?? 50);
    const ema20 = Number((snap as any)?.ema20 ?? price);
    const ema50 = Number((snap as any)?.ema50 ?? price);
    const atrPct = Number((snap as any)?.atrPct ?? 0);
    const volume = Number((snap as any)?.volume ?? 0);
    const volumeMA = Number((snap as any)?.volumeMA ?? volume);
    const volumeRatio = volumeMA > 0 ? volume / volumeMA : 1;
    const emaSpread = ((ema20 - ema50) / ema50) * 100;

    // Individual quality filter checks
    checks.qualityFilters = {};

    // Trend alignment
    const trendAligned = bias === 'long' ? ema20 > ema50 && emaSpread > 0.5 : ema20 < ema50 && emaSpread < -0.5;
    checks.qualityFilters.trendAlignment = {
      status: trendAligned ? 'PASS' : Math.abs(emaSpread) < 0.1 ? 'REJECT' : 'PARTIAL',
      reason: `EMA spread: ${emaSpread.toFixed(3)}%, need ${bias === 'long' ? '>0.5%' : '<-0.5%'}`,
      value: emaSpread,
      points: trendAligned ? 25 : 0
    };

    // ADX check with detailed thresholds
    let adxStatus = 'FAIL';
    let adxPoints = 0;
    let adxDetails = '';
    
    if (adx >= 25) { 
      adxStatus = 'PASS'; 
      adxPoints = 30; 
      adxDetails = `ADX ${adx.toFixed(1)} (strong momentum)`;
    } else if (adx >= 20) { 
      adxStatus = 'PARTIAL'; 
      adxPoints = 20; 
      adxDetails = `ADX ${adx.toFixed(1)} (moderate momentum, need 25+ for max points)`;
    } else if (adx < 12) { 
      adxStatus = 'REJECT'; 
      adxDetails = `ADX ${adx.toFixed(1)} (too weak, minimum 12)`;
    } else {
      adxDetails = `ADX ${adx.toFixed(1)} (weak momentum, need 20+ for points)`;
    }
    
    checks.qualityFilters.momentum = {
      status: adxStatus,
      reason: adxDetails,
      value: adx,
      points: adxPoints,
      details: {
        currentADX: adx,
        thresholds: {
          minimum: 12,
          moderate: 20,
          strong: 25
        }
      }
    };

    // RSI check
    const rsiOptimal = bias === 'long' ? (rsi >= 45 && rsi <= 70) : (rsi >= 30 && rsi <= 55);
    let rsiStatus = 'FAIL';
    if (rsiOptimal) rsiStatus = 'PASS';
    else if ((bias === 'long' && rsi > 75) || (bias === 'short' && rsi < 25)) rsiStatus = 'REJECT';
    
    checks.qualityFilters.rsiPosition = {
      status: rsiStatus,
      reason: `RSI: ${rsi.toFixed(1)} (${bias} optimal: ${bias === 'long' ? '45-70' : '30-55'})`,
      value: rsi,
      points: rsiOptimal ? 15 : 0
    };

    // Volatility check with detailed info
    // Use dynamic ATR thresholds based on aggressiveness level
    const thresholds = this.effectiveEntryThresholds();
    const minAtrPct = thresholds.ENTRY_MIN_ATR_PCT;
    const goodAtrPct = Math.max(minAtrPct * 1.5, 1.0); // Scale thresholds or keep traditional good level
    const excellentAtrPct = Math.max(minAtrPct * 2.0, 1.5); // Scale thresholds or keep traditional excellent level
    
    let volPoints = 0;
    let volDetails = '';
    
    if (atrPct >= excellentAtrPct) {
      volPoints = 15;
      volDetails = `ATR ${atrPct.toFixed(2)}% (excellent volatility)`;
    } else if (atrPct >= goodAtrPct) {
      volPoints = 10;
      volDetails = `ATR ${atrPct.toFixed(2)}% (good, need ${excellentAtrPct.toFixed(2)}% for max points)`;
    } else if (atrPct >= minAtrPct) {
      volPoints = 5;
      volDetails = `ATR ${atrPct.toFixed(2)}% (acceptable, need ${goodAtrPct.toFixed(2)}% for good)`;
    } else {
      volDetails = `ATR ${atrPct.toFixed(2)}% (too low, need ${minAtrPct.toFixed(2)}% minimum)`;
    }
    
    checks.qualityFilters.volatility = {
      status: atrPct >= minAtrPct ? 'PASS' : 'FAIL',
      reason: volDetails,
      value: atrPct,
      points: volPoints,
      details: {
        currentATR: atrPct,
        thresholds: {
          minimum: minAtrPct,
          good: goodAtrPct,
          excellent: excellentAtrPct
        }
      }
    };

    // Volume check with detailed thresholds
    let volumeStatus = 'FAIL';
    let volumePoints = 0;
    let volumeDetails = '';
    
    if (volumeRatio >= 1.3) { 
      volumeStatus = 'PASS'; 
      volumePoints = 15; 
      volumeDetails = `Volume ${volumeRatio.toFixed(2)}x average (excellent)`;
    } else if (volumeRatio >= 1.1) { 
      volumeStatus = 'PARTIAL'; 
      volumePoints = 10; 
      volumeDetails = `Volume ${volumeRatio.toFixed(2)}x average (good, need 1.3x for max points)`;
    } else if (volumeRatio < 0.5) { 
      volumeStatus = 'REJECT'; 
      volumeDetails = `Volume ${volumeRatio.toFixed(2)}x average (too low, minimum 0.5x)`;
    } else {
      volumeDetails = `Volume ${volumeRatio.toFixed(2)}x average (insufficient, need 1.1x minimum)`;
    }
    
    checks.qualityFilters.volume = {
      status: volumeStatus,
      reason: volumeDetails,
      value: volumeRatio,
      points: volumePoints,
      details: {
        currentVolume: volume,
        averageVolume: volumeMA,
        ratio: volumeRatio,
        thresholds: {
          minimum: 0.5,
          good: 1.1,
          excellent: 1.3
        }
      }
    };

    // Calculate total quality score
    const totalQualityScore = (checks.qualityFilters.trendAlignment?.points || 0) + 
                             (checks.qualityFilters.momentum?.points || 0) + 
                             (checks.qualityFilters.rsiPosition?.points || 0) + 
                             (checks.qualityFilters.volatility?.points || 0) + 
                             (checks.qualityFilters.volume?.points || 0);

    // Required score based on aggressiveness
    const level = this.profile?.aggressiveness || 'conservative';
    let minScore = 55; // Conservative
    if (level === 'reactive') minScore = 45;
    if (level === 'aggressive') minScore = 35;
    
    // Learning mode adjustment
    const potentialMove = Math.abs((price - ema20) / ema20) * 100;
    const hasLowExperience = this.recentTrades.length < 20;
    let adjustedMinScore = minScore;
    
    if (potentialMove >= 1.5 && potentialMove <= 4.0 && hasLowExperience) {
      adjustedMinScore = Math.max(25, minScore - 15);
    }
    
    adjustedMinScore += this.qualityThresholdAdjustment;
    adjustedMinScore = Math.max(30, Math.min(75, adjustedMinScore));

    checks.qualityScore = {
      status: totalQualityScore >= adjustedMinScore ? 'PASS' : 'FAIL',
      reason: `Score: ${totalQualityScore}/${adjustedMinScore} required (${level} mode)`,
      current: totalQualityScore,
      required: adjustedMinScore,
      breakdown: {
        baseRequired: minScore,
        learningAdjustment: hasLowExperience && potentialMove >= 1.5 && potentialMove <= 4.0 ? -15 : 0,
        performanceAdjustment: this.qualityThresholdAdjustment,
        final: adjustedMinScore
      }
    };

    // Overall assessment
    const allChecks = [
      checks.hasPosition,
      checks.isArmed,
      checks.isEntering,
      checks.dailyTradeLimit,
      checks.consecutiveStopsLimit,
      checks.inEntryZone,
      checks.momentumGates,
      checks.qualityScore
    ];

    const rejectChecks = Object.values(checks.qualityFilters).filter((c: any) => c.status === 'REJECT');
    const failedChecks = allChecks.filter(c => c.status !== 'PASS');
    
    const canTrade = failedChecks.length === 0 && rejectChecks.length === 0;

    return {
      canTrade,
      reason: canTrade ? 'All checks passed' : `${failedChecks.length} failed checks, ${rejectChecks.length} reject conditions`,
      checks,
      summary: {
        totalChecks: allChecks.length,
        passed: allChecks.length - failedChecks.length,
        failed: failedChecks.length,
        rejected: rejectChecks.length
      }
    };
  }
}

// Singleton agent instance to be used by routes/engine
export const Agent = new ReboundRejectionAgent();
