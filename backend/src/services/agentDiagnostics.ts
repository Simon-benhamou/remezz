/**
 * Enhanced Agent Diagnostic Info API
 * Returns comprehensive data for monitoring page including:
 * - Symbol profile (volatility, direction, volume, trend)
 * - Predictor results (probabilities, confidence, decision)
 * - Strategy metrics (current strategy, score, confidence)
 * - Position state (entry, R-multiple, time open)
 */

import type { Request, Response } from 'express';
import { prisma } from '../db/client.js';
import { AgentHub } from '../agent/hub.js';
import { classifyVolatilityRegime, classifyDirectionBias, classifyVolumeRegime, classifyTrendingRanging } from '../learning/personalityProfile.js';
import type { TechnicalSnapshot } from '../ai/tech.js';
import { getPredictorReliabilityMetrics } from '../quantai/pythonPredictor.js';

export type AgentDiagnosticInfo = {
  sessionId: string;
  symbol: string;
  
  // Symbol Profile
  symbolProfile: {
    volatilityRegime: string;
    directionBias: string;
    volumeRegime: string;
    trendingRanging: string;
    atrPct: number;
    adx: number;
    rsi: number;
    trendStrength: number;
  };
  
  // Predictor (Python ML Model)
  predictor: {
    available: boolean;
    decision: 'long' | 'short' | 'none';
    bias: 'long' | 'short' | 'both';
    direction: 'bullish' | 'bearish' | 'neutral';
    confidence: number;
    probabilities: {
      long: number;
      short: number;
      none: number;
    };
    primaryProbability: number;
    probLong: number;
    probShort: number;
    probNone: number;
    edge: number;
    entryWeight: number;
    riskMultiplier: number;
    source: string | null;
    cooldown: {
      active: boolean;
      reason: string | null;
      seconds: number | null;
    };
    // 🔴 Reliability Metrics
    reliability: {
      totalCalls: number;
      successfulCalls: number;
      failedCalls: number;
      reliabilityRate: number;
      isReliable: boolean;
      consecutiveFailures: number;
      lastErrorTimestamp: number | null;
      lastErrorMessage: string | null;
    };
  } | null;
  
  // Current Strategy
  strategy: {
    id: string;
    label: string;
    bias: 'long' | 'short' | 'both';
    confidence: number;
    score: number;
    family: string;
  } | null;
  
  // Position State
  position: {
    side: 'long' | 'short';
    entryPrice: number;
    currentPrice: number;
    rMultiple: number;
    pnlUsd: number;
    pnlPct: number;
    minutesOpen: number;
    stopPrice: number;
    targets: number[];
  } | null;
  
  // Market Context
  market: {
    last: number;
    change24h: number;
    volume24h: number;
    volumeMA: number;
    volumeRatio: number;
  };
  
  // Orders
  orders: Array<{
    id: string;
    side: 'long' | 'short';
    type: string;
    status: string;
    price: number | null;
    amount: number;
    filled: number;
    createdAt: string;
  }>;
  
  // Fills (Trades)
  fills: Array<{
    id: string;
    orderId: string;
    side: 'long' | 'short';
    price: number;
    amount: number;
    fee: number;
    createdAt: string;
  }>;
  
  timestamp: number;
};

export async function getAgentDiagnosticInfo(sessionId: string): Promise<AgentDiagnosticInfo | null> {
  try {
    // Get session
    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
      include: {
        orders: {
          where: { status: { in: ['open', 'filled'] } },
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });

    if (!session) {
      return null;
    }

    // Get agent from hub (may be null if backend restarted)
    const agent = AgentHub.get(sessionId) as any;
    
    // If agent not in hub, try to reconstruct diagnostics from DB/last known state
    if (!agent) {

      // FIX: Try to get real symbol profile from DB instead of defaults
      let symbolProfileData: any = {
        volatilityRegime: 'unknown',
        directionBias: 'unknown',
        volumeRegime: 'unknown',
        trendingRanging: 'unknown',
        atrPct: 0,
        adx: 0,
        rsi: 50,
        trendStrength: 0,
      };
      
      try {
        const { getSymbolProfile } = await import('./symbolSpecificOptimization.js');
        const profile = await getSymbolProfile(session.symbol);
        if (profile?.marketCharacteristics) {
          const mc = profile.marketCharacteristics as any;
          symbolProfileData = {
            volatilityRegime: mc.volatilityRegime || 'normal',
            directionBias: mc.directionBias || 'neutral',
            volumeRegime: mc.volumeRegime || 'normal',
            trendingRanging: mc.trendingRanging || 'ranging',
            atrPct: mc.atrPct || 0,
            adx: mc.adx || 0,
            rsi: mc.rsi || 50,
            trendStrength: mc.trendStrength || 0,
          };
        }
      } catch (error) {
        console.warn(`[diagnostics] Could not load symbol profile for ${session.symbol}:`, error);
      }
      
      // Try an on-demand predictor using a temporary snapshot even when agent is not yet in hub
      let onDemandPredictor: AgentDiagnosticInfo['predictor'] | null = null;
      try {
        const { buildTechSnapshot } = await import('../ai/tech.js');
        const tempSnap = await buildTechSnapshot(session.symbol, session.userId || undefined, { bypassCache: true }).catch(()=>null);
        if (tempSnap) {
          const { buildPredictorFeatures } = await import('../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');
          const { getPredictionSyncSafe, getPredictorReliabilityMetrics } = await import('../quantai/pythonPredictor.js');
          const features = buildPredictorFeatures(tempSnap as any);
          if (features && Object.keys(features).length > 0) {
            const pred = getPredictionSyncSafe(features, { allowFallback: true });
            const rel = getPredictorReliabilityMetrics();
            const probabilityEdgeRaw = (pred.probabilityLong ?? 0) - (pred.probabilityShort ?? 0);
            const meta = pred.meta && typeof pred.meta === 'object' ? (pred.meta as Record<string, unknown>) : null;
            const rawSource: unknown = meta ? (meta['predictionSource'] ?? meta['source'] ?? 'on_demand') : 'on_demand';
            const source = typeof rawSource === 'string' ? rawSource : rawSource != null ? String(rawSource) : 'on_demand';
            const dir = (pred as any).bias === 'long' ? 'bullish' : ( (pred as any).bias === 'short' ? 'bearish' : 'neutral');
            onDemandPredictor = {
              available: true,
              decision: pred.decision || 'none',
              bias: (pred as any).bias ?? (pred.decision as any) ?? 'both',
              direction: dir as any,
              confidence: Number((pred.confidence ?? 0).toFixed(2)),
              probabilities: {
                long: Number((pred.probabilityLong ?? pred.probabilities?.long ?? 0).toFixed(2)),
                short: Number((pred.probabilityShort ?? pred.probabilities?.short ?? 0).toFixed(2)),
                none: Number((pred.probabilityNone ?? pred.probabilities?.none ?? 0).toFixed(2)),
              },
              primaryProbability: Number((Math.max(pred.probabilityLong ?? 0, pred.probabilityShort ?? 0, pred.probabilityNone ?? 0)).toFixed(2)),
              probLong: Number((pred.probabilityLong ?? pred.probabilities?.long ?? 0).toFixed(4)),
              probShort: Number((pred.probabilityShort ?? pred.probabilities?.short ?? 0).toFixed(4)),
              probNone: Number((pred.probabilityNone ?? pred.probabilities?.none ?? 0).toFixed(4)),
              edge: Number(probabilityEdgeRaw.toFixed(4)),
              entryWeight: Number((pred.entryWeight ?? 1).toFixed(2)),
              riskMultiplier: Number((pred.riskMultiplier ?? 1).toFixed(2)),
              source,
              cooldown: {
                active: Boolean(pred.cooldown?.active),
                reason: pred.cooldown?.reason || null,
                seconds: pred.cooldown?.seconds || null,
              },
              reliability: {
                totalCalls: rel.totalCalls,
                successfulCalls: rel.successfulCalls,
                failedCalls: rel.failedCalls,
                reliabilityRate: Number(rel.reliabilityRate.toFixed(4)),
                isReliable: rel.isReliable,
                consecutiveFailures: rel.consecutiveFailures,
                lastErrorTimestamp: rel.lastErrorTimestamp,
                lastErrorMessage: rel.lastErrorMessage,
              },
            };
          }
        }
        else {
          // Minimal neutral features for rule-based fallback
          const { getPredictionSyncSafe, getPredictorReliabilityMetrics } = await import('../quantai/pythonPredictor.js');
          const neutral = { rsi_14: 50, macd_signal: 0, volume_ratio: 1, atr_14_pct: 1, price_change_1h_pct: 0 } as Record<string, number>;
          const pred = getPredictionSyncSafe(neutral, { allowFallback: true });
          const rel = getPredictorReliabilityMetrics();
          const probabilityEdgeRaw = (pred.probabilityLong ?? 0) - (pred.probabilityShort ?? 0);
          const meta = pred.meta && typeof pred.meta === 'object' ? (pred.meta as Record<string, unknown>) : null;
          const rawSource: unknown = meta ? (meta['predictionSource'] ?? meta['source'] ?? 'on_demand_minimal') : 'on_demand_minimal';
          const source = typeof rawSource === 'string' ? rawSource : rawSource != null ? String(rawSource) : 'on_demand_minimal';
          const dir = (pred as any).bias === 'long' ? 'bullish' : ( (pred as any).bias === 'short' ? 'bearish' : 'neutral');
          onDemandPredictor = {
            available: true,
            decision: pred.decision || 'none',
            bias: (pred as any).bias ?? (pred.decision as any) ?? 'both',
            direction: dir as any,
            confidence: Number((pred.confidence ?? 0).toFixed(2)),
            probabilities: {
              long: Number((pred.probabilityLong ?? pred.probabilities?.long ?? 0).toFixed(2)),
              short: Number((pred.probabilityShort ?? pred.probabilities?.short ?? 0).toFixed(2)),
              none: Number((pred.probabilityNone ?? pred.probabilities?.none ?? 0).toFixed(2)),
            },
            primaryProbability: Number((Math.max(pred.probabilityLong ?? 0, pred.probabilityShort ?? 0, pred.probabilityNone ?? 0)).toFixed(2)),
            probLong: Number((pred.probabilityLong ?? pred.probabilities?.long ?? 0).toFixed(4)),
            probShort: Number((pred.probabilityShort ?? pred.probabilities?.short ?? 0).toFixed(4)),
            probNone: Number((pred.probabilityNone ?? pred.probabilities?.none ?? 0).toFixed(4)),
            edge: Number(probabilityEdgeRaw.toFixed(4)),
            entryWeight: Number((pred.entryWeight ?? 1).toFixed(2)),
            riskMultiplier: Number((pred.riskMultiplier ?? 1).toFixed(2)),
            source,
            cooldown: {
              active: Boolean(pred.cooldown?.active),
              reason: pred.cooldown?.reason || null,
              seconds: pred.cooldown?.seconds || null,
            },
            reliability: {
              totalCalls: rel.totalCalls,
              successfulCalls: rel.successfulCalls,
              failedCalls: rel.failedCalls,
              reliabilityRate: Number(rel.reliabilityRate.toFixed(4)),
              isReliable: rel.isReliable,
              consecutiveFailures: rel.consecutiveFailures,
              lastErrorTimestamp: rel.lastErrorTimestamp,
              lastErrorMessage: rel.lastErrorMessage,
            },
          };
        }
      } catch {}

      // Return diagnostics based on DB data + symbol profile
      const hasOpenOrder = session.orders && session.orders.length > 0;

      return {
        sessionId,
        symbol: session.symbol,
        symbolProfile: symbolProfileData,
        predictor: onDemandPredictor,
        strategy: null,
        position: hasOpenOrder ? {
          side: session.orders[0].side === 'buy' ? 'long' : 'short',
          entryPrice: Number(session.orders[0].price || 0),
          currentPrice: Number(session.orders[0].price || 0),
          rMultiple: 0,
          pnlUsd: 0,
          pnlPct: 0,
          minutesOpen: Math.floor((Date.now() - new Date(session.orders[0].createdAt).getTime()) / 60000),
          stopPrice: 0,
          targets: [],
        } : null,
        market: {
          last: 0,
          change24h: 0,
          volume24h: 0,
          volumeMA: 0,
          volumeRatio: 0,
        },
        orders: [],
        fills: [],
        timestamp: Date.now(),
      };
    }

    // Get latest snapshot from agent
    const snap: TechnicalSnapshot | null = agent.snap || agent.lastSnap || null;
    if (!snap) {
      // Try to build a one-off snapshot and compute an immediate prediction
      let onDemandPredictor: AgentDiagnosticInfo['predictor'] | null = null;
      try {
        const { buildTechSnapshot } = await import('../ai/tech.js');
        const tempSnap = await buildTechSnapshot(session.symbol, session.userId || undefined, { bypassCache: true }).catch(()=>null);
        if (tempSnap) {
          const { buildPredictorFeatures } = await import('../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');
          const { getPredictionSyncSafe, getPredictorReliabilityMetrics } = await import('../quantai/pythonPredictor.js');
          const features = buildPredictorFeatures(tempSnap as any);
          if (features && Object.keys(features).length > 0) {
            const pred = getPredictionSyncSafe(features, { allowFallback: true });
            const rel = getPredictorReliabilityMetrics();
            const probabilityEdgeRaw = (pred.probabilityLong ?? 0) - (pred.probabilityShort ?? 0);
            const meta = pred.meta && typeof pred.meta === 'object' ? (pred.meta as Record<string, unknown>) : null;
            const rawSource: unknown = meta ? (meta['predictionSource'] ?? meta['source'] ?? 'on_demand') : 'on_demand';
            const source = typeof rawSource === 'string' ? rawSource : rawSource != null ? String(rawSource) : 'on_demand';
            const dir = (pred as any).bias === 'long' ? 'bullish' : ( (pred as any).bias === 'short' ? 'bearish' : 'neutral');
            onDemandPredictor = {
              available: true,
              decision: pred.decision || 'none',
              bias: (pred as any).bias ?? (pred.decision as any) ?? 'both',
              direction: dir as any,
              confidence: Number((pred.confidence ?? 0).toFixed(2)),
              probabilities: {
                long: Number((pred.probabilityLong ?? pred.probabilities?.long ?? 0).toFixed(2)),
                short: Number((pred.probabilityShort ?? pred.probabilities?.short ?? 0).toFixed(2)),
                none: Number((pred.probabilityNone ?? pred.probabilities?.none ?? 0).toFixed(2)),
              },
              primaryProbability: Number((Math.max(pred.probabilityLong ?? 0, pred.probabilityShort ?? 0, pred.probabilityNone ?? 0)).toFixed(2)),
              probLong: Number((pred.probabilityLong ?? pred.probabilities?.long ?? 0).toFixed(4)),
              probShort: Number((pred.probabilityShort ?? pred.probabilities?.short ?? 0).toFixed(4)),
              probNone: Number((pred.probabilityNone ?? pred.probabilities?.none ?? 0).toFixed(4)),
              edge: Number(probabilityEdgeRaw.toFixed(4)),
              entryWeight: Number((pred.entryWeight ?? 1).toFixed(2)),
              riskMultiplier: Number((pred.riskMultiplier ?? 1).toFixed(2)),
              source,
              cooldown: {
                active: Boolean(pred.cooldown?.active),
                reason: pred.cooldown?.reason || null,
                seconds: pred.cooldown?.seconds || null,
              },
              reliability: {
                totalCalls: rel.totalCalls,
                successfulCalls: rel.successfulCalls,
                failedCalls: rel.failedCalls,
                reliabilityRate: Number(rel.reliabilityRate.toFixed(4)),
                isReliable: rel.isReliable,
                consecutiveFailures: rel.consecutiveFailures,
                lastErrorTimestamp: rel.lastErrorTimestamp,
                lastErrorMessage: rel.lastErrorMessage,
              },
            };
          }
        }
      } catch {}

      // Return diagnostics even if we couldn't compute a snapshot
      const hasOpenOrder = session.orders && session.orders.length > 0;
      return {
        sessionId,
        symbol: session.symbol,
        symbolProfile: {
          volatilityRegime: 'waiting_for_data',
          directionBias: 'waiting_for_data',
          volumeRegime: 'waiting_for_data',
          trendingRanging: 'waiting_for_data',
          atrPct: 0,
          adx: 0,
          rsi: 50,
          trendStrength: 0,
        },
        predictor: onDemandPredictor,
        strategy: null,
        position: hasOpenOrder ? {
          side: session.orders[0].side === 'buy' ? 'long' : 'short',
          entryPrice: Number(session.orders[0].price || 0),
          currentPrice: Number(session.orders[0].price || 0),
          rMultiple: 0,
          pnlUsd: 0,
          pnlPct: 0,
          minutesOpen: Math.floor((Date.now() - new Date(session.orders[0].createdAt).getTime()) / 60000),
          stopPrice: 0,
          targets: [],
        } : null,
        market: {
          last: 0,
          change24h: 0,
          volume24h: 0,
          volumeMA: 0,
          volumeRatio: 0,
        },
        orders: [],
        fills: [],
        timestamp: Date.now(),
      };
    }

    // Extract symbol profile
    const atrPct = (snap.atr14 / snap.last) * 100;
    const volatilityRegime = classifyVolatilityRegime(atrPct);
    const directionBias = classifyDirectionBias((snap as any).ema20, (snap as any).ema50);
    const volume = (snap as any).volume ?? 0;
    const volumeMA = (snap as any).volumeMA ?? 1;
    const volumeRegime = classifyVolumeRegime(volume, volumeMA);
    const trendingRanging = classifyTrendingRanging(snap.adx14 ?? 0, atrPct);

    const symbolProfile = {
      volatilityRegime,
      directionBias,
      volumeRegime,
      trendingRanging,
      atrPct: Number(atrPct.toFixed(2)),
      adx: Number((snap.adx14 ?? 0).toFixed(1)),
      rsi: Number((snap.rsi14 ?? 50).toFixed(1)),
      trendStrength: Number(((snap as any).trendStrength ?? 0).toFixed(2)),
    };

    // Extract predictor info (from agent state, last signal, DB profileJson, or global cache)
    let predictorInfo: AgentDiagnosticInfo['predictor'] = null;
    let pythonSignal = agent.pythonSignal || (agent.lastSignal as any)?.pythonSignal || null;
    let predictionSource: 'live' | 'db' | 'cache' | 'none' = pythonSignal ? 'live' : 'none';
    
    // 🔴 FIX: Fallback to profileJson._diagnostics when agent has no live data
    if (!pythonSignal) {
      const profile = (session.profileJson as any) || {};
      const diagnostics = profile._diagnostics || {};
      if (diagnostics.lastPredictorData) {
        const saved = diagnostics.lastPredictorData;
        pythonSignal = {
          decision: saved.decision,
          confidence: saved.confidence,
          probabilities: saved.probabilities,
          probabilityLong: saved.probabilities?.long,
          probabilityShort: saved.probabilities?.short,
          probabilityNone: saved.probabilities?.none,
          primaryProbability: Math.max(
            saved.probabilities?.long || 0,
            saved.probabilities?.short || 0,
            saved.probabilities?.none || 0
          ),
          entryWeight: 1,
          riskMultiplier: 1,
          cooldown: { active: false, reason: null, seconds: null },
        };
        predictionSource = 'db';
      }
    }
    
    // 🆕 NEW: Fallback to global predictor cache if still no data
    if (!pythonSignal) {
      const { getCachedPrediction } = await import('../quantai/predictorCache.js');
      const cached = getCachedPrediction(session.symbol);
      if (cached) {
        pythonSignal = {
          decision: cached.decision,
          confidence: cached.confidence,
          probabilities: cached.probabilities,
          probabilityLong: cached.probabilityLong,
          probabilityShort: cached.probabilityShort,
          probabilityNone: cached.probabilityNone,
          primaryProbability: Math.max(
            cached.probabilityLong,
            cached.probabilityShort,
            cached.probabilityNone
          ),
          entryWeight: cached.entryWeight,
          riskMultiplier: cached.riskMultiplier,
          cooldown: cached.cooldown,
        };
        predictionSource = 'cache';
      }
    }

    // 🆕 NEW: As a last resort, compute a fresh prediction on-demand using the current snapshot
    if (!pythonSignal && snap) {
      try {
        const { buildPredictorFeatures } = await import('../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');
        const { getPredictionSyncSafe } = await import('../quantai/pythonPredictor.js');
        const features = buildPredictorFeatures(snap as any);
        if (features && Object.keys(features).length > 0) {
          const pred = getPredictionSyncSafe(features, { allowFallback: true });
          pythonSignal = {
            decision: pred.decision,
            confidence: pred.confidence,
            probabilities: pred.probabilities,
            probabilityLong: pred.probabilityLong,
            probabilityShort: pred.probabilityShort,
            probabilityNone: pred.probabilityNone,
            primaryProbability: Math.max(pred.probabilityLong, pred.probabilityShort, pred.probabilityNone),
            entryWeight: pred.entryWeight ?? 1,
            riskMultiplier: pred.riskMultiplier ?? 1,
            cooldown: pred.cooldown ?? { active: false, reason: null, seconds: null },
            meta: pred.meta || { source: 'diagnostics_on_demand' },
          } as any;
          predictionSource = 'live';
        }
      } catch (e) {
        // Swallow errors to keep diagnostics resilient
      }
    }
    // Get predictor reliability metrics
    const reliabilityMetrics = getPredictorReliabilityMetrics();
    
    if (pythonSignal) {
      const predictorDirection = pythonSignal.bias === 'long'
        ? 'bullish'
        : pythonSignal.bias === 'short'
          ? 'bearish'
          : 'neutral';
      const probabilityEdgeRaw = (pythonSignal.probabilityLong ?? pythonSignal.probabilities?.long ?? 0)
        - (pythonSignal.probabilityShort ?? pythonSignal.probabilities?.short ?? 0);
      const meta = pythonSignal.meta && typeof pythonSignal.meta === 'object' ? pythonSignal.meta : null;
      let rawSource: unknown = null;
      if (meta) {
        const metaRecord = meta as Record<string, unknown>;
        rawSource = metaRecord['predictionSource'] ?? metaRecord['source'] ?? null;
      }
      const source = typeof rawSource === 'string' ? rawSource : rawSource != null ? String(rawSource) : null;

      predictorInfo = {
        available: true,
        decision: pythonSignal.decision || pythonSignal.bias || 'none',
        bias: pythonSignal.bias ?? 'both',
        direction: predictorDirection,
        confidence: Number((pythonSignal.confidence ?? 0).toFixed(2)),
        probabilities: {
          long: Number((pythonSignal.probabilityLong ?? pythonSignal.probabilities?.long ?? 0).toFixed(2)),
          short: Number((pythonSignal.probabilityShort ?? pythonSignal.probabilities?.short ?? 0).toFixed(2)),
          none: Number((pythonSignal.probabilityNone ?? pythonSignal.probabilities?.none ?? 0).toFixed(2)),
        },
        primaryProbability: Number((pythonSignal.primaryProbability ?? 0).toFixed(2)),
        probLong: Number((pythonSignal.probabilityLong ?? pythonSignal.probabilities?.long ?? 0).toFixed(4)),
        probShort: Number((pythonSignal.probabilityShort ?? pythonSignal.probabilities?.short ?? 0).toFixed(4)),
        probNone: Number((pythonSignal.probabilityNone ?? pythonSignal.probabilities?.none ?? 0).toFixed(4)),
        edge: Number(probabilityEdgeRaw.toFixed(4)),
        entryWeight: Number((pythonSignal.entryWeight ?? 1).toFixed(2)),
        riskMultiplier: Number((pythonSignal.riskMultiplier ?? 1).toFixed(2)),
        source,
        cooldown: {
          active: Boolean(pythonSignal.cooldown?.active),
          reason: pythonSignal.cooldown?.reason || null,
          seconds: pythonSignal.cooldown?.seconds || null,
        },
        reliability: {
          totalCalls: reliabilityMetrics.totalCalls,
          successfulCalls: reliabilityMetrics.successfulCalls,
          failedCalls: reliabilityMetrics.failedCalls,
          reliabilityRate: Number(reliabilityMetrics.reliabilityRate.toFixed(4)),
          isReliable: reliabilityMetrics.isReliable,
          consecutiveFailures: reliabilityMetrics.consecutiveFailures,
          lastErrorTimestamp: reliabilityMetrics.lastErrorTimestamp,
          lastErrorMessage: reliabilityMetrics.lastErrorMessage,
        },
      };
    }

    // Extract strategy info (from agent state, last signal, or DB profileJson)
    let strategyInfo: AgentDiagnosticInfo['strategy'] = null;
    let currentStrategy = agent.strategy || agent.plan || agent.lastSignal || null;
    
    // 🔴 FIX: Fallback to profileJson._diagnostics when agent has no live data
    if (!currentStrategy) {
      const profile = (session.profileJson as any) || {};
      const diagnostics = profile._diagnostics || {};
      if (diagnostics.lastStrategyData) {
        const saved = diagnostics.lastStrategyData;
        currentStrategy = {
          id: saved.id,
          strategyId: saved.id,
          label: saved.label,
          strategyLabel: saved.label,
          bias: saved.bias,
          side: saved.bias,
          confidence: saved.confidence,
          score: saved.score,
          family: saved.family,
          strategyFamily: saved.family,
          meta: { score: saved.score },
        };
      }
    }
    
    if (currentStrategy) {
      strategyInfo = {
        id: currentStrategy.id || currentStrategy.strategyId || 'unknown',
        label: currentStrategy.label || currentStrategy.strategyLabel || 'Unknown Strategy',
        bias: currentStrategy.bias || currentStrategy.side || 'both',
        confidence: Number((currentStrategy.confidence ?? 0).toFixed(2)),
        score: Number((currentStrategy.score ?? currentStrategy.meta?.score ?? 0).toFixed(3)),
        family: currentStrategy.family || currentStrategy.strategyFamily || 'unknown',
      };
    }

    // Extract position info
    let positionInfo: AgentDiagnosticInfo['position'] = null;
    const position = agent.pos || agent.position || null;
    
    if (position && position.entry) {
      const currentPrice = snap.last;
      const entryPrice = position.entry;
      const stopPrice = position.stop || position.stopLoss || 0;
      const side = position.side === 'buy' ? 'long' : 'short';
      
      const riskPerUnit = Math.abs(entryPrice - stopPrice);
      const pnlPerUnit = side === 'long' 
        ? currentPrice - entryPrice 
        : entryPrice - currentPrice;
      
      const rMultiple = riskPerUnit > 0 ? pnlPerUnit / riskPerUnit : 0;
      const pnlPct = entryPrice > 0 ? (pnlPerUnit / entryPrice) * 100 : 0;
      const pnlUsd = pnlPerUnit * (position.qty || position.quantity || 0);
      
      const entryTime = position.entryTime || position.openedAt || Date.now();
      const minutesOpen = Math.floor((Date.now() - new Date(entryTime).getTime()) / 60000);

      positionInfo = {
        side,
        entryPrice: Number(entryPrice.toFixed(4)),
        currentPrice: Number(currentPrice.toFixed(4)),
        rMultiple: Number(rMultiple.toFixed(2)),
        pnlUsd: Number(pnlUsd.toFixed(2)),
        pnlPct: Number(pnlPct.toFixed(2)),
        minutesOpen,
        stopPrice: Number(stopPrice.toFixed(4)),
        targets: (position.targets || position.takeProfits || []).map((t: number) => Number(t.toFixed(4))),
      };
    }

    // Extract market context
    // Calculate 24h change from historical data if available
    let change24hPct = 0;
    try {
      const { getOHLCV } = await import('../data/market.js');
      const result = await getOHLCV(session.symbol, '1h', 25).catch(() => null);
      if (result && Array.isArray(result) && result.length >= 24) {
        const current = snap.last;
        const price24hAgo = result[0][4]; // close price 24h ago
        if (price24hAgo > 0) {
          change24hPct = ((current - price24hAgo) / price24hAgo) * 100;
        }
      } else if (result && typeof result === 'object' && 'series' in result) {
        const series = (result as any).series;
        if (Array.isArray(series) && series.length >= 24) {
          const current = snap.last;
          const price24hAgo = series[0][4];
          if (price24hAgo > 0) {
            change24hPct = ((current - price24hAgo) / price24hAgo) * 100;
          }
        }
      }
    } catch {}

    const market = {
      last: Number(snap.last.toFixed(4)),
      change24h: Number(change24hPct.toFixed(2)),
      volume24h: Number(((snap as any).volume24h ?? (snap as any).volume ?? 0).toFixed(0)),
      volumeMA: Number(((snap as any).volumeMA ?? 0).toFixed(0)),
      volumeRatio: Number((((snap as any).volume ?? 0) / Math.max((snap as any).volumeMA ?? 1, 1)).toFixed(2)),
    };

    // Get orders and fills
    const orders = await prisma.order.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    
    const fills = await prisma.fill.findMany({
      where: { sessionId },
      orderBy: { ts: 'desc' },
      take: 100,
    });

    return {
      sessionId,
      symbol: session.symbol,
      symbolProfile,
      predictor: predictorInfo,
      strategy: strategyInfo,
      position: positionInfo,
      market,
      orders: orders.map(o => ({
        id: o.id,
        side: (o.side || 'buy') as 'long' | 'short',
        type: o.type || 'market',
        status: o.status || 'unknown',
        price: o.price ? Number(o.price.toString()) : null,
        amount: o.qty ? Number(o.qty.toString()) : 0,
        filled: o.qty ? Number(o.qty.toString()) : 0,
        createdAt: o.createdAt.toISOString(),
      })),
      fills: fills.map(f => ({
        id: f.id,
        orderId: f.orderId,
        side: (f.side || 'buy') as 'long' | 'short',
        price: f.price ? Number(f.price.toString()) : 0,
        amount: f.qty ? Number(f.qty.toString()) : 0,
        fee: f.fee ? Number(f.fee.toString()) : 0,
        createdAt: f.ts.toISOString(),
      })),
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error(`[getAgentDiagnosticInfo] Error for session ${sessionId}:`, error);
    return null;
  }
}
