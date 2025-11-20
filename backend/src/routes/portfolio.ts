import { Router } from 'express';
import { prisma } from '../db/client.js';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.js';

export const router = Router();

/**
 * PHASE 3: GET /api/portfolio/correlation
 * Returns correlation matrix for active positions
 */
router.get('/correlation', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'auth_required' });
    }

    const mode = (req.query.mode as 'paper' | 'live') || 'paper';
    
    // Get active sessions with orders to reconstruct positions
    const sessionWhere: any = {
      stoppedAt: null,
      mode,
    };
    if (req.user.role !== 'admin' && !req.user.isLegacy) {
      sessionWhere.userId = req.user.id;
    }

    const activeSessions = await prisma.agentSession.findMany({
      where: sessionWhere,
      include: {
        orders: {
          where: { status: 'filled' },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    
    // Reconstruct open positions from filled orders (like analyze-all-positions.mjs)
    const positions: Array<{
      sessionId: string;
      symbol: string;
      side: string;
      qty: number;
      entryPrice: number;
      unrealizedPnl: number;
      leverage: number;
    }> = [];
    
    for (const session of activeSessions) {
      // Group orders by symbol for multi-symbol agents
      const ordersBySymbol: Record<string, any[]> = {};
      for (const order of session.orders) {
        if (!ordersBySymbol[order.symbol]) {
          ordersBySymbol[order.symbol] = [];
        }
        ordersBySymbol[order.symbol].push(order);
      }
      
      // Reconstruct positions from order pairs
      for (const [symbol, orders] of Object.entries(ordersBySymbol)) {
        let currentTrade: any = null;
        
        for (const order of orders) {
          if (order.side === 'buy' || order.side === 'long') {
            // Entry
            currentTrade = {
              sessionId: session.id,
              symbol: order.symbol,
              side: order.side,
              entryPrice: order.price,
              qty: order.qty,
            };
          } else if ((order.side === 'sell' || order.side === 'short') && currentTrade) {
            // Exit closes the position
            currentTrade = null;
          }
        }
        
        // If currentTrade exists, it's an open position
        if (currentTrade) {
          const leverage = typeof session.profileJson === 'object' && session.profileJson !== null 
            ? (session.profileJson as any).leverage || 1 
            : 1;
            
          positions.push({
            sessionId: currentTrade.sessionId,
            symbol: currentTrade.symbol,
            side: currentTrade.side,
            qty: currentTrade.qty,
            entryPrice: currentTrade.entryPrice,
            unrealizedPnl: 0, // Would need current price from Binance
            leverage,
          });
        }
      }
    }
    
    // Calculate correlation matrix (simplified - in production use actual price data)
    const symbols = Array.from(new Set(positions.map(p => p.symbol)));
    const correlationMatrix: Record<string, Record<string, number>> = {};
    
    symbols.forEach(sym1 => {
      correlationMatrix[sym1] = {};
      symbols.forEach(sym2 => {
        if (sym1 === sym2) {
          correlationMatrix[sym1][sym2] = 1.0;
        } else {
          // Simplified correlation (in production, calculate from historical price data)
          // For now, use heuristics: BTC-ETH high, BTC-SOL medium, etc.
          const correlation = calculateSimplifiedCorrelation(sym1, sym2);
          correlationMatrix[sym1][sym2] = correlation;
        }
      });
    });
    
    // Calculate portfolio heat
    const totalExposure = positions.reduce((sum, p) => {
      const positionValue = p.qty * p.entryPrice * p.leverage;
      return sum + Math.abs(positionValue);
    }, 0);
    
    // Calculate weighted correlation
    let weightedCorrelation = 0;
    let pairCount = 0;
    
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const pos1 = positions[i];
        const pos2 = positions[j];
        const corr = correlationMatrix[pos1.symbol]?.[pos2.symbol] || 0;
        const weight1 = (pos1.qty * pos1.entryPrice * pos1.leverage) / totalExposure;
        const weight2 = (pos2.qty * pos2.entryPrice * pos2.leverage) / totalExposure;
        weightedCorrelation += corr * weight1 * weight2;
        pairCount++;
      }
    }
    
    const portfolioHeat = pairCount > 0 ? Math.abs(weightedCorrelation) : 0;
    const heatLimit = 0.90; // 90% max correlation
    
    // Check if hedging should be recommended
    const needsHedging = portfolioHeat > heatLimit * 0.85; // 85% of limit
    
    // Build matrix format expected by frontend
    const matrix: { symbol1: string; symbol2: string; correlation: number }[] = [];
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        matrix.push({
          symbol1: symbols[i],
          symbol2: symbols[j],
          correlation: correlationMatrix[symbols[i]]?.[symbols[j]] || 0,
        });
      }
    }
    
    const hedgingRecommendations: string[] = [];
    if (needsHedging) {
      hedgingRecommendations.push('Portfolio correlation approaching limit - consider hedging or reducing exposure');
      // Find highly correlated pairs
      matrix
        .filter(m => m.correlation > 0.75)
        .forEach(m => {
          hedgingRecommendations.push(`High correlation between ${m.symbol1} and ${m.symbol2} (${(m.correlation * 100).toFixed(0)}%)`);
        });
    }
    
    res.json({
      matrix,
      portfolioHeat,
      hedgingRecommendations,
      // Additional data for debugging
      metadata: {
        mode,
        positionCount: positions.length,
        totalExposure,
        heatLimit,
        heatPercentage: (portfolioHeat / heatLimit) * 100,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch portfolio correlation', details: error.message });
  }
});

/**
 * PHASE 3: GET /api/portfolio/risk-distribution
 * Returns risk distribution across positions
 */
router.get('/risk-distribution', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'auth_required' });
    }

    const mode = (req.query.mode as 'paper' | 'live') || 'paper';
    
    // Get active sessions with positions for this user
    const sessionWhere: any = {
      stoppedAt: null,
      mode,
    };
    if (req.user.role !== 'admin' && !req.user.isLegacy) {
      sessionWhere.userId = req.user.id;
    }

    const activeSessions = await prisma.agentSession.findMany({
      where: sessionWhere,
      include: {
        positions: {
          where: {
            qty: { gt: 0 },
          },
        },
      },
    });
    
    const positions = activeSessions.flatMap(session => 
      session.positions.map(pos => ({
        sessionId: session.id,
        symbol: pos.symbol || session.symbol,
        side: pos.side,
        qty: pos.qty || 0,
        entryPrice: pos.entryPrice || 0,
        stopPrice: pos.stopPrice,
        leverage: pos.leverage || 1,
        unrealizedPnl: pos.unrealizedPnl || 0,
      }))
    );
    
    // Calculate risk per position
    const riskBySymbol = positions.map(pos => {
      const positionValue = pos.qty * pos.entryPrice;
      const leveragedValue = positionValue * pos.leverage;
      const stopDistance = pos.stopPrice ? Math.abs(pos.entryPrice - pos.stopPrice) : pos.entryPrice * 0.02;
      const riskAmount = pos.qty * stopDistance;
      const riskPercentage = positionValue > 0 ? (riskAmount / positionValue) * 100 : 0;
      
      return {
        symbol: pos.symbol,
        side: pos.side,
        positionValue,
        leveragedValue,
        riskAmount,
        riskPercentage,
        leverage: pos.leverage,
        unrealizedPnl: pos.unrealizedPnl,
      };
    });
    
    const totalRisk = riskBySymbol.reduce((sum, r) => sum + r.riskAmount, 0);
    const totalValue = riskBySymbol.reduce((sum, r) => sum + r.positionValue, 0);
    
    // Group by leverage usage
    const leverageDistribution = {
      low: riskBySymbol.filter(r => r.leverage <= 2).length,
      medium: riskBySymbol.filter(r => r.leverage > 2 && r.leverage <= 5).length,
      high: riskBySymbol.filter(r => r.leverage > 5).length,
    };
    
    // Format response to match frontend expectations
    res.json({
      bySymbol: riskBySymbol.map(r => ({
        symbol: r.symbol,
        riskAmount: r.riskAmount,
        positionValue: r.positionValue,
        leverage: r.leverage,
        stopDistance: r.riskAmount / (r.positionValue > 0 ? r.positionValue : 1),
        portfolioRiskPercent: totalValue > 0 ? (r.riskAmount / totalValue) * 100 : 0,
      })),
      leverageDistribution: [
        { leverage: 1, count: leverageDistribution.low, totalValue: riskBySymbol.filter(r => r.leverage <= 2).reduce((sum, r) => sum + r.positionValue, 0) },
        { leverage: 3, count: leverageDistribution.medium, totalValue: riskBySymbol.filter(r => r.leverage > 2 && r.leverage <= 5).reduce((sum, r) => sum + r.positionValue, 0) },
        { leverage: 7, count: leverageDistribution.high, totalValue: riskBySymbol.filter(r => r.leverage > 5).reduce((sum, r) => sum + r.positionValue, 0) },
      ],
      totalPortfolioValue: totalValue,
      totalRiskAmount: totalRisk,
      avgLeverage: riskBySymbol.reduce((sum, r) => sum + r.leverage, 0) / (riskBySymbol.length || 1),
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch risk distribution', details: error.message });
  }
});

/**
 * Helper: Calculate simplified correlation between two symbols
 * In production, this should use actual historical price data
 */
function calculateSimplifiedCorrelation(sym1: string, sym2: string): number {
  // Simplified heuristic correlations
  const pairs: Record<string, Record<string, number>> = {
    'BTC/USDT': { 'ETH/USDT': 0.85, 'SOL/USDT': 0.72, 'XRP/USDT': 0.65, 'DOGE/USDT': 0.60 },
    'ETH/USDT': { 'BTC/USDT': 0.85, 'SOL/USDT': 0.68, 'XRP/USDT': 0.55, 'DOGE/USDT': 0.50 },
    'SOL/USDT': { 'BTC/USDT': 0.72, 'ETH/USDT': 0.68, 'XRP/USDT': 0.45, 'DOGE/USDT': 0.40 },
    'XRP/USDT': { 'BTC/USDT': 0.65, 'ETH/USDT': 0.55, 'SOL/USDT': 0.45, 'DOGE/USDT': 0.55 },
    'DOGE/USDT': { 'BTC/USDT': 0.60, 'ETH/USDT': 0.50, 'SOL/USDT': 0.40, 'XRP/USDT': 0.55 },
  };
  
  return pairs[sym1]?.[sym2] || pairs[sym2]?.[sym1] || 0.50; // Default moderate correlation
}

export default router;
