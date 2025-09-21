import { Router } from 'express';
import { z } from 'zod';

const router = Router();

// Schema pour les options de scan
const scanOptionsSchema = z.object({
  timeframe: z.enum(['1h', '4h', '24h']).optional().default('24h'),
  minVolume: z.number().optional().default(1000000), // Volume minimum en USD
  maxSymbols: z.number().optional().default(20),
  sortBy: z.enum(['volume', 'change', 'momentum']).optional().default('momentum'),
  includeAnalysis: z.boolean().optional().default(true)
});

interface CryptoOpportunity {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  momentum: number; // Score composite
  volatility: number;
  trend: string;
  signals: string[];
  rank: number;
  analysis?: any;
}

// Cryptos populaires avec bon volume sur les exchanges majeurs
const POPULAR_PERPETUALS = [
  'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT', 'AVAX/USDT',
  'BNB/USDT', 'DOGE/USDT', 'MATIC/USDT', 'DOT/USDT', 'LINK/USDT', 'UNI/USDT',
  'LTC/USDT', 'BCH/USDT', 'ATOM/USDT', 'FIL/USDT', 'TRX/USDT', 'ETC/USDT',
  'NEAR/USDT', 'APT/USDT', 'ARB/USDT', 'OP/USDT', 'SUI/USDT', 'SEI/USDT',
  'WLD/USDT', 'INJ/USDT', 'TIA/USDT', 'ORDI/USDT', 'STX/USDT', 'JUP/USDT'
];

// POST /api/scanner/opportunities
router.post('/opportunities', async (req, res) => {
  try {
    const options = scanOptionsSchema.parse(req.body);
    console.log('[SCANNER] Scanning for trading opportunities...');
    
    const opportunities: CryptoOpportunity[] = [];
    
    // Utiliser notre API batch existante pour analyser tous les symboles
    const batchResponse = await fetch(`${process.env.BACKEND_URL || 'http://localhost:4000'}/api/batch/trading-diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbols: POPULAR_PERPETUALS.slice(0, options.maxSymbols),
        includeStrategy: options.includeAnalysis,
        includeSentiment: false,
        includeNews: false,
        forceRefresh: false
      })
    });
    
    if (!batchResponse.ok) {
      throw new Error('Failed to fetch batch analysis');
    }
    
    const batchData = await batchResponse.json();
    
    if (batchData.success) {
      // Calculer le score de momentum pour chaque crypto
      batchData.data.forEach((signal: any, index: number) => {
        if (!signal.error && signal.price > 0) {
          // Score composite basé sur plusieurs facteurs
          const volumeScore = Math.min(signal.volume24h / 10000000, 10); // Volume score (max 10)
          const changeScore = Math.min(Math.abs(signal.change24h) / 5, 10); // Change score (max 10)
          const strengthScore = signal.strength / 10; // Strength score (max 10)
          
          const momentum = (volumeScore * 0.4 + changeScore * 0.4 + strengthScore * 0.2);
          
          const opportunity: CryptoOpportunity = {
            symbol: signal.symbol,
            price: signal.price,
            change24h: signal.change24h,
            volume24h: signal.volume24h,
            momentum: Math.round(momentum * 100) / 100,
            volatility: signal.atr || 0,
            trend: signal.change24h > 2 ? 'bullish' : signal.change24h < -2 ? 'bearish' : 'neutral',
            signals: signal.triggers || [],
            rank: index + 1,
            analysis: options.includeAnalysis ? signal : undefined
          };
          
          // Filtrer par volume minimum
          if (signal.volume24h >= options.minVolume) {
            opportunities.push(opportunity);
          }
        }
      });
    }
    
    // Trier selon les critères demandés
    opportunities.sort((a, b) => {
      switch (options.sortBy) {
        case 'volume':
          return b.volume24h - a.volume24h;
        case 'change':
          return Math.abs(b.change24h) - Math.abs(a.change24h);
        case 'momentum':
        default:
          return b.momentum - a.momentum;
      }
    });
    
    // Réattribuer les rangs après tri
    opportunities.forEach((opp, index) => {
      opp.rank = index + 1;
    });
    
    console.log(`[SCANNER] Found ${opportunities.length} opportunities`);
    
    // Sélectionner les top 3 pour recommandation
    const topOpportunities = opportunities.slice(0, 3);
    const recommendation = topOpportunities.length > 0 ? {
      symbol: topOpportunities[0].symbol,
      reason: `Highest momentum (${topOpportunities[0].momentum}) with ${topOpportunities[0].change24h.toFixed(2)}% change and $${(topOpportunities[0].volume24h / 1000000).toFixed(1)}M volume`,
      alternatives: topOpportunities.slice(1).map(opp => ({
        symbol: opp.symbol,
        reason: `Momentum ${opp.momentum}, Change ${opp.change24h.toFixed(2)}%`
      }))
    } : null;
    
    res.json({
      success: true,
      data: {
        opportunities,
        recommendation,
        metadata: {
          scannedSymbols: POPULAR_PERPETUALS.slice(0, options.maxSymbols).length,
          qualifiedOpportunities: opportunities.length,
          criteria: options,
          scanTime: new Date().toISOString()
        }
      }
    });
    
  } catch (error: any) {
    console.error('[SCANNER] Error scanning opportunities:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'SCANNER_ERROR'
    });
  }
});

// GET /api/scanner/top-movers - Version simplifiée pour un aperçu rapide
router.get('/top-movers', async (req, res) => {
  try {
    // Réutiliser l'endpoint opportunities avec des paramètres par défaut
    const scanResult = await fetch(`${req.protocol}://${req.get('host')}/api/scanner/opportunities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeframe: '24h',
        maxSymbols: 10,
        sortBy: 'momentum',
        includeAnalysis: false
      })
    });
    
    const data = await scanResult.json();
    
    if (data.success) {
      const topMovers = data.data.opportunities.slice(0, 5).map((opp: CryptoOpportunity) => ({
        symbol: opp.symbol,
        change24h: opp.change24h,
        volume24h: opp.volume24h,
        momentum: opp.momentum,
        trend: opp.trend
      }));
      
      res.json({
        success: true,
        data: topMovers,
        timestamp: new Date().toISOString()
      });
    } else {
      throw new Error(data.error);
    }
    
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export { router as scannerRouter };