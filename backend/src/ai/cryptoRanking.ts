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
import { getAllTickersFromWebSocket, adaptBinanceTickerToCcxt, toBinanceSymbolId } from '../services/binanceWebSocket.js';
import type { BinanceTickerData } from '../services/binanceWebSocket.js';

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

// Lightweight entry readiness using 15m snapshot only (no agent state)
function entryReadinessLite(snap: any) {
  try {
    const ema20 = Number(snap.ema20 || 0);
    const ema50 = Number(snap.ema50 || 0);
    const adx = Number(snap.adx14 || 0);
    const atrPct = Number(snap.atrPct || 0);
    const cmf20 = Number(snap.cmf20 || 0);
    const volumeRatio = (Number(snap.volumeMA || 0) > 0) ? (Number(snap.volume || 0) / Number(snap.volumeMA || 1)) : 0;
    const srBias = String(snap.srBias || 'neutral');

    // Direction guess: EMA alignment, fallbacks to srBias and CMF
    let direction: 'long' | 'short' | 'none' = 'none';
    if (ema20 > ema50) direction = 'long'; else if (ema20 < ema50) direction = 'short';
    if (direction === 'none') {
      if (srBias === 'nearSupport' && cmf20 > 0) direction = 'long';
      else if (srBias === 'nearResistance' && cmf20 < 0) direction = 'short';
    }

    // Score: normalize 0..1 with simple weights
    const emaAligned = (direction === 'long' && ema20 > ema50) || (direction === 'short' && ema20 < ema50);
    const nearSR = (direction === 'long' && srBias === 'nearSupport') || (direction === 'short' && srBias === 'nearResistance');
    const cmfAligned = (direction === 'long' && cmf20 > 0.08) || (direction === 'short' && cmf20 < -0.08);
    const volOk = volumeRatio >= 0.55; // liquid enough
    const momentumOk = adx >= 12 && atrPct >= 0.2;

    const score = (
      (emaAligned ? 0.35 : 0) +
      (nearSR ? 0.20 : 0) +
      (cmfAligned ? 0.20 : 0) +
      (volOk ? 0.10 : 0) +
      (momentumOk ? 0.15 : 0)
    );

    return { score: Number(score.toFixed(2)), direction };
  } catch {
    return { score: 0, direction: 'none' as const };
  }
}

/**
 * ÉTAPE 1: Filtrage par volume
 * Récupère les top 50 cryptos par volume 24h en USD
 */
export async function getTop50CryptosByVolume(excludeSessionId?: string): Promise<VolumeFilteredCrypto[]> {
  try {
    console.log('📊 ÉTAPE 1: Filtrage par volume des perpetuals...');
    
    const { EXCHANGE_ID } = getConfig();
    const _isBinance = String(EXCHANGE_ID || '').toLowerCase().includes('binance');

    // Binance fast-path: avoid REST entirely, use WebSocket mini-tickers
    if (_isBinance) {
      try {
        const wsMap = await getAllTickersFromWebSocket();
        if (!wsMap || wsMap.size === 0) throw new Error('WebSocket tickers not ready');
        const volumeData: Array<{ symbol: string; volumeUsd: number; change24h: number; price: number }>= [];
        for (const t of wsMap.values()) {
          if (!t.symbol.endsWith('USDT')) continue; // keep USDT margined only
          const base = t.symbol.replace('USDT','');
          const unified = `${base}/USDT`;
          const volumeUsd = Number(t.quoteVolume || 0);
          const currentPrice = Number(t.last || 0);
          const openPrice = Number(t.open || currentPrice);
          const realChange24h = openPrice > 0 ? ((currentPrice - openPrice) / openPrice) * 100 : 0;
          if (currentPrice > 0) {
            volumeData.push({ symbol: unified, volumeUsd, change24h: realChange24h, price: currentPrice });
          }
        }
        const MIN_VOLUME_USD = 100_000;
        const qualified = volumeData.filter(x => x.volumeUsd >= MIN_VOLUME_USD);
        qualified.sort((a,b)=> b.volumeUsd - a.volumeUsd);
        const top50 = qualified.slice(0, 50);
        console.log(`✅ Binance WS volume filter: ${top50.length} symbols`);
        return top50.map((crypto, index) => ({
          symbol: crypto.symbol,
          volumeUsd24h: crypto.volumeUsd,
          change24h: crypto.change24h,
          price: crypto.price,
          volumeRank: index + 1
        }));
      } catch (error) {
        console.warn('⚠️ Binance WS volume scan failed, fallback to majors list:', error);
        const majors = ['BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT','XRP/USDT'];
        return majors.map((s, i) => ({ symbol: s, volumeUsd24h: 0, change24h: 0, price: 0, volumeRank: i+1 }));
      }
    }
    const ExchangeClass = (ccxt as any)[EXCHANGE_ID];
    
    if (!ExchangeClass) {
      throw new Error(`Exchange ${EXCHANGE_ID} not supported`);
    }

    const exchange = new ExchangeClass({
      enableRateLimit: true,
      options: { defaultType: 'swap' }
    });

    await exchange.loadMarkets();
    
    // Get all USDT-settled perpetual markets
    // Support both Binance-style "BTC/USDT" and colon notation "BTC/USDT:USDT"
    const allMarkets = Object.keys(exchange.markets || {});
    const perpetualMarkets = allMarkets.filter(symbol => {
      try {
        const market = exchange.markets[symbol];
        if (!market) return false;
        const isSwap = market.swap === true || market.type === 'swap' || market.perpetual === true;
        const isActive = market.active !== false;
        const isUsdtSettled = String(market.settle || market.quote || '').toUpperCase() === 'USDT';
        const symbolLooksUsdt = symbol.includes('/USDT') || symbol.includes('/USDT:USDT');
        return isSwap && isActive && isUsdtSettled && symbolLooksUsdt;
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

    const maxScan = Math.min(perpetualMarkets.length, 200);
    const scanSymbols = perpetualMarkets.slice(0, maxScan);
    const isBinanceExchange = String((exchange as any)?.id || '').toLowerCase().includes('binance');
    let wsTickerMap: Map<string, BinanceTickerData> | null = null;

    if (isBinanceExchange) {
      try {
        wsTickerMap = await getAllTickersFromWebSocket();
        if (!wsTickerMap) {
          console.warn('⚠️ Binance WebSocket tickers unavailable for ranking, using REST fallback.');
        }
      } catch (error) {
        console.warn('⚠️ Failed to load Binance WebSocket tickers for ranking:', error);
        wsTickerMap = null;
      }
    }

    const restCandidates: string[] = [];

    if (wsTickerMap) {
      for (const symbol of scanSymbols) {
        const wsSymbol = toBinanceSymbolId(symbol);
        const wsTicker = wsTickerMap.get(wsSymbol);
        if (!wsTicker) {
          restCandidates.push(symbol);
          continue;
        }
        const adapted = adaptBinanceTickerToCcxt(symbol, wsTicker);
        const volumeUsd = Number(adapted.quoteVolume || 0);
        const currentPrice = Number(adapted.last || adapted.close || 0);
        const openPrice = Number((adapted as any).open || currentPrice);
        const realChange24h = openPrice > 0 ? ((currentPrice - openPrice) / openPrice) * 100 : 0;
        volumeData.push({ symbol, volumeUsd, change24h: realChange24h, price: currentPrice });
      }
      if (restCandidates.length) {
        console.log(`⚠️ WebSocket missing ${restCandidates.length} symbols, falling back to REST.`);
      }
    } else {
      restCandidates.push(...scanSymbols);
    }

    // REST fallback for remaining symbols (or all if WS unavailable)
    if (restCandidates.length) {
      const batchSize = 50;
      for (let i = 0; i < restCandidates.length; i += batchSize) {
        const batch = restCandidates.slice(i, i + batchSize);
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

        console.log(`📊 REST progress: ${Math.min(i + batchSize, restCandidates.length)}/${restCandidates.length}`);
      }
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
              trend: snap.ema20 > snap.ema50 ? (snap.ema20 - snap.ema50) / snap.ema50 * 100 : (snap.ema20 < snap.ema50 ? (snap.ema20 - snap.ema50) / snap.ema50 * 100 : 0),
              srBias: snap.srBias,
              volume: snap.volume || 0,
              volumeMA: snap.volumeMA || 0,
              cmf20: snap.cmf20 ?? 0
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
    
    // Lightweight prefilter (liquidity + minimal momentum)
    let minimallyTradable = validSnapshots.filter(s => {
      const vma = Number(s!.technical.volumeMA || 0);
      const vr = vma > 0 ? Number((s!.technical.volume / vma)) : 0;
      const adx = Number(s!.technical.adx || 0);
      const atrPct = Number(s!.technical.atrPct || 0);
      return vr >= 0.5 && adx >= 12 && atrPct >= 0.2; // keep only minimally tradable
    });
    if (minimallyTradable.length === 0) {
      console.warn('⚠️ Prefilter removed all candidates; proceeding without prefilter to avoid empty ranking.');
      minimallyTradable = validSnapshots as any;
    }

    // Prepare data for AI prompt
    const aiInput = minimallyTradable.map(s => {
      const vr = s!.technical.volumeMA > 0 ? Number((s!.technical.volume / s!.technical.volumeMA)) : 0;
      const er = entryReadinessLite({
        ema20: s!.technical.ema20,
        ema50: s!.technical.ema50,
        adx14: s!.technical.adx,
        atrPct: s!.technical.atrPct,
        cmf20: s!.technical.cmf20,
        volume: s!.technical.volume,
        volumeMA: s!.technical.volumeMA,
        srBias: s!.technical.srBias
      });
      return {
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
        volumeRatio: Number(vr.toFixed(2)),
        cmf20: Number((s!.technical.cmf20||0).toFixed(3)),
        entryReadinessScore: er.score,
        entrySuggestedDirection: er.direction
      };
    });
    
    // AI Prompt for ranking - TIER-BASED with quality focus
    const prompt = `You are a PROFESSIONAL crypto trading selector. Your goal: return a ranked list of symbols that are LIQUID and NEAR ENTRY, balancing quality and opportunity.

🎯 CRITICAL: Prioritize QUALITY and REPUTATION over raw movement percentage.

📊 TIER SYSTEM (Quality-based classification):

**TIER 1 - BLUE CHIPS** (Highest priority):
- BTC, ETH, SOL
- Characteristics: >$500M daily volume, highest liquidity, lowest risk
- Accept movements: ≥0.3% (even small moves are significant)
- Score adjustment: +2.0 bonus

**TIER 2 - MAJOR ESTABLISHED** (High priority):
- XRP, BNB, ADA, DOGE, MATIC, TRX, LTC, DOT, SHIB, etc.
- Characteristics: >$50M daily volume, well-established, good liquidity
- Accept movements: ≥0.5%
- Score adjustment: +1.0 bonus

**TIER 3 - PROMISING ALTS** (Moderate priority):
- AVAX, LINK, UNI, NEAR, SUI, APT, ARB, OP, etc.
- Characteristics: >$10M daily volume, established projects, moderate risk
- Accept movements: ≥1.0%
- Score adjustment: +0.3 bonus

**TIER 4 - SMALL CAPS** (Lowest priority, high risk):
- Unknown or new projects
- Characteristics: <$10M volume, unproven, high risk
- Accept ONLY if: ≥3% movement AND exceptional technicals AND score >8.5
- Score adjustment: -1.0 penalty

🎯 RANKING CRITERIA (weighted by importance):

1. **Crypto Tier/Reputation** (40% weight) - MOST IMPORTANT
   - Tier 1 coins are ALWAYS better than Tier 4, regardless of movement
   - BTC at +0.5% >>> Unknown coin at +5%
   - Quality beats quantity

2. **Volume Quality** (25% weight)
   - volumeRatio ≥ 0.8 is good
   - Tier 1 requires >$500M/day
   - Tier 2 requires >$50M/day
   - Reject if volumeRatio < 0.6

3. **Technical Setup + Entry Readiness** (35% weight)
   - Trend confirmation (EMA alignment)
   - RSI in tradeable range (30-80)
   - ADX shows strength (>15 acceptable, >25 excellent)
   - EntryReadinessScore (0..1) and suggested direction must be considered heavily
   - CMF20 alignment with direction is a strong positive

4. **Momentum** (10% weight)
   - Tier 1: Accept ≥0.3% moves
   - Tier 2: Accept ≥0.5% moves
   - Tier 3: Accept ≥1.0% moves
   - Tier 4: Require ≥3.0% moves

📊 CRYPTOS DATA (Top candidates):
${JSON.stringify(aiInput, null, 2)}

RESPOND WITH STRICT JSON (array of top 20 opportunities):
{
  "opportunities": [
    {
      "symbol": "BTC/USDT",
      "score": 0.90,
      "type": "trend|breakout|reversal|momentum|range",
      "direction": "long|short|neutral",
      "confidence": 0.85,
      "reasons": [
        "Tier 1 Blue Chip - Highest quality asset",
        "Stable 0.8% move with $2B volume confirms solid demand",
        "Strong technical setup with ADX 28",
        "Low risk, high reliability"
      ]
    }
  ]
}

⚠️ CRITICAL RULES:
- BTC/ETH/SOL should ALWAYS rank in top 5 if they have ANY positive movement (>0.3%)
- Tier 4 coins should be AVOIDED unless truly exceptional (score >8.5 AND volume >$20M)
- Return TOP 20 opportunities ranked by QUALITY-ADJUSTED score
- Score formula: baseScore + tierBonus - riskPenalty
- Reasons must mention the TIER and why it matters
- Quality > Movement: "Tier 1 at +0.5%" beats "Tier 4 at +5%"`;

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
    
    // Return top ranked with score > 0.5 (relaxed from 0.6)
    const best = ranked[0];
    if (best.score < 0.5) {
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
