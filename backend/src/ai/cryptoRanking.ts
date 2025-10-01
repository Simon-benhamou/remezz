// backend/src/ai/cryptoRanking.ts
/**
 * AI-POWERED CRYPTO RANKING SYSTEM
 * Pipeline en 2 étapes:
 * 1. Filtrage par volume → Top 50 cryptos liquides
 * 2. Analyse IA → Classement par opportunité 24h
 */

import { getTicker } from '../data/market.js';
import { buildTechSnapshot } from './tech.js';
import { llmJSON } from './llm.js';
import { getConfig } from '../utils/env.js';
import ccxt from 'ccxt';

// Cache pour éviter de rescanner trop souvent (30 min)
const RANKING_CACHE = new Map<string, { ts: number; data: RankedOpportunity[] }>();
const RANKING_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export interface RankedOpportunity {
  symbol: string;
  rank: number;
  score: number; // 0-1 (AI confidence)
  volumeUsd24h: number;
  change24h: number;
  technical: {
    rsi: number;
    adx: number;
    atrPct: number;
    trend: 'bullish' | 'bearish' | 'neutral';
    ema20: number;
    ema50: number;
  };
  opportunity: {
    type: 'breakout' | 'reversal' | 'trend' | 'momentum' | 'range';
    direction: 'long' | 'short' | 'neutral';
    timeframe: '24h';
    confidence: number;
  };
  aiReasoning: string[];
}

export interface VolumeFilteredCrypto {
  symbol: string;
  volumeUsd24h: number;
  change24h: number;
  price: number;
  volumeRank: number;
}

/**
 * ÉTAPE 1: Filtrage par volume
 * Récupère les top 50 cryptos par volume 24h en USD
 */
export async function getTop50CryptosByVolume(excludeSessionId?: string): Promise<VolumeFilteredCrypto[]> {
  try {
    console.log('📊 ÉTAPE 1: Filtrage par volume des perpetuals...');
    
    const { EXCHANGE_ID } = getConfig();
    const ExchangeClass = (ccxt as any)[EXCHANGE_ID];
    
    if (!ExchangeClass) {
      throw new Error(`Exchange ${EXCHANGE_ID} not supported`);
    }

    const exchange = new ExchangeClass({
      enableRateLimit: true,
      options: { defaultType: 'swap' }
    });

    await exchange.loadMarkets();
    
    // Get all USD-settled perpetual markets
    const allMarkets = Object.keys(exchange.markets || {});
    const perpetualMarkets = allMarkets.filter(symbol => {
      try {
        const market = exchange.markets[symbol];
        return market?.swap === true && 
               market?.active === true &&
               market?.settle === 'USD' &&
               symbol.includes('/USD:USD');
      } catch {
        return false;
      }
    });
    
    console.log(`📊 Found ${perpetualMarkets.length} perpetual markets`);
    
    if (perpetualMarkets.length === 0) {
      throw new Error('No perpetual markets found');
    }

    // Fetch ALL tickers to get real volumes
    const volumeData: Array<{
      symbol: string;
      volumeUsd: number;
      change24h: number;
      price: number;
    }> = [];
    
    console.log(`📊 Fetching tickers for volume filtering...`);
    
    // Batch fetch tickers (faster)
    const batchSize = 50;
    for (let i = 0; i < Math.min(perpetualMarkets.length, 200); i += batchSize) {
      const batch = perpetualMarkets.slice(i, i + batchSize);
      const promises = batch.map(async (symbol) => {
        try {
          const ticker = await exchange.fetchTicker(symbol);
          const volumeUsd = Number(ticker.quoteVolume || 0);
          const currentPrice = Number(ticker.last || ticker.close || 0);
          const openPrice = Number(ticker.open || currentPrice);
          const realChange24h = openPrice > 0 ? ((currentPrice - openPrice) / openPrice) * 100 : 0;
          
          return {
            symbol,
            volumeUsd,
            change24h: realChange24h,
            price: currentPrice
          };
        } catch {
          return null;
        }
      });
      
      const results = await Promise.all(promises);
      volumeData.push(...results.filter(r => r !== null) as any[]);
      
      console.log(`📊 Progress: ${Math.min(i + batchSize, perpetualMarkets.length)}/${Math.min(perpetualMarkets.length, 200)}`);
    }
    
    // Filter by minimum volume ($100K USD)
    const MIN_VOLUME_USD = 100_000;
    const qualified = volumeData.filter(crypto => {
      if (crypto.volumeUsd < MIN_VOLUME_USD) {
        return false;
      }
      
      // Additional safety filters
      if (crypto.price <= 0) return false;
      
      // Sub-penny tokens need higher volume
      if (crypto.price < 0.01 && crypto.volumeUsd < 2_000_000) return false;
      
      return true;
    });
    
    console.log(`📊 After volume filter: ${qualified.length} cryptos (>$${MIN_VOLUME_USD/1000}K volume)`);
    
    // Sort by volume DESC and take top 50
    qualified.sort((a, b) => b.volumeUsd - a.volumeUsd);
    const top50 = qualified.slice(0, 50);
    
    console.log(`✅ Top 50 cryptos by volume:`);
    top50.slice(0, 10).forEach((crypto, i) => {
      const base = crypto.symbol.split('/')[0];
      console.log(`   ${i+1}. ${base}: $${(crypto.volumeUsd/1_000_000).toFixed(2)}M vol, ${crypto.change24h > 0 ? '+' : ''}${crypto.change24h.toFixed(2)}%`);
    });
    
    // Convert to spot format (SYMBOL/USDT) and add rank
    const result: VolumeFilteredCrypto[] = top50.map((crypto, index) => {
      const base = crypto.symbol.split('/')[0];
      return {
        symbol: `${base}/USDT`,
        volumeUsd24h: crypto.volumeUsd,
        change24h: crypto.change24h,
        price: crypto.price,
        volumeRank: index + 1
      };
    });
    
    return result;
    
  } catch (error) {
    console.error('❌ Error filtering cryptos by volume:', error);
    throw error;
  }
}

/**
 * ÉTAPE 2: Analyse IA des top 50
 * L'IA reçoit les données techniques et classe par opportunité 24h
 */
export async function rankCryptosWithAI(
  top50: VolumeFilteredCrypto[],
  opts?: { useCache?: boolean; forceRefresh?: boolean }
): Promise<RankedOpportunity[]> {
  try {
    console.log('🤖 ÉTAPE 2: Analyse IA des top 50 cryptos...');
    
    // Check cache
    const cacheKey = 'ai_ranking';
    if (opts?.useCache !== false && !opts?.forceRefresh) {
      const cached = RANKING_CACHE.get(cacheKey);
      if (cached && Date.now() - cached.ts < RANKING_CACHE_TTL) {
        console.log('💾 Using cached AI ranking');
        return cached.data;
      }
    }
    
    // Build technical snapshots for all 50 cryptos
    console.log('📊 Building technical snapshots...');
    const snapshots = await Promise.all(
      top50.map(async (crypto) => {
        try {
          const snap = await buildTechSnapshot(crypto.symbol);
          return {
            symbol: crypto.symbol,
            volumeUsd24h: crypto.volumeUsd24h,
            change24h: crypto.change24h,
            price: crypto.price,
            volumeRank: crypto.volumeRank,
            technical: {
              rsi: snap.rsi14,
              adx: snap.adx14,
              atrPct: snap.atrPct,
              ema20: snap.ema20,
              ema50: snap.ema50,
              trend: snap.ema20 > snap.ema50 ? (snap.ema20 - snap.ema50) / snap.ema50 * 100 : 0,
              srBias: snap.srBias,
              volume: snap.volume || 0,
              volumeMA: snap.volumeMA || 0
            }
          };
        } catch (error) {
          console.warn(`⚠️ Failed to build snapshot for ${crypto.symbol}:`, error);
          return null;
        }
      })
    );
    
    const validSnapshots = snapshots.filter(s => s !== null);
    console.log(`✅ Built ${validSnapshots.length} technical snapshots`);
    
    // Prepare data for AI prompt
    const aiInput = validSnapshots.map(s => ({
      symbol: s!.symbol,
      volumeRank: s!.volumeRank,
      volumeUsd24h: Math.round(s!.volumeUsd24h),
      change24h: Number(s!.change24h.toFixed(2)),
      rsi: Number(s!.technical.rsi.toFixed(1)),
      adx: Number(s!.technical.adx.toFixed(1)),
      atrPct: Number(s!.technical.atrPct.toFixed(2)),
      ema20: Number(s!.technical.ema20.toFixed(2)),
      ema50: Number(s!.technical.ema50.toFixed(2)),
      trendPct: Number(s!.technical.trend.toFixed(2)),
      srBias: s!.technical.srBias,
      volumeRatio: s!.technical.volumeMA > 0 ? Number((s!.technical.volume / s!.technical.volumeMA).toFixed(2)) : 0
    }));
    
    // AI Prompt for ranking
    const prompt = `You are a crypto trading expert analyzing the top 50 cryptos by volume for the BEST opportunities in the next 24 hours.

TASK: Rank these cryptos from BEST to WORST trading opportunity for the next 24h, considering:
1. **Volume Quality**: Current volume vs MA (volumeRatio ≥ 0.8 is good)
2. **Momentum**: Strong 24h change (>2% or <-2%) with RSI confirmation
3. **Trend Strength**: ADX > 20 indicates strong trend
4. **Volatility**: ATR% 0.5-2% is optimal (enough movement, not too risky)
5. **Technical Setup**: Near support/resistance, RSI extremes (30-80 range)

CRYPTOS DATA (Top 50 by volume):
${JSON.stringify(aiInput, null, 2)}

RESPOND WITH STRICT JSON (array of top 20 opportunities):
{
  "opportunities": [
    {
      "symbol": "ETH/USDT",
      "score": 0.85,
      "type": "breakout|reversal|trend|momentum|range",
      "direction": "long|short|neutral",
      "confidence": 0.85,
      "reasons": [
        "High volume ratio 1.2x MA confirms interest",
        "Strong uptrend with ADX 35",
        "RSI 65 - room for continuation"
      ]
    }
  ]
}

IMPORTANT:
- Return TOP 20 opportunities only (best score first)
- Score 0-1 (higher = better opportunity)
- Confidence 0-1 (higher = more certain)
- Reasons must be specific and data-driven
- Reject low volume ratio (<0.5) or extreme RSI (>80 or <20) unless reversal setup`;

    console.log('🤖 Sending to AI for ranking...');
    
    const aiResponse = await llmJSON(prompt, {
      cacheKey: 'crypto_ranking_24h',
      ttlMin: 30, // Cache 30 minutes
      provider: 'grok', // Use Grok for better analysis
      context: { kind: 'crypto_ranking' }
    });
    
    const parsed = JSON.parse(aiResponse);
    const aiOpportunities = parsed.opportunities || [];
    
    console.log(`🤖 AI returned ${aiOpportunities.length} ranked opportunities`);
    
    // Map AI results to our format
    const ranked: RankedOpportunity[] = aiOpportunities.map((opp: any, index: number) => {
      const snapshot = validSnapshots.find(s => s?.symbol === opp.symbol);
      
      if (!snapshot) {
        return null;
      }
      
      return {
        symbol: opp.symbol,
        rank: index + 1,
        score: Number(opp.score || 0),
        volumeUsd24h: snapshot.volumeUsd24h,
        change24h: snapshot.change24h,
        technical: {
          rsi: snapshot.technical.rsi,
          adx: snapshot.technical.adx,
          atrPct: snapshot.technical.atrPct,
          trend: snapshot.technical.ema20 > snapshot.technical.ema50 ? 'bullish' : 
                 snapshot.technical.ema20 < snapshot.technical.ema50 ? 'bearish' : 'neutral',
          ema20: snapshot.technical.ema20,
          ema50: snapshot.technical.ema50
        },
        opportunity: {
          type: opp.type || 'momentum',
          direction: opp.direction || 'neutral',
          timeframe: '24h',
          confidence: Number(opp.confidence || 0)
        },
        aiReasoning: opp.reasons || []
      };
    }).filter(r => r !== null) as RankedOpportunity[];
    
    // Cache the results
    RANKING_CACHE.set(cacheKey, { ts: Date.now(), data: ranked });
    
    console.log('✅ AI Ranking complete. Top 5:');
    ranked.slice(0, 5).forEach(r => {
      console.log(`   ${r.rank}. ${r.symbol}: Score ${r.score.toFixed(2)}, ${r.opportunity.direction} ${r.opportunity.type}`);
      console.log(`      Reasoning: ${r.aiReasoning[0]}`);
    });
    
    return ranked;
    
  } catch (error) {
    console.error('❌ Error ranking cryptos with AI:', error);
    throw error;
  }
}

/**
 * FONCTION PRINCIPALE: Pipeline complet
 * 1. Filtre par volume → Top 50
 * 2. Analyse IA → Ranking par opportunité 24h
 */
export async function getAIRankedOpportunities(
  opts?: { useCache?: boolean; forceRefresh?: boolean; excludeSessionId?: string }
): Promise<RankedOpportunity[]> {
  try {
    console.log('🚀 Starting AI-powered crypto ranking pipeline...');
    
    // ÉTAPE 1: Filtrage volume
    const top50 = await getTop50CryptosByVolume(opts?.excludeSessionId);
    
    if (top50.length === 0) {
      throw new Error('No cryptos passed volume filter');
    }
    
    // ÉTAPE 2: Analyse IA
    const ranked = await rankCryptosWithAI(top50, opts);
    
    if (ranked.length === 0) {
      throw new Error('AI returned no opportunities');
    }
    
    console.log(`✅ Pipeline complete: ${ranked.length} opportunities ranked`);
    
    return ranked;
    
  } catch (error) {
    console.error('❌ Error in AI ranking pipeline:', error);
    throw error;
  }
}

/**
 * Get best opportunity from AI ranking (for auto-select agents)
 */
export async function getBestAIOpportunity(excludeSessionId?: string): Promise<RankedOpportunity | null> {
  try {
    const ranked = await getAIRankedOpportunities({ 
      useCache: true, 
      excludeSessionId 
    });
    
    if (ranked.length === 0) {
      return null;
    }
    
    // Return top ranked with score > 0.6
    const best = ranked[0];
    if (best.score < 0.6) {
      console.log(`⚠️ Best opportunity score too low: ${best.score.toFixed(2)}`);
      return null;
    }
    
    console.log(`🏆 Best AI opportunity: ${best.symbol} (Score: ${best.score.toFixed(2)})`);
    return best;
    
  } catch (error) {
    console.error('Error getting best AI opportunity:', error);
    return null;
  }
}
