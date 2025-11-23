/**
 * STRATEGY PERFORMANCE API
 * 
 * Endpoints pour analyser la performance des différentes stratégies
 * utilisées par les agents de trading
 */

import express from 'express';
import { 
  analyzeStrategyPerformance, 
  getStrategyRecommendation,
  generateStrategyReport 
} from '../learning/strategyPerformanceAnalyzer.js';
import { prisma } from '../db/client.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('strategy-performance');
export const router = express.Router();

/**
 * GET /api/strategy-performance/summary
 * 
 * Obtient un résumé des performances de toutes les stratégies
 * Query params:
 * - days: nombre de jours d'historique (default: 30)
 * - symbol: filtre par crypto (optional)
 */
router.get('/summary', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const symbol = req.query.symbol as string | undefined;
    
    const recommendations = await analyzeStrategyPerformance(symbol, days);
    
    // Aggregate global stats
    const globalStats = recommendations.reduce((acc, rec) => {
      for (const strat of rec.strategies) {
        if (!acc[strat.strategy]) {
          acc[strat.strategy] = {
            strategy: strat.strategy,
            totalTrades: 0,
            totalWins: 0,
            totalPnlUsd: 0,
            cryptoCount: 0,
          };
        }
        acc[strat.strategy].totalTrades += strat.totalTrades;
        acc[strat.strategy].totalWins += Math.round(strat.winRate * strat.totalTrades);
        acc[strat.strategy].totalPnlUsd += strat.totalPnlUsd;
        acc[strat.strategy].cryptoCount++;
      }
      return acc;
    }, {} as Record<string, any>);
    
    const globalArray = Object.values(globalStats).map((s: any) => ({
      strategy: s.strategy,
      totalTrades: s.totalTrades,
      winRate: s.totalTrades > 0 ? s.totalWins / s.totalTrades : 0,
      totalPnlUsd: s.totalPnlUsd,
      avgPnlUsd: s.totalTrades > 0 ? s.totalPnlUsd / s.totalTrades : 0,
      cryptoCount: s.cryptoCount,
      profitFactor: calculateProfitFactor(s),
    }));
    
    res.json({
      period: { days, symbol },
      global: globalArray,
      bySymbol: recommendations,
    });
  } catch (error) {
    logger.error('Error fetching strategy summary', { error });
    res.status(500).json({ error: 'Failed to fetch strategy summary' });
  }
});

/**
 * GET /api/strategy-performance/recommendation/:symbol
 * 
 * Obtient la recommandation de stratégie pour un crypto donné
 * basée sur l'historique et les conditions actuelles
 */
router.get('/recommendation/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const atrPct = parseFloat(req.query.atrPct as string) || 1.0;
    const adx = parseFloat(req.query.adx as string) || 20;
    const emaCompression = parseFloat(req.query.emaCompression as string) || 3.0;
    const rsi = req.query.rsi ? parseFloat(req.query.rsi as string) : undefined;
    
    const recommendation = await getStrategyRecommendation(symbol, {
      atrPct,
      adx,
      emaCompression,
      rsi,
    });
    
    res.json(recommendation);
  } catch (error) {
    logger.error('Error fetching recommendation', { error, symbol: req.params.symbol });
    res.status(500).json({ error: 'Failed to fetch recommendation' });
  }
});

/**
 * GET /api/strategy-performance/detailed
 * 
 * Statistiques détaillées par stratégie avec breakdown par crypto
 */
router.get('/detailed', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    // Get all fills with strategy
    const fills = await prisma.fill.findMany({
      where: {
        ts: { gte: since },
        strategyUsed: { not: null },
      },
      include: {
        session: {
          select: { symbol: true },
        },
        order: {
          select: {
            strategyUsed: true,
            strategyConfidence: true,
            side: true,
          },
        },
      },
      orderBy: { ts: 'asc' },
    });
    
    // Group by strategy
    const strategyMap = new Map<string, {
      trades: any[];
      bySymbol: Map<string, any[]>;
      dailyPnl: Map<string, number>;
    }>();
    
    for (const fill of fills) {
      if (!fill.strategyUsed) continue;
      
      const strategy = fill.strategyUsed;
      if (!strategyMap.has(strategy)) {
        strategyMap.set(strategy, {
          trades: [],
          bySymbol: new Map(),
          dailyPnl: new Map(),
        });
      }
      
      const data = strategyMap.get(strategy)!;
      data.trades.push(fill);
      
      // By symbol
      const sym = fill.session?.symbol || 'UNKNOWN';
      if (!data.bySymbol.has(sym)) {
        data.bySymbol.set(sym, []);
      }
      data.bySymbol.get(sym)!.push(fill);
      
      // Daily PnL
      const day = fill.ts.toISOString().split('T')[0];
      data.dailyPnl.set(day, (data.dailyPnl.get(day) || 0) + (fill.realizedPnl || 0));
    }
    
    // Build detailed stats
    const detailed = Array.from(strategyMap.entries()).map(([strategy, data]) => {
      const trades = data.trades;
      const wins = trades.filter(t => (t.realizedPnl || 0) > 0).length;
      const losses = trades.filter(t => (t.realizedPnl || 0) < 0).length;
      const totalPnl = trades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);
      const winningPnl = trades.filter(t => (t.realizedPnl || 0) > 0).reduce((sum, t) => sum + (t.realizedPnl || 0), 0);
      const losingPnl = Math.abs(trades.filter(t => (t.realizedPnl || 0) < 0).reduce((sum, t) => sum + (t.realizedPnl || 0), 0));
      
      const bySymbol = Array.from(data.bySymbol.entries()).map(([symbol, fills]) => {
        const symWins = fills.filter(f => (f.realizedPnl || 0) > 0).length;
        const symTotal = fills.length;
        const symPnl = fills.reduce((sum, f) => sum + (f.realizedPnl || 0), 0);
        
        return {
          symbol,
          trades: symTotal,
          winRate: symTotal > 0 ? symWins / symTotal : 0,
          totalPnl: symPnl,
          avgPnl: symTotal > 0 ? symPnl / symTotal : 0,
        };
      }).sort((a, b) => b.totalPnl - a.totalPnl);
      
      const dailyPnl = Array.from(data.dailyPnl.entries()).map(([date, pnl]) => ({
        date,
        pnl,
      })).sort((a, b) => a.date.localeCompare(b.date));
      
      return {
        strategy,
        totalTrades: trades.length,
        wins,
        losses,
        winRate: trades.length > 0 ? wins / trades.length : 0,
        totalPnl,
        avgPnl: trades.length > 0 ? totalPnl / trades.length : 0,
        profitFactor: losingPnl > 0 ? winningPnl / losingPnl : winningPnl > 0 ? 999 : 0,
        avgWin: wins > 0 ? winningPnl / wins : 0,
        avgLoss: losses > 0 ? losingPnl / losses : 0,
        bySymbol,
        dailyPnl,
      };
    });
    
    res.json({ period: days, strategies: detailed });
  } catch (error) {
    logger.error('Error fetching detailed stats', { error });
    res.status(500).json({ error: 'Failed to fetch detailed stats' });
  }
});

/**
 * GET /api/strategy-performance/heatmap
 * 
 * Heatmap crypto x strategy pour identifier les meilleures combinaisons
 */
router.get('/heatmap', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    const fills = await prisma.fill.findMany({
      where: {
        ts: { gte: since },
        strategyUsed: { not: null },
      },
      include: {
        session: {
          select: { symbol: true },
        },
      },
    });
    
    // Build matrix
    const matrix = new Map<string, Map<string, {
      trades: number;
      wins: number;
      pnl: number;
    }>>();
    
    for (const fill of fills) {
      if (!fill.session?.symbol || !fill.strategyUsed) continue;
      
      const sym = fill.session.symbol;
      const strat = fill.strategyUsed;
      
      if (!matrix.has(sym)) {
        matrix.set(sym, new Map());
      }
      
      const symData = matrix.get(sym)!;
      if (!symData.has(strat)) {
        symData.set(strat, { trades: 0, wins: 0, pnl: 0 });
      }
      
      const cell = symData.get(strat)!;
      cell.trades++;
      if ((fill.realizedPnl || 0) > 0) cell.wins++;
      cell.pnl += fill.realizedPnl || 0;
    }
    
    // Convert to array format
    const heatmap = Array.from(matrix.entries()).map(([symbol, strategies]) => {
      const strategyData: any = {};
      
      for (const [strategy, data] of strategies.entries()) {
        strategyData[strategy] = {
          trades: data.trades,
          winRate: data.trades > 0 ? data.wins / data.trades : 0,
          pnl: data.pnl,
          avgPnl: data.trades > 0 ? data.pnl / data.trades : 0,
        };
      }
      
      return {
        symbol,
        strategies: strategyData,
      };
    });
    
    res.json({ period: days, heatmap });
  } catch (error) {
    logger.error('Error generating heatmap', { error });
    res.status(500).json({ error: 'Failed to generate heatmap' });
  }
});

/**
 * GET /api/strategy-performance/report
 * 
 * Génère un rapport texte complet
 */
router.get('/report', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const report = await generateStrategyReport(days);
    
    res.type('text/plain').send(report);
  } catch (error) {
    logger.error('Error generating report', { error });
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

/**
 * Helper: Calculate profit factor
 */
function calculateProfitFactor(stats: any): number {
  if (!stats.totalTrades) return 0;
  
  const winningPnl = stats.totalWins > 0 ? (stats.totalPnlUsd / stats.totalTrades) * stats.totalWins : 0;
  const losingPnl = Math.abs((stats.totalTrades - stats.totalWins) > 0 
    ? (stats.totalPnlUsd / stats.totalTrades) * (stats.totalTrades - stats.totalWins) 
    : 0);
  
  return losingPnl > 0 ? winningPnl / losingPnl : winningPnl > 0 ? 999 : 0;
}
