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
import { getPredictionSync, isPythonPredictorAvailable, type PythonPredictionResult } from '../quantai/pythonPredictor.js';
import { setCachedPrediction } from '../quantai/predictorCache.js';
import { recordPrediction, getStableSnapshot } from '../quantai/predictorStateStore.js';
import type { PredictorSnapshot } from '../quantai/predictorStateStore.js';
import type { TechnicalSnapshot } from './tech.js';

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
    timeframe: '4h';
    confidence: number;
  };
  aiReasoning: string[];
  predictor?: PredictorSnapshot;  // Stable predictor snapshot captured during ranking
}

export interface VolumeFilteredCrypto {
  symbol: string;
  volumeUsd24h: number;
  change24h: number;
  price: number;
  volumeRank: number;
}

/**
 * Build predictor features from technical snapshot (same logic as metaAdaptiveAgent)
 */
function buildPredictorFeatures(snap: TechnicalSnapshot): Record<string, number> | null {
  const safeNum = (val: any, fallback: number = Number.NaN) => {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  };
  
  const ema20 = safeNum(snap.ema20);
  const ema50 = safeNum(snap.ema50);
  const ema100 = safeNum(snap.ema100);
  const ema200 = safeNum(snap.ema200);
  const rsi14 = safeNum(snap.rsi14);
  const atr14 = safeNum(snap.atr14);
  const adx14 = safeNum(snap.adx14);
  const ema20Slope = safeNum((snap as any).ema20Slope, 0);
  const volume = safeNum((snap as any).volume);
  const volumeMA = safeNum((snap as any).volumeMA);
  const lastPrice = safeNum(snap.last);
  const atrPctPercent = safeNum(snap.atrPct);
  
  const trendSpreadFallback = Number.isFinite(ema50) && Math.abs(ema50) > 1e-9 ? (ema20 - ema50) / ema50 : 0;
  const emaTrendSpread = safeNum((snap as any).emaTrendSpread, trendSpreadFallback);
  const rsiSlope = safeNum((snap as any).rsiSlope, 0);
  const volumeZScore = safeNum((snap as any).volumeZScore, 0);
  const momentum3 = safeNum((snap as any).momentum3, 0);
  
  const atrPct = Number.isFinite(atr14) && Number.isFinite(lastPrice) && Math.abs(lastPrice) > 1e-9
    ? atr14 / lastPrice
    : Number.isFinite(atrPctPercent)
      ? atrPctPercent / 100
      : Number.NaN;
  
  if (!Number.isFinite(volume) || !Number.isFinite(volumeMA) || volumeMA <= 0) {
    return null;
  }
  
  return {
    ema20,
    ema50,
    ema100,
    ema200,
    rsi14,
    atr14,
    adx14,
    ema20Slope,
    volumeRatio: volume / volumeMA,
    emaTrendSpread,
    rsiSlope,
    atrPct,
    volumeZScore,
    momentum3,
  };
}

/**
 * Query XGBoost predictor for a crypto with snapshot
 */
async function getPredictorBias(
  symbol: string,
  snap: TechnicalSnapshot
): Promise<import('../quantai/pythonPredictor.js').PythonPredictionResult | null> {
  if (!isPythonPredictorAvailable()) {
    return null;
  }
  
  const features = buildPredictorFeatures(snap);
  if (!features) {
    return null;
  }
  
  try {
    // 🎯 RANKING ALWAYS FETCHES FRESH: This is the SOURCE OF TRUTH that initializes the cache
    console.log(`🔄 ${symbol}: Ranking fetching fresh predictor (will update cache)...`);
    const prediction = getPredictionSync(features);
    
    // Cache for 5 minutes with longer TTL for stability
    // Strategy/diagnostics will reuse THIS prediction from cache
    setCachedPrediction(symbol, prediction, features, 5 * 60 * 1000);

    recordPrediction({
      symbol,
      prediction,
      features,
      source: 'ranking',
      meta: { stage: 'ai_ranking' },
    });

    console.log(
      `✅ ${symbol}: Cached predictor decision=${prediction.decision}, confidence=${(prediction.confidence * 100).toFixed(1)}%`
    );

    return prediction;
  } catch (error) {
    console.warn(`⚠️ Predictor failed for ${symbol}:`, error instanceof Error ? error.message : String(error));
    return null;
  }
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
            multiTimeframe: snap.multiTimeframe ?? null,
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

    // 🎯 PREDICTOR FILTER: Remove cryptos with bias 'none' or low confidence
    console.log('🤖 Running XGBoost predictor on all candidates...');
    const predictorFiltered: typeof validSnapshots = [];
    const predictorResults = new Map<string, PredictorSnapshot>();  // Store stable predictor snapshots
    let predictorSkipped = 0;
    let predictorNone = 0;
    let predictorLowConfidence = 0;
    
    for (const snap of validSnapshots) {
      if (!snap) continue;
      
      const prediction = await getPredictorBias(snap.symbol, snap as any as TechnicalSnapshot);
      
      if (!prediction) {
        predictorSkipped++;
        console.log(`⚠️ ${snap.symbol}: Predictor unavailable - skipping`);
        continue;
      }
      
      // Filter: keep only if decision is NOT 'none' AND confidence >= 30%
      const { decision, confidence } = prediction;
      
      if (decision === 'none') {
        predictorNone++;
        console.log(`🚫 ${snap.symbol}: Predictor decision '${decision}' - skipping`);
        continue;
      }
      
      if (confidence < 0.30) {
        predictorLowConfidence++;
        console.log(`🚫 ${snap.symbol}: Confidence ${(confidence * 100).toFixed(1)}% < 30% - skipping`);
        continue;
      }
      
      // Passed all filters - keep this crypto AND store the prediction
      predictorFiltered.push(snap);
      const stableSnapshot = getStableSnapshot(snap.symbol);
      const snapshotForOpportunity: PredictorSnapshot = stableSnapshot
        ? {
            ...stableSnapshot,
            probabilities: { ...stableSnapshot.probabilities },
            features: stableSnapshot.features ? { ...stableSnapshot.features } : null,
            cooldown: { ...stableSnapshot.cooldown },
            classOrder: stableSnapshot.classOrder ? [...stableSnapshot.classOrder] : null,
            meta: stableSnapshot.meta ? { ...stableSnapshot.meta } : null,
          }
        : {
            symbol: snap.symbol.toUpperCase(),
            decision,
            confidence,
            probabilities: { ...prediction.probabilities },
            probabilityLong: prediction.probabilityLong,
            probabilityShort: prediction.probabilityShort,
            probabilityNone: prediction.probabilityNone,
            entryWeight: prediction.entryWeight,
            riskMultiplier: prediction.riskMultiplier,
            cooldown: {
              active: Boolean(prediction.cooldown?.active),
              reason: prediction.cooldown?.reason ?? null,
              seconds:
                Number.isFinite(Number(prediction.cooldown?.seconds)) && prediction.cooldown?.seconds != null
                  ? Number(prediction.cooldown.seconds)
                  : null,
            },
            classOrder: Array.isArray(prediction.classOrder)
              ? prediction.classOrder.filter((value): value is string => typeof value === 'string')
              : null,
            features: null,
            featuresHash: null,
            source: 'ranking',
            timestamp: Date.now(),
            meta: { fallback: true },
          };
      predictorResults.set(snap.symbol, snapshotForOpportunity);  // Store for later
      console.log(`✅ ${snap.symbol}: decision=${decision}, confidence=${(confidence * 100).toFixed(1)}% - PASSED`);
    }
    
    console.log(`🎯 Predictor filter results: ${predictorFiltered.length}/${validSnapshots.length} passed`);
    console.log(`   - ${predictorNone} removed (decision=none)`);
    console.log(`   - ${predictorLowConfidence} removed (confidence <30%)`);
    console.log(`   - ${predictorSkipped} skipped (errors)`);

    if (zeroVolumeSymbols.length > 0) {
      console.warn('🚨 Zero-volume anomalies detected. Symbols will be retried after market data warmup.',
        zeroVolumeSymbols.map(entry => ({
          symbol: entry.symbol,
          timeframe: entry.meta.timeframe,
          availableBars: entry.meta.availableBars,
          nextRetryTs: entry.meta.warmupState?.nextRetryTs,
          details: entry.meta.details,
        }))
      );
    }
    
    // Use predictor-filtered snapshots (or all if predictor failed entirely)
    const snapshotsToRank = predictorFiltered.length > 0 ? predictorFiltered : validSnapshots;
    console.log(`📊 Ranking ${snapshotsToRank.length} predictor-approved cryptos...`);
    
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
    
    // AI Prompt for ranking - TIER-BASED with quality focus
    const prompt = `You are a PROFESSIONAL crypto trading selector. Your goal: return a ranked list of symbols that are LIQUID and NEAR ENTRY, balancing quality and opportunity.

🎯 CRITICAL: Prioritize QUALITY and REPUTATION over raw movement percentage.

📊 TIER SYSTEM (Quality-based classification):

**TIER 1 - BLUE CHIPS** (Highest priority):
- BTC, ETH, SOL
- Characteristics: >$500M daily volume, highest liquidity, lowest risk
- Accept movements: ≥0.2% (even small moves are significant)
- Score adjustment: +1.5 bonus

**TIER 2 - MAJOR ESTABLISHED** (High priority):
- XRP, BNB, ADA, DOGE, MATIC, TRX, LTC, DOT, SHIB, AVAX, LINK, UNI, ATOM, etc.
- Characteristics: >$30M daily volume, well-established, good liquidity
- Accept movements: ≥0.3%
- Score adjustment: +0.8 bonus

**TIER 3 - PROMISING ALTS** (Moderate priority):
- NEAR, SUI, APT, ARB, OP, AAVE, FET, ICP, HBAR, TAO, etc.
- Characteristics: >$5M daily volume, established projects, moderate risk
- Accept movements: ≥0.5%
- Score adjustment: +0.3 bonus

**TIER 4 - SMALL CAPS** (Accept if tradeable):
- Smaller market cap coins with growth potential
- Characteristics: <$5M volume but still liquid enough
- Accept if: ≥0.8% movement AND good technicals (ADX >15, volumeRatio >0.7)
- Score adjustment: 0 (neutral, evaluate on merit)

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
- Return AT LEAST 15-20 opportunities to ensure good selection
- Blue chips (BTC/ETH/SOL) should rank highly if they have reasonable setups
- Don't over-filter - we need OPTIONS for the agent to choose from
- Tier 4 coins are OK if technicals are solid (ADX >15, volumeRatio >0.7)
- Return TOP 20-25 opportunities ranked by QUALITY-ADJUSTED score
- Score formula: baseScore + tierBonus
- Reasons must be concise (1-2 sentences max per reason)
- Include a MIX of tiers for diversity
- IMPORTANT: Even if a crypto has low movement, include it if technicals are excellent`;

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

      return {
        symbol: opp.symbol,
        rank: index + 1,
        score: Number(adjustedScore),
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
        predictor: predictorResults.get(opp.symbol)  // Include predictor result from ranking time
      };
    }).filter(r => r !== null) as RankedOpportunity[];
    
    // Re-sort after score adjustments
    ranked.sort((a, b) => b.score - a.score);
    
    // Update ranks after re-sort
    ranked.forEach((r, i) => r.rank = i + 1);
    
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
