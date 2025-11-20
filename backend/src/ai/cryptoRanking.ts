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
import { getAllTickersFromWebSocket, adaptBinanceTickerToCcxt, toBinanceSymbolId, waitForWsHealthy } from '../services/binanceWebSocket.js';
import type { BinanceTickerData } from '../services/binanceWebSocket.js';
import { isInsufficientDataError, type InsufficientDataMeta } from '../data/errors.js';
import type { TechnicalSnapshot } from './tech.js';
import { evaluateStrategyCompatibility, filterByStrategyCompatibility, type StrategyCompatibility } from '../quantai/strategies/metaAdaptive/cryptoSelection.js';

// Cache pour éviter de rescanner trop souvent (30 min)
const RANKING_CACHE = new Map<string, { ts: number; data: RankedOpportunity[] }>();
const RANKING_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export function sanitizeBaseSymbol(rawBase: string): string | null {
  if (!rawBase) {
    return null;
  }
  const cleaned = rawBase.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (cleaned.length < 2) {
    return null;
  }
  if (!/[A-Z]/.test(cleaned)) {
    return null;
  }
  if (cleaned === 'USDT') {
    return null;
  }
  return cleaned;
}

function buildVolumeEntry(
  base: string,
  crypto: { volumeUsd: number; change24h: number; price: number },
  rank: number,
): VolumeFilteredCrypto | null {
  const sanitized = sanitizeBaseSymbol(base);
  if (!sanitized) {
    return null;
  }
  return {
    symbol: `${sanitized}/USDT`,
    volumeUsd24h: crypto.volumeUsd,
    change24h: crypto.change24h,
    price: crypto.price,
    volumeRank: rank,
  };
}

export interface RankedOpportunity {
  symbol: string;
  rank: number;
  score: number; // 0-1 (Combined: AI + Strategy Compatibility)
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
    timeframe: '4h';
    confidence: number;
  };
  aiReasoning: string[];
  strategyCompatibility?: StrategyCompatibility; // NEW: Strategy fit assessment
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
    let wsTop: VolumeFilteredCrypto[] | null = null;
    if (_isBinance) {
      try {
        // Stronger warm-up: wait up to 6s for !ticker@arr to fill
        await waitForWsHealthy(6000);
        let wsMap = await getAllTickersFromWebSocket();
        // Small warm-up wait for WS cache
        if (!wsMap || wsMap.size === 0) {
          for (let i = 0; i < 6; i++) { // up to ~3s
            await new Promise(r => setTimeout(r, 500));
            wsMap = await getAllTickersFromWebSocket();
            if (wsMap && wsMap.size > 0) break;
          }
        }
        if (!wsMap || wsMap.size === 0) throw new Error('WebSocket tickers not ready');
        const volumeData: Array<{ symbol: string; volumeUsd: number; change24h: number; price: number }> = [];
        const invalidSymbols: string[] = [];
        for (const t of wsMap.values()) {
          if (!t.symbol.endsWith('USDT')) continue; // keep USDT margined only
          const rawBase = t.symbol.slice(0, -4);
          const sanitized = sanitizeBaseSymbol(rawBase);
          if (!sanitized) {
            invalidSymbols.push(t.symbol);
            continue;
          }
          const volumeUsd = Number(t.quoteVolume || 0);
          const currentPrice = Number(t.last || 0);
          const openPrice = Number(t.open || currentPrice);
          const realChange24h = openPrice > 0 ? ((currentPrice - openPrice) / openPrice) * 100 : 0;
          if (currentPrice > 0) {
            volumeData.push({
              symbol: `${sanitized}/USDT`,
              volumeUsd,
              change24h: realChange24h,
              price: currentPrice,
            });
          }
        }
        if (invalidSymbols.length) {
          console.warn('⚠️ Skipping invalid Binance WS symbols', { symbols: invalidSymbols.slice(0, 10), total: invalidSymbols.length });
        }
        const MIN_VOLUME_USD = 100_000;
        const qualified = volumeData.filter(x => x.volumeUsd >= MIN_VOLUME_USD);
        qualified.sort((a,b)=> b.volumeUsd - a.volumeUsd);
        const top50 = qualified.slice(0, 50);
        console.log(`✅ Binance WS volume filter: ${top50.length} symbols`);
        wsTop = top50.map((crypto, index) => ({
          symbol: crypto.symbol,
          volumeUsd24h: crypto.volumeUsd,
          change24h: crypto.change24h,
          price: crypto.price,
          volumeRank: index + 1
        }));
      } catch (error) {
        console.warn('⚠️ Binance WS volume scan failed, falling back to REST discovery:', error);
      }
    }
    if (wsTop && wsTop.length) {
      return wsTop;
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
    const invalidSymbols: string[] = [];
    const result: VolumeFilteredCrypto[] = [];
    for (const crypto of top50) {
      const base = crypto.symbol.split('/')[0];
      const entry = buildVolumeEntry(base, crypto, result.length + 1);
      if (!entry) {
        invalidSymbols.push(crypto.symbol);
        continue;
      }
      result.push(entry);
    }

    if (invalidSymbols.length) {
      console.warn('⚠️ Dropping invalid perpetual symbols from volume filter', {
        symbols: invalidSymbols.slice(0, 10),
        total: invalidSymbols.length,
      });
    }

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
  opts?: { 
    useCache?: boolean; 
    forceRefresh?: boolean;
    excludeSessionId?: string;
    aggressiveness?: 'conservative' | 'reactive' | 'aggressive';
  }
): Promise<RankedOpportunity[]> {
  try {
    console.log('🤖 ÉTAPE 2: Analyse IA des top 50 cryptos...');
    
    // Check cache
    const rankingCacheKey = 'ai_ranking';
    if (opts?.useCache !== false && !opts?.forceRefresh) {
      const cached = RANKING_CACHE.get(rankingCacheKey);
      if (cached && Date.now() - cached.ts < RANKING_CACHE_TTL) {
        console.log('💾 Using cached AI ranking');
        return cached.data;
      }
    }
    
    // Build technical snapshots for all 50 cryptos
    console.log('📊 Building technical snapshots...');
    const zeroVolumeSymbols: Array<{ symbol: string; meta: InsufficientDataMeta }> = [];
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
            fullSnapshot: snap, // Store full snapshot for strategy compatibility
            multiTimeframe: snap.multiTimeframe ?? null,
            technical: {
              rsi: snap.rsi14,
              adx: snap.adx14,
              atrPct: snap.atrPct,
              ema20: snap.ema20,
              ema50: snap.ema50,
              ema100: snap.ema100 || snap.ema50,
              trend: snap.ema20 > snap.ema50 ? (snap.ema20 - snap.ema50) / snap.ema50 * 100 : (snap.ema20 < snap.ema50 ? (snap.ema20 - snap.ema50) / snap.ema50 * 100 : 0),
              srBias: snap.srBias,
              volume: snap.volume || 0,
              volumeMA: snap.volumeMA || 0,
              cmf20: snap.cmf20 ?? 0
            }
          };
        } catch (error) {
          if (isInsufficientDataError(error)) {
            const reason = error.meta.reason || 'insufficient_data';
            if (reason === 'zero_volume') {
              zeroVolumeSymbols.push({ symbol: crypto.symbol, meta: error.meta });
              console.warn(`⏳ ${crypto.symbol}: Snapshot skipped due to zero recent volume from primary feed. Triggering ticker fallback for confirmation.`, {
                timeframe: error.meta.timeframe,
                availableBars: error.meta.availableBars,
                warmup: error.meta.warmupState,
                details: error.meta.details,
              });
              try {
                const ticker = await getTicker(crypto.symbol);
                console.warn(`ℹ️ ${crypto.symbol}: REST ticker volume check after zero-volume anomaly`, {
                  quoteVolume: ticker?.quoteVolume,
                  baseVolume: (ticker as any)?.baseVolume,
                  info: (ticker as any)?.info?.volume || (ticker as any)?.info?.quoteVolume,
                });
              } catch (fallbackError) {
                console.warn(`⚠️ ${crypto.symbol}: Failed fallback ticker fetch after zero-volume anomaly`, fallbackError);
              }
              return null;
            }
            console.warn(`⚠️ ${crypto.symbol}: Snapshot skipped due to insufficient data (${reason}).`, {
              timeframe: error.meta.timeframe,
              availableBars: error.meta.availableBars,
              warmup: error.meta.warmupState,
            });
            return null;
          }
          console.warn(`⚠️ Failed to build snapshot for ${crypto.symbol}:`, error);
          return null;
        }
      })
    );

    const validSnapshots = snapshots.filter(s => s !== null);
    console.log(`✅ Built ${validSnapshots.length} technical snapshots`);

    // Skip predictor filtering - not relevant for selection, only for strategy
    // Use all valid snapshots directly
    const snapshotsToRank = validSnapshots;
    
    // Lightweight prefilter (liquidity + minimal momentum)
    let minimallyTradable = snapshotsToRank.filter(s => {
      const vma = Number(s!.technical.volumeMA || 0);
      const vr = vma > 0 ? Number((s!.technical.volume / vma)) : 0;
      const adx = Number(s!.technical.adx || 0);
      const atrPct = Number(s!.technical.atrPct || 0);
      return vr >= 0.5 && adx >= 12 && atrPct >= 0.2; // keep only minimally tradable
    });
    if (minimallyTradable.length === 0) {
      console.warn('⚠️ Prefilter removed all candidates; proceeding without prefilter to avoid empty ranking.');
      minimallyTradable = snapshotsToRank as any;
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
    
    // AI Prompt for ranking - TIER-BASED with HEAVY bias toward majors
    const prompt = `You are a PROFESSIONAL crypto trading selector. Your goal: return a ranked list of symbols that are LIQUID and NEAR ENTRY, HEAVILY FAVORING ESTABLISHED MAJORS.

🎯 CRITICAL PRIORITY RULES:
1. BTC/ETH/SOL should ALWAYS rank in top 5 if they have ANY reasonable setup
2. XRP/BNB/ADA/AVAX should rank in top 10 if conditions are acceptable
3. Unknown tier4 coins (PUMP, ALLO, MET, etc.) should be HEAVILY PENALIZED
4. Quality and reliability >>> raw movement percentage

📊 TIER SYSTEM (Quality-based classification):

**TIER 1 - BLUE CHIPS** (ALWAYS PRIORITIZE):
- BTC, ETH, SOL
- Characteristics: >$500M daily volume, highest liquidity, lowest risk
- Accept movements: ≥0.15% (even tiny moves are tradeable)
- Score adjustment: +3.0 MASSIVE bonus (basically guaranteed top 3)

**TIER 2 - MAJOR ESTABLISHED** (STRONG PREFERENCE):
- XRP, BNB, ADA, DOGE, MATIC, TRX, LTC, DOT, SHIB, AVAX, LINK, UNI, ATOM, etc.
- Characteristics: >$30M daily volume, well-established, good liquidity
- Accept movements: ≥0.25%
- Score adjustment: +1.5 strong bonus (target top 10)

**TIER 3 - PROMISING ALTS** (ACCEPTABLE):
- NEAR, SUI, APT, ARB, OP, AAVE, FET, ICP, HBAR, TAO, etc.
- Characteristics: >$5M daily volume, established projects, moderate risk
- Accept movements: ≥0.5%
- Score adjustment: +0.5 moderate bonus

**TIER 4 - SMALL CAPS** (AVOID UNLESS EXCEPTIONAL):
- Unknown/exotic coins (PUMP, ALLO, PIEVERSE, etc.)
- Characteristics: <$10M volume, high risk, low reliability
- Accept ONLY if: ≥1.5% movement AND excellent technicals (ADX >25, volumeRatio >1.2)
- Score adjustment: -2.0 PENALTY (push to bottom of list)

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
   - Tier 1: Accept ≥0.2% moves
   - Tier 2: Accept ≥0.3% moves
   - Tier 3: Accept ≥0.5% moves
   - Tier 4: Accept ≥0.8% moves

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
- Return AT LEAST 15-20 opportunities
- BTC/ETH/SOL MUST be in top 5 if they have ANY tradeable setup (even 0.2% move)
- XRP/BNB/ADA should be in top 10 if conditions are reasonable
- Tier 4 coins should rank BELOW 15th place unless EXCEPTIONAL (ADX >30, volumeRatio >1.5, movement >2%)
- Return TOP 20-25 opportunities ranked by QUALITY-FIRST approach
- Score formula: baseScore + MASSIVE_tierBonus (tier1=+3.0, tier2=+1.5, tier4=-2.0)
- Reasons must be concise (1-2 sentences max per reason)
- BIAS heavily toward tier1/tier2, tier4 is last resort only
- A tier1 with weak technicals >>> tier4 with strong technicals`;

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

      const mt = snapshot.multiTimeframe?.timeframes ?? {};
      const bias4h = String(mt['4h']?.bias ?? 'neutral');
      const bias1h = String(mt['1h']?.bias ?? 'neutral');
      
      // Pénalité légère pour conflits au lieu de rejet total
      // Les cryptos avec conflit restent éligibles mais avec score réduit
      const conflicting =
        (bias4h === 'bullish' && bias1h === 'bearish') ||
        (bias4h === 'bearish' && bias1h === 'bullish');
      
      const aligned = bias4h === 'neutral' || bias1h === 'neutral' || bias4h === bias1h;
      
      // Ajustement du score:
      // - Aligned: score complet
      // - Conflicting: -15% (garde la crypto mais avec pénalité)
      // - Autres: -10%
      let adjustedScore = Number(opp.score || 0);
      if (conflicting) {
        adjustedScore *= 0.85; // -15% pour conflit
        console.log(`⚠️ ${opp.symbol}: 4h(${bias4h}) vs 1h(${bias1h}) conflict - score reduced to ${adjustedScore.toFixed(2)}`);
      } else if (!aligned) {
        adjustedScore *= 0.90; // -10% pour non-alignement
      }
      
      const reasoning = Array.isArray(opp.reasons) ? [...opp.reasons] : [];
      if (conflicting) {
        reasoning.push(`⚠️ HTF conflict: 4h=${bias4h} vs 1h=${bias1h} - trade with caution`);
      } else if (!aligned) {
        reasoning.push(`Alignment caution: 4h=${bias4h}, 1h=${bias1h}`);
      } else {
        reasoning.push(`✅ HTF alignment confirmed: 4h=${bias4h}, 1h=${bias1h}`);
      }
      
      // 🎯 EVALUATE STRATEGY COMPATIBILITY
      // Check if this crypto will actually work with our meta-adaptive strategy
      const cryptoInfo: VolumeFilteredCrypto = {
        symbol: snapshot.symbol,
        volumeUsd24h: snapshot.volumeUsd24h,
        change24h: snapshot.change24h,
        price: snapshot.price,
        volumeRank: snapshot.volumeRank,
      };
      
      // Use full snapshot for compatibility check
      const techSnapshot: TechnicalSnapshot = (snapshot as any).fullSnapshot;
      const compatibility = evaluateStrategyCompatibility(cryptoInfo, techSnapshot);
      
      // Blend AI score with strategy compatibility (60% AI, 40% compatibility)
      const finalScore = adjustedScore * 0.60 + compatibility.score * 0.40;
      
      // Add compatibility insights to reasoning
      if (!compatibility.compatible) {
        reasoning.push(`⚠️ Strategy fit: ${compatibility.score.toFixed(2)} - ${compatibility.warnings[0] || 'suboptimal conditions'}`);
      } else if (compatibility.estimatedWinRate >= 0.55) {
        reasoning.push(`✅ Strategy fit: ${compatibility.score.toFixed(2)} (Est. WR: ${(compatibility.estimatedWinRate * 100).toFixed(0)}%)`);
      }

      return {
        symbol: opp.symbol,
        rank: index + 1,
        score: Number(finalScore.toFixed(3)),
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
          timeframe: '4h',
          confidence: Number(opp.confidence || 0)
        },
        aiReasoning: reasoning,
        strategyCompatibility: compatibility,
      };
    }).filter(r => r !== null) as RankedOpportunity[];
    
    // Re-sort after score adjustments (now includes strategy compatibility)
    ranked.sort((a, b) => b.score - a.score);
    
    // Update ranks after re-sort
    ranked.forEach((r, i) => r.rank = i + 1);
    
    // ÉTAPE 3A: Apply learning-based performance adjustment
    console.log('🧠 Applying learning-based performance adjustments...');
    const { prisma } = await import('../db/client.js');
    
    // Get historical symbol performance from decision memory (last 30 days)
    const symbolPerformance = new Map<string, { trades: number; winRate: number }>();
    
    for (const r of ranked) {
      try {
        const decisions = await prisma.decisionMemory.findMany({
          where: {
            symbol: r.symbol,
            createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
            outcome: { not: null }
          },
          select: { outcome: true }
        });
        
        if (decisions.length >= 5) {
          const wins = decisions.filter(d => d.outcome === 'win').length;
          const winRate = wins / decisions.length;
          symbolPerformance.set(r.symbol, { trades: decisions.length, winRate });
        }
      } catch (error) {
        // Skip symbols without history
        continue;
      }
    }
    
    ranked.forEach(r => {
      const perf = symbolPerformance.get(r.symbol);
      if (perf) {
        const oldScore = r.score;
        
        // Adjust based on win rate:
        // Win rate > 55%: +10% to +20% boost
        // Win rate 45-55%: neutral
        // Win rate < 45%: -10% to -25% penalty
        let learningMultiplier = 1.0;
        if (perf.winRate >= 0.55) {
          learningMultiplier = 1.10 + (perf.winRate - 0.55) * 0.5; // Up to +20%
        } else if (perf.winRate < 0.45) {
          learningMultiplier = 0.90 - (0.45 - perf.winRate) * 0.75; // Down to -25%
        }
        
        r.score = Number((r.score * learningMultiplier).toFixed(3));
        const change = ((learningMultiplier - 1) * 100).toFixed(0);
        console.log(`   ${r.symbol}: WR ${(perf.winRate * 100).toFixed(0)}% (${perf.trades} trades) → ${change > '0' ? '+' : ''}${change}% (${oldScore.toFixed(2)} → ${r.score.toFixed(2)})`);
      }
    });
    
    // ÉTAPE 3B: Apply diversity scoring - penalize over-represented symbols
    console.log('🎯 Applying portfolio diversity adjustments...');
    const { getSymbolUsageDistribution } = await import('../services/intelligentAgent/strategies/core.js');
    const usage = await getSymbolUsageDistribution(opts?.excludeSessionId);
    
    ranked.forEach(r => {
      const currentUsage = usage.get(r.symbol) || 0;
      if (currentUsage > 0) {
        // Penalize based on current usage:
        // 1 agent: -5%, 2 agents: -12%, 3+ agents: -20%
        const diversityPenalty = currentUsage === 1 ? 0.95 : 
                                currentUsage === 2 ? 0.88 : 0.80;
        const oldScore = r.score;
        r.score = Number((r.score * diversityPenalty).toFixed(3));
        console.log(`   ${r.symbol}: ${currentUsage} active agents → ${((1-diversityPenalty)*100).toFixed(0)}% penalty (${oldScore.toFixed(2)} → ${r.score.toFixed(2)})`);
      }
    });
    
    // Re-sort after diversity adjustments
    ranked.sort((a, b) => b.score - a.score);
    ranked.forEach((r, i) => r.rank = i + 1);
    
    // ÉTAPE 4: Apply aggressiveness filtering
    const aggressiveness = opts?.aggressiveness || 'reactive';
    console.log(`🎯 Applying ${aggressiveness} aggressiveness filter...`);
    const TIER_CONFIGS = {
      conservative: {
        minVolume: 100_000_000, // $100M+
        maxATR: 1.5,            // Cap volatility
        preferTiers: ['tier1', 'tier2'], // Only blue chips and majors
        description: 'Blue chips only (BTC, ETH, SOL, major established)'
      },
      reactive: {
        minVolume: 30_000_000,  // $30M+
        maxATR: 2.5,            // Moderate volatility
        preferTiers: ['tier1', 'tier2', 'tier3'], // Majors + promising alts
        description: 'Balanced: majors and quality alts'
      },
      aggressive: {
        minVolume: 5_000_000,   // $5M+
        maxATR: 5.0,            // High volatility OK
        preferTiers: ['tier1', 'tier2', 'tier3', 'tier4'], // All tiers
        description: 'All quality opportunities including small caps'
      }
    };
    
    const config = TIER_CONFIGS[aggressiveness];
    console.log(`   Filter: ${config.description}`);
    
    const filtered = ranked.filter(r => {
      const compat = r.strategyCompatibility;
      if (!compat) return true; // Keep if no compatibility data
      
      // Check volume threshold
      if (r.volumeUsd24h < config.minVolume) {
        console.log(`   ❌ ${r.symbol}: Volume $${(r.volumeUsd24h/1e6).toFixed(1)}M < $${(config.minVolume/1e6).toFixed(0)}M threshold`);
        return false;
      }
      
      // Check ATR threshold
      if (r.technical.atrPct > config.maxATR) {
        console.log(`   ❌ ${r.symbol}: ATR ${r.technical.atrPct.toFixed(2)}% > ${config.maxATR}% threshold`);
        return false;
      }
      
      // Check tier preference
      if (!config.preferTiers.includes(compat.tier)) {
        console.log(`   ❌ ${r.symbol}: Tier ${compat.tier} not in preferred tiers [${config.preferTiers.join(', ')}]`);
        return false;
      }
      
      return true;
    });
    
    console.log(`📊 After aggressiveness filter: ${filtered.length}/${ranked.length} opportunities`);
    
    // Update ranks
    filtered.forEach((r, i) => r.rank = i + 1);
    
    // Cache the results
    const cacheKey = `ai_ranking_${aggressiveness}_${opts?.excludeSessionId || 'all'}`;
    RANKING_CACHE.set(cacheKey, { ts: Date.now(), data: filtered });
    
    console.log('✅ AI Ranking complete with aggressiveness & diversity. Top 10:');
    filtered.slice(0, 10).forEach(r => {
      const compat = r.strategyCompatibility;
      console.log(`   ${r.rank}. ${r.symbol}:`);
      console.log(`      Score: ${r.score.toFixed(2)} (AI: ${(r.score / 0.60 * 0.6).toFixed(2)}, Strategy: ${compat?.score.toFixed(2)})`);
      console.log(`      ${r.opportunity.direction} ${r.opportunity.type}`);
      if (compat) {
        console.log(`      Fit: Vol:${compat.volatilityFit}, Liq:${compat.liquidityFit}, Trend:${compat.trendQuality} | Est.WR: ${(compat.estimatedWinRate * 100).toFixed(0)}%`);
      }
      console.log(`      ${r.aiReasoning[0]}`);
    });
    
    return filtered;
    
  } catch (error) {
    console.error('❌ Error ranking cryptos with AI:', error);
    throw error;
  }
}

/**
 * FONCTION PRINCIPALE: Pipeline complet
 * 1. Filtre par volume → Top 50
 * 2. Analyse IA → Ranking par opportunité 24h
 * 3. Apply aggressiveness filtering
 * 4. Apply diversity scoring
 */
export async function getAIRankedOpportunities(
  opts?: { 
    useCache?: boolean; 
    forceRefresh?: boolean; 
    excludeSessionId?: string;
    aggressiveness?: 'conservative' | 'reactive' | 'aggressive';
  }
): Promise<RankedOpportunity[]> {
  try {
    const aggressiveness = opts?.aggressiveness || 'reactive';
    console.log(`🚀 Starting AI-powered crypto ranking pipeline (aggressiveness: ${aggressiveness})...`);
    
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
