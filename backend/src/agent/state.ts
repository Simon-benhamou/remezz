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
  userId?: string; // User ID for authenticated exchange access
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

// Advanced Performance Tracking Interfaces
interface StrategyPerformance {
  strategy: string; // 'mean_reversion', 'momentum_breakout', etc.
  bias: 'long' | 'short';
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
  avgPnL: number;
  profitRatio: number; // total profit / total loss
  maxDrawdown: number;
  consecutiveLosses: number;
  lastTradeTime: number;
  adaptationMultiplier: number; // Multiplier for ATR/ADX thresholds
}

interface PerformanceMetrics {
  symbol: string;
  totalTrades: number;
  winRate: number;
  profitRatio: number;
  maxDrawdown: number;
  dailyPnL: number;
  strategyPerformance: Map<string, StrategyPerformance>;
  circuitBreaker: {
    isActive: boolean;
    reason: string;
    activatedAt: number;
    lossThreshold: number;
    winRateThreshold: number;
  };
  adaptationState: {
    atrMultiplier: number;
    adxMultiplier: number;
    qualityThresholdAdjustment: number;
    lastUpdated: number;
  };
  biasSwitching: {
    currentBias: 'long' | 'short' | 'standby';
    lastBiasSwitch: number;
    consecutiveLosses: number;
    triggerThreshold: number;
  };
}

export class ReboundRejectionAgent {
  state: AgentState = 'IDLE';
  profile: ActivationProfile | null = null;
  plan: ValidatedPlan | null = null;
  broker: Broker | null = null;
  pos: ActivePosition | null = null;
  extendedOnce = false;
  private lastExitTime = 0; // Track last exit time for cooldown
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

  // Advanced performance tracking by strategy and bias
  private performanceMetrics: PerformanceMetrics | null = null;
  private strategyPerformance: Map<string, StrategyPerformance> = new Map();

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
      ? new LiveBroker(profile.userId || '')
      : new PaperBroker(profile.startBalanceUsd);
    this.state = 'SCAN';
    this.logMovement('Agent activated', `Mode=${profile.mode}, symbol=${profile.symbol}`, {
      tags: ['agent', 'activation'],
      context: { profile },
      severity: 'low',
    }).catch(()=>{});
    
    // Initialize adaptive ATR cache for this symbol
    if (profile.symbol) {
      this.updateAdaptiveATRCache(profile.symbol, 1.0).catch(err => 
        console.warn('Initial ATR cache update failed:', err)
      );
    }
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
        const expo = await inspectExposure(this.profile.symbol, this.profile.userId);
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
          
        // Enhanced entry logic: support both mean reversion AND breakout entries
        const shouldEnterMeanReversion = inZone && distanceFromEntry <= maxDistanceAllowed;
        
        // Allow breakout entries slightly above/below zone for better opportunity capture
        const zoneMax = Math.max(from, to);
        const zoneMin = Math.min(from, to);
        const breakoutThreshold = 0.02; // 2% maximum distance from zone edge
        
        const shouldEnterBreakout = (
          (this.plan.bias === 'long' && price > zoneMax && 
           (price - zoneMax) / price < breakoutThreshold) ||
          (this.plan.bias === 'short' && price < zoneMin && 
           (zoneMin - price) / price < breakoutThreshold)
        );
        
        if (shouldEnterMeanReversion || shouldEnterBreakout) {
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
    
    // 🚨 COOLDOWN CHECK: Prevent entries too soon after last exit
    const { TRADE_COOLDOWN_MS } = (await import('../utils/env.js')).getConfig();
    const timeSinceLastExit = Date.now() - this.lastExitTime;
    
    if (this.lastExitTime > 0 && timeSinceLastExit < TRADE_COOLDOWN_MS) {
      const cooldownRemaining = (TRADE_COOLDOWN_MS - timeSinceLastExit) / 1000;
      console.log(`⏳ Trade cooldown: ${cooldownRemaining.toFixed(0)}s remaining - skipping entry`);
      return;
    }
    
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
    // Aggressiveness-aware min profitability
    let minProfitPct = cfg.MIN_TRADE_PROFIT_PCT;
    const levelProfit = this.profile?.aggressiveness || 'conservative';
    if (levelProfit === 'reactive') minProfitPct = Math.max(0.6, minProfitPct - 0.2);
    if (levelProfit === 'aggressive') minProfitPct = Math.max(0.5, minProfitPct - 0.3);
    const firstTpProfitPct = Math.abs((tp[0] - entry) / entry) * 100;
    // Single profitability gate is enough; movement check duplicates the same quantity
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
    // Hard budget cap: limit balance used for sizing to startBalanceUsd * budget%
    const startBudget = (this.profile.startBalanceUsd && this.profile.startBalanceUsd > 0)
      ? this.profile.startBalanceUsd
      : bal.freeUsd;
    const capBalance = Math.max(0, startBudget * budgetFrac);
    const usableBalance = Math.max(0, Math.min(bal.freeUsd, availableMargin, capBalance));
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
    
    // Use plan recommended risk if current risk is invalid and plan has recommendation
    if (!(dynamicRiskPct > 0) && planRiskRecommendedPct != null) {
      dynamicRiskPct = planRiskRecommendedPct;
    }
    // Fallback to profile risk if still invalid
    if (!(dynamicRiskPct > 0)) {
      dynamicRiskPct = this.profile.riskPerTradePct;
    }
    
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
      // CRYPTO ADAPTATION: Use 4-5R targets minimum for crypto volatility
      const baseTp = side === 'buy' ? (this.pos.entry + (this.plan.stopDistance * 4)) : (this.pos.entry - (this.plan.stopDistance * 4));
      this.pos.tp = [baseTp];
    }
    if (this.pos.tp.length === 1) {
      // Runner TP at 5R for crypto
      const runnerTp = side === 'buy' ? (this.pos.entry + (this.plan.stopDistance * 5)) : (this.pos.entry - (this.plan.stopDistance * 5));
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
        stop: this.pos.stop,
        tp: this.pos.tp,
        mode: 'manual',
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
      // Wider RSI bands for crypto on reactive mode
      ENTRY_SHORT_MIN_RSI = Math.max(35, ENTRY_SHORT_MIN_RSI - 5);
      ENTRY_LONG_MAX_RSI = Math.min(75, ENTRY_LONG_MAX_RSI + 5);
    } else if (level === 'aggressive') {
      ENTRY_SHORT_MIN_ADX = Math.max(8, ENTRY_SHORT_MIN_ADX - 4);
      ENTRY_LONG_MIN_ADX = Math.max(6, ENTRY_LONG_MIN_ADX - 4);
      ENTRY_MIN_ATR_PCT = Math.max(0.15, ENTRY_MIN_ATR_PCT * 0.5); // Très flexible: 0.7 → 0.35%
      ENTRY_MIN_SLOPE_ABS_PCT = Math.max(0.006, ENTRY_MIN_SLOPE_ABS_PCT * 0.5);
      // Claude-style RSI flexibility for aggressive mode
      ENTRY_SHORT_MIN_RSI = Math.max(30, ENTRY_SHORT_MIN_RSI - 10);
      ENTRY_LONG_MAX_RSI = Math.min(80, ENTRY_LONG_MAX_RSI + 10);
    }
    return { ENTRY_SHORT_MIN_ADX, ENTRY_LONG_MIN_ADX, ENTRY_SHORT_MIN_RSI, ENTRY_LONG_MAX_RSI, ENTRY_MIN_ATR_PCT, ENTRY_MIN_SLOPE_ABS_PCT };
  }

  private static readonly adaptiveATRCache = new Map<string, { threshold: number; lastUpdated: number; baselineATR: number }>();
  private static readonly volatilityProfileCache = new Map<string, 'LOW_VOLATILITY' | 'MODERATE_VOLATILITY' | 'HIGH_VOLATILITY' | 'EXTREME_VOLATILITY'>();
  
  // 🧠 NEW: AI-Powered Dynamic Thresholds Cache System
  private static readonly dynamicThresholdsCache = new Map<string, {
    rsiZones: { long: { min: number; max: number }; short: { min: number; max: number } };
    adxThresholds: { minimum: number; moderate: number; strong: number };
    emaSpreadRequired: number;
    volatilityProfile: string;
    marketRegime: 'BULL' | 'BEAR' | 'SIDEWAYS' | 'VOLATILE';
    confidenceScore: number; // 0-1, how confident the AI is in these thresholds
    lastUpdated: number;
    dataPoints: number; // How many data points were used for analysis
    performanceScore?: number; // How well these thresholds performed historically
  }>();
  
  private static readonly intelligentVolatilityCache = new Map<string, {
    currentVolatility: number;
    volatilityTrend: 'INCREASING' | 'DECREASING' | 'STABLE';
    volumeProfile: 'HIGH' | 'NORMAL' | 'LOW';
    priceStability: number; // 0-1 score
    marketCap?: number;
    lastAnalysis: number;
    rawMetrics: {
      atr30d: number;
      volumeCV: number; // Coefficient of variation
      priceCV: number;
      trendStrength: number;
    };
  }>();
  
  private static readonly MAX_CACHE_SIZE = 200; // Limit cache size to prevent memory issues
  private static readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h cache validity
  private static readonly INTELLIGENT_CACHE_TTL_MS = 8 * 60 * 60 * 1000; // 8h for AI analysis
  private static readonly VOLATILITY_ANALYSIS_TTL_MS = 12 * 60 * 60 * 1000; // 12h for volatility metrics
  private static readonly VOLATILITY_CHANGE_THRESHOLD = 0.5; // 50% change triggers update
  private static cacheStats = { hits: 0, misses: 0, updates: 0 };
  private static intelligentCacheStats = { hits: 0, misses: 0, updates: 0, aiAnalysis: 0 };

  /*
   * Clear cache if it gets too large (maintenance)
   */
  /*
  private static clearCacheIfNeeded(): void {
    if (ReboundRejectionAgent.adaptiveATRCache.size > ReboundRejectionAgent.MAX_CACHE_SIZE) {
      console.log(`🧹 Clearing ATR cache (${ReboundRejectionAgent.adaptiveATRCache.size} entries) - Stats: ${ReboundRejectionAgent.cacheStats.hits} hits, ${ReboundRejectionAgent.cacheStats.misses} misses`);
      ReboundRejectionAgent.adaptiveATRCache.clear();
      ReboundRejectionAgent.cacheStats = { hits: 0, misses: 0 }; // Reset stats
    }
    if (ReboundRejectionAgent.volatilityProfileCache.size > ReboundRejectionAgent.MAX_CACHE_SIZE) {
      console.log(`🧹 Clearing volatility profile cache (${ReboundRejectionAgent.volatilityProfileCache.size} entries)`);
      ReboundRejectionAgent.volatilityProfileCache.clear();
    }
  }
  */

  /**
   * Check if cache needs update based on current market volatility vs cached baseline
   */
  private async shouldUpdateATRCache(symbol: string): Promise<{ needsUpdate: boolean; currentATR: number }> {
    const cached = ReboundRejectionAgent.adaptiveATRCache.get(symbol);
    
    // Get current market ATR for comparison
    let currentATR = 0;
    try {
      if (this.profile?.symbol) {
        const snapshot = await buildTechSnapshot(this.profile.symbol);
        currentATR = Number((snapshot as any)?.atrPct ?? 0);
      }
    } catch (error) {
      console.warn(`Failed to get current ATR for ${symbol}:`, error);
      // If we can't get current data, use cache if available
      if (cached) {
        return { needsUpdate: false, currentATR: cached.baselineATR };
      }
    }
    
    if (!cached) return { needsUpdate: true, currentATR }; // No cache = needs update
    
    const now = Date.now();
    const ageMs = now - cached.lastUpdated;
    
    // Force update if cache is too old (24h)
    if (ageMs > ReboundRejectionAgent.CACHE_TTL_MS) {
      console.log(`🕐 Cache expired for ${symbol} (${(ageMs / (1000 * 60 * 60)).toFixed(1)}h old)`);
      return { needsUpdate: true, currentATR };
    }
    
    // Update if volatility changed significantly
    if (cached.baselineATR > 0 && currentATR > 0) {
      const volatilityChange = Math.abs(currentATR - cached.baselineATR) / cached.baselineATR;
      if (volatilityChange > ReboundRejectionAgent.VOLATILITY_CHANGE_THRESHOLD) {
        console.log(`📈 Volatility changed significantly for ${symbol}: ${cached.baselineATR.toFixed(3)}% → ${currentATR.toFixed(3)}% (${(volatilityChange * 100).toFixed(1)}% change)`);
        return { needsUpdate: true, currentATR };
      }
    }
    
    return { needsUpdate: false, currentATR };
  }

  /**
   * Calculate dynamic entry zone based on current market conditions and bias
   */
  /**
   * Determine optimal bias based on current market context, trend strength, and key levels
   * Enhanced logic for trend continuation scenarios (rebounds on resistance, rejections on support)
   */
  private determineContextualBias(snap: TechnicalSnapshot, currentPrice: number): 'long' | 'short' | 'none' {
    const supports = snap.supports || [];
    const resistances = snap.resistances || [];
    
    // Find nearest support and resistance
    const nearestSupport = supports
      .filter(s => s.price < currentPrice)
      .sort((a, b) => Math.abs(currentPrice - b.price) - Math.abs(currentPrice - a.price))[0];
      
    const nearestResistance = resistances
      .filter(r => r.price > currentPrice)
      .sort((a, b) => Math.abs(currentPrice - a.price) - Math.abs(currentPrice - b.price))[0];
    
    const supportDistance = nearestSupport ? Math.abs(currentPrice - nearestSupport.price) / currentPrice : 1;
    const resistanceDistance = nearestResistance ? Math.abs(currentPrice - nearestResistance.price) / currentPrice : 1;
    
    // Enhanced technical analysis with trend strength evaluation
    const ema20 = Number((snap as any)?.ema20 ?? currentPrice);
    const ema50 = Number((snap as any)?.ema50 ?? currentPrice);
    const rsi = Number((snap as any)?.rsi14 ?? 50);
    const adx = Number((snap as any)?.adx14 ?? 0);
    const ema20Slope = Number((snap as any)?.ema20Slope ?? 0);
    const atrPct = Number((snap as any)?.atrPct ?? 1.0);
    
    // Calculate trend metrics
    const emaSpread = Math.abs((ema20 - ema50) / ema50) * 100;
    const trendUp = ema20 > ema50;
    const strongTrend = adx > 25 && emaSpread > 1.0; // Both ADX and EMA spread confirm trend
    const moderateTrend = adx > 15 && emaSpread > 0.5;
    const trendStrength = strongTrend ? 'strong' : moderateTrend ? 'moderate' : 'weak';
    
    // Slope direction confirmation (trend acceleration/deceleration)
    const slopeAligned = trendUp ? ema20Slope > 0 : ema20Slope < 0;
    const slopeMagnitude = Math.abs(ema20Slope / ema20) * 100; // Slope as percentage
    
    console.log(`🧠 TREND ANALYSIS: ${trendUp ? 'UP' : 'DOWN'} trend (${trendStrength}), ADX: ${adx.toFixed(1)}, EMA spread: ${emaSpread.toFixed(2)}%, Slope: ${slopeMagnitude.toFixed(3)}%`);
    
    // SCENARIO 1: Near Support - Context-dependent behavior
    if (supportDistance < 0.04 && nearestSupport) { // Increased to 4% for more opportunities
      const supportStrength = nearestSupport.touches || 1;
      const rsiOversold = rsi < 35;
      const rsiNeutral = rsi >= 35 && rsi <= 65;
      
      if (strongTrend && trendUp && slopeAligned) {
        // STRONG UPTREND: High probability support bounce
        console.log(`📈 SCENARIO: STRONG UPTREND + Support (${(supportDistance*100).toFixed(1)}%) → LONG (trend continuation bounce)`);
        return 'long';
      } else if (strongTrend && !trendUp && !slopeAligned) {
        // STRONG DOWNTREND: Support likely to break (rejection scenario)
        console.log(`📉 SCENARIO: STRONG DOWNTREND + Support (${(supportDistance*100).toFixed(1)}%) → SHORT (support break continuation)`);
        return 'short';
      } else if (supportStrength >= 2 && (rsiOversold || (rsiNeutral && moderateTrend && trendUp))) {
        // MODERATE CONDITIONS: Traditional support bounce
        console.log(`📈 SCENARIO: Support bounce (strength: ${supportStrength}, RSI: ${rsi.toFixed(1)}) → LONG`);
        return 'long';
      }
    }
    
    // SCENARIO 2: Near Resistance - Enhanced with trend continuation logic
    if (resistanceDistance < 0.04 && nearestResistance) { // Increased to 4%
      const resistanceStrength = nearestResistance.touches || 1;
      const rsiOverbought = rsi > 65;
      const rsiNeutral = rsi >= 35 && rsi <= 65;
      
      if (strongTrend && trendUp && slopeAligned) {
        // STRONG UPTREND: Resistance break scenario (continuation)
        console.log(`📈 SCENARIO: STRONG UPTREND + Resistance (${(resistanceDistance*100).toFixed(1)}%) → LONG (resistance break continuation)`);
        return 'long';
      } else if (strongTrend && !trendUp && !slopeAligned) {
        // STRONG DOWNTREND: High probability resistance rejection
        console.log(`📉 SCENARIO: STRONG DOWNTREND + Resistance (${(resistanceDistance*100).toFixed(1)}%) → SHORT (trend continuation rejection)`);
        return 'short';
      } else if (resistanceStrength >= 2 && (rsiOverbought || (rsiNeutral && moderateTrend && !trendUp))) {
        // MODERATE CONDITIONS: Traditional resistance rejection
        console.log(`📉 SCENARIO: Resistance rejection (strength: ${resistanceStrength}, RSI: ${rsi.toFixed(1)}) → SHORT`);
        return 'short';
      }
    }
    
    // SCENARIO 3: Trend Following in Middle Zone (enhanced)
    if (strongTrend && slopeAligned) {
      if (trendUp && rsi < 70 && emaSpread > 1.5) {
        console.log(`📈 SCENARIO: STRONG UPTREND continuation (ADX: ${adx.toFixed(1)}, spread: ${emaSpread.toFixed(1)}%) → LONG`);
        return 'long';
      } else if (!trendUp && rsi > 30 && emaSpread > 1.5) {
        console.log(`📉 SCENARIO: STRONG DOWNTREND continuation (ADX: ${adx.toFixed(1)}, spread: ${emaSpread.toFixed(1)}%) → SHORT`);
        return 'short';
      }
    }
    
    // SCENARIO 4: Momentum-based entries (when trend is developing)
    if (moderateTrend && slopeMagnitude > 0.05) { // Accelerating trend
      if (trendUp && rsi >= 45 && rsi <= 65) {
        console.log(`📈 SCENARIO: Developing uptrend momentum → LONG`);
        return 'long';
      } else if (!trendUp && rsi >= 35 && rsi <= 55) {
        console.log(`📉 SCENARIO: Developing downtrend momentum → SHORT`);
        return 'short';
      }
    }
    
    // SCENARIO 5: High volatility mean reversion (when no clear trend)
    if (atrPct > 3.0 && trendStrength === 'weak' && Math.abs(rsi - 50) > 15) {
      if (rsi < 35 && supportDistance < 0.06) {
        console.log(`� SCENARIO: High volatility oversold bounce → LONG`);
        return 'long';
      } else if (rsi > 65 && resistanceDistance < 0.06) {
        console.log(`📉 SCENARIO: High volatility overbought rejection → SHORT`);
        return 'short';
      }
    }
    
    console.log(`🔄 SCENARIO: CONSOLIDATION/NEUTRAL - No clear directional edge (trend: ${trendStrength}, RSI: ${rsi.toFixed(1)})`);
    return 'none';
  }  private async calculateDynamicEntryZone(snap: TechnicalSnapshot, currentPrice: number, bias: 'long' | 'short' | 'none'): Promise<{ from: number; to: number; mid: number }> {
    if (bias === 'none') {
      // No bias, create a small zone around current price
      const range = currentPrice * 0.005; // 0.5% range
      return {
        from: currentPrice - range,
        to: currentPrice + range,
        mid: currentPrice
      };
    }
    
    // Get current support and resistance levels
    const supports = snap.supports || [];
    const resistances = snap.resistances || [];
    const atrPct = Number((snap as any)?.atrPct ?? 1.0);
    
    // Calculate dynamic zone based on bias and proximity to key levels
    if (bias === 'long') {
      // LONG SCENARIO: Target support areas for bounce entries
      const nearestSupport = supports
        .filter(s => s.price < currentPrice)
        .sort((a, b) => Math.abs(currentPrice - b.price) - Math.abs(currentPrice - a.price))[0];
      
      let targetLevel = nearestSupport?.price;
      let zoneLabel = 'pullback';
      
      // If no nearby support or too far, use technical levels
      if (!targetLevel || Math.abs(currentPrice - targetLevel) / currentPrice > 0.08) {
        // Use EMA levels as dynamic support
        const ema20 = Number((snap as any)?.ema20 ?? currentPrice);
        const ema50 = Number((snap as any)?.ema50 ?? currentPrice);
        
        // Priority: EMA20 > EMA50 > calculated pullback (ensure levels are BELOW current price for LONG)
        if (currentPrice > ema20 && ema20 > 0 && (currentPrice - ema20) / currentPrice < 0.05) {
          targetLevel = ema20;
          zoneLabel = 'EMA20 support';
        } else if (currentPrice > ema50 && ema50 > 0 && (currentPrice - ema50) / currentPrice < 0.08) {
          targetLevel = ema50;
          zoneLabel = 'EMA50 support';
        } else {
          // Calculate optimal pullback level (2-4% based on volatility) - BELOW current price
          const pullbackPct = Math.max(0.02, Math.min(0.04, atrPct / 100));
          targetLevel = currentPrice * (1 - pullbackPct);
          zoneLabel = `${(pullbackPct*100).toFixed(1)}% pullback`;
        }
      } else {
        zoneLabel = 'support bounce';
      }
      
      // Validation: Ensure LONG targetLevel is BELOW current price
      if (targetLevel >= currentPrice) {
        console.warn(`⚠️ LONG bias inconsistency: targetLevel ${targetLevel.toFixed(4)} >= currentPrice ${currentPrice.toFixed(4)}, forcing pullback below`);
        const fallbackPullbackPct = 0.025; // 2.5% below
        targetLevel = currentPrice * (1 - fallbackPullbackPct);
        zoneLabel = 'fallback pullback (corrected)';
      }
      
      // Create zone around target level with adaptive width
      const baseWidth = Math.max(targetLevel * 0.005, targetLevel * (atrPct / 100) * 0.3); // Min 0.5% or 30% of ATR
      const supportStrength = nearestSupport?.touches || 1;
      const strengthMultiplier = Math.min(1.5, 1 + (supportStrength - 1) * 0.2); // Stronger support = wider zone
      const zoneWidth = baseWidth * strengthMultiplier;
      
      console.log(`📈 LONG entry zone: ${zoneLabel} at ${targetLevel.toFixed(4)} ±${zoneWidth.toFixed(4)}`);
      
      return {
        from: targetLevel - zoneWidth,
        to: targetLevel + zoneWidth,
        mid: targetLevel
      };
      
    } else if (bias === 'short') {
      // SHORT SCENARIO: Target resistance areas for rejection entries
      const nearestResistance = resistances
        .filter(r => r.price > currentPrice)
        .sort((a, b) => Math.abs(currentPrice - a.price) - Math.abs(currentPrice - b.price))[0];
      
      let targetLevel = nearestResistance?.price;
      let zoneLabel = 'bounce';
      
      // If no nearby resistance or too far, use technical levels
      if (!targetLevel || Math.abs(currentPrice - targetLevel) / currentPrice > 0.08) {
        // Use EMA levels as dynamic resistance
        const ema20 = Number((snap as any)?.ema20 ?? currentPrice);
        const ema50 = Number((snap as any)?.ema50 ?? currentPrice);
        
        // Priority: EMA20 > EMA50 > calculated bounce (ensure levels are ABOVE current price for SHORT)
        if (currentPrice < ema20 && ema20 > 0 && (ema20 - currentPrice) / currentPrice < 0.05) {
          targetLevel = ema20;
          zoneLabel = 'EMA20 resistance';
        } else if (currentPrice < ema50 && ema50 > 0 && (ema50 - currentPrice) / currentPrice < 0.08) {
          targetLevel = ema50;
          zoneLabel = 'EMA50 resistance';
        } else {
          // Calculate optimal bounce level (2-4% based on volatility) - ABOVE current price
          const bouncePct = Math.max(0.02, Math.min(0.04, atrPct / 100));
          targetLevel = currentPrice * (1 + bouncePct);
          zoneLabel = `${(bouncePct*100).toFixed(1)}% bounce`;
        }
      } else {
        zoneLabel = 'resistance rejection';
      }
      
      // Validation: Ensure SHORT targetLevel is ABOVE current price
      if (targetLevel <= currentPrice) {
        console.warn(`⚠️ SHORT bias inconsistency: targetLevel ${targetLevel.toFixed(4)} <= currentPrice ${currentPrice.toFixed(4)}, forcing bounce above`);
        const fallbackBouncePct = 0.025; // 2.5% above
        targetLevel = currentPrice * (1 + fallbackBouncePct);
        zoneLabel = 'fallback bounce (corrected)';
      }
      
      // Create zone around target level with adaptive width
      const baseWidth = Math.max(targetLevel * 0.005, targetLevel * (atrPct / 100) * 0.3); // Min 0.5% or 30% of ATR
      const resistanceStrength = nearestResistance?.touches || 1;
      const strengthMultiplier = Math.min(1.5, 1 + (resistanceStrength - 1) * 0.2); // Stronger resistance = wider zone
      const zoneWidth = baseWidth * strengthMultiplier;
      
      console.log(`📉 SHORT entry zone: ${zoneLabel} at ${targetLevel.toFixed(4)} ±${zoneWidth.toFixed(4)}`);
      
      return {
        from: targetLevel - zoneWidth,
        to: targetLevel + zoneWidth,
        mid: targetLevel
      };
    }
    
    // Fallback: small zone around current price
    const range = currentPrice * 0.01; // 1% range
    return {
      from: currentPrice - range,
      to: currentPrice + range,
      mid: currentPrice
    };
  }

  /**
   * Public method to test ATR thresholds for debugging
   */
  public testAdaptiveATRThreshold(symbol: string, baseThreshold: number): number {
    return this.getAdaptiveATRThresholdSync(symbol, baseThreshold);
  }

  /**
   * Public method to test dynamic entry zone calculation for debugging
   */
  public async testCalculateDynamicEntryZone(snap: TechnicalSnapshot, currentPrice: number, bias: 'long' | 'short' | 'none'): Promise<{ from: number; to: number; mid: number }> {
    return this.calculateDynamicEntryZone(snap, currentPrice, bias);
  }

  /**
   * Synchronous version that uses cached values (for momentum gates and quality filters)
   */
  private getAdaptiveATRThresholdSync(symbol: string, baseThreshold: number): number {
    if (!symbol) return baseThreshold;
    
    const baseCrypto = symbol.split('/')[0]?.toUpperCase();
    if (!baseCrypto) return baseThreshold;
    
    // Check cache first
    const cached = ReboundRejectionAgent.adaptiveATRCache.get(symbol);
    if (cached) {
      const now = Date.now();
      const ageMs = now - cached.lastUpdated;
      
      // Use cache if not too old (prefer slightly stale data over blocking)
      if (ageMs < ReboundRejectionAgent.CACHE_TTL_MS * 2) { // 48h tolerance for sync calls
        ReboundRejectionAgent.cacheStats.hits++;
        return cached.threshold;
      }
    }
    
    // Fallback to static classification if no cache
    let adaptiveThreshold = baseThreshold;
    
    // Static classification by crypto type
    switch (baseCrypto) {
      case 'CRO':
      case 'ADA': 
      case 'XRP':
      case 'TRX':
      case 'MATIC':
      case 'DOT':
        adaptiveThreshold = Math.max(0.15, baseThreshold * 0.3); // Low volatility
        break;
        
      case 'ETH':
      case 'SOL':
      case 'LINK':
      case 'UNI':
      case 'AVAX':
        adaptiveThreshold = Math.max(0.25, baseThreshold * 0.5); // Moderate volatility
        break;
        
      case 'DOGE':
      case 'SHIB':
      case 'PEPE':
      case 'AVNT':
      case 'WIF':
        adaptiveThreshold = Math.max(0.4, baseThreshold * 0.7); // High volatility
        break;
        
      case 'BTC':
      case 'BCH':
        adaptiveThreshold = baseThreshold; // Bitcoin family
        break;
        
      default:
        adaptiveThreshold = Math.max(0.25, baseThreshold * 0.5); // Unknown cryptos
        break;
    }
    
    // Apply performance-based adaptation multipliers
    if (this.performanceMetrics && this.plan) {
      const strategy = this.plan.bias || 'long';
      const bias = strategy === 'long' ? 'long' : 'short';
      const multipliers = this.getAdaptationMultipliers(strategy, bias);
      
      // Apply ATR multiplier based on strategy performance
      adaptiveThreshold *= multipliers.atr;
      
      console.log(`🎯 Performance-adapted ATR for ${symbol} (${strategy}_${bias}): ${baseThreshold.toFixed(3)}% → ${adaptiveThreshold.toFixed(3)}% (multiplier: ${multipliers.atr.toFixed(2)})`);
    }
    
    return adaptiveThreshold;
  }

  /**
   * Public method to force update adaptive ATR cache for a symbol
   */
  public async forceUpdateAdaptiveATR(symbol: string): Promise<void> {
    if (!symbol) return;
    try {
      await this.updateAdaptiveATRCache(symbol, 1.0);
    } catch (err) {
      console.error('Error forcing adaptive ATR update:', err);
    }
  }

  /**
   * Async version for cache updates (called periodically or on demand)
   */
  async updateAdaptiveATRCache(symbol: string, baseThreshold: number): Promise<void> {
    if (!symbol) return;
    
    const baseCrypto = symbol.split('/')[0]?.toUpperCase();
    if (!baseCrypto) return;
    
    // Check if we need to update cache
    const { needsUpdate, currentATR } = await this.shouldUpdateATRCache(symbol);
    const cached = ReboundRejectionAgent.adaptiveATRCache.get(symbol);
    
    if (cached && !needsUpdate) {
      return; // No update needed
    }
    
    // Calculate new adaptive threshold (same logic as sync version)
    let adaptiveThreshold = this.getAdaptiveATRThresholdSync(symbol, baseThreshold);
    
    // Dynamic adjustment based on recent market conditions
    if (currentATR > 0) {
      // If current volatility is very high, be more permissive
      if (currentATR > 3.0) {
        adaptiveThreshold *= 1.2; // 20% higher threshold in extreme volatility
      }
      // If current volatility is very low, be more strict
      else if (currentATR < 0.5) {
        adaptiveThreshold *= 0.8; // 20% lower threshold in low volatility
      }
    }
    
    // Update cache with new data
    ReboundRejectionAgent.adaptiveATRCache.set(symbol, {
      threshold: adaptiveThreshold,
      lastUpdated: Date.now(),
      baselineATR: currentATR
    });
    
    ReboundRejectionAgent.cacheStats.misses++;
    if (needsUpdate && cached) {
      ReboundRejectionAgent.cacheStats.updates++;
      console.log(`🔄 Updated ATR threshold for ${symbol}: ${cached.threshold.toFixed(3)}% → ${adaptiveThreshold.toFixed(3)}%`);
    }
    
    // Clear cache if it gets too large
    if (ReboundRejectionAgent.adaptiveATRCache.size > ReboundRejectionAgent.MAX_CACHE_SIZE) {
      this.clearOldCacheEntries();
    }
  }

  /**
   * Clear old cache entries based on LRU and age
   */
  private clearOldCacheEntries(): void {
    const now = Date.now();
    const entries = Array.from(ReboundRejectionAgent.adaptiveATRCache.entries());
    
    // Sort by age (oldest first)
    entries.sort((a, b) => a[1].lastUpdated - b[1].lastUpdated);
    
    // Remove oldest 25% of entries
    const toRemove = Math.floor(entries.length * 0.25);
    for (let i = 0; i < toRemove; i++) {
      ReboundRejectionAgent.adaptiveATRCache.delete(entries[i][0]);
    }
    
    console.log(`🧹 Cleared ${toRemove} old ATR cache entries (${ReboundRejectionAgent.adaptiveATRCache.size} remaining)`);
  }

  /**
   * Get cache statistics for monitoring
   */
  static getATRCacheStats() {
    const cacheSize = ReboundRejectionAgent.adaptiveATRCache.size;
    const hitRate = ReboundRejectionAgent.cacheStats.hits + ReboundRejectionAgent.cacheStats.misses > 0 
      ? (ReboundRejectionAgent.cacheStats.hits / (ReboundRejectionAgent.cacheStats.hits + ReboundRejectionAgent.cacheStats.misses) * 100)
      : 0;
    
    return {
      cacheSize,
      hits: ReboundRejectionAgent.cacheStats.hits,
      misses: ReboundRejectionAgent.cacheStats.misses,
      updates: ReboundRejectionAgent.cacheStats.updates,
      hitRate: hitRate.toFixed(1) + '%',
      maxSize: ReboundRejectionAgent.MAX_CACHE_SIZE
    };
  }

  /*
   * AI-powered crypto volatility classification (cached for performance)
   */
  /*
  private classifyCryptoVolatility(baseCrypto: string): 'LOW_VOLATILITY' | 'MODERATE_VOLATILITY' | 'HIGH_VOLATILITY' | 'EXTREME_VOLATILITY' {
    // Check cache first - these classifications are static
    if (ReboundRejectionAgent.volatilityProfileCache.has(baseCrypto)) {
      return ReboundRejectionAgent.volatilityProfileCache.get(baseCrypto)!;
    }
    
    // Simplified robust classification without complex Sets
    const crypto = baseCrypto.toUpperCase();
    let profile: 'LOW_VOLATILITY' | 'MODERATE_VOLATILITY' | 'HIGH_VOLATILITY' | 'EXTREME_VOLATILITY';
    
    // Low volatility - stablecoins and large caps
    if (crypto === 'CRO' || crypto === 'BNB' || crypto === 'ADA' || crypto === 'XRP' || 
        crypto === 'TRX' || crypto === 'MATIC' || crypto === 'DOT' || crypto === 'ALGO' ||
        crypto === 'ATOM' || crypto === 'XLM' || crypto === 'LTC' || crypto === 'AVAX') {
      profile = 'LOW_VOLATILITY';
    }
    // Moderate volatility - established protocols  
    else if (crypto === 'ETH' || crypto === 'SOL' || crypto === 'LINK' || crypto === 'UNI' ||
        crypto === 'AAVE' || crypto === 'COMP' || crypto === 'ARB' || crypto === 'OP' ||
        crypto === 'APT' || crypto === 'SUI' || crypto === 'NEAR' || crypto === 'ICP') {
      profile = 'MODERATE_VOLATILITY';
    }
    // High volatility - meme coins and smaller caps
    else if (crypto === 'DOGE' || crypto === 'SHIB' || crypto === 'PEPE' || crypto === 'BONK' ||
        crypto === 'AVNT' || crypto === 'GMX' || crypto === 'INJ' || crypto === 'WIF') {
      profile = 'HIGH_VOLATILITY';
    }
    // Extreme volatility - Bitcoin and very speculative
    else if (crypto === 'BTC' || crypto === 'BCH' || crypto === 'BSV') {
      profile = 'EXTREME_VOLATILITY';
    }
    // Default for unknown cryptos
    else {
      profile = 'MODERATE_VOLATILITY';
    }
    
    // Cache the result for future use
    ReboundRejectionAgent.volatilityProfileCache.set(baseCrypto, profile);
    
    return profile;
  }
  */

  /**
   * 🧠 AI-Powered Adaptive RSI zones with intelligent caching
   * Analyzes real market data instead of hardcoded classifications
   */
  private async getIntelligentRSIZones(symbol: string, bias: 'long' | 'short'): Promise<{ min: number; max: number }> {
    const cached = await this.getIntelligentThresholds(symbol);
    return bias === 'long' ? cached.rsiZones.long : cached.rsiZones.short;
  }

  /**
   * 🧠 AI-Powered Adaptive ADX thresholds with market regime analysis
   */
  private async getIntelligentADXThresholds(symbol: string): Promise<{ minimum: number; moderate: number; strong: number }> {
    const cached = await this.getIntelligentThresholds(symbol);
    return cached.adxThresholds;
  }

  /**
   * 🧠 AI-Powered Adaptive EMA spread with volatility analysis
   */
  private async getIntelligentEMASpread(symbol: string): Promise<number> {
    const cached = await this.getIntelligentThresholds(symbol);
    return cached.emaSpreadRequired;
  }

  /**
   * 🧠 Core AI Analysis Engine - Analyzes market data to determine optimal thresholds
   */
  private async getIntelligentThresholds(symbol: string): Promise<{
    rsiZones: { long: { min: number; max: number }; short: { min: number; max: number } };
    adxThresholds: { minimum: number; moderate: number; strong: number };
    emaSpreadRequired: number;
    volatilityProfile: string;
    marketRegime: 'BULL' | 'BEAR' | 'SIDEWAYS' | 'VOLATILE';
    confidenceScore: number;
  }> {
    // Check intelligent cache first
    const cached = ReboundRejectionAgent.dynamicThresholdsCache.get(symbol);
    const now = Date.now();
    
    if (cached && (now - cached.lastUpdated) < ReboundRejectionAgent.INTELLIGENT_CACHE_TTL_MS) {
      ReboundRejectionAgent.intelligentCacheStats.hits++;
      console.log(`🧠 AI Cache HIT for ${symbol} (age: ${((now - cached.lastUpdated) / (60 * 60 * 1000)).toFixed(1)}h, confidence: ${cached.confidenceScore.toFixed(2)})`);
      return cached;
    }

    // Perform AI analysis
    console.log(`🧠 Performing AI market analysis for ${symbol}...`);
    ReboundRejectionAgent.intelligentCacheStats.aiAnalysis++;
    
    try {
      // Step 1: Analyze volatility metrics with extended data
      const volatilityMetrics = await this.analyzeIntelligentVolatility(symbol);
      
      // Step 2: Detect market regime (bull/bear/sideways)
      const marketRegime = await this.detectAIMarketRegime(symbol);
      
      // Step 3: Calculate optimal thresholds based on analysis
      const analysis = await this.calculateOptimalThresholds(symbol, volatilityMetrics, marketRegime);
      
      console.log(`🧠 AI Analysis complete for ${symbol}: ${analysis.volatilityProfile} profile, ${marketRegime} regime, ${analysis.confidenceScore.toFixed(2)} confidence`);
      
      // Cache the results
      ReboundRejectionAgent.dynamicThresholdsCache.set(symbol, {
        ...analysis,
        marketRegime,
        lastUpdated: now,
        dataPoints: 100, // We analyzed significant data
      });
      
      ReboundRejectionAgent.intelligentCacheStats.updates++;
      return { ...analysis, marketRegime };
      
    } catch (error) {
      console.error(`❌ AI Analysis failed for ${symbol}, falling back to static thresholds:`, error);
      
      // Fallback to enhanced static analysis
      return this.getEnhancedStaticThresholds(symbol);
    }
  }

  /**
   * 🧠 Analyzes intelligent volatility metrics using market data
   */
  private async analyzeIntelligentVolatility(symbol: string): Promise<any> {
    const cached = ReboundRejectionAgent.intelligentVolatilityCache.get(symbol);
    const now = Date.now();
    
    if (cached && (now - cached.lastAnalysis) < ReboundRejectionAgent.VOLATILITY_ANALYSIS_TTL_MS) {
      return cached;
    }

    try {
      // Get extended technical data for analysis
      const { buildTechSnapshot } = await import('../ai/tech.js');
      const { getOHLCV } = await import('../data/market.js');
      const snap = await buildTechSnapshot(symbol);
      
      // Get 30-day data for comprehensive analysis
      const ohlcv30d = await getOHLCV(symbol, '1d', 30);
      
      if (!ohlcv30d || ohlcv30d.length < 10) {
        throw new Error('Insufficient historical data');
      }
      
      // Calculate comprehensive volatility metrics
      const closes = ohlcv30d.map(bar => bar[4]);
      const volumes = ohlcv30d.map(bar => Number(bar[5] || 0));
      
      // Calculate ATR 30-day average
      const { atr } = await import('../data/indicators.js');
      const atr30dArray = atr(ohlcv30d, 14);
      const atr30d = atr30dArray[atr30dArray.length - 1] || 0;
      const atr30dPct = (atr30d / snap.last) * 100;
      
      // Price stability (coefficient of variation)
      const priceMean = closes.reduce((sum, p) => sum + p, 0) / closes.length;
      const priceStdDev = Math.sqrt(closes.reduce((sum, p) => sum + Math.pow(p - priceMean, 2), 0) / closes.length);
      const priceCV = priceStdDev / priceMean;
      
      // Volume stability
      const volumeMean = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
      const volumeStdDev = Math.sqrt(volumes.reduce((sum, v) => sum + Math.pow(v - volumeMean, 2), 0) / volumes.length);
      const volumeCV = volumeStdDev / volumeMean;
      
      // Determine volatility profile based on real metrics
      let currentVolatility = 'MODERATE';
      if (atr30dPct > 4.0 || priceCV > 0.15) currentVolatility = 'HIGH';
      else if (atr30dPct < 1.5 && priceCV < 0.05) currentVolatility = 'LOW';
      
      const analysis = {
        currentVolatility: atr30dPct,
        volatilityTrend: (priceCV > 0.1 ? 'INCREASING' : priceCV < 0.05 ? 'DECREASING' : 'STABLE') as 'INCREASING' | 'DECREASING' | 'STABLE',
        volumeProfile: (volumeCV > 0.8 ? 'HIGH' : volumeCV < 0.3 ? 'LOW' : 'NORMAL') as 'HIGH' | 'NORMAL' | 'LOW',
        priceStability: Math.max(0, 1 - priceCV), // Higher = more stable
        lastAnalysis: now,
        rawMetrics: {
          atr30d: atr30dPct,
          volumeCV,
          priceCV,
          trendStrength: snap.adx14 || 0
        }
      };
      
      ReboundRejectionAgent.intelligentVolatilityCache.set(symbol, analysis);
      console.log(`📊 Volatility analysis for ${symbol}: ATR ${atr30dPct.toFixed(2)}%, CV ${priceCV.toFixed(3)}, Profile: ${currentVolatility}`);
      
      return analysis;
      
    } catch (error) {
      console.error(`❌ Volatility analysis failed for ${symbol}:`, error);
      // Return basic fallback
      return {
        currentVolatility: 2.0,
        volatilityTrend: 'STABLE',
        volumeProfile: 'NORMAL',
        priceStability: 0.7,
        lastAnalysis: now,
        rawMetrics: { atr30d: 2.0, volumeCV: 0.5, priceCV: 0.1, trendStrength: 15 }
      };
    }
  }

  /**
   * 🧠 Detects market regime for AI analysis (bull/bear/sideways) using technical analysis
   */
  private async detectAIMarketRegime(symbol: string): Promise<'BULL' | 'BEAR' | 'SIDEWAYS' | 'VOLATILE'> {
    try {
      const { buildTechSnapshot } = await import('../ai/tech.js');
      const snap = await buildTechSnapshot(symbol);
      
      const emaSpread = ((snap.ema20 - snap.ema50) / snap.ema50) * 100;
      const adx = snap.adx14 || 0;
      const rsi = snap.rsi14 || 50;
      const atrPct = snap.atrPct || 0;
      
      // Regime detection logic
      if (atrPct > 4.0 && adx < 20) return 'VOLATILE'; // High volatility, low trend
      if (emaSpread > 2.0 && adx > 20 && rsi > 55) return 'BULL'; // Strong uptrend
      if (emaSpread < -2.0 && adx > 20 && rsi < 45) return 'BEAR'; // Strong downtrend
      return 'SIDEWAYS'; // Consolidation
      
    } catch (error) {
      console.error(`❌ Market regime detection failed for ${symbol}:`, error);
      return 'SIDEWAYS';
    }
  }

  /**
   * 🧠 Calculates optimal thresholds based on AI analysis
   */
  private async calculateOptimalThresholds(symbol: string, volatilityMetrics: any, marketRegime: string): Promise<any> {
    const atr = volatilityMetrics.rawMetrics.atr30d;
    const priceCV = volatilityMetrics.rawMetrics.priceCV;
    const trendStrength = volatilityMetrics.rawMetrics.trendStrength;
    
    // AI-driven threshold calculation
    let volatilityProfile = 'MODERATE';
    if (atr > 4.0 || priceCV > 0.15) volatilityProfile = 'HIGH_VOLATILITY';
    else if (atr < 1.5 && priceCV < 0.05) volatilityProfile = 'LOW_VOLATILITY';
    
    // Calculate RSI zones based on volatility and regime
    const rsiAdjustment = marketRegime === 'VOLATILE' ? 10 : marketRegime === 'BULL' ? 5 : 0;
    let rsiZones;
    
    if (volatilityProfile === 'HIGH_VOLATILITY') {
      rsiZones = {
        long: { min: 30 + rsiAdjustment, max: 80 },
        short: { min: 20, max: 70 - rsiAdjustment }
      };
    } else if (volatilityProfile === 'LOW_VOLATILITY') {
      rsiZones = {
        long: { min: 45, max: 65 },
        short: { min: 35, max: 55 }
      };
    } else {
      rsiZones = {
        long: { min: 40, max: 70 },
        short: { min: 30, max: 60 }
      };
    }
    
    // Calculate ADX thresholds
    const adxBase = volatilityProfile === 'HIGH_VOLATILITY' ? [8, 14, 20] : 
                    volatilityProfile === 'LOW_VOLATILITY' ? [15, 22, 30] : [12, 18, 25];
    
    const adxThresholds = {
      minimum: adxBase[0],
      moderate: adxBase[1],
      strong: adxBase[2]
    };
    
    // Calculate EMA spread requirement
    const baseSpread = 0.5;
    const spreadMultiplier = volatilityProfile === 'HIGH_VOLATILITY' ? 1.5 : 
                            volatilityProfile === 'LOW_VOLATILITY' ? 0.7 : 1.0;
    const emaSpreadRequired = baseSpread * spreadMultiplier;
    
    // Confidence score based on data quality
    const confidenceScore = Math.min(1.0, 
      0.7 + // Base confidence
      (volatilityMetrics.priceStability * 0.2) + // Data stability bonus
      (trendStrength > 15 ? 0.1 : 0) // Trend clarity bonus
    );
    
    return {
      rsiZones,
      adxThresholds,
      emaSpreadRequired,
      volatilityProfile,
      confidenceScore
    };
  }

  /**
   * 🧠 Synchronous intelligent EMA spread for diagnostics
   */
  private getIntelligentEMASpreadSync(symbol: string): number {
    const profile = this.getCryptoVolatilityProfile(symbol);
    const baseSpread = 0.5;
    
    // Simple intelligent logic without async complexity
    switch (profile) {
      case 'HIGH_VOLATILITY': // AVNT
        return baseSpread * 1.5; // 0.75% pour les volatiles
      case 'LOW_VOLATILITY': // BTC
        return baseSpread * 0.7; // 0.35% pour les stables
      default:
        return baseSpread; // 0.5% standard
    }
  }

  /**
   * 🧠 Synchronous intelligent ADX thresholds for diagnostics
   */
  private getIntelligentADXThresholdsSync(symbol: string): { minimum: number; moderate: number; strong: number } {
    const profile = this.getCryptoVolatilityProfile(symbol);
    
    let thresholds = { minimum: 12, moderate: 18, strong: 25 }; // Standard defaults
    
    switch (profile) {
      case 'HIGH_VOLATILITY': // AVNT, volatiles
        thresholds = { minimum: 10, moderate: 16, strong: 22 }; // Plus bas pour volatiles
        break;
      case 'LOW_VOLATILITY': // BTC, majors
        thresholds = { minimum: 15, moderate: 20, strong: 28 }; // Plus haut pour stables
        break;
      default:
        thresholds = { minimum: 12, moderate: 18, strong: 25 }; // Standard
        break;
    }
    
    // Apply performance-based adaptation multipliers
    if (this.performanceMetrics && this.plan) {
      const strategy = this.plan.bias || 'long';
      const bias = strategy === 'long' ? 'long' : 'short';
      const multipliers = this.getAdaptationMultipliers(strategy, bias);
      
      // Apply ADX multiplier based on strategy performance
      thresholds.minimum *= multipliers.adx;
      thresholds.moderate *= multipliers.adx;
      thresholds.strong *= multipliers.adx;
      
      console.log(`🎯 Performance-adapted ADX for ${symbol} (${strategy}_${bias}): min=${thresholds.minimum.toFixed(1)}, mod=${thresholds.moderate.toFixed(1)}, str=${thresholds.strong.toFixed(1)} (multiplier: ${multipliers.adx.toFixed(2)})`);
    }
    
    return thresholds;
  }

  /**
   * 🧠 Synchronous intelligent RSI zones for diagnostics
   */
  private getIntelligentRSIZonesSync(symbol: string, bias: 'long' | 'short'): { min: number; max: number } {
    const profile = this.getCryptoVolatilityProfile(symbol);
    
    if (bias === 'long') {
      switch (profile) {
        case 'HIGH_VOLATILITY': // AVNT, DOGE, meme coins
          return { min: 35, max: 75 }; // Plus large pour cryptos volatiles
        case 'LOW_VOLATILITY': // BTC, majors
          return { min: 45, max: 65 }; // Plus serré pour stables
        default:
          return { min: 40, max: 70 }; // Standard
      }
    } else { // short bias
      switch (profile) {
        case 'HIGH_VOLATILITY':
          return { min: 25, max: 65 }; // Plus large pour volatiles
        case 'LOW_VOLATILITY':
          return { min: 35, max: 55 }; // Plus serré
        default:
          return { min: 30, max: 60 }; // Standard
      }
    }
  }

  /**
   * 🧠 Enhanced static thresholds as fallback
   */
  private getEnhancedStaticThresholds(symbol: string): any {
    const profile = this.getCryptoVolatilityProfile(symbol);
    
    return {
      rsiZones: {
        long: profile === 'HIGH_VOLATILITY' ? { min: 35, max: 75 } : 
              profile === 'LOW_VOLATILITY' ? { min: 45, max: 65 } : { min: 40, max: 70 },
        short: profile === 'HIGH_VOLATILITY' ? { min: 25, max: 65 } : 
               profile === 'LOW_VOLATILITY' ? { min: 35, max: 55 } : { min: 30, max: 60 }
      },
      adxThresholds: profile === 'HIGH_VOLATILITY' ? { minimum: 10, moderate: 16, strong: 22 } :
                     profile === 'LOW_VOLATILITY' ? { minimum: 15, moderate: 20, strong: 28 } :
                     { minimum: 12, moderate: 18, strong: 25 },
      emaSpreadRequired: profile === 'HIGH_VOLATILITY' ? 0.75 : 
                        profile === 'LOW_VOLATILITY' ? 0.35 : 0.5,
      volatilityProfile: profile,
      confidenceScore: 0.6
    };
  }

  /**
   * Helper method to get crypto volatility profile (reusing existing logic)
   */
  private getCryptoVolatilityProfile(symbol: string): 'HIGH_VOLATILITY' | 'MODERATE' | 'LOW_VOLATILITY' {
    const baseCrypto = symbol.split('/')[0]?.toUpperCase();
    if (!baseCrypto) return 'MODERATE';
    
    // Reuse existing volatility classification logic
    if (['AVNT', 'DOGE', 'SHIB', 'PEPE', 'FLOKI', 'WIF', 'BONK'].includes(baseCrypto)) {
      return 'HIGH_VOLATILITY';
    }
    if (['BTC', 'USDC', 'USDT', 'DAI'].includes(baseCrypto)) {
      return 'LOW_VOLATILITY';
    }
    return 'MODERATE'; // ETH, BNB, ADA, etc.
  }

  private passesEntryMomentumGates(snap: TechnicalSnapshot, reasonHint: 'enter'|'reverse'): boolean {
    const thresholds = this.effectiveEntryThresholds();
    let minAtr = thresholds.ENTRY_MIN_ATR_PCT;
    let minSlopeAbsPct = thresholds.ENTRY_MIN_SLOPE_ABS_PCT;

    // 🚨 CIRCUIT BREAKER CHECK: Prevent new entries if circuit breaker is active
    if (this.performanceMetrics?.circuitBreaker?.isActive) {
      recordOpsEvent({
        level: 'warn',
        source: 'circuit_breaker',
        message: 'entry_blocked_circuit_breaker',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: {
          reason: this.performanceMetrics.circuitBreaker.reason,
          activatedAt: this.performanceMetrics.circuitBreaker.activatedAt,
          reasonHint
        },
      });
      return false;
    }

    // 🔄 BIAS SWITCHING CHECK: Ensure plan bias matches performance-recommended bias
    const planBias = this.plan?.bias;
    const recommendedBias = this.performanceMetrics?.biasSwitching?.currentBias;
    if (planBias && recommendedBias && planBias !== recommendedBias && planBias !== 'none') return false;

    // Intelligent per-crypto ATR threshold adaptation
    try {
      const sym = this.profile?.symbol || '';
      const adaptedMinAtr = this.getAdaptiveATRThresholdSync(sym, minAtr);
      if (adaptedMinAtr !== minAtr) {
        console.log(`🎯 Adaptive ATR for ${sym}: ${minAtr.toFixed(3)}% → ${adaptedMinAtr.toFixed(3)}%`);
        minAtr = adaptedMinAtr;
      }
      // Trigger async cache update in background (don't await)
      this.updateAdaptiveATRCache(sym, minAtr).catch(err => 
        console.warn('Background ATR cache update failed:', err)
      );
    } catch (error) {
      console.error('Error in adaptive ATR calculation:', error);
    }

    const atrPct = Number((snap as any)?.atrPct ?? 0);

    // Basic ATR check with simple flexibility
    if (atrPct < minAtr) {
      const adx = Number((snap as any)?.adx14 ?? 0);
      const ema20 = Number((snap as any)?.ema20 ?? snap.last);
      const ema50 = Number((snap as any)?.ema50 ?? snap.last);
      const bias: 'long'|'short' = (this.plan as any)?.bias || 'long';

      // Simple quality assessment
      const emaSpread = ((ema20 - ema50) / ema50) * 100;
      const trendAligned = bias === 'long' ? ema20 > ema50 && emaSpread > 0.5 : ema20 < ema50 && emaSpread < -0.5;
      const strongAdx = adx >= 25;
      const atrDeficit = minAtr - atrPct;

      // Allow ATR flexibility only for high-quality setups
      const allowFlexibility = trendAligned && strongAdx && atrDeficit <= 0.5;

      if (!allowFlexibility) {
        recordOpsEvent({
          level: 'info',
          source: 'entry_gate',
          message: 'atr_too_low',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { atrPct, min: minAtr, reason: reasonHint },
        });
        return false;
      }
    }

    // Basic slope check
    const emaVal = Number((snap as any)?.ema20 ?? snap.last ?? 0);
    const emaSlope = Number((snap as any)?.ema20Slope ?? 0);
    const slopePctAbs = emaVal !== 0 ? Math.abs((emaSlope / emaVal) * 100) : 0;
    const bias = this.plan?.bias || 'none';

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

  // Simplified quality filters - keep only essential indicators: EMA20/50, RSI, ATR, ADX, volume
  private passesQualityFilters(snap: TechnicalSnapshot): boolean {
    if (!this.plan) return false;
    const price = snap.last;
    const bias = this.plan.bias;
    if (bias === 'none') return false;

    const cfg = getConfig();
    const adx = Number((snap as any)?.adx14 ?? 0);
    const rsi = Number((snap as any)?.rsi14 ?? 50);
    const ema20 = Number((snap as any)?.ema20 ?? price);
    const ema50 = Number((snap as any)?.ema50 ?? price);
    const atrPct = Number((snap as any)?.atrPct ?? 0);
    const volume = Number((snap as any)?.volume ?? 0);
    const volumeMA = Number((snap as any)?.volumeMA ?? (snap as any)?.volumeAvg ?? volume);

    // 1. EMA Trend Alignment (required)
    const emaSpread = ((ema20 - ema50) / ema50) * 100;
    const trendAligned = bias === 'long' ? ema20 > ema50 && emaSpread > 0.5 : ema20 < ema50 && emaSpread < -0.5;
    if (!trendAligned) {
      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'ema_trend_misaligned',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { emaSpread, bias },
      });
      return false;
    }

    // 2. ADX Trend Strength (required)
    if (adx < 20) {
      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'adx_too_weak',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { adx, bias },
      });
      return false;
    }

    // 3. RSI Position (required)
    const rsiOptimal = bias === 'long' ? (rsi >= 40 && rsi <= 75) : (rsi >= 25 && rsi <= 60);
    if (!rsiOptimal) {
      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'rsi_out_of_range',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { rsi, bias },
      });
      return false;
    }

    // 4. ATR Volatility (required)
    if (atrPct < 0.5) {
      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'atr_too_low',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { atrPct, bias },
      });
      return false;
    }

    // 5. Volume Confirmation (required)
    const volumeRatio = volumeMA > 0 ? volume / volumeMA : 1;
    if (volumeRatio < 0.8) {
      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'volume_too_low',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { volumeRatio, bias },
      });
      return false;
    }

    // All essential filters passed
    recordOpsEvent({
      level: 'info',
      source: 'quality_filter',
      message: 'quality_filter_passed',
      sessionId: this.sessionId || undefined,
      symbol: this.profile?.symbol,
      details: {
        bias,
        adx,
        rsi,
        atrPct,
        volumeRatio,
        emaSpread
      },
    });

    return true;
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
    // Prefer volumeMA from snapshot; fallback to volumeAvg; finally fallback to current volume
    const volumeMA = Number((snap as any)?.volumeMA ?? (snap as any)?.volumeAvg ?? 0);
    
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
    const emaSpread = ((snap as any)?.ema20 - (snap as any)?.ema50) / Math.abs((snap as any)?.ema50 || 1);
    const trendAligned = bias === 'long' ? emaSpread > 0.5 : emaSpread < -0.5;
    if (trendAligned) {
      if (Math.abs(emaSpread) > 0.02) sizeMultiplier *= 1.2; // Strong trend
      else if (Math.abs(emaSpread) > 0.01) sizeMultiplier *= 1.1; // Moderate trend
    } else if (Math.abs(emaSpread) < 0.002) {
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
    
    // Reduce size further on short-term loss streaks (confidence tightening)
    try {
      const cfg = getConfig();
      const window = Math.max(1, Number(cfg.STREAK_WINDOW || 3));
      const streak = this.getLossStreak(window);
      if (streak >= 1) {
        const penalty = Math.min(0.7, (cfg.LOSS_STREAK_SIZE_PENALTY || 0.15) * streak);
        sizeMultiplier *= (1 - penalty);
      }
      // Increase size modestly on win streaks (confidence relaxation)
      const winstreak = this.getWinStreak(window);
      if (winstreak >= 1) {
        const bonus = Math.min(0.3, (cfg.WIN_STREAK_SIZE_BONUS || 0.10) * winstreak);
        sizeMultiplier *= (1 + bonus);
      }
    } catch {}
    // Apply bounds (0.5x to 1.5x of base risk)
    sizeMultiplier = Math.max(0.5, Math.min(1.5, sizeMultiplier));
    
    return sizeMultiplier;
  }

  // Return consecutive losses in the last N trades (default 3)
  private getLossStreak(window: number = 3): number {
    if (!this.recentTrades.length) return 0;
    const slice = this.recentTrades.slice(-window);
    let streak = 0;
    for (let i = slice.length - 1; i >= 0; i--) {
      if (!slice[i].win) streak += 1; else break;
    }
    return streak;
  }

  // Return consecutive wins in the last N trades (default 3)
  private getWinStreak(window: number = 3): number {
    if (!this.recentTrades.length) return 0;
    const slice = this.recentTrades.slice(-window);
    let streak = 0;
    for (let i = slice.length - 1; i >= 0; i--) {
      if (slice[i].win) streak += 1; else break;
    }
    return streak;
  }

  // Snapshot of short-run performance over last N trades
  private getRecentPerformance(n: number = 5): { trades: number; winRate: number; avgPnlPct: number } {
    const slice = this.recentTrades.slice(-n);
    const trades = slice.length;
    if (trades === 0) return { trades: 0, winRate: 0, avgPnlPct: 0 };
    const wins = slice.filter(t => t.win).length;
    const winRate = wins / trades;
    const avgPnlPct = slice.reduce((s, t) => s + t.pnlPct, 0) / trades;
    return { trades, winRate, avgPnlPct };
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

  /**
   * Get comprehensive trading diagnostics for frontend display
   */
  public async getDiagnostics(): Promise<any> {
    try {
      const snap = await buildTechSnapshot(this.profile?.symbol || '');
      const canTrade = this.canTradeNow(snap);
      const checks = this.getDiagnosticChecks(snap);
      const summary = this.getDiagnosticSummary(checks);

      return {
        canTrade,
        reason: this.getTradingReadinessReason(checks),
        checks,
        summary,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('Diagnostics error:', error);
      return {
        canTrade: false,
        reason: 'Diagnostic error',
        checks: {},
        summary: { totalChecks: 0, passed: 0, failed: 0 },
        error: String(error)
      };
    }
  }

  private canTradeNow(snap: TechnicalSnapshot): boolean {
    if (!this.profile || !this.plan) return false;
    if (this.state !== 'ARMED') return false;
    if (this.pos) return false; // Already have position
    if (this.entering) return false; // Currently entering

    // Check circuit breaker
    if (this.performanceMetrics?.circuitBreaker?.isActive) return false;

    // Check bias switching
    const planBias = this.plan?.bias;
    const recommendedBias = this.performanceMetrics?.biasSwitching?.currentBias;
    if (planBias && recommendedBias && planBias !== recommendedBias && planBias !== 'none') return false;

    // Basic zone check
    const price = snap.last;
    const { from, to } = this.plan.zone;
    const inZone = price >= Math.min(from, to) && price <= Math.max(from, to);
    if (!inZone) return false;

    // Basic momentum gates
    return this.passesEntryMomentumGates(snap, 'enter');
  }

  private getDiagnosticChecks(snap: TechnicalSnapshot): any {
    const checks: any = {};

    // Basic state checks
    checks.hasPosition = {
      status: !this.pos ? 'PASS' : 'FAIL',
      reason: !this.pos ? 'No active position - ready for new entry' : 'Position already exists - cannot enter new trade',
      message: !this.pos ? 'No active position' : 'Position already exists'
    };

    checks.isArmed = {
      status: this.state === 'ARMED' ? 'PASS' : 'FAIL',
      reason: this.state === 'ARMED' ? 'Agent is armed and ready to trade' : `Agent is in ${this.state} state - must be ARMED to trade`,
      message: this.state === 'ARMED' ? 'Agent is armed' : `Agent state: ${this.state}`
    };

    checks.isEntering = {
      status: !this.entering ? 'PASS' : 'FAIL',
      reason: !this.entering ? 'Not currently entering a position' : 'Entry process already in progress - wait for completion',
      message: !this.entering ? 'Not currently entering' : 'Entry in progress'
    };

    // Risk management checks
    checks.dailyTradeLimit = {
      status: (this.tradesToday || 0) < 10 ? 'PASS' : 'FAIL',
      reason: (this.tradesToday || 0) < 10 
        ? `Daily trades: ${this.tradesToday || 0}/10 - within limit`
        : `Daily trades: ${this.tradesToday || 0}/10 - limit exceeded for risk management`,
      message: `Trades today: ${this.tradesToday || 0}`
    };

    checks.consecutiveStopsLimit = {
      status: (this.consecutiveStops || 0) < 3 ? 'PASS' : 'FAIL',
      reason: (this.consecutiveStops || 0) < 3
        ? `Consecutive stops: ${this.consecutiveStops || 0}/3 - acceptable loss streak`
        : `Consecutive stops: ${this.consecutiveStops || 0}/3 - circuit breaker activated`,
      message: `Consecutive stops: ${this.consecutiveStops || 0}`
    };

    // Zone and momentum checks
    const price = snap.last;
    const { from, to } = this.plan?.zone || { from: 0, to: 0 };
    checks.inEntryZone = {
      status: (price >= Math.min(from, to) && price <= Math.max(from, to)) ? 'PASS' : 'FAIL',
      reason: (price >= Math.min(from, to) && price <= Math.max(from, to))
        ? `Price ${price.toFixed(4)} is within entry zone [${Math.min(from, to).toFixed(4)}, ${Math.max(from, to).toFixed(4)}]`
        : `Price ${price.toFixed(4)} is outside entry zone [${Math.min(from, to).toFixed(4)}, ${Math.max(from, to).toFixed(4)}]`,
      message: `Price: ${price?.toFixed(4)}, Zone: ${Math.min(from, to).toFixed(4)} - ${Math.max(from, to).toFixed(4)}`
    };

    checks.momentumGates = {
      status: this.passesEntryMomentumGates(snap, 'enter') ? 'PASS' : 'FAIL',
      reason: this.passesEntryMomentumGates(snap, 'enter') 
        ? 'All momentum requirements met (ATR, slope, trend alignment)'
        : 'Failed momentum gates - insufficient volatility or trend strength',
      message: 'Momentum gates check'
    };

    // Simplified quality filters (binary pass/fail for essential indicators)
    checks.qualityFilters = this.getQualityFiltersDiagnostics(snap);

    // Calculate overall quality score based on points (0-100) - allow trading with 80+ points (4/5 filters)
    const qualityPoints = Object.values(checks.qualityFilters).reduce((sum: number, filter: any) => sum + (filter.points || 0), 0);
    const maxPoints = 100; // 5 filters × 20 points each
    const minTradingPoints = 80; // Require at least 4/5 filters (80 points) to trade
    checks.qualityScore = {
      current: qualityPoints,
      required: minTradingPoints, // Changed from maxPoints to minTradingPoints
      status: qualityPoints >= minTradingPoints ? 'PASS' : 'FAIL',
      reason: `Quality score: ${qualityPoints}/${maxPoints} points (${Object.values(checks.qualityFilters).filter((f: any) => f.points > 0).length}/5 filters passed) - ${qualityPoints >= minTradingPoints ? 'Ready to trade' : 'Insufficient quality'}`
    };

    return checks;
  }

  private getQualityFiltersDiagnostics(snap: TechnicalSnapshot): any {
    if (!this.plan) return {};

    const price = snap.last;
    const bias = this.plan.bias;
    const adx = Number((snap as any)?.adx14 ?? 0);
    const rsi = Number((snap as any)?.rsi14 ?? 50);
    const ema20 = Number((snap as any)?.ema20 ?? price);
    const ema50 = Number((snap as any)?.ema50 ?? price);
    const atrPct = Number((snap as any)?.atrPct ?? 0);
    const volume = Number((snap as any)?.volume ?? 0);
    const volumeMA = Number((snap as any)?.volumeMA ?? (snap as any)?.volumeAvg ?? volume);

    return {
      trendAlignment: {
        status: this.checkTrendAlignment(ema20, ema50, bias) ? 'PASS' : 'FAIL',
        reason: bias === 'long' 
          ? `EMA20 (${ema20.toFixed(4)}) should be above EMA50 (${ema50.toFixed(4)}) with >0.5% spread for long bias`
          : `EMA20 (${ema20.toFixed(4)}) should be below EMA50 (${ema50.toFixed(4)}) with <-0.5% spread for short bias`,
        points: this.checkTrendAlignment(ema20, ema50, bias) ? 20 : 0,
        details: {
          ema20: ema20.toFixed(4),
          ema50: ema50.toFixed(4),
          spread: (((ema20 - ema50) / ema50) * 100).toFixed(2) + '%'
        }
      },
      momentum: {
        status: adx >= 20 ? 'PASS' : 'FAIL',
        reason: `ADX (${adx.toFixed(1)}) must be >= 20 to confirm trend strength`,
        points: adx >= 20 ? 20 : 0,
        details: {
          currentADX: adx,
          threshold: 20
        }
      },
      rsiPosition: {
        status: this.checkRSIPosition(rsi, bias) ? 'PASS' : 'FAIL',
        reason: bias === 'long' 
          ? `RSI (${rsi.toFixed(1)}) should be between 40-75 for long entries (avoiding overbought)`
          : `RSI (${rsi.toFixed(1)}) should be between 25-60 for short entries (avoiding oversold)`,
        points: this.checkRSIPosition(rsi, bias) ? 20 : 0,
        details: {
          currentRSI: rsi,
          bias
        }
      },
      volatility: {
        status: atrPct >= 0.5 ? 'PASS' : 'FAIL',
        reason: `ATR (${atrPct.toFixed(2)}%) must be >= 0.5% to ensure sufficient volatility for profitable moves`,
        points: atrPct >= 0.5 ? 20 : 0,
        details: {
          currentATR: atrPct,
          threshold: 0.5
        }
      },
      volume: {
        status: this.checkVolumeConfirmation(volume, volumeMA) ? 'PASS' : 'FAIL',
        reason: `Current volume (${volume.toFixed(0)}) should be >= 80% of MA volume (${volumeMA.toFixed(0)}) for confirmation`,
        points: this.checkVolumeConfirmation(volume, volumeMA) ? 20 : 0,
        details: {
          currentVolume: volume,
          volumeMA: volumeMA,
          ratio: volumeMA > 0 ? (volume / volumeMA).toFixed(2) : 'N/A'
        }
      }
    };
  }

  private checkTrendAlignment(ema20: number, ema50: number, bias: string): boolean {
    const emaSpread = ((ema20 - ema50) / ema50) * 100;
    if (bias === 'long') return ema20 > ema50 && emaSpread > 0.5;
    if (bias === 'short') return ema20 < ema50 && emaSpread < -0.5;
    return false;
  }

  private checkRSIPosition(rsi: number, bias: string): boolean {
    if (bias === 'long') return rsi >= 40 && rsi <= 75;
    if (bias === 'short') return rsi >= 25 && rsi <= 60;
    return false;
  }

  private checkVolumeConfirmation(volume: number, volumeMA: number): boolean {
    if (volumeMA <= 0) return volume > 0;
    const ratio = volume / volumeMA;
    return ratio >= 0.8;
  }

  private getDiagnosticSummary(checks: any): any {
    const checkValues = Object.values(checks);
    const totalChecks = checkValues.length;
    const passed = checkValues.filter((c: any) => c.status === 'PASS').length;
    const failed = checkValues.filter((c: any) => c.status === 'FAIL').length;
    const partial = checkValues.filter((c: any) => c.status === 'PARTIAL').length;
    const rejected = checkValues.filter((c: any) => c.status === 'REJECT').length;

    return {
      totalChecks,
      passed,
      failed,
      partial,
      rejected
    };
  }

  private getTradingReadinessReason(checks: any): string {
    const failedChecks = Object.entries(checks)
      .filter(([_, check]: [string, any]) => check.status === 'FAIL')
      .map(([key, check]: [string, any]) => `${key}: ${check.message}`);

    if (failedChecks.length === 0) {
      return 'Ready to trade - all conditions met';
    }

    return `Blocked by: ${failedChecks.join(', ')}`;
  }

  // Stub implementations for missing methods - to be implemented properly later

  private async logMovement(message: string, details: string, metadata?: any): Promise<void> {
    console.log(`[AGENT ${this.profile?.symbol}] ${message}: ${details}`);
  }

  private formatPrice(price: number): string {
    return price.toFixed(6);
  }

  public halt(): void {
    this.state = 'HALT';
    console.log(`Agent ${this.profile?.symbol} halted`);
  }

  private async restorePersistedPosition(): Promise<void> {
    // Stub - restore position from persistence layer
    console.log('Restoring persisted position (stub)');
  }

  private async syncProtectiveOrders(reason: string): Promise<void> {
    // Stub - sync stop loss and take profit orders
    console.log(`Syncing protective orders: ${reason} (stub)`);
  }

  private async manage(price: number, snap: TechnicalSnapshot): Promise<void> {
    // Stub - manage existing position
    console.log(`Managing position at price ${price} (stub)`);
  }

  private async applyDailyRoiThrottle(riskPct: number): Promise<number> {
    // Stub - apply daily ROI throttling
    return riskPct;
  }

  private async placeLimitAdaptive(order: any): Promise<any> {
    // Stub - place adaptive limit order
    console.log('Placing adaptive limit order (stub)');
    return null; // Return null for failed placement
  }

  private async executeTwapOrder(order: any): Promise<any> {
    // Stub - execute TWAP order
    console.log('Executing TWAP order (stub)');
    return null; // Return null for failed placement
  }

  private computeTelemetry(startTs: number, placed: any, details: any): any {
    // Stub - compute order telemetry
    return {
      duration: Date.now() - startTs,
      success: placed !== null,
      details
    };
  }

  private getAdaptationMultipliers(strategy: any, bias: string): any {
    // Stub - get adaptation multipliers
    return { risk: 1.0, size: 1.0 };
  }

  public async nextPlan(options?: any): Promise<any> {
    // Stub - generate next trading plan
    return this.plan;
  }
}
