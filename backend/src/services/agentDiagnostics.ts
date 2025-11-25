/**
 * Enhanced Agent Diagnostic Info API
 * Returns comprehensive data for monitoring page including:
 * - Symbol profile (volatility, direction, volume, trend)
 * - Strategy metrics (current strategy, score, confidence)
 * - Position state (entry, R-multiple, time open)
 * - Scoring breakdown (trend/breakout/mean/momentum scores) for transparency
 */

import type { Request, Response } from 'express';
import { prisma } from '../db/client.js';
import { AgentHub } from '../agent/hub.js';
import { classifyVolatilityRegime, classifyDirectionBias, classifyVolumeRegime, classifyTrendingRanging } from '../learning/personalityProfile.js';
import type { TechnicalSnapshot } from '../ai/tech.js';
import type { ExecutionPlan, MarketQualityScore, RiskLimits, SentimentSignal } from '../agent/subagents/types.js';
import { agentServiceRegistry } from '../agent/subagents/serviceRegistry.js';
import { getLastScoringBreakdown, type ScoringBreakdown } from '../quantai/strategies/metaAdaptive/recognizedStrategies.js';

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
  
  // Current Strategy
  strategy: {
    id: string;
    label: string;
    bias: 'long' | 'short' | 'both';
    confidence: number;
    score: number;
    family: string;
  } | null;
  
  // 🆕 Scoring Breakdown - shows WHY agent chose a strategy
  scoringBreakdown: ScoringBreakdown | null;
  
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
  
  supportAgents: {
    marketQuality: MarketQualityScore;
    sentiment: SentimentSignal;
    riskLimits: RiskLimits;
    executionPlan: ExecutionPlan | null;
  };
  
  // Market Context
  market: {
    last: number;
    change24h: number;
    volume24h: number;
    volumeMA: number;
    volumeRatio: number;
  };

  technicalLevels: {
    support: number | null;
    resistance: number | null;
    supports: Array<{ price: number; touches: number; strength: number; label: string | null }>;
    resistances: Array<{ price: number; touches: number; strength: number; label: string | null }>;
    pivots: {
      P: number | null;
      S1: number | null;
      S2: number | null;
      R1: number | null;
      R2: number | null;
      refDay: string | null;
    } | null;
    srBias: 'nearSupport' | 'nearResistance' | 'neutral' | null;
  } | null;
  
  // Orders
  orders: Array<{
    id: string;
    clientOrderId?: string | null;
    intent?: 'entry' | 'exit';
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

      // Return diagnostics based on DB data + symbol profile
      // 🔴 FIX: Retrieve orders and fills from database even when agent is not in hub
      const dbOrders = await prisma.order.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      
      const dbFills = await prisma.fill.findMany({
        where: { sessionId },
        orderBy: { ts: 'desc' },
        take: 100,
      });

      const dbPosition = await prisma.position.findFirst({
        where: { 
          sessionId,
          qty: { not: 0 }
        },
        orderBy: { openedAt: 'desc' }
      });

      // Try to get current market price and volume data
      let currentPrice = 0;
      let fallbackVolume24h = 0;
      let fallbackVolumeMA = 0;
      let fallbackChange24hPct = 0;
      try {
        const { getTicker } = await import('../data/market.js');
        const ticker = await getTicker(session.symbol).catch(() => null);
        currentPrice = ticker?.last ?? 0;
        fallbackVolume24h = (ticker as any)?.volume24h ?? (ticker as any)?.volume ?? 0;
        fallbackVolumeMA = (ticker as any)?.volumeMA ?? 0;
        
        // Try to get 24h change from OHLCV
        try {
          const { getOHLCV } = await import('../data/market.js');
          const result = await getOHLCV(session.symbol, '1h', 24).catch(() => null);
          if (result && Array.isArray(result) && result.length >= 24) {
            const price24hAgo = result[0][4];
            if (price24hAgo > 0 && currentPrice > 0) {
              fallbackChange24hPct = ((currentPrice - price24hAgo) / price24hAgo) * 100;
            }
          }
        } catch {}
      } catch {}

      const hasOpenOrder = session.orders && session.orders.length > 0;
      let positionInfo: AgentDiagnosticInfo['position'] = null;
      
      if (dbPosition) {
        const entryPrice = Number(dbPosition.entryPrice || 0);
        const stopPrice = Number(dbPosition.stopPrice || 0);
        const side = dbPosition.side === 'buy' ? 'long' : 'short';
        const riskPerUnit = Math.abs(entryPrice - stopPrice);
        const pnlPerUnit = side === 'long' 
          ? currentPrice - entryPrice 
          : entryPrice - currentPrice;
        const rMultiple = riskPerUnit > 0 ? pnlPerUnit / riskPerUnit : 0;
        const pnlPct = entryPrice > 0 ? (pnlPerUnit / entryPrice) * 100 : 0;
        const pnlUsd = pnlPerUnit * Number(dbPosition.qty || 0);
        const minutesOpen = dbPosition.openedAt 
          ? Math.floor((Date.now() - new Date(dbPosition.openedAt).getTime()) / 60000)
          : 0;

        positionInfo = {
          side,
          entryPrice,
          currentPrice,
          rMultiple: Number(rMultiple.toFixed(2)),
          pnlUsd: Number(pnlUsd.toFixed(2)),
          pnlPct: Number(pnlPct.toFixed(2)),
          minutesOpen,
          stopPrice,
          targets: [], // TODO: extract targets from orders
        };
      } else if (hasOpenOrder) {
        positionInfo = {
          side: session.orders[0].side === 'buy' ? 'long' : 'short',
          entryPrice: Number(session.orders[0].price || 0),
          currentPrice: currentPrice || Number(session.orders[0].price || 0),
          rMultiple: 0,
          pnlUsd: 0,
          pnlPct: 0,
          minutesOpen: Math.floor((Date.now() - new Date(session.orders[0].createdAt).getTime()) / 60000),
          stopPrice: 0,
          targets: [],
        };
      }

      const inferOrderIntent = (order: { clientOrderId?: string | null }): 'entry' | 'exit' => {
        const rawId = typeof order.clientOrderId === 'string' ? order.clientOrderId : '';
        const clientId = rawId.toLowerCase();
        if (!clientId) return 'entry';
        if (clientId.includes('exit') || clientId.includes('close') || clientId.includes('reduce')) {
          return 'exit';
        }
        return 'entry';
      };

      const supportAgents = await buildSupportAgentsSnapshot(sessionId, session.symbol, {
        side: positionInfo?.side === 'long' ? 'buy' : 'sell',
      });

      return {
        sessionId,
        symbol: session.symbol,
        symbolProfile: symbolProfileData,
        strategy: null,
        scoringBreakdown: getLastScoringBreakdown(session.symbol),
        position: positionInfo,
        supportAgents,
        market: {
          last: currentPrice,
          change24h: Number(fallbackChange24hPct.toFixed(2)),
          volume24h: Number(fallbackVolume24h.toFixed(0)),
          volumeMA: Number(fallbackVolumeMA.toFixed(0)),
          volumeRatio: Number((fallbackVolume24h / Math.max(fallbackVolumeMA, 1)).toFixed(2)),
        },
        technicalLevels: null,
        orders: dbOrders.map(o => ({
          id: o.id,
          clientOrderId: o.clientOrderId,
          intent: inferOrderIntent(o),
          side: (o.side || 'buy') as 'long' | 'short',
          type: o.type || 'market',
          status: o.status || 'unknown',
          price: o.price ? Number(o.price.toString()) : null,
          amount: o.qty ? Number(o.qty.toString()) : 0,
          filled: o.qty ? Number(o.qty.toString()) : 0,
          createdAt: o.createdAt.toISOString(),
        })),
        fills: dbFills.map(f => ({
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
    }

    // Get latest snapshot from agent
    const snap: TechnicalSnapshot | null = agent.snap || agent.lastSnap || null;
    if (!snap) {
      // Return diagnostics even if we couldn't compute a snapshot
      // 🔴 FIX: Retrieve orders and fills from database
      const dbOrders = await prisma.order.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      
      const dbFills = await prisma.fill.findMany({
        where: { sessionId },
        orderBy: { ts: 'desc' },
        take: 100,
      });

      const dbPosition = await prisma.position.findFirst({
        where: { 
          sessionId,
          qty: { not: 0 }
        },
        orderBy: { openedAt: 'desc' }
      });

      // Try to get current market price and volume data
      let currentPrice = 0;
      let fallbackVolume24h = 0;
      let fallbackVolumeMA = 0;
      let fallbackChange24hPct = 0;
      try {
        const { getTicker } = await import('../data/market.js');
        const ticker = await getTicker(session.symbol).catch(() => null);
        currentPrice = ticker?.last ?? 0;
        fallbackVolume24h = (ticker as any)?.volume24h ?? (ticker as any)?.volume ?? 0;
        fallbackVolumeMA = (ticker as any)?.volumeMA ?? 0;
        
        // Try to get 24h change from OHLCV
        try {
          const { getOHLCV } = await import('../data/market.js');
          const result = await getOHLCV(session.symbol, '1h', 24).catch(() => null);
          if (result && Array.isArray(result) && result.length >= 24) {
            const price24hAgo = result[0][4];
            if (price24hAgo > 0 && currentPrice > 0) {
              fallbackChange24hPct = ((currentPrice - price24hAgo) / price24hAgo) * 100;
            }
          }
        } catch {}
      } catch {}

      const hasOpenOrder = session.orders && session.orders.length > 0;
      let positionInfo: AgentDiagnosticInfo['position'] = null;
      
      if (dbPosition) {
        const entryPrice = Number(dbPosition.entryPrice || 0);
        const stopPrice = Number(dbPosition.stopPrice || 0);
        const side = dbPosition.side === 'buy' ? 'long' : 'short';
        const riskPerUnit = Math.abs(entryPrice - stopPrice);
        const pnlPerUnit = side === 'long' 
          ? currentPrice - entryPrice 
          : entryPrice - currentPrice;
        const rMultiple = riskPerUnit > 0 ? pnlPerUnit / riskPerUnit : 0;
        const pnlPct = entryPrice > 0 ? (pnlPerUnit / entryPrice) * 100 : 0;
        const pnlUsd = pnlPerUnit * Number(dbPosition.qty || 0);
        const minutesOpen = dbPosition.openedAt 
          ? Math.floor((Date.now() - new Date(dbPosition.openedAt).getTime()) / 60000)
          : 0;

        positionInfo = {
          side,
          entryPrice,
          currentPrice,
          rMultiple: Number(rMultiple.toFixed(2)),
          pnlUsd: Number(pnlUsd.toFixed(2)),
          pnlPct: Number(pnlPct.toFixed(2)),
          minutesOpen,
          stopPrice,
          targets: [],
        };
      } else if (hasOpenOrder) {
        positionInfo = {
          side: session.orders[0].side === 'buy' ? 'long' : 'short',
          entryPrice: Number(session.orders[0].price || 0),
          currentPrice: currentPrice || Number(session.orders[0].price || 0),
          rMultiple: 0,
          pnlUsd: 0,
          pnlPct: 0,
          minutesOpen: Math.floor((Date.now() - new Date(session.orders[0].createdAt).getTime()) / 60000),
          stopPrice: 0,
          targets: [],
        };
      }

      const inferOrderIntent = (order: { clientOrderId?: string | null }): 'entry' | 'exit' => {
        const rawId = typeof order.clientOrderId === 'string' ? order.clientOrderId : '';
        const clientId = rawId.toLowerCase();
        if (!clientId) return 'entry';
        if (clientId.includes('exit') || clientId.includes('close') || clientId.includes('reduce')) {
          return 'exit';
        }
        return 'entry';
      };

      const supportAgents = await buildSupportAgentsSnapshot(sessionId, session.symbol, {
        side: positionInfo?.side === 'long' ? 'buy' : 'sell',
      });

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
        strategy: null,
        scoringBreakdown: getLastScoringBreakdown(session.symbol),
        position: positionInfo,
        supportAgents,
        market: {
          last: currentPrice,
          change24h: Number(fallbackChange24hPct.toFixed(2)),
          volume24h: Number(fallbackVolume24h.toFixed(0)),
          volumeMA: Number(fallbackVolumeMA.toFixed(0)),
          volumeRatio: Number((fallbackVolume24h / Math.max(fallbackVolumeMA, 1)).toFixed(2)),
        },
        technicalLevels: null,
        orders: dbOrders.map(o => ({
          id: o.id,
          clientOrderId: o.clientOrderId,
          intent: inferOrderIntent(o),
          side: (o.side || 'buy') as 'long' | 'short',
          type: o.type || 'market',
          status: o.status || 'unknown',
          price: o.price ? Number(o.price.toString()) : null,
          amount: o.qty ? Number(o.qty.toString()) : 0,
          filled: o.qty ? Number(o.qty.toString()) : 0,
          createdAt: o.createdAt.toISOString(),
        })),
        fills: dbFills.map(f => ({
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

    const formatPrice = (value: unknown): number | null => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
      }
      return Number(value.toFixed(4));
    };

    const inferOrderIntent = (order: { clientOrderId?: string | null }): 'entry' | 'exit' => {
      const rawId = typeof order.clientOrderId === 'string' ? order.clientOrderId : '';
      const clientId = rawId.toLowerCase();
      if (!clientId) return 'entry';
      if (clientId.includes('exit') || clientId.includes('close') || clientId.includes('reduce')) {
        return 'exit';
      }
      return 'entry';
    };

    const normalizeLevels = (levels?: Array<{ price?: number; touches?: number; strength?: number; label?: string }>) => {
      if (!Array.isArray(levels)) return [];
      return levels
        .filter(level => typeof level?.price === 'number' && Number.isFinite(level.price as number))
        .slice(0, 4)
        .map(level => ({
          price: Number((level.price ?? 0).toFixed(4)),
          touches: Number(level.touches ?? 0),
          strength: Number(level.strength ?? 0),
          label: level.label ?? null,
        }));
    };

    const pivots = snap.pivots ? {
      P: formatPrice(snap.pivots.P),
      S1: formatPrice(snap.pivots.S1),
      S2: formatPrice(snap.pivots.S2),
      R1: formatPrice(snap.pivots.R1),
      R2: formatPrice(snap.pivots.R2),
      refDay: snap.pivots.refDay || null,
    } : null;

    const technicalLevels = {
      support: formatPrice(snap.support),
      resistance: formatPrice(snap.resistance),
      supports: normalizeLevels(snap.supports),
      resistances: normalizeLevels(snap.resistances),
      pivots,
      srBias: snap.srBias || null,
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

    const supportAgents = await buildSupportAgentsSnapshot(sessionId, session.symbol, {
      side: positionInfo?.side === 'long' ? 'buy' : 'sell',
    });

    return {
      sessionId,
      symbol: session.symbol,
      symbolProfile,
      strategy: strategyInfo,
      scoringBreakdown: getLastScoringBreakdown(session.symbol),
      position: positionInfo,
      supportAgents,
      market,
      technicalLevels,
      orders: orders.map(o => ({
        id: o.id,
        clientOrderId: o.clientOrderId,
        intent: inferOrderIntent(o),
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

async function buildSupportAgentsSnapshot(
  sessionId: string,
  symbol: string,
  params: { side: 'buy' | 'sell' | undefined },
) {
  const services = agentServiceRegistry;
  const marketQuality = await services.marketQuality.assess(symbol);
  const sentiment = await services.sentiment.getSignal(symbol);
  const riskLimits = await services.riskGovernor.getLimits(sessionId, symbol);
  let executionPlan: ExecutionPlan | null = null;
  if (params.side) {
    executionPlan = await services.execution.plan({
      symbol,
      side: params.side,
      sizeUsd: riskLimits.maxPositionUsd,
      spreadBps: marketQuality.spreadBps,
      marketQualityScore: marketQuality.score,
      marketQuality,
      riskLimits,
    });
  }
  return { marketQuality, sentiment, riskLimits, executionPlan };
}
