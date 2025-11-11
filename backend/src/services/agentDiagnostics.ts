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
    confidence: number;
    probabilities: {
      long: number;
      short: number;
      none: number;
    };
    primaryProbability: number;
    entryWeight: number;
    riskMultiplier: number;
    cooldown: {
      active: boolean;
      reason: string | null;
      seconds: number | null;
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
      
      // Return diagnostics based on DB data + symbol profile
      const hasOpenOrder = session.orders && session.orders.length > 0;
      
      return {
        sessionId,
        symbol: session.symbol,
        symbolProfile: symbolProfileData,
        predictor: null,
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
        timestamp: Date.now(),
      };
    }

    // Get latest snapshot from agent
    const snap: TechnicalSnapshot | null = agent.snap || agent.lastSnap || null;
    if (!snap) {
      // Return DB-only diagnostics when agent exists but has no snapshot yet
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
        predictor: null,
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

    // Extract predictor info (from agent state or last signal)
    let predictorInfo: AgentDiagnosticInfo['predictor'] = null;
    const pythonSignal = agent.pythonSignal || (agent.lastSignal as any)?.pythonSignal || null;
    
    if (pythonSignal) {
      predictorInfo = {
        available: true,
        decision: pythonSignal.decision || pythonSignal.bias || 'none',
        confidence: Number((pythonSignal.confidence ?? 0).toFixed(2)),
        probabilities: {
          long: Number((pythonSignal.probabilityLong ?? pythonSignal.probabilities?.long ?? 0).toFixed(2)),
          short: Number((pythonSignal.probabilityShort ?? pythonSignal.probabilities?.short ?? 0).toFixed(2)),
          none: Number((pythonSignal.probabilityNone ?? pythonSignal.probabilities?.none ?? 0).toFixed(2)),
        },
        primaryProbability: Number((pythonSignal.primaryProbability ?? 0).toFixed(2)),
        entryWeight: Number((pythonSignal.entryWeight ?? 1).toFixed(2)),
        riskMultiplier: Number((pythonSignal.riskMultiplier ?? 1).toFixed(2)),
        cooldown: {
          active: Boolean(pythonSignal.cooldown?.active),
          reason: pythonSignal.cooldown?.reason || null,
          seconds: pythonSignal.cooldown?.seconds || null,
        },
      };
    }

    // Extract strategy info
    let strategyInfo: AgentDiagnosticInfo['strategy'] = null;
    const currentStrategy = agent.strategy || agent.plan || agent.lastSignal || null;
    
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
    const market = {
      last: Number(snap.last.toFixed(4)),
      change24h: Number(((snap as any).change24h ?? 0).toFixed(2)),
      volume24h: Number(((snap as any).volume24h ?? (snap as any).volume ?? 0).toFixed(0)),
      volumeMA: Number(((snap as any).volumeMA ?? 0).toFixed(0)),
      volumeRatio: Number((((snap as any).volume ?? 0) / Math.max((snap as any).volumeMA ?? 1, 1)).toFixed(2)),
    };

    return {
      sessionId,
      symbol: session.symbol,
      symbolProfile,
      predictor: predictorInfo,
      strategy: strategyInfo,
      position: positionInfo,
      market,
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error(`[getAgentDiagnosticInfo] Error for session ${sessionId}:`, error);
    return null;
  }
}
