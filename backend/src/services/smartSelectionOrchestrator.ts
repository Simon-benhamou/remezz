/**
 * Smart Selection Orchestrator
 * 
 * Intelligent crypto selection system with:
 * - Fast track monitoring (1min cycle via WebSocket)
 * - Adaptive universe refresh with intelligent caching
 * - Context-aware scoring (market regime)
 * - Cost-optimized AI (batch calls, ML first)
 * - Memory system to avoid redundant analysis
 */

import { prisma } from '../db/client.js';
import { createLogger } from '../utils/logger.js';
import { getOptimizedCryptoList, calculateIntelligentScore, type IntelligentAnalysis } from './intelligentAgent/strategies/core.js';
import { getAllTickersFromWebSocket } from './binanceWebSocket.js';
import { getConfig } from '../utils/env.js';
import { buildTechSnapshot } from '../ai/tech.js';
import { computeMultiTimeframeDiagnostics } from '../ai/multiTimeframe.js';

const logger = createLogger('smart-selection');

// ============================================
// TYPES
// ============================================

type MarketRegime = 'bull' | 'bear' | 'neutral' | 'volatile';

type CachedOpportunity = {
  symbol: string;
  score: number;
  confidence: number;
  analysis: IntelligentAnalysis;
  timestamp: number;
  marketRegime: MarketRegime;
};

type UniverseCache = {
  symbols: string[];
  timestamp: number;
  marketRegime: MarketRegime;
  ttl: number; // Dynamic TTL based on regime
};

type FastTrackMonitor = {
  currentSymbol: string;
  alternatives: string[]; // Top 5 alternatives to monitor
  lastCheck: number;
};

// ============================================
// STATE
// ============================================

const universeCache: Map<string, UniverseCache> = new Map();
const opportunityCache: Map<string, CachedOpportunity> = new Map();
const fastTrackMonitors: Map<string, FastTrackMonitor> = new Map(); // sessionId -> monitor
const analysisMemory: Map<string, number> = new Map(); // symbol -> last full analysis timestamp

// Cache TTL based on market regime
const REGIME_TTL = {
  bull: 15 * 60 * 1000,      // 15min in trending market
  bear: 15 * 60 * 1000,      // 15min in trending market
  neutral: 10 * 60 * 1000,   // 10min in ranging market
  volatile: 5 * 60 * 1000,   // 5min in volatile market
};

const FAST_TRACK_INTERVAL = 60 * 1000; // 1 minute
const MEMORY_RETENTION = 30 * 60 * 1000; // 30 minutes
const STRONG_SIGNAL_THRESHOLD = 0.80; // 80% confidence for immediate switch

// ============================================
// MARKET REGIME DETECTION
// ============================================

async function detectMarketRegime(): Promise<MarketRegime> {
  try {
    // Use BTC as market proxy
    const btcTech = await buildTechSnapshot('BTC/USDT');
    const btcMtf = await computeMultiTimeframeDiagnostics('BTC/USDT');
    
    const atrPct = (btcTech.atr14 / btcTech.last) * 100;
    const adx = btcTech.adx14;
    const change24h = ((btcTech.last - (btcTech as any).open24h) / (btcTech as any).open24h) * 100;
    const divergenceScore = btcMtf?.divergenceScore ?? 0;
    
    // Volatile: High ATR + divergence
    if (atrPct > 4.0 || divergenceScore > 2) {
      logger.info(`Market regime: VOLATILE (ATR: ${atrPct.toFixed(2)}%, divergence: ${divergenceScore.toFixed(2)})`);
      return 'volatile';
    }
    
    // Trending: High ADX
    if (adx > 25) {
      const regime = change24h > 1 ? 'bull' : change24h < -1 ? 'bear' : 'neutral';
      logger.info(`Market regime: ${regime.toUpperCase()} (ADX: ${adx.toFixed(1)}, change: ${change24h.toFixed(2)}%)`);
      return regime;
    }
    
    // Neutral/ranging
    logger.info(`Market regime: NEUTRAL (ADX: ${adx.toFixed(1)}, ATR: ${atrPct.toFixed(2)}%)`);
    return 'neutral';
  } catch (error) {
    logger.warn('Failed to detect market regime, defaulting to neutral:', error);
    return 'neutral';
  }
}

// ============================================
// ADAPTIVE UNIVERSE MANAGEMENT
// ============================================

export async function getAdaptiveUniverse(
  excludeSessionId?: string,
  forceRefresh = false
): Promise<string[]> {
  const cacheKey = 'main_universe';
  const cached = universeCache.get(cacheKey);
  const now = Date.now();
  
  // Detect current market regime
  const currentRegime = await detectMarketRegime();
  const ttl = REGIME_TTL[currentRegime];
  
  // Use cache if valid and regime hasn't changed dramatically
  if (!forceRefresh && cached && (now - cached.timestamp) < cached.ttl) {
    // Regime change requires refresh
    if (cached.marketRegime === currentRegime || 
        (cached.marketRegime !== 'volatile' && currentRegime !== 'volatile')) {
      logger.debug(`Using cached universe (${cached.symbols.length} symbols, age: ${((now - cached.timestamp) / 1000).toFixed(0)}s)`);
      return cached.symbols;
    }
  }
  
  logger.info(`Refreshing universe (regime: ${currentRegime}, TTL: ${(ttl / 60000).toFixed(0)}min)`);
  
  // Fetch new universe
  const symbols = await getOptimizedCryptoList(excludeSessionId);
  
  // Store in cache with regime-specific TTL
  universeCache.set(cacheKey, {
    symbols,
    timestamp: now,
    marketRegime: currentRegime,
    ttl,
  });
  
  logger.info(`Universe refreshed: ${symbols.length} symbols`);
  return symbols;
}

// ============================================
// FAST TRACK MONITORING
// ============================================

async function updateFastTrackMonitor(sessionId: string, currentSymbol: string, topAlternatives: string[]): Promise<void> {
  fastTrackMonitors.set(sessionId, {
    currentSymbol,
    alternatives: topAlternatives.slice(0, 5), // Top 5 alternatives
    lastCheck: Date.now(),
  });
}

async function fastTrackCheck(sessionId: string): Promise<{ shouldSwitch: boolean; targetSymbol?: string; reason?: string }> {
  const monitor = fastTrackMonitors.get(sessionId);
  if (!monitor) {
    return { shouldSwitch: false };
  }
  
  const now = Date.now();
  if (now - monitor.lastCheck < FAST_TRACK_INTERVAL) {
    return { shouldSwitch: false };
  }
  
  try {
    // Get WebSocket tickers for real-time data (0 latency)
    const wsTickersMap = await getAllTickersFromWebSocket();
    if (!wsTickersMap) {
      logger.debug('WebSocket tickers unavailable for fast track');
      return { shouldSwitch: false };
    }
    
    // Quick score current vs alternatives using cached data + real-time price
    const currentCached = opportunityCache.get(monitor.currentSymbol);
    if (!currentCached) {
      return { shouldSwitch: false };
    }
    
    let bestAlternative: { symbol: string; score: number; confidence: number } | null = null;
    
    for (const altSymbol of monitor.alternatives) {
      const altCached = opportunityCache.get(altSymbol);
      if (!altCached) continue;
      
      // Check if alternative has significantly better score AND high confidence
      if (altCached.score > currentCached.score * 1.15 && // 15% better
          altCached.confidence >= STRONG_SIGNAL_THRESHOLD) {
        if (!bestAlternative || altCached.score > bestAlternative.score) {
          bestAlternative = {
            symbol: altSymbol,
            score: altCached.score,
            confidence: altCached.confidence,
          };
        }
      }
    }
    
    monitor.lastCheck = now;
    
    if (bestAlternative) {
      logger.info(`🚀 Fast track switch detected: ${monitor.currentSymbol} → ${bestAlternative.symbol} (score: ${bestAlternative.score.toFixed(3)}, conf: ${(bestAlternative.confidence * 100).toFixed(1)}%)`);
      return {
        shouldSwitch: true,
        targetSymbol: bestAlternative.symbol,
        reason: `strong_signal_confidence_${(bestAlternative.confidence * 100).toFixed(0)}`,
      };
    }
    
    return { shouldSwitch: false };
  } catch (error) {
    logger.warn('Fast track check failed:', error);
    return { shouldSwitch: false };
  }
}

// ============================================
// CONTEXTUAL SCORING
// ============================================

async function scoreOpportunityWithContext(
  symbol: string,
  marketRegime: MarketRegime,
  excludeSessionId?: string
): Promise<CachedOpportunity | null> {
  // Check analysis memory to avoid redundant work
  const lastAnalysis = analysisMemory.get(symbol);
  const now = Date.now();
  
  if (lastAnalysis && (now - lastAnalysis) < MEMORY_RETENTION) {
    const cached = opportunityCache.get(symbol);
    if (cached && cached.marketRegime === marketRegime) {
      logger.debug(`Using memory cache for ${symbol} (age: ${((now - lastAnalysis) / 1000).toFixed(0)}s)`);
      return cached;
    }
  }
  
  try {
    // Get intelligent score
    const analysis = await calculateIntelligentScore(symbol, { excludeSessionId });
    if (!analysis) return null;
    
    // Apply regime-specific adjustments based on actual IntelligentAnalysis structure
    let regimeMultiplier = 1.0;
    
    switch (marketRegime) {
      case 'bull':
        // Favor momentum in bull markets
        if (analysis.metrics.momentum > 0.7) {
          regimeMultiplier = 1.15;
        }
        break;
      
      case 'bear':
        // Favor quality (hurst exponent) in bear markets
        if (analysis.metrics.hurst > 0.6) {
          regimeMultiplier = 1.10;
        }
        break;
      
      case 'volatile':
        // Favor established coins with good liquidity in volatile markets
        if (analysis.metrics.volume24h > 50_000_000) {
          regimeMultiplier = 1.20;
        }
        break;
      
      case 'neutral':
        // No adjustment in neutral markets
        break;
    }
    
    const adjustedScore = analysis.score * regimeMultiplier;
    
    const opportunity: CachedOpportunity = {
      symbol,
      score: adjustedScore,
      confidence: analysis.confidence,
      analysis,
      timestamp: now,
      marketRegime,
    };
    
    // Store in caches
    opportunityCache.set(symbol, opportunity);
    analysisMemory.set(symbol, now);
    
    // Cleanup old entries
    if (analysisMemory.size > 200) {
      const oldestEntries = Array.from(analysisMemory.entries())
        .sort((a, b) => a[1] - b[1])
        .slice(0, 50);
      
      oldestEntries.forEach(([sym]) => {
        analysisMemory.delete(sym);
        opportunityCache.delete(sym);
      });
    }
    
    return opportunity;
  } catch (error) {
    logger.warn(`Failed to score ${symbol}:`, error);
    return null;
  }
}

// ============================================
// BATCH ANALYSIS (COST-OPTIMIZED)
// ============================================

async function batchAnalyzeOpportunities(
  symbols: string[],
  marketRegime: MarketRegime,
  excludeSessionId?: string,
  limit = 10
): Promise<CachedOpportunity[]> {
  logger.info(`Batch analyzing ${symbols.length} symbols (limit: ${limit})...`);
  
  const results: CachedOpportunity[] = [];
  const symbolsToAnalyze = symbols.slice(0, Math.min(symbols.length, 50)); // Max 50 for performance
  
  // Parallel analysis with concurrency limit
  const concurrency = 5;
  for (let i = 0; i < symbolsToAnalyze.length; i += concurrency) {
    const batch = symbolsToAnalyze.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(symbol => scoreOpportunityWithContext(symbol, marketRegime, excludeSessionId))
    );
    
    for (const result of batchResults) {
      if (result.status === 'fulfilled' && result.value) {
        results.push(result.value);
      }
    }
    
    // Early exit if we have enough high-quality results
    const highQualityResults = results.filter(r => r.score > 0.5 && r.confidence > 0.6);
    if (highQualityResults.length >= limit) {
      logger.info(`Early exit: found ${highQualityResults.length} high-quality opportunities`);
      break;
    }
  }
  
  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  
  logger.info(`Batch analysis complete: ${results.length} valid opportunities`);
  return results.slice(0, limit);
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Get best opportunity for a new agent
 */
export async function selectBestOpportunity(excludeSessionId?: string): Promise<{
  symbol: string;
  score: number;
  confidence: number;
  analysis: IntelligentAnalysis;
  marketRegime: MarketRegime;
  alternatives: string[];
}> {
  logger.info('🎯 Selecting best opportunity...');
  
  // Get adaptive universe
  const universe = await getAdaptiveUniverse(excludeSessionId);
  const marketRegime = await detectMarketRegime();
  
  // Batch analyze top opportunities
  const opportunities = await batchAnalyzeOpportunities(universe, marketRegime, excludeSessionId, 10);
  
  if (opportunities.length === 0) {
    throw new Error('No valid opportunities found');
  }
  
  const best = opportunities[0];
  const alternatives = opportunities.slice(1, 6).map(o => o.symbol);
  
  logger.info(`✅ Selected ${best.symbol} (score: ${best.score.toFixed(3)}, confidence: ${(best.confidence * 100).toFixed(1)}%)`);
  logger.info(`📊 Alternatives: ${alternatives.join(', ')}`);
  
  return {
    symbol: best.symbol,
    score: best.score,
    confidence: best.confidence,
    analysis: best.analysis,
    marketRegime,
    alternatives,
  };
}

/**
 * Evaluate if smart agent should switch symbol
 */
export async function evaluateSmartSwitch(
  sessionId: string,
  currentSymbol: string,
  excludeSessionId?: string
): Promise<{
  shouldSwitch: boolean;
  targetSymbol?: string;
  currentScore: number;
  targetScore?: number;
  reason?: string;
  fastTrack: boolean;
}> {
  // First: Fast track check (1min cycle, WebSocket-based)
  const fastTrack = await fastTrackCheck(sessionId);
  if (fastTrack.shouldSwitch && fastTrack.targetSymbol) {
    return {
      shouldSwitch: true,
      targetSymbol: fastTrack.targetSymbol,
      currentScore: 0, // Will be calculated if needed
      targetScore: 1, // Placeholder
      reason: fastTrack.reason,
      fastTrack: true,
    };
  }
  
  // Second: Full evaluation (every 30min or on demand)
  const universe = await getAdaptiveUniverse(excludeSessionId);
  const marketRegime = await detectMarketRegime();
  
  // Score current symbol
  const currentOpp = await scoreOpportunityWithContext(currentSymbol, marketRegime, excludeSessionId);
  if (!currentOpp) {
    logger.warn(`Failed to score current symbol ${currentSymbol}`);
    return { shouldSwitch: false, currentScore: 0, fastTrack: false };
  }
  
  // Find best alternative
  const opportunities = await batchAnalyzeOpportunities(universe, marketRegime, excludeSessionId, 10);
  
  // Filter out current symbol
  const alternatives = opportunities.filter(o => o.symbol !== currentSymbol);
  
  if (alternatives.length === 0) {
    logger.info(`No alternatives found, keeping ${currentSymbol}`);
    
    // Update fast track monitor
    await updateFastTrackMonitor(sessionId, currentSymbol, []);
    
    return { shouldSwitch: false, currentScore: currentOpp.score, fastTrack: false };
  }
  
  const best = alternatives[0];
  
  // Update fast track monitor with top alternatives
  await updateFastTrackMonitor(sessionId, currentSymbol, alternatives.slice(0, 5).map(a => a.symbol));
  
  // Require significant improvement (20%) to avoid churn
  const SWITCH_THRESHOLD = 1.20;
  const shouldSwitch = best.score > currentOpp.score * SWITCH_THRESHOLD;
  
  if (shouldSwitch) {
    logger.info(`🔄 Switch recommended: ${currentSymbol} (${currentOpp.score.toFixed(3)}) → ${best.symbol} (${best.score.toFixed(3)})`);
  } else {
    logger.info(`✋ Keeping ${currentSymbol} (current: ${currentOpp.score.toFixed(3)}, best alt: ${best.symbol} ${best.score.toFixed(3)})`);
  }
  
  return {
    shouldSwitch,
    targetSymbol: shouldSwitch ? best.symbol : undefined,
    currentScore: currentOpp.score,
    targetScore: best.score,
    reason: shouldSwitch ? 'better_opportunity' : 'current_optimal',
    fastTrack: false,
  };
}

/**
 * Force refresh universe (for manual triggers or market regime changes)
 */
export async function forceUniverseRefresh(excludeSessionId?: string): Promise<string[]> {
  logger.info('🔄 Force refreshing universe...');
  return getAdaptiveUniverse(excludeSessionId, true);
}

/**
 * Get cached opportunities (for debugging/monitoring)
 */
export function getCachedOpportunities(limit = 10): CachedOpportunity[] {
  const opportunities = Array.from(opportunityCache.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  
  return opportunities;
}

/**
 * Clear all caches (for testing or resets)
 */
export function clearAllCaches(): void {
  universeCache.clear();
  opportunityCache.clear();
  analysisMemory.clear();
  fastTrackMonitors.clear();
  logger.info('All caches cleared');
}
