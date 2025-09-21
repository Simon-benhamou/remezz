import { Router } from 'express';
import { z } from 'zod';
import { requireLiveApiKeys } from '../middleware/requireApiKeys.js';
import { fullAnalysis } from '../ai/analysis.js';
import { getTicker } from '../data/market.js';

const router = Router();

// Schema pour la requête batch
const batchAnalysisSchema = z.object({
  symbols: z.array(z.string()).min(1).max(20), // Maximum 20 symboles pour éviter les timeouts
  includeStrategy: z.boolean().optional().default(false),
  includeSentiment: z.boolean().optional().default(false),
  includeNews: z.boolean().optional().default(false),
  forceRefresh: z.boolean().optional().default(false)
});

interface CryptoSignal {
  symbol: string;
  signal: 'bullish' | 'bearish' | 'strong_buy' | 'strong_sell' | 'neutral' | 'caution';
  strength: number; // 0-100
  triggers: string[];
  price: number;
  change24h: number;
  volume24h: number;
  atr: number;
  rsi: number;
  trend: number;
  lastUpdated: string;
  error?: string;
}

// POST /api/batch/trading-diagnostics
router.post('/trading-diagnostics', async (req, res) => {
  const startTime = Date.now();
  try {
    const { symbols, includeStrategy, includeSentiment, includeNews, forceRefresh } = batchAnalysisSchema.parse(req.body);
    
    console.log(`[BATCH] Analyzing ${symbols.length} symbols: ${symbols.join(', ')}`);
    
    const results: CryptoSignal[] = [];
    const errors: string[] = [];
    let totalApiCalls = 0;
    
    // Traiter tous les symboles en parallèle avec un délai pour éviter de surcharger les APIs
    const analysisPromises = symbols.map(async (symbol, index) => {
      // Petit délai progressif pour étaler les requêtes
      await new Promise(resolve => setTimeout(resolve, index * 100));
      
      try {
        console.log(`[BATCH] Processing ${symbol}...`);
        
        // Récupérer les données de base (ticker + analyse technique)
        const [tickerData, analysisData] = await Promise.allSettled([
          getTicker(symbol),
          fullAnalysis(symbol)
        ]);
        
        let price = 0;
        let change24h = 0;
        let volume24h = 0;
        
        if (tickerData.status === 'fulfilled' && tickerData.value) {
          const ticker = tickerData.value;
          price = ticker.last || ticker.price || 0;
          change24h = ticker.percentage || 0;
          volume24h = ticker.baseVolume || 0;
        }
        
        let technical: any = {};
        let strategy: any = null;
        
        if (analysisData.status === 'fulfilled' && analysisData.value) {
          const analysis = analysisData.value;
          technical = analysis.technical || {};
          
          // Compter les appels API si disponible (estimation)
          totalApiCalls += 1; // Estimation pour l'analyse technique
        }
        
        // Déterminer le signal basé sur l'analyse technique
        let signal: CryptoSignal['signal'] = 'neutral';
        let strength = 0;
        
        if (technical.ema20 && technical.ema50 && technical.last) {
          // Calculer le signal basé sur les EMAs et le prix
          const emaSpread = (technical.ema20 - technical.ema50) / technical.ema50;
          const priceVsEma = (technical.last - technical.ema20) / technical.ema20;
          
          const trendValue = emaSpread + priceVsEma;
          strength = Math.min(Math.abs(trendValue) * 100, 100);
          
          if (trendValue > 0.05) signal = 'bullish';
          else if (trendValue > 0.1) signal = 'strong_buy';
          else if (trendValue < -0.05) signal = 'bearish';
          else if (trendValue < -0.1) signal = 'strong_sell';
          else signal = 'neutral';
        }
        
        // Générer les triggers d'analyse
        const triggers: string[] = [];
        
        if (technical.atr14) {
          const atrPct = (technical.atr14 / technical.last) * 100;
          if (atrPct > 2) {
            triggers.push('High volatility');
          } else if (atrPct < 0.5) {
            triggers.push('Low volatility');
          } else {
            triggers.push('Normal volatility');
          }
        }
        
        if (technical.rsi14) {
          if (technical.rsi14 > 70) {
            triggers.push('Overbought (RSI)');
          } else if (technical.rsi14 < 30) {
            triggers.push('Oversold (RSI)');
          } else {
            triggers.push('Neutral RSI');
          }
        }
        
        if (technical.ema20 && technical.ema50) {
          if (technical.ema20 > technical.ema50) {
            triggers.push('Bullish EMA cross');
          } else {
            triggers.push('Bearish EMA cross');
          }
        }
        
        if (volume24h > 1000000) {
          triggers.push(`Volume: ${(volume24h / 1000000).toFixed(1)}M`);
        }
        
        const cryptoSignal: CryptoSignal = {
          symbol,
          signal,
          strength: Math.round(strength),
          triggers: triggers.slice(0, 4), // Limiter à 4 triggers
          price: price || technical.last || 0,
          change24h: change24h || 0,
          volume24h,
          atr: technical.atr14 || 0,
          rsi: technical.rsi14 || 50,
          trend: technical.ema20 && technical.ema50 ? (technical.ema20 - technical.ema50) / technical.ema50 : 0,
          lastUpdated: new Date().toISOString()
        };
        
        return cryptoSignal;
        
      } catch (error: any) {
        console.error(`[BATCH] Error processing ${symbol}:`, error.message);
        errors.push(`${symbol}: ${error.message}`);
        
        // Retourner un signal par défaut en cas d'erreur
        return {
          symbol,
          signal: 'neutral' as const,
          strength: 0,
          triggers: ['Analysis failed'],
          price: 0,
          change24h: 0,
          volume24h: 0,
          atr: 0,
          rsi: 50,
          trend: 0,
          lastUpdated: new Date().toISOString(),
          error: error.message
        };
      }
    });
    
    // Attendre que toutes les analyses soient terminées
    const analysisResults = await Promise.all(analysisPromises);
    results.push(...analysisResults);
    
    // Trier par force du signal (plus forts en premier)
    const sortedResults = results.sort((a, b) => b.strength - a.strength);
    
    console.log(`[BATCH] Completed analysis for ${symbols.length} symbols. API calls used: ${totalApiCalls}`);
    
    res.json({
      success: true,
      data: sortedResults,
      metadata: {
        totalSymbols: symbols.length,
        successCount: results.filter(r => !r.error).length,
        errorCount: errors.length,
        errors: errors.length > 0 ? errors : undefined,
        apiCallsUsed: totalApiCalls,
        timestamp: new Date().toISOString(),
        processingTimeMs: Date.now() - startTime
      }
    });
    
  } catch (error: any) {
    console.error('[BATCH] Batch analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'BATCH_ANALYSIS_ERROR'
    });
  }
});

export { router as batchRouter };