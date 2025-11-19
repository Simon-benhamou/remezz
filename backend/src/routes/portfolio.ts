import { Router } from 'express';
import { prisma } from '../db/client.js';

export const router = Router();

/**
 * PHASE 3: GET /api/portfolio/correlation
 * Returns correlation matrix for active positions
 */
router.get('/correlation', async (req, res) => {
  try {
    const mode = (req.query.mode as 'paper' | 'live') || 'paper';
    
    // Get all active sessions with positions
    const activeSessions = await prisma.agentSession.findMany({
      where: {
        stoppedAt: null,
        mode,
      },
      include: {
        positions: {
          where: {
            qty: { gt: 0 },
          },
        },
      },
    });
    
    // Get performance ledger for correlation calculation (simplified)
    const positions = activeSessions
      .flatMap(session => session.positions.map(pos => ({
        sessionId: session.id,
        symbol: pos.symbol || session.symbol,
        side: pos.side,
        qty: pos.qty || 0,
        entryPrice: pos.entryPrice || 0,
        unrealizedPnl: pos.unrealizedPnl || 0,
        leverage: pos.leverage || 1,
      })))
      .filter(pos => pos.qty > 0);
    
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
    
    res.json({
      mode,
      positions: positions.map(p => ({
        symbol: p.symbol,
        side: p.side,
        exposure: p.qty * p.entryPrice * p.leverage,
        heat: Math.min(1.0, portfolioHeat * 1.2), // Scaled heat per position
      })),
      correlationMatrix,
      portfolioMetrics: {
        portfolioHeat,
        heatLimit,
        heatPercentage: (portfolioHeat / heatLimit) * 100,
        needsHedging,
        totalExposure,
        positionCount: positions.length,
      },
      hedging: {
        active: false, // TODO: Check if any hedges are active
        recommended: needsHedging,
        reason: needsHedging ? 'Portfolio correlation approaching limit' : 'Portfolio correlation within acceptable range',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch portfolio correlation', details: error.message });
  }
});

/**
 * PHASE 3: GET /api/portfolio/risk-distribution
 * Returns risk distribution across positions
 */
router.get('/risk-distribution', async (req, res) => {
  try {
    const mode = (req.query.mode as 'paper' | 'live') || 'paper';
    
    // Get all active sessions with positions
    const activeSessions = await prisma.agentSession.findMany({
      where: {
        stoppedAt: null,
        mode,
      },
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
    
    res.json({
      mode,
      riskBySymbol,
      summary: {
        totalRisk,
        totalValue,
        portfolioRiskPercentage: totalValue > 0 ? (totalRisk / totalValue) * 100 : 0,
        positionCount: positions.length,
        avgLeverage: riskBySymbol.reduce((sum, r) => sum + r.leverage, 0) / (riskBySymbol.length || 1),
      },
      leverageDistribution,
      timestamp: new Date().toISOString(),
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
