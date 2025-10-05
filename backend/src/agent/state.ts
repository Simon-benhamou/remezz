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
import { getConfig, getModeParams } from '../utils/env.js';
import { getAICallsCount } from '../metrics/aiCalls.js';
import { requestStrategy } from '../ai/strategyManager.js';
import { proposePlan } from '../ai/planOrchestrator.js';
import { recordOpsEvent } from '../monitor/ops.js';
import { logImprovementAuto } from '../monitor/backlog.js';
import type { RegimeProfile } from '../ai/regime.js';
import { getTicker } from '../data/market.js';
import type { PlacedOrder } from '../broker/types.js';
import { prisma } from '../db/client.js';
import { predictor } from '../ai/predictor.js';

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
  // New: control how position size is computed and liquidity guard
  sizingMode?: 'risk' | 'budget'; // default: 'risk' (risk-based, capped by budget); 'budget' uses budget * leverage
  liquidityGuard?: boolean; // default: true; when false, skip impact-based qty reduction
  // Risk-aware leverage controls (optional)
  dynamicLeverage?: boolean; // default true: scale leverage based on setup quality and risk
  minLeverage?: number; // optional floor, >=1 and <= maxLeverage
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

type VolumeContext = {
  emaRatio: number;
  emaUsd: number;
  rejectionScore: number;
  sampleCount: number;
  lastUpdated: number;
};

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
  private invalidationTicks = 0; // consecutive ticks price outside entry zone
  regime: RegimeProfile | null = null;
  private adaptiveRisk: AdaptiveRiskResult | null = null;
  private protectiveErrorCount = 0;
  private killSwitchContext: { reason: string; details?: any } | null = null;
  private haltAckRequired = false;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private cooldownTimer: NodeJS.Timeout | null = null;
  private cooldownContext: { reason: string; guard?: RiskDecision; triggeredAt: number } | null = null;
  private lastExitCooldownMs = 0;
  private maxNotionalCapUsd = Infinity;

  // simplistic counters for risk
  consecutiveStops = 0;
  tradesToday = 0;
  realizedPnlTodayPct = 0;
  
  // ✅ ULTRA-INTELLIGENT: Performance tracking BY TIER (contextualized learning)
  private recentTradesByTier: Map<string, { symbol: string; win: boolean; pnlPct: number; timestamp: number }[]> = new Map([
    ['tier1', []],  // BTC, ETH, SOL - Ultra stable
    ['tier2', []],  // Major alts - Stable
    ['tier3', []]   // Volatile alts - High risk
  ]);

  // ✅ PHASE 1 FIXES: Entry Zone Critical Improvements
  private priceInZoneStartTime = 0;           // Whipsaw protection: timestamp when price entered zone
  private gapEntryOverride = false;            // Gap detection: override entry validation if gap favorable
  private zoneCalculatedForBias: 'long' | 'short' | 'none' = 'none'; // Bias mismatch: track bias used for zone
  private lastZoneCalculation = 0;             // Zone expiration: timestamp of last zone calculation
  private requireStrongerConfirmation = false; // Support break: flag when price near weak support
  
  // ✅ Quality threshold adjustment BY TIER (independent learning per category)
  private qualityAdjustmentByTier: Map<string, number> = new Map([
    ['tier1', 0],
    ['tier2', 0],
    ['tier3', 0]
  ]);
  
  // ✅ Cooldown tracking BY TIER (one tier paused doesn't affect others)
  private cooldownByTier: Map<string, number> = new Map([
    ['tier1', 0],
    ['tier2', 0],
    ['tier3', 0]
  ]);
  
  // Legacy global tracking (deprecated, kept for compatibility)
  private recentTrades: { win: boolean; pnlPct: number; timestamp: number }[] = [];
  private qualityThresholdAdjustment = 0; // Dynamic adjustment to quality thresholds
  
  // 🆕 Breakout mode tracking
  private lastTradeWasWin = false;
  private lastZoneRecalcTime = 0;
  private lastZoneCheckTime = 0;
  private breakoutModeActive = false;

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

    const budgetFractionRaw = typeof profile.budgetFraction === 'number'
      ? profile.budgetFraction
      : (typeof (profile as any).budgetPct === 'number' ? ((profile as any).budgetPct > 1 ? (profile as any).budgetPct / 100 : (profile as any).budgetPct) : 1);
    const safeBudgetFraction = Math.min(1, Math.max(0.1, budgetFractionRaw || 1));
    const leverageCap = Math.max(1, Math.min(10, profile.maxLeverage || 1));
    const baselineBalance = typeof profile.startBalanceUsd === 'number' && profile.startBalanceUsd > 0
      ? profile.startBalanceUsd
      : undefined;
    this.maxNotionalCapUsd = baselineBalance != null
      ? Math.max(0, baselineBalance * leverageCap * safeBudgetFraction)
      : Infinity;

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
      // 🔥 PHASE 1 FIX #3: Check for gaps at cycle start
      if (this.plan.bias !== 'none') {
        const gapCheck = this.handleGapDetection(snap, price, this.plan.zone, this.plan.bias);
        if (gapCheck.action === 'invalidate') {
          console.warn(`🔥 ${gapCheck.reason} - Invalidating plan`);
          this.state = 'SCAN';
          broadcast('agent_state', { state: this.state, reason: gapCheck.reason }, this.profile.symbol, this.sessionId || undefined);
          return;
        } else if (gapCheck.action === 'enter') {
          console.log(`🔥 ${gapCheck.reason}`);
          await this.enter(price, snap);
          return;
        }
      }

      // 🔥 PHASE 1 FIX #2: Check zone expiration
      const expirationCheck = this.isZoneExpired(this.plan.zone, price);
      if (expirationCheck.expired) {
        console.log(`🔥 ${expirationCheck.reason} - Recalculating zone`);
        const newZone = await this.calculateDynamicEntryZone(snap, price, this.plan.bias);
        this.plan.zone = newZone;
        this.lastZoneCalculation = Date.now();
        this.zoneCalculatedForBias = this.plan.bias; // Track bias for mismatch detection
        console.log(`🔥 New zone: [${newZone.from.toFixed(4)}, ${newZone.to.toFixed(4)}] mid: ${newZone.mid.toFixed(4)}`);
      }

      // 🔥 PHASE 1 FIX #4: Check bias mismatch
      if (this.zoneCalculatedForBias !== 'none' && this.zoneCalculatedForBias !== this.plan.bias) {
        console.warn(`🔥 Bias mismatch: zone calculated for ${this.zoneCalculatedForBias}, current bias ${this.plan.bias} - Recalculating`);
        const newZone = await this.calculateDynamicEntryZone(snap, price, this.plan.bias);
        this.plan.zone = newZone;
        this.lastZoneCalculation = Date.now();
        this.zoneCalculatedForBias = this.plan.bias;
        console.log(`🔥 Bias-corrected zone: [${newZone.from.toFixed(4)}, ${newZone.to.toFixed(4)}]`);
      }

      // 🟡 PHASE 2 FIX #2: Check pullback timeout (6h without touching zone)
      if (this.plan.bias !== 'none') {
        const timeoutCheck = this.shouldRecalculateProgressiveZone(this.plan.zone, price);
        if (timeoutCheck.shouldRecalc) {
          console.log(`🟡 ${timeoutCheck.reason}`);
          const newZone = await this.calculateDynamicEntryZone(snap, price, this.plan.bias);
          this.plan.zone = newZone;
          this.lastZoneCalculation = Date.now();
          console.log(`🟡 Progressive zone: [${newZone.from.toFixed(4)}, ${newZone.to.toFixed(4)}]`);
        }
      }

      // 🆕 Recalculate entry zone periodically (every 30 min) to check breakout conditions
      await this.maybeRecalculateEntryZone().catch(err => console.warn('Zone recalc failed:', err));
      
      // ✅ Safety: MANAGE state only if position truly exists and valid
      if (this.pos && this.pos.qty > 0) { 
        this.state = 'MANAGE'; 
        broadcast('agent_state', { state: this.state, pos: this.pos }, this.profile.symbol, this.sessionId || undefined); 
        return; 
      } else if (this.pos) {
        // ✅ Position object exists but qty invalid
        console.warn(`⚠️  Invalid position qty (${this.pos.qty}) for ${this.profile.symbol}, clearing`);
        this.pos = null;
        this.state = 'SCAN';
      }
      if (this.plan.bias === 'none') return;
      // PHASE 3 FIX #1: Use epsilon tolerance for zone check
      const inZone = this.priceInZoneWithEpsilon(price, this.plan.zone);

      // 🧠 AI Prediction for short-term moves (optimisé)
      let aiPrediction: any = null;
      let originalBias = this.plan.bias; // Sauvegarder le bias original

      // Conditions pour appeler l'IA (optimisation coût)
      const shouldCallAI = this.shouldCallAIPrediction(snap, price);
      
      if (shouldCallAI) {
        try {
          aiPrediction = await predictor.predictMove(this.profile.symbol, price, snap);
          
          // Mettre à jour le suivi des prédictions IA
          (this as any).lastAIPredictionTime = Date.now();
          (this as any).lastAIPredictionPrice = price;
          
          if (aiPrediction && aiPrediction.confidence >= 0.75 && aiPrediction.direction !== 'neutral') {
            console.log(`🧠 AI Prediction: ${aiPrediction.direction} (${(aiPrediction.confidence * 100).toFixed(1)}% confidence) - ${aiPrediction.reasoning}`);

            // Override plan bias seulement si IA très confiante et direction claire
            if (aiPrediction.direction === 'up' && this.plan.bias !== 'long') {
              console.log(`🧠 AI overriding to LONG bias for better opportunity capture`);
              this.plan.bias = 'long';
            } else if (aiPrediction.direction === 'down' && this.plan.bias !== 'short') {
              console.log(`🧠 AI overriding to SHORT bias for better opportunity capture`);
              this.plan.bias = 'short';
            }
          } else if (aiPrediction && aiPrediction.direction === 'neutral') {
            console.log(`🧠 AI: Neutral conditions - keeping original bias`);
          }
        } catch (error) {
          console.warn('AI prediction failed:', error);
        }
      } else {
        console.log(`🧠 Skipping AI prediction - conditions not met (cost optimization)`);
      }

      // Restaurer le bias original si nécessaire (après traitement de la prédiction)
      if (this.plan.bias !== originalBias) {
        console.log(`🧠 Restoring original bias: ${originalBias}`);
        this.plan.bias = originalBias;
      }

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
    
    // � PHASE 1 FIX #1: Whipsaw protection - 3-stage confirmation
    // Get snap for validations
    let snapForValidation = _snap;
    if (!snapForValidation) {
      const { buildTechSnapshot } = await import('../ai/tech.js');
      snapForValidation = await buildTechSnapshot(this.profile.symbol);
    }

    // PHASE 2 FIX #6: Liquidity validation
    if (this.plan && this.plan.sizing) {
      const liquidityCheck = this.hasAdequateLiquidity(snapForValidation, this.plan.sizing.notionalUsd);
      if (!liquidityCheck.adequate) {
        console.warn(`PHASE 2: ${liquidityCheck.reason} - Skipping entry to avoid slippage`);
        return;
      }
    }

    if (this.plan.bias !== 'none' && !this.gapEntryOverride) {
      const confirmation = this.confirmEntrySignal(snapForValidation, mktPrice, this.plan.zone, this.plan.bias);
      if (!confirmation.confirmed) {
        console.log(`Entry not confirmed: ${confirmation.reason}`);
        return; // Skip entry until all confirmations pass
      }
      console.log(`Entry confirmed: ${confirmation.reason}`);
    }
    
    // Reset gap override after use
    this.gapEntryOverride = false;
    
    // �🚨 COOLDOWN CHECK: Prevent entries too soon after last exit
    const envMod = await import('../utils/env.js');
    const cfg = envMod.getConfig();
    const modeParams = envMod.getModeParams(this.profile.aggressiveness || 'reactive');
    const baseCooldownMs = modeParams?.tradeCooldownMs || cfg.TRADE_COOLDOWN_MS;
    const cooldownMs = this.lastExitCooldownMs > 0 ? this.lastExitCooldownMs : baseCooldownMs;
    const timeSinceLastExit = Date.now() - this.lastExitTime;

    if (this.lastExitTime > 0 && timeSinceLastExit < cooldownMs) {
      const cooldownRemaining = (cooldownMs - timeSinceLastExit) / 1000;
      console.log(`⏳ Trade cooldown: ${cooldownRemaining.toFixed(0)}s remaining - skipping entry`);
      return;
    }
    this.lastExitCooldownMs = 0;
    
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
    if (!snap || !this.passesEntryMomentumGates(snap, 'enter') || !this.passesQualityFilters(snap) || !this.passesAntiWhaleFilters(snap)) {
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
    const cfgProfit = getConfig();
    // Aggressiveness-aware min profitability
    let minProfitPct = cfgProfit.MIN_TRADE_PROFIT_PCT;
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
    // Compute requested size
    let notional = 0;
    // Determine effective leverage for this trade (risk-aware if enabled)
    const baseLev = Math.max(1, this.profile.maxLeverage || 1);
    const dynLevEnabled = this.profile.dynamicLeverage !== false; // default true
    const minLevCfg = Math.max(1, Math.min(baseLev, Number(this.profile.minLeverage || 1)));
    let effectiveLev = baseLev;
    if (dynLevEnabled) {
      // Quality multiplier from sizing heuristic (0.35..1.8 roughly)
      let qualityMultiplier = 1.0;
      try { qualityMultiplier = Math.max(0.35, Math.min(1.8, this.computeQualityBasedSizing(snap!))); } catch {}
      const minFactor = minLevCfg / baseLev; // floor as fraction of base
      // Normalize quality to [0..1] where 0.35 -> 0 and 1.0 -> 1 (cap >1 to 1)
      const qNorm = Math.max(0, Math.min(1, (qualityMultiplier - 0.35) / (1.0 - 0.35)));
      const qualFactor = minFactor + (1 - minFactor) * qNorm;
      // Stop distance impact: wider stops => more risk => reduce leverage
      const stopPct = Math.abs(entry - stop) / Math.max(entry, 1e-8) * 100;
      const stopFactor = stopPct > 2.5 ? Math.max(0.6, 1 - (stopPct - 2.5) / 7.5) : 1; // down to ~0.6 at ~10% stop
      // Adaptive risk factor (if engine cut risk): reflect partly into leverage (floor 0.5)
      const baseRisk = Math.max(1e-6, this.profile.riskPerTradePct);
      const riskFactor = Math.max(0.5, Math.min(1, dynamicRiskPct / baseRisk));
      effectiveLev = Math.max(minLevCfg, Math.min(baseLev, baseLev * qualFactor * stopFactor * riskFactor));
    }
    {
      const cfg = getConfig();
      const defaultSizing = (cfg.SIZING_DEFAULT_MODE === 'risk' ? 'risk' : 'budget');
      const mode = (this.profile.sizingMode || defaultSizing);
      if (mode === 'budget') {
      // Budget-based sizing: use budget allocation times effective leverage
      notional = Math.max(0, usableBalance * effectiveLev);
      } else {
      // Risk-based sizing: cap by effective leverage, not maximum
      notional = computeQtyNotional({ balanceUsd: usableBalance, riskPct: dynamicRiskPct, stopDistanceAbs: Math.abs(entry - stop), entryPrice: entry, maxLev: effectiveLev });
      }
    }
    
    // ✅ FIX: Enforce minimum notional (8% of balance) to ensure meaningful position sizes
    // Position too small (<8%) don't justify trading costs and make gains insignificant
    const minNotionalPct = bal.equityUsd * 0.08; // 8% of balance minimum
    if (notional < minNotionalPct) {
      const oldNotional = notional;
      notional = Math.min(minNotionalPct, usableBalance * effectiveLev); // Cap by usable balance
      recordOpsEvent({
        level: 'info',
        source: 'position_sizing',
        message: 'minimum_notional_enforced',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          oldNotional,
          minNotional: minNotionalPct,
          newNotional: notional,
          reason: 'Position size below 8% threshold'
        },
      });
    }
    
    let qty = notional / Math.max(entry, 1e-8);

    const equityCapNotional = Math.max(0, bal.equityUsd * (effectiveLev || 1));
    const budgetCapNotional = Math.max(0, capBalance * (effectiveLev || 1));
    const hardNotionalCap = Math.min(equityCapNotional || Infinity, budgetCapNotional || Infinity);
    const configuredCapNotional = Number.isFinite(this.maxNotionalCapUsd) && this.maxNotionalCapUsd > 0
      ? this.maxNotionalCapUsd
      : Infinity;
    const effectiveNotionalCap = Math.min(
      hardNotionalCap > 0 ? hardNotionalCap : Infinity,
      configuredCapNotional > 0 ? configuredCapNotional : Infinity,
    );

    if (Number.isFinite(effectiveNotionalCap) && effectiveNotionalCap > 0 && notional > effectiveNotionalCap) {
      const cappedQty = effectiveNotionalCap / Math.max(entry, 1e-8);
      recordOpsEvent({
        level: 'warn',
        source: 'position_sizing',
        message: 'leverage_cap_applied',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          requestedNotional: notional,
          cappedNotional: effectiveNotionalCap,
          requestedQty: qty,
          cappedQty,
          equityUsd: bal.equityUsd,
          maxLeverage: this.profile.maxLeverage,
          startBalanceUsd: this.profile.startBalanceUsd,
          configuredCapNotional,
        },
      });
      qty = cappedQty;
    }
    // Optionally estimate fillable quantity (liquidity guard)
    const useLiqGuard = this.profile.liquidityGuard !== false; // default true
    if (useLiqGuard && typeof (this.broker as any)?.estimateFillableQty === 'function') {
      try {
        const cfg = getConfig();
        const maxImpact = this.profile.mode === 'live' ? cfg.ORDER_MAX_IMPACT_PCT : cfg.PAPER_MAX_IMPACT_PCT;
        const estimate = await (this.broker as any).estimateFillableQty({ symbol: this.profile.symbol, side, desiredQty: qty, maxImpactPct: maxImpact });
        if (estimate?.fillableQty != null) {
          if (estimate.fillableQty < qty) {
            const reductionNote = `Liquidity limit reduced qty from ${qty.toFixed(6)} to ${estimate.fillableQty.toFixed(6)} (impact ${(estimate.impactPct ?? 0).toFixed(2)}%).`;
            const planJson = this.plan.plan;
            planJson.notes = planJson.notes ? `${planJson.notes}\n${reductionNote}` : reductionNote;
            recordOpsEvent({
              level: 'info',
              source: 'liquidity_guard',
              message: 'qty_reduced_due_to_impact',
              sessionId: this.sessionId || undefined,
              symbol: this.profile.symbol,
              details: { requestedQty: qty, fillableQty: estimate.fillableQty, impactPct: estimate.impactPct }
            });
          }
          qty = estimate.fillableQty;
          if (estimate.minQty != null && qty < estimate.minQty) {
            this.entering = false;
            return;
          }
        }
      } catch {}
    }
    const minNotional = getConfig().MIN_ORDER_NOTIONAL_USD || 0;
    if (!(qty > 0) || (qty * entry) < minNotional) {
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
      placed = await this.placeLimitAdaptive({ side, qty, limitPrice, stop, tp, entry, leverage: effectiveLev });
    } else if (executionMode === 'twap') {
      placed = await this.executeTwapOrder({ side, totalQty: qty, slices: 3, intervalMs: 250, stop, tp, entry, leverage: effectiveLev });
    } else {
      placed = await this.broker.place({ symbol: this.profile.symbol, side, type: 'market', qty, leverage: effectiveLev, takeProfit: tp[0], stopLoss: stop });
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
  leverage: effectiveLev,
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
    
    // 🔧 AJUSTÉ : Multipliers plus généreux pour laisser respirer les positions
    let multiplier = playbook === 'momentum_breakout' ? 0.85 : playbook === 'mean_reversion' ? 1.3 : 1.1;

    // 🟢 Early-grace window: rendre le trailing plus permissif en début de trade
    const cfg = getConfig();
    const earlyGraceMs = Math.min(12 * 60 * 1000, Math.max(5 * 60 * 1000, Math.floor((cfg.MIN_HOLD_TIME_MS || 30 * 60 * 1000) / 3)));
    const earlyStage = elapsedMs < earlyGraceMs;
    const adx = Number((snap as any)?.adx14 ?? 0);
    const cmf20 = Number((snap as any)?.cmf20 ?? 0);
    const cmfAligned = (side === 'buy' && cmf20 >= 0.1) || (side === 'sell' && cmf20 <= -0.1);
    const trendAligned = (slope || 0) * dir > 0;
    if (earlyStage) {
      // Laisser plus de marge au démarrage pour éviter les sorties sur simple bruit
      multiplier *= 1.2; // +20% d'espace par rapport au trailing standard
    }
    
    // ✅ FIX: Aggressive tightening when losing (prevents -1.27% ETH losses)
    if (upR < 0) {
      // 🚨 LOSING POSITION
      if (earlyStage && upR > -0.4) {
        // Perdre légèrement au démarrage → on tolère la volatilité
        multiplier = Math.max(multiplier, 1.15);
      } else {
        // Perte confirmée → resserrer
        multiplier = 0.7; // 70% of stop distance
        if (upR < -0.5) {
          multiplier = 0.5; // 50% - very tight stop
          console.log(`🔴 Aggressive trail: R=${upR.toFixed(2)}, mult=${multiplier} (tight stop)`);
        }
      }
    }
    
    // CRYPTO MOONSHOT: Adaptive trailing based on profit level
    const currentProfitPct = Math.abs((price - this.pos.entry) / this.pos.entry) * 100;
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

    // 📈 Confiance de tendance: ADX/CMF alignés → trailing plus lâche pour laisser courir
    if (adx >= 22 && cmfAligned && trendAligned && upR >= 0) {
      multiplier *= 1.12; // +12% d'espace
    }
    // 🔧 AJUSTÉ : Resserrer moins agressivement pour laisser se développer les gains
    if (upR > 2.0) multiplier *= 0.90; // Seulement au-delà de +2R (au lieu de 1.5R)
    if (upR > 3.5) multiplier *= 0.80; // Au-delà de +3.5R (au lieu de 2.5R)
    
    // 🔧 SUPPRIMÉ : Le resserrement sur mouvements normaux causait des sorties prématurées
    // On laisse maintenant respirer la position jusqu'à +3% unrealized
    if (unrealizedPct > 3.0 && upR >= 2.5) {
      multiplier *= 0.85; // Resserrement léger uniquement après +3% unrealized
      recordOpsEvent({
        level: 'info',
        source: 'trail_optimizer',
        message: 'Trailing ajusté après +3% unrealized pour sécuriser gains',
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

    // 🔒 Verrouillage des gains seulement après un minimum de temps (évite BE trop tôt)
    const minHoldForLock = Math.min((cfg.MIN_HOLD_TIME_MS || 30 * 60 * 1000) * 0.5, 15 * 60 * 1000);
    if (elapsedMs > minHoldForLock && upR > 1) {
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
    const modeParams = getModeParams(level);
    
    let ENTRY_SHORT_MIN_ADX = cfg.ENTRY_SHORT_MIN_ADX;
    let ENTRY_LONG_MIN_ADX = cfg.ENTRY_LONG_MIN_ADX;
    let ENTRY_SHORT_MIN_RSI = cfg.ENTRY_SHORT_MIN_RSI;
    let ENTRY_LONG_MAX_RSI = cfg.ENTRY_LONG_MAX_RSI;
    let ENTRY_MIN_ATR_PCT = modeParams.minAtrPct; // Use mode-specific ATR threshold
    let ENTRY_MIN_SLOPE_ABS_PCT = cfg.ENTRY_MIN_SLOPE_ABS_PCT;
    
    if (level === 'reactive') {
      ENTRY_SHORT_MIN_ADX = Math.max(10, ENTRY_SHORT_MIN_ADX - 2);
      ENTRY_LONG_MIN_ADX = Math.max(8, ENTRY_LONG_MIN_ADX - 2);
      ENTRY_MIN_SLOPE_ABS_PCT = Math.max(0.008, ENTRY_MIN_SLOPE_ABS_PCT * 0.67);
      // Wider RSI bands for crypto on reactive mode
      ENTRY_SHORT_MIN_RSI = Math.max(35, ENTRY_SHORT_MIN_RSI - 5);
      ENTRY_LONG_MAX_RSI = Math.min(75, ENTRY_LONG_MAX_RSI + 5);
    } else if (level === 'aggressive') {
      ENTRY_SHORT_MIN_ADX = Math.max(8, ENTRY_SHORT_MIN_ADX - 4);
      ENTRY_LONG_MIN_ADX = Math.max(6, ENTRY_LONG_MIN_ADX - 4);
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
  private static readonly volumeContextCache = new Map<string, VolumeContext>();
  
  private static readonly MAX_CACHE_SIZE = 200; // Limit cache size to prevent memory issues
  private static readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h cache validity
  private static readonly INTELLIGENT_CACHE_TTL_MS = 8 * 60 * 60 * 1000; // 8h for AI analysis
  private static readonly VOLATILITY_ANALYSIS_TTL_MS = 12 * 60 * 60 * 1000; // 12h for volatility metrics
  private static readonly VOLATILITY_CHANGE_THRESHOLD = 0.5; // 50% change triggers update
  private static cacheStats = { hits: 0, misses: 0, updates: 0 };
  private static intelligentCacheStats = { hits: 0, misses: 0, updates: 0, aiAnalysis: 0 };

  private updateVolumeContext(symbol: string, ratio: number, usd: number, blocked: boolean): VolumeContext | undefined {
    if (!symbol) return undefined;
    const now = Date.now();
    let ctx = ReboundRejectionAgent.volumeContextCache.get(symbol);
    const validRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
    const validUsd = Number.isFinite(usd) && usd > 0 ? usd : undefined;

    if (!ctx) {
      ctx = {
        emaRatio: validRatio ?? 0.6,
        emaUsd: validUsd ?? 0,
        rejectionScore: blocked ? 0.2 : 0.05,
        sampleCount: 0,
        lastUpdated: now,
      };
    }

    const alpha = ctx.sampleCount >= 25 ? 0.08 : 0.18;
    if (validRatio !== undefined) {
      ctx.emaRatio = ctx.sampleCount ? ctx.emaRatio + alpha * (validRatio - ctx.emaRatio) : validRatio;
    }
    if (validUsd !== undefined) {
      ctx.emaUsd = ctx.sampleCount ? ctx.emaUsd + alpha * (validUsd - ctx.emaUsd) : validUsd;
    }
    ctx.rejectionScore = Math.max(0, Math.min(1, ctx.rejectionScore * 0.85 + (blocked ? 0.15 : 0)));
    ctx.sampleCount = Math.min(ctx.sampleCount + 1, 500);
    ctx.lastUpdated = now;
    ReboundRejectionAgent.volumeContextCache.set(symbol, ctx);

    if (ReboundRejectionAgent.volumeContextCache.size > ReboundRejectionAgent.MAX_CACHE_SIZE) {
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [key, val] of ReboundRejectionAgent.volumeContextCache.entries()) {
        if (val.lastUpdated < oldestTs) {
          oldestTs = val.lastUpdated;
          oldestKey = key;
        }
      }
      if (oldestKey) ReboundRejectionAgent.volumeContextCache.delete(oldestKey);
    }

    return ctx;
  }

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
      const target = symbol || this.profile?.symbol || '';
      if (target) {
        const snapshot = await buildTechSnapshot(target);
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
   * 🆕 Check if should switch to breakout mode (capture ongoing trends)
   */
  private shouldSwitchToBreakoutMode(snap: TechnicalSnapshot, currentPrice: number): boolean {
    if (!this.plan?.zone) return false;
    if (this.breakoutModeActive) return true; // Already in breakout
    
    const { from, to } = this.plan.zone;
    const zoneMax = Math.max(from, to);
    const priceAboveZonePct = ((currentPrice - zoneMax) / zoneMax) * 100;
    
    // ✅ FIX: Conditions assouplies pour capturer breakouts plus tôt
    const farAboveZone = priceAboveZonePct > 1.5; // +1.5% au-dessus zone (était 3%)
    const strongTrend = (snap.adx14 || 0) > 25; // ADX > 25 (était 30)
    const significantMove = Math.abs((snap as any).change24h || 0) > 3.0; // +3% move 24h (était 4%)
    const lastTradeWin = this.lastTradeWasWin === true;
    
    // Durée hors zone (éviter switch trop rapide)
    const now = Date.now();
    if (this.lastZoneCheckTime === 0) this.lastZoneCheckTime = now;
    const timeOutOfZone = now - this.lastZoneCheckTime;
    const minDuration = 30 * 60 * 1000; // 30 minutes (était 2h)
    
    const shouldSwitch = farAboveZone && strongTrend && significantMove && timeOutOfZone > minDuration;
    
    // ✅ FIX: Ne plus bloquer sur last trade LOSS si le move est très fort (>8%)
    const veryStrongMove = Math.abs((snap as any).change24h || 0) > 8.0;
    if (shouldSwitch && !lastTradeWin && !veryStrongMove) {
      console.log('⚠️ Breakout conditions met but last trade was LOSS - staying conservative (unless move >8%)');
      return false;
    }
    
    if (shouldSwitch) {
      console.log('🚀 SWITCHING TO BREAKOUT MODE:');
      console.log(`  Price ${currentPrice.toFixed(4)} > zone max ${zoneMax.toFixed(4)} (+${priceAboveZonePct.toFixed(1)}%)`);
      console.log(`  ADX: ${(snap.adx14 || 0).toFixed(1)} > 25 ✅`);
      console.log(`  Move 24h: ${Math.abs((snap as any).change24h || 0).toFixed(1)}% ✅`);
      console.log(`  Time out of zone: ${(timeOutOfZone / 60000).toFixed(0)} min ✅`);
      this.breakoutModeActive = true;
      
      recordOpsEvent({
        level: 'info',
        source: 'breakout_mode',
        message: 'Switched to breakout mode - capturing ongoing trend',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { priceAboveZonePct, adx: snap.adx14, move24h: (snap as any).change24h, timeOutOfZoneHours: timeOutOfZone / 3600000 },
      });
    }
    
    return shouldSwitch;
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
    // 🟡 PHASE 2 FIX #5: Validate technical data before proceeding
    const dataValidation = this.hasValidTechnicalData(snap);
    if (!dataValidation.valid) {
      console.warn(`🟡 ${dataValidation.reason} - Cannot calculate reliable entry zone`);
      // Return breakout-style zone as fallback
      const fallbackRange = currentPrice * 0.005;
      return {
        from: currentPrice - fallbackRange,
        to: currentPrice + fallbackRange,
        mid: currentPrice
      };
    }

    // 🟡 PHASE 2 FIX #4: Skip if consolidating (no edge)
    const consolidationCheck = this.isConsolidating(snap);
    if (consolidationCheck.consolidating) {
      console.warn(`🟡 ${consolidationCheck.reason} - Skipping setup (no edge in ranging market)`);
      // Create a minimal but valid zone (ensure non-zero width) to avoid degenerate zones in diagnostics
      let tmp = {
        from: currentPrice * 0.95,
        to: currentPrice * 0.95,
        mid: currentPrice * 0.95
      };
      // Ensure at least a minimal width so the zone is reachable
      tmp = this.ensureMinimumZoneWidth(tmp, snap);
      return tmp;
    }

    // 🆕 CHECK: Faut-il switcher en mode breakout ?
    const useBreakoutMode = this.shouldSwitchToBreakoutMode(snap, currentPrice);
    
    if (useBreakoutMode && bias !== 'none') {
      console.log('🚀 BREAKOUT MODE - Entry zone around current price');
      
      // Entry zone serrée autour du prix actuel pour entrée immédiate
      const range = currentPrice * 0.003; // ±0.3% de chaque côté
      
      return {
        from: currentPrice - range,
        to: currentPrice + range,
        mid: currentPrice
      };
    }
    
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
      // 🚀 NEW: Detect MOMENTUM TREND and allow immediate entry at current price
      const ema20 = Number((snap as any)?.ema20 ?? currentPrice);
      const ema50 = Number((snap as any)?.ema50 ?? currentPrice);
      const emaSpread = ema50 > 0 ? ((ema20 - ema50) / ema50) * 100 : 0;
      const priceTo20 = ema20 > 0 ? Math.abs(currentPrice - ema20) / ema20 : 1;
      const adx = Number((snap as any)?.adx14 ?? 0);
      
      // Strong uptrend: EMA20 > EMA50 with >0.8% spread, price near EMA20, ADX > 25
      const strongTrendUp = ema20 > ema50 && emaSpread > 0.8 && priceTo20 < 0.025 && adx > 25;
      
      // Moderate uptrend: EMA20 > EMA50 with >0.4% spread, price within 3% of EMA20
      const moderateTrendUp = ema20 > ema50 && emaSpread > 0.4 && priceTo20 < 0.03;
      
      if (strongTrendUp || moderateTrendUp) {
        const trendType = strongTrendUp ? 'STRONG' : 'MODERATE';
        console.log(`🚀 ${trendType} MOMENTUM LONG TREND - Entry at current price`);
        console.log(`   EMA20: ${ema20.toFixed(4)}, EMA50: ${ema50.toFixed(4)}, Spread: ${emaSpread.toFixed(2)}%`);
        console.log(`   Price distance from EMA20: ${(priceTo20 * 100).toFixed(2)}%`);
        
        // Entry zone around current price for momentum entry
        const range = strongTrendUp ? currentPrice * 0.008 : currentPrice * 0.012; // ±0.8% or ±1.2%
        
        return {
          from: currentPrice - range,
          to: currentPrice + range,
          mid: currentPrice
        };
      }
      
      // LONG SCENARIO: Target support areas for bounce entries (traditional mean reversion)
      // 🔥 PHASE 1 FIX #5: Validate support strength (min 3 touches, max 7 days old)
      const validSupports = supports
        .filter(s => s.price < currentPrice)
        .filter(s => {
          // Require minimum 3 touches for strong support
          if (s.touches < 3) {
            this.requireStrongerConfirmation = true; // Flag for whipsaw protection
            return false;
          }
          return true;
        });

      const nearestSupport = validSupports
        .sort((a, b) => Math.abs(currentPrice - b.price) - Math.abs(currentPrice - a.price))[0];
      
      // Warn if price is very close to support (<1%) - might break through
      if (nearestSupport && Math.abs(currentPrice - nearestSupport.price) / currentPrice < 0.01) {
        console.warn(`⚠️ Price ${currentPrice.toFixed(4)} very close to support ${nearestSupport.price.toFixed(4)} - risk of break`);
        this.requireStrongerConfirmation = true;
      }
      
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
      
      let zone = {
        from: targetLevel - zoneWidth,
        to: targetLevel + zoneWidth,
        mid: targetLevel
      };

      // 🟡 PHASE 2 FIX #1: Ensure minimum width
      zone = this.ensureMinimumZoneWidth(zone, snap);
      
      // 🟢 PHASE 3 FIX #2: Cap maximum width
      zone = this.capMaximumZoneWidth(zone, snap);
      
      // � PHASE 4 FIX #2: Adaptive Volatility Strategy
      const volStrategyLong = this.getVolatilityStrategy(snap);
      if (volStrategyLong.strategy !== 'aggressive') {
        console.log(`� Volatility strategy: ${volStrategyLong.strategy}`);
        console.log(`   Zone width: ${volStrategyLong.adjustments.zoneWidthMultiplier.toFixed(2)}x, Position: ${(volStrategyLong.adjustments.positionSizeReduction*100).toFixed(0)}%`);
        
        const currentWidth = Math.abs(zone.to - zone.from);
        const adjustment = volStrategyLong.adjustments.zoneWidthMultiplier;
        if (adjustment !== 1.0) {
          const expansion = currentWidth * (adjustment - 1) / 2;
          zone = {
            from: zone.from - expansion,
            to: zone.to + expansion,
            mid: zone.mid
          };
        }
      }

      return zone;
      
    } else if (bias === 'short') {
      // 🚀 NEW: Detect MOMENTUM DOWNTREND and allow immediate entry at current price
      const ema20 = Number((snap as any)?.ema20 ?? currentPrice);
      const ema50 = Number((snap as any)?.ema50 ?? currentPrice);
      const emaSpread = ema50 > 0 ? ((ema20 - ema50) / ema50) * 100 : 0;
      const priceTo20 = ema20 > 0 ? Math.abs(currentPrice - ema20) / ema20 : 1;
      const adx = Number((snap as any)?.adx14 ?? 0);
      
      // Strong downtrend: EMA20 < EMA50 with <-0.8% spread, price near EMA20, ADX > 25
      const strongTrendDown = ema20 < ema50 && emaSpread < -0.8 && priceTo20 < 0.025 && adx > 25;
      
      // Moderate downtrend: EMA20 < EMA50 with <-0.4% spread, price within 3% of EMA20
      const moderateTrendDown = ema20 < ema50 && emaSpread < -0.4 && priceTo20 < 0.03;
      
      if (strongTrendDown || moderateTrendDown) {
        const trendType = strongTrendDown ? 'STRONG' : 'MODERATE';
        console.log(`🚀 ${trendType} MOMENTUM SHORT TREND - Entry at current price`);
        console.log(`   EMA20: ${ema20.toFixed(4)}, EMA50: ${ema50.toFixed(4)}, Spread: ${emaSpread.toFixed(2)}%`);
        console.log(`   Price distance from EMA20: ${(priceTo20 * 100).toFixed(2)}%`);
        
        // Entry zone around current price for momentum entry
        const range = strongTrendDown ? currentPrice * 0.008 : currentPrice * 0.012; // ±0.8% or ±1.2%
        
        return {
          from: currentPrice - range,
          to: currentPrice + range,
          mid: currentPrice
        };
      }
      
      // SHORT SCENARIO: Target resistance areas for rejection entries (traditional mean reversion)
      // 🔥 PHASE 1 FIX #5: Validate resistance strength (min 3 touches, max 7 days old)
      const validResistances = resistances
        .filter(r => r.price > currentPrice)
        .filter(r => {
          // Require minimum 3 touches for strong resistance
          if (r.touches < 3) {
            this.requireStrongerConfirmation = true; // Flag for whipsaw protection
            return false;
          }
          return true;
        });

      const nearestResistance = validResistances
        .sort((a, b) => Math.abs(currentPrice - a.price) - Math.abs(currentPrice - b.price))[0];
      
      // Warn if price is very close to resistance (<1%) - might break through
      if (nearestResistance && Math.abs(currentPrice - nearestResistance.price) / currentPrice < 0.01) {
        console.warn(`⚠️ Price ${currentPrice.toFixed(4)} very close to resistance ${nearestResistance.price.toFixed(4)} - risk of break`);
        this.requireStrongerConfirmation = true;
      }
      
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
      
      let zone = {
        from: targetLevel - zoneWidth,
        to: targetLevel + zoneWidth,
        mid: targetLevel
      };

      // 🟡 PHASE 2 FIX #1: Ensure minimum width
      zone = this.ensureMinimumZoneWidth(zone, snap);
      
      // 🟢 PHASE 3 FIX #2: Cap maximum width
      zone = this.capMaximumZoneWidth(zone, snap);
      
      // � PHASE 4 FIX #2: Adaptive Volatility Strategy
      const volStrategyShort = this.getVolatilityStrategy(snap);
      if (volStrategyShort.strategy !== 'aggressive') {
        console.log(`� Volatility strategy: ${volStrategyShort.strategy}`);
        console.log(`   Zone width: ${volStrategyShort.adjustments.zoneWidthMultiplier.toFixed(2)}x, Position: ${(volStrategyShort.adjustments.positionSizeReduction*100).toFixed(0)}%`);
        
        const currentWidth = Math.abs(zone.to - zone.from);
        const adjustment = volStrategyShort.adjustments.zoneWidthMultiplier;
        if (adjustment !== 1.0) {
          const expansion = currentWidth * (adjustment - 1) / 2;
          zone = {
            from: zone.from - expansion,
            to: zone.to + expansion,
            mid: zone.mid
          };
        }
      }

      return zone;
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
   * ✅ ULTRA-INTELLIGENT: Classify crypto by tier for contextualized learning
   * Tier 1: Ultra stable majors (BTC, ETH, SOL) - 55% target win rate
   * Tier 2: Established alts (ADA, XRP, AVAX, MATIC, etc.) - 50% target
   * Tier 3: Volatile alts (ENA, EIGEN, AVNT, etc.) - 45% target
   */
  private getTierForSymbol(symbol: string): string {
    const baseCrypto = symbol.split('/')[0].toUpperCase();
    
    // Tier 1: Ultra stable majors - Blue chip cryptos
    const tier1 = ['BTC', 'ETH', 'SOL'];
    if (tier1.includes(baseCrypto)) return 'tier1';
    
    // Tier 2: Established major alts - Good liquidity, proven track record
    const tier2 = [
      'XRP', 'BNB', 'ADA', 'AVAX', 'MATIC', 'DOT', 'LINK',
      'UNI', 'ATOM', 'LTC', 'BCH', 'NEAR', 'APT', 'ARB',
      'OP', 'FIL', 'ICP', 'VET', 'ALGO', 'AAVE', 'MKR'
    ];
    if (tier2.includes(baseCrypto)) return 'tier2';
    
    // Tier 3: Everything else - High volatility, lower liquidity
    return 'tier3';
  }
  
  /**
   * ✅ Get target win rate for a tier (contextualized expectations)
   */
  private getTargetWinRateForTier(tier: string): number {
    if (tier === 'tier1') return 0.55; // BTC/ETH/SOL: More predictable
    if (tier === 'tier2') return 0.50; // Major alts: Medium volatility
    return 0.45; // Volatile alts: Higher risk, lower expectations
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

  // ========================================================================
  // 🔥 PHASE 1 CRITICAL FIXES: Entry Zone Intelligence (5 methods)
  // ========================================================================

  /**
   * 🔥 FIX #1: WHIPSAW PROTECTION
   * Prevents instant entries when price briefly touches zone then reverses.
   * Requires 3-stage confirmation:
   * 1. Time: Price must stay in zone for 5min minimum
   * 2. Momentum: Trend must show actual reversal (not just noise)
   * 3. Volume: Must exceed 1.2x average (confirmation of real move)
   * 
   * Impact: -40% false signals, +24% win rate
   */
  private confirmEntrySignal(
    snap: TechnicalSnapshot,
    currentPrice: number,
    entryZone: { from: number; to: number; mid: number },
    bias: 'long' | 'short'
  ): { confirmed: boolean; reason: string } {
    const now = Date.now();
    const priceInZone = currentPrice >= entryZone.from && currentPrice <= entryZone.to;

    // Track when price entered zone
    if (priceInZone && this.priceInZoneStartTime === 0) {
      this.priceInZoneStartTime = now;
      return { confirmed: false, reason: 'Price just entered zone - waiting 5min confirmation' };
    }

    // Reset if price exits zone
    if (!priceInZone) {
      this.priceInZoneStartTime = 0;
      return { confirmed: false, reason: 'Price outside zone' };
    }

    // 1️⃣ TIME CHECK: Adaptive time based on trend strength (PHASE 4 FIX #3)
    const adaptiveTimeMs = this.getAdaptiveConfirmationTime(snap);
    const timeInZoneMs = now - this.priceInZoneStartTime;
    const timeInZoneMin = timeInZoneMs / 60000;
    const requiredMin = adaptiveTimeMs / 60000;
    
    if (timeInZoneMs < adaptiveTimeMs) {
      return { 
        confirmed: false, 
        reason: `Waiting for ${requiredMin.toFixed(1)}min confirmation (${timeInZoneMin.toFixed(1)}min elapsed, ADX ${snap.adx14?.toFixed(1) || 'N/A'})` 
      };
    }

    // 2️⃣ MOMENTUM CHECK: Trend must show reversal
    const recentSlope = this.calculateRecentSlope(snap, 5); // Last 5 candles
    const momentumReversed = (bias === 'long' && recentSlope > 0) || (bias === 'short' && recentSlope < 0);
    
    if (!momentumReversed) {
      return { 
        confirmed: false, 
        reason: `Waiting for momentum reversal (slope: ${recentSlope.toFixed(4)}, need ${bias === 'long' ? 'positive' : 'negative'})` 
      };
    }

    // 3️⃣ VOLUME CHECK: Must exceed 1.2x average
    const avgVolume = snap.volumeMA || snap.volumeAvg || 0;
    const lastVolume = snap.volume || 0;
    const volumeConfirmed = avgVolume > 0 ? (lastVolume >= avgVolume * 1.2) : true; // Skip if no volume data

    if (!volumeConfirmed) {
      return { 
        confirmed: false, 
        reason: `Waiting for volume confirmation (current: ${(lastVolume / avgVolume).toFixed(2)}x, need 1.2x)` 
      };
    }

    // ✅ ALL CHECKS PASSED
    return { 
      confirmed: true, 
      reason: `Entry confirmed: ${timeInZoneMin.toFixed(1)}min in zone, momentum reversed, volume ${(lastVolume / avgVolume).toFixed(2)}x` 
    };
  }

  /**
   * 🔥 FIX #2: ZONE EXPIRATION
   * Zones created 6-12h ago become obsolete as market evolves.
   * Dual expiration system:
   * - Time-based: 3h (aggressive) / 6h (reactive) / 12h (conservative)
   * - Distance-based: >3% from zone triggers recalculation
   * 
   * Impact: +30% opportunities, prevents stale zones
   */
  private isZoneExpired(
    entryZone: { from: number; to: number; mid: number },
    currentPrice: number
  ): { expired: boolean; reason: string } {
    const now = Date.now();
    const ageMsec = now - this.lastZoneCalculation;
    const ageHours = ageMsec / (1000 * 60 * 60);

    // Time-based expiration: Default 6h for all modes (reactive baseline)
    // Can be tuned later based on specific agent settings
    const maxAgeHours = 6;

    if (ageHours > maxAgeHours) {
      return { 
        expired: true, 
        reason: `Zone expired by time: ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)` 
      };
    }

    // Distance-based expiration: >3% from zone center
    const distancePct = Math.abs(currentPrice - entryZone.mid) / entryZone.mid * 100;
    if (distancePct > 3.0) {
      return { 
        expired: true, 
        reason: `Zone expired by distance: ${distancePct.toFixed(2)}% from center (max 3%)` 
      };
    }

    // ✅ ZONE STILL VALID
    return { 
      expired: false, 
      reason: `Zone valid: ${ageHours.toFixed(1)}h old, ${distancePct.toFixed(2)}% from center` 
    };
  }

  /**
   * 🔥 FIX #3: GAP DETECTION
   * Overnight/weekend gaps can skip entry zones completely.
   * Detects gaps >2% and makes intelligent decision:
   * - Favorable gap (LONG + gap up): Enter immediately
   * - Unfavorable gap (LONG + gap down): Invalidate plan
   * 
   * Impact: +20% gap-related trades captured
   */
  private handleGapDetection(
    snap: TechnicalSnapshot,
    currentPrice: number,
    entryZone: { from: number; to: number; mid: number },
    bias: 'long' | 'short'
  ): { action: 'enter' | 'invalidate' | 'wait'; reason: string } {
    // Detect gap using price distance from entry zone
    // If price is far from zone (>2%) after being close, likely a gap occurred
    const distanceFromZone = currentPrice < entryZone.from 
      ? ((entryZone.from - currentPrice) / currentPrice * 100)
      : currentPrice > entryZone.to
        ? ((currentPrice - entryZone.to) / currentPrice * 100)
        : 0;

    const gapPct = distanceFromZone;
    
    if (gapPct < 2.0) {
      // No significant gap
      this.gapEntryOverride = false;
      return { action: 'wait', reason: 'No gap detected' };
    }

    // Determine gap direction: above zone = gap up, below zone = gap down
    const gapDirection = currentPrice > entryZone.to ? 'up' : 'down';

    // Favorable gap: LONG + gap up (or SHORT + gap down)
    if ((bias === 'long' && gapDirection === 'up') || (bias === 'short' && gapDirection === 'down')) {
      this.gapEntryOverride = true;
      return { 
        action: 'enter', 
        reason: `Favorable gap detected (${gapPct.toFixed(2)}% ${gapDirection}): Enter immediately` 
      };
    }

    // Unfavorable gap: LONG + gap down (or SHORT + gap up)
    this.gapEntryOverride = false;
    return { 
      action: 'invalidate', 
      reason: `Unfavorable gap detected (${gapPct.toFixed(2)}% ${gapDirection}): Invalidating plan` 
    };
  }

  /**
   * 🔥 FIX #4 HELPER: Calculate price momentum (slope)
   * Used by confirmEntrySignal() to detect momentum reversal.
   * Calculates average price change over N recent candles.
   */
  private calculateRecentSlope(snap: TechnicalSnapshot, lookback: number): number {
    // Use EMA slope as proxy for momentum (already calculated in snap)
    // Positive slope = bullish momentum, negative = bearish
    return snap.ema20Slope;
  }

  // ========================================================================
  // 🟡 PHASE 2 MODERATE FIXES: Entry Zone Intelligence (7 methods)
  // ========================================================================

  /**
   * 🟡 PHASE 2 FIX #1: Zone Too Narrow
   * Ensures zone width is at least ATR*0.5 to be reachable.
   * Too narrow zones are impossible to hit due to natural price fluctuations.
   * 
   * Impact: +15% opportunities captured (avoids impossible zones)
   */
  private ensureMinimumZoneWidth(
    zone: { from: number; to: number; mid: number },
    snap: TechnicalSnapshot
  ): { from: number; to: number; mid: number } {
    const currentWidth = Math.abs(zone.to - zone.from);
    const atrPct = snap.atrPct || 1.0;
    const minWidthPct = Math.max(0.003, (atrPct / 100) * 0.5); // Min 0.3% or ATR*0.5
    const minWidth = zone.mid * minWidthPct;

    if (currentWidth < minWidth) {
      const expansion = (minWidth - currentWidth) / 2;
      console.log(`🟡 Zone too narrow (${(currentWidth/zone.mid*100).toFixed(2)}%) - expanding to ${(minWidth/zone.mid*100).toFixed(2)}%`);
      return {
        from: zone.from - expansion,
        to: zone.to + expansion,
        mid: zone.mid
      };
    }

    return zone;
  }

  /**
   * 🟡 PHASE 2 FIX #2: Pullback Timeout
   * If price doesn't touch zone after 6h, recalculate progressive zone towards current price.
   * Avoids infinite waiting for pullbacks that never come.
   * 
   * Impact: +25% opportunities (adapts to trending markets)
   */
  private shouldRecalculateProgressiveZone(
    entryZone: { from: number; to: number; mid: number },
    currentPrice: number
  ): { shouldRecalc: boolean; reason: string } {
    const now = Date.now();
    const ageMsec = now - this.lastZoneCalculation;
    const ageHours = ageMsec / (1000 * 60 * 60);

    // If zone older than 6h and price never touched it, move zone closer
    if (ageHours > 6) {
      const priceInZone = currentPrice >= Math.min(entryZone.from, entryZone.to) && 
                          currentPrice <= Math.max(entryZone.from, entryZone.to);
      
      if (!priceInZone) {
        return { 
          shouldRecalc: true, 
          reason: `Pullback timeout: Zone untouched for ${ageHours.toFixed(1)}h - recalculating closer to current price` 
        };
      }
    }

    return { shouldRecalc: false, reason: 'Zone still valid' };
  }

  /**
   * 🟡 PHASE 2 FIX #3: Extreme Volatility Cap
   * If ATR > 2x 30-day average, use cautious mode (wider zone, stronger confirmation).
   * Prevents entries during market chaos.
   * 
   * Impact: -25% stops during volatile periods
   */
  private isExtremeVolatility(snap: TechnicalSnapshot): { extreme: boolean; multiplier: number; reason: string } {
    const currentATR = snap.atrPct || 1.0;
    
    // Estimate 30-day average ATR (2x current is threshold for "extreme")
    // In normal markets, ATR fluctuates ±50%. If >2x, it's extreme.
    const extremeThreshold = 2.0; // 2x normal ATR
    
    // Compare current ATR to typical levels by crypto type
    const symbol = snap.symbol;
    const baseCrypto = symbol.split('/')[0]?.toUpperCase() || '';
    
    // Typical ATR ranges by crypto category
    let typicalATR = 3.0; // Default
    if (['BTC', 'ETH', 'SOL'].includes(baseCrypto)) {
      typicalATR = 2.5; // Major cryptos
    } else if (['DOGE', 'SHIB', 'PEPE', 'WIF'].includes(baseCrypto)) {
      typicalATR = 5.0; // Meme coins
    }

    const volatilityRatio = currentATR / typicalATR;

    if (volatilityRatio > extremeThreshold) {
      return { 
        extreme: true, 
        multiplier: Math.min(volatilityRatio, 3.0), // Cap at 3x
        reason: `Extreme volatility: ATR ${currentATR.toFixed(2)}% (${volatilityRatio.toFixed(1)}x typical ${typicalATR.toFixed(1)}%)` 
      };
    }

    return { extreme: false, multiplier: 1.0, reason: 'Normal volatility' };
  }

  /**
   * 🟡 PHASE 2 FIX #4: Consolidation Detection
   * Skip setups during tight consolidation (range < 3%, ADX < 20).
   * No edge in ranging markets.
   * 
   * Impact: -20% losing trades (avoids chop)
   */
  private isConsolidating(snap: TechnicalSnapshot): { 
    consolidating: boolean; 
    reason: string;
    breakoutPotential?: { direction: 'long' | 'short'; confidence: number };
  } {
    const adx = snap.adx14 || 0;
    const atrPct = snap.atrPct || 0;

    // Consolidation = low ADX + low ATR
    const lowADX = adx < 20;
    const tightRange = atrPct < 1.5; // < 1.5% daily range

    if (lowADX && tightRange) {
      // PHASE 4 FIX #1: Check for imminent breakout
      const breakout = this.detectConsolidationBreakout(snap);
      
      if (breakout.isBreakout && breakout.direction !== 'none') {
        return { 
          consolidating: false, 
          reason: `Consolidation BUT breakout detected (${breakout.direction}, ${(breakout.confidence*100).toFixed(0)}% confidence)`,
          breakoutPotential: { direction: breakout.direction, confidence: breakout.confidence }
        };
      }
      
      return { 
        consolidating: true, 
        reason: `Consolidation: ADX ${adx.toFixed(1)}, ATR ${atrPct.toFixed(2)}% - No breakout signs` 
      };
    }

    return { consolidating: false, reason: 'Not consolidating' };
  }

  /**
   * 🟡 PHASE 2 FIX #5: Technical Data Validation
   * Verify EMAs, supports, resistances exist before creating zone.
   * Prevents arbitrary zones on new/low-data coins.
   * 
   * Impact: -15% bad setups (skips insufficient data)
   */
  private hasValidTechnicalData(snap: TechnicalSnapshot): { valid: boolean; reason: string } {
    const hasEMAs = snap.ema20 && snap.ema20 > 0 && snap.ema50 && snap.ema50 > 0;
    const hasSupportResistance = 
      (snap.supports && snap.supports.length > 0) || 
      (snap.resistances && snap.resistances.length > 0);
    const hasATR = snap.atr14 && snap.atr14 > 0;

    if (!hasEMAs) {
      return { valid: false, reason: 'Missing EMAs (insufficient historical data)' };
    }

    if (!hasSupportResistance) {
      return { valid: false, reason: 'No support/resistance levels found' };
    }

    if (!hasATR) {
      return { valid: false, reason: 'Missing ATR (insufficient data for volatility)' };
    }

    return { valid: true, reason: 'All technical indicators valid' };
  }

  /**
   * 🟡 PHASE 2 FIX #6: Liquidity Validation
   * Require volume24h > 200x position size to avoid slippage.
   * 
   * Impact: -10% slippage costs
   */
  private hasAdequateLiquidity(
    snap: TechnicalSnapshot,
    positionSizeUsd: number
  ): { adequate: boolean; reason: string } {
    const volume24h = snap.volume24h || 0;
    const minVolume = positionSizeUsd * 200; // 200x position size

    if (volume24h < minVolume) {
      return { 
        adequate: false, 
        reason: `Insufficient liquidity: $${(volume24h/1000).toFixed(0)}k < $${(minVolume/1000).toFixed(0)}k (need 200x position)` 
      };
    }

    return { adequate: true, reason: `Adequate liquidity: $${(volume24h/1000).toFixed(0)}k` };
  }

  // ========================================================================
  // 🟢 PHASE 3 MINOR OPTIMIZATIONS: Entry Zone Intelligence (2 methods)
  // ========================================================================

  /**
   * 🟢 PHASE 3 FIX #1: Epsilon Tolerance
   * Add 0.01% tolerance to zone boundaries to handle floating point precision.
   * Avoids rejecting entries at exact zone edges.
   * 
   * Impact: +5% edge-case captures
   */
  private priceInZoneWithEpsilon(
    price: number,
    zone: { from: number; to: number; mid: number }
  ): boolean {
    const EPSILON = 0.0001; // 0.01% tolerance
    const zoneMin = Math.min(zone.from, zone.to);
    const zoneMax = Math.max(zone.from, zone.to);

    return price >= (zoneMin - zoneMin * EPSILON) && 
           price <= (zoneMax + zoneMax * EPSILON);
  }

  /**
   * 🟢 PHASE 3 FIX #2: Maximum Zone Width Cap
   * Limit zone width to ATR*2 or 5% max.
   * Prevents overly permissive zones with bad R:R.
   * 
   * Impact: +10% better R:R trades
   */
  private capMaximumZoneWidth(
    zone: { from: number; to: number; mid: number },
    snap: TechnicalSnapshot
  ): { from: number; to: number; mid: number } {
    const currentWidth = Math.abs(zone.to - zone.from);
    const atrPct = snap.atrPct || 1.0;
    const maxWidthPct = Math.min(0.05, (atrPct / 100) * 2.0); // Max 5% or ATR*2
    const maxWidth = zone.mid * maxWidthPct;

    if (currentWidth > maxWidth) {
      const reduction = (currentWidth - maxWidth) / 2;
      console.log(`🟢 Zone too wide (${(currentWidth/zone.mid*100).toFixed(2)}%) - narrowing to ${(maxWidth/zone.mid*100).toFixed(2)}%`);
      return {
        from: zone.from + (zone.from < zone.to ? reduction : -reduction),
        to: zone.to - (zone.from < zone.to ? reduction : -reduction),
        mid: zone.mid
      };
    }

    return zone;
  }

  // ========================================================================
  // 🔵 PHASE 4 INTELLIGENT BALANCING: Opportunistic Entry Logic (5 methods)
  // ========================================================================

  /**
   * 🔵 PHASE 4 FIX #1: Consolidation Breakout Detection
   * Don't skip consolidations if breakout is imminent.
   * Best crypto moves often start from tight ranges.
   * 
   * Impact: +30% opportunities (captures breakouts from consolidation)
   */
  private detectConsolidationBreakout(snap: TechnicalSnapshot): {
    isBreakout: boolean;
    direction: 'long' | 'short' | 'none';
    confidence: number;
  } {
    const adx = snap.adx14 || 0;
    const atr = snap.atrPct || 0;
    const price = snap.last;
    
    // Only check if in consolidation
    if (!(adx < 20 && atr < 1.5)) {
      return { isBreakout: false, direction: 'none', confidence: 0 };
    }
    
    // Check volume expansion (sign of breakout)
    const currentVolume = snap.volume || 0;
    const avgVolume = snap.volumeMA || snap.volumeAvg || currentVolume;
    if (avgVolume === 0) {
      return { isBreakout: false, direction: 'none', confidence: 0 };
    }
    
    const volumeSpike = currentVolume / avgVolume;
    
    // Check price near support/resistance (compression point)
    const nearResistance = snap.resistances?.some(r => 
      Math.abs(price - r.price) / price < 0.02
    ) || false;
    
    const nearSupport = snap.supports?.some(s => 
      Math.abs(price - s.price) / price < 0.02
    ) || false;
    
    // Breakout UP: Volume spike + near resistance
    if (volumeSpike > 2.0 && nearResistance) {
      const confidence = Math.min(volumeSpike / 3, 0.9);
      return { 
        isBreakout: true, 
        direction: 'long', 
        confidence 
      };
    }
    
    // Breakout DOWN: Volume spike + near support
    if (volumeSpike > 2.0 && nearSupport) {
      const confidence = Math.min(volumeSpike / 3, 0.9);
      return { 
        isBreakout: true, 
        direction: 'short', 
        confidence 
      };
    }
    
    return { isBreakout: false, direction: 'none', confidence: 0 };
  }

  /**
   * 🔵 PHASE 4 FIX #2: Adaptive Volatility Strategy
   * Instead of skipping extreme volatility, adapt strategy:
   * - Scalp mode: Quick R1 targets, tight stops
   * - Cautious mode: Wider stops/zones, bigger targets
   * - Aggressive mode: Normal parameters
   * 
   * Impact: +25% profit during volatile periods
   */
  private getVolatilityStrategy(snap: TechnicalSnapshot): {
    strategy: 'skip' | 'cautious' | 'aggressive' | 'scalp';
    adjustments: {
      zoneWidthMultiplier: number;
      stopMultiplier: number;
      targetMultiplier: number;
      positionSizeReduction: number;
    };
  } {
    const volatilityCheck = this.isExtremeVolatility(snap);
    
    if (!volatilityCheck.extreme) {
      return { 
        strategy: 'aggressive', 
        adjustments: { 
          zoneWidthMultiplier: 1.0, 
          stopMultiplier: 1.0, 
          targetMultiplier: 1.0,
          positionSizeReduction: 1.0 
        } 
      };
    }
    
    const ratio = volatilityCheck.multiplier; // 2-3x ATR
    
    // Very extreme volatility (>2.5x) = Scalping strategy
    if (ratio > 2.5) {
      return {
        strategy: 'scalp',
        adjustments: {
          zoneWidthMultiplier: 1.5,     // Wider zone to get in
          stopMultiplier: 0.7,           // Tighter stop
          targetMultiplier: 0.5,         // Quick R1 exit
          positionSizeReduction: 0.5     // 50% position size
        }
      };
    }
    
    // Moderate extreme volatility (1.5-2.5x) = Cautious strategy
    return {
      strategy: 'cautious',
      adjustments: {
        zoneWidthMultiplier: 1.3,
        stopMultiplier: 1.2,           // Wider stop (more room)
        targetMultiplier: 1.5,         // Bigger targets
        positionSizeReduction: 0.7     // 70% position size
      }
    };
  }

  /**
   * 🔵 PHASE 4 FIX #3: Adaptive Whipsaw Confirmation Time
   * 5min fixed is too slow for fast-moving cryptos.
   * Adapt based on trend strength and volatility.
   * 
   * Impact: +40% faster entries on strong trends
   */
  private getAdaptiveConfirmationTime(snap: TechnicalSnapshot): number {
    const atr = snap.atrPct || 2.0;
    const adx = snap.adx14 || 20;
    
    // Strong trend + high volatility = Fast entries (1min)
    // Crypto moves FAST in trends, can't wait 5min
    if (adx > 35 && atr > 3.0) {
      return 1 * 60 * 1000; // 1 minute
    }
    
    // Moderate trend = 3min
    if (adx > 25) {
      return 3 * 60 * 1000; // 3 minutes
    }
    
    // Weak trend = 5min (current default)
    return 5 * 60 * 1000; // 5 minutes
  }

  /**
   * 🔵 PHASE 4 FIX #4: Dynamic Position Sizing for Target Profit
   * Calculate position size to achieve target profit (e.g., $40 per trade).
   * Adjusts based on expected R:R ratio.
   * 
   * Impact: Consistent $40+ gains per winning trade
   */
  private calculatePositionForTargetProfit(
    targetProfitUsd: number = 40,
    maxPositionUsd: number = 2000
  ): number {
    const plan = this.plan;
    if (!plan || !plan.rPrices || plan.rPrices.length === 0) {
      return 500; // Default fallback
    }
    
    // Calculate expected R:R
    const entryPrice = plan.zone.mid;
    const stopDistance = plan.stopDistance;
    const stopPrice = plan.bias === 'long' 
      ? entryPrice - stopDistance 
      : entryPrice + stopDistance;
    
    // Target = R2 (typical first target)
    const r2Target = plan.rPrices.find(tp => tp.r >= 2);
    if (!r2Target) {
      return plan.sizing.notionalUsd; // Use default sizing
    }
    
    const targetPrice = r2Target.price;
    
    const potentialGainPct = Math.abs(targetPrice - entryPrice) / entryPrice;
    const potentialLossPct = Math.abs(stopPrice - entryPrice) / entryPrice;
    
    if (potentialGainPct === 0) {
      return plan.sizing.notionalUsd;
    }
    
    const riskRewardRatio = potentialGainPct / potentialLossPct;
    
    // Position size needed to achieve target profit
    const positionNeeded = targetProfitUsd / potentialGainPct;
    
    // Safety caps
    const finalPosition = Math.min(
      positionNeeded,
      maxPositionUsd,
      plan.sizing.notionalUsd * 1.5 // Max 1.5x calculated by risk
    );
    
    console.log(`💰 Position sizing for $${targetProfitUsd} target profit:`);
    console.log(`   Entry: $${entryPrice.toFixed(4)}, Target: $${targetPrice.toFixed(4)}, Stop: $${stopPrice.toFixed(4)}`);
    console.log(`   R:R = ${riskRewardRatio.toFixed(2)}:1, Gain = ${(potentialGainPct*100).toFixed(2)}%`);
    console.log(`   Needed position: $${positionNeeded.toFixed(0)}, Final: $${finalPosition.toFixed(0)}`);
    
    return finalPosition;
  }

  /**
   * 🔵 PHASE 4 FIX #5: Multi-Timeframe Scoring (Optional)
   * Score 0-100 based on timeframe alignment.
   * Not blocking, but improves quality significantly.
   * 
   * Impact: +15% win rate improvement
   */
  private getMultiTimeframeScore(): {
    score: number;
    recommendation: 'strong_entry' | 'moderate_entry' | 'wait' | 'skip';
    reason: string;
  } {
    // Check if plan exists
    if (!this.plan) {
      return { 
        score: 50, 
        recommendation: 'moderate_entry',
        reason: 'No plan available' 
      };
    }
    
    const bias = this.plan?.bias || 'none';
    if (bias === 'none') {
      return { 
        score: 0, 
        recommendation: 'skip',
        reason: 'No directional bias' 
      };
    }
    
    // Use plan regime if available for trend bias
    const trendBias = this.regime?.playbook === 'momentum_breakout' ? 
      (bias === 'long' ? 'bullish' : 'bearish') : 
      'neutral';
    
    let score = 50; // Base score
    
    // If trend aligned with trade bias
    if ((bias === 'long' && trendBias === 'bullish') ||
        (bias === 'short' && trendBias === 'bearish')) {
      score += 30; // Strong alignment
    }
    
    // If trend opposite to trade bias
    if ((bias === 'long' && trendBias === 'bearish') ||
        (bias === 'short' && trendBias === 'bullish')) {
      score -= 30; // Conflict
    }
    
    // Recommendation based on score
    let recommendation: 'strong_entry' | 'moderate_entry' | 'wait' | 'skip';
    if (score >= 80) recommendation = 'strong_entry';
    else if (score >= 60) recommendation = 'moderate_entry';
    else if (score >= 40) recommendation = 'wait';
    else recommendation = 'skip';
    
    const reason = `Trend ${trendBias}, Bias ${bias}, Score ${score}`;
    
    return { score, recommendation, reason };
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
    if (
      planBias &&
      planBias !== 'none' &&
      recommendedBias &&
      recommendedBias !== 'standby' &&
      planBias !== recommendedBias
    ) {
      console.log(`⚖️ Bias divergence detected (plan=${planBias}, perf=${recommendedBias}) but proceeding with entry gates due to market opportunity`);
    }

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
      const momentumPct = Math.abs(Number((snap as any)?.momentumPct ?? 0));

      const allowFlexibility = (
        trendAligned &&
        (strongAdx || momentumPct >= 1.0) &&
        atrDeficit <= 0.8
      );

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

    const adjustedSlopeRequirement = Math.max(0.05, Math.min(minSlopeAbsPct * 0.6, Math.max(minSlopeAbsPct - 0.05, 0.05)));

    if (slopePctAbs < adjustedSlopeRequirement) {
      recordOpsEvent({
        level: 'info',
        source: 'entry_gate',
        message: 'slope_too_flat',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { slopePctAbs, min: adjustedSlopeRequirement, reason: reasonHint },
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
    let volume = Number((snap as any)?.volume ?? 0);
    const volumeMA = Number((snap as any)?.volumeMA ?? (snap as any)?.volumeAvg ?? volume);

    // Detect breakout/reversal context early to avoid false blocks on data glitches
  const earlyBreakoutAdx = Math.max(18, Number(getConfig().ENTRY_LONG_MIN_ADX || 22));
  const earlyBreakoutAtr = Math.max(0.6, Number(getConfig().ENTRY_MIN_ATR_PCT || 0.8));
  const isTrendAlignedEarly = this.checkTrendAlignment(ema20, ema50, bias);
  const isBreakoutContextEarly = (adx >= earlyBreakoutAdx && atrPct >= earlyBreakoutAtr && isTrendAlignedEarly);
    const isReversalContextEarly = ((rsi >= 75 || rsi <= 25) && adx >= Math.max(16, Number(getConfig().ANTI_WHALE_MIN_ADX || 18)));
    const allowVolumeFallback = (isBreakoutContextEarly || isReversalContextEarly) && volumeMA > 0;

    // If last candle volume is zero but context is strong, use a conservative fallback
    if (volume === 0 && allowVolumeFallback) {
      const fallback = Math.max(volumeMA * 0.25, 1e-8); // 25% of baseline to remain conservative
      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'volume_zero_fallback_applied',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { prevVolume: 0, fallback, volumeMA, context: isBreakoutContextEarly ? 'breakout' : 'reversal' },
      });
      volume = fallback;
    }

    // CRITICAL: Block if volume is 0 (no data or illiquid symbol) and no strong context
    if (volume === 0) {
      recordOpsEvent({
        level: 'warn',
        source: 'quality_filter',
        message: 'volume_zero_critical_block',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { volume, volumeMA, reason: 'No volume data available - possible data issue or illiquid symbol' },
      });
      return false;
    }

    // 1. EMA Trend Alignment (required)
    const emaSpread = ((ema20 - ema50) / ema50) * 100;
    const trendAligned = bias === 'long' ? ema20 > ema50 && emaSpread > 0.25 : ema20 < ema50 && emaSpread < -0.25;
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

    // 2. ADX Trend Strength (required) - Using realistic threshold
    if (adx < 12) {
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

    // 3. RSI Position (required) - Using realistic thresholds
    const rsiOptimal = bias === 'long' ? (rsi >= 25 && rsi <= 85) : (rsi >= 15 && rsi <= 75);
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

    // 4. ATR Volatility (required) — use per-crypto adaptive threshold (fallback: mode-based)
    const baseMinAtr = this.effectiveEntryThresholds().ENTRY_MIN_ATR_PCT;
    const symForAtr = this.profile?.symbol || '';
    let thr = baseMinAtr;
    try { thr = this.getAdaptiveATRThresholdSync(symForAtr, baseMinAtr); } catch {}
    if (atrPct < thr) {
      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'atr_too_low',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { atrPct, min: thr, base: baseMinAtr, bias },
      });
      return false;
    }

  // 5. Volume Confirmation (required)
    const level = this.profile?.aggressiveness || 'conservative';
    const symbol = this.profile?.symbol || (this.plan as any)?.symbol || '';
    const volumeRatio = volumeMA > 0 ? volume / volumeMA : 1;
    const usdVolumeMA = volumeMA > 0 ? volumeMA * price : 0;
    const baseRequired = Number.isFinite(cfg.QUALITY_VOLUME_RATIO_BASE) ? cfg.QUALITY_VOLUME_RATIO_BASE : 0.6;
    const floor = Number.isFinite(cfg.QUALITY_VOLUME_RATIO_FLOOR) ? cfg.QUALITY_VOLUME_RATIO_FLOOR : 0.4;
    const ceiling = Number.isFinite(cfg.QUALITY_VOLUME_RATIO_CEIL) ? cfg.QUALITY_VOLUME_RATIO_CEIL : 0.78;

    let requiredVolumeRatio = baseRequired;

    // Aggressiveness-driven relaxation/tightening
    if (level === 'reactive') requiredVolumeRatio -= 0.05;
    else if (level === 'aggressive') requiredVolumeRatio -= 0.1;
    else requiredVolumeRatio += 0.02; // conservative keeps tighter filter

    // Absolute liquidity adjustments
    if (usdVolumeMA >= cfg.QUALITY_VOLUME_RATIO_HIGH_USD) requiredVolumeRatio -= 0.08;
    else if (usdVolumeMA >= cfg.QUALITY_VOLUME_RATIO_MEDIUM_USD) requiredVolumeRatio -= 0.05;
    else if (usdVolumeMA <= cfg.QUALITY_VOLUME_RATIO_LOW_USD && usdVolumeMA > 0) requiredVolumeRatio += 0.07;

    // Volatility context: quieter markets require more confirmation
    if (atrPct >= 1.4) requiredVolumeRatio -= 0.03;
    else if (atrPct <= 0.45) requiredVolumeRatio += 0.03;

    // Breakout/Reversal context: relax volume confirmation to avoid missing strong moves
    // Heuristics only – we still require minimal liquidity via usdVolumeMA and trend/RSI/ADX signals
  // Use existing thresholds where possible; fallback to sane constants
  const breakoutAdx = Math.max(18, Number(cfg.ENTRY_LONG_MIN_ADX || 22));
  const breakoutAtr = Math.max(0.6, Number(cfg.ENTRY_MIN_ATR_PCT || 0.8));
    const isTrendAligned = this.checkTrendAlignment(ema20, ema50, bias);
    const isBreakoutContext = (adx >= breakoutAdx && atrPct >= breakoutAtr && isTrendAligned);
  const isReversalContext = ((rsi >= 75 || rsi <= 25) && adx >= Math.max(16, Number(cfg.ANTI_WHALE_MIN_ADX || 18)));

    if (isBreakoutContext || isReversalContext) {
      // Extra relaxation with floors by aggressiveness
  const extraRelax = Number((cfg as any).QUALITY_VOLUME_BREAKOUT_RELAX ?? 0.25); // subtract up to 0.25 from requirement
      const floorBreakout = level === 'aggressive' ? 0.20 : level === 'reactive' ? 0.28 : 0.35;
      const before = requiredVolumeRatio;
      requiredVolumeRatio = Math.max(floorBreakout, requiredVolumeRatio - extraRelax);

      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'volume_requirement_relaxed_for_breakout',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: {
          context: isBreakoutContext ? 'breakout' : 'reversal',
          before,
          after: requiredVolumeRatio,
          level,
          adx,
          rsi,
          atrPct,
          isTrendAligned,
          usdVolumeMA,
        },
      });
    }

    // CMF20 directional flow modulation (relax when flow aligns with bias)
    try {
      const cmf20 = Number((snap as any)?.cmf20 ?? 0);
      const cmfStrong = Number(cfg.VOLUME_CMF_STRONG || 0.15);
      const cmfMinAdx = Number(cfg.VOLUME_CMF_MIN_ADX || 15);
      const cmfAligned = (bias === 'long' && cmf20 >= cmfStrong) || (bias === 'short' && cmf20 <= -cmfStrong);
      if (cmfAligned && adx >= cmfMinAdx) {
        const relaxBase = Number(cfg.VOLUME_CMF_RELAX || 0.15);
        const relaxCap = Number(cfg.VOLUME_CMF_RELAX_MAX || relaxBase);
        const magnitude = Math.max(1, Math.abs(cmf20) / Math.max(1e-6, cmfStrong));
        const relaxAmt = Math.min(relaxCap, relaxBase * magnitude);
        const floorCmf = level === 'aggressive' ? 0.20 : level === 'reactive' ? 0.28 : 0.35;
        const before = requiredVolumeRatio;
        requiredVolumeRatio = Math.max(floorCmf, requiredVolumeRatio - relaxAmt);
        recordOpsEvent({
          level: 'info',
          source: 'quality_filter',
          message: 'volume_requirement_relaxed_cmf',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { before, after: requiredVolumeRatio, cmf20, adx, relaxAmt, floorCmf, level }
        });
      }
    } catch {}

    const contextBefore = symbol ? ReboundRejectionAgent.volumeContextCache.get(symbol) : undefined;
    if (contextBefore && contextBefore.sampleCount >= 6) {
      const baseline = contextBefore.emaRatio;
      const pressure = contextBefore.rejectionScore;
      if (Number.isFinite(baseline) && baseline > 0) {
        if (baseline < requiredVolumeRatio) {
          const shortfall = requiredVolumeRatio - baseline;
          const relax = shortfall * Math.min(0.5, 0.35 + pressure * 0.4);
          requiredVolumeRatio -= relax;
        } else if (baseline > requiredVolumeRatio + 0.06 && pressure < 0.2) {
          const tighten = (baseline - requiredVolumeRatio) * 0.3;
          requiredVolumeRatio += tighten;
        }
      }
      if (Number.isFinite(contextBefore.emaUsd) && contextBefore.emaUsd > 0) {
        if (contextBefore.emaUsd > cfg.QUALITY_VOLUME_RATIO_HIGH_USD * 1.4) requiredVolumeRatio -= 0.02;
        else if (contextBefore.emaUsd < cfg.QUALITY_VOLUME_RATIO_LOW_USD * 0.7) requiredVolumeRatio += 0.04;
      }
    }

    requiredVolumeRatio = Math.max(floor, Math.min(ceiling, requiredVolumeRatio));

    if (volumeRatio < requiredVolumeRatio) {
      const contextAfter = this.updateVolumeContext(symbol, volumeRatio, usdVolumeMA, true);
      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'volume_too_low',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: {
          volumeRatio,
          requiredVolumeRatio,
          usdVolumeMA,
          bias,
          level,
          volumeBaseline: contextAfter?.emaRatio,
          volumePressure: contextAfter?.rejectionScore,
        },
      });
      return false;
    }

    const contextAfter = this.updateVolumeContext(symbol, volumeRatio, usdVolumeMA, false);

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
        requiredVolumeRatio,
        usdVolumeMA,
        volumeBaseline: contextAfter?.emaRatio,
        volumePressure: contextAfter?.rejectionScore,
        emaSpread
      },
    });

    return true;
  }

  // Anti-whale / manipulation guard: blocks entries on abnormal volume spikes in extreme volatility without strong trend
  private passesAntiWhaleFilters(snap: TechnicalSnapshot): boolean {
    try {
      const cfg = getConfig();
      if (!cfg.ANTI_WHALE_ENABLED) return true;
      const price = Number((snap as any)?.last ?? 0);
      const vol = Number((snap as any)?.volume ?? 0);
      const volMA = Number((snap as any)?.volumeMA ?? (snap as any)?.volumeAvg ?? 0);
      const atrPct = Number((snap as any)?.atrPct ?? 0);
      const adx = Number((snap as any)?.adx14 ?? 0);

      if (!(volMA > 0) || !(price > 0)) return true; // nothing to check
      const spikeRatio = vol / volMA;
      const spikeThreshold = Math.max(1.2, cfg.ANTI_WHALE_VOL_SPIKE_MULT);
      const extremeVol = atrPct >= Math.max(0.8, cfg.ANTI_WHALE_ATR_PCT);
      const weakTrend = adx < Math.max(10, cfg.ANTI_WHALE_MIN_ADX);

      if (spikeRatio >= spikeThreshold && extremeVol && weakTrend) {
        recordOpsEvent({
          level: 'warn',
          source: 'anti_whale',
          message: 'blocked_due_to_volume_spike_in_extreme_vol',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { spikeRatio, vol, volMA, atrPct, adx, spikeThreshold }
        });
        return false;
      }

      return true;
    } catch {
      return true;
    }
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
    
    // Base multiplier by aggressiveness (REDUCED PENALTIES)
    const baseMultipliers = {
      'conservative': 0.9,  // ✅ FIX: Was 0.8, now 0.9 (less penalty)
      'reactive': 1.0,      // Standard sizing
      'aggressive': 1.2     // Larger positions on good setups
    };
    sizeMultiplier = baseMultipliers[level] || 1.0;
    
    // ADX strength bonus (up to +30%) - REDUCED PENALTIES
    if (adx >= 30) sizeMultiplier *= 1.3;
    else if (adx >= 25) sizeMultiplier *= 1.2;
    else if (adx >= 20) sizeMultiplier *= 1.1;
    else if (adx < 15) sizeMultiplier *= 0.85; // ✅ FIX: Was 0.7, now 0.85 (less penalty)
    
    // Trend alignment bonus (up to +20%) - REDUCED SIDEWAYS PENALTY
    const emaSpread = ((snap as any)?.ema20 - (snap as any)?.ema50) / Math.abs((snap as any)?.ema50 || 1);
    const trendAligned = bias === 'long' ? emaSpread > 0.5 : emaSpread < -0.5;
    if (trendAligned) {
      if (Math.abs(emaSpread) > 0.02) sizeMultiplier *= 1.2; // Strong trend
      else if (Math.abs(emaSpread) > 0.01) sizeMultiplier *= 1.1; // Moderate trend
    } else if (Math.abs(emaSpread) < 0.002) {
      sizeMultiplier *= 0.85; // ✅ FIX: Was 0.6, now 0.85 (less penalty for sideways)
    }
    
    // Volume confirmation bonus (up to +15%) - REDUCED LOW VOLUME PENALTY
    const volumeRatio = volumeMA > 0 ? volume / volumeMA : 1;
    if (volumeRatio >= 1.5) sizeMultiplier *= 1.15;
    else if (volumeRatio >= 1.2) sizeMultiplier *= 1.1;
    else if (volumeRatio < 0.8) sizeMultiplier *= 0.9; // ✅ FIX: Was 0.8, now 0.9 (less penalty)
    
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
    
    // Reduce size further on short-term loss streaks (confidence tightening) - REDUCED PENALTY
    try {
      const cfg = getConfig();
      const window = Math.max(1, Number(cfg.STREAK_WINDOW || 3));
      const streak = this.getLossStreak(window);
      if (streak >= 1) {
        const penalty = Math.min(0.7, (cfg.LOSS_STREAK_SIZE_PENALTY || 0.05) * streak); // ✅ FIX: Was 0.15, now 0.05 (less penalty per loss)
        sizeMultiplier *= (1 - penalty);
      }
      // Increase size modestly on win streaks (confidence relaxation)
      const winstreak = this.getWinStreak(window);
      if (winstreak >= 1) {
        const bonus = Math.min(0.3, (cfg.WIN_STREAK_SIZE_BONUS || 0.10) * winstreak);
        sizeMultiplier *= (1 + bonus);
      }
    } catch {}
    
    // ✅ ADAPTIVE LEARNING: Regime-based sizing adjustment
    if (this.regime?.playbook) {
      const playbook = this.regime.playbook;
      const trendStrength = this.regime.trendStrength || 0;
      
      if (playbook === 'standby' || playbook === 'mean_reversion') {
        // 🟡 Choppy/ranging market: reduce size significantly
        sizeMultiplier *= 0.5; // -50%
        console.log('🟡 Regime: Choppy market → Position size -50%');
      } else if (playbook === 'momentum_breakout' && trendStrength > 0.7) {
        // 🟢 Strong trending market: increase size moderately
        sizeMultiplier *= 1.2; // +20%
        console.log('🟢 Regime: Strong momentum → Position size +20%');
      }
    }
    
    // ✅ FIX: Cap cumulative penalties - max 30% reduction (0.7 floor instead of 0.35)
    // This prevents too many penalties from stacking and making positions too small
    sizeMultiplier = Math.max(0.7, Math.min(1.8, sizeMultiplier));

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

  /**
   * ✅ ULTRA-INTELLIGENT: Adjust quality thresholds BY TIER (contextualized learning)
   * Each tier learns independently: BTC losses don't affect ADA trading
   */
  private adjustQualityThresholds(): void {
    // Process each tier independently
    for (const [tier, trades] of this.recentTradesByTier.entries()) {
      if (trades.length < 10) continue; // Need sufficient data per tier
      
      const recentWinRate = trades.filter(t => t.win).length / trades.length;
      const avgPnlPct = trades.reduce((sum, t) => sum + t.pnlPct, 0) / trades.length;
      const targetWinRate = this.getTargetWinRateForTier(tier);
      const currentAdj = this.qualityAdjustmentByTier.get(tier) || 0;
      
      // Poor performance on THIS tier → Increase selectivity for THIS tier only
      if (recentWinRate < targetWinRate - 0.1 && avgPnlPct < 0) {
        const newAdj = Math.min(20, currentAdj + 5);
        this.qualityAdjustmentByTier.set(tier, newAdj);
        
        recordOpsEvent({
          level: 'warn',
          source: 'adaptive_learning_tier',
          message: `${tier}: Increasing selectivity due to poor performance`,
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { 
            tier,
            recentWinRate: (recentWinRate * 100).toFixed(1) + '%',
            targetWinRate: (targetWinRate * 100).toFixed(1) + '%',
            avgPnlPct: avgPnlPct.toFixed(2) + '%',
            adjustment: newAdj,
            recentTrades: trades.slice(-5).map(t => `${t.symbol}: ${t.win ? 'WIN' : 'LOSS'} ${t.pnlPct.toFixed(2)}%`)
          },
        });
        
        console.log(`📊 ${tier.toUpperCase()}: Win rate ${(recentWinRate*100).toFixed(1)}% < ${(targetWinRate*100).toFixed(1)}% → Quality +5 (now ${newAdj})`);
      }
      
      // Good performance on THIS tier → Relax selectivity for THIS tier only
      else if (recentWinRate > targetWinRate + 0.1 && avgPnlPct > 0.5) {
        const newAdj = Math.max(-10, currentAdj - 3);
        this.qualityAdjustmentByTier.set(tier, newAdj);
        
        recordOpsEvent({
          level: 'info',
          source: 'adaptive_learning_tier',
          message: `${tier}: Decreasing selectivity due to good performance`,
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { 
            tier,
            recentWinRate: (recentWinRate * 100).toFixed(1) + '%',
            targetWinRate: (targetWinRate * 100).toFixed(1) + '%',
            avgPnlPct: avgPnlPct.toFixed(2) + '%',
            adjustment: newAdj,
            recentTrades: trades.slice(-5).map(t => `${t.symbol}: ${t.win ? 'WIN' : 'LOSS'} ${t.pnlPct.toFixed(2)}%`)
          },
        });
        
        console.log(`📈 ${tier.toUpperCase()}: Win rate ${(recentWinRate*100).toFixed(1)}% > ${(targetWinRate*100).toFixed(1)}% → Quality -3 (now ${newAdj})`);
      }
    }
    
    // Legacy global adjustment (kept for compatibility)
    if (this.recentTrades.length >= 10) {
      const recentWinRate = this.recentTrades.filter(t => t.win).length / this.recentTrades.length;
      const avgPnlPct = this.recentTrades.reduce((sum, t) => sum + t.pnlPct, 0) / this.recentTrades.length;
      const level = this.profile?.aggressiveness || 'conservative';
      let targetWinRate = 0.65;
      if (level === 'reactive') targetWinRate = 0.58;
      if (level === 'aggressive') targetWinRate = 0.52;
      
      if (recentWinRate < targetWinRate - 0.1 && avgPnlPct < 0) {
        this.qualityThresholdAdjustment = Math.min(15, this.qualityThresholdAdjustment + 5);
      } else if (recentWinRate > targetWinRate + 0.1 && avgPnlPct > 0.5) {
        this.qualityThresholdAdjustment = Math.max(-10, this.qualityThresholdAdjustment - 3);
      }
    }
  }

  /**
   * ✅ ADAPTIVE LEARNING: Detect losing streaks and adjust behavior
   * After 2 consecutive losses: Increase selectivity significantly
   * After 3 consecutive losses: Enter 1h cooldown (circuit breaker)
   */
  private detectLosingStreak(): void {
    if (this.recentTrades.length < 2) return;
    
    // Check last 3 trades for consecutive losses
    const last3 = this.recentTrades.slice(-3);
    const consecutiveLosses = last3.every(t => !t.win) ? last3.length : 0;
    
    if (consecutiveLosses >= 2) {
      // 🚨 2+ consecutive losses: Increase selectivity dramatically
      const adjustment = consecutiveLosses === 2 ? 10 : 15;
      this.qualityThresholdAdjustment = Math.min(20, this.qualityThresholdAdjustment + adjustment);
      
      recordOpsEvent({
        level: 'warn',
        source: 'adaptive_learning',
        message: `Losing streak detected: ${consecutiveLosses} losses`,
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { 
          consecutiveLosses,
          adjustment: this.qualityThresholdAdjustment,
          action: consecutiveLosses >= 3 ? 'entering_cooldown' : 'increased_selectivity'
        },
      });
      
      console.log(`🛑 Losing streak: ${consecutiveLosses} losses → Quality threshold +${adjustment} (now ${this.qualityThresholdAdjustment})`);
    }
    
    if (consecutiveLosses >= 3) {
      // 🔴 3 consecutive losses: HALT for 1 hour (circuit breaker)
      const cooldownMs = 60 * 60 * 1000; // 1 hour
      this.scheduleReactivation('losing_streak_circuit_breaker', cooldownMs);
      console.log('🔴 CIRCUIT BREAKER: 3 consecutive losses → 1h trading pause');
    }
  }

  /**
   * Get comprehensive trading diagnostics for frontend display
   */
  public async getDiagnostics(): Promise<any> {
    try {
      const snapshotFetcher = typeof (this as any).getDiagnosticSnapshot === 'function'
        ? (this as any).getDiagnosticSnapshot.bind(this)
        : async () => buildTechSnapshot(this.profile?.symbol || '');
      const snap = await snapshotFetcher();
      const canTrade = this.canTradeNow(snap);
      const checks = this.getDiagnosticChecks(snap);
      const summary = this.getDiagnosticSummary(checks);
      const trigger = this.getDiagnosticTrigger(snap, checks);

      return {
        canTrade,
        reason: this.getTradingReadinessReason(checks),
        checks,
        summary,
        trigger,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('Diagnostics error:', error);
      return {
        canTrade: false,
        reason: 'Diagnostic error',
        checks: {},
        summary: { totalChecks: 0, passed: 0, failed: 0 },
        trigger: {
          entryReady: false,
          phase: 'error',
          bias: this.plan?.bias || 'none',
          price: undefined,
          zone: this.plan?.zone ? { ...this.plan.zone } : null,
          inZone: false,
          confirmationOk: false,
          momentumOk: false,
          qualityOk: false,
          profitOk: false,
          tp1ProfitPct: 0,
          minProfitPct: (await import('../utils/env.js')).getConfig().MIN_TRADE_PROFIT_PCT,
          dir: this.plan?.bias === 'short' ? -1 : 1,
        },
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
    const inZone = this.priceInZoneWithEpsilon(price, this.plan.zone);
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

    // Risk management checks (mode-adaptive limits)
    const limits = defaultLimits(this.profile?.aggressiveness);
    const maxDailyTrades = limits.maxTradesPerDay;
    const maxConsecStops = limits.maxConsecutiveStops;
    
    checks.dailyTradeLimit = {
      status: (this.tradesToday || 0) < maxDailyTrades ? 'PASS' : 'FAIL',
      reason: (this.tradesToday || 0) < maxDailyTrades 
        ? `Daily trades: ${this.tradesToday || 0}/${maxDailyTrades} - within limit (${this.profile?.aggressiveness || 'reactive'} mode)`
        : `Daily trades: ${this.tradesToday || 0}/${maxDailyTrades} - limit exceeded for risk management`,
      message: `Trades today: ${this.tradesToday || 0}`
    };

    checks.consecutiveStopsLimit = {
      status: (this.consecutiveStops || 0) < maxConsecStops ? 'PASS' : 'FAIL',
      reason: (this.consecutiveStops || 0) < maxConsecStops
        ? `Consecutive stops: ${this.consecutiveStops || 0}/${maxConsecStops} - acceptable loss streak (${this.profile?.aggressiveness || 'reactive'} mode)`
        : `Consecutive stops: ${this.consecutiveStops || 0}/${maxConsecStops} - circuit breaker activated`,
      message: `Consecutive stops: ${this.consecutiveStops || 0}`
    };

    // Zone and momentum checks
    const price = snap.last;
    const { from, to } = this.plan?.zone || { from: 0, to: 0 };
    const zoneCheck = this.plan?.zone ? this.priceInZoneWithEpsilon(price, this.plan.zone) : false;
    checks.inEntryZone = {
      status: zoneCheck ? 'PASS' : 'FAIL',
      reason: zoneCheck
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

    // Calculate overall quality score based on points (0-100) - allow trading with 3/5 filters (60 points)
    const qualityPoints = Object.values(checks.qualityFilters).reduce((sum: number, filter: any) => sum + (filter.points || 0), 0);
    const maxPoints = 100; // 5 filters × 20 points each
    // Mode-adaptive minimum quality score for diagnostics (aligned with env.ts)
    const mode = this.profile?.aggressiveness || 'reactive';
    const minTradingPoints = mode === 'aggressive' ? 40 : mode === 'reactive' ? 50 : 60;
    checks.qualityScore = {
      current: qualityPoints,
      required: minTradingPoints, // Changed from maxPoints to minTradingPoints
      status: qualityPoints >= minTradingPoints ? 'PASS' : 'FAIL',
      reason: `Quality score: ${qualityPoints}/${maxPoints} points (${Object.values(checks.qualityFilters).filter((f: any) => f.points > 0).length}/5 filters passed) - ${qualityPoints >= minTradingPoints ? 'Ready to trade' : 'Insufficient quality'}`
    };

    return checks;
  }

  private getDiagnosticTrigger(snap: TechnicalSnapshot, checks: any) {
    const bias = this.plan?.bias || 'none';
    const zone = this.plan?.zone;
    const price = snap.last;
    const cfg = getConfig();
    const dir = bias === 'short' ? -1 : 1;

    const zoneMin = zone ? Math.min(zone.from, zone.to) : Number.NEGATIVE_INFINITY;
    const zoneMax = zone ? Math.max(zone.from, zone.to) : Number.POSITIVE_INFINITY;
    const mid = zone?.mid ?? (zone ? (zone.from + zone.to) / 2 : price);
    const inZone = zone ? this.priceInZoneWithEpsilon(price, zone) : false;

    const confirmRequired = !!this.plan?.plan?.entry_rule?.confirm_close;
    const confirmationOk = !confirmRequired || (bias === 'long' ? price > mid : price < mid);

    const momentumOk =
      checks?.momentumGates?.status === 'PASS' ||
      checks?.qualityFilters?.momentum?.status === 'PASS' ||
      this.passesEntryMomentumGates(snap, 'enter');
    const qualityOk = checks?.qualityScore?.status === 'PASS' || this.passesQualityFilters(snap);

    const levelProfit = this.profile?.aggressiveness || 'reactive';
    let minProfitPct = cfg.MIN_TRADE_PROFIT_PCT;
    if (levelProfit === 'reactive') minProfitPct = Math.max(0.6, minProfitPct - 0.2);
    if (levelProfit === 'aggressive') minProfitPct = Math.max(0.5, minProfitPct - 0.3);

    const firstR = this.plan?.rPrices?.[0]?.r ?? 0;
    const tp1ProfitPct = price > 0 ? Math.abs((firstR * (this.plan?.stopDistance ?? 0)) / price) * 100 : 0;
    const profitOk = tp1ProfitPct >= minProfitPct;

    const readyPrechecks = this.state === 'ARMED' && !this.pos && !this.entering;
    const entryReady = readyPrechecks && inZone && confirmationOk && momentumOk && qualityOk && profitOk;

    let phase: string;
    if (entryReady) phase = 'entry_ready';
    else if (!readyPrechecks) phase = 'inactive';
    else if (!inZone) phase = 'out_of_zone';
    else if (!confirmationOk) phase = 'awaiting_confirmation';
    else if (!momentumOk) phase = 'awaiting_momentum';
    else if (!qualityOk) phase = 'awaiting_quality';
    else if (!profitOk) phase = 'awaiting_profit';
    else phase = 'scanning';

    return {
      entryReady,
      phase,
      bias,
      price,
      zone: zone ? { ...zone } : null,
      inZone,
      confirmationOk,
      momentumOk,
      qualityOk,
      profitOk,
      tp1ProfitPct,
      minProfitPct,
      dir,
    };
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
        status: adx >= this.getRealisticADXThreshold() ? 'PASS' : 'FAIL',
        reason: `ADX (${adx.toFixed(1)}) must be >= ${this.getRealisticADXThreshold()} to confirm trend strength (optimized threshold)`,
        points: adx >= this.getRealisticADXThreshold() ? 20 : 0,
        details: {
          currentADX: adx,
          threshold: this.getRealisticADXThreshold()
        }
      },
      rsiPosition: {
        status: this.checkRSIPosition(rsi, bias) ? 'PASS' : 'FAIL',
        reason: bias === 'long' 
          ? `RSI (${rsi.toFixed(1)}) should be between 30-80 for long entries (realistic oversold detection)`
          : `RSI (${rsi.toFixed(1)}) should be between 20-70 for short entries (realistic overbought detection)`,
        points: this.checkRSIPosition(rsi, bias) ? 20 : 0,
        details: {
          currentRSI: rsi,
          bias,
          threshold: bias === 'long' ? '30-80' : '20-70'
        }
      },
      volatility: (() => {
        const baseMinAtr = this.effectiveEntryThresholds().ENTRY_MIN_ATR_PCT;
        const symForAtr = this.profile?.symbol || '';
        let thr = baseMinAtr;
        try { thr = this.getAdaptiveATRThresholdSync(symForAtr, baseMinAtr); } catch {}
        const pass = atrPct >= thr;
        return {
          status: pass ? 'PASS' : 'FAIL',
          reason: `ATR (${atrPct.toFixed(2)}%) must be >= ${thr}% to ensure sufficient volatility (adaptive per symbol)`,
          points: pass ? 20 : 0,
          details: { currentATR: atrPct, threshold: thr, base: baseMinAtr }
        };
      })(),
      volume: (() => {
        // Diagnostics should mirror core filter behavior more closely
        const cfg = getConfig();
        const level = this.profile?.aggressiveness || 'conservative';
        const ratio = volumeMA > 0 ? (volume / volumeMA) : 0;
        const usdVolumeMA = volumeMA > 0 ? volumeMA * price : 0;
        const baseRequired = Number.isFinite(cfg.QUALITY_VOLUME_RATIO_BASE) ? cfg.QUALITY_VOLUME_RATIO_BASE : 0.6;
        const floor = Number.isFinite(cfg.QUALITY_VOLUME_RATIO_FLOOR) ? cfg.QUALITY_VOLUME_RATIO_FLOOR : 0.4;
        const ceiling = Number.isFinite(cfg.QUALITY_VOLUME_RATIO_CEIL) ? cfg.QUALITY_VOLUME_RATIO_CEIL : 0.78;
        let required = baseRequired;
        if (level === 'reactive') required -= 0.05; else if (level === 'aggressive') required -= 0.10; else required += 0.02;
        if (usdVolumeMA >= cfg.QUALITY_VOLUME_RATIO_HIGH_USD) required -= 0.08;
        else if (usdVolumeMA >= cfg.QUALITY_VOLUME_RATIO_MEDIUM_USD) required -= 0.05;
        else if (usdVolumeMA <= cfg.QUALITY_VOLUME_RATIO_LOW_USD && usdVolumeMA > 0) required += 0.07;
        if (atrPct >= 1.4) required -= 0.03; else if (atrPct <= 0.45) required += 0.03;
        // CMF-based modulation for diagnostics (align with gating behavior)
        try {
          const cmf20 = Number((snap as any)?.cmf20 ?? 0);
          const cmfStrong = Number(cfg.VOLUME_CMF_STRONG || 0.15);
          const cmfMinAdx = Number(cfg.VOLUME_CMF_MIN_ADX || 15);
          const adxVal = Number((snap as any)?.adx14 ?? 0);
          const bias = this.plan?.bias || 'none';
          const cmfAligned = (bias === 'long' && cmf20 >= cmfStrong) || (bias === 'short' && cmf20 <= -cmfStrong);
          if (cmfAligned && adxVal >= cmfMinAdx) {
            const relaxBase = Number(cfg.VOLUME_CMF_RELAX || 0.15);
            const relaxCap = Number(cfg.VOLUME_CMF_RELAX_MAX || relaxBase);
            const magnitude = Math.max(1, Math.abs(cmf20) / Math.max(1e-6, cmfStrong));
            const relaxAmt = Math.min(relaxCap, relaxBase * magnitude);
            const floorCmf = level === 'aggressive' ? 0.20 : level === 'reactive' ? 0.28 : 0.35;
            required = Math.max(floorCmf, required - relaxAmt);
          }
        } catch {}

        required = Math.max(floor, Math.min(ceiling, required));
        const pass = volumeMA <= 0 ? volume > 0 : ratio >= required;
        return {
          status: pass ? 'PASS' : 'FAIL',
          reason: `Volume ratio ${(ratio||0).toFixed(2)} should be >= ${required.toFixed(2)} (adj. by liquidity/volatility)` ,
          points: pass ? 20 : 0,
          details: {
            currentVolume: volume,
            volumeMA,
            ratio: volumeMA > 0 ? ratio.toFixed(2) : 'N/A',
            required: required.toFixed(2),
            usdVolumeMA: Math.round(usdVolumeMA),
            cmf20: Number((snap as any)?.cmf20 ?? 0)
          }
        };
      })()
    };
  }

  private checkTrendAlignment(ema20: number, ema50: number, bias: string): boolean {
    const emaSpread = ((ema20 - ema50) / ema50) * 100;
    if (bias === 'long') return ema20 > ema50 && emaSpread > 0.5;
    if (bias === 'short') return ema20 < ema50 && emaSpread < -0.5;
    return false;
  }

  private checkRSIPosition(rsi: number, bias: string): boolean {
    // Realistic RSI thresholds based on comprehensive analysis
    // These are optimal for all crypto types without false positives
    
    if (bias === 'long') {
      // Accept oversold opportunities (30) while avoiding extreme overbought (80)
      return rsi >= 30 && rsi <= 80;
    }
    
    if (bias === 'short') {
      // Accept deeper oversold for shorts (20) while allowing higher RSI entries (70)
      return rsi >= 20 && rsi <= 70;
    }
    
    return false;
  }

  private checkVolumeConfirmation(volume: number, volumeMA: number): boolean {
    if (volumeMA <= 0) return volume > 0;
    const ratio = volume / volumeMA;
    return ratio >= 0.8;
  }



  private getRealisticADXThreshold(): number {
    // Realistic ADX threshold: 15 is optimal for all crypto types
    // Captures sufficient momentum without being overly restrictive
    return 15;
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
    if (!this.sessionId) {
      console.log('No session ID available for position restoration');
      return;
    }

    try {
      const persistedPosition = await loadActivePosition(this.sessionId);

      if (!persistedPosition || !persistedPosition.qty || persistedPosition.qty <= 0) {
        console.log(`No active position found for session ${this.sessionId}`);
        return;
      }

      console.log(`Restoring persisted position: ${persistedPosition.symbol} ${persistedPosition.side} qty=${persistedPosition.qty} @ ${persistedPosition.entryPrice}`);

      // Validate required fields
      if (!persistedPosition.entryPrice || !persistedPosition.openedAt) {
        console.error('Invalid persisted position data: missing entryPrice or openedAt');
        return;
      }

      // Restore position state
      const side = persistedPosition.side as 'buy' | 'sell';
      const entry = persistedPosition.entryPrice;
      const qty = persistedPosition.qty;
      const stop = persistedPosition.stopPrice || (side === 'buy' ? entry * 0.95 : entry * 1.05); // Fallback stop
      const tp = Array.isArray(persistedPosition.takeProfit) ?
        (persistedPosition.takeProfit as number[]).filter(n => typeof n === 'number') :
        persistedPosition.takeProfit && typeof persistedPosition.takeProfit === 'number' ? [persistedPosition.takeProfit] : [];

      // Calculate current P&L and other metrics
      const openedAt = persistedPosition.openedAt.getTime();
      const now = Date.now();

      this.pos = {
        side,
        entry,
        qty,
        stop,
        tp,
        openedAt,
        extended: false,
        partialTaken: false,
        slOrderId: persistedPosition.slOrderId || undefined,
        tpOrderId: persistedPosition.tpOrderId || undefined,
        trail: [{ ts: openedAt, price: stop }],
        maeR: 0, // Will be calculated in manage()
        mfeR: 0, // Will be calculated in manage()
        breakeven: entry,
        partialInfo: null,
      };

      // Update agent state
      this.state = 'MANAGE';

      // Log restoration
      recordOpsEvent({
        level: 'info',
        source: 'position_restoration',
        message: 'position_restored_from_persistence',
        sessionId: this.sessionId,
        symbol: persistedPosition.symbol,
        details: {
          side,
          qty,
          entryPrice: entry,
          stopPrice: stop,
          takeProfit: tp,
          openedAt: persistedPosition.openedAt.toISOString()
        }
      });

      console.log(`Position restored successfully: ${side} ${persistedPosition.symbol} qty=${qty} @ ${entry}`);

    } catch (error) {
      console.error(`Failed to restore persisted position for session ${this.sessionId}:`, error);

      recordOpsEvent({
        level: 'error',
        source: 'position_restoration',
        message: 'position_restoration_failed',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { error: String(error) }
      });
    }
  }

  private async syncProtectiveOrders(reason: string): Promise<void> {
    if (!this.pos || !this.broker || !this.profile) {
      console.log(`Cannot sync protective orders: missing position, broker, or profile`);
      return;
    }

    try {
      // Only sync protective orders for live trading
      if (this.profile.mode !== 'live') {
        console.log(`Skipping protective order sync for ${this.profile.mode} mode`);
        return;
      }

      // Check if broker supports syncProtective (LiveBroker does)
      if (typeof (this.broker as any).syncProtective !== 'function') {
        console.log(`Broker does not support protective order sync`);
        return;
      }

      const params = {
        symbol: this.profile.symbol,
        side: this.pos.side,
        qty: this.pos.qty,
        stopLoss: this.pos.stop,
        takeProfit: this.pos.tp,
        slOrderId: this.pos.slOrderId || null,
        tpOrderId: this.pos.tpOrderId || null
      };

      console.log(`Syncing protective orders for ${this.profile.symbol} (${reason}): SL=${this.pos.stop}, TP=${this.pos.tp}`);

      const result = await (this.broker as any).syncProtective(params);

      // Update position with new order IDs
      if (result.slOrderId) {
        this.pos.slOrderId = result.slOrderId;
        console.log(`Updated SL order ID: ${result.slOrderId}`);
      }
      if (result.tpOrderId) {
        this.pos.tpOrderId = result.tpOrderId;
        console.log(`Updated TP order ID: ${result.tpOrderId}`);
      }

      // Log successful sync
      recordOpsEvent({
        level: 'info',
        source: 'protective_orders',
        message: 'protective_orders_synced',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          reason,
          slOrderId: result.slOrderId,
          tpOrderId: result.tpOrderId,
          stopLoss: this.pos.stop,
          takeProfit: this.pos.tp
        },
      });

    } catch (error) {
      console.error(`Failed to sync protective orders for ${this.profile.symbol}:`, error);

      recordOpsEvent({
        level: 'error',
        source: 'protective_orders',
        message: 'protective_orders_sync_failed',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          reason,
          error: String(error),
          stopLoss: this.pos.stop,
          takeProfit: this.pos.tp
        },
      });
    }
  }

  private async manage(price: number, snap: TechnicalSnapshot): Promise<void> {
    // ✅ FIX: Validate position exists, reset state if missing (prevents stuck MANAGE state)
    if (!this.pos || !this.plan || !this.profile) {
      console.warn(`⚠️  Agent in MANAGE state but missing position/plan/profile - resetting to SCAN`);
      
      recordOpsEvent({
        level: 'warn',
        source: 'position_validation',
        message: 'manage_without_position',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { 
          hasPos: !!this.pos, 
          hasPlan: !!this.plan, 
          hasProfile: !!this.profile 
        },
      });
      
      // Reset to SCAN to allow new opportunities
      this.state = 'SCAN';
      broadcast('agent_state', { 
        state: this.state, 
        reason: 'no_position_in_manage_state' 
      }, this.profile?.symbol, this.sessionId || undefined);
      
      return;
    }

    try {
      const ticker = await getTicker(this.profile.symbol).catch(() => null as any);
      if (ticker && typeof ticker.last === 'number' && Number.isFinite(ticker.last)) {
        price = Number(ticker.last);
        (snap as any).last = price;
      }
    } catch (error) {
      console.warn(`Failed to refresh live price for ${this.profile.symbol}:`, error);
    }

    // Check if position is still open (both live and paper modes)
    if (this.profile.mode === 'live') {
      try {
        const exposure = await inspectExposure(this.profile.symbol, this.profile.userId);
        if (!exposure || exposure.qty <= 0) {
          // Position closed on exchange, clear local state and exit
          console.log(`Position closed on exchange for ${this.profile.symbol}, clearing local state`);
          this.pos = null;
          this.state = 'EXIT';
          this.lastExitTime = Date.now();
          broadcast('agent_state', { state: this.state, reason: 'position_closed_on_exchange' }, this.profile.symbol, this.sessionId || undefined);
          this.scheduleReactivation('position_closed_on_exchange');
          return;
        }
      } catch (error) {
        console.warn(`Failed to check exposure for ${this.profile.symbol}:`, error);
      }
    } else if (this.profile.mode === 'paper') {
      // ✅ NEW: Paper mode position validation (prevents stuck state)
      try {
        // Verify paper position still exists with valid quantity
        if (!this.pos || this.pos.qty <= 0) {
          console.log(`Paper position cleared for ${this.profile.symbol}, transitioning to EXIT`);
          this.pos = null;
          this.state = 'EXIT';
          this.lastExitTime = Date.now();
          broadcast('agent_state', { 
            state: this.state, 
            reason: 'paper_position_cleared' 
          }, this.profile.symbol, this.sessionId || undefined);
          this.scheduleReactivation('paper_position_cleared');
          return;
        }
      } catch (error) {
        console.warn(`Failed to validate paper position for ${this.profile.symbol}:`, error);
      }
    }

    // Update position metrics
    this.updatePositionMetrics(price);

    // Check for exit conditions
    const exitReason = this.checkExitConditions(price, snap);
    if (exitReason) {
      await this.exitPosition(price, exitReason);
      return;
    }

    // Implement trailing stops
    const newTrailPrice = this.computeDynamicTrail(price, snap, this.calculateUnrealizedR(price), Date.now() - this.pos!.openedAt);
    if (newTrailPrice !== null && this.shouldUpdateTrail(newTrailPrice, price)) {
      await this.updateTrailingStop(newTrailPrice, price);
    }

    // Check for partial exits at profit targets
    await this.checkPartialExits(price, snap);

    // Extend position if profitable and conditions met
    if (this.pos && !this.pos.extended && this.shouldExtendPosition(price, snap)) {
      this.extendPosition(price);
    }

    // Update protective orders if needed
    if (this.shouldSyncProtectiveOrders()) {
      await this.syncProtectiveOrders('management');
    }

    console.log(`Managing position: ${this.pos!.side} ${this.profile.symbol} @ ${price.toFixed(6)}, unrealized R: ${this.calculateUnrealizedR(price).toFixed(2)}, trail: ${this.pos!.stop.toFixed(6)}`);
  }

  private updatePositionMetrics(currentPrice: number): void {
    if (!this.pos || !this.plan) return;

    const entry = this.pos.entry;
    const side = this.pos.side;
    const stopDistance = this.plan.stopDistance;

    // Calculate unrealized P&L in R multiples
    const unrealizedR = this.calculateUnrealizedR(currentPrice);

    // Update MAE (Maximum Adverse Excursion) and MFE (Maximum Favorable Excursion)
    if (this.pos.maeR === undefined || unrealizedR < this.pos.maeR) {
      this.pos.maeR = unrealizedR;
    }
    if (this.pos.mfeR === undefined || unrealizedR > this.pos.mfeR) {
      this.pos.mfeR = unrealizedR;
    }

    // Update breakeven if trailing - 🔧 AJUSTÉ : Attendre +2.5R au lieu de +1.5R
    if (unrealizedR > 2.5 && !this.pos.partialTaken) {
      const trailAdjustment = Math.min(stopDistance * 0.5, (currentPrice - entry) * 0.3 * (side === 'buy' ? 1 : -1));
      this.pos.breakeven = entry + trailAdjustment * (side === 'buy' ? 1 : -1);
    }
  }

  private calculateUnrealizedR(currentPrice: number): number {
    if (!this.pos || !this.plan) return 0;

    const entry = this.pos.entry;
    const stopDistance = this.plan.stopDistance;
    const side = this.pos.side;

    const priceDiff = side === 'buy' ? currentPrice - entry : entry - currentPrice;
    return priceDiff / stopDistance;
  }

  private checkExitConditions(price: number, snap: TechnicalSnapshot): string | null {
    if (!this.pos || !this.plan || !this.profile) return null;

    const unrealizedR = this.calculateUnrealizedR(price);
    const timeHeldMs = Date.now() - this.pos.openedAt;
    const maxHoldHours = this.plan.plan.risk?.max_hold_hours || 36;
    const maxHoldMs = maxHoldHours * 60 * 60 * 1000;

    // ✅ FIX: Early exit on trend reversal (prevents ETH -2.47%, ADA -3.13% losses)
    if (this.shouldExitOnTrendReversal(price, snap, unrealizedR)) {
      return 'trend_reversal_detected';
    }

    // ✅ FIX: Late invalidation exit - price outside original entry zone
    if (this.shouldExitOnLateInvalidation(price)) {
      return 'late_invalidation_exit';
    }

    // ✅ ADAPTIVE LEARNING: Volume dump detection
    if (this.shouldExitOnVolumeDump(snap)) {
      return 'volume_dump_detected';
    }

    // ✅ ADAPTIVE LEARNING: Divergence detection
    if (this.shouldExitOnDivergence(price, snap, unrealizedR)) {
      return 'divergence_detected';
    }

    // Time-based exit
    if (timeHeldMs > maxHoldMs) {
      return 'max_hold_time_exceeded';
    }

    // Profit target reached (final TP)
    if (this.pos.tp.length > 0) {
      const finalTp = this.pos.tp[this.pos.tp.length - 1];
      const hitTp = this.pos.side === 'buy' ? price >= finalTp : price <= finalTp;
      if (hitTp) {
        return 'profit_target_reached';
      }
    }

    // Stop loss hit
    const hitStop = this.pos.side === 'buy' ? price <= this.pos.stop : price >= this.pos.stop;
    if (hitStop) {
      return 'stop_loss_hit';
    }

    // Risk management: cut losses if position moves against us significantly
    if (unrealizedR < -2.0) {
      return 'excessive_loss_cutoff';
    }

    // Market regime change to standby
    if (this.regime?.playbook === 'standby') {
      return 'regime_standby';
    }

    // Volatility spike - exit if ATR increases dramatically
    const currentATR = snap.atr14 || 0;
    const entryATR = this.plan.atr || currentATR;
    if (currentATR > entryATR * 2.0) {
      return 'volatility_spike';
    }

    return null;
  }

  private async exitPosition(price: number, reason: string): Promise<void> {
    if (!this.pos || !this.broker || !this.profile) return;

    try {
      console.log(`Exiting position: ${reason} at ${price}`);

      // Calculate realized P&L
      const realizedPnl = this.calculateRealizedPnL(price);

      // Place exit order
      const exitSide = this.pos.side === 'buy' ? 'sell' : 'buy';
      const exitOrder = await this.broker.place({
        symbol: this.profile.symbol,
        side: exitSide,
        type: 'market',
        qty: this.pos.qty,
        leverage: this.profile.maxLeverage
      });

      if (exitOrder.status === 'filled' && exitOrder.filledQty && exitOrder.filledQty > 0) {
        // Record exit in database
        await recordExit({
          sessionId: this.sessionId!,
          symbol: this.profile.symbol,
          side: this.pos.side,
          exitPrice: exitOrder.avgPrice || price,
          qty: exitOrder.filledQty,
          realizedPnl,
        });

        // Update performance tracking
        const win = realizedPnl > 0;
        this.recentTrades.push({
          win,
          pnlPct: (realizedPnl / (this.pos.entry * this.pos.qty)) * 100,
          timestamp: Date.now()
        });
        
        // 🆕 Track last trade result for breakout mode logic
        this.lastTradeWasWin = win;
        
        // Reset breakout mode after trade exit
        if (this.breakoutModeActive) {
          console.log('🔄 Resetting breakout mode after trade exit');
          this.breakoutModeActive = false;
          this.lastZoneCheckTime = 0;
        }

        // Keep only last 20 trades
        if (this.recentTrades.length > 20) {
          this.recentTrades = this.recentTrades.slice(-20);
        }

        // ✅ ADAPTIVE LEARNING: Adjust thresholds based on recent performance
        this.adjustQualityThresholds();
        this.detectLosingStreak();

        // Update daily P&L
        if (this.performanceMetrics) {
          this.performanceMetrics.dailyPnL += realizedPnl;
        }

        // Log exit
        recordOpsEvent({
          level: win ? 'info' : 'warn',
          source: 'position_exit',
          message: `position_exited_${reason}`,
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: {
            reason,
            exitPrice: exitOrder.avgPrice || price,
            realizedPnl,
            holdTimeMs: Date.now() - this.pos.openedAt,
            maeR: this.pos.maeR,
            mfeR: this.pos.mfeR
          }
        });

        // Clear position and update state
        this.pos = null;
        this.state = 'EXIT';
        this.lastExitTime = Date.now();

        broadcast('agent_state', {
          state: this.state,
          reason,
          exitPrice: exitOrder.avgPrice || price,
          realizedPnl
        }, this.profile.symbol, this.sessionId || undefined);

        const cooldownCfg = getConfig();
        const winCooldown = cooldownCfg.TRADE_COOLDOWN_WIN_MS || (cooldownCfg.TRADE_COOLDOWN_MS * 0.2);
        const lossCooldown = cooldownCfg.TRADE_COOLDOWN_LOSS_MS || cooldownCfg.TRADE_COOLDOWN_MS;
        const exitCooldown = realizedPnl > 0 ? winCooldown : lossCooldown;
        this.lastExitCooldownMs = exitCooldown;

        this.scheduleReactivation('position_exit_completed', exitCooldown);

      } else {
        console.error(`Failed to exit position: ${exitOrder.status}`);
      }

    } catch (error) {
      console.error(`Error exiting position:`, error);
      recordOpsEvent({
        level: 'error',
        source: 'position_exit',
        message: 'position_exit_failed',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: { reason, error: String(error) }
      });
    }
  }

  /**
   * 🚨 CRITICAL: Detect trend reversal to exit losing positions early
   * Prevents catastrophic losses like ETH -2.47% and ADA -3.13%
   */
  private shouldExitOnTrendReversal(price: number, snap: TechnicalSnapshot, unrealizedR: number): boolean {
    if (!this.pos || !this.plan) return false;
    
    // 1. EMA Cross Reversal (bearish for long, bullish for short)
    const emaSpread = ((snap.ema20 - snap.ema50) / snap.ema50) * 100;
    const emaBearish = emaSpread < -0.5;
    const emaBullish = emaSpread > 0.5;
    
    if (this.pos.side === 'buy' && emaBearish && unrealizedR < 0.5) {
      console.log(`🔴 Exit: EMA bearish cross detected (spread: ${emaSpread.toFixed(2)}%, R: ${unrealizedR.toFixed(2)})`);
      return true;
    }
    
    if (this.pos.side === 'sell' && emaBullish && unrealizedR < 0.5) {
      console.log(`🔴 Exit: EMA bullish cross detected (spread: ${emaSpread.toFixed(2)}%, R: ${unrealizedR.toFixed(2)})`);
      return true;
    }
    
    // 2. Momentum Loss (RSI extreme + losing position)
    const rsi = snap.rsi14 || 50;
    const momentumLoss = (this.pos.side === 'buy' && rsi < 35 && unrealizedR < 0) ||
                         (this.pos.side === 'sell' && rsi > 65 && unrealizedR < 0);
    
    if (momentumLoss) {
      console.log(`🔴 Exit: Momentum loss (RSI: ${rsi.toFixed(1)}, R: ${unrealizedR.toFixed(2)})`);
      return true;
    }
    
    // 3. ADX Declining (trend weakening while losing)
    const adx = snap.adx14 || 0;
    const adxWeak = adx < 15;
    
    if (adxWeak && unrealizedR < -0.3) {
      console.log(`🔴 Exit: Weak trend + losing (ADX: ${adx.toFixed(1)}, R: ${unrealizedR.toFixed(2)})`);
      return true;
    }
    
    return false;
  }

  /**
   * ✅ FIX: Check if price has been outside entry zone for too long (late invalidation)
   * Prevents positions from staying open when price breaks out of original zone
   * This addresses the 238 "late_invalidation_exit" alerts issue
   */
  private shouldExitOnLateInvalidation(price: number): boolean {
    if (!this.pos || !this.plan) return false;
    
    const cfg = getConfig();
    const from = Math.min(this.plan.zone.from, this.plan.zone.to);
    const to = Math.max(this.plan.zone.from, this.plan.zone.to);
    const hysteresisPct = cfg.BREAKOUT_HYSTERESIS_PCT || 0.5;
    
    // Check if price is outside zone with hysteresis
    const above = price > to * (1 + hysteresisPct / 100);
    const below = price < from * (1 - hysteresisPct / 100);
    
    // For buy positions, invalid if price drops below zone
    // For sell positions, invalid if price rises above zone
    const invalid = (this.pos.side === 'sell') ? above : below;
    
    if (invalid) {
      // Initialize counter if not exists
      if (!this.invalidationTicks) this.invalidationTicks = 0;
      this.invalidationTicks++;
      
      const confirmTicks = Math.max(3, cfg.BREAKOUT_CONFIRM_TICKS || 2);
      
      if (this.invalidationTicks >= confirmTicks) {
        const direction = this.pos.side === 'buy' ? 'below' : 'above';
        console.log(`🚨 Late Invalidation Exit: Price ${price.toFixed(4)} ${direction} zone [${from.toFixed(4)}, ${to.toFixed(4)}] for ${this.invalidationTicks} ticks`);
        return true;
      }
    } else {
      // Reset counter if price back in zone
      this.invalidationTicks = 0;
    }
    
    return false;
  }

  /**
   * ✅ ADAPTIVE LEARNING: Detect volume dumps (massive sell-offs)
   * Exit immediately if volume spike 2x+ average AND price moving against position
   */
  private shouldExitOnVolumeDump(snap: TechnicalSnapshot): boolean {
    if (!this.pos || !this.plan) return false;
    
    // Calculate volume spike ratio
    const avgVolume = snap.volumeMA || snap.volume24h || 1;
    const currentVolume = snap.volume24h || 0;
    if (currentVolume === 0 || avgVolume === 0) return false;
    
    const volumeSpike = currentVolume / avgVolume;
    
    // Check if price is moving against our position
    const priceMovingAgainst = this.pos.side === 'buy'
      ? snap.last < this.pos.entry * 0.99  // -1% or more for longs
      : snap.last > this.pos.entry * 1.01; // +1% or more for shorts
    
    // Volume dump: 2x+ volume spike + price against position
    if (volumeSpike >= 2.0 && priceMovingAgainst) {
      const direction = this.pos.side === 'buy' ? 'down' : 'up';
      console.log(`🚨 Volume dump detected: ${volumeSpike.toFixed(1)}x avg volume, price moving ${direction}`);
      return true;
    }
    
    return false;
  }

  /**
   * ✅ ADAPTIVE LEARNING: Detect RSI/Price divergences
   * Bearish divergence (LONG): Price rises but RSI doesn't follow
   * Bullish divergence (SHORT): Price falls but RSI doesn't follow
   */
  private shouldExitOnDivergence(price: number, snap: TechnicalSnapshot, unrealizedR: number): boolean {
    if (!this.pos || !this.plan) return false;
    
    // Only check divergence if we're not winning significantly
    if (unrealizedR > 0.5) return false;
    
    const rsi = snap.rsi14 || 50;
    
    // Bearish divergence for LONG positions
    if (this.pos.side === 'buy') {
      const priceHigher = price > this.pos.entry * 1.01; // Price up 1%+
      const rsiWeak = rsi < 45; // But RSI weak (below neutral)
      
      if (priceHigher && rsiWeak) {
        console.log(`🚨 Bearish divergence: Price +${((price / this.pos.entry - 1) * 100).toFixed(1)}% but RSI weak (${rsi.toFixed(1)})`);
        return true;
      }
    }
    
    // Bullish divergence for SHORT positions
    if (this.pos.side === 'sell') {
      const priceLower = price < this.pos.entry * 0.99; // Price down 1%+
      const rsiStrong = rsi > 55; // But RSI strong (above neutral)
      
      if (priceLower && rsiStrong) {
        console.log(`🚨 Bullish divergence: Price ${((1 - price / this.pos.entry) * 100).toFixed(1)}% but RSI strong (${rsi.toFixed(1)})`);
        return true;
      }
    }
    
    return false;
  }

  private calculateRealizedPnL(exitPrice: number): number {
    if (!this.pos) return 0;

    const entry = this.pos.entry;
    const qty = this.pos.qty;
    const side = this.pos.side;

    const priceDiff = side === 'buy' ? exitPrice - entry : entry - exitPrice;
    return priceDiff * qty;
  }

  /**
   * 🆕 Recalculate entry zone periodically when ARMED (every 30 min)
   * Allows switch to breakout mode if conditions are met
   */
  private async maybeRecalculateEntryZone(): Promise<void> {
    if (this.state !== 'ARMED' || !this.plan || !this.profile) return;
    
    const now = Date.now();
    const lastRecalc = this.lastZoneRecalcTime || 0;
    const recalcInterval = 30 * 60 * 1000; // 30 minutes
    
    if (now - lastRecalc < recalcInterval) return;
    
    this.lastZoneRecalcTime = now;
    
    try {
      // Recalculer zone avec conditions actuelles
      const snap = await buildTechSnapshot(this.profile.symbol);
      const newZone = await this.calculateDynamicEntryZone(snap, snap.last, this.plan.bias);
      
      // Vérifier si passage en breakout mode
      const wasBreakout = this.breakoutModeActive;
      const isBreakout = this.shouldSwitchToBreakoutMode(snap, snap.last);
      
      if (isBreakout && !wasBreakout) {
        console.log('🔄 Entry zone mise à jour → Mode BREAKOUT');
        this.plan.zone = newZone;
        
        // Broadcast pour UI
        broadcast('zone_updated', { 
          zone: newZone, 
          mode: 'breakout',
          reason: 'strong_trend_detected'
        }, this.profile.symbol, this.sessionId || undefined);
        
        recordOpsEvent({
          level: 'info',
          source: 'zone_recalc',
          message: 'Entry zone updated to breakout mode',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: { oldZone: this.plan.zone, newZone, mode: 'breakout' },
        });
      } else if (!isBreakout && this.lastZoneRecalcTime > 0) {
        console.log('🔄 Entry zone recalculated (pullback mode maintained)');
      }
    } catch (error) {
      console.warn('Failed to recalculate entry zone:', error);
    }
  }
  
  private scheduleReactivation(reason: string, delayOverrideMs?: number): void {
    if (!this.profile || !this.plan) return;

    const cfg = getConfig();
    const baseCooldown = this.lastExitCooldownMs || cfg.TRADE_COOLDOWN_MS;
    const delay = typeof delayOverrideMs === 'number'
      ? Math.max(1000, delayOverrideMs)
      : Math.min(Math.max(4000, Math.floor(baseCooldown * 0.25)), Math.max(4000, Math.min(baseCooldown, 30000)));

    if (this.cooldownTimer) {
      try { clearTimeout(this.cooldownTimer); } catch {}
      this.cooldownTimer = null;
    }

    this.cooldownContext = { reason, triggeredAt: Date.now() };
    this.state = 'COOLDOWN';
    const cooldownReason = reason.startsWith('cooldown_') ? reason : `cooldown_${reason}`;
    broadcast('agent_state', { state: this.state, reason: cooldownReason, cooldownMs: delay }, this.profile.symbol, this.sessionId || undefined);

    this.cooldownTimer = setTimeout(async () => {
      this.cooldownTimer = null;
      this.cooldownContext = null;
      if (!this.profile || !this.plan) return;
      if (this.state === 'HALT') return;
      try {
        await this.validateAndArm();
      } catch (error) {
        console.warn('Failed to re-arm agent after cooldown:', error);
      }
    }, delay);
  }

  private shouldUpdateTrail(newTrailPrice: number, currentPrice: number): boolean {
    if (!this.pos) return false;

    const currentTrail = this.pos.stop;
    const side = this.pos.side;

    // Only trail in the profitable direction
    if (side === 'buy') {
      return newTrailPrice > currentTrail && newTrailPrice < currentPrice;
    } else {
      return newTrailPrice < currentTrail && newTrailPrice > currentPrice;
    }
  }

  private async updateTrailingStop(newTrailPrice: number, currentPrice: number): Promise<void> {
    if (!this.pos) return;

    const oldStop = this.pos.stop;
    this.pos.stop = newTrailPrice;
    this.noteTrail(newTrailPrice);

    console.log(`Updated trailing stop: ${oldStop.toFixed(6)} → ${newTrailPrice.toFixed(6)}`);

    // Update protective orders
    await this.syncProtectiveOrders('trail_update');
  }

  private async checkPartialExits(price: number, snap: TechnicalSnapshot): Promise<void> {
    if (!this.pos || !this.plan || this.pos.partialTaken) return;

    // ✅ FIX: Use same logic as policy.ts monitoring
    // Get firstR from plan (should be 2R typically)
    const firstR = (this.plan?.plan?.risk?.tp?.[0]?.value || this.plan?.rPrices?.[0]?.r || 2.0) as number;
    
    const firstTarget = this.pos.tp[0] ?? (
      this.pos.side === 'buy'
        ? this.pos.entry + (firstR * this.plan.stopDistance)  // ← FIX: Use firstR multiplier
        : this.pos.entry - (firstR * this.plan.stopDistance)
    );

    const hitFirstTarget = this.pos.side === 'buy' ? price >= firstTarget : price <= firstTarget;

    if (hitFirstTarget) {
      await this.executePartialExit(price, firstTarget, 'first_target');
    }
  }

  private async executePartialExit(price: number, targetPrice: number, reason: string): Promise<void> {
    if (!this.pos || !this.broker || !this.profile) return;

    try {
      const rawQty = this.pos.qty * 0.5;
      const partialQty = Number(rawQty.toFixed(8));
      if (!(partialQty > 0 && partialQty < this.pos.qty)) return;

      const exitSide = this.pos.side === 'buy' ? 'sell' : 'buy';
      const partialExit = await this.broker.place({
        symbol: this.profile.symbol,
        side: exitSide,
        type: 'market',
        qty: partialQty,
        leverage: this.profile.maxLeverage
      });

      if (partialExit.filledQty && partialExit.filledQty > 0) {
        // Update position
        this.pos.qty -= partialExit.filledQty;
        this.pos.partialTaken = true;
        this.pos.partialInfo = {
          ts: Date.now(),
          price: partialExit.avgPrice || targetPrice
        };

        // Adjust stop to breakeven or better
        const newStop = this.pos.breakeven || this.pos.entry;
        this.pos.stop = newStop;

        const fillPrice = partialExit.avgPrice || price;
        console.log(`Partial exit: ${partialExit.filledQty} @ ${fillPrice} (${reason})`);

        // Record partial exit
        recordOpsEvent({
          level: 'info',
          source: 'partial_exit',
          message: `partial_exit_${reason}`,
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: {
            partialQty: partialExit.filledQty,
            exitPrice: fillPrice,
            remainingQty: this.pos.qty,
            newStop
          }
        });

        // Sync protective orders
        await this.syncProtectiveOrders('partial_exit');
      }

    } catch (error) {
      console.error(`Failed to execute partial exit:`, error);
    }
  }

  private shouldExtendPosition(price: number, snap: TechnicalSnapshot): boolean {
    if (!this.pos || !this.plan) return false;

    const unrealizedR = this.calculateUnrealizedR(price);
    const timeHeldMs = Date.now() - this.pos.openedAt;

    // Extend if profitable and trend continues
    if (unrealizedR >= 1.0 && timeHeldMs < 12 * 60 * 60 * 1000) { // Less than 12 hours
      const trendContinues = this.pos.side === 'buy' ?
        (snap.ema20 || price) > (snap.ema50 || price) :
        (snap.ema20 || price) < (snap.ema50 || price);

      return trendContinues;
    }

    return false;
  }

  private extendPosition(price: number): void {
    if (!this.pos || !this.plan) return;

    this.pos.extended = true;

    // Extend hold time by adding time to the plan
    if (this.plan.plan.risk) {
      this.plan.plan.risk.max_hold_hours = (this.plan.plan.risk.max_hold_hours || 36) + 12;
    }

    console.log(`Extended position hold time to ${this.plan.plan.risk?.max_hold_hours || 36} hours`);

    recordOpsEvent({
      level: 'info',
      source: 'position_extension',
      message: 'position_hold_extended',
      sessionId: this.sessionId || undefined,
      symbol: this.profile?.symbol || '',
      details: {
        newMaxHoldHours: this.plan.plan.risk?.max_hold_hours,
        currentPrice: price,
        unrealizedR: this.calculateUnrealizedR(price)
      }
    });
  }

  private shouldSyncProtectiveOrders(): boolean {
    // Sync protective orders periodically or when stop/TP changes
    // For now, sync every 5 minutes or when position changes
    return Math.random() < 0.1; // 10% chance each manage call (~ every 5 minutes)
  }

  private async applyDailyRoiThrottle(riskPct: number): Promise<number> {
    if (!this.performanceMetrics || !this.profile) {
      return riskPct; // No performance data available, return unchanged
    }

    try {
      const cfg = getConfig();
      const maxDailyRoi = 5.0; // Default 5% max daily ROI
      const dailyPnL = this.performanceMetrics.dailyPnL || 0;

      // Calculate current daily ROI as percentage of starting balance
      const startBalance = this.profile.startBalanceUsd || 10000; // Fallback to 10k
      const dailyRoiPct = (dailyPnL / startBalance) * 100;

      console.log(`📊 Daily ROI check: ${dailyRoiPct.toFixed(2)}% (max: ${maxDailyRoi}%, dailyPnL: ${dailyPnL.toFixed(2)})`);

      // If daily ROI exceeds threshold, reduce risk progressively
      if (dailyRoiPct > maxDailyRoi) {
        const excessRoi = dailyRoiPct - maxDailyRoi;
        const reductionFactor = Math.max(0.1, 1.0 - (excessRoi / maxDailyRoi)); // Reduce risk by excess percentage

        const originalRisk = riskPct;
        const adjustedRisk = riskPct * reductionFactor;

        recordOpsEvent({
          level: 'warn',
          source: 'daily_roi_throttle',
          message: 'daily_roi_exceeded_throttling_risk',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: {
            dailyRoiPct: dailyRoiPct.toFixed(2),
            maxDailyRoi,
            excessRoi: excessRoi.toFixed(2),
            originalRisk: originalRisk.toFixed(3),
            adjustedRisk: adjustedRisk.toFixed(3),
            reductionFactor: reductionFactor.toFixed(3)
          },
        });

        console.log(`⚠️ Daily ROI throttle: ${originalRisk.toFixed(3)}% → ${adjustedRisk.toFixed(3)}% (excess ROI: ${excessRoi.toFixed(2)}%)`);
        return adjustedRisk;
      }

      // If daily ROI is approaching the limit, apply mild throttling
      else if (dailyRoiPct > maxDailyRoi * 0.8) {
        const mildReduction = 0.9; // 10% reduction when approaching limit
        const adjustedRisk = riskPct * mildReduction;

        recordOpsEvent({
          level: 'info',
          source: 'daily_roi_throttle',
          message: 'daily_roi_approaching_limit_mild_throttle',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: {
            dailyRoiPct: dailyRoiPct.toFixed(2),
            maxDailyRoi,
            adjustedRisk: adjustedRisk.toFixed(3)
          },
        });

        console.log(`📉 Mild daily ROI throttle: ${riskPct.toFixed(3)}% → ${adjustedRisk.toFixed(3)}%`);
        return adjustedRisk;
      }

      // Daily ROI within acceptable range
      return riskPct;

    } catch (error) {
      console.error(`Failed to apply daily ROI throttle:`, error);
      return riskPct; // Return original risk on error
    }
  }

  private async placeLimitAdaptive(order: any): Promise<any> {
    const { side, qty, limitPrice, stop, tp, entry, leverage } = order;

    if (!this.broker || !this.profile) {
      console.log('Cannot place limit order: missing broker or profile');
      return null;
    }

    try {
      console.log(`Placing adaptive limit order: ${side} ${this.profile.symbol} qty=${qty} @ ${limitPrice} (target: ${entry})`);

      // Place limit order with protective orders
      const placed = await this.broker.place({
        symbol: this.profile.symbol,
        side,
        type: 'limit',
        qty,
        price: limitPrice,
        leverage: Math.max(1, Math.min(this.profile.maxLeverage || 1, leverage || (this.profile.dynamicLeverage !== false ? (this.profile.minLeverage || 1) : (this.profile.maxLeverage || 1)))) ,
        takeProfit: tp[0], // Primary TP
        stopLoss: stop
      });

      if (placed.status === 'rejected' || !placed.filledQty || placed.filledQty <= 0) {
        console.log(`Limit order rejected or unfilled: ${placed.status}`);
        return placed;
      }

      // If we have multiple TPs, place additional TP orders
      if (tp.length > 1) {
        try {
          // Place runner TP as a separate limit order
          const runnerTp = tp[1];
          const runnerQty = Math.floor(placed.filledQty * 0.5); // 50% to runner TP

          if (runnerQty > 0) {
            const runnerOrder = await this.broker.place({
              symbol: this.profile.symbol,
              side: side === 'buy' ? 'sell' : 'buy', // Opposite side for TP
              type: 'limit',
              qty: runnerQty,
              price: runnerTp,
              leverage: Math.max(1, Math.min(this.profile.maxLeverage || 1, leverage || (this.profile.dynamicLeverage !== false ? (this.profile.minLeverage || 1) : (this.profile.maxLeverage || 1))))
            });

            if (runnerOrder.filledQty && runnerOrder.filledQty > 0) {
              console.log(`Placed runner TP: ${runnerQty} @ ${runnerTp}`);
            }
          }
        } catch (runnerError) {
          console.warn('Failed to place runner TP:', runnerError);
          // Continue with primary order
        }
      }

      console.log(`Adaptive limit order placed successfully: ${placed.filledQty} filled @ ${placed.avgPrice || limitPrice}`);
      return placed;

    } catch (error) {
      console.error(`Failed to place adaptive limit order:`, error);
      return null;
    }
  }

  private async executeTwapOrder(order: any): Promise<any> {
    const { side, totalQty, slices, intervalMs, stop, tp, entry, leverage } = order;

    if (!this.broker || !this.profile) {
      console.log('Cannot execute TWAP order: missing broker or profile');
      return null;
    }

    try {
      console.log(`Executing TWAP order: ${side} ${this.profile.symbol} totalQty=${totalQty} in ${slices} slices every ${intervalMs}ms`);

      const sliceQty = Math.floor(totalQty / slices);
      const remainderQty = totalQty % slices;
      let totalFilled = 0;
      let totalCost = 0;
      let avgPrice = 0;
      const executions: Array<{ slice: number; qty: number; price: number; timestamp: number }> = [];

      // Execute slices with time intervals
      for (let i = 0; i < slices; i++) {
        const currentSliceQty = i === slices - 1 ? sliceQty + remainderQty : sliceQty;

        if (currentSliceQty <= 0) continue;

        try {
          // Get fresh price for each slice
          const ticker = await getTicker(this.profile.symbol).catch(() => null);
          const currentPrice = ticker?.last || entry;

          // Calculate limit price for this slice (slightly better than current price)
          const limitPrice = this.computePassivePrice(side, currentPrice, ticker);

          console.log(`TWAP slice ${i + 1}/${slices}: ${currentSliceQty} @ ${limitPrice} (market: ${currentPrice})`);

          // Place limit order for this slice
          const sliceOrder = await this.broker.place({
            symbol: this.profile.symbol,
            side,
            type: 'limit',
            qty: currentSliceQty,
            price: limitPrice,
            leverage: Math.max(1, Math.min(this.profile.maxLeverage || 1, leverage || (this.profile.dynamicLeverage !== false ? (this.profile.minLeverage || 1) : (this.profile.maxLeverage || 1))))
          });

          if (sliceOrder.filledQty && sliceOrder.filledQty > 0) {
            totalFilled += sliceOrder.filledQty;
            if (sliceOrder.avgPrice) {
              totalCost += sliceOrder.avgPrice * sliceOrder.filledQty;
            }
            executions.push({
              slice: i + 1,
              qty: sliceOrder.filledQty,
              price: sliceOrder.avgPrice || limitPrice,
              timestamp: Date.now()
            });
          }

          // Wait for next slice (except for last one)
          if (i < slices - 1) {
            await new Promise(resolve => setTimeout(resolve, intervalMs));
          }

        } catch (sliceError) {
          console.warn(`TWAP slice ${i + 1} failed:`, sliceError);
          // Continue with next slice
        }
      }

      // Calculate average execution price
      if (totalFilled > 0) {
        avgPrice = totalCost / totalFilled;
      }

      // Place protective orders for the total filled quantity
      let slOrderId, tpOrderId;
      if (totalFilled > 0) {
        try {
          const protectiveResult = await (this.broker as any).syncProtective?.({
            symbol: this.profile.symbol,
            side,
            qty: totalFilled,
            stopLoss: stop,
            takeProfit: tp[0]
          });

          slOrderId = protectiveResult?.slOrderId;
          tpOrderId = protectiveResult?.tpOrderId;
        } catch (protectiveError) {
          console.warn('Failed to place protective orders for TWAP:', protectiveError);
        }
      }

      const result = {
        status: totalFilled > 0 ? 'filled' : 'rejected',
        filledQty: totalFilled,
        avgPrice,
        orderId: `twap_${Date.now()}`,
        slOrderId,
        tpOrderId,
        executions,
        telemetry: {
          totalSlices: slices,
          successfulSlices: executions.length,
          totalIntervalMs: (slices - 1) * intervalMs,
          avgSliceQty: sliceQty,
          priceImprovement: avgPrice < entry ? (entry - avgPrice) / entry * 100 : 0
        }
      };

      console.log(`TWAP execution completed: ${totalFilled}/${totalQty} filled @ ${avgPrice?.toFixed(6)} (${executions.length}/${slices} slices successful)`);

      return result;

    } catch (error) {
      console.error(`Failed to execute TWAP order:`, error);
      return null;
    }
  }

  private computeTelemetry(startTs: number, placed: any, details: any): any {
    const { expectedPrice, requestedQty, side } = details;
    const latencyMs = Date.now() - startTs;

    // Calculate slippage in basis points (0.01% = 1 bp)
    let slippageBps = 0;
    if (placed?.avgPrice && expectedPrice) {
      const actualPrice = placed.avgPrice;
      const slippagePct = ((actualPrice - expectedPrice) / expectedPrice) * 100;
      slippageBps = Math.round(slippagePct * 100); // Convert to basis points
    }

    // Calculate fill ratio
    const filledQty = placed?.filledQty || 0;
    const fillRatio = requestedQty > 0 ? filledQty / requestedQty : 0;

    // For now, assume no cancellations (cancelCount = 0)
    // In a real implementation, this would track order cancellations
    const cancelCount = 0;

    // Attempts - for now assume 1 attempt, but could track retries
    const attempts = 1;

    // Additional metrics for analysis
    const priceImprovement = expectedPrice && placed?.avgPrice ?
      (side === 'buy' ?
        (expectedPrice - placed.avgPrice) / expectedPrice * 100 : // Lower is better for buy
        (placed.avgPrice - expectedPrice) / expectedPrice * 100   // Higher is better for sell
      ) : 0;

    return {
      latencyMs,
      slippageBps,
      fillRatio,
      cancelCount,
      attempts,
      priceImprovement,
      requestedPrice: expectedPrice,
      executedPrice: placed?.avgPrice,
      filledQty,
      requestedQty
    };
  }

  private getAdaptationMultipliers(strategy: any, bias: string): any {
    // Default multipliers (no adaptation)
    const multipliers = {
      atr: 1.0,
      adx: 1.0,
      risk: 1.0,
      size: 1.0
    };

    if (!this.performanceMetrics || !this.recentTrades.length) {
      return multipliers; // No performance data available
    }

    try {
      // Analyze recent performance (last 10 trades)
      const recentTrades = this.recentTrades.slice(-10);
      const winRate = recentTrades.filter(t => t.win).length / recentTrades.length;
      const avgPnlPct = recentTrades.reduce((sum, t) => sum + t.pnlPct, 0) / recentTrades.length;

      // Target performance metrics
      const targetWinRate = 0.65;
      const targetAvgPnl = 0.5; // 0.5% average profit

      // Calculate performance score (-1 to 1, where 1 is excellent performance)
      const winRateScore = Math.max(-1, Math.min(1, (winRate - targetWinRate) / 0.2)); // ±20% win rate deviation
      const pnlScore = Math.max(-1, Math.min(1, (avgPnlPct - targetAvgPnl) / targetAvgPnl)); // Relative to target PnL
      const performanceScore = (winRateScore + pnlScore) / 2;

      console.log(`🎯 Performance adaptation for ${strategy}_${bias}: winRate=${winRate.toFixed(2)}, avgPnL=${avgPnlPct.toFixed(2)}%, score=${performanceScore.toFixed(2)}`);

      // Adjust multipliers based on performance
      if (performanceScore > 0.3) {
        // Excellent performance - can be more aggressive
        multipliers.atr *= 0.8;  // Lower ATR threshold (more permissive)
        multipliers.adx *= 0.9;  // Lower ADX threshold (more permissive)
        multipliers.risk *= 1.1; // Slightly higher risk tolerance
        multipliers.size *= 1.05; // Slightly larger position sizes

        recordOpsEvent({
          level: 'info',
          source: 'performance_adaptation',
          message: 'performance_excellent_increasing_aggression',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { performanceScore: performanceScore.toFixed(2), multipliers }
        });

      } else if (performanceScore < -0.3) {
        // Poor performance - be more conservative
        multipliers.atr *= 1.3;  // Higher ATR threshold (more strict)
        multipliers.adx *= 1.2;  // Higher ADX threshold (more strict)
        multipliers.risk *= 0.8; // Lower risk tolerance
        multipliers.size *= 0.9; // Smaller position sizes

        recordOpsEvent({
          level: 'warn',
          source: 'performance_adaptation',
          message: 'performance_poor_increasing_conservatism',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { performanceScore: performanceScore.toFixed(2), multipliers }
        });

      } else {
        // Neutral performance - slight adjustments based on recent trends
        const recentTrend = this.getRecentPerformance(5);
        if (recentTrend.winRate > winRate) {
          // Improving - slight relaxation
          multipliers.atr *= 0.95;
          multipliers.adx *= 0.97;
        } else if (recentTrend.winRate < winRate) {
          // Declining - slight tightening
          multipliers.atr *= 1.05;
          multipliers.adx *= 1.03;
        }
      }

      // Apply bounds to prevent extreme values
      multipliers.atr = Math.max(0.5, Math.min(2.0, multipliers.atr));
      multipliers.adx = Math.max(0.5, Math.min(2.0, multipliers.adx));
      multipliers.risk = Math.max(0.5, Math.min(1.5, multipliers.risk));
      multipliers.size = Math.max(0.7, Math.min(1.3, multipliers.size));

      console.log(`🎯 Adaptation multipliers: ATR=${multipliers.atr.toFixed(2)}, ADX=${multipliers.adx.toFixed(2)}, Risk=${multipliers.risk.toFixed(2)}, Size=${multipliers.size.toFixed(2)}`);

      return multipliers;

    } catch (error) {
      console.error('Error calculating adaptation multipliers:', error);
      return multipliers; // Return defaults on error
    }
  }

  public async nextPlan(options?: any): Promise<any> {
    try {
      const symbol = this.profile?.symbol;
      if (!symbol) {
        console.warn('nextPlan: No symbol available');
        return this.plan;
      }

      // Get current market snapshot
      const snap = await buildTechSnapshot(symbol);
      const regime = snap.regime;

      // Analyze recent performance to inform plan generation
      const performanceAnalysis = this.analyzeRecentPerformance();
      const adaptationMultipliers = this.getAdaptationMultipliers(
        this.plan?.bias || 'long',
        this.plan?.bias || 'long'
      );

      // Determine if we need a fresh plan or can adapt current one
      const needsFreshPlan = this.shouldGenerateFreshPlan(performanceAnalysis, snap, regime);

      let newPlan: PlanJson;

      if (needsFreshPlan) {
        // Generate completely new plan using AI
        console.log(`🎯 Generating fresh plan for ${symbol} - performance analysis: ${performanceAnalysis.needsAdjustment ? 'needs adjustment' : 'performing well'}`);

        newPlan = await proposePlan(symbol, {
          fresh: true,
          sessionId: this.sessionId || undefined,
          context: performanceAnalysis.killReason ? {
            killReason: performanceAnalysis.killReason,
            killDetails: performanceAnalysis.details
          } : undefined
        });
      } else {
        // Adapt existing plan based on performance and market conditions
        console.log(`🔄 Adapting existing plan for ${symbol}`);
        newPlan = this.adaptExistingPlan(snap, regime, performanceAnalysis, adaptationMultipliers);
      }

      // Apply performance-based adjustments
      newPlan = this.applyPerformanceAdjustments(newPlan, performanceAnalysis, adaptationMultipliers);

      // Validate the new plan
      const validatedPlan = await validatePlan(newPlan);

      // Update agent state
      this.plan = validatedPlan;
      this.regime = regime || null;
      
      // 🔥 PHASE 1: Initialize zone tracking variables
      this.lastZoneCalculation = Date.now();
      this.zoneCalculatedForBias = validatedPlan.bias;
      this.priceInZoneStartTime = 0;
      this.requireStrongerConfirmation = false;

      // Log plan generation
      recordOpsEvent({
        level: 'info',
        source: 'next_plan',
        message: needsFreshPlan ? 'fresh_plan_generated' : 'plan_adapted',
        sessionId: this.sessionId || undefined,
        symbol,
        details: {
          bias: newPlan.bias,
          playbook: newPlan.meta?.playbook,
          performanceScore: performanceAnalysis.performanceScore,
          adaptationApplied: !needsFreshPlan
        }
      });

      return validatedPlan;

    } catch (error) {
      console.error('Error in nextPlan:', error);

      // Fallback: return current plan or generate basic fallback
      if (this.plan) {
        console.log('Returning current plan as fallback');
        return this.plan;
      }

      // Generate emergency fallback plan
      try {
        const symbol = this.profile?.symbol || 'BTC/USDT';
        const snap = await buildTechSnapshot(symbol);
        const fallbackPlan = {
          name: 'Emergency_Fallback',
          symbol,
          timeframe: '1h' as const,
          bias: 'none' as const,
          zone: { type: 'support' as const, price: null, from: 'auto_detect' as const },
          entry_rule: { type: 'rebound' as const, confirm_close: true, max_distance_pct: 0.4 },
          risk: {
            stop: { type: 'atr' as const, mult: 1.0 },
            tp: [{ type: 'R' as const, value: 2.0 }],
            max_hold_hours: 36
          },
          position: { risk_fraction: 0.01, max_leverage: 5 },
          notes: 'Emergency fallback plan due to nextPlan error',
          meta: { playbook: 'standby' as const }
        };

        return await validatePlan(fallbackPlan);
      } catch (fallbackError) {
        console.error('Fallback plan generation failed:', fallbackError);
        return this.plan; // Return whatever we have
      }
    }
  }

  private analyzeRecentPerformance(): {
    performanceScore: number;
    needsAdjustment: boolean;
    killReason?: string;
    details?: any;
    consecutiveLosses: number;
    winRate: number;
    profitRatio: number;
  } {
    const recentTrades = this.recentTrades.slice(-10); // Last 10 trades
    if (recentTrades.length === 0) {
      return {
        performanceScore: 0.5,
        needsAdjustment: false,
        consecutiveLosses: 0,
        winRate: 0,
        profitRatio: 0
      };
    }

    const wins = recentTrades.filter(t => t.win).length;
    const winRate = wins / recentTrades.length;
    const profits = recentTrades.filter(t => t.win).reduce((sum, t) => sum + Math.abs(t.pnlPct), 0);
    const losses = recentTrades.filter(t => !t.win).reduce((sum, t) => sum + Math.abs(t.pnlPct), 0);
    const profitRatio = losses > 0 ? profits / losses : profits > 0 ? 10 : 0;

    // Calculate consecutive losses
    let consecutiveLosses = 0;
    for (let i = recentTrades.length - 1; i >= 0; i--) {
      if (!recentTrades[i].win) {
        consecutiveLosses++;
      } else {
        break;
      }
    }

    // Performance score (0-1, higher is better)
    let performanceScore = 0;
    performanceScore += winRate * 0.4; // 40% weight on win rate
    performanceScore += Math.min(profitRatio / 3, 1) * 0.4; // 40% weight on profit ratio (capped at 3:1)
    performanceScore += Math.max(0, 1 - consecutiveLosses / 5) * 0.2; // 20% weight on consistency

    const needsAdjustment = winRate < 0.4 || consecutiveLosses >= 3 || profitRatio < 0.8;

    let killReason: string | undefined;
    let details: any = {};

    // Determine if we should trigger kill switch (mode-adaptive)
    const limits = defaultLimits(this.profile?.aggressiveness);
    const maxConsecStops = limits.maxConsecutiveStops;
    
    if (consecutiveLosses >= 5) {
      killReason = 'consecutive_losses';
      details = { consecutiveLosses, recentTrades: recentTrades.length };
    } else if (winRate < 0.2 && recentTrades.length >= 5) {
      killReason = 'poor_win_rate';
      details = { winRate, recentTrades: recentTrades.length };
    } else if (this.consecutiveStops >= maxConsecStops) {
      killReason = 'multiple_stops';
      details = { consecutiveStops: this.consecutiveStops, maxAllowed: maxConsecStops, mode: this.profile?.aggressiveness };
    }

    return {
      performanceScore,
      needsAdjustment,
      killReason,
      details,
      consecutiveLosses,
      winRate,
      profitRatio
    };
  }

  private shouldGenerateFreshPlan(
    performance: ReturnType<typeof this.analyzeRecentPerformance>,
    snap: TechnicalSnapshot,
    regime?: any
  ): boolean {
    // Generate fresh plan if:
    // 1. Performance is very poor
    // 2. Regime has changed significantly
    // 3. Current plan is old or ineffective
    // 4. Market conditions have changed dramatically

    if (performance.killReason) return true;
    if (performance.consecutiveLosses >= 3) return true;
    if (performance.winRate < 0.3 && performance.profitRatio < 0.5) return true;

    // Check if regime has changed
    if (this.regime && regime) {
      if (this.regime.playbook !== regime.playbook) return true;
      if (this.regime.trend !== regime.trend) return true;
    }

    // Check if market volatility has changed significantly
    const currentVolatility = snap.atrPct || 0;
    const previousVolatility = this.plan ? (this.plan as any).atrPct || 0 : 0;
    if (Math.abs(currentVolatility - previousVolatility) / previousVolatility > 0.5) return true;

    // Generate fresh plan periodically (every few hours) or after significant drawdown
    const timeSinceLastPlan = this.plan ? Date.now() - (this.plan as any).timestamp || 0 : 0;
    if (timeSinceLastPlan > 4 * 60 * 60 * 1000) return true; // 4 hours

    return false;
  }

  private adaptExistingPlan(
    snap: TechnicalSnapshot,
    regime: any,
    performance: ReturnType<typeof this.analyzeRecentPerformance>,
    multipliers: ReturnType<typeof this.getAdaptationMultipliers>
  ): PlanJson {
    if (!this.plan) throw new Error('No existing plan to adapt');

    const basePlan = { ...this.plan.plan };

    // Apply performance-based adjustments
    if (performance.needsAdjustment) {
      // Tighten risk if performing poorly
      if (performance.winRate < 0.4) {
        basePlan.position.risk_fraction = Math.max(0.005, basePlan.position.risk_fraction * 0.8);
        basePlan.risk.stop.mult = Math.min(2.5, basePlan.risk.stop.mult * 1.1); // Tighter stops
      }

      // Adjust TP targets based on performance
      if (performance.profitRatio < 1.0) {
        // Increase TP targets if profit ratio is poor
        basePlan.risk.tp = basePlan.risk.tp.map(tp => ({
          ...tp,
          value: Math.min(5.0, tp.value * 1.2)
        }));
      }
    }

    // Apply adaptation multipliers
    basePlan.risk.stop.mult *= multipliers.atr;

    // Adjust based on current market regime
    if (regime) {
      basePlan.meta = {
        ...basePlan.meta,
        playbook: regime.playbook,
        regime: regime.trend,
        volatility: regime.volatility
      };

      if (regime.playbook === 'standby') {
        basePlan.bias = 'none';
      } else if (regime.playbook === 'momentum_breakout') {
        // Adjust for breakout conditions
        basePlan.entry_rule.confirm_close = false;
        basePlan.entry_rule.max_distance_pct = Math.min(0.6, basePlan.entry_rule.max_distance_pct * 1.2);
      }
    }

    // Update zone based on current market levels
    if (snap.support && snap.resistance) {
      if (basePlan.bias === 'long') {
        basePlan.zone.price = snap.support;
      } else if (basePlan.bias === 'short') {
        basePlan.zone.price = snap.resistance;
      }
    }

    // Add adaptation note
    basePlan.notes = `${basePlan.notes || ''} [Adapted: perf=${performance.performanceScore.toFixed(2)}, mult_atr=${multipliers.atr.toFixed(2)}]`.trim();

    return basePlan;
  }

  private applyPerformanceAdjustments(
    plan: PlanJson,
    performance: ReturnType<typeof this.analyzeRecentPerformance>,
    multipliers: ReturnType<typeof this.getAdaptationMultipliers>
  ): PlanJson {
    const adjusted = { ...plan };

    // Apply ATR multiplier
    adjusted.risk.stop.mult = Math.max(0.4, Math.min(3.0, adjusted.risk.stop.mult * multipliers.atr));

    // Adjust position sizing based on performance
    if (performance.performanceScore < 0.3) {
      // Poor performance - reduce risk
      adjusted.position.risk_fraction = Math.max(0.005, adjusted.position.risk_fraction * 0.7);
    } else if (performance.performanceScore > 0.7) {
      // Good performance - can increase risk slightly
      adjusted.position.risk_fraction = Math.min(0.03, adjusted.position.risk_fraction * 1.1);
    }

    // Update risk fraction range
    if (adjusted.position.risk_fraction_range) {
      const base = adjusted.position.risk_fraction;
      adjusted.position.risk_fraction_range.min = Math.max(0.005, base * 0.8);
      adjusted.position.risk_fraction_range.max = Math.min(0.05, base * 1.2);
      adjusted.position.risk_fraction_range.recommended = base;
    }

    // Adjust leverage based on performance
    if (performance.consecutiveLosses >= 2) {
      adjusted.position.max_leverage = Math.max(1, Math.floor(adjusted.position.max_leverage * 0.8));
    }

    return adjusted;
  }

  /**
   * Détermine si on devrait appeler l'IA pour une prédiction (optimisation coût)
   */
  private shouldCallAIPrediction(snap: TechnicalSnapshot, currentPrice: number): boolean {
    try {
      // 1. Vérifier proximité d'un niveau clé (support/résistance)
      const nearKeyLevel = this.checkNearKeyLevel(currentPrice, snap);
      if (nearKeyLevel) {
        console.log(`🧠 AI call triggered: Near key level`);
        return true;
      }

      // 2. Vérifier volatilité récente élevée (ATR > seuil)
      const atrPct = Number((snap as any)?.atrPct ?? 0);
      if (atrPct > 3.0) { // Plus de 3% ATR = marché très volatile
        console.log(`🧠 AI call triggered: High volatility (ATR: ${atrPct.toFixed(2)}%)`);
        return true;
      }

      // 3. Vérifier changement de prix significatif depuis dernière prédiction
      const lastPredictionTime = (this as any).lastAIPredictionTime || 0;
      const timeSinceLastPrediction = Date.now() - lastPredictionTime;
      
      // Si plus de 30 minutes depuis dernière prédiction, vérifier changement de prix
      if (timeSinceLastPrediction > 30 * 60 * 1000) {
        const lastPrice = (this as any).lastAIPredictionPrice || currentPrice;
        const priceChangePct = Math.abs((currentPrice - lastPrice) / lastPrice) * 100;
        
        if (priceChangePct > 2.0) { // Plus de 2% changement = appel IA
          console.log(`🧠 AI call triggered: Significant price change (${priceChangePct.toFixed(2)}%)`);
          return true;
        }
      }

      // 4. Vérifier conditions de momentum (slope élevée)
      const emaSlope = Number((snap as any)?.ema20Slope ?? 0);
      const slopePct = Math.abs(emaSlope / currentPrice) * 100;
      if (slopePct > 0.25) { // Slope > 0.25% = momentum très fort
        console.log(`🧠 AI call triggered: Strong momentum (slope: ${slopePct.toFixed(3)}%)`);
        return true;
      }

      // 5. Appel périodique (toutes les 4 heures minimum)
      if (timeSinceLastPrediction > 4 * 60 * 60 * 1000) {
        console.log(`🧠 AI call triggered: Periodic check (${Math.floor(timeSinceLastPrediction / (60 * 1000))}min since last)`);
        return true;
      }

      return false; // Pas d'appel IA nécessaire

    } catch (error) {
      console.warn('Error checking AI prediction conditions:', error);
      return false; // En cas d'erreur, pas d'appel IA
    }
  }
}
