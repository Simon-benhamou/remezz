import { prisma } from '../../../db/client.js';
import { getTicker, getOHLCV } from '../../../data/market.js';
import { isInsufficientDataError, isUnusableMarketDataError } from '../../../data/errors.js';
import { fullAnalysis, computeProjection } from '../../../ai/analysis.js';
import { buildTechSnapshot, type TechnicalSnapshot } from '../../../ai/tech.js';
import { getAIRankedOpportunities, type RankedOpportunity } from '../../../ai/cryptoRanking.js';
import { fetchPerformanceSnapshot, type PerformanceSnapshot } from '../../../ai/performance/memory.js';
import ccxt from 'ccxt';
import { getConfig } from '../../../utils/env.js';
import { computeMultiTimeframeDiagnostics, type Diagnostics as MultiTimeframeDiagnostics } from '../../../ai/multiTimeframe.js';
import { getAdaptiveWeightsForSymbol } from '../../../learning/adaptiveWeights.js';
import { recordDecisionSnapshot, markDecisionCancelled, analyzeDecisionMemoryForSymbol } from '../../../learning/decisionMemory.js';
import type { DecisionFeatures } from '../../../learning/decisionMemory.js';
import { getPersonalityProfile, DEFAULT_PARAMS, classifyVolatilityRegime, classifyDirectionBias, classifyVolumeRegime, classifyTrendingRanging } from '../../../learning/personalityProfile.js';
import { logTradeEvaluation } from '../../../learning/tradeEvaluationLogger.js';
import { getHybridSentiment } from '../../../sentiment/index.js';
import { getAllTickersFromWebSocket, adaptBinanceTickerToCcxt, toBinanceSymbolId } from '../../binanceWebSocket.js';
import type { BinanceTickerData } from '../../binanceWebSocket.js';
import { recordOpsEvent } from '../../../monitor/ops.js';
import { scheduleJob, registerSchedulerJobHandler, processSchedulerJobsOnce } from '../../schedulerJobService.js';
import { proposePlan } from '../../../ai/planOrchestrator.js';
import { requestStrategy } from '../../../ai/strategyManager.js';
import { AgentHub } from '../../../agent/hub.js';
import { broadcast } from '../../../ws/hub.js';
import { mergePlanContainer, savePlan, normalizePlanContainer } from '../../planStore.js';
import type { ActivationProfile } from '../../../agent/state.js';
import { getPredictionSync as getPythonPredictionSync, isPythonPredictorAvailable } from '../../../quantai/pythonPredictor.js';
import type { PythonPredictionResult } from '../../../quantai/pythonPredictor.js';
import {
  LiquidityGuardrailOptions,
  SymbolQualityContext,
  buildSymbolQualityContext,
  evaluateSymbolLiquidityGuardrails,
  symbolQualityRank,
  sanitizeBaseSymbol,
} from '../liquidity.js';
import {
  AutoUniverseStatus,
  AUTO_UNIVERSE_MAX_ATTEMPTS,
  AUTO_UNIVERSE_RETRY_DEFAULT_MS,
  getAutoUniverseStatusSnapshot,
  scheduleAutoUniverseRetry,
  restoreAutoUniverseRetrySchedule,
  updateAutoUniverseStatus,
  registerUniverseFetcher,
  __autoUniverseSchedulerTesting,
} from '../autoUniverseScheduler.js';
import { ensureSymbolProfile } from '../../symbolSpecificOptimization.js';
import { logBiasDecision, logBiasStatistics, hasSignificantBias } from '../biasMonitor.js';

export {
  getAutoUniverseStatusSnapshot,
  restoreAutoUniverseRetrySchedule,
  scheduleAutoUniverseRetry,
  AUTO_UNIVERSE_MAX_ATTEMPTS,
  AUTO_UNIVERSE_RETRY_DEFAULT_MS,
  __autoUniverseSchedulerTesting,
} from '../autoUniverseScheduler.js';
export type { AutoUniverseStatus } from '../autoUniverseScheduler.js';

// HYBRID INTELLIGENT: ML local + IA ultra-conditionnelle
const aiAnalysisCache = new Map<string, { result: any; timestamp: number }>();
const AUTO_UNIVERSE_CACHE_DURATION_MS = 45 * 60 * 1000; // 45 minutes - reduced from 4 hours for faster market adaptation

type CachedDynamicUniverse = {
  kind: 'dynamic';
  orderedPerformers: string[];
  performanceSnapshot: Array<{ base: string; change24h: number }>;
};

type CachedFallbackUniverse = {
  kind: 'fallback';
  symbols: string[];
};

type CachedAutoUniverseResult = CachedDynamicUniverse | CachedFallbackUniverse;

const autoUniverseCache = new Map<string, { result: CachedAutoUniverseResult; timestamp: number }>();

type AutoUniverseDependencyBag = {
  getActiveSymbols: typeof getActiveAgentSymbols;
  getActiveCount: typeof getActiveAgentCountForSymbol;
};

const defaultAutoUniverseDeps: AutoUniverseDependencyBag = {
  getActiveSymbols: getActiveAgentSymbols,
  getActiveCount: getActiveAgentCountForSymbol,
};

function createAutoUniverseCacheKey(strategy?: StrategyFilterProfile): string {
  if (!strategy) {
    return 'auto_universe:default';
  }
  const target = Number.isFinite(strategy.targetTpPct)
    ? Number(strategy.targetTpPct).toFixed(4)
    : 'na';
  const stop = Number.isFinite(strategy.stopLossPct)
    ? Number(strategy.stopLossPct).toFixed(4)
    : 'na';
  return `auto_universe:${strategy.aggressiveness}:${target}:${stop}`;
}

function storeAutoUniverseCache(key: string, result: CachedAutoUniverseResult): void {
  autoUniverseCache.set(key, { result, timestamp: Date.now() });
  if (autoUniverseCache.size > 5) {
    const oldestKey = autoUniverseCache.keys().next().value;
    if (oldestKey) {
      autoUniverseCache.delete(oldestKey);
    }
  }
}

/**
 * Enforce cache size limits using LRU eviction
 */
function enforceCacheSizeLimits(): void {
  // Clean AI analysis cache
  if (aiAnalysisCache.size > MAX_AI_CACHE_SIZE) {
    const entries = Array.from(aiAnalysisCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = entries.slice(0, entries.length - MAX_AI_CACHE_SIZE);
    toDelete.forEach(([key]) => aiAnalysisCache.delete(key));
    console.log(`🧹 Cleaned ${toDelete.length} entries from aiAnalysisCache (size was ${entries.length})`);
  }
  
  // Clean volatility cache
  // Note: volatilityCache stores only booleans without timestamps
  // Since we can't implement true LRU without timestamps, we keep oldest keys
  // This is acceptable as volatility checks are frequent and uniform across symbols
  if (volatilityCache.size > MAX_VOLATILITY_CACHE_SIZE) {
    const count = volatilityCache.size - MAX_VOLATILITY_CACHE_SIZE;
    const keys = Array.from(volatilityCache.keys()).slice(0, count);
    keys.forEach(key => volatilityCache.delete(key));
    console.log(`🧹 Cleaned ${count} entries from volatilityCache (FIFO eviction)`);
  }
  
  // Clean ML prediction cache
  if (mlPredictionCache.size > MAX_ML_PREDICTION_CACHE_SIZE) {
    const entries = Array.from(mlPredictionCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = entries.slice(0, entries.length - MAX_ML_PREDICTION_CACHE_SIZE);
    toDelete.forEach(([key]) => mlPredictionCache.delete(key));
    console.log(`🧹 Cleaned ${toDelete.length} entries from mlPredictionCache (size was ${entries.length})`);
  }
}

/**
 * Clean expired cache entries
 */
function cleanExpiredCacheEntries(): void {
  const now = Date.now();
  
  // Clean AI analysis cache
  for (const [key, entry] of aiAnalysisCache.entries()) {
    if (now - entry.timestamp > CACHE_DURATION_AI) {
      aiAnalysisCache.delete(key);
    }
  }
  
  // Clean ML prediction cache
  for (const [key, entry] of mlPredictionCache.entries()) {
    if (now - entry.timestamp > CACHE_DURATION_ML) {
      mlPredictionCache.delete(key);
    }
  }
}

// Run cache cleanup periodically (every 5 minutes)
// Only run in Node.js environment (not during module bundling/analysis)
if (typeof setInterval !== 'undefined' && typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    enforceCacheSizeLimits();
    cleanExpiredCacheEntries();
  }, 5 * 60 * 1000);
}

async function resolveCachedAutoUniverse(
  cached: CachedAutoUniverseResult,
  excludeSessionId: string | undefined,
  deps: AutoUniverseDependencyBag = defaultAutoUniverseDeps,
): Promise<string[]> {
  if (cached.kind === 'dynamic') {
    return rebuildDynamicUniverseFromCache(cached, excludeSessionId, deps);
  }
  return filterSymbolsByActivity(cached.symbols, excludeSessionId, deps);
}

async function rebuildDynamicUniverseFromCache(
  cached: CachedDynamicUniverse,
  excludeSessionId: string | undefined,
  deps: AutoUniverseDependencyBag,
): Promise<string[]> {
  const activeSymbols = await deps.getActiveSymbols(excludeSessionId);
  const activeSet = new Set(activeSymbols.map((sym) => normalizeUnifiedSymbol(sym)));
  const performanceByBase = new Map<string, number>();
  for (const snap of cached.performanceSnapshot) {
    if (!snap?.base) continue;
    const upperBase = snap.base.toUpperCase();
    if (!performanceByBase.has(upperBase)) {
      performanceByBase.set(upperBase, snap.change24h);
    }
  }

  const selected: string[] = [];
  const seen = new Set<string>();

  for (const symbol of cached.orderedPerformers) {
    if (!symbol) continue;
    const unified = normalizeUnifiedSymbol(symbol);
    if (!unified || seen.has(unified)) continue;
    const base = extractPerpBase(symbol)?.toUpperCase() ?? unified.split('/')[0] ?? symbol;
    const change = performanceByBase.get(base) ?? 0;
    const absChange = Math.abs(change);

    if (absChange > 3) {
      const activeCount = await deps.getActiveCount(symbol, excludeSessionId);
      if (activeCount < 2) {
        selected.push(symbol);
        seen.add(unified);
      }
      continue;
    }

    if (activeSet.has(unified)) {
      if (absChange > 2) {
        const activeCount = await deps.getActiveCount(symbol, excludeSessionId);
        if (activeCount < 2) {
          selected.push(symbol);
          seen.add(unified);
        }
      }
      continue;
    }

    selected.push(symbol);
    seen.add(unified);
  }

  if (selected.length > 0) {
    return selected;
  }

  return filterSymbolsByActivity(cached.orderedPerformers, excludeSessionId, deps);
}

async function filterSymbolsByActivity(
  symbols: string[],
  excludeSessionId: string | undefined,
  deps: AutoUniverseDependencyBag,
): Promise<string[]> {
  const activeSymbols = await deps.getActiveSymbols(excludeSessionId);
  const activeSet = new Set(activeSymbols.map((sym) => normalizeUnifiedSymbol(sym)));
  const seen = new Set<string>();
  const available: string[] = [];

  for (const symbol of symbols) {
    if (!symbol) continue;
    const unified = normalizeUnifiedSymbol(symbol);
    if (!unified || seen.has(unified) || activeSet.has(unified)) {
      continue;
    }
    seen.add(unified);
    available.push(symbol);
  }

  return available;
}
const volatilityCache = new Map<string, boolean>();
const mlPredictionCache = new Map<string, { confidence: number; prediction: string; reasoning: string; timestamp: number }>();
const CACHE_DURATION_AI = 12 * 60 * 1000; // 12min cache IA - reduced from 30min for faster adaptation
const CACHE_DURATION_VOLATILITY = 3 * 60 * 1000; // 3min cache volatilité - reduced from 5min
const CACHE_DURATION_ML = 8 * 60 * 1000; // 8min cache ML - reduced from 15min

// Cache size limits to prevent memory leaks
const MAX_AI_CACHE_SIZE = 50;
const MAX_VOLATILITY_CACHE_SIZE = 100;
const MAX_ML_PREDICTION_CACHE_SIZE = 50;
const waitFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type FetchImpl = (input: any, init?: any) => Promise<Response>;

function isRequestTimeoutError(error: unknown): boolean {
  if (!error) return false;
  const ccxtAny = ccxt as any;
  if (error instanceof ccxtAny.RequestTimeout) {
    return true;
  }
  const name = typeof (error as any)?.name === 'string' ? (error as any).name : '';
  if (name === 'AbortError') {
    return true;
  }
  const message = typeof (error as any)?.message === 'string' ? (error as any).message : '';
  return message.includes('RequestTimeout') || message.includes('timed out') || message.includes('ETIMEDOUT');
}

async function fetchJsonWithBackoff(
  url: string,
  label: string,
  {
    fetchImpl = fetch,
    attempts = 3,
    timeoutMs = 20_000,
    baseDelayMs = 2_000,
  }: { fetchImpl?: FetchImpl; attempts?: number; timeoutMs?: number; baseDelayMs?: number } = {},
): Promise<any> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: abortController.signal });
      clearTimeout(timer);
      if (!response.ok) {
        throw new Error(`${label} HTTP ${response.status}: ${response.statusText}`);
      }
      return response.json();
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      const delay = Math.min(baseDelayMs * 2 ** attempt, 60_000);
      const message = typeof (error as any)?.message === 'string' ? (error as any).message : String(error);
      console.warn(`⚠️ ${label} attempt ${attempt + 1} failed: ${message}`);
      if (attempt + 1 >= attempts) {
        break;
      }
      await waitFor(delay);
    }
  }
  throw lastError ?? new Error(`${label} failed after ${attempts} attempts`);
}

type BinanceMarket = {
  symbol: string;
  swap: boolean;
  type: 'swap';
  active: boolean;
  settle: string;
  base: string;
  quote: string;
};

function toBinanceSwapSymbol(symbol: string): string {
  if (!symbol) return symbol;
  if (symbol.includes(':')) return symbol;
  const [base, quote] = symbol.split('/') as [string, string | undefined];
  if (quote && quote.toUpperCase() === 'USDT') {
    return `${base}/USDT:USDT`;
  }
  return symbol;
}

async function fetchBinancePerpetualMarkets(
  cacheKey: string,
  {
    fetchImpl = fetch,
    disableCache = false,
    getWsTickers,
  }: { fetchImpl?: FetchImpl; disableCache?: boolean; getWsTickers?: (() => Promise<Map<string, BinanceTickerData> | null>) | null } = {},
): Promise<{ markets: Record<string, BinanceMarket>; count: number; source: string }> {
  const CACHE_DURATION = 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (!disableCache) {
    const cachedData = aiAnalysisCache.get(cacheKey);
    if (cachedData && now - cachedData.timestamp < CACHE_DURATION) {
      const cachedResult = cachedData.result as { markets: Record<string, BinanceMarket>; count: number };
      return { markets: cachedResult.markets, count: cachedResult.count, source: 'cache' };
    }
  }

  const markets: Record<string, BinanceMarket> = {};

  if (getWsTickers) {
    try {
      const wsMap = await getWsTickers();
      if (wsMap && wsMap.size > 0) {
        let count = 0;
        for (const ticker of wsMap.values()) {
          if (!ticker.symbol.endsWith('USDT')) continue;
          const base = ticker.symbol.replace(/USDT$/i, '');
          const unified = `${base}/USDT`;
          markets[unified] = {
            symbol: unified,
            swap: true,
            type: 'swap',
            active: true,
            settle: 'USDT',
            base,
            quote: 'USDT',
          };
          count += 1;
        }
        if (count > 0) {
          if (!disableCache) {
            aiAnalysisCache.set(cacheKey, { result: { markets, count }, timestamp: now });
          }
          console.log(`✅ Derived ${count} USDT perpetual markets from Binance WS tickers`);
          return { markets, count, source: 'ws' };
        }
      }
    } catch (error) {
      console.warn('⚠️ Failed to derive Binance perpetual markets from WS tickers:', error);
    }
  }

  const restEndpoints = [
    {
      url: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
      label: 'Binance futures exchangeInfo (fapi)',
      settle: 'USDT',
    },
    {
      url: 'https://dapi.binance.com/dapi/v1/exchangeInfo',
      label: 'Binance coin-m futures exchangeInfo (dapi)',
      settle: 'USD',
    },
  ] as const;

  for (const endpoint of restEndpoints) {
    try {
      const exchangeInfo = await fetchJsonWithBackoff(endpoint.url, endpoint.label, { fetchImpl });
      const symbols = Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : [];
      let count = 0;
      for (const symbolInfo of symbols) {
        const quote = String(symbolInfo?.quoteAsset ?? '').toUpperCase();
        if (symbolInfo?.contractType !== 'PERPETUAL') continue;
        if (symbolInfo?.status !== 'TRADING') continue;
        if (quote !== 'USDT') continue;
        const base = String(symbolInfo.baseAsset ?? '').toUpperCase();
        if (!base) continue;
        const unified = `${base}/USDT`;
        markets[unified] = {
          symbol: unified,
          swap: true,
          type: 'swap',
          active: true,
          settle: 'USDT',
          base,
          quote: 'USDT',
        };
        count += 1;
      }
      if (count > 0) {
        if (!disableCache) {
          aiAnalysisCache.set(cacheKey, { result: { markets, count }, timestamp: now });
        }
        console.log(`📊 Fetched ${count} Binance perpetual markets from ${endpoint.label}`);
        return { markets, count, source: endpoint.label };
      }
    } catch (error) {
      console.warn(`⚠️ ${endpoint.label} failed:`, error);
    }
  }

  try {
    const spotInfo = await fetchJsonWithBackoff('https://api.binance.com/api/v3/exchangeInfo', 'Binance spot exchangeInfo', {
      fetchImpl,
      attempts: 2,
      baseDelayMs: 1_000,
    });
    const symbols = Array.isArray(spotInfo?.symbols) ? spotInfo.symbols : [];
    let count = 0;
    for (const symbolInfo of symbols) {
      if (symbolInfo?.status !== 'TRADING') continue;
      if (symbolInfo?.quoteAsset !== 'USDT') continue;
      const base = String(symbolInfo.baseAsset ?? '').toUpperCase();
      if (!base) continue;
      const unified = `${base}/USDT`;
      markets[unified] = {
        symbol: unified,
        swap: true,
        type: 'swap',
        active: true,
        settle: 'USDT',
        base,
        quote: 'USDT',
      };
      count += 1;
    }
    if (count > 0) {
      console.warn('⚠️ Falling back to Binance spot exchangeInfo for perpetual market validation');
      if (!disableCache) {
        aiAnalysisCache.set(cacheKey, { result: { markets, count }, timestamp: now });
      }
      return { markets, count, source: 'spot_fallback' };
    }
  } catch (error) {
    console.error('❌ Binance spot exchangeInfo fallback failed:', error);
  }

  throw new Error('Unable to load Binance perpetual markets from any source');
}

async function fetchTickerWithRetry(
  exchange: any,
  symbol: string,
  alias: string,
  attempt: number = 0,
  maxAttempts: number = 3,
): Promise<any> {
  try {
    return await exchange.fetchTicker(symbol);
  } catch (error) {
    if (isRequestTimeoutError(error) && attempt + 1 < maxAttempts) {
      const delay = Math.min(2_000 * 2 ** attempt, 15_000);
      console.warn(`⚠️ ${exchange.id} timeout on ${alias} (${symbol}), retrying in ${delay}ms...`);
      await waitFor(delay);
      return fetchTickerWithRetry(exchange, symbol, alias, attempt + 1, maxAttempts);
    }
    if (isRequestTimeoutError(error)) {
      console.warn(`⚠️ ${exchange.id} timeout on ${alias} (${symbol}) after ${maxAttempts} attempts. Skipping.`);
      return null;
    }
    throw error;
  }
}

const OPEN_ORDER_STATUS_LIST = [
  'new', 'NEW',
  'open', 'OPEN',
  'partially_filled', 'PARTIALLY_FILLED',
  'pending', 'PENDING',
  'accepted', 'ACCEPTED',
  'working', 'WORKING',
  'trigger_pending', 'TRIGGER_PENDING'
];
const OPEN_ORDER_STATUSES = new Set(OPEN_ORDER_STATUS_LIST.map((status) => status.toLowerCase()));
const POSITION_QTY_EPSILON = 1e-6;

// AUTO-DIRECTIONAL: Détection automatique du bias optimal (VERSION ÉQUILIBRÉE)
function determineOptimalBias(symbol: string, metrics: any): { bias: 'long' | 'short' | 'none'; confidence: number; reasoning: string } {
  const { rsi, adx, momentum, trendStrength, volume24h } = metrics;
  
  let bullScore = 0;
  let bearScore = 0;
  const signals: string[] = [];
  
  // 🎯 TREND-FOLLOWING PRIMARY: Suivre la tendance principale (momentum)
  // FIX: Favoriser trend-following plutôt que counter-trend pour équilibrer long/short
  if (Math.abs(momentum) > 2) {
    const trendBonus = Math.min(40, Math.abs(momentum) * 5);
    if (momentum < 0) {
      // Momentum négatif = opportunité SHORT (trend-following)
      bearScore += trendBonus;
      signals.push(`Bearish momentum ${momentum.toFixed(1)}% (short trend-following)`);
    } else {
      // Momentum positif = opportunité LONG (trend-following)
      bullScore += trendBonus;
      signals.push(`Bullish momentum +${momentum.toFixed(1)}% (long trend-following)`);
    }
  }
  
  // 🔄 COUNTER-TREND SECONDARY: Opportunités de reversal (score réduit pour éviter biais)
  // Uniquement si RSI extrême confirme le reversal
  const extremeMove = Math.abs(momentum);
  if (extremeMove > 10 && ((momentum < -8 && rsi < 25) || (momentum > 8 && rsi > 75))) {
    const reversalBonus = 20; // Réduit de 40 à 20 pour donner priorité au trend-following
    if (momentum < -8 && rsi < 25) {
      bullScore += reversalBonus;
      signals.push(`Extreme oversold reversal setup (RSI ${rsi.toFixed(0)})`);
    } else if (momentum > 8 && rsi > 75) {
      bearScore += reversalBonus;
      signals.push(`Extreme overbought reversal setup (RSI ${rsi.toFixed(0)})`);
    }
  }
  
  // Analyse RSI (équilibré pour long/short)
  if (rsi < 40) {
    bullScore += rsi < 25 ? 25 : 15; // Réduit pour équilibrer
    signals.push(`RSI ${rsi.toFixed(0)} oversold zone`);
  } else if (rsi > 60) {
    bearScore += rsi > 75 ? 25 : 15; // Symétrique avec oversold
    signals.push(`RSI ${rsi.toFixed(0)} overbought zone`);
  }
  
  // Analyse ADX (trend strength) - équilibré pour long/short
  if (adx > 20) { // Abaissé de 25 à 20 pour capter plus de trends
    const adxBonus = Math.min(25, adx - 10);
    if (momentum < 0) {
      // Downtrend fort = privilégier SHORT (trend-following)
      bearScore += adxBonus;
      signals.push(`Strong downtrend (ADX ${adx.toFixed(0)}) - short opportunity`);
    } else if (momentum > 0) {
      // Uptrend fort = privilégier LONG (trend-following)
      bullScore += adxBonus;
      signals.push(`Strong uptrend (ADX ${adx.toFixed(0)}) - long opportunity`);
    }
  }
  
  // Analyse trendStrength (confirmation directionnelle)
  if (trendStrength) {
    const tsBonus = Math.abs(trendStrength) * 15;
    if (trendStrength < 0) {
      bearScore += tsBonus;
      signals.push(`Bearish trend strength ${trendStrength.toFixed(2)}`);
    } else if (trendStrength > 0) {
      bullScore += tsBonus;
      signals.push(`Bullish trend strength ${trendStrength.toFixed(2)}`);
    }
  }
  
  // Volume confirmation (symétrique)
  if (volume24h > 100_000_000) {
    const volumeBonus = Math.min(15, (volume24h / 100_000_000) * 5);
    if (extremeMove > 3) {
      // Volume élevé confirme le mouvement en cours
      if (momentum < 0) {
        bearScore += volumeBonus; // Confirme bearish move
        signals.push('High volume confirms bearish move');
      } else {
        bullScore += volumeBonus; // Confirme bullish move
        signals.push('High volume confirms bullish move');
      }
    }
  }
  
  // CRYPTO MAJORS: Bonus symétrique (pas de biais long)
  const majorCryptos = ['BTC/USDT', 'ETH/USDT', 'AVNT/USDT', 'SOL/USDT', 'SUI/USDT', 'XRP/USDT', 'ADA/USDT'];
  if (majorCryptos.includes(symbol)) {
    const majorBonus = 10;
    if (bullScore > bearScore) bullScore += majorBonus;
    else if (bearScore > bullScore) bearScore += majorBonus; // FIX: Appliquer aussi au bearScore
    signals.push('Major crypto liquidity bonus');
  }
  
  // Determine bias et confidence (seuil équilibré)
  const maxScore = Math.max(bullScore, bearScore);
  const scoreMargin = Math.abs(bullScore - bearScore);
  
  // Require clear directional edge (15 points minimum margin)
  const bias = scoreMargin < 15 ? 'none' : 
               bullScore > bearScore ? 'long' : 'short';
  
  const confidence = Math.min(maxScore, 100);
  const reasoning = `${bias.toUpperCase()} bias (${confidence}%, margin: ${scoreMargin.toFixed(0)}): ${signals.join(' | ')}`;
  
  // Log detailed bias decision for monitoring
  logBiasDecision(symbol, bias, confidence, reasoning, { bullScore, bearScore });
  
  return { bias, confidence, reasoning };
}

// Helper pour construire les features du predictor depuis technical snapshot
function buildPredictorFeaturesFromTech(technical: TechnicalSnapshot): Record<string, number> {
  return {
    ema20: technical.ema20 || 0,
    ema50: technical.ema50 || 0,
    ema100: technical.ema100 || 0,
    ema200: technical.ema200 || 0,
    rsi14: technical.rsi14 || 50,
    atr14: technical.atr14 || 0,
    adx14: technical.adx14 || 0,
  };
}

// Machine Learning avec XGBoost Predictor (95% accuracy)
function predictWithXGBoostPredictor(symbol: string, technical: TechnicalSnapshot, momentum: number, volume: number): { confidence: number; prediction: string; reasoning: string; probabilities?: { long: number; short: number; none: number } } {
  // Vérifier si le predictor Python est disponible
  const pythonAvailable = process.env.DISABLE_PYTHON_PREDICTOR !== 'true' && isPythonPredictorAvailable();
  
  if (!pythonAvailable) {
    // Fallback vers le ML local basique si Python indisponible
    return predictWithLocalMLFallback(symbol, technical.rsi14 || 50, technical.adx14 || 0, momentum, volume);
  }
  
  try {
    // Construire les features pour le predictor
    const features = buildPredictorFeaturesFromTech(technical);
    
    // Appeler le predictor XGBoost
    const prediction: PythonPredictionResult = getPythonPredictionSync(features);
    
    // Extraire la décision et confiance
    const decision = prediction.decision.toUpperCase(); // 'long' | 'short' | 'none'
    const confidencePercent = prediction.confidence * 100; // 0-1 → 0-100
    
    // Générer le reasoning
    const probLong = (prediction.probabilities.long * 100).toFixed(1);
    const probShort = (prediction.probabilities.short * 100).toFixed(1);
    const probNone = (prediction.probabilities.none * 100).toFixed(1);
    const reasoning = `XGBoost: ${decision} (${probLong}% L, ${probShort}% S, ${probNone}% N)`;
    
    console.log(`[36m🤖 ${symbol}: XGBoost predictor ${decision} (confidence: ${confidencePercent.toFixed(1)}%, probs: L=${probLong}% S=${probShort}% N=${probNone}%)[0m`);
    
    return {
      confidence: confidencePercent,
      prediction: decision,
      reasoning,
      probabilities: prediction.probabilities,
    };
  } catch (error) {
    console.warn(`⚠️ ${symbol}: XGBoost predictor failed, using fallback ML:`, error);
    return predictWithLocalMLFallback(symbol, technical.rsi14 || 50, technical.adx14 || 0, momentum, volume);
  }
}

// Machine Learning Local - Prédiction sans coût API (FALLBACK seulement)
function predictWithLocalMLFallback(symbol: string, rsi: number, adx: number, momentum: number, volume: number): { confidence: number; prediction: string; reasoning: string } {
  // Patterns basés sur l'expérience crypto
  let confidence = 0;
  let signals: string[] = [];
  
  // Pattern 1: RSI Extremes
  if (rsi < 30) {
    confidence += 25;
    signals.push('RSI oversold');
  } else if (rsi > 70) {
    confidence += 20;
    signals.push('RSI overbought');
  }
  
  // Pattern 2: Trend Strength (ADX)
  if (adx > 25) {
    confidence += 20;
    signals.push('Strong trend');
  }
  
  // Pattern 3: Momentum Alignment
  if (Math.abs(momentum) > 2) {
    confidence += 15;
    signals.push('Strong momentum');
  }
  
  // Pattern 4: Volume Confirmation
  if (volume > 100_000_000) {
    confidence += 10;
    signals.push('High volume');
  }
  
  // Pattern 5: Crypto-specific (majors bonus)
  const majorCryptos = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'SUI/USDT'];
  if (majorCryptos.includes(symbol)) {
    confidence += 10;
    signals.push('Major crypto');
  }
  
  const prediction = momentum > 0 ? 'BULLISH' : 'BEARISH';
  const reasoning = signals.join(' + ');
  
  return { confidence: Math.min(confidence, 100), prediction, reasoning };
}
function extractPerpBase(sym: string): string | null {
  if (!sym) return null;
  const raw = String(sym).trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();

  if (upper.includes('/')) {
    const [base, quotePart] = upper.split('/') as [string, string];
    if (quotePart?.startsWith('USDT') || quotePart?.startsWith('USD')) {
      return base;
    }
  }

  const stripped = upper.replace(/[:\-]/g, '');
  const directMatch = stripped.match(/^([A-Z0-9]+)(USDT|USD|USDC)(PERP)?$/);
  if (directMatch) {
    return directMatch[1];
  }

  const perpMatch = upper.match(/^([A-Z0-9]+)(USD|USDT)(?:[_-]?PERP)?$/);
  if (perpMatch) {
    return perpMatch[1];
  }

  return upper.includes('/') ? upper.split('/')[0] : upper;
}

export function normalizeUnifiedSymbol(sym: string): string {
  try {
    const base = extractPerpBase(sym);
    if (!base) return sym;
    return `${base}/USDT`;
  } catch {
    return sym;
  }
}

export async function getActiveAgentSymbols(excludeSessionId?: string): Promise<string[]> {
  try {
    const whereClause: any = { stoppedAt: null };

    // Exclude current session being created to avoid self-conflict
    if (excludeSessionId) {
      whereClause.id = { not: excludeSessionId };
      console.log(`🚫 Excluding session ${excludeSessionId.substring(0, 8)}... from conflict detection`);
    }

    const activeSessions = await prisma.agentSession.findMany({
      where: whereClause,
      select: { symbol: true, currentSymbol: true }
    });

    const normalized = new Set<string>();
    for (const session of activeSessions) {
      const candidates = [session.symbol, session.currentSymbol];
      for (const raw of candidates) {
        if (!raw) continue;
        const unified = normalizeUnifiedSymbol(raw);
        if (unified) {
          normalized.add(unified);
        }
      }
    }

    return Array.from(normalized);
  } catch (error) {
    console.error('Error fetching active agent symbols:', error);
    return [];
  }
}

export interface IntelligentAnalysis {
  symbol: string;
  score: number;
  rank: number;
  confidence: number;
  projectionConfidence?: number;
  autoBias?: { // 🆕 Bias auto-déterminé par l'agent
    bias: 'long' | 'short' | 'none';
    confidence: number;
    reasoning: string;
  };
  multiTimeframe?: MultiTimeframeDiagnostics;
  reasoning: {
    summary: string;
    technical: string[];
    sentiment: string[];
    risk: string[];
  };
  metrics: {
    momentum: number;
    trend: number;
    volatility: number;
    volume24h: number;
    rsi: number;
    trendStrength: number;
    hurst: number;
    adx: number;
  };
  opportunity: {
    type: 'breakout' | 'reversal' | 'trend' | 'momentum' | 'volatility';
    direction: 'bullish' | 'bearish' | 'neutral';
    timeframe: 'short' | 'medium' | 'long';
    expectedReturn: number;
    riskLevel: 'low' | 'medium' | 'high';
    playbook?: string;
    targetR?: number;
  };
  regime: string;
  memoryContext?: {
    symbolWinRate: number | null;
    weightedOutcome: number | null;
    scoreMultiplier: number;
    sampleSize: number;
    similarWinCount: number;
    similarLossCount: number;
    similarDecisions: Array<{
      id: string;
      createdAt: string;
      outcome: string | null;
      realizedPnl: number | null;
      bias?: string | null;
      similarity: number;
    }>;
  };
}

async function enrichAnalysisWithMemory(analysis: IntelligentAnalysis): Promise<IntelligentAnalysis> {
  try {
    const memoryFeatures = {
      momentum: Number(analysis.metrics.momentum ?? 0),
      volume24h: Number(analysis.metrics.volume24h ?? 0),
      volatility: Number(analysis.metrics.volatility ?? 0),
      trend: Number(analysis.metrics.trend ?? 0),
      trendStrength: Number(analysis.metrics.trendStrength ?? 0),
      score: Number(analysis.score ?? 0),
      confidence: Number(analysis.confidence ?? 0),
      biasConfidence: Number(analysis.autoBias?.confidence ?? 0),
      agreementScore: analysis.multiTimeframe?.agreementScore != null
        ? Number(analysis.multiTimeframe.agreementScore)
        : undefined,
      divergenceScore: analysis.multiTimeframe?.divergenceScore != null
        ? Number(analysis.multiTimeframe.divergenceScore)
        : undefined,
    } satisfies DecisionFeatures;

    const insight = await analyzeDecisionMemoryForSymbol(analysis.symbol, memoryFeatures);
    if (insight) {
      analysis.memoryContext = insight;
      const adjustedScore = Number((analysis.score * insight.scoreMultiplier).toFixed(2));
      const delta = adjustedScore - analysis.score;
      analysis.score = adjustedScore;
      const weighted = insight.weightedOutcome != null ? `${Math.round(insight.weightedOutcome * 100)}%` : 'n/a';
      const neutralCount = insight.similarDecisions.length - insight.similarWinCount - insight.similarLossCount;
      analysis.reasoning.technical.unshift(
        `Memory check: ${insight.similarWinCount}W/${insight.similarLossCount}L/${neutralCount}N (weighted win ${weighted}) → score ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} (${insight.scoreMultiplier.toFixed(2)}x)`,
      );
      analysis.reasoning.summary = `${analysis.reasoning.summary} | Memory ${weighted} (${insight.similarDecisions.length} matches)`;
    }
  } catch (error) {
    console.warn(`Memory enrichment failed for ${analysis.symbol}:`, error);
  }

  return analysis;
}

const MAX_HISTORY_ENTRIES = 40;

function clampHistory(history: any[] = []): any[] {
  if (!Array.isArray(history)) return [];
  if (history.length <= MAX_HISTORY_ENTRIES) return history;
  return history.slice(-MAX_HISTORY_ENTRIES);
}

async function refreshPlanAndStrategy(sessionId: string, symbol: string, reason: string) {
  try {
    console.log(`🧠 Refreshing plan for ${sessionId} on ${symbol} (${reason})`);
    const agent = AgentHub.get(sessionId) as any;
    if (agent && agent.profile) {
      const newProfile: ActivationProfile = { ...agent.profile, symbol };
      agent.profile = newProfile;
    }
    const plan = await proposePlan(symbol, { fresh: true, sessionId });
    await savePlan(sessionId, plan as any, {
      planMeta: { reason, source: 'intelligent_agent' },
    });

    // Meta-adaptive agents are stateless stubs without propose/validateAndArm methods
    if (agent) {
      if (typeof agent.propose === 'function') {
        await agent.propose(plan as any);
      }
      if (typeof agent.validateAndArm === 'function') {
        await agent.validateAndArm();
      }
    }

    try {
      const { strategy: strat, levels: lvls } = await requestStrategy({
        symbol,
        trigger: reason,
        sessionId,
        fresh: true,
        force: true,
      });
      broadcast('strategy', { ...(strat as any), levels: lvls }, symbol, sessionId);
    } catch (err) {
      console.warn(`Strategy refresh failed for ${sessionId}:`, err);
    }

    broadcast('plan_refreshed', { symbol, reason, plan }, symbol, sessionId);

    try {
      const tech = await buildTechSnapshot(symbol);
      broadcast('analysis', { symbol, technical: tech }, symbol, sessionId);
    } catch (err) {
      console.warn(`Tech snapshot priming failed for ${sessionId}:`, err);
    }

    try {
      await getTicker(symbol, { forceRefresh: true });
      await Promise.allSettled([
        getOHLCV(symbol, '4h', 200),
        getOHLCV(symbol, '1h', 200),
        getOHLCV(symbol, '15m', 200)
      ]);
    } catch (err) {
      console.warn(`Market data priming failed for ${sessionId}:`, err);
    }

    try {
      if (agent && typeof agent.onTick === 'function') {
        await agent.onTick();
      }
    } catch (err) {
      console.warn(`Initial onTick priming failed for ${sessionId}:`, err);
    }
  } catch (error) {
    console.error(`❌ Failed to refresh plan for ${sessionId}:`, error);
  }
}

/** Check if a symbol is already used by another active session */
async function isSymbolInUse(symbol: string, excludeSessionId?: string): Promise<boolean> {
  try {
    const conflict = await prisma.agentSession.findFirst({
      where: {
        stoppedAt: null,
        id: excludeSessionId ? { not: excludeSessionId } : undefined,
        OR: [
          { symbol },
          { currentSymbol: symbol },
        ],
      },
      select: { id: true },
    });
    return !!conflict;
  } catch (err) {
    console.warn('isSymbolInUse check failed:', err);
    return false;
  }
}

/**
 * Get optimized list of top performing cryptos for analysis (max 20)
 */
export type StrategyFilterProfile = {
  aggressiveness: 'conservative' | 'reactive' | 'aggressive';
  targetTpPct: number;
  stopLossPct: number;
};

type CandidateRegimeTag = 'trending' | 'ranging' | 'volatile' | 'quiet';

type CandidatePerformanceSnapshot = PerformanceSnapshot;

type CandidateMicrostructureSnapshot = {
  spreadBps: number | null;
  bidDepthCents: bigint;
  askDepthCents: bigint;
};

type CandidateMetrics = {
  symbol: string;
  baseScore: number;
  volumeCents24h: bigint;
  lastPrice: number;
  regimeTag: CandidateRegimeTag;
  atrPct: number | null;
  micro: CandidateMicrostructureSnapshot;
  performance: CandidatePerformanceSnapshot;
  multiTimeframe?: MultiTimeframeDiagnostics;
};

const VOLUME_FLOOR_CENTS = BigInt(50_000_000 * 100);
const DEPTH_FLOOR_CENTS_BY_PROFILE = {
  conservative: BigInt(25_000 * 100),
  reactive: BigInt(15_000 * 100),
  aggressive: BigInt(10_000 * 100),
} as const;
const MAX_SPREAD_BPS = 8;
const MIN_PASSIVE_FILL_RATE = 0.4;
const PERFORMANCE_COOLDOWN_HOURS = 24;
const ORDER_BOOK_MIN_INTERVAL_MS = 1_000;
const orderBookThrottle = new Map<string, number>();

function getDepthFloorCents(aggressiveness: StrategyFilterProfile['aggressiveness']): bigint {
  return DEPTH_FLOOR_CENTS_BY_PROFILE[aggressiveness] ?? DEPTH_FLOOR_CENTS_BY_PROFILE.reactive;
}

function numberToCents(value: number | null | undefined): bigint | null {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return BigInt(Math.round(num * 100));
}

function sumDepthLevels(levels: Array<[number, number]>): bigint {
  let total = BigInt(0);
  for (const level of levels) {
    const price = Number(level?.[0] ?? NaN);
    const qty = Number(level?.[1] ?? NaN);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
    const usd = Math.round(price * qty * 100);
    if (!Number.isFinite(usd)) continue;
    if (usd > 0) total += BigInt(usd);
  }
  return total;
}

function resolveExchangeSymbol(exchange: any, symbol: string): string | null {
  if (!symbol) return null;
  const markets = exchange?.markets as Record<string, any> | undefined;
  if (markets?.[symbol]) {
    return markets[symbol]?.symbol ?? symbol;
  }

  const alt = toBinanceSwapSymbol(symbol);
  if (alt !== symbol && markets?.[alt]) {
    return markets[alt]?.symbol ?? alt;
  }

  try {
    if (typeof exchange?.market === 'function') {
      const market = exchange.market(symbol);
      if (market?.symbol) return market.symbol;
    }
  } catch (error) {
    if (isMissingSymbolError(error)) {
      return null;
    }
  }

  const upper = symbol.toUpperCase();
  if (markets?.[upper]) {
    return markets[upper]?.symbol ?? upper;
  }

  return null;
}

function shouldFetchOrderBook(symbol: string): boolean {
  const now = Date.now();
  const last = orderBookThrottle.get(symbol) ?? 0;
  if (now - last < ORDER_BOOK_MIN_INTERVAL_MS) {
    return false;
  }
  orderBookThrottle.set(symbol, now);
  return true;
}

function resetOrderBookThrottle(): void {
  orderBookThrottle.clear();
}

function isMissingSymbolError(error: unknown): boolean {
  if (!error) return false;
  const message = typeof (error as any)?.message === 'string' ? (error as any).message : String(error);
  if (!message) return false;
  return message.includes("Mandatory parameter 'symbol'")
    || message.includes('INVALID_SYMBOL')
    || message.includes('not found');
}

function deriveRegimeTag(regime: any | undefined, atrPct: number | null): CandidateRegimeTag {
  if (regime && typeof regime === 'object') {
    const playbook = regime.playbook as string | undefined;
    const volatility = regime.volatility as string | undefined;
    const trend = regime.trend as string | undefined;
    if (volatility === 'high' || playbook === 'momentum_breakout') {
      return 'volatile';
    }
    if (playbook === 'trend_following' || trend === 'uptrend' || trend === 'downtrend') {
      return 'trending';
    }
    if (volatility === 'low') {
      return 'quiet';
    }
    return 'ranging';
  }
  if (atrPct != null && Number.isFinite(atrPct)) {
    if (atrPct >= 3) return 'volatile';
    if (atrPct >= 1.2) return 'trending';
    if (atrPct <= 0.6) return 'quiet';
  }
  return 'ranging';
}

function evaluateCandidateAgainstFilters(
  metrics: CandidateMetrics,
  strategy: StrategyFilterProfile,
  now: number,
): { ok: boolean; reasons: string[]; score: number } {
  const reasons: string[] = [];
  const quality = buildSymbolQualityContext(metrics.symbol);

  // 🆕 Cross-timeframe constraint: 4h bias pilots 15m execution bias
  const mt = metrics.multiTimeframe?.timeframes ?? {};
  const bias4h = String(mt['4h']?.bias ?? 'neutral');
  const bias15 = String(mt['15m']?.bias ?? 'neutral');
  const conflictingBias =
    (bias4h === 'bullish' && bias15 === 'bearish') ||
    (bias4h === 'bearish' && bias15 === 'bullish');
  if (conflictingBias) {
    reasons.push('tf_conflict_4h_vs_15m');
  }

  if (metrics.volumeCents24h < VOLUME_FLOOR_CENTS) {
    reasons.push('volume_below_floor');
  }

  const spreadBps = metrics.micro.spreadBps;
  if (spreadBps == null || !Number.isFinite(spreadBps)) {
    reasons.push('spread_missing');
  } else if (spreadBps > MAX_SPREAD_BPS) {
    reasons.push('spread_too_wide');
  }

  const depthFloorCents = getDepthFloorCents(strategy.aggressiveness);
  if (metrics.micro.bidDepthCents < depthFloorCents || metrics.micro.askDepthCents < depthFloorCents) {
    reasons.push('book_depth_thin');
  }

  const fillRate = metrics.performance.avgFillRate;
  if (fillRate == null || !Number.isFinite(fillRate)) {
    reasons.push('fill_rate_missing');
  } else if (fillRate < MIN_PASSIVE_FILL_RATE) {
    reasons.push('fill_rate_low');
  }

  const atrPct = metrics.atrPct;
  if (atrPct == null || !Number.isFinite(atrPct)) {
    reasons.push('atr_missing');
  } else {
    const minAtr = strategy.targetTpPct * 0.5;
    // 🔒 PROTECTION: Réduire maxAtr de 3x à 2x pour éviter les crashs rapides comme SAPIEN (-7.8% en minutes)
    const maxAtr = strategy.targetTpPct * 2;
    // 🔒 REACTIVE MODE: Hard cap at 2.5% ATR pour éviter les tokens ultra-volatils
    const reactiveMaxAtr = strategy.aggressiveness === 'reactive' ? 2.5 : maxAtr;
    const effectiveMaxAtr = Math.min(maxAtr, reactiveMaxAtr);
    
    if (atrPct < minAtr) {
      reasons.push('atr_too_low');
    } else if (atrPct > effectiveMaxAtr) {
      reasons.push('atr_too_high');
    }
  }

  const regime = metrics.regimeTag;
  switch (strategy.aggressiveness) {
    case 'conservative':
      if (regime === 'volatile' || regime === 'trending') {
        reasons.push('regime_mismatch');
      }
      break;
    case 'reactive':
      if (regime === 'volatile' && (atrPct ?? 0) > strategy.targetTpPct * 2.5) {
        reasons.push('regime_excessive_vol');
      }
      break;
    case 'aggressive':
      // aggressive mode prefers volatile/trending. Ranging/quiet still allowed but penalized later.
      break;
  }

  const perf = metrics.performance;
  const sampleThreshold = quality.family === 'major' ? 5 : 8;
  if (perf.sample >= sampleThreshold) {
    if (perf.winRate != null && Number.isFinite(perf.winRate) && perf.winRate < 35) {
      const ageHours = perf.lastTradeAt != null ? (now - perf.lastTradeAt) / 3_600_000 : null;
      reasons.push(ageHours != null && ageHours < PERFORMANCE_COOLDOWN_HOURS ? 'win_rate_cooldown' : 'win_rate_low');
    }
    if (perf.expectancyUsd != null && Number.isFinite(perf.expectancyUsd) && perf.expectancyUsd <= 0) {
      const ageHours = perf.lastTradeAt != null ? (now - perf.lastTradeAt) / 3_600_000 : null;
      reasons.push(ageHours != null && ageHours < PERFORMANCE_COOLDOWN_HOURS ? 'expectancy_cooldown' : 'expectancy_negative');
    }
  }

  if (
    perf.avgSlippageBps != null && Number.isFinite(perf.avgSlippageBps) &&
    spreadBps != null && Number.isFinite(spreadBps)
  ) {
    const spreadGuard = Math.max(5, spreadBps * 1.2);
    const slippageLimitBps = Math.min(spreadGuard, 18);
    if (perf.avgSlippageBps > slippageLimitBps) {
      reasons.push('slippage_vs_spread');
    }
  }

  if (reasons.some((reason) => reason.endsWith('cooldown'))) {
    // treat cooldown reasons as hard failure during cooldown window
    return { ok: false, reasons, score: metrics.baseScore };
  }

  if (reasons.includes('tf_conflict_4h_vs_15m')) {
    return { ok: false, reasons, score: metrics.baseScore };
  }

  if (reasons.includes('volume_below_floor') || reasons.includes('spread_missing') || reasons.includes('book_depth_thin')) {
    return { ok: false, reasons, score: metrics.baseScore };
  }

  if (reasons.includes('fill_rate_low') || reasons.includes('fill_rate_missing')) {
    return { ok: false, reasons, score: metrics.baseScore };
  }

  if (reasons.includes('atr_missing') || reasons.includes('atr_too_low') || reasons.includes('atr_too_high')) {
    return { ok: false, reasons, score: metrics.baseScore };
  }

  if (reasons.includes('expectancy_negative') || reasons.includes('win_rate_low') || reasons.includes('slippage_vs_spread')) {
    return { ok: false, reasons, score: metrics.baseScore };
  }

  // Soft penalties (regime mismatch for aggressive/conservative)
  let score = metrics.baseScore;
  const liquidityDenominator = depthFloorCents * BigInt(2);
  const liquidityRatio = liquidityDenominator > BigInt(0)
    ? Number(metrics.micro.bidDepthCents + metrics.micro.askDepthCents) / Number(liquidityDenominator)
    : 0;
  if (Number.isFinite(liquidityRatio) && liquidityRatio > 0) {
    if (liquidityRatio < 1) {
      const malus = Math.max(0.7, liquidityRatio * 0.9);
      score *= malus;
    } else if (liquidityRatio >= 1.15) {
      score *= Math.min(1.2, liquidityRatio);
    }
  }

  if (perf.sample >= sampleThreshold && perf.expectancyUsd != null && Number.isFinite(perf.expectancyUsd)) {
    score *= 1 + Math.max(-0.2, Math.min(0.25, perf.expectancyUsd / 200));
  }

  if (perf.winRate != null && Number.isFinite(perf.winRate) && perf.sample >= sampleThreshold) {
    score *= 1 + Math.max(-0.1, Math.min(0.15, (perf.winRate - 50) / 250));
  }

  if (strategy.aggressiveness === 'aggressive' && (regime === 'ranging' || regime === 'quiet')) {
    score *= 0.9;
  }
  if (strategy.aggressiveness === 'conservative' && regime === 'volatile') {
    score *= 0.85;
  }

  if (quality.isBlueChip) {
    score *= 1.1;
  } else if (quality.family === 'major') {
    score *= 1.05;
  }

  return { ok: true, reasons, score };
}

async function computeCandidateMetrics(
  symbol: string,
  performance: CryptoPerformanceEntry,
  ticker: any,
  exchange: any,
): Promise<CandidateMetrics | null> {
  const requestSymbol = typeof symbol === 'string' ? symbol.trim() : '';
  if (!requestSymbol) {
    console.debug('Skipping candidate with empty symbol');
    return null;
  }

  const volumeCents = numberToCents(performance.quoteVolume24h);
  if (volumeCents == null) {
    console.debug(`${requestSymbol}: Invalid volume data (${performance.quoteVolume24h})`);
    return null;
  }

  let spreadBps: number | null = null;
  const bid = Number(ticker?.bid ?? ticker?.info?.bid ?? NaN);
  const ask = Number(ticker?.ask ?? ticker?.info?.ask ?? NaN);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && ask > bid) {
    const mid = (bid + ask) / 2;
    spreadBps = ((ask - bid) / mid) * 10_000;
  }

  let book: CandidateMicrostructureSnapshot = {
    spreadBps,
    bidDepthCents: BigInt(0),
    askDepthCents: BigInt(0),
  };
  try {
    const marketSymbol = resolveExchangeSymbol(exchange, requestSymbol);
    if (!marketSymbol) {
      console.debug(`${requestSymbol}: Symbol not found in exchange markets - likely delisted or not available`);
      return null;
    }

    if (!shouldFetchOrderBook(marketSymbol)) {
      console.debug(`Throttling order book fetch for ${marketSymbol}`);
    } else {
      const ob = await exchange.fetchOrderBook(marketSymbol, 5);
      const obBid = Array.isArray(ob?.bids) ? ob.bids : [];
      const obAsk = Array.isArray(ob?.asks) ? ob.asks : [];
      const bestBid = obBid?.[0]?.[0];
      const bestAsk = obAsk?.[0]?.[0];
      if (spreadBps == null && Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestAsk > bestBid) {
        const mid = (bestBid + bestAsk) / 2;
        spreadBps = ((bestAsk - bestBid) / mid) * 10_000;
      }
      book = {
        spreadBps,
        bidDepthCents: sumDepthLevels(obBid as Array<[number, number]>),
        askDepthCents: sumDepthLevels(obAsk as Array<[number, number]>),
      };
    }
  } catch (error) {
    if (isMissingSymbolError(error)) {
      const message = typeof (error as any)?.message === 'string' ? (error as any).message : String(error);
      console.debug(`${requestSymbol}: Exchange validation failed - ${message}`);
      return null;
    }
    console.debug(`${requestSymbol}: Order book fetch warning - ${error}`);
  }

  let snapshot: TechnicalSnapshot;
  try {
    snapshot = await buildTechSnapshot(symbol);
  } catch (error) {
    if (isUnusableMarketDataError(error) && error.meta?.timeframe === '15m' && error.meta?.invalidRatio === 1) {
      console.debug(`${symbol}: All 15m market data invalid (ratio=1) - insufficient historical data or data quality issues`);
      recordOpsEvent({
        level: 'warn',
        source: 'tech_snapshot',
        message: 'skip_symbol_invalid_ratio',
        symbol,
        details: { timeframe: '15m', invalidRatio: error.meta.invalidRatio },
      });
      return null;
    }
    // Re-throw other errors to be handled by the caller
    throw error;
  }
  let multiTimeframe: MultiTimeframeDiagnostics | undefined;
  try {
    multiTimeframe = await computeMultiTimeframeDiagnostics(symbol);
  } catch (error) {
    console.warn(`⚠️ Failed to compute multi-timeframe diagnostics for ${symbol}:`, error);
  }
  const atrPct = Number(snapshot?.atrPct ?? snapshot?.atr14 ?? null);
  const regimeTag = deriveRegimeTag(snapshot?.regime, Number.isFinite(atrPct) ? atrPct : null);

  const performanceSnapshot = await fetchPerformanceSnapshot(requestSymbol);

  return {
    symbol: requestSymbol,
    baseScore: performance.combinedScore,
    volumeCents24h: volumeCents,
    lastPrice: performance.lastPrice,
    regimeTag,
    atrPct: Number.isFinite(atrPct) ? atrPct : null,
    micro: book,
    performance: performanceSnapshot,
    multiTimeframe,
  };
}

export async function getOptimizedCryptoList(
  excludeSessionId?: string,
  attempt: number = 1,
  options?: { strategy?: StrategyFilterProfile },
): Promise<string[]> {
  const maxAttempts = AUTO_UNIVERSE_MAX_ATTEMPTS;
  const retryDelayMs = 2000;
  const attemptLabel = Math.max(1, attempt);
  const cacheKey = createAutoUniverseCacheKey(options?.strategy);
  const cached = autoUniverseCache.get(cacheKey);
  const now = Date.now();

  if (cached) {
    if (now - cached.timestamp < AUTO_UNIVERSE_CACHE_DURATION_MS) {
      try {
        console.log('💾 Using cached auto universe snapshot');
        const cachedResult = await resolveCachedAutoUniverse(cached.result, excludeSessionId);
        if (cachedResult.length > 0) {
          return cachedResult;
        }
        console.log('⚠️ Cached auto universe was exhausted - rebuilding');
      } catch (error) {
        console.warn('⚠️ Failed to reuse cached auto universe:', error);
      }
    }
    autoUniverseCache.delete(cacheKey);
  }

  if (process.env.UNIT_TEST_MODE === 'true') {
    const syntheticUniverse = ['ETH/USDT:USDT', 'SOL/USDT:USDT', 'ADA/USDT:USDT', 'XRP/USDT:USDT'];
    storeAutoUniverseCache(cacheKey, { kind: 'fallback', symbols: syntheticUniverse });
    return applyActiveFilter(syntheticUniverse, excludeSessionId);
  }
  try {
    console.log('📊 Fetching top performing cryptos from last 24h...');
    
    // 🚫 ÉVITER LES CONFLITS: Récupérer les cryptos déjà actives (excluding current session)
    const activeSymbols = await getActiveAgentSymbols(excludeSessionId);
    if (activeSymbols.length > 0) {
      console.log(`🚫 Symbols already active: ${activeSymbols.join(', ')}`);
    }
    
    const { EXCHANGE_ID } = getConfig();
    const ExchangeClass = (ccxt as any)[EXCHANGE_ID];

    if (!ExchangeClass) {
      console.log('📊 Exchange not available, using static top 20 cryptos list');
      const fallback = await getTopCryptos(excludeSessionId);
      storeAutoUniverseCache(cacheKey, { kind: 'fallback', symbols: fallback });
      return fallback;
    }

    const exchange = new ExchangeClass({
      enableRateLimit: true,
      timeout: 20_000,
      options: { defaultType: 'swap' }
    });

    const isBinanceExchange = String((exchange as any)?.id || '').toLowerCase().includes('binance');
    let markets: Record<string, any> = {};

    if (isBinanceExchange) {
      const CACHE_KEY = 'binance_perpetuals_cache';
      try {
        const { markets: binanceMarkets, count, source } = await fetchBinancePerpetualMarkets(CACHE_KEY, {
          getWsTickers: getAllTickersFromWebSocket,
        });
        markets = binanceMarkets;
        console.log(`📊 Using ${count} Binance perpetual markets from ${source}`);
      } catch (error) {
        console.error('❌ Failed to load Binance perpetual markets:', error);
        console.log('📊 Falling back to static Binance perpetual list');
        const binancePerpetuals = [
          'BTC/USDT','ETH/USDT','BNB/USDT','ADA/USDT','XRP/USDT','SOL/USDT','DOT/USDT','DOGE/USDT',
          'AVAX/USDT','LTC/USDT','MATIC/USDT','ALGO/USDT','VET/USDT','ICP/USDT','FIL/USDT','TRX/USDT',
          'ETC/USDT','XLM/USDT','THETA/USDT','FTM/USDT','HBAR/USDT','EGLD/USDT','NEAR/USDT','FLOW/USDT'
        ];
        markets = {};
        for (const symbol of binancePerpetuals) {
          const base = symbol.split('/')[0];
          markets[symbol] = { symbol, swap: true, type: 'swap', active: true, settle: 'USDT', base, quote: 'USDT' };
        }
      }
      if (typeof (exchange as any).setMarkets === 'function') {
        (exchange as any).setMarkets(markets, Object.values(markets));
      } else {
        (exchange as any).markets = markets;
        (exchange as any).symbols = Object.keys(markets);
      }
    } else {
      let loadAttempt = 0;
      while (loadAttempt < 3) {
        try {
          loadAttempt += 1;
          await exchange.loadMarkets();
          break;
        } catch (error) {
          if (isRequestTimeoutError(error) && loadAttempt < 3) {
            const delay = Math.min(2_000 * 2 ** (loadAttempt - 1), 15_000);
            console.warn(`⚠️ ${exchange.id} loadMarkets timeout (attempt ${loadAttempt}), retrying in ${delay}ms...`);
            await waitFor(delay);
            continue;
          }
          throw error;
        }
      }
      markets = exchange.markets || {};
    }

    // Get all markets and filter for USD-settled perpetuals (Crypto.com format)
    const allMarkets = Object.keys(markets || {});
    console.log(`📊 Found ${allMarkets.length} total markets`);
    
    const perpetualMarkets = allMarkets.filter(symbol => {
      try {
        if (!symbol || typeof symbol !== 'string') return false;
        
        const market = markets[symbol]; // Use markets directly for Binance
        if (!market) return false;
        
        // Handle different formats: Binance (USDT) vs Crypto.com (USD:USD)
        if (isBinanceExchange) {
          return market.swap === true && 
                 market.active === true &&
                 (market.settle === 'USDT' || market.quote === 'USDT');
        } else {
          // Crypto.com uses USD-settled perpetuals in format: SYMBOL/USD:USD
          return market.swap === true && 
                 market.active === true &&
                 market.settle === 'USD' && // USD-settled perpetuals
                 symbol.includes('/USD:USD'); // Perpetual format on Crypto.com
        }
      } catch (error) {
        return false;
      }
    });
    
    console.log(`📊 Found ${perpetualMarkets.length} perpetual markets, fetching tickers...`);
    
    if (perpetualMarkets.length === 0) {
      console.log('📊 No perpetual markets found, falling back to static list');
      const fallback = await getTopCryptos(excludeSessionId);
      storeAutoUniverseCache(cacheKey, { kind: 'fallback', symbols: fallback });
      return fallback;
    }

    // Fetch MORE tickers to get better selection - PRIORITIZE major cryptos
    const sampleSize = Math.min(perpetualMarkets.length, 100); // Analyze more markets for better selection
    
    // DYNAMIC DISCOVERY: Sort all markets by volume for intelligent prioritization
    console.log('🔍 Performing dynamic market discovery based on real-time volumes...');
    
    // Fetch ALL tickers first to get real volumes
    const allTickers = {} as Record<string, any>;
    console.log('📊 Fetching volumes for dynamic ranking...');

    let wsTickerMap: Map<string, BinanceTickerData> | null = null;
    if (isBinanceExchange) {
      try {
        wsTickerMap = await getAllTickersFromWebSocket();
        if (!wsTickerMap) {
          console.warn('⚠️ Binance WebSocket tickers unavailable, using REST fallback.');
        } else {
          console.log(`✅ Using Binance WebSocket: ${wsTickerMap.size} tickers available (0 weight)`);
        }
      } catch (error) {
        console.warn('⚠️ Failed to load Binance WebSocket tickers, using REST fallback:', error);
        wsTickerMap = null;
      }
    }

    for (let i = 0; i < Math.min(perpetualMarkets.length, 150); i++) { // Analyze more for better discovery
      const symbol = perpetualMarkets[i];
      try {
        if (wsTickerMap) {
          const wsSymbol = toBinanceSymbolId(symbol);
          const wsTicker = wsTickerMap.get(wsSymbol);
          if (wsTicker) {
            allTickers[symbol] = adaptBinanceTickerToCcxt(symbol, wsTicker);
            continue;
          }
        }

        // Fallback REST only for non-Binance or WebSocket miss
        const requestSymbol = isBinanceExchange ? toBinanceSwapSymbol(symbol) : symbol;
        const ticker = await fetchTickerWithRetry(exchange, requestSymbol, symbol);
        if (ticker) {
          allTickers[symbol] = ticker;
        }
      } catch (error) {
        // Skip failed tickers
      }
    }
    
    // Sort by volume DESC to prioritize high-activity cryptos
    const volumeSortedMarkets = Object.entries(allTickers)
      .map(([symbol, ticker]) => ({
        symbol,
        volume: Number((ticker as any).quoteVolume || 0),
        ticker
      }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, sampleSize)
      .map(item => item.symbol);
    
    const sampleMarkets = volumeSortedMarkets;
    console.log(`🎯 Dynamic discovery selected top ${sampleMarkets.length} cryptos by volume`);
    
    // Use already fetched tickers from dynamic discovery
    const tickers = {};
    console.log(`📊 Using dynamically discovered ${sampleMarkets.length} top-volume perpetual markets...`);
    
    for (const symbol of sampleMarkets) {
      if (allTickers[symbol]) {
        tickers[symbol] = allTickers[symbol];
        const ticker = allTickers[symbol] as any;
        console.log(`✅ ${symbol}: ${ticker.percentage?.toFixed(2) || 0}% change, volume: $${((ticker.quoteVolume || 0) / 1000000).toFixed(2)}M`);
      }
    }
    
    const tickerCount = Object.keys(tickers).length;
    console.log(`📊 Successfully fetched ${tickerCount} tickers`);
    if (tickerCount < 10) {
      const reason = 'insufficient_tickers';
      console.warn(JSON.stringify({ level: 'warn', event: 'auto_select_universe_fallback', reason, attempt: attemptLabel, ticker_count: tickerCount }));
      updateAutoUniverseStatus({
        source: 'fallback_dynamic',
        attempt: attemptLabel,
        candidateCount: tickerCount,
        reason,
        ts: Date.now(),
      });
      if (attemptLabel < maxAttempts) {
        await waitFor(retryDelayMs * attemptLabel);
        return getOptimizedCryptoList(excludeSessionId, attemptLabel + 1, options);
      }
    }
    
    // Convert to array et calcul VRAI changement 24h
    const cryptoPerformance = Object.entries(tickers).map(([symbol, ticker]) => {
      const tickerData = ticker as any;

      // 🔥 CALCUL VRAI CHANGEMENT 24H (pour AVNT -21.9% au lieu de -0.22%)
      const currentPrice = Number(tickerData.last || tickerData.close || tickerData.ask || 0);
      const openPrice = Number(tickerData.open || currentPrice);
      const realChange24h = openPrice > 0 ? ((currentPrice - openPrice) / openPrice) * 100 : Number(tickerData.percentage || 0);

      const quoteVolume24h = volumeUsdFromTicker(tickerData);
      const volume24h = quoteVolume24h; // keep naming compatibility
      const change24h = realChange24h; // 🔥 Utilise le vrai changement

      const liquidityGuardrail = evaluateSymbolLiquidityGuardrails(symbol, quoteVolume24h, currentPrice);
      if (!liquidityGuardrail.ok) {
        console.log(`🚫 ${symbol} rejected: ${liquidityGuardrail.reason} (volUsd=$${(quoteVolume24h/1_000_000).toFixed(2)}M, required ≥ $${((liquidityGuardrail.minRequired || 0)/1_000_000).toFixed(1)}M)`);
        return null;
      }

      // SÉCURITÉ: Scoring strict avec validation volume
      const volumeScore = calculateVolumeComponent(quoteVolume24h); // Utilise fonction sécurisée
      const performanceScore = Math.abs(change24h); // Direct percentage

      // Calcul du score de mouvement (Phase 3)
      const movementScore = calculatePriceMovementComponent(change24h);

      // 🎯 SMART QUALITY SCORING: Objective criteria based
      let combinedScore = 0;
      const smartQuality = applySmartQualityAdjustments({
        symbol,
        volumeUsd: quoteVolume24h,
        movement: change24h,
        avgVolatility: 2.0, // Default typical daily movement
        setupQuality: volumeScore, // Use volume score as proxy for now
      });

      // 📊 Filtrage par mouvement minimum requis (based on liquidity, not name)
      const absChange = Math.abs(change24h);
      if (absChange < smartQuality.minMovement) {
        console.log(`🚫 ${symbol} (${smartQuality.label}): Movement ${change24h.toFixed(2)}% below threshold ${smartQuality.minMovement}% for this liquidity level`);
        return null; // Skip - insufficient movement for liquidity profile
      }

      if (volumeScore >= 5.0) { // Seuil volume de base
        // 🎯 SMART QUALITY: Objective scoring without name bias
        // - Liquidity adjustments (execution quality)
        // - Spread adjustments (trading costs)
        // - Volatility-adjusted movement (exceptional opportunities)
        // - Technical setup quality
        combinedScore = (performanceScore * 0.25) + (volumeScore * 0.25) + (movementScore * 0.20) + smartQuality.adjustments;

        console.log(`✅ ${symbol} (${smartQuality.label}): Score=${combinedScore.toFixed(2)}`);
        smartQuality.reasons.forEach(r => console.log(`   ${r}`));
      } else {
        console.log(`🚫 Score volume ${volumeScore} insuffisant pour ${symbol}`);
      }

      return {
        symbol,
        change24h,
        volume24h,
        quoteVolume24h,
        combinedScore,
        absChange: Math.abs(change24h),
        volumeScore,
        performanceScore,
        lastPrice: currentPrice,
      };
    }).filter((crypto): crypto is CryptoPerformanceEntry => {
      if (!crypto) return false;

      // Smart eligibility (dynamic)
      const base = crypto.symbol.split("/")[0];
      const elig = isSymbolEligibleForAuto(base, { last: crypto.lastPrice, volumeUsd: crypto.quoteVolume24h });
      if (!elig.ok) {
        console.log(`🚫 ${crypto.symbol} rejected: ${elig.reason} (volUsd=$${(crypto.quoteVolume24h/1_000_000).toFixed(2)}M, required: $${(elig.minRequired || 0)/1_000_000}M)`);
        return false;
      }

      // DYNAMIC FILTERING based on volume with stricter guardrails
      const volumeUsd = crypto.quoteVolume24h;
      const isHighVolumeAsset = volumeUsd >= 200_000_000; // $200M+ = institutional grade
      const isMediumVolumeAsset = volumeUsd >= 75_000_000; // $75M+ = strong liquidity
      const isBaselineVolumeAsset = volumeUsd >= 35_000_000; // $35M+ = acceptable floor

      if (isHighVolumeAsset) {
        if (crypto.absChange < 0.5) return false; // Need at least 0.5% move on mega liquidity
      } else if (isMediumVolumeAsset) {
        if (crypto.absChange < 1.0) return false; // Require 1% move on solid liquidity
      } else if (isBaselineVolumeAsset) {
        if (crypto.absChange < 2.0) return false; // Smaller caps need bigger dislocations
      } else {
        // Below $35M we rely on guardrails to filter out by default
        return false;
      }

      return true;
    }) as CryptoPerformanceEntry[];

    if (cryptoPerformance.length === 0) {
      const reason = 'no_dynamic_candidates';
      console.warn(JSON.stringify({ level: 'warn', event: 'auto_select_universe_fallback', reason, attempt: attemptLabel, ticker_count: tickerCount }));
      updateAutoUniverseStatus({
        source: 'fallback_dynamic',
        attempt: attemptLabel,
        candidateCount: 0,
        reason,
        ts: Date.now(),
      });
      if (attemptLabel < maxAttempts) {
        await waitFor(retryDelayMs * attemptLabel);
        return getOptimizedCryptoList(excludeSessionId, attemptLabel + 1, options);
      }
    }

    // Sort by combined score descending
    cryptoPerformance.sort((a, b) => b.combinedScore - a.combinedScore);
    
    console.log(`🎯 Performance analysis complete:`);
    console.log(`   📊 Total analyzed: ${Object.keys(tickers).length} perpetuals`);
    console.log(`   ✅ Qualifying cryptos: ${cryptoPerformance.length}`);
    console.log(`   🏆 Top 5 performers by score:`);
    cryptoPerformance.slice(0, 5).forEach((crypto, i) => {
      console.log(`      ${i+1}. ${crypto.symbol}: ${crypto.change24h.toFixed(3)}% change, $${(crypto.quoteVolume24h/1000000).toFixed(2)}M vol, score: ${crypto.combinedScore.toFixed(2)}`);
    });
    
    const strategyProfile: StrategyFilterProfile = options?.strategy ?? {
      aggressiveness: 'reactive',
      targetTpPct: Math.max(1.2, Number(getConfig().TARGET_TP1_PCT ?? getConfig().MIN_TP_PCT ?? 1.2)),
      stopLossPct: Math.max(0.4, Number(getConfig().MIN_STOP_PCT ?? 0.6)),
    };

    const enriched: { symbol: string; score: number; reasons: string[] }[] = [];
    const evaluationDiagnostics: { symbol: string; reasons: string[] }[] = [];
    const shortlist = cryptoPerformance.slice(0, 30);
    for (const entry of shortlist) {
      try {
        const metrics = await computeCandidateMetrics(entry.symbol, entry, tickers[entry.symbol], exchange);
        if (!metrics) {
          // metrics is null - this typically means symbol validation failed, market data unavailable,
          // or symbol not available on exchange. Individual debug logs are emitted by computeCandidateMetrics.
          evaluationDiagnostics.push({ symbol: entry.symbol, reasons: ['metrics_computation_failed'] });
          continue;
        }
        const evaluation = evaluateCandidateAgainstFilters(metrics, strategyProfile, Date.now());
        if (evaluation.ok) {
          enriched.push({ symbol: entry.symbol, score: evaluation.score, reasons: evaluation.reasons });
        } else {
          evaluationDiagnostics.push({ symbol: entry.symbol, reasons: evaluation.reasons });
        }
      } catch (error) {
        if (isInsufficientDataError(error)) {
          console.debug(`ℹ️ Skipping candidate ${entry.symbol} due to insufficient data (${error.meta?.timeframe ?? 'unknown'}).`, {
            timeframe: error.meta?.timeframe,
            availableBars: error.meta?.availableBars,
            firstBarAt: error.meta?.firstBarAt,
            warmupState: error.meta?.warmupState,
          });
          evaluationDiagnostics.push({ symbol: entry.symbol, reasons: ['insufficient_data'] });
          continue;
        }
        console.warn(`⚠️ Failed to evaluate candidate ${entry.symbol}:`, error);
        evaluationDiagnostics.push({ symbol: entry.symbol, reasons: ['evaluation_error'] });
      }
    }

    if (!enriched.length) {
      console.warn('⚠️ Liquidity/performance filters rejected all candidates');
      
      // Group diagnostics by reason for better visibility
      const reasonGroups = new Map<string, string[]>();
      evaluationDiagnostics.forEach((diag) => {
        const reason = diag.reasons.join(', ') || 'unknown';
        if (!reasonGroups.has(reason)) {
          reasonGroups.set(reason, []);
        }
        reasonGroups.get(reason)!.push(diag.symbol);
      });
      
      // Log grouped results
      reasonGroups.forEach((symbols, reason) => {
        console.warn(`   [${reason}]: ${symbols.length} symbols`);
        if (symbols.length <= 5) {
          // Show all symbols if <= 5
          symbols.forEach(sym => console.warn(`      ${sym}`));
        } else {
          // Show first 3 and count
          symbols.slice(0, 3).forEach(sym => console.warn(`      ${sym}`));
          console.warn(`      ... and ${symbols.length - 3} more`);
        }
      });
      
      const reason = 'filters_rejected_all';
      updateAutoUniverseStatus({
        source: 'fallback_dynamic',
        attempt: attemptLabel,
        candidateCount: 0,
        reason,
        ts: Date.now(),
      });
      if (attemptLabel < maxAttempts) {
        await waitFor(retryDelayMs * attemptLabel);
        return getOptimizedCryptoList(excludeSessionId, attemptLabel + 1, options);
      }
    }

    // Take top performers after gating and keep original symbol format for analysis
    const topPerformers = enriched
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((item) => item.symbol);
    
    // 🚫 ÉVITER LES CONFLITS: Filtrer les cryptos déjà actives avec gestion intelligente
    // PRIORISATION: Mouvement >3% = priorité absolue, >2% = agent supplémentaire autorisé
    const availablePerformers: string[] = [];
    const prioritySymbols: string[] = [];
    
    for (const symbol of topPerformers) {
      const isActive = activeSymbols.includes(symbol);
      const base = symbol.split('/')[0];
      const performance = cryptoPerformance.find(p => p.symbol.startsWith(base + '/'));
      const absChange = performance ? Math.abs(performance.change24h) : 0;
      
      // 🎯 PRIORITÉ ABSOLUE: Mouvement >3% (même si agents actifs)
      if (absChange > 3.0 && performance) {
        const activeCount = await getActiveAgentCountForSymbol(symbol);
        if (activeCount < 2) { // Max 2 agents par symbole
          prioritySymbols.push(symbol);
          console.log(`🔥 PRIORITY symbol ${symbol}: ${performance.change24h > 0 ? '+' : ''}${performance.change24h.toFixed(2)}% (${activeCount} agents active)`);
        }
        continue;
      }
      
      // 🎯 AGENT SUPPLÉMENTAIRE: Mouvement >2%
      if (isActive && absChange > 2.0 && performance) {
        const activeCount = await getActiveAgentCountForSymbol(symbol);
        if (activeCount < 2) {
          availablePerformers.push(symbol);
          console.log(`🎯 Additional agent on ${symbol}: ${performance.change24h > 0 ? '+' : ''}${performance.change24h.toFixed(2)}% (${activeCount} active)`);
        } else {
          console.log(`🚫 Max agents reached for ${symbol} (${activeCount} active)`);
        }
        continue;
      }
      
      // 📊 SÉLECTION NORMALE: Pas d'agents actifs
      if (!isActive) {
        availablePerformers.push(symbol);
      } else {
        console.log(`🚫 Skipping ${symbol} - already active, insufficient movement`);
      }
    }
    
    // Combiner les priorités et les performers normaux
    const finalPerformers = [...prioritySymbols, ...availablePerformers];

    if (finalPerformers.length > 0) {
      let orderedPerformers = finalPerformers
        .map(symbol => ({ symbol, rank: symbolQualityRank(symbol) }))
        .sort((a, b) => a.rank - b.rank)
        .map(item => item.symbol);

      const prioritySet = new Set(prioritySymbols);
      const performanceForTrend = cryptoPerformance.filter(entry => finalPerformers.includes(entry.symbol));
      const { ordering: trendWeighted } = await applyTrendWeighting(orderedPerformers, performanceForTrend, prioritySet);
      orderedPerformers = trendWeighted;

      console.log(`✅ Selected ${finalPerformers.length} performers (${prioritySymbols.length} priority + ${availablePerformers.length} normal)`);
      if (prioritySymbols.length > 0) {
        console.log('🔥 Priority symbols (>3%):', prioritySymbols.slice(0, 3));
      }
      console.log('🏆 Top available (trend-weighted):', orderedPerformers.slice(0, 5));
      updateAutoUniverseStatus({
        source: 'dynamic',
        attempt: attemptLabel,
        candidateCount: orderedPerformers.length,
        reason: 'dynamic_ready',
        ts: Date.now(),
      });
      storeAutoUniverseCache(cacheKey, {
        kind: 'dynamic',
        orderedPerformers,
        performanceSnapshot: cryptoPerformance.map((entry) => ({
          base: extractPerpBase(entry.symbol) ?? entry.symbol.split('/')[0] ?? entry.symbol,
          change24h: entry.change24h,
        })),
      });
      return orderedPerformers;
    } else {
      const reason = 'top_performers_conflict';
      console.log('⚠️ All top performers at capacity - falling back to static list without active ones');
      console.warn(JSON.stringify({ level: 'warn', event: 'auto_select_universe_fallback', reason, attempt: attemptLabel, candidate_count: cryptoPerformance.length }));
      const staticFallback = await getTopCryptos(excludeSessionId);
      const fallbackList = staticFallback.length > 0 ? staticFallback : await getTopCryptos(excludeSessionId);
      updateAutoUniverseStatus({
        source: 'fallback_static',
        attempt: attemptLabel,
        candidateCount: fallbackList.length,
        reason,
        retryScheduledMs: AUTO_UNIVERSE_RETRY_DEFAULT_MS,
        ts: Date.now(),
      });
      await scheduleAutoUniverseRetry(excludeSessionId, AUTO_UNIVERSE_RETRY_DEFAULT_MS);
      storeAutoUniverseCache(cacheKey, { kind: 'fallback', symbols: fallbackList });
      return fallbackList;
    }

  } catch (error) {
    console.error('Error getting dynamic crypto list:', error);
    console.log('📊 Falling back to static top cryptos list');
    const fallbackList = await getTopCryptos(excludeSessionId);
    updateAutoUniverseStatus({
      source: 'fallback_static',
      attempt: attemptLabel,
      candidateCount: fallbackList.length,
      reason: 'exception_fallback',
      retryScheduledMs: AUTO_UNIVERSE_RETRY_DEFAULT_MS,
      ts: Date.now(),
    });
    await scheduleAutoUniverseRetry(excludeSessionId, AUTO_UNIVERSE_RETRY_DEFAULT_MS);
    storeAutoUniverseCache(cacheKey, { kind: 'fallback', symbols: fallbackList });
    return fallbackList; // Fallback to our curated list
  }
}

export type { CandidateMetrics };
export { evaluateCandidateAgainstFilters };

export const __autoUniverseTestHooks = {
  clearCache(): void {
    autoUniverseCache.clear();
  },
  getCacheKey(strategy?: StrategyFilterProfile): string {
    return createAutoUniverseCacheKey(strategy);
  },
  setCacheEntry(key: string, result: CachedAutoUniverseResult, timestamp: number = Date.now()): void {
    autoUniverseCache.set(key, { result, timestamp });
  },
  resolveCached(
    cached: CachedAutoUniverseResult,
    excludeSessionId?: string,
    deps?: Partial<AutoUniverseDependencyBag>,
  ): Promise<string[]> {
    const effectiveDeps: AutoUniverseDependencyBag = {
      ...defaultAutoUniverseDeps,
      ...(deps ?? {}),
    } as AutoUniverseDependencyBag;
    return resolveCachedAutoUniverse(cached, excludeSessionId, effectiveDeps);
  },
  async fetchBinanceMarketsForTests(options?: { fetchImpl?: FetchImpl; disableCache?: boolean; cacheKey?: string }) {
    const cacheKey = options?.cacheKey ?? `binance_perpetuals_cache_${Date.now()}`;
    return fetchBinancePerpetualMarkets(cacheKey, {
      fetchImpl: options?.fetchImpl,
      disableCache: options?.disableCache ?? false,
      getWsTickers: null,
    });
  },
};

export const __intelligentAgentTestHooks = {
  shouldDeferDueToRecentActivity,
  resolveExchangeSymbol,
  shouldFetchOrderBook,
  isMissingSymbolError,
  resetOrderBookThrottle,
};

/**
 * Top cryptos by volume/market cap - focus on liquid markets only
 * Filters out symbols already active in other agents
 */
const FALLBACK_STATIC_SYMBOLS = [
  'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'ADA/USDT',
  'AVAX/USDT', 'DOT/USDT', 'MATIC/USDT', 'LINK/USDT', 'LTC/USDT', 'UNI/USDT',
  'ATOM/USDT', 'NEAR/USDT', 'FIL/USDT', 'TRX/USDT', 'XLM/USDT', 'BCH/USDT',
  'ETC/USDT', 'APT/USDT', 'OP/USDT', 'ARB/USDT', 'SUI/USDT', 'INJ/USDT',
  'AAVE/USDT', 'RNDR/USDT', 'TIA/USDT', 'SEI/USDT', 'IMX/USDT', 'DYDX/USDT',
  'HBAR/USDT', 'ALGO/USDT', 'MKR/USDT', 'PYTH/USDT', 'JUP/USDT', 'TON/USDT'
];

async function getTopCryptos(excludeSessionId?: string): Promise<string[]> {
  try {
    const { EXCHANGE_ID } = getConfig();
    const ExchangeClass = (ccxt as any)[EXCHANGE_ID];
    if (!ExchangeClass) throw new Error('Unknown exchange ' + EXCHANGE_ID);

    const exchange = new ExchangeClass({
      enableRateLimit: true,
      timeout: 20_000,
      options: { defaultType: 'swap' }
    });

    const isBinanceExchange = String((exchange as any)?.id || '').toLowerCase().includes('binance');
    let markets: Record<string, any> = {};

    if (isBinanceExchange) {
      try {
      const { markets: binanceMarkets, count, source } = await fetchBinancePerpetualMarkets('binance_perpetuals_cache', {
        getWsTickers: getAllTickersFromWebSocket,
      });
        markets = binanceMarkets;
        console.log(`📊 Using ${count} Binance perpetual markets from ${source}`);
      } catch (error) {
        console.error('❌ Failed to load Binance perpetual markets:', error);
        markets = {};
        for (const symbol of FALLBACK_STATIC_SYMBOLS) {
          const base = symbol.split('/')[0];
          markets[symbol] = {
            symbol,
            swap: true,
            type: 'swap',
            active: true,
            settle: 'USDT',
            base,
            quote: 'USDT',
          };
        }
      }
    } else {
      await exchange.loadMarkets();
      markets = exchange.markets || {};
    }

    const usdPerps = Object.values(markets).filter((market: any) => {
      if (!market) return false;
      const isSwap = market.swap === true || market.type === 'swap';
      if (!isSwap) return false;
      if (market.active === false) return false;
      const settle = (market.settle || market.quote || '').toUpperCase();
      return settle === 'USD' || settle === 'USDT';
    });

    if (usdPerps.length === 0) {
      console.warn('⚠️ No USD-settled perpetuals detected on exchange, using static fallback');
      return applyActiveFilter(FALLBACK_STATIC_SYMBOLS, excludeSessionId);
    }

    const volumeScore = (market: any) => {
      const info = market?.info || {};
      const candidates = [
        info.volumeUsd24h,
        info.turnover24h,
        info.volume24h,
        info.volume,
        market?.baseVolume,
        market?.quoteVolume
      ];
      for (const value of candidates) {
        const num = Number(value);
        if (!Number.isNaN(num) && num > 0) return num;
      }
      return 0;
    };

    usdPerps.sort((a, b) => volumeScore(b) - volumeScore(a));

    const normalized = usdPerps.map((market: any) => {
      const base = (market.base || '').toUpperCase();
      const symbol = market.symbol || '';
      if (symbol.includes('/USDT')) return `${base}/USDT`;
      if (symbol.includes('/USD:USD')) return `${base}/USDT`;
      if (symbol.includes('/USD')) return `${base}/USDT`;
      return `${base}/USDT`;
    });

    const uniqueSymbols = normalized.filter((symbol: string, idx: number, arr: string[]) => symbol && arr.indexOf(symbol) === idx);
    const topSymbols = uniqueSymbols.slice(0, 40);

    console.log(`📊 Derived ${topSymbols.length} fallback symbols directly from ${EXCHANGE_ID} markets`);
    
    // Apply volume filtering to fallback symbols
    const filteredSymbols: string[] = [];
    for (const symbol of topSymbols) {
      try {
        const ticker = await getTicker(symbol);
        if (ticker) {
          const volumeUsd = volumeUsdFromTicker(ticker);
          const last = Number(ticker.last || 0);
          const eligibility = isSymbolEligibleForAuto(symbol.split('/')[0], { last, volumeUsd });
          if (eligibility.ok) {
            filteredSymbols.push(symbol);
          } else {
            console.log(`🚫 Fallback symbol ${symbol} rejected: ${eligibility.reason} (vol: $${(volumeUsd/1000).toFixed(0)}K, required: $${(eligibility.minRequired!/1000).toFixed(0)}K)`);
          }
        }
      } catch (error) {
        console.log(`⚠️ Failed to check volume for fallback symbol ${symbol}:`, error);
      }
    }
    
    console.log(`📊 After volume filtering: ${filteredSymbols.length} eligible fallback symbols`);
    return applyActiveFilter(filteredSymbols, excludeSessionId);
  } catch (error) {
    console.error('Error generating dynamic fallback list:', error);
    // Apply volume filtering to static fallback symbols
    const filteredStatic: string[] = [];
    for (const symbol of FALLBACK_STATIC_SYMBOLS) {
      try {
        const ticker = await getTicker(symbol);
        if (ticker) {
          const volumeUsd = volumeUsdFromTicker(ticker);
          const last = Number(ticker.last || 0);
          const eligibility = isSymbolEligibleForAuto(symbol.split('/')[0], { last, volumeUsd });
          if (eligibility.ok) {
            filteredStatic.push(symbol);
          } else {
            console.log(`🚫 Static fallback symbol ${symbol} rejected: ${eligibility.reason} (vol: $${(volumeUsd/1000).toFixed(0)}K, required: $${(eligibility.minRequired!/1000).toFixed(0)}K)`);
          }
        }
      } catch (error) {
        console.log(`⚠️ Failed to check volume for static fallback symbol ${symbol}:`, error);
      }
    }
    console.log(`📊 After volume filtering: ${filteredStatic.length} eligible static fallback symbols`);
    return applyActiveFilter(filteredStatic, excludeSessionId);
  }
}

async function applyActiveFilter(symbols: string[], excludeSessionId?: string): Promise<string[]> {
  try {
    const activeSymbols = await getActiveAgentSymbols(excludeSessionId);
    const activeSet = new Set(activeSymbols.map((s) => normalizeUnifiedSymbol(s)));
    const seen = new Set<string>();
    const available: string[] = [];

    for (const symbol of symbols) {
      if (!symbol) continue;
      const unified = normalizeUnifiedSymbol(symbol);
      if (!unified || activeSet.has(unified) || seen.has(unified)) {
        continue;
      }
      seen.add(unified);
      available.push(symbol);
    }

    if (available.length > 0) {
      console.log(`📊 Fallback list after conflict filter: ${available.length} available (${symbols.length - available.length} filtered)`);
      return available;
    }

    console.log('⚠️ All candidates currently active - probing static fallback universe');
    const fallbackSeen = new Set(seen);
    const fallback: string[] = [];
    for (const fallbackSymbol of getFallbackSymbols()) {
      if (!fallbackSymbol) continue;
      const preferred = ensurePreferredPerpSymbol(fallbackSymbol);
      const unified = normalizeUnifiedSymbol(preferred);
      if (!unified || activeSet.has(unified) || fallbackSeen.has(unified)) continue;
      fallbackSeen.add(unified);
      fallback.push(preferred);
    }

    if (fallback.length > 0) {
      console.log(`✅ Static fallback supplied ${fallback.length} alternate symbols`);
      return fallback;
    }

    console.log('🚫 No alternate symbols available after filtering');
    return [];
  } catch (error) {
    console.error('Error filtering fallback symbols:', error);
    return symbols;
  }
}

function ensurePreferredPerpSymbol(symbol: string): string {
  if (!symbol) return symbol;
  if (symbol.includes(':')) return symbol;
  const parts = symbol.split('/');
  if (parts.length !== 2) return symbol;
  const [base, quote] = parts;
  if (!quote) return symbol;
  if (quote.toUpperCase() === 'USDT') {
    return `${base}/USDT`;
  }
  return symbol;
}

/**
 * Emergency fallback symbols - Bitcoin moved to last position
 */
function getFallbackSymbols(): string[] {
  return ['ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'BNB/USDT', 'BTC/USDT'];
}

/**
 * Optimized scoring algorithm - technical analysis first, minimal IA usage
 */
export async function calculateIntelligentScore(symbol: string, opts?: { aggressiveness?: 'conservative'|'reactive'|'aggressive'; excludeSessionId?: string }): Promise<IntelligentAnalysis | null> {
  try {
    console.log(`🔍 Analyzing ${symbol}...`);
    let multiTimeframe: MultiTimeframeDiagnostics | null = null;
    
    // Get technical snapshot first (no IA cost)
    let technical;
    try {
      technical = await buildTechSnapshot(symbol);
    } catch (error) {
      if (isUnusableMarketDataError(error)) {
        console.warn(`⚠️ Skipping ${symbol} due to unusable market data:`, error.meta);
        return null;
      }
      throw error;
    }
    const ticker = await getTicker(symbol);
    
    if (!technical || !ticker) {
      console.log(`❌ ${symbol}: Missing data - technical:${!!technical}, ticker:${!!ticker}`);
      return null;
    }

    // Normalize volume for logs: prefer USD when available
    const volBaseLog = Number((ticker as any)?.baseVolume || 0);
    const lastPxLog = Number((ticker as any)?.last || 0);
    const volUsdLog = Number((ticker as any)?.quoteVolume || 0) || (volBaseLog > 0 && lastPxLog > 0 ? volBaseLog * lastPxLog : 0);
    const volLog = volUsdLog ? `$${(volUsdLog/1_000_000).toFixed(2)}M` : String(volBaseLog);
    // 🔥 CALCUL VRAI CHANGEMENT 24H (AVNT -21.9% vs -0.22%)
    const currentPrice = Number(ticker.last || ticker.close || 0);
    const rawOpen = Number(ticker.open);
    const hasValidOpen = Number.isFinite(rawOpen) && rawOpen > 0;
    let openPrice = hasValidOpen ? rawOpen : currentPrice;
    let realChange24h = 0;
    if (hasValidOpen) {
      realChange24h = ((currentPrice - openPrice) / openPrice) * 100;
    } else if (Number.isFinite(Number(ticker.percentage))) {
      realChange24h = Number(ticker.percentage);
    }
    if (Math.abs(realChange24h) < 0.01 && Number.isFinite(Number(ticker.percentage))) {
      // Some exchanges (or REST fallbacks) don't provide open price; use percentage to avoid zero-momentum artifacts
      realChange24h = Number(ticker.percentage);
    }
    
    console.log(`📊 ${symbol}: RSI=${technical.rsi14}, ADX=${technical.adx14}, Vol=${volLog}, Change=${realChange24h.toFixed(2)}% (real 24h)`);

    // OPTIMISATION IA: Utilise l'IA intelligemment pour économiser les coûts
    let sentiment: any = null;
    const change24h = realChange24h;
    const majorCryptos = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'SUI/USDT', 'XRP/USDT', 'ADA/USDT', 'DOGE/USDT'];
    
    // HYBRID INTELLIGENT: ML d'abord, IA seulement si nécessaire
    const currentVolumeUsd = Number((ticker as any)?.quoteVolume || 0);
    
    // 🐦 GROK SENTIMENT FIRST: Twitter/X real-time sentiment (BEST for crypto)
    try {
      const grokSentiment = await getHybridSentiment(symbol);
      if (grokSentiment && grokSentiment.confidence && grokSentiment.confidence > 0.5) {
        sentiment = {
          overall: grokSentiment.label, // 'bullish' | 'bearish' | 'neutral'
          score: grokSentiment.score,   // 0-1
          confidence: grokSentiment.confidence,
          mentions: grokSentiment.mentions || 0,
          velocity: grokSentiment.velocity,
          keywords: grokSentiment.keywords,
          reasoning: `Grok sentiment: ${grokSentiment.label} (${grokSentiment.mentions || 0} mentions on Twitter/X, confidence ${(grokSentiment.confidence * 100).toFixed(0)}%)`,
          source: 'grok_twitter'
        };
        console.log(`🐦 ${symbol}: Grok sentiment ${grokSentiment.label} (score: ${grokSentiment.score.toFixed(2)}, mentions: ${grokSentiment.mentions || 0}, velocity: ${grokSentiment.velocity || 'N/A'})`);
      }
    } catch (error) {
      console.warn(`⚠️ ${symbol}: Grok sentiment failed, falling back to ML:`, error);
    }
    
    // Prédiction XGBoost (95% accuracy) au lieu du ML local basique
    const xgbCacheKey = `xgb_${symbol}_${Math.floor(Date.now() / CACHE_DURATION_ML)}`;
    let mlResult = mlPredictionCache.get(xgbCacheKey);
    
    if (!mlResult) {
      const xgbPrediction = predictWithXGBoostPredictor(symbol, technical, change24h, currentVolumeUsd);
      mlResult = { ...xgbPrediction, timestamp: Date.now() };
      mlPredictionCache.set(xgbCacheKey, mlResult);
      
      // Nettoyage cache ML
      if (mlPredictionCache.size > 100) {
        const oldestKey = Array.from(mlPredictionCache.keys())[0];
        mlPredictionCache.delete(oldestKey);
      }
    }
    
    // IA ULTRA-CONDITIONNELLE: Seulement si XGBoost pas confiant ET enjeu important
    if (!mlResult) {
      const xgbPrediction = predictWithXGBoostPredictor(symbol, technical, change24h, currentVolumeUsd);
      mlResult = { ...xgbPrediction, timestamp: Date.now() };
    }
    
    const isHighStakes = currentVolumeUsd > 1_000_000 && Math.abs(change24h) > 3.0;
    const mlNotConfident = mlResult.confidence < 60;
    const isCriticalMajor = majorCryptos.includes(symbol) && Math.abs(change24h) > 2.0;
    if (!multiTimeframe) {
      try {
        multiTimeframe = await computeMultiTimeframeDiagnostics(symbol);
      } catch (error) {
        console.warn(`Failed to build multi-timeframe diagnostics for ${symbol}:`, error);
      }
    }

    const shortTermMomentum = Math.abs(multiTimeframe?.timeframes?.['5m']?.momentumPct ?? 0);
    const divergenceScore = multiTimeframe?.divergenceScore ?? 0;
    const agreementScore = multiTimeframe?.agreementScore ?? 0;
    const multiTfSuggestsEscalation = divergenceScore >= 1 && shortTermMomentum > 0.3;

    const shouldUseAI = (mlNotConfident && (isHighStakes || multiTfSuggestsEscalation)) ||
                        (isCriticalMajor && multiTfSuggestsEscalation);
    
    // Utiliser ML comme sentiment par défaut SEULEMENT si Grok n'a pas fourni de sentiment
    if (!sentiment) {
      sentiment = {
        overall: mlResult.prediction.toLowerCase(),
        confidence: mlResult.confidence / 100,
        reasoning: mlResult.reasoning,
        source: 'local_ml'
      };
    }
    
    if (shouldUseAI) {
      try {
        // Cache IA pour économiser les coûts (30min)
        const cacheKey = `ai_${symbol}_${Math.floor(Date.now() / CACHE_DURATION_AI)}`;
        let analysisResult = aiAnalysisCache.get(cacheKey);
        
        if (!analysisResult) {
          console.log(`� ${symbol}: ML confidence ${mlResult.confidence}% - Using AI confirmation (${change24h}% move)`);
          const fullAnalysisResult = await fullAnalysis(symbol);
          analysisResult = { result: fullAnalysisResult, timestamp: Date.now() };
          aiAnalysisCache.set(cacheKey, analysisResult);
          
          // Nettoyage cache (garde seulement les 30 dernières entrées)
          if (aiAnalysisCache.size > 30) {
            const oldestKey = Array.from(aiAnalysisCache.keys())[0];
            aiAnalysisCache.delete(oldestKey);
          }
        } else {
          console.log(`💾 ${symbol}: Using CACHED AI confirmation (${change24h}% move)`);
        }
        
        // Combiner ML + IA pour meilleure précision
        const aiSentiment = analysisResult.result.sentiment;
        sentiment = {
          overall: aiSentiment.overall,
          confidence: (mlResult!.confidence / 100 + aiSentiment.confidence) / 2, // Moyenne
          reasoning: `ML: ${mlResult!.reasoning} | AI: ${aiSentiment.reasoning}`,
          source: 'hybrid_ml_ai'
        };
      } catch {
        console.log(`⚡ AI failed for ${symbol} - using ML prediction only`);
      }
    } else {
      console.log(`🧠 ${symbol}: ML confidence ${mlResult!.confidence}% (volume: $${(currentVolumeUsd/1000000).toFixed(1)}M, move: ${change24h.toFixed(2)}%) - NO AI NEEDED`);
    }

    // Core metrics avec VRAI changement 24h
    const volBase = Number((ticker as any)?.baseVolume || 0);
    const lastPx = Number((ticker as any)?.last || 0);
    const finalVolumeUsd = Number((ticker as any)?.quoteVolume || 0) || (volBase > 0 && lastPx > 0 ? volBase * lastPx : 0);
    const metrics = {
      momentum: change24h, // 🔥 VRAI changement 24h au lieu de ticker.percentage
      trend: technical.trend || 0,
      volatility: technical.realizedVol || 0,
      volume24h: finalVolumeUsd,
      rsi: technical.rsi14 || 50,
      trendStrength: technical.trendStrength || 0,
      hurst: technical.hurst || 0.5,
      adx: technical.adx14 || 0,
    };

    // Get aggressiveness level for scoring adjustments
    const aggressiveness = opts?.aggressiveness || 'reactive';
    const aggressiveMultiplier = aggressiveness === 'conservative' ? 0.8 : aggressiveness === 'aggressive' ? 1.2 : 1.0;

    // Optimized scoring - technical analysis focused with aggressiveness adjustments
    const momentumScore = calculateMomentumComponent(metrics, aggressiveMultiplier);
    const trendScore = calculateTrendComponent(metrics, technical, aggressiveMultiplier);
    const volatilityScore = calculateVolatilityComponent(metrics, aggressiveMultiplier);
    const volumeScore = calculateVolumeComponent(metrics.volume24h, aggressiveMultiplier);
    const regimeScore = calculateRegimeComponent(technical.regime);
    
    // Sentiment score (only if IA was used)
    const sentimentScore = sentiment ? calculateSentimentComponent(sentiment) : 6.0; // Neutral default

    // Projection confidence (range forecast) derived from technicals without requiring LLM
    let projectionConfidence = 0;
    try {
      const proj = computeProjection(technical as any, sentiment, Number(ticker?.last ?? metrics.momentum));
      if (proj && typeof (proj as any).confidence === 'number') {
        projectionConfidence = Number((proj as any).confidence) || 0;
      }
    } catch {}

    const adaptiveWeights = await getAdaptiveWeightsForSymbol(symbol).catch(() => ({
      momentumWeight: 1,
      volumeWeight: 1,
      volatilityWeight: 1,
      confidence: 0,
      sampleSize: 0,
    }));

    const weightedMomentum = momentumScore * 0.30 * adaptiveWeights.momentumWeight;
    const weightedTrend = trendScore * 0.25;
    const weightedVolatility = volatilityScore * 0.20 * adaptiveWeights.volatilityWeight;
    const weightedVolume = volumeScore * 0.15 * adaptiveWeights.volumeWeight;
    const weightedRegime = regimeScore * 0.05;
    const weightedSentiment = sentimentScore * 0.05;

    const adaptiveTotal =
      0.30 * adaptiveWeights.momentumWeight +
      0.20 * adaptiveWeights.volatilityWeight +
      0.15 * adaptiveWeights.volumeWeight +
      0.25 +
      0.05 +
      0.05;

    const compositeScoreRaw =
      weightedMomentum +
      weightedTrend +
      weightedVolatility +
      weightedVolume +
      weightedRegime +
      weightedSentiment;

    const compositeScore = adaptiveTotal > 0
      ? compositeScoreRaw * (1 / adaptiveTotal)
      : compositeScoreRaw;

    // Determine opportunity type and direction
    const opportunity = determineOpportunity(metrics, technical, sentiment, multiTimeframe || undefined);

    // Generate detailed reasoning
    const reasoning = generateReasoning(metrics, technical, sentiment, opportunity);
    if (multiTimeframe) {
      reasoning.technical = reasoning.technical ?? [];
      reasoning.technical.push(
        `Multi-TF consensus ${agreementScore}/3 (divergence ${divergenceScore})`
      );
    }

    // Calculate confidence based on convergence of signals
    let aggregatedConfidence = calculateConfidence(
      momentumScore, trendScore, sentimentScore, 
      volatilityScore, volumeScore, regimeScore
    );
    if (multiTimeframe) {
      if (agreementScore >= 2) aggregatedConfidence = Math.min(1, aggregatedConfidence + 0.05);
      if (divergenceScore >= 2) aggregatedConfidence = Math.max(0, aggregatedConfidence - 0.05);
    }

    // 🎯 AUTO-DIRECTIONAL: Déterminer automatiquement le bias optimal
    const autoBias = determineOptimalBias(symbol, {
      rsi: metrics.rsi,
      adx: metrics.adx,
      momentum: metrics.momentum,
      trendStrength: metrics.trend,
      volume24h: metrics.volume24h
    });
    
    // Skip si pas de bias clair (confidence < 30% uniformisé pour tous les modes)
    const isSmartAgentScan = !opts?.excludeSessionId; // Smart Agent mode si pas de session à exclure  
    const minConfidenceThreshold = 30; // Uniformisé : 30% minimum pour tous les modes
    console.log(`🔍 DEBUG ${symbol}: excludeSessionId=${opts?.excludeSessionId}, isSmartAgent=${isSmartAgentScan}, threshold=${minConfidenceThreshold}, confidence=${autoBias.confidence}`);
    
    // NEW RANKING SYSTEM: Never reject, just give low scores to poor quality cryptos
    
    // FIX: DO NOT force NONE bias to LONG - this was causing the long bias!
    // Skip symbols with no clear directional bias to avoid forcing longs
    if (autoBias.bias === 'none') {
      console.log(`⚠️ ${symbol}: No clear directional bias (${autoBias.confidence}%) - applying heavy penalty to score`);
      // Don't force to long, just apply heavy penalty
      autoBias.reasoning = `No clear trend → penalized score (margin too small)`;
    }
    
    // Apply confidence penalty to score instead of rejecting
    let confidencePenalty = 1.0;
    if (autoBias.confidence < minConfidenceThreshold) {
      confidencePenalty = Math.max(0.1, autoBias.confidence / minConfidenceThreshold); // Scale down score based on low confidence
      console.log(`⚠️ ${symbol}: Low confidence ${autoBias.confidence}% → applying ${(confidencePenalty * 100).toFixed(0)}% score penalty`);
    }
    
    // Apply confidence penalty to final score
    const penalizedScore = compositeScore * confidencePenalty;

    const finalScore = Math.round(penalizedScore * 100) / 100;
    const combinedConfidence = Math.round((autoBias.confidence + aggregatedConfidence * 100) / 2);
    console.log(`🎯 ${symbol}: Final Score=${finalScore} (M:${momentumScore.toFixed(1)}, T:${trendScore.toFixed(1)}, V:${volatilityScore.toFixed(1)}, Vol:${volumeScore.toFixed(1)}) [${aggressiveness}]`);

    return {
      symbol,
      score: finalScore,
      rank: 0, // Will be set after ranking all symbols
      confidence: Math.round(autoBias.confidence),
      projectionConfidence: Math.round(projectionConfidence * 1000) / 1000,
      autoBias, // 🎯 Bias automatiquement déterminé
      reasoning: {
        ...reasoning,
        sentiment: [...(reasoning.sentiment || []), autoBias.reasoning] // Ajouter le bias reasoning
      },
      metrics,
      opportunity,
      regime: (technical.regime as any)?.label || 'unknown',
      multiTimeframe: multiTimeframe || undefined
    };

  } catch (error) {
    console.error(`Error analyzing ${symbol}:`, error);
    return null;
  }
}

/**
 * Momentum component scoring - More permissive for real market conditions with aggressiveness adjustment
 */
function calculateMomentumComponent(metrics: any, aggressiveMultiplier: number = 1.0): number {
  const { momentum, rsi } = metrics;
  
  // Adjust thresholds based on aggressiveness (lower thresholds = more permissive for aggressive mode)
  const strongMomentumThreshold = 3 * aggressiveMultiplier;
  const goodMomentumThreshold = 2 * aggressiveMultiplier;
  const moderateMomentumThreshold = 0.5 * aggressiveMultiplier;
  
  // Strong momentum signals (lowered thresholds for aggressive mode)
  if (Math.abs(momentum) > strongMomentumThreshold && ((momentum > 0 && rsi > 55) || (momentum < 0 && rsi < 45))) {
    return 8.5; // Excellent momentum with RSI confirmation
  }
  
  // Good momentum (lowered from 3 to 2)
  if (Math.abs(momentum) > goodMomentumThreshold) {
    return 7.0 + Math.min(1.5, Math.abs(momentum) / 10);
  }
  
  // Moderate momentum (lowered from 1 to 0.5)
  if (Math.abs(momentum) > moderateMomentumThreshold) {
    return 5.5 + Math.abs(momentum);
  }
  
  // Even small movements can be valid (base score increased)
  return 4.0 + Math.abs(momentum);
}

/**
 * Trend component scoring - More permissive for real market conditions with aggressiveness adjustment
 */
function calculateTrendComponent(metrics: any, technical: any, aggressiveMultiplier: number = 1.0): number {
  const { trend, trendStrength, adx } = metrics;
  
  // Adjust thresholds based on aggressiveness (lower thresholds = more permissive for aggressive mode)
  const strongAdxThreshold = 20 / aggressiveMultiplier;
  const strongTrendStrengthThreshold = 1.5 / aggressiveMultiplier;
  const moderateAdxThreshold = 12 / aggressiveMultiplier;
  const moderateTrendStrengthThreshold = 0.8 / aggressiveMultiplier;
  const weakAdxThreshold = 8 / aggressiveMultiplier;
  
  // Strong trending market (lowered thresholds for aggressive mode)
  if (adx > strongAdxThreshold && trendStrength > strongTrendStrengthThreshold) {
    return 8.0 + Math.min(1.0, trendStrength / 5);
  }
  
  // Moderate trend (lowered thresholds)
  if (adx > moderateAdxThreshold && trendStrength > moderateTrendStrengthThreshold) {
    return 6.5 + Math.min(1.5, adx / 15);
  }
  
  // Weak trend but some direction (more generous)
  if (Math.abs(trend) > 0 || adx > weakAdxThreshold) {
    return 5.0 + Math.min(1.5, Math.abs(trend) / (technical.last || 1) * 100);
  }
  
  // Even consolidation periods can be valid (increased base)
  return 4.5;
}

/**
 * Sentiment component scoring
 */
function calculateSentimentComponent(sentiment: any): number {
  if (!sentiment) return 5.0;
  
  const score = sentiment.score || 0.5;
  const isStrongSentiment = sentiment.label && sentiment.label !== 'neutral';
  
  if (isStrongSentiment && (score > 0.7 || score < 0.3)) {
    return 8.0 + (Math.abs(score - 0.5) * 4); // Up to 10
  }
  
  if (isStrongSentiment) {
    return 6.0 + (Math.abs(score - 0.5) * 4);
  }
  
  return 4.0 + (score * 2);
}

/**
 * Volatility component scoring - More permissive for crypto markets with aggressiveness adjustment
 */
function calculateVolatilityComponent(metrics: any, aggressiveMultiplier: number = 1.0): number {
  const { volatility, hurst } = metrics;
  
  // Adjust volatility range based on aggressiveness (broader range for aggressive mode)
  const optimalVolMin = 1.5 / aggressiveMultiplier;
  const optimalVolMax = 12 * aggressiveMultiplier;
  const highVolThreshold = 12 * aggressiveMultiplier;
  
  // Optimal volatility range for crypto (broader range for aggressive mode)
  if (volatility >= optimalVolMin && volatility <= optimalVolMax) {
    const base = 7.5;
    const persistency = hurst > 0.6 ? 1.0 : hurst < 0.4 ? 0.8 : 0.9;
    return base + persistency;
  }
  
  // High volatility (opportunity in crypto, more permissive for aggressive mode)
  if (volatility > highVolThreshold) {
    return 6.5 + Math.min(1.5, 15 / volatility);
  }
  
  // Low volatility (still tradeable in crypto)
  return 5.0 + Math.min(2.0, volatility);
}

/**
 * Volume component scoring avec intelligence adaptative
 */
function calculateVolumeComponent(volume: number, aggressiveMultiplier: number = 1.0, isHighVolatility: boolean = false): number {
  // Ajustement intelligent des seuils selon volatilité et agressivité (plus stricts pour garantir la liquidité)
  let minVolumeThreshold = 1_000_000; // Seuil de base $1M

  if (isHighVolatility) {
    minVolumeThreshold = 750_000; // Légèrement réduit en haute volatilité
  }

  minVolumeThreshold = Math.max(500_000, Math.round(minVolumeThreshold / aggressiveMultiplier));

  // SÉCURITÉ: Rejet automatique pour volumes insuffisants
  if (volume < minVolumeThreshold) {
    console.log(`🚫 Volume ${volume} insuffisant pour trading AUTO (minimum $${(minVolumeThreshold/1_000_000).toFixed(2)}M)`);
    return 0; // REJET AUTOMATIQUE
  }

  // Scores progressifs avec bonus haute volatilité
  const volatilityBonus = isHighVolatility ? 0.3 : 0;

  if (volume >= 500_000_000) return Math.min(10.0, 9.8 + volatilityBonus); // $500M+ = Exceptionnel
  if (volume >= 200_000_000) return Math.min(10.0, 9.3 + volatilityBonus); // $200M+ = Très élevé
  if (volume >= 100_000_000) return Math.min(10.0, 8.8 + volatilityBonus); // $100M+ = Excellent
  if (volume >= 50_000_000) return Math.min(10.0, 8.2 + volatilityBonus);  // $50M+ = Très bon
  if (volume >= 25_000_000) return Math.min(10.0, 7.5 + volatilityBonus);  // $25M+ = Bon
  if (volume >= 10_000_000) return Math.min(10.0, 7.0 + volatilityBonus);  // $10M+ = Correct
  if (volume >= 5_000_000) return Math.min(10.0, 6.5 + volatilityBonus);   // $5M+ = Minimum accepté
  return Math.min(10.0, 6.0 + volatilityBonus); // < $5M = très limite mais acceptable avec garde-fous
}

/**
 * Nouveau scoring de mouvement de prix avec pondération améliorée
 */
function calculatePriceMovementComponent(change24h: number, isHighVolatility: boolean = false): number {
  const absChange = Math.abs(change24h);
  
  // Bonus significatif pour les forts mouvements
  let movementScore = 5.0; // Score de base
  
  // Échelle exponentielle pour les mouvements forts
  if (absChange > 5.0) {
    movementScore = 10.0; // Mouvement exceptionnel >5%
  } else if (absChange > 3.0) {
    movementScore = 9.0;  // Fort mouvement >3%
  } else if (absChange > 2.0) {
    movementScore = 8.0;  // Bon mouvement >2%
  } else if (absChange > 1.0) {
    movementScore = 7.0;  // Mouvement modéré >1%
  } else if (absChange > 0.5) {
    movementScore = 6.0;  // Petit mouvement >0.5%
  }
  
  // Bonus en haute volatilité pour favoriser l'action
  if (isHighVolatility && absChange > 1.0) {
    movementScore += 1.0;
  }
  
  return Math.min(10.0, movementScore);
}

/**
 * Regime component scoring
 */
function calculateRegimeComponent(regime: any): number {
  if (!regime) return 5.0;
  
  switch (regime.label) {
    case 'trending_bull':
    case 'trending_bear':
      return 8.5;
    case 'volatile_bull':
    case 'volatile_bear':
      return 7.5;
    case 'ranging_neutral':
      return 6.0;
    case 'low_vol_neutral':
      return 4.0;
    default:
      return 5.0;
  }
}

/**
 * Determine opportunity type and characteristics
 */
function determineOpportunity(metrics: any, technical: any, sentiment: any, multiTimeframe?: MultiTimeframeDiagnostics): any {
  const { momentum, rsi, adx, trendStrength } = metrics;
  const movementAbs = Math.abs(momentum);
  const hasVolumeData = technical?.volume != null && technical?.volumeMA != null;
  const volumeBurst = hasVolumeData ? Number(technical.volume) > Number(technical.volumeMA) * 10 : false;
  const oneHourBias = multiTimeframe?.timeframes?.['1h']?.bias;
  const fifteenBias = multiTimeframe?.timeframes?.['15m']?.bias;
  const fiveBias = multiTimeframe?.timeframes?.['5m']?.bias;
  const dominantBias = (() => {
    if (oneHourBias && oneHourBias !== 'neutral') return oneHourBias;
    if (fifteenBias && fifteenBias !== 'neutral') return fifteenBias;
    return fiveBias || 'neutral';
  })();

  if (movementAbs > 5 && volumeBurst) {
    const dir = momentum > 0 ? 'bullish' : 'bearish';
    return {
      type: 'breakout',
      direction: dir,
      timeframe: 'short',
      expectedReturn: 12,
      riskLevel: 'high',
      playbook: 'momentum_breakout',
      targetR: 10,
    };
  }
  
  if (rsi < 25 || rsi > 75) {
    const dir = rsi < 25 ? 'bullish' : 'bearish';
    return {
      type: 'reversal',
      direction: dir,
      timeframe: 'short',
      expectedReturn: 5,
      riskLevel: 'medium',
      playbook: 'mean_reversion',
      targetR: 4,
    };
  }
  
  // Breakout opportunity
  if (adx > 20 && Math.abs(momentum) > 3 && 
      ((rsi > 70 && momentum > 0) || (rsi < 30 && momentum < 0))) {
    return {
      type: 'breakout',
      direction: momentum > 0 ? 'bullish' : 'bearish',
      timeframe: 'short',
      expectedReturn: Math.min(15, Math.abs(momentum) * 2),
      riskLevel: 'high'
    };
  }
  
  // Trend opportunity
  if (trendStrength > 1.5 && adx > 15) {
    return {
      type: 'trend',
      direction: technical.trend > 0 ? 'bullish' : 'bearish',
      timeframe: 'medium',
      expectedReturn: Math.min(12, trendStrength * 3),
      riskLevel: 'medium',
      playbook: 'trend_following',
      targetR: 6,
    };
  }
  
  // Reversal opportunity
  if ((rsi > 80 || rsi < 20) && Math.abs(momentum) > 2) {
    return {
      type: 'reversal',
      direction: rsi > 80 ? 'bearish' : 'bullish',
      timeframe: 'short',
      expectedReturn: Math.min(10, Math.abs(momentum) * 1.5),
      riskLevel: 'high',
      playbook: 'mean_reversion',
      targetR: 4,
    };
  }
  
  // Momentum opportunity
  if (Math.abs(momentum) > 2 && sentiment?.score) {
    const sentimentAligned = (momentum > 0 && sentiment.score > 0.6) || 
                            (momentum < 0 && sentiment.score < 0.4);
    return {
      type: 'momentum',
      direction: momentum > 0 ? 'bullish' : 'bearish',
      timeframe: sentimentAligned ? 'medium' : 'short',
      expectedReturn: Math.min(8, Math.abs(momentum) * 1.2),
      riskLevel: sentimentAligned ? 'medium' : 'high',
      playbook: sentimentAligned ? 'momentum_breakout' : 'momentum_scalp',
      targetR: sentimentAligned ? 7 : 5,
    };
  }
  
  // Default - volatility play
  const defaultDirection = dominantBias === 'bullish' ? 'bullish' : dominantBias === 'bearish' ? 'bearish' : 'neutral';
  return {
    type: 'volatility',
    direction: defaultDirection,
    timeframe: 'short',
    expectedReturn: 5,
    riskLevel: 'medium',
    playbook: 'volatility',
    targetR: 3,
  };
}

type TrendAssessment = {
  symbol: string;
  score: number;
  ok: boolean;
  direction: 'bullish' | 'bearish' | 'neutral';
  adx: number;
  trendStrength: number;
  slope: number;
  atrPct: number;
  reasons: string[];
};

type CryptoPerformanceEntry = {
  symbol: string;
  change24h: number;
  volume24h: number;
  quoteVolume24h: number;
  combinedScore: number;
  absChange: number;
  volumeScore: number;
  performanceScore: number;
  lastPrice: number;
};

async function computeTrendConfidence(symbol: string, snap: TechnicalSnapshot | null): Promise<TrendAssessment> {
  if (!snap) {
    return {
      symbol,
      score: 0,
      ok: false,
      direction: 'neutral',
      adx: 0,
      trendStrength: 0,
      slope: 0,
      atrPct: 0,
      reasons: ['no_snapshot'],
    };
  }

  // Try to fetch learned personality profile for this symbol
  // Now with regime awareness for volatility, direction, volume, and trending/ranging
  const atrPct = Number(snap.atrPct ?? 0);
  const ema20 = Number(snap.ema20 ?? 0);
  const ema50 = Number(snap.ema50 ?? 0);
  const adx = Number(snap.adx14 ?? 0);
  const volume = snap.volume ? Number(snap.volume) : undefined;
  const volumeMA = snap.volumeMA ? Number(snap.volumeMA) : undefined;
  const volumeZScore = snap.volumeZScore ? Number(snap.volumeZScore) : undefined;
  
  const volatilityRegime = classifyVolatilityRegime(atrPct);
  const directionBias = classifyDirectionBias(ema20, ema50);
  const volumeRegime = classifyVolumeRegime(volume, volumeMA, volumeZScore);
  const trendingRanging = classifyTrendingRanging(adx, atrPct);
  
  const profile = await getPersonalityProfile(symbol, {
    volatilityRegime,
    directionBias,
    volumeRegime,
    trendingRanging,
  }).catch(() => null);
  const params = profile || DEFAULT_PARAMS;

  const trendStrength = Number(snap.trendStrength ?? 0);
  const ema100 = Number(snap.ema100 ?? 0);
  const ema200 = Number(snap.ema200 ?? 0);
  const last = Number(snap.last ?? 0);
  const slope = Number(snap.ema20Slope ?? 0);
  const cmf = Number(snap.cmf20 ?? 0);

  const direction: TrendAssessment['direction'] = ema20 > ema50
    ? 'bullish'
    : ema20 < ema50
      ? 'bearish'
      : 'neutral';

  // 2. Compute component scores (normalized 0-1)
  const adxScore = Math.max(0, Math.min(1, (adx - 15) / 22));
  const strengthScore = Math.max(0, Math.min(1, (trendStrength - 0.2) / 0.8));
  const alignment = ema50 !== 0 ? Math.abs((ema20 - ema50) / ema50) : 0;
  const alignmentScore = Math.max(0, Math.min(1, alignment / 0.018));
  const slopeNorm = last !== 0 ? Math.abs(slope / last) : 0;
  const slopeScore = Math.max(0, Math.min(1, slopeNorm * 220));
  const flowScore = Math.max(0, Math.min(1, (cmf + 0.2) / 0.6));

  // Use learned weights from personality profile
  const weightedScore = 
    adxScore * params.weights.adx + 
    strengthScore * params.weights.strength + 
    alignmentScore * params.weights.alignment + 
    slopeScore * params.weights.slope + 
    flowScore * params.weights.flow;
  const score = Number(weightedScore.toFixed(4));

  // 4. Apply category-specific thresholds for validation reasons
  const reasons: string[] = [];
  // Use learned thresholds from personality profile
  if (adx < params.thresholds.adx) reasons.push('adx_below_trend_threshold');
  if (trendStrength < params.thresholds.trendStrength) reasons.push('weak_trend_structure');
  if (direction === 'bullish' && ema20 <= ema100) reasons.push('bullish_trend_missing_stack');
  if (direction === 'bearish' && ema20 >= ema100) reasons.push('bearish_trend_missing_stack');
  // CMF flow check (simplified, no category-specific thresholds)
  if (Math.abs(cmf) < 0.02) reasons.push('neutral_flow');
  if (ema200 !== 0) {
    const distance = Math.abs((last - ema200) / ema200) * 100;
    if (distance < 0.4) reasons.push('price_near_ema200');
  }

  // Use learned minimum confidence threshold
  const ok = score >= params.thresholds.minConfidence && adx >= params.thresholds.adx && trendStrength >= params.thresholds.trendStrength;

  // Log the trade evaluation for learning
  // 'filter_passed' means entry filters PASSED, 'filter_blocked' means FAILED
  const decision = ok ? 'filter_passed' : 'filter_blocked';
  const blockedReason = ok ? undefined : (reasons.length > 0 ? reasons.join(', ') : 'entry_filters_failed');
  
  logTradeEvaluation({
    symbol,
    decision,
    blockedReason,
    confidenceScore: score,
    inputMetrics: {
      adx,
      cmf,
      atrPct,
      slope,
      trendStrength,
      ema20,
      ema50,
      ema100,
      ema200,
      rsi14: snap.rsi14 ? Number(snap.rsi14) : undefined,
      volume,
      volumeMA,
      volumeZScore,
    },
    regimeContext: {
      volatilityRegime: atrPct < 3 ? 'low' : atrPct > 6 ? 'high' : 'medium',
      directionBias: ema20 && ema50 ? (ema20 > ema50 * 1.001 ? 'long' : ema20 < ema50 * 0.999 ? 'short' : 'neutral') : 'neutral',
      volumeRegime: volumeZScore !== undefined ? (volumeZScore < -0.5 ? 'low' : volumeZScore > 0.5 ? 'high' : 'normal') : 'normal',
      trendingRanging: adx > 25 ? 'trending' : adx < 20 ? 'ranging' : (atrPct > 4 ? 'trending' : 'ranging'),
      parameterSource: 'static_config',
    },
  }).catch((error) => {
    // Non-blocking: log error but don't fail the trade decision
    console.warn('Failed to log trade evaluation:', error);
  });

  return {
    symbol,
    score,
    ok,
    direction,
    adx,
    trendStrength,
    slope,
    atrPct,
    reasons,
  };
}

async function evaluateSymbolTrend(symbol: string): Promise<TrendAssessment> {
  const candidates = symbol.includes(':') ? [symbol] : [symbol, `${symbol}:USDT`];
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const snap = await buildTechSnapshot(candidate);
      return await computeTrendConfidence(symbol, snap);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    console.warn(`⚠️ Trend snapshot unavailable for ${symbol}:`, lastError);
  }
  return await computeTrendConfidence(symbol, null);
}

async function applyTrendWeighting(
  symbols: string[],
  performance: CryptoPerformanceEntry[],
  prioritySymbols: Set<string>,
): Promise<{ ordering: string[]; evaluations: TrendAssessment[] }> {
  if (symbols.length === 0) {
    return { ordering: symbols, evaluations: [] };
  }

  console.log(`🔎 Evaluating trend diagnostics for ${symbols.length} candidate${symbols.length === 1 ? '' : 's'}...`);
  const evaluations = await Promise.all(symbols.map((symbol) => evaluateSymbolTrend(symbol)));

  evaluations.forEach((evaluation) => {
    const status = evaluation.ok ? '✅' : '⚠️';
    const details = `score=${(evaluation.score * 100).toFixed(1)}%, ADX=${evaluation.adx.toFixed(1)}, trend=${evaluation.trendStrength.toFixed(2)}, slope=${evaluation.slope.toFixed(4)}`;
    const reasons = evaluation.reasons.length ? ` | ${evaluation.reasons.join(', ')}` : '';
    console.log(`${status} ${evaluation.symbol}: ${details}${reasons}`);
  });

  if (!evaluations.some((ev) => ev.ok)) {
    console.log('⚠️ No candidates passed trend quality threshold. Retaining original ordering.');
    return { ordering: symbols, evaluations };
  }

  const perfMap = new Map(performance.map((entry) => [entry.symbol, entry]));
  const evalMap = new Map(evaluations.map((entry) => [entry.symbol, entry]));

  const scored = symbols.map((symbol, idx) => {
    const perf = perfMap.get(symbol);
    const trend = evalMap.get(symbol);
    const perfScore = perf ? Math.max(0.15, Math.min(1, perf.combinedScore / 12)) : 0.4;
    const trendScore = trend ? trend.score : 0;
    const reliability = trend && trend.ok ? 0.08 : -0.05;
    const priorityBonus = prioritySymbols.has(symbol) ? 0.05 : 0;
    const finalScore = perfScore * 0.45 + trendScore * 0.5 + reliability + priorityBonus;
    return { symbol, finalScore, idx };
  });

  scored.sort((a, b) => {
    if (b.finalScore === a.finalScore) return a.idx - b.idx;
    return b.finalScore - a.finalScore;
  });

  const ordering = scored.map((item) => item.symbol);
  console.log('🏁 Trend-weighted ordering:', ordering.slice(0, 8));
  return { ordering, evaluations };
}

/**
 * Generate detailed reasoning for the analysis
 */
function generateReasoning(metrics: any, technical: any, sentiment: any, opportunity: any): any {
  const technical_reasons: string[] = [];
  const sentiment_reasons: string[] = [];
  const risk_reasons: string[] = [];
  
  // Technical analysis
  if (metrics.rsi > 70) {
    technical_reasons.push(`RSI overbought (${metrics.rsi.toFixed(1)}) - potential reversal`);
  } else if (metrics.rsi < 30) {
    technical_reasons.push(`RSI oversold (${metrics.rsi.toFixed(1)}) - potential bounce`);
  } else if (metrics.rsi > 60) {
    technical_reasons.push(`RSI bullish momentum (${metrics.rsi.toFixed(1)})`);
  } else if (metrics.rsi < 40) {
    technical_reasons.push(`RSI bearish momentum (${metrics.rsi.toFixed(1)})`);
  }
  
  if (metrics.adx > 25) {
    technical_reasons.push(`Strong trend (ADX: ${metrics.adx.toFixed(1)})`);
  } else if (metrics.adx > 15) {
    technical_reasons.push(`Moderate trend (ADX: ${metrics.adx.toFixed(1)})`);
  }
  
  if (technical.srBias === 'nearSupport') {
    technical_reasons.push(`Near support level - potential bounce`);
  } else if (technical.srBias === 'nearResistance') {
    technical_reasons.push(`Near resistance - potential breakout or rejection`);
  }
  
  // Sentiment analysis
  if (sentiment) {
    if (sentiment.label === 'bullish' && sentiment.score > 0.7) {
      sentiment_reasons.push(`Strong bullish sentiment (${(sentiment.score * 100).toFixed(0)}%)`);
    } else if (sentiment.label === 'bearish' && sentiment.score < 0.3) {
      sentiment_reasons.push(`Strong bearish sentiment (${(sentiment.score * 100).toFixed(0)}%)`);
    } else if (sentiment.label !== 'neutral') {
      sentiment_reasons.push(`${sentiment.label} sentiment (${(sentiment.score * 100).toFixed(0)}%)`);
    }
    
    if (sentiment.bullets) {
      sentiment_reasons.push(...sentiment.bullets.slice(0, 2));
    }
  }
  
  // Risk assessment
  if (metrics.volatility > 10) {
    risk_reasons.push(`High volatility (${metrics.volatility.toFixed(1)}%) - increased risk/reward`);
  } else if (metrics.volatility < 2) {
    risk_reasons.push(`Low volatility (${metrics.volatility.toFixed(1)}%) - limited movement expected`);
  }
  
  if (metrics.volume24h < 500000) {
    risk_reasons.push(`Low 24h volume ($${(metrics.volume24h / 1000).toFixed(0)}K) - liquidity concerns`);
  } else if (metrics.volume24h > 5000000) {
    risk_reasons.push(`High 24h volume ($${(metrics.volume24h / 1000000).toFixed(1)}M) - good liquidity`);
  }
  
  const summary = `${opportunity.type.toUpperCase()} opportunity with ${opportunity.direction} bias. ` +
                 `Expected return: ${opportunity.expectedReturn.toFixed(1)}% (${opportunity.riskLevel} risk)`;
  
  return {
    summary,
    technical: technical_reasons,
    sentiment: sentiment_reasons,
    risk: risk_reasons
  };
}

/**
 * Calculate confidence based on signal convergence
 */
function calculateConfidence(...scores: number[]): number {
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((acc, score) => acc + Math.pow(score - avg, 2), 0) / scores.length;
  const stdDev = Math.sqrt(variance);
  
  // Lower standard deviation = higher confidence
  const convergence = Math.max(0, 1 - (stdDev / 3));
  
  // Boost confidence for high average scores
  const qualityBoost = avg > 7 ? 0.1 : avg > 6 ? 0.05 : 0;
  
  return Math.min(1.0, convergence + qualityBoost);
}

/**
 * NEW: AI-powered scan using 2-step pipeline
 * 1. Filter by volume → Top 50
 * 2. AI ranking → Best opportunities for 24h
 */
export async function scanIntelligentOpportunities(excludeSessionId?: string, opts?: { aggressiveness?: 'conservative'|'reactive'|'aggressive' }): Promise<IntelligentAnalysis[]> {
  console.log('🔍 Starting AI-powered opportunity scan (2-step pipeline)...');
  
  // Note: AI ranking uses its own sophisticated filtering and doesn't currently
  // use the aggressiveness parameter. The aggressiveness filtering is applied
  // in the legacy path via getOptimizedCryptoList's strategy profile.
  // Future enhancement: Pass aggressiveness to AI ranking for consistency.
  const aggressiveness = opts?.aggressiveness || 'reactive';
  if (aggressiveness !== 'reactive') {
    console.log(`⚠️ AI ranking path currently uses built-in filtering (aggressiveness '${aggressiveness}' noted but not applied to AI selection)`);
  }
  
  try {
    // Use NEW AI ranking pipeline
    const aiRanked = await getAIRankedOpportunities({ 
      useCache: true, 
      excludeSessionId 
    });
    
    if (aiRanked.length === 0) {
      console.log('⚠️ AI ranking returned no opportunities');
      return [];
    }
    
    console.log(`🤖 AI ranked ${aiRanked.length} opportunities`);
    
    // Convert AI ranking to IntelligentAnalysis format
    const analyses: IntelligentAnalysis[] = await Promise.all(aiRanked.map(async (ranked, index) => {
      // Auto-bias based on AI direction
      const autoBias = {
        bias: ranked.opportunity.direction as 'long' | 'short' | 'none',
        confidence: Math.round(ranked.opportunity.confidence * 100),
        reasoning: ranked.aiReasoning.join(' | ')
      };
      
      // Determine opportunity details
      const opportunityType = ranked.opportunity.type === 'range' ? 'volatility' : ranked.opportunity.type;
      const opportunity = {
        type: opportunityType as 'breakout' | 'reversal' | 'trend' | 'momentum' | 'volatility',
        direction: ranked.opportunity.direction === 'long' ? 'bullish' : 
                  ranked.opportunity.direction === 'short' ? 'bearish' : 'neutral' as 'bullish' | 'bearish' | 'neutral',
        timeframe: 'short' as const,
        expectedReturn: Math.abs(ranked.change24h) * 1.5, // Estimate based on momentum
        riskLevel: ranked.technical.atrPct > 1.5 ? 'high' : 
                   ranked.technical.atrPct > 0.8 ? 'medium' : 'low' as 'low' | 'medium' | 'high',
        playbook: opportunityType === 'breakout' ? 'momentum_breakout' :
                 opportunityType === 'trend' ? 'trend_following' :
                 opportunityType === 'reversal' ? 'mean_reversion' : 'volatility',
        targetR: opportunityType === 'breakout' ? 10 : 
                opportunityType === 'trend' ? 6 : 4
      };
      
      const analysis: IntelligentAnalysis = {
        symbol: ranked.symbol,
        score: ranked.score * 10, // Convert 0-1 to 0-10 scale
        rank: ranked.rank,
        confidence: Math.round(ranked.opportunity.confidence * 100),
        projectionConfidence: ranked.opportunity.confidence,
        autoBias,
        reasoning: {
          summary: ranked.aiReasoning[0] || 'AI-selected opportunity',
          technical: ranked.aiReasoning.slice(0, 3),
          sentiment: [],
          risk: ranked.technical.atrPct > 1.5 ? ['High volatility - increased risk'] : []
        },
        metrics: {
          momentum: ranked.change24h,
          trend: ranked.technical.ema20 - ranked.technical.ema50,
          volatility: ranked.technical.atrPct,
          volume24h: ranked.volumeUsd24h,
          rsi: ranked.technical.rsi,
          trendStrength: Math.abs(ranked.technical.ema20 - ranked.technical.ema50) / ranked.technical.ema50 * 100,
          hurst: 0.5, // Default
          adx: ranked.technical.adx
        },
        opportunity,
        regime: ranked.technical.trend
      };
      return enrichAnalysisWithMemory(analysis);
    }));

    analyses.sort((a, b) => b.score - a.score);
    
    console.log(`✅ AI scan complete. ${analyses.length} opportunities converted.`);
    console.log(`🏆 Top 5: ${analyses.slice(0, 5).map(a => `${a.symbol}(${a.score.toFixed(1)})`).join(', ')}`);
    
    return analyses;
    
  } catch (error) {
    console.error('❌ AI ranking failed, falling back to legacy system:', error);
    
    // FALLBACK: Use legacy system if AI fails
    return await scanIntelligentOpportunitiesLegacy(excludeSessionId, opts);
  }
}

/**
 * LEGACY: Original scan (backup if AI fails)
 */
async function scanIntelligentOpportunitiesLegacy(excludeSessionId?: string, opts?: { aggressiveness?: 'conservative'|'reactive'|'aggressive' }): Promise<IntelligentAnalysis[]> {
  console.log('🔍 Using LEGACY opportunity scan...');
  
  // Create strategy profile from aggressiveness option
  const aggressiveness = opts?.aggressiveness || 'reactive';
  const strategyProfile: StrategyFilterProfile = {
    aggressiveness,
    targetTpPct: Math.max(1.2, Number(getConfig().TARGET_TP1_PCT ?? getConfig().MIN_TP_PCT ?? 1.2)),
    stopLossPct: Math.max(0.4, Number(getConfig().MIN_STOP_PCT ?? 0.6)),
  };
  
  console.log(`📊 Using ${aggressiveness} aggressiveness for crypto selection`);
  
  // Get top 10-20 cryptos instead of all perpetuals, excluding current session
  const symbols = await getOptimizedCryptoList(excludeSessionId, 1, { strategy: strategyProfile });
  console.log(`📊 Analyzing ${symbols.length} top cryptos (legacy mode)...`);
  
  // Analyze in smaller batches for better performance
  const analyses: IntelligentAnalysis[] = [];
  const batchSize = 5; // Smaller batches for top cryptos
  
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const batchPromises = batch.map(symbol => calculateIntelligentScore(symbol, { ...opts, excludeSessionId }));
    const batchResults = await Promise.all(batchPromises);
    
    // Filter out null results and add to analyses
    analyses.push(...batchResults.filter(result => result !== null) as IntelligentAnalysis[]);
    
    // Progress log
    console.log(`📈 Analyzed ${Math.min(i + batchSize, symbols.length)}/${symbols.length} top cryptos`);
  }
  
  const enrichedAnalyses = await Promise.all(analyses.map(enrichAnalysisWithMemory));

  // Sort by score (descending) and assign ranks
  enrichedAnalyses.sort((a, b) => b.score - a.score);

  // Filter by minimum score threshold to remove poor quality cryptos
  const minScoreThreshold = 2.0; // Minimum score to be considered tradeable
  let qualifiedAnalyses = enrichedAnalyses.filter(a => a.score >= minScoreThreshold);

  if (!qualifiedAnalyses.length && enrichedAnalyses.length) {
    console.warn(`⚠️ All analyses scored below ${minScoreThreshold}. Falling back to top-ranked candidate anyway.`);
    const fallbackCount = Math.min(3, enrichedAnalyses.length);
    qualifiedAnalyses = enrichedAnalyses.slice(0, fallbackCount);
  }

  qualifiedAnalyses.forEach((analysis, index) => {
    analysis.rank = index + 1;
  });

  console.log(`✅ Legacy scan complete. Found ${enrichedAnalyses.length} total analyses, ${qualifiedAnalyses.length} selected (score threshold ${minScoreThreshold}).`);
  console.log(`🏆 Selected: ${qualifiedAnalyses.slice(0, 5).map(a => `${a.symbol}(${a.score.toFixed(1)})`).join(', ')}`);

  return qualifiedAnalyses;
}

/**
 * Get the best opportunity with detailed explanation
 */
/**
 * Compte le nombre d'agents actifs sur un symbole spécifique
 */
export async function getActiveAgentCountForSymbol(symbol: string, excludeSessionId?: string): Promise<number> {
  try {
    const norm = normalizeUnifiedSymbol(symbol);
    const base = norm.split('/')[0];
    const forms = Array.from(new Set([
      `${base}/USDT`,
      `${base}/USDT:USDT`,
      `${base}/USD:USD`,
      `${base}/USDT:USD`,
      `${base}-USDT`,
      `${base}USDT`,
      `${base}USDT_PERP`,
      `${base}USD_PERP`,
      `${base}USD-PERP`,
      `${base}USDT-PERP`,
      `${base}USD`,
      `${base}/USD`
    ]));
    const where: any = {
      stoppedAt: null,
      OR: [
        { symbol: { in: forms } },
        { currentSymbol: { in: forms } },
      ],
    };
    if (excludeSessionId) where.id = { not: excludeSessionId };
    const count = await prisma.agentSession.count({ where });
    return count;
  } catch (error) {
    console.error('Error counting active agents for symbol:', error);
    return 0;
  }
}

export async function getBestIntelligentOpportunity(
  excludeSessionId?: string,
  opts?: {
    relaxSteps?: number;
    candidatesOverride?: IntelligentAnalysis[];
    aggressiveness?: 'conservative' | 'reactive' | 'aggressive';
    maxUsage?: number;
  }
): Promise<IntelligentAnalysis | null> {
  const testMode = process.env.UNIT_TEST_MODE === 'true';

  console.log('🎯 Smart Agent Selection: Finding best available opportunity from ranked list...');

  // Get the complete ranked list of qualified opportunities
  const opportunities =
    opts?.candidatesOverride ??
    (testMode
      ? await scanIntelligentOpportunitiesLegacy(excludeSessionId, opts)
      : await scanIntelligentOpportunities(excludeSessionId, opts));

  if (opportunities.length === 0) {
    console.log('😴 No qualified opportunities found (all below minimum score threshold) → SLEEP mode');
    return null;
  }
  
  console.log(`📊 Found ${opportunities.length} qualified opportunities. Selecting by availability...`);
  
  // Get usage count for each symbol (how many agents are already active on it)
  const symbolUsageMap = new Map<string, number>();
  for (const opp of opportunities) {
    const count = await getActiveAgentCountForSymbol(opp.symbol, excludeSessionId);
    symbolUsageMap.set(opp.symbol, count);
  }
  
  const maxUsage = Math.max(0, Math.min(2, Number.isFinite(opts?.maxUsage) ? Number(opts!.maxUsage) : 1));

  // Selection strategy:
  // 1. Try symbols with 0 active agents first
  // 2. Incrementally relax up to opts.maxUsage (default 1)
  // 3. Never allow 2+ agents on same symbol unless explicitly permitted or during high-momentum override

  for (let usageThreshold = 0; usageThreshold <= maxUsage; usageThreshold++) {
    console.log(`🔄 Pass ${usageThreshold + 1}: Looking for symbols with ${usageThreshold} active agent(s)...`);

    for (const opportunity of opportunities) {
      const currentUsage = symbolUsageMap.get(opportunity.symbol) || 0;

      if (currentUsage === usageThreshold) {
        console.log(`✅ SELECTED: ${opportunity.symbol} (Score: ${opportunity.score.toFixed(1)}, Rank: ${opportunity.rank}, Usage: ${currentUsage}/2)`);
        console.log(`📝 Reasoning: ${opportunity.reasoning.summary}`);
        return opportunity;
      } else {
        console.log(`⏭️  Skip: ${opportunity.symbol} (Usage: ${currentUsage}, looking for ${usageThreshold})`);
      }
    }
  }

  if (maxUsage >= 2) {
    // Final aggressive pass: allow a second slot on high-momentum assets (>= 4% move)
    for (const opportunity of opportunities) {
      const currentUsage = symbolUsageMap.get(opportunity.symbol) || 0;
      const momentum = Math.abs(opportunity.metrics?.momentum ?? 0);
      if (currentUsage <= maxUsage && momentum >= 4) {
        console.log(`⚡ High-momentum override: ${opportunity.symbol} selected despite usage ${currentUsage} (|Δ24h|=${momentum.toFixed(2)}%)`);
        return opportunity;
      }
    }
  }

  // If we get here, all qualified symbols are already used 2+ times
  console.log(`😴 All ${opportunities.length} qualified opportunities already have 2+ active agents → SLEEP mode`);
  return null;
}

/**
 * Helper function to update session next check time
 */
async function updateSessionNextCheck(sessionId: string, nextCheck: Date): Promise<void> {
  try {
    const session = await prisma.agentSession.findUnique({ where: { id: sessionId } });
    if (!session) return;
    
    const config = session.profileJson as any;
    const updatedConfig = { ...config, nextScanDue: nextCheck.toISOString() };
    
    await prisma.agentSession.update({
      where: { id: sessionId },
      data: { profileJson: updatedConfig as any }
    });
  } catch (error) {
    console.error(`Error updating next check for session ${sessionId}:`, error);
  }
}

async function mergeSessionProfileJson(sessionId: string, patch: Record<string, any>) {
  const session = await prisma.agentSession.findUnique({
    where: { id: sessionId },
    select: { profileJson: true, startBalanceUsd: true },
  });
  const base = ((session?.profileJson as any) || {}) as Record<string, any>;
  const merged = { ...base, ...patch } as Record<string, any>;
  if (session?.startBalanceUsd != null && merged.startBalanceUsd == null) {
    merged.startBalanceUsd = Number(session.startBalanceUsd);
  }
  return prisma.agentSession.update({
    where: { id: sessionId },
    data: { profileJson: merged as any },
  });
}

/**
 * Initialize intelligent agent for a session
 */
export async function initializeIntelligentAgent(sessionId: string, preset?: IntelligentAnalysis | null, opts?: { candidatesOverride?: IntelligentAnalysis[]; testMode?: boolean }): Promise<boolean> {
  try {
    console.log(`🤖 Initializing Intelligent Agent for session ${sessionId}...`);
    
    // Fetch session to get aggressiveness level for meta-adaptive strategy
    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
      select: { profileJson: true }
    });
    const profileJson = (session?.profileJson as any) || {};
    const aggressiveness: 'conservative' | 'reactive' | 'aggressive' = 
      profileJson.aggressiveness || 'reactive';
    
    console.log(`📊 Using aggressiveness level: ${aggressiveness} for crypto selection`);
    
    const testMode = !!opts?.testMode || (process.env.UNIT_TEST_MODE === 'true');
    const maxAttemptsEnv = Number(process.env.SMART_AGENT_INIT_MAX_ATTEMPTS || 4);
    const baseDelayEnv = Number(process.env.SMART_AGENT_INIT_RETRY_BASE_MS || 1500);
    const maxDelayEnv = Number(process.env.SMART_AGENT_INIT_RETRY_MAX_MS || 12000);
    const configuredAttempts = preset ? 1 : Math.max(1, Number.isFinite(maxAttemptsEnv) ? Math.trunc(maxAttemptsEnv) : 4);
    const maxAttempts = testMode ? 1 : configuredAttempts;
    const baseDelayMs = Math.max(250, Number.isFinite(baseDelayEnv) ? baseDelayEnv : 1500);
    const maxDelayMs = Math.max(baseDelayMs, Number.isFinite(maxDelayEnv) ? maxDelayEnv : 12000);

    let bestOpportunity: IntelligentAnalysis | null | undefined = preset ?? null;
    if (!bestOpportunity) {
      for (let attempt = 1; attempt <= maxAttempts && !bestOpportunity; attempt++) {
        try {
          bestOpportunity = await getBestIntelligentOpportunity(sessionId, { 
            candidatesOverride: opts?.candidatesOverride,
            aggressiveness 
          });
        } catch (error) {
          console.warn(`⚠️ Attempt ${attempt} failed to fetch intelligent opportunity:`, error);
          bestOpportunity = null;
        }

        if (!bestOpportunity && attempt < maxAttempts) {
          const waitMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
          console.log(`⏳ No intelligent opportunity yet (attempt ${attempt}/${maxAttempts}) — retrying in ${(waitMs / 1000).toFixed(1)}s`);
          await waitFor(waitMs);
        }
      }
    }

    if (testMode) {
      // In test mode, only return selection decision (true if selected, false if none)
      return !!bestOpportunity;
    }

    if (!bestOpportunity) {
      throw new Error(`No intelligent opportunity available after ${maxAttempts} attempts for session ${sessionId}`);
    }
    
    const universeStatus = getAutoUniverseStatusSnapshot();
    if (universeStatus.source !== 'dynamic') {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'auto_select_universe_source',
        source: universeStatus.source,
        reason: universeStatus.reason,
        attempt: universeStatus.attempt,
        candidate_count: universeStatus.candidateCount,
      }));
    }
    if (FALLBACK_STATIC_SYMBOLS.includes(bestOpportunity.symbol)) {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'auto_select_major_pick',
        symbol: bestOpportunity.symbol,
        universe_source: universeStatus.source,
        reason: universeStatus.reason,
        attempt: universeStatus.attempt,
        score: bestOpportunity.score,
      }));
    }
    
    // Enhanced conflict check with multi-agent support (Phase 2)
    const currentAgentCount = await getActiveAgentCountForSymbol(bestOpportunity.symbol, sessionId);
    const strongMomentum = Math.abs(bestOpportunity.metrics.momentum) > 2.0; // Strong movement exception
    
    if (currentAgentCount > 1 && !strongMomentum) {
      console.log(`🚫 Agent limit exceeded for ${bestOpportunity.symbol} (${currentAgentCount} active, momentum: ${bestOpportunity.metrics.momentum.toFixed(2)})`);
      const retry = await getBestIntelligentOpportunity(sessionId, { aggressiveness });
      if (!retry || retry.symbol === bestOpportunity.symbol) {
        // Enter short sleep and retry later to avoid churn
        const sleepConfig = {
          isIntelligent: true,
          selectedAt: new Date().toISOString(),
          analysis: null,
          lastScan: new Date().toISOString(),
          nextScanDue: new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString(), // 1h sleep (was 2h)
          minHoldHours: 0,
          strategy: 'sleep_mode_conflict',
          sleepMode: true,
          sleepReason: 'symbol_conflict'
        };
        try { await markDecisionCancelled(sessionId); } catch (error) { console.warn('conflict cancel decision failed:', error); }
        await mergeSessionProfileJson(sessionId, sleepConfig);
        await mergePlanContainer(sessionId, { intelligentHistory: clampHistory([{ timestamp: new Date().toISOString(), action: 'intelligent_enter_sleep', reason: 'symbol_conflict', nextScan: sleepConfig.nextScanDue }]) });
        console.log(`💤 ${sessionId} sleeping 2h due to symbol conflict`);
        return true;
      }
      // Use alternative
      bestOpportunity = retry;
      console.log(`🔄 Switching allocation to alternative ${bestOpportunity.symbol}`);
    }

    // Ensure symbol profile exists before proceeding
    try {
      await ensureSymbolProfile(bestOpportunity.symbol);
    } catch (error) {
      console.error(`Failed to ensure symbol profile for ${bestOpportunity.symbol}:`, error);
      // Don't block agent initialization if profile creation fails
    }

    let currentDecisionId: string | null = null;
    try {
      currentDecisionId = await recordDecisionSnapshot({
        sessionId,
        symbol: bestOpportunity.symbol,
        analysis: bestOpportunity,
        aggressiveness: 'reactive',
      });
    } catch (error) {
      console.warn(`Unable to record decision snapshot for ${sessionId}:`, error);
    }

    const regimeLabel = bestOpportunity.regime || '';
    let minHoldHours = 6; // Base 6h (was 12h)
    if (/bull/i.test(regimeLabel)) {
      minHoldHours = Math.round(minHoldHours * 1.5); // 9h in bull
    } else if (/bear/i.test(regimeLabel)) {
      minHoldHours = Math.max(4, Math.round(minHoldHours * 0.7)); // ~4h in bear
    }
    if (bestOpportunity.opportunity.playbook === 'momentum_breakout') {
      minHoldHours = Math.max(4, Math.round(minHoldHours * 0.75)); // ~4-5h for breakouts
    }
    const strategyTag = bestOpportunity.opportunity.playbook || 'optimized_cost_efficient';
    const targetsMultiplier = /bear/i.test(regimeLabel) ? 0.7 : /bull/i.test(regimeLabel) ? 1.5 : 1;
    const targetR = bestOpportunity.opportunity.targetR ?? 4;
    const biasPreference = /bear/i.test(regimeLabel) ? 'short' : /bull/i.test(regimeLabel) ? 'long' : bestOpportunity.autoBias?.bias || 'neutral';

    // Update session with the selected symbol using profileJson for metadata
    const intelligentConfig = {
      isIntelligent: true,
      selectedAt: new Date().toISOString(),
      analysis: bestOpportunity,
      lastScan: new Date().toISOString(),
      nextScanDue: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), // 6h minimum (was 12h)
      minHoldHours,
      strategy: strategyTag,
      targetsMultiplier,
      targetR,
      biasPreference,
      sleepMode: false,
      currentDecisionId
    };
    
    const intelligentHistory = [{
      timestamp: new Date().toISOString(),
      action: 'intelligent_init',
      symbol: bestOpportunity.symbol,
      score: bestOpportunity.score,
      confidence: bestOpportunity.confidence,
      reasoning: bestOpportunity.reasoning.summary,
      strategy: strategyTag,
      targetR,
      targetsMultiplier,
      biasPreference,
      decisionId: currentDecisionId || undefined,
    }];
    
    console.log(`🔄 Updating session ${sessionId} with symbol: ${bestOpportunity.symbol}`);
    
    // Try direct SQL to update both symbol and currentSymbol
    try {
      await prisma.$executeRaw`
        UPDATE "AgentSession" 
        SET "symbol" = ${bestOpportunity.symbol}, "currentSymbol" = ${bestOpportunity.symbol}, "lastSymbolSwitchAt" = NOW()
        WHERE id = ${sessionId}
      `;
      console.log(`✅ symbol and currentSymbol updated via SQL to: ${bestOpportunity.symbol}`);
    } catch (error) {
      console.error(`❌ SQL update failed:`, error);
    }
    
    await mergeSessionProfileJson(sessionId, {
      ...intelligentConfig,
      originalSymbol: bestOpportunity.symbol,
    });
    await mergePlanContainer(sessionId, { intelligentHistory: clampHistory(intelligentHistory) });

    console.log(`✅ Session ${sessionId} updated successfully with currentSymbol: ${bestOpportunity.symbol}`);

    console.log(`✅ Intelligent Agent initialized with ${bestOpportunity.symbol}`);
    console.log(`🎯 Score: ${bestOpportunity.score}, Confidence: ${bestOpportunity.confidence}`);

    await refreshPlanAndStrategy(sessionId, bestOpportunity.symbol, 'intelligent_init');
    console.log(`📋 Opportunity: ${bestOpportunity.opportunity.type} ${bestOpportunity.opportunity.direction}`);
    
    return true;
    
  } catch (error) {
    console.error('❌ Error initializing Intelligent Agent:', error);
    return false;
  }
}

/**
 * Optimized background job - 12h minimum hold + trade condition check
 */
export async function checkIntelligentOpportunities(): Promise<void> {
  try {
    console.log('🔄 Checking intelligent opportunities (12h+ hold strategy)...');
    
    // Get all sessions with intelligent configuration using profileJson OR top-level isSmartAgent flag
    const sessions = await prisma.agentSession.findMany({
      where: {
        stoppedAt: null, // Active sessions
        OR: [
          { isSmartAgent: true }, // Top-level flag
          { profileJson: { path: ['isIntelligent'], equals: true } }, // Profile flag
          { profileJson: { path: ['isSmartAgent'], equals: true } } // Alternative profile flag
        ]
      },
      include: {
        positions: {
          where: { qty: { gt: 0 } }, // Only open positions
          take: 5
        },
        orders: {
          where: {
            status: { in: OPEN_ORDER_STATUS_LIST }
          },
          select: {
            id: true,
            status: true,
            symbol: true,
            createdAt: true
          }
        }
      }
    });
    
    if (sessions.length === 0) {
      console.log('📋 No active intelligent agent sessions found');
      return;
    }
    
    console.log(`🤖 Found ${sessions.length} intelligent sessions for 12h+ evaluation`);
    
    for (const session of sessions) {
      await checkSessionForBetterOpportunityOptimized(session);
    }
    
  } catch (error) {
    console.error('❌ Error in intelligent opportunities check:', error);
  }
}

/**
 * Optimized session check: 12h minimum + trade activity condition + sleep mode handling
 */
async function maybeHandleDirectionalReversal(
  session: any,
  config: any,
  now: Date,
  minHoldHours: number,
  hoursSinceSelection: number,
  aggressiveness?: 'conservative' | 'reactive' | 'aggressive'
): Promise<boolean> {
  try {
    if (!session?.symbol || !config?.analysis) {
      return false;
    }
    
    // Use provided aggressiveness or extract from config
    const effectiveAggressiveness = aggressiveness || config?.aggressiveness || 'reactive';

    const analysis = config.analysis as any;
    const expectedBiasRaw = analysis?.autoBias?.bias ?? analysis?.opportunity?.direction ?? null;
    let expectedBias: 'long' | 'short' | null = null;
    if (expectedBiasRaw === 'long' || expectedBiasRaw === 'bullish') expectedBias = 'long';
    else if (expectedBiasRaw === 'short' || expectedBiasRaw === 'bearish') expectedBias = 'short';

    if (!expectedBias) {
      return false;
    }

    const minHoursBeforeCheck = Math.max(
      1,
      Math.min(
        minHoldHours,
        Number(process.env.SMART_DIRECTIONAL_REVERSAL_MIN_HOURS || '1.5')
      ),
    );
    if (hoursSinceSelection < minHoursBeforeCheck) {
      return false;
    }

    let snap: TechnicalSnapshot | null = null;
    try {
      snap = await buildTechSnapshot(session.symbol);
    } catch (error) {
      console.warn(`⚠️ Failed to build tech snapshot for ${session.symbol} during reversal check:`, error);
      return false;
    }

    if (!snap) return false;

    const ema20 = Number(snap.ema20 ?? 0);
    const ema50 = Number(snap.ema50 ?? 0);
    const slopeRaw = Number(snap.ema20Slope ?? 0);
    const slopePct = Math.abs(ema20) > 1e-8 ? (slopeRaw / Math.abs(ema20)) * 100 : 0;
    const emaSpreadPct = Math.abs(ema50) > 1e-8 ? Math.abs(ema20 - ema50) / Math.abs(ema50) * 100 : 0;
    const adx = Number(snap.adx14 ?? 0);
    const trendStrength = Number((snap as any)?.trendStrength ?? 0);
    const regimeBias = snap.trendBias === 'bullish' ? 'long' : snap.trendBias === 'bearish' ? 'short' : 'none';
    const slopeBias = slopeRaw >= 0 ? 'long' : 'short';
    const maBias = ema20 >= ema50 ? 'long' : 'short';

    const consensus = [slopeBias, maBias, regimeBias].reduce(
      (acc: { long: number; short: number }, value) => {
        if (value === 'long') acc.long += 1;
        else if (value === 'short') acc.short += 1;
        return acc;
      },
      { long: 0, short: 0 }
    );
    const consensusBias =
      consensus.long === consensus.short
        ? maBias
        : consensus.long > consensus.short
          ? 'long'
          : 'short';
    const consensusStrength = Math.max(consensus.long, consensus.short);

    let change24h = 0;
    try {
      const ticker = await getTicker(session.symbol);
      change24h = Number(ticker?.percentage ?? (ticker as any)?.info?.priceChangePercent ?? 0);
    } catch (error) {
      console.warn(`⚠️ Failed to fetch ticker for ${session.symbol} during reversal check:`, error);
    }

    const previousMomentum = Number(analysis?.metrics?.momentum ?? 0);
    const momentumFlip =
      Number.isFinite(previousMomentum) &&
      Math.abs(change24h) >= 1 &&
      Math.sign(previousMomentum) !== Math.sign(change24h);

    const structuralReversal =
      consensusBias !== expectedBias &&
      consensusStrength >= 2 &&
      emaSpreadPct >= Number(process.env.SMART_DIRECTIONAL_REVERSAL_SPREAD_PCT || 0.35);
    const trendSupport = adx >= 18 || trendStrength >= 0.9;
    const momentumSupport = momentumFlip || Math.abs(change24h) >= 2;

    if (!(structuralReversal && trendSupport && momentumSupport)) {
      return false;
    }

    console.log(
      `🔄 Directional reversal guard triggered for ${session.id} (${session.symbol}) ` +
        `bias ${expectedBias}→${consensusBias} | Δ24h ${change24h.toFixed(2)}% | ADX ${adx.toFixed(2)} | slope ${slopePct.toFixed(3)}%`
    );

    recordOpsEvent({
      level: 'warn',
      source: 'intelligent_rotation',
      message: 'directional_reversal_detected',
      sessionId: session.id,
      symbol: session.symbol,
      details: {
        expectedBias,
        consensusBias,
        consensusStrength,
        emaSpreadPct,
        slopePct,
        adx,
        trendStrength,
        change24h,
        momentumFlip,
        hoursSinceSelection,
      },
    });

    // Broadcast directional reversal alert for real-time dashboard updates
    broadcast('directional_reversal', {
      previousBias: expectedBias,
      newBias: consensusBias,
      symbol: session.symbol,
      timestamp: now.toISOString(),
      confidence: consensusStrength / 3, // Normalize to 0-1 (3 indicators max)
      metrics: {
        change24h,
        adx,
        slopePct,
        emaSpreadPct,
        consensusStrength,
      },
      reasoning: `Consensus bias shifted from ${expectedBias} to ${consensusBias} with ${consensusStrength}/3 indicators aligned (ADX: ${adx.toFixed(1)}, Δ24h: ${change24h.toFixed(2)}%, EMA spread: ${emaSpreadPct.toFixed(2)}%)`,
    }, session.symbol, session.id);

    const candidate = await getBestIntelligentOpportunity(session.id, { relaxSteps: 1, aggressiveness: effectiveAggressiveness });

    if (!candidate) {
      const nextCheck = new Date(now.getTime() + 60 * 60 * 1000);
      await mergeSessionProfileJson(session.id, {
        lastScan: now.toISOString(),
        nextScanDue: nextCheck.toISOString(),
        pendingRotation: 'directional_reversal_wait',
      });
      await updateSessionNextCheck(session.id, nextCheck);
      return true;
    }

    const historyBase = normalizePlanContainer(session.planJson).intelligentHistory || [];
    const historyEntryBase = {
      timestamp: now.toISOString(),
      fromBias: expectedBias,
      toBias: consensusBias,
      change24h,
      adx,
      slopePct,
      emaSpreadPct,
    } as Record<string, any>;

    if (candidate.symbol !== session.symbol) {
      const updatedConfig = {
        ...(config || {}),
        analysis: candidate,
        selectedAt: now.toISOString(),
        lastScan: now.toISOString(),
        nextScanDue: new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString(),
        switchReason: 'directional_reversal',
        sleepMode: false,
      };

      try {
        await ensureSymbolProfile(candidate.symbol);
      } catch (error) {
        console.error(`Failed to ensure symbol profile for ${candidate.symbol}:`, error);
      }

      try {
        await prisma.$executeRaw`
          UPDATE "AgentSession"
          SET "symbol" = ${candidate.symbol}, "currentSymbol" = ${candidate.symbol}, "lastSymbolSwitchAt" = NOW()
          WHERE id = ${session.id}
        `;
      } catch (error) {
        console.warn(`⚠️ Failed to persist symbol switch for ${session.id}:`, error);
      }

      await prisma.agentSession.update({
        where: { id: session.id },
        data: { profileJson: updatedConfig as any },
      });
      const history = clampHistory([
        ...historyBase,
        {
          ...historyEntryBase,
          action: 'intelligent_switch_reversal',
          fromSymbol: session.symbol,
          toSymbol: candidate.symbol,
          score: candidate.score,
          confidence: candidate.confidence,
          reasoning: candidate.reasoning.summary,
        },
      ]);
      await mergePlanContainer(session.id, { intelligentHistory: history });
      await refreshPlanAndStrategy(session.id, candidate.symbol, 'intelligent_switch_reversal');

      recordOpsEvent({
        level: 'info',
        source: 'intelligent_rotation',
        message: 'directional_reversal_switch',
        sessionId: session.id,
        symbol: candidate.symbol,
        details: {
          fromSymbol: session.symbol,
          toSymbol: candidate.symbol,
          score: candidate.score,
          confidence: candidate.confidence,
        },
      });
    } else {
      const updatedConfig = {
        ...(config || {}),
        analysis: candidate,
        selectedAt: now.toISOString(),
        lastScan: now.toISOString(),
        nextScanDue: new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString(),
        switchReason: 'directional_reversal_refresh',
        sleepMode: false,
      };

      await prisma.agentSession.update({
        where: { id: session.id },
        data: { profileJson: updatedConfig as any },
      });
      const history = clampHistory([
        ...historyBase,
        {
          ...historyEntryBase,
          action: 'intelligent_refresh_reversal',
          symbol: session.symbol,
          score: candidate.score,
          confidence: candidate.confidence,
          reasoning: candidate.reasoning.summary,
        },
      ]);
      await mergePlanContainer(session.id, { intelligentHistory: history });
      await refreshPlanAndStrategy(session.id, candidate.symbol, 'intelligent_reversal_refresh');

      recordOpsEvent({
        level: 'info',
        source: 'intelligent_rotation',
        message: 'directional_reversal_refresh',
        sessionId: session.id,
        symbol: session.symbol,
        details: {
          score: candidate.score,
          confidence: candidate.confidence,
        },
      });
    }

    return true;
  } catch (error) {
    console.warn(`⚠️ Directional reversal handling failed for ${session?.id}:`, error);
    return false;
  }
}

type RecentActivityDecision = {
  shouldDefer: boolean;
  nextCheckAt: Date | null;
  inactivityMs: number | null;
};

function shouldDeferDueToRecentActivity(params: { lastActivityAt: Date | null; windowMs: number; now?: Date }): RecentActivityDecision {
  const { lastActivityAt } = params;
  const windowMs = Math.max(0, Number(params.windowMs || 0));
  const now = params.now ?? new Date();

  if (!lastActivityAt || windowMs <= 0) {
    return { shouldDefer: false, nextCheckAt: null, inactivityMs: null };
  }

  const inactivityMs = now.getTime() - lastActivityAt.getTime();
  if (!Number.isFinite(inactivityMs)) {
    return { shouldDefer: false, nextCheckAt: null, inactivityMs: null };
  }

  const waitUntil = new Date(lastActivityAt.getTime() + windowMs);
  if (waitUntil > now) {
    return { shouldDefer: true, nextCheckAt: waitUntil, inactivityMs };
  }

  return { shouldDefer: false, nextCheckAt: null, inactivityMs };
}

async function checkSessionForBetterOpportunityOptimized(session: any): Promise<void> {
  try {
    const config = session.profileJson as any;
    const now = new Date();
    
    // Extract aggressiveness from session profile for proper crypto selection
    const aggressiveness: 'conservative' | 'reactive' | 'aggressive' = 
      config?.aggressiveness || 'reactive';
    
    // Configurable recent-activity window (hours). Default 3h (was 12h).
    const activityWindowHours = Math.max(1, Number(process.env.SMART_RECENT_ACTIVITY_HOURS || '3'));
    const activityWindowMs = activityWindowHours * 60 * 60 * 1000;

    const agent = AgentHub.get(session.id) as any;
    const hasOpenPosition = Array.isArray(session.positions)
      && session.positions.some((p: any) => Number(p?.qty || 0) > POSITION_QTY_EPSILON);
    const hasOpenOrders = Array.isArray(session.orders)
      && session.orders.some((order: any) => OPEN_ORDER_STATUSES.has(String(order?.status || '').toLowerCase()));
    
    // FIX: For meta-adaptive agents (stateless stubs), only trust database state.
    // The agent.entering flag is unreliable and causes false positives.
    // Removed: agentBusy check that was blocking rotation when agent is armed.
    
    if (hasOpenPosition || hasOpenOrders) {
      const nextCheck = new Date(now.getTime() + 60 * 60 * 1000); // Re-evaluate in 1h
      console.log(
        `⏸️ Session ${session.id}: active trade detected (position=${hasOpenPosition}, orders=${hasOpenOrders}, state=${agent?.state}) — postponing reselection`
      );

      try {
        await mergeSessionProfileJson(session.id, {
          lastScan: now.toISOString(),
          nextScanDue: nextCheck.toISOString(),
          pendingRotation: 'active_trade_guard'
        });
      } catch (err) {
        console.warn(`⚠️ Failed to persist active-trade guard for session ${session.id}:`, err);
      }

      await updateSessionNextCheck(session.id, nextCheck);

      recordOpsEvent({
        level: 'info',
        source: 'intelligent_rotation',
        message: 'skip_due_to_active_trade',
        sessionId: session.id,
        symbol: session.symbol,
        details: {
          hasOpenPosition,
          hasOpenOrders,
          agentState: agent?.state,
          // Enhanced logging for debugging
          dbPositions: session.positions?.length || 0,
          dbOpenOrders: session.orders?.filter((o: any) => 
            OPEN_ORDER_STATUSES.has(String(o?.status || '').toLowerCase())
          ).length || 0
        }
      });

      return;
    }

    // Dynamic min-hold based on last known ADX (from stored analysis). Fallback to 12h.
    // - strong trend (ADX>=25): 10h
    // - moderate trend (20<=ADX<25): 8h
    // - neutral (15<=ADX<20): 6h
    // - choppy (ADX<15): 3h
    const lastAdx = Number(config?.analysis?.metrics?.adx ?? 0);
    const dynamicMinHold = lastAdx >= 25 ? 10
                         : lastAdx >= 20 ? 8
                         : lastAdx >= 15 ? 6
                         : 3;
    
    // Fast guard: if we suffered a cluster of losses recently, trigger an immediate re-evaluation
    try {
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const recentLossExits = await prisma.order.count({
        where: {
          sessionId: session.id,
          status: 'filled',
          source: 'agent',
          createdAt: { gte: oneHourAgo },
          // Exit orders produced by the agent include ".exit" in the clientOrderId
          clientOrderId: { contains: '.exit' }
        }
      });
      if (recentLossExits >= 3) {
        console.log(`🚨 Loss cluster detected for ${session.id} (${recentLossExits} exits < 60m) — forcing re-evaluation`);
        const best = await getBestIntelligentOpportunity(session.id, { aggressiveness });
        if (best && best.symbol && best.symbol !== session.symbol) {
          const existingHistory = normalizePlanContainer(session.planJson).intelligentHistory || [];
          const history = [...existingHistory, {
            timestamp: now.toISOString(),
            action: 'intelligent_switch_loss_cluster',
            fromSymbol: session.symbol,
            toSymbol: best.symbol,
            score: best.score,
            confidence: best.confidence,
            reasoning: best.reasoning.summary,
            recentLossExits
          }];
          try {
            await ensureSymbolProfile(best.symbol);
          } catch (error) {
            console.error(`Failed to ensure symbol profile for ${best.symbol}:`, error);
          }
          try {
            await prisma.$executeRaw`
              UPDATE "AgentSession"
              SET "symbol" = ${best.symbol}, "currentSymbol" = ${best.symbol}, "lastSymbolSwitchAt" = NOW()
              WHERE id = ${session.id}
            `;
          } catch (err) {
            console.warn('Loss-cluster switch SQL update failed:', err);
          }
          const updated = {
            ...(config || {}),
            analysis: best,
            selectedAt: now.toISOString(),
            lastScan: now.toISOString(),
            nextScanDue: new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString(),
            switchReason: `loss_cluster_${recentLossExits}`,
            sleepMode: false
          };
          await prisma.agentSession.update({ where: { id: session.id }, data: { profileJson: updated as any } });
          await mergePlanContainer(session.id, { intelligentHistory: clampHistory(history) });
          await refreshPlanAndStrategy(session.id, best.symbol, 'intelligent_switch_loss_cluster');
          return; // handled
        } else {
          // No better symbol found — enter short sleep to avoid churn
          const sleepConfig = {
            ...(config || {}),
            analysis: null,
            lastScan: now.toISOString(),
            nextScanDue: new Date(now.getTime() + 60 * 60 * 1000).toISOString(), // 1h sleep
            sleepMode: true,
            sleepReason: `loss_cluster_${recentLossExits}`
          };
          const existingHistory = normalizePlanContainer(session.planJson).intelligentHistory || [];
          const history = [...existingHistory, {
            timestamp: now.toISOString(),
            action: 'intelligent_enter_sleep',
            reason: `loss_cluster_${recentLossExits}`,
            previousSymbol: session.symbol,
            nextScan: sleepConfig.nextScanDue
          }];
        await mergeSessionProfileJson(session.id, sleepConfig);
          await mergePlanContainer(session.id, { intelligentHistory: clampHistory(history) });
          return;
        }
      }
    } catch (err) {
      console.warn(`Loss-cluster evaluation failed for ${session.id}:`, err);
    }
    
    // Check if session is in sleep mode
    if (config?.sleepMode) {
      const nextScanDue = new Date(config?.nextScanDue || now);
      
      if (now < nextScanDue) {
        console.log(`💤 Session ${session.id}: Still in sleep mode until ${nextScanDue.toISOString()}`);
        return;
      }
      
      console.log(`⏰ Session ${session.id}: Waking up from sleep mode - scanning for opportunities`);
      
      // Adaptive relaxation after missed scans
      const miss = Math.max(0, Number((config?.sleepMisses ?? 0)));
      // Try to find opportunities after sleep (exclude current session) with relax
      const bestOpportunity = await getBestIntelligentOpportunity(session.id, { relaxSteps: miss >= 2 ? 1 : 0, aggressiveness });
      
      if (!bestOpportunity) {
        const nextCheck = new Date(now.getTime() + 1 * 60 * 60 * 1000); // 1h sleep extension (was 2h)
        const newMiss = miss + 1;
        console.log(`💤 Session ${session.id}: Still no opportunities - extending sleep for 1h (miss=${newMiss})`);
        // Persist sleepMisses to allow auto-relax after two misses
        try {
          const sleepCfg = { ...(config || {}), nextScanDue: nextCheck.toISOString(), lastScan: now.toISOString(), sleepMisses: newMiss };
        await mergeSessionProfileJson(session.id, sleepCfg);
        } catch {}
        await updateSessionNextCheck(session.id, nextCheck);
        return;
      }
      
      // Found opportunity - wake up session
      console.log(`🌅 Session ${session.id}: Waking up with opportunity ${bestOpportunity.symbol}`);
      
      const wakeUpConfig = {
        ...config,
        analysis: bestOpportunity,
        selectedAt: now.toISOString(),
        lastScan: now.toISOString(),
        nextScanDue: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(),
        // Seed minHoldHours based on current trend if not provided
        minHoldHours: Number((config as any)?.minHoldHours ?? (lastAdx >= 25 ? 10 : lastAdx >= 20 ? 8 : lastAdx >= 15 ? 6 : 3)),
        strategy: 'optimized_cost_efficient',
        sleepMode: false,
        sleepMisses: 0
      };
      
      const existingHistory = normalizePlanContainer(session.planJson).intelligentHistory || [];
      const newHistory = [...existingHistory, {
        timestamp: now.toISOString(),
        action: 'intelligent_wakeup',
        symbol: bestOpportunity.symbol,
        score: bestOpportunity.score,
        confidence: bestOpportunity.confidence,
        reasoning: bestOpportunity.reasoning.summary,
        sleepDuration: Math.round((now.getTime() - new Date(config?.selectedAt || now).getTime()) / (1000 * 60 * 60)) + 'h'
      }];
      
      // Ensure symbol profile exists
      try {
        await ensureSymbolProfile(bestOpportunity.symbol);
      } catch (error) {
        console.error(`Failed to ensure symbol profile for ${bestOpportunity.symbol}:`, error);
      }
      
      // Update session with selected symbol and wake up
      try {
        await prisma.$executeRaw`
          UPDATE "AgentSession" 
          SET "symbol" = ${bestOpportunity.symbol}, "currentSymbol" = ${bestOpportunity.symbol}, "lastSymbolSwitchAt" = NOW()
          WHERE id = ${session.id}
        `;
        console.log(`✅ symbol and currentSymbol updated to ${bestOpportunity.symbol} via SQL`);
      } catch (error) {
        console.error(`❌ SQL update failed:`, error);
      }
      
      await prisma.agentSession.update({
        where: { id: session.id },
        data: {
          profileJson: wakeUpConfig as any,
        }
      });
      await mergePlanContainer(session.id, { intelligentHistory: clampHistory(newHistory) });
      await refreshPlanAndStrategy(session.id, bestOpportunity.symbol, 'intelligent_wakeup');
      
      console.log(`✅ Session ${session.id} woken up with ${bestOpportunity.symbol}`);
      return;
    }
    
    // Normal session logic (not in sleep mode)
    const selectedAt = new Date(config?.selectedAt || now);
    const hoursSinceSelection = (now.getTime() - selectedAt.getTime()) / (1000 * 60 * 60);
    // Prefer explicit config, else dynamic based on ADX
    const minHoldHours = Math.max(2, Number((config as any)?.minHoldHours ?? dynamicMinHold));
    
    // RULE 1: Minimum hold period (configurable)
    if (hoursSinceSelection < minHoldHours) {
      const reversalHandled = await maybeHandleDirectionalReversal(
        session,
        config,
        now,
        minHoldHours,
        hoursSinceSelection,
        aggressiveness
      );
      if (reversalHandled) {
        return;
      }
      console.log(`⏱️ Session ${session.id}: Only ${hoursSinceSelection.toFixed(1)}h since selection (${minHoldHours}h minimum)`);
      return;
    }
    
    // RULE 2: Check if there were any trades (fills) in the last X hours ONLY (default 3h)
    let recentTrades = 0;
    let lastTradeAt: Date | null = null;
    let inactivityMinutes: number | null = null;
    try {
      const windowStart = new Date(now.getTime() - activityWindowMs);
      const recentActivity = await prisma.fill.aggregate({
        where: { sessionId: session.id, ts: { gte: windowStart } },
        _count: { _all: true },
        _max: { ts: true },
      });
      recentTrades = Number(recentActivity?._count?._all ?? 0);
      lastTradeAt = recentActivity?._max?.ts ? new Date(recentActivity._max.ts) : null;
    } catch (err) {
      console.warn(`⚠️ Failed to count recent fills for session ${session.id}:`, err);
      // fallback: do not block rotation on error
      recentTrades = 0;
      lastTradeAt = null;
    }

    const activityDecision = shouldDeferDueToRecentActivity({
      lastActivityAt: lastTradeAt,
      windowMs: activityWindowMs,
      now,
    });
    inactivityMinutes =
      activityDecision.inactivityMs != null
        ? Number((activityDecision.inactivityMs / 60000).toFixed(2))
        : null;

    if (activityDecision.shouldDefer) {
      const nextCheck = activityDecision.nextCheckAt ?? new Date(now.getTime() + activityWindowMs);
      console.log(
        `📈 Session ${session.id}: trade ${(inactivityMinutes ?? 0).toFixed(2)} min ago — deferring rotation for ${session.symbol} until ${nextCheck.toISOString()}`
      );

      try {
        await mergeSessionProfileJson(session.id, {
          lastScan: now.toISOString(),
          nextScanDue: nextCheck.toISOString(),
          pendingRotation: 'recent_activity_guard',
          pendingRotationDetails: {
            recentTrades,
            lastTradeAt: lastTradeAt?.toISOString() ?? null,
            inactivityMinutes,
            deferUntil: nextCheck.toISOString(),
          },
        });
      } catch (err) {
        console.warn(`⚠️ Failed to persist recent-activity guard for session ${session.id}:`, err);
      }

      await updateSessionNextCheck(session.id, nextCheck);

      recordOpsEvent({
        level: 'info',
        source: 'intelligent_rotation',
        message: 'skip_due_to_recent_activity',
        sessionId: session.id,
        symbol: session.symbol,
        details: {
          recentTrades,
          lastTradeAt: lastTradeAt?.toISOString() ?? null,
          inactivityMinutes,
          deferUntil: nextCheck.toISOString(),
        },
      });

      return;
    }

    if (recentTrades > 0) {
      console.log(
        `📈 Session ${session.id}: last trade ${inactivityMinutes != null ? inactivityMinutes.toFixed(2) : '??'} min ago meets inactivity threshold — continuing evaluation for ${session.symbol}`
      );
    }

    console.log(`🔍 Session ${session.id}: No trades in ${activityWindowHours}h+ - evaluating switch from ${session.symbol}`);

    // Refresh current symbol analysis so we compare against latest data
    let refreshedCurrent: IntelligentAnalysis | null = null;
    if (session.symbol) {
      try {
        refreshedCurrent = await calculateIntelligentScore(session.symbol);
      } catch (err) {
        console.warn(`⚠️ Failed to refresh analysis for current symbol ${session.symbol}:`, err);
      }
    }
    
    // Get current best opportunity using smart orchestrator (cost-optimized, context-aware)
    let bestOpportunity: IntelligentAnalysis | null = null;
    try {
      const smartEval = await import('../../smartSelectionOrchestrator.js').then(m => 
        m.evaluateSmartSwitch(session.id, session.symbol, session.id)
      );
      
      if (smartEval.shouldSwitch && smartEval.targetSymbol) {
        // Smart orchestrator found a better opportunity
        const targetAnalysis = await calculateIntelligentScore(smartEval.targetSymbol);
        if (targetAnalysis) {
          bestOpportunity = targetAnalysis;
          console.log(`🎯 Smart orchestrator recommended: ${smartEval.targetSymbol} (fast track: ${smartEval.fastTrack})`);
        }
      }
    } catch (error) {
      console.warn('Smart orchestrator failed, using legacy method:', error);
    }
    
    // Fallback to legacy method if smart orchestrator didn't find better
    if (!bestOpportunity) {
      bestOpportunity = await getBestIntelligentOpportunity(session.id, { aggressiveness });
    }
    
    const currentAnalysis = config?.analysis;
    const currentScore = refreshedCurrent?.score ?? currentAnalysis?.score ?? 0;
    
    if (!bestOpportunity) {
      console.log(`💤 Session ${session.id}: No opportunities found - switching to sleep mode for 2h`);
      
      // Switch to sleep mode instead of extending hold
      const sleepConfig = {
        ...config,
        analysis: null,
        lastScan: now.toISOString(),
        nextScanDue: new Date(now.getTime() + 1 * 60 * 60 * 1000).toISOString(), // 1h sleep (was 2h)
        sleepMode: true,
        sleepReason: 'No qualifying opportunities in market scan'
      };
      
      const existingHistory = normalizePlanContainer(session.planJson).intelligentHistory || [];
      const newHistory = [...existingHistory, {
        timestamp: now.toISOString(),
        action: 'intelligent_enter_sleep',
        reason: 'No qualifying opportunities found',
        previousSymbol: session.symbol,
        hoursHeld: hoursSinceSelection.toFixed(1),
        nextScan: sleepConfig.nextScanDue
      }];
      
      await mergeSessionProfileJson(session.id, sleepConfig);
      await mergePlanContainer(session.id, { intelligentHistory: clampHistory(newHistory) });
      
      console.log(`💤 Session ${session.id} entered sleep mode for 2h`);
      return;
    }
    
    // Check if we should switch (significant improvement + different symbol)
    const scoreImprovement = bestOpportunity.score - currentScore;
    const shouldSwitch = bestOpportunity.symbol !== session.symbol &&
                        scoreImprovement > 1.0 && // Higher threshold for switches
                        bestOpportunity.confidence > 0.75; // Higher confidence required
    
    if (shouldSwitch) {
      // Avoid duplicate allocation if another agent already took it
      if (await isSymbolInUse(bestOpportunity.symbol, session.id)) {
        console.log(`🚫 Allocation conflict on ${bestOpportunity.symbol} — skipping switch`);
        const nextCheck = new Date(now.getTime() + 2 * 60 * 60 * 1000);
        await updateSessionNextCheck(session.id, nextCheck);
        return;
      }
      console.log(`🔄 SWITCH: ${session.id} from ${session.symbol} to ${bestOpportunity.symbol}`);
      console.log(`📈 Score improvement: ${scoreImprovement.toFixed(1)} points (confidence: ${bestOpportunity.confidence})`);
      
      // Update session with new selection
      const updatedConfig = {
        ...config,
        analysis: bestOpportunity,
        selectedAt: now.toISOString(),
        lastScan: now.toISOString(),
        nextScanDue: new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString(), // 6h minimum (was 12h)
        switchReason: `No trades + ${scoreImprovement.toFixed(1)} score improvement`,
        sleepMode: false
      };
      
      const existingHistory = normalizePlanContainer(session.planJson).intelligentHistory || [];
      const newHistory = [...existingHistory, {
        timestamp: now.toISOString(),
        action: 'intelligent_switch_12h',
        fromSymbol: session.symbol,
        toSymbol: bestOpportunity.symbol,
        score: bestOpportunity.score,
        confidence: bestOpportunity.confidence,
        reasoning: bestOpportunity.reasoning.summary,
        hoursHeld: hoursSinceSelection.toFixed(1),
        trades: recentTrades
      }];
      
      // Ensure symbol profile exists
      try {
        await ensureSymbolProfile(bestOpportunity.symbol);
      } catch (error) {
        console.error(`Failed to ensure symbol profile for ${bestOpportunity.symbol}:`, error);
      }
      
      // Update both symbol and currentSymbol via SQL
      try {
        await prisma.$executeRaw`
          UPDATE "AgentSession" 
          SET "symbol" = ${bestOpportunity.symbol}, "currentSymbol" = ${bestOpportunity.symbol}, "lastSymbolSwitchAt" = NOW()
          WHERE id = ${session.id}
        `;
        console.log(`✅ symbol and currentSymbol updated to ${bestOpportunity.symbol} via SQL`);
      } catch (error) {
        console.error(`❌ SQL update failed:`, error);
      }
      
      await prisma.agentSession.update({
        where: { id: session.id },
        data: {
          profileJson: updatedConfig as any,
        }
      });
      await mergePlanContainer(session.id, { intelligentHistory: clampHistory(newHistory) });
      await refreshPlanAndStrategy(session.id, bestOpportunity.symbol, 'intelligent_switch');

    } else {
      // Keep current symbol, extend hold period
      console.log(`✅ Session ${session.id} keeping ${session.symbol} (insufficient improvement: ${scoreImprovement.toFixed(1)})`);
      const nextCheck = new Date(now.getTime() + 6 * 60 * 60 * 1000); // 6h retry (was 12h)

      const keepAnalysis = bestOpportunity.symbol === session.symbol
        ? bestOpportunity
        : (refreshedCurrent ?? currentAnalysis ?? bestOpportunity);

      const updatedConfig = {
        ...config,
        analysis: keepAnalysis,
        lastScan: now.toISOString(),
        nextScanDue: nextCheck.toISOString(),
        sleepMode: false
      };

      const existingHistory = normalizePlanContainer(session.planJson).intelligentHistory || [];
      const newHistory = [...existingHistory, {
        timestamp: now.toISOString(),
        action: 'intelligent_keep_refresh',
        symbol: session.symbol,
        score: keepAnalysis?.score,
        confidence: keepAnalysis?.confidence,
        reasoning: keepAnalysis?.reasoning?.summary,
        improvement: scoreImprovement,
        hoursHeld: hoursSinceSelection.toFixed(1),
        trades: recentTrades
      }];

      await prisma.agentSession.update({
        where: { id: session.id },
        data: {
          profileJson: updatedConfig as any,
        }
      });
      await mergePlanContainer(session.id, { intelligentHistory: clampHistory(newHistory) });
      await updateSessionNextCheck(session.id, nextCheck);
    }
    
  } catch (error) {
    console.error(`❌ Error checking opportunities for session ${session.id}:`, error);
  }
}

/**
 * Trigger manual re-selection for Smart Agent
 * Forces immediate crypto re-evaluation regardless of timing constraints
 */
export async function triggerIntelligentReselection(sessionId: string): Promise<{
  success: boolean;
  oldSymbol?: string;
  newSymbol?: string;
  currentSymbol?: string;
  reason: string;
}> {
  try {
    console.log(`🔄 Manual re-selection triggered for session ${sessionId}`);
    
    // Get current session
    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId }
    });
    
    if (!session) {
      return { success: false, reason: 'Session not found' };
    }
    
    const isSmartAgent = (session as any).isSmartAgent || false;
    if (!isSmartAgent) {
      return { success: false, reason: 'Not a Smart Agent' };
    }
    
    const currentSymbol = session.symbol;
    console.log(`📊 Current symbol: ${currentSymbol}`);
    
    // Extract aggressiveness from session profile
    const profileJson = (session.profileJson as any) || {};
    const aggressiveness: 'conservative' | 'reactive' | 'aggressive' = 
      profileJson.aggressiveness || 'reactive';
    
    // Compute best opportunity with confidence filter (exclude current session)
    const best = await getBestIntelligentOpportunity(sessionId, { aggressiveness });

    if (!best) {
      return {
        success: false,
        currentSymbol,
        reason: 'No confident opportunity (below threshold)'
      };
    }

    console.log(`🎯 Best opportunity found: ${best.symbol} (Score: ${best.score}, Confidence: ${best.confidence})`);

    // Check if it's different from current
    if (best.symbol === currentSymbol) {
      return {
        success: false,
        currentSymbol,
        reason: `${currentSymbol} is already the best option`
      };
    }
    
    // Ensure target symbol is not already in use
    if (await isSymbolInUse(best.symbol, sessionId)) {
      return {
        success: false,
        currentSymbol,
        reason: `Conflict: ${best.symbol} already in use by another agent`
      };
    }
    // Force symbol switch regardless of timing
    console.log(`🔄 Forcing switch: ${currentSymbol} → ${best.symbol}`);
    
    const now = new Date();
    const sessionPlan = normalizePlanContainer(session.planJson);
    const config = sessionPlan.intelligentConfig || {};
    
    // Update session with forced re-selection
    const updatedConfig = {
      ...config,
      selectedAt: now.toISOString(),
      lastScan: now.toISOString(),
      nextScanDue: new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString(), // 6h next scan
      switchReason: 'Manual re-selection triggered',
      sleepMode: false
    };
    
    const existingHistory = sessionPlan.intelligentHistory || [];
    const newHistory = clampHistory([...existingHistory, {
      timestamp: now.toISOString(),
      action: 'manual_reselection',
      fromSymbol: currentSymbol,
      toSymbol: best.symbol,
      reasoning: 'User-triggered manual re-selection',
      forced: true
    }]);
    
    // Ensure symbol profile exists
    try {
      await ensureSymbolProfile(best.symbol);
    } catch (error) {
      console.error(`Failed to ensure symbol profile for ${best.symbol}:`, error);
    }
    
    // Update database
    await prisma.$executeRaw`
      UPDATE "AgentSession" 
      SET "symbol" = ${best.symbol}, "currentSymbol" = ${best.symbol}, "lastSymbolSwitchAt" = NOW()
      WHERE "id" = ${sessionId}
    `;
    
    await mergePlanContainer(sessionId, {
      intelligentConfig: updatedConfig,
      intelligentHistory: newHistory,
    });
    await refreshPlanAndStrategy(sessionId, best.symbol, 'manual_reselection');
    
    console.log(`✅ Manual re-selection completed: ${currentSymbol} → ${best.symbol}`);
    
    return {
      success: true,
      oldSymbol: currentSymbol,
      newSymbol: best.symbol,
      reason: 'Manual re-selection successful'
    };
    
  } catch (error) {
    console.error(`❌ Manual re-selection error:`, error);
    return {
      success: false,
      reason: `Re-selection failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
// Compute normalized USD volume from ccxt ticker
export function volumeUsdFromTicker(ticker: any): number {
  try {
    // Prioritize info.volumeUsd24h for exchanges that provide it (e.g., Crypto.com)
    const infoVol = Number(ticker?.info?.volumeUsd24h || ticker?.info?.volume24h || ticker?.info?.volume || 0);
    if (infoVol && Number.isFinite(infoVol)) {
      console.log(`📊 Volume from info: ${infoVol} for ${ticker?.symbol}`);
      return infoVol;
    }
    
    // Fallback to standard CCXT fields
    const qv = Number(ticker?.quoteVolume || 0);
    if (qv && Number.isFinite(qv)) {
      console.log(`📊 Volume from quoteVolume: ${qv} for ${ticker?.symbol}`);
      return qv;
    }
    
    const bv = Number(ticker?.baseVolume || 0);
    const last = Number(ticker?.last || 0);
    const calcVol = bv > 0 && last > 0 ? bv * last : 0;
    if (calcVol > 0) {
      console.log(`📊 Volume calculated: ${calcVol} (${bv} * ${last}) for ${ticker?.symbol}`);
      return calcVol;
    }
  } catch (e) {
    console.log(`❌ Error calculating volume for ${ticker?.symbol}:`, e);
  }
  console.log(`📊 Volume: 0 for ${ticker?.symbol}`);
  return 0;
}

/**
 * SMART QUALITY SCORING - Objective criteria based scoring
 * 
 * Instead of arbitrary tier bonuses, we use measurable quality metrics:
 * - Liquidity (volume) affects execution quality
 * - Spread affects trading costs
 * - Movement/volatility ratio indicates exceptional opportunities
 * - Setup quality from technical analysis
 * 
 * Result: Captures best risk/reward regardless of crypto "name"
 * @public - Exported for testing
 */
export function applySmartQualityAdjustments(params: {
  symbol: string;
  volumeUsd: number;
  spread?: number; // in percentage
  movement: number; // percentage change
  avgVolatility?: number; // typical daily movement
  setupQuality?: number; // 0-10 from technical analysis
}): {
  adjustments: number;
  reasons: string[];
  minMovement: number;
  label: string;
} {
  let adjustments = 0;
  const reasons: string[] = [];
  const qualityContext = buildSymbolQualityContext(params.symbol);
  
  // 1. LIQUIDITY ADJUSTMENT (objective execution quality)
  if (params.volumeUsd < 50_000_000) {
    adjustments -= 1.5;
    reasons.push('Very low liquidity -1.5 (high slippage risk)');
  } else if (params.volumeUsd < 200_000_000) {
    adjustments -= 0.5;
    reasons.push('Low liquidity -0.5 (some slippage expected)');
  } else if (params.volumeUsd > 1_000_000_000) {
    adjustments += 0.3;
    reasons.push('Excellent liquidity +0.3 (minimal slippage)');
  }
  
  // 2. SPREAD ADJUSTMENT (real trading cost)
  const spread = params.spread || (params.volumeUsd < 100_000_000 ? 0.1 : 0.02); // Estimate if not provided
  if (spread > 0.1) {
    adjustments -= 1.0;
    reasons.push('High spread -1.0 (expensive to trade)');
  } else if (spread < 0.02) {
    adjustments += 0.5;
    reasons.push('Tight spread +0.5 (low cost)');
  }
  
  // 3. EXCEPTIONAL MOVEMENT BONUS (volatility-adjusted)
  const avgVol = params.avgVolatility || 2.0; // Default 2% typical daily movement
  const volatilityRatio = Math.abs(params.movement) / avgVol;
  if (volatilityRatio > 3.0) {
    adjustments += 1.0;
    reasons.push(`Exceptional movement +1.0 (${volatilityRatio.toFixed(1)}x typical)`);
  } else if (volatilityRatio < 1.0) {
    adjustments -= 0.5;
    reasons.push('Normal movement -0.5 (not exceptional)');
  }
  
  // 4. SETUP QUALITY BONUS (technical confirmation)
  const setupQuality = params.setupQuality || 5.0;
  if (setupQuality >= 8.0) {
    adjustments += 0.5;
    reasons.push('Clean setup +0.5 (strong technical confirmation)');
  }
  
  // Quality premium/penalty based on symbol family
  if (qualityContext.isBlueChip) {
    adjustments += 0.5;
    reasons.push('Blue-chip liquidity premium +0.5');
  } else if (qualityContext.family === 'major') {
    adjustments += 0.25;
    reasons.push('Major cap liquidity premium +0.25');
  } else if (qualityContext.isMeme) {
    adjustments -= 0.8;
    reasons.push('Meme/speculative asset -0.8 (requires exceptional confirmation)');
  } else {
    adjustments -= 0.2;
    reasons.push('Unproven altcoin -0.2 (demand stronger confluence)');
  }

  // Determine minimum movement threshold (based on liquidity profile and quality)
  let minMovement = 0.8; // Default baseline
  if (params.volumeUsd < 35_000_000) minMovement = 3.5; // Need big moves to justify risk
  else if (params.volumeUsd < 75_000_000) minMovement = 2.0;
  else if (params.volumeUsd < 200_000_000) minMovement = 1.0;
  else if (params.volumeUsd > 1_000_000_000) minMovement = 0.4; // Can trade small moves

  if (qualityContext.isMeme) {
    minMovement = Math.max(minMovement, 4.0);
  } else if (!qualityContext.isBlueChip && qualityContext.family !== 'major') {
    minMovement = Math.max(minMovement, 2.5);
  }

  // Label based on actual characteristics and quality
  let label: string;
  if (qualityContext.isMeme) {
    label = params.volumeUsd >= 100_000_000 ? 'Meme (High Liquidity)' : 'Meme (Speculative)';
  } else if (qualityContext.isBlueChip) {
    label = params.volumeUsd > 1_000_000_000 ? 'Blue Chip Mega Cap' : 'Blue Chip Major';
  } else if (qualityContext.family === 'major') {
    label = params.volumeUsd > 200_000_000 ? 'Large Cap Major' : 'Major Alt (Monitor liquidity)';
  } else if (params.volumeUsd > 200_000_000) {
    label = 'Mid Cap Alt (Good)';
  } else if (params.volumeUsd > 50_000_000) {
    label = 'Small Cap Alt (Risky)';
  } else {
    label = 'Micro Cap (Very Risky)';
  }
  
  return { adjustments, reasons, minMovement, label };
}

// Smart eligibility criteria (dynamic, not static):
// - Must pass dynamic USD volume guardrails (≥$35M for altcoins, higher for memes)
// - Stricter thresholds for sub-penny and complex/long symbols
export function isSymbolEligibleForAuto(base: string, params: { last: number; volumeUsd: number }, opts?: { aggressiveness?: 'conservative'|'reactive'|'aggressive' }): { ok: boolean; reason?: string; minRequired?: number } {
  const cfg = getConfig();
  const level = opts?.aggressiveness || 'reactive';
  const minByLevel = level === 'conservative' ? cfg.AUTO_MIN_USD_VOLUME_CONSERVATIVE || 75_000_000 :
                     level === 'aggressive' ? cfg.AUTO_MIN_USD_VOLUME_AGGRESSIVE || 35_000_000 :
                     cfg.AUTO_MIN_USD_VOLUME_REACTIVE || 50_000_000; // Équilibre optimal sécurité/opportunités
  const vol = Number(params.volumeUsd || 0);
  const px = Number(params.last || 0);
  if (vol < minByLevel) return { ok: false, reason: 'min_usd_volume', minRequired: minByLevel };
  
  const qualityContext = buildSymbolQualityContext(base);
  
  // 🔒 PROTECTION: Sub-penny tokens sont souvent très volatils (ex: SAPIEN à 0.44$ a chuté -7.8%)
  // Exception pour les blue chips établies (ADA, XRP, etc.) avec volume massif
  if (px > 0 && px < 1.0 && vol < 5_000_000) {
    // Autoriser les majors/blue chips même sub-penny si volume > $100M
    const isEstablished = qualityContext.isBlueChip || qualityContext.family === 'major';
    const hasStrongVolume = vol >= 100_000_000; // $100M+
    
    if (!isEstablished || !hasStrongVolume) {
      return { ok: false, reason: 'subpenny_volatile_low_volume', minRequired: 5_000_000 };
    }
  }
  
  // Complex/long symbols (often micro-caps) must have higher volume
  const isComplex = base.length >= 6 || /[0-9]/.test(base);
  if (isComplex && vol < 3_000_000) return { ok: false, reason: 'complex_symbol_low_volume', minRequired: 3_000_000 };
  // Meme-like names must have extremely strong liquidity
  if (qualityContext.isMeme && vol < 50_000_000) {
    return { ok: false, reason: 'meme_low_volume', minRequired: 50_000_000 };
  }

  const guardrail = evaluateSymbolLiquidityGuardrails(base, vol, px, { aggressiveness: level });
  if (!guardrail.ok) return guardrail;
  return { ok: true };
}

registerUniverseFetcher((excludeSessionId?: string, attempt: number = AUTO_UNIVERSE_MAX_ATTEMPTS) =>
  getOptimizedCryptoList(excludeSessionId, attempt),
);

// Export bias monitoring functions
export { logBiasStatistics, hasSignificantBias, getBiasStatistics } from '../biasMonitor.js';

export {
  evaluateOpportunity,
  fitProbabilityModel,
  updateBandit,
} from '../../../ai/evPipeline.js';
