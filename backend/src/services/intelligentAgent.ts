import { prisma } from '../db/client.js';
import { getTicker } from '../data/market.js';
import { fullAnalysis, computeProjection } from '../ai/analysis.js';
import { buildTechSnapshot } from '../ai/tech.js';
import { getAIRankedOpportunities, type RankedOpportunity } from '../ai/cryptoRanking.js';
import ccxt from 'ccxt';
import { getConfig } from '../utils/env.js';
import { computeMultiTimeframeDiagnostics, type Diagnostics as MultiTimeframeDiagnostics } from '../ai/multiTimeframe.js';
import { getAdaptiveWeightsForSymbol } from '../learning/adaptiveWeights.js';
import { recordDecisionSnapshot, markDecisionCancelled } from '../learning/decisionMemory.js';
import { getHybridSentiment } from '../sentiment/index.js';
import { getAllTickersFromWebSocket, adaptBinanceTickerToCcxt, toBinanceSymbolId } from '../services/binanceWebSocket.js';
import type { BinanceTickerData } from '../services/binanceWebSocket.js';

// HYBRID INTELLIGENT: ML local + IA ultra-conditionnelle
const aiAnalysisCache = new Map<string, { result: any; timestamp: number }>();
const volatilityCache = new Map<string, boolean>();
const mlPredictionCache = new Map<string, { confidence: number; prediction: string; reasoning: string; timestamp: number }>();
const CACHE_DURATION_AI = 30 * 60 * 1000; // 30min cache IA (plus long)
const CACHE_DURATION_VOLATILITY = 5 * 60 * 1000; // 5min cache volatilité
const CACHE_DURATION_ML = 15 * 60 * 1000; // 15min cache ML

// AUTO-DIRECTIONAL: Détection automatique du bias optimal (VERSION AGRESSIVE)
function determineOptimalBias(symbol: string, metrics: any): { bias: 'long' | 'short' | 'none'; confidence: number; reasoning: string } {
  const { rsi, adx, momentum, trendStrength, volume24h } = metrics;
  
  let bullScore = 0;
  let bearScore = 0;
  const signals: string[] = [];
  
  // 🔥 CRYPTO EXTREME MOVES: Bonus pour gros mouvements (AVNT -21% = opportunité!)
  const extremeMove = Math.abs(momentum);
  if (extremeMove > 10) { // >10% mouvement = opportunité extrême
    if (momentum < -5) {
      bullScore += 40; // Oversold extreme = rebond possible
      signals.push(`Extreme dump -${extremeMove.toFixed(1)}% (oversold bounce)`);
    } else if (momentum > 5) {
      bearScore += 40; // Overbought extreme = correction possible
      signals.push(`Extreme pump +${extremeMove.toFixed(1)}% (overbought correction)`);
    }
  } else if (extremeMove > 5) { // >5% mouvement = opportunité forte
    if (momentum < -2) {
      bullScore += 25;
      signals.push(`Strong selloff -${extremeMove.toFixed(1)}% (reversal chance)`);
    } else if (momentum > 2) {
      bearScore += 25;
      signals.push(`Strong pump +${extremeMove.toFixed(1)}% (pullback chance)`);
    }
  }
  
  // Analyse RSI (plus permissif)
  if (rsi < 40) { // Élargi de 35 à 40
    bullScore += rsi < 25 ? 35 : 25; // Bonus si très oversold
    signals.push(`RSI ${rsi.toFixed(0)} oversold`);
  } else if (rsi > 60) { // Élargi de 65 à 60
    bearScore += rsi > 75 ? 35 : 25; // Bonus si très overbought
    signals.push(`RSI ${rsi.toFixed(0)} overbought`);
  }
  
  // Analyse ADX (trend strength)
  if (adx > 25) {
    const adxBonus = Math.min(20, adx - 15); // Bonus progressif
    if (momentum < 0) {
      // Trend baissier fort = soit continuation soit reversal imminent
      if (rsi < 35) {
        bullScore += adxBonus; // RSI oversold + trend fort = reversal
        signals.push('Strong downtrend + oversold RSI (reversal setup)');
      } else {
        bearScore += adxBonus; // Continuation baissière
        signals.push('Strong downtrend continuation');
      }
    } else {
      // Trend haussier fort
      if (rsi > 65) {
        bearScore += adxBonus; // Trend haut + RSI overbought = correction
        signals.push('Strong uptrend + overbought RSI (correction setup)');
      } else {
        bullScore += adxBonus; // Continuation haussière
        signals.push('Strong uptrend continuation');
      }
    }
  }
  
  // Volume confirmation (plus accessible)
  if (volume24h > 100_000_000) { // Réduit de 500M à 100M
    const volumeBonus = Math.min(15, (volume24h / 100_000_000) * 5);
    if (extremeMove > 3) {
      // Volume élevé + mouvement extrême = confirmation
      if (momentum < 0) bullScore += volumeBonus;
      else bearScore += volumeBonus;
      signals.push('High volume + extreme move');
    }
  }
  
  // CRYPTO MAJORS: Bonus pour cryptos connus
  const majorCryptos = ['BTC/USDT', 'ETH/USDT', 'AVNT/USDT', 'SOL/USDT', 'SUI/USDT', 'XRP/USDT', 'ADA/USDT'];
  if (majorCryptos.includes(symbol)) {
    const majorBonus = 10;
    if (bullScore > bearScore) bullScore += majorBonus;
    else bearScore += majorBonus;
    signals.push('Major crypto');
  }
  
  // Determine bias et confidence (seuil réduit)
  const maxScore = Math.max(bullScore, bearScore);
  const bias = maxScore < 35 ? 'none' : // Réduit de 50 à 35
               bullScore > bearScore ? 'long' : 'short';
  
  const confidence = Math.min(maxScore, 100);
  const reasoning = `${bias.toUpperCase()} bias (${confidence}%): ${signals.join(' + ')}`;
  
  console.log(`🎯 Auto-Bias for ${symbol}: ${reasoning}`);
  return { bias, confidence, reasoning };
}

// Machine Learning Local - Prédiction sans coût API
function predictWithLocalML(symbol: string, rsi: number, adx: number, momentum: number, volume: number): { confidence: number; prediction: string; reasoning: string } {
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
import { proposePlan } from '../ai/planOrchestrator.js';
import { requestStrategy } from '../ai/strategyManager.js';
import { AgentHub } from '../agent/hub.js';
import { broadcast } from '../ws/hub.js';
import { mergePlanContainer, savePlan, normalizePlanContainer } from './planStore.js';
import type { ActivationProfile } from '../agent/state.js';

/**
 * Get list of symbols currently being traded by active agents
 * Normalizes different symbol formats for comparison
 */
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
      select: { symbol: true }
    });
    
    return activeSessions
      .map(session => session.symbol)
      .filter(symbol => symbol) // Remove null/undefined
      .map(symbol => {
        // Normalize symbol formats for comparison
        // Convert ETH/USD:USD → ETH/USDT
        // Convert BTC/USD:USD → BTC/USDT
        // Keep DOGE/USDT as is
        if (symbol.includes('/USD:USD')) {
          const base = symbol.split('/')[0];
          return `${base}/USDT`;
        }
        return symbol;
      })
      .filter((symbol, index, arr) => arr.indexOf(symbol) === index); // Remove duplicates
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

    if (agent) {
      await agent.propose(plan as any);
      await agent.validateAndArm();
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
export async function getOptimizedCryptoList(excludeSessionId?: string): Promise<string[]> {
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
      return await getTopCryptos(excludeSessionId);
    }

    const exchange = new ExchangeClass({
      enableRateLimit: true,
      options: { defaultType: 'swap' }
    });

    await exchange.loadMarkets();
    
    // Get all markets and filter for USD-settled perpetuals (Crypto.com format)
    const allMarkets = Object.keys(exchange.markets || {});
    console.log(`📊 Found ${allMarkets.length} total markets`);
    
    const perpetualMarkets = allMarkets.filter(symbol => {
      try {
        if (!symbol || typeof symbol !== 'string') return false;
        
        const market = exchange.markets[symbol];
        if (!market) return false;
        
        // Crypto.com uses USD-settled perpetuals in format: SYMBOL/USD:USD
        return market.swap === true && 
               market.active === true &&
               market.settle === 'USD' && // USD-settled perpetuals
               symbol.includes('/USD:USD'); // Perpetual format on Crypto.com
      } catch (error) {
        return false;
      }
    });
    
    console.log(`📊 Found ${perpetualMarkets.length} perpetual markets, fetching tickers...`);
    
    if (perpetualMarkets.length === 0) {
      console.log('📊 No perpetual markets found, falling back to static list');
      return await getTopCryptos(excludeSessionId);
    }

    // Fetch MORE tickers to get better selection - PRIORITIZE major cryptos
    const sampleSize = Math.min(perpetualMarkets.length, 100); // Analyze more markets for better selection
    
    // DYNAMIC DISCOVERY: Sort all markets by volume for intelligent prioritization
    console.log('🔍 Performing dynamic market discovery based on real-time volumes...');
    
    // Fetch ALL tickers first to get real volumes
    const allTickers = {} as Record<string, any>;
    console.log('📊 Fetching volumes for dynamic ranking...');

    const isBinanceExchange = String((exchange as any)?.id || '').toLowerCase().includes('binance');
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
        const ticker = await exchange.fetchTicker(symbol);
        allTickers[symbol] = ticker;
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
    
    console.log(`📊 Successfully fetched ${Object.keys(tickers).length} tickers`);
    
    // Convert to array et calcul VRAI changement 24h
    const cryptoPerformance = Object.entries(tickers).map(([symbol, ticker]) => {
      const tickerData = ticker as any;
      
      // 🔥 CALCUL VRAI CHANGEMENT 24H (pour AVNT -21.9% au lieu de -0.22%)
      const currentPrice = Number(tickerData.last || tickerData.close || 0);
      const openPrice = Number(tickerData.open || currentPrice);
      const realChange24h = openPrice > 0 ? ((currentPrice - openPrice) / openPrice) * 100 : Number(tickerData.percentage || 0);
      
      const quoteVolume24h = volumeUsdFromTicker(tickerData);
      const volume24h = quoteVolume24h; // keep naming compatibility
      const change24h = realChange24h; // 🔥 Utilise le vrai changement
      
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
        return false; // Skip - insufficient movement for liquidity profile
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
        performanceScore
      };
    }).filter((crypto): crypto is {
      symbol: string;
      change24h: number;
      volume24h: number;
      quoteVolume24h: number;
      combinedScore: number;
      absChange: number;
      volumeScore: number;
      performanceScore: number;
    } => {
      if (!crypto) return false;
      
      // Smart eligibility (dynamic)
      const base = crypto.symbol.split("/")[0];
      const elig = isSymbolEligibleForAuto(base, { last: Number((tickers as any)[`${crypto.symbol.replace('/USDT','/USD:USD')}`]?.last || 0), volumeUsd: crypto.quoteVolume24h });
      if (!elig.ok) {
        console.log(`🚫 ${crypto.symbol} rejected: ${elig.reason} (volUsd=$${(crypto.quoteVolume24h/1_000_000).toFixed(2)}M, required: $${(elig.minRequired || 0)/1_000_000}M)`);
        return false;
      }
      
      // DYNAMIC FILTERING based on volume (RÉDUITS pour plus d'opportunités)
      const volumeUsd = crypto.quoteVolume24h;
      const isHighVolumeAsset = volumeUsd >= 50_000_000; // $50M+ = established
      const isMediumVolumeAsset = volumeUsd >= 1_000_000; // $1M+ = emerging (réduit de $5M)
      const isLowVolumeAsset = volumeUsd >= 100_000; // $100K+ = speculative (réduit de $500K)
      
      if (isHighVolumeAsset) {
        // High volume: accept tiny movements (very safe)
        if (crypto.absChange < 0.005) return false; // 0.005% minimum
      } else if (isMediumVolumeAsset) {
        // Medium volume: moderate movements (balanced)
        if (crypto.absChange < 0.02) return false; // 0.02% minimum (réduit de 0.05%)
      } else if (isLowVolumeAsset) {
        // Lower volume: require significant movements (higher risk/reward)
        if (crypto.absChange < 0.05) return false; // 0.05% minimum (réduit de 0.15%)
      } else {
        // Very low volume: reject (too risky)
        return false;
      }
      
      return true;
    });

    // Sort by combined score descending
    cryptoPerformance.sort((a, b) => b.combinedScore - a.combinedScore);
    
    console.log(`🎯 Performance analysis complete:`);
    console.log(`   📊 Total analyzed: ${Object.keys(tickers).length} perpetuals`);
    console.log(`   ✅ Qualifying cryptos: ${cryptoPerformance.length}`);
    console.log(`   🏆 Top 5 performers by score:`);
    cryptoPerformance.slice(0, 5).forEach((crypto, i) => {
      console.log(`      ${i+1}. ${crypto.symbol}: ${crypto.change24h.toFixed(3)}% change, $${(crypto.quoteVolume24h/1000000).toFixed(2)}M vol, score: ${crypto.combinedScore.toFixed(2)}`);
    });
    
    // Take top 20 and convert to spot trading format for analysis
    const topPerformers = cryptoPerformance.slice(0, 20).map(crypto => {
      // Convert from SYMBOL/USD:USD to SYMBOL/USDT for analysis
      const base = crypto.symbol.split('/')[0];
      return `${base}/USDT`;
    });
    
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
      console.log(`✅ Selected ${finalPerformers.length} performers (${prioritySymbols.length} priority + ${availablePerformers.length} normal)`);
      if (prioritySymbols.length > 0) {
        console.log('🔥 Priority symbols (>3%):', prioritySymbols.slice(0, 3));
      }
      console.log('🏆 Top available:', finalPerformers.slice(0, 5));
      return finalPerformers;
    } else {
      console.log('⚠️ All top performers at capacity - falling back to static list without active ones');
      const staticFallback = await getTopCryptos(excludeSessionId);
      return staticFallback.length > 0 ? staticFallback : await getTopCryptos(excludeSessionId); // Dernière chance
    }
    
  } catch (error) {
    console.error('Error getting dynamic crypto list:', error);
    console.log('📊 Falling back to static top cryptos list');
    return await getTopCryptos(excludeSessionId); // Fallback to our curated list
  }
}

/**
 * Top cryptos by volume/market cap - focus on liquid markets only
 * Filters out symbols already active in other agents
 */
const FALLBACK_STATIC_SYMBOLS = [
  'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT',
  'AVAX/USDT', 'DOGE/USDT', 'DOT/USDT', 'MATIC/USDT', 'LTC/USDT',
  'LINK/USDT', 'UNI/USDT', 'BCH/USDT', 'XLM/USDT', 'ATOM/USDT',
  'APT/USDT', 'OP/USDT', 'ARB/USDT', 'SUI/USDT', 'BTC/USDT'
];

async function getTopCryptos(excludeSessionId?: string): Promise<string[]> {
  try {
    const { EXCHANGE_ID } = getConfig();
    const ExchangeClass = (ccxt as any)[EXCHANGE_ID];
    if (!ExchangeClass) throw new Error('Unknown exchange ' + EXCHANGE_ID);

    const exchange = new ExchangeClass({
      enableRateLimit: true,
      options: { defaultType: 'swap' }
    });

    await exchange.loadMarkets();
    const markets = Object.values(exchange.markets || {});

    const usdPerps = markets.filter((market: any) => {
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
    const available = symbols.filter(symbol => !activeSymbols.includes(symbol));

    if (available.length > 0) {
      console.log(`📊 Fallback list after conflict filter: ${available.length} available (${symbols.length - available.length} filtered)`);
      return available;
    }

    console.log('⚠️ All fallback symbols currently active - returning original list');
    return symbols;
  } catch (error) {
    console.error('Error filtering fallback symbols:', error);
    return symbols;
  }
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
async function calculateIntelligentScore(symbol: string, opts?: { aggressiveness?: 'conservative'|'reactive'|'aggressive'; excludeSessionId?: string }): Promise<IntelligentAnalysis | null> {
  try {
    console.log(`🔍 Analyzing ${symbol}...`);
    let multiTimeframe: MultiTimeframeDiagnostics | null = null;
    
    // Get technical snapshot first (no IA cost)
    const technical = await buildTechSnapshot(symbol);
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
    const openPrice = Number(ticker.open || currentPrice);
    const realChange24h = openPrice > 0 ? ((currentPrice - openPrice) / openPrice) * 100 : Number(ticker.percentage || 0);
    
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
    
    // Prédiction ML locale (GRATUITE) - Fallback si Grok indisponible
    const mlCacheKey = `ml_${symbol}_${Math.floor(Date.now() / CACHE_DURATION_ML)}`;
    let mlResult = mlPredictionCache.get(mlCacheKey);
    
    if (!mlResult) {
      const rsi = technical.rsi14 || 50;
      const adx = technical.adx14 || 0;
      const prediction = predictWithLocalML(symbol, rsi, adx, change24h, currentVolumeUsd);
      mlResult = { ...prediction, timestamp: Date.now() };
      mlPredictionCache.set(mlCacheKey, mlResult);
      
      // Nettoyage cache ML
      if (mlPredictionCache.size > 100) {
        const oldestKey = Array.from(mlPredictionCache.keys())[0];
        mlPredictionCache.delete(oldestKey);
      }
    }
    
    // IA ULTRA-CONDITIONNELLE: Seulement si ML pas confiant ET enjeu important
    if (!mlResult) {
      const rsi = technical.rsi14 || 50;
      const adx = technical.adx14 || 0;
      const prediction = predictWithLocalML(symbol, rsi, adx, change24h, currentVolumeUsd);
      mlResult = { ...prediction, timestamp: Date.now() };
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
    
    // Convert NONE bias to LONG for neutral markets
    if (autoBias.bias === 'none') {
      console.log(`🔄 ${symbol}: Converting NONE bias (${autoBias.confidence}%) to LONG for neutral market trading`);
      autoBias.bias = 'long';
      autoBias.reasoning = `Neutral market → LONG bias (${autoBias.confidence}% confidence)`;
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
  // Ajustement intelligent des seuils selon volatilité et agressivité (RÉDUITS pour plus d'opportunités)
  let minVolumeThreshold = 25000; // Seuil de base très réduit ($25K)
  
  if (isHighVolatility) {
    minVolumeThreshold = 10000; // Seuil très bas en haute volatilité ($10K)
  }
  
  minVolumeThreshold = minVolumeThreshold / aggressiveMultiplier;
  
  // SÉCURITÉ: Rejet automatique pour volumes insuffisants
  if (volume < minVolumeThreshold) {
    console.log(`🚫 Volume ${volume} insuffisant pour trading AUTO (minimum $${(minVolumeThreshold/1000).toFixed(0)}K)`);
    return 0; // REJET AUTOMATIQUE
  }
  
  // Scores progressifs avec bonus haute volatilité
  const volatilityBonus = isHighVolatility ? 0.5 : 0;
  
  if (volume > 10000000) return Math.min(10.0, 9.5 + volatilityBonus); // $10M+ = Excellent
  if (volume > 5000000) return Math.min(10.0, 8.5 + volatilityBonus);  // $5M+ = High volume 
  if (volume > 2000000) return Math.min(10.0, 7.5 + volatilityBonus);  // $2M+ = Good volume
  if (volume > 1000000) return Math.min(10.0, 7.0 + volatilityBonus);  // $1M+ = Acceptable volume
  if (volume > 500000) return Math.min(10.0, 6.5 + volatilityBonus);   // $500K+ = Decent
  return Math.min(10.0, 6.0 + volatilityBonus); // $100K-$500K = Minimum acceptable
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
    const analyses: IntelligentAnalysis[] = aiRanked.map((ranked, index) => {
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
      
      return {
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
    });
    
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
  
  // Get top 10-20 cryptos instead of all perpetuals, excluding current session
  const symbols = await getOptimizedCryptoList(excludeSessionId);
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
  
  // Sort by score (descending) and assign ranks
  analyses.sort((a, b) => b.score - a.score);
  
  // Filter by minimum score threshold to remove poor quality cryptos
  const minScoreThreshold = 2.0; // Minimum score to be considered tradeable
  const qualifiedAnalyses = analyses.filter(a => a.score >= minScoreThreshold);
  
  // Assign ranks to qualified analyses only
  qualifiedAnalyses.forEach((analysis, index) => {
    analysis.rank = index + 1;
  });
  
  console.log(`✅ Legacy scan complete. Found ${analyses.length} total analyses, ${qualifiedAnalyses.length} above threshold (score ≥ ${minScoreThreshold}).`);
  console.log(`🏆 Top qualified: ${qualifiedAnalyses.slice(0, 5).map(a => `${a.symbol}(${a.score.toFixed(1)})`).join(', ')}`);
  
  return qualifiedAnalyses;
}

/**
 * Get the best opportunity with detailed explanation
 */
/**
 * Détecte si le marché est en mode haute volatilité
 * Critères: plusieurs cryptos majeures avec mouvements >2%, volume élevé
 */
export async function detectHighVolatilityMode(): Promise<boolean> {
  try {
    const majorCryptos = ['BTC/USD:USD', 'ETH/USD:USD', 'XRP/USD:USD', 'SOL/USD:USD', 'SUI/USD:USD'];
    let strongMovements = 0;
    let totalVolume = 0;
    
    for (const symbol of majorCryptos) {
      try {
        const ticker = await getTicker(symbol.replace('/USD:USD', '/USDT'));
        if (ticker) {
          const change = Math.abs(ticker.percentage || 0);
          const volume = ticker.quoteVolume || 0;
          
          if (change > 2.0) strongMovements++;
          totalVolume += volume;
        }
      } catch (e) {
        // Ignore errors for individual tickers
      }
    }
    
    // Mode haute volatilité si: 2+ cryptos majeures >2% ET volume total >$2B
    const isHighVolatility = strongMovements >= 2 && totalVolume > 2_000_000_000;
    
    if (isHighVolatility) {
      console.log(`🔥 HIGH VOLATILITY MODE detected: ${strongMovements} major cryptos >2%, total volume $${(totalVolume/1000000000).toFixed(1)}B`);
    }
    
    return isHighVolatility;
  } catch (error) {
    console.error('Error detecting volatility mode:', error);
    return false;
  }
}

/**
 * Compte le nombre d'agents actifs sur un symbole spécifique
 */
export async function getActiveAgentCountForSymbol(symbol: string, excludeSessionId?: string): Promise<number> {
  try {
    const whereClause: any = { 
      stoppedAt: null,
      symbol: symbol
    };
    
    if (excludeSessionId) {
      whereClause.id = { not: excludeSessionId };
    }
    
    const count = await prisma.agentSession.count({
      where: whereClause
    });
    
    return count;
  } catch (error) {
    console.error('Error counting active agents for symbol:', error);
    return 0;
  }
}

export async function getBestIntelligentOpportunity(excludeSessionId?: string, opts?: { relaxSteps?: number; candidatesOverride?: IntelligentAnalysis[]; aggressiveness?: 'conservative'|'reactive'|'aggressive' }): Promise<IntelligentAnalysis | null> {
  console.log('🎯 Smart Agent Selection: Finding best available opportunity from ranked list...');
  
  // Get the complete ranked list of qualified opportunities
  const opportunities = opts?.candidatesOverride ?? await scanIntelligentOpportunities(undefined, opts);
  
  if (opportunities.length === 0) {
    console.log('� No qualified opportunities found (all below minimum score threshold) → SLEEP mode');
    return null;
  }
  
  console.log(`📊 Found ${opportunities.length} qualified opportunities. Selecting by availability...`);
  
  // Get usage count for each symbol (how many agents are already active on it)
  const symbolUsageMap = new Map<string, number>();
  for (const opp of opportunities) {
    const count = await getActiveAgentCountForSymbol(opp.symbol, excludeSessionId);
    symbolUsageMap.set(opp.symbol, count);
  }
  
  // Selection strategy: 
  // 1. Try symbols with 0 active agents first
  // 2. If none available, try symbols with 1 active agent
  // 3. Never allow 2+ agents on same symbol (avoid conflicts)
  
  for (let maxUsage = 0; maxUsage <= 1; maxUsage++) {
    console.log(`� Pass ${maxUsage + 1}: Looking for symbols with ${maxUsage} active agent(s)...`);
    
    for (const opportunity of opportunities) {
      const currentUsage = symbolUsageMap.get(opportunity.symbol) || 0;
      
      if (currentUsage === maxUsage) {
        console.log(`✅ SELECTED: ${opportunity.symbol} (Score: ${opportunity.score.toFixed(1)}, Rank: ${opportunity.rank}, Usage: ${currentUsage}/2)`);
        console.log(`📝 Reasoning: ${opportunity.reasoning.summary}`);
        return opportunity;
      } else {
        console.log(`⏭️  Skip: ${opportunity.symbol} (Usage: ${currentUsage}, looking for ${maxUsage})`);
      }
    }
  }
  
  // Final aggressive pass: allow a second slot on high-momentum assets (>= 4% move) even if already used twice
  for (const opportunity of opportunities) {
    const currentUsage = symbolUsageMap.get(opportunity.symbol) || 0;
    const momentum = Math.abs(opportunity.metrics?.momentum ?? 0);
    if (currentUsage <= 2 && momentum >= 4) {
      console.log(`⚡ High-momentum override: ${opportunity.symbol} selected despite usage ${currentUsage} (|Δ24h|=${momentum.toFixed(2)}%)`);
      return opportunity;
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

/**
 * Helper: Return top-N cryptos by 24h USD volume from dynamic discovery
 * Falls back to getOptimizedCryptoList and enriches each with ticker info.
 */
export async function getTopCryptosByVolume(limit: number = 50): Promise<Array<{ symbol: string; volumeUsd: number; change24h: number; price: number }>> {
  const symbols = await getOptimizedCryptoList();
  const enriched: Array<{ symbol: string; volumeUsd: number; change24h: number; price: number }> = [];
  for (const symbol of symbols) {
    try {
      const ticker = await getTicker(symbol);
      if (!ticker) continue;
      const last = Number(ticker.last || ticker.close || 0);
      const baseVol = Number((ticker as any).baseVolume || 0);
      const quoteVol = Number((ticker as any).quoteVolume || 0) || (baseVol > 0 && last > 0 ? baseVol * last : 0);
      const open = Number((ticker as any).open || last);
      const change = open > 0 ? ((last - open) / open) * 100 : Number((ticker as any).percentage || 0);
      enriched.push({ symbol, volumeUsd: quoteVol, change24h: change, price: last });
    } catch {}
  }
  enriched.sort((a, b) => b.volumeUsd - a.volumeUsd);
  return enriched.slice(0, Math.max(1, limit));
}

/**
 * Helper: Rank a provided list of cryptos with our hybrid ML/IA scoring
 * Returns lightweight summary suitable for test output (aiScore, opportunity, reasoning)
 */
export async function rankCryptosWithAI(list: Array<{ symbol: string } | { symbol: string; volumeUsd?: number; change24h?: number; price?: number }>): Promise<Array<{ symbol: string; aiScore: number; opportunity?: string; reasoning?: string; risk?: string; volumeUsd?: number; change24h?: number }>> {
  const results: Array<{ symbol: string; aiScore: number; opportunity?: string; reasoning?: string; risk?: string; volumeUsd?: number; change24h?: number }> = [];
  // Analyze in small parallel batches to avoid rate limits
  const batchSize = 5;
  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    const analyses = await Promise.all(batch.map(async (item) => {
      const symbol = (item as any).symbol;
      const analysis = await calculateIntelligentScore(symbol).catch(() => null);
      if (!analysis) return null;
      return {
        symbol,
        aiScore: Number((analysis.score || 0).toFixed(2)),
        opportunity: analysis.opportunity?.type,
        reasoning: analysis.reasoning?.summary,
        risk: analysis.opportunity?.riskLevel,
      } as any;
    }));
    for (const a of analyses) if (a) results.push(a);
  }
  results.sort((a, b) => b.aiScore - a.aiScore);
  return results;
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
    
    // Pass sessionId as excludeSessionId to avoid self-conflict
    let bestOpportunity = preset ?? await getBestIntelligentOpportunity(sessionId, { candidatesOverride: opts?.candidatesOverride });
    const testMode = !!opts?.testMode || (process.env.UNIT_TEST_MODE === 'true');
    if (testMode) {
      // In test mode, only return selection decision (true if selected, false if none)
      return !!bestOpportunity;
    }
    
    if (!bestOpportunity) {
      console.log('💤 No valid opportunities found - creating session in sleep mode for 1h');
      
      // Create session in sleep mode with 1h scan interval (relaxed from 2h)
      const sleepConfig = {
        isIntelligent: true,
        selectedAt: new Date().toISOString(),
        analysis: null,
        lastScan: new Date().toISOString(),
        nextScanDue: new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString(), // 1h sleep mode (was 2h)
        minHoldHours: 0, // No minimum in sleep mode
        strategy: 'sleep_mode_3h',
        sleepMode: true,
        sleepReason: 'No qualifying opportunities found'
      };
      
      const sleepHistory = [{
        timestamp: new Date().toISOString(),
        action: 'intelligent_sleep',
        reason: 'No qualifying opportunities found',
        nextScan: sleepConfig.nextScanDue,
        scanInterval: '2h'
      }];
      
      console.log(`💤 Setting session ${sessionId} to sleep mode - next scan in 2h`);
      
      try { await markDecisionCancelled(sessionId); } catch (error) { console.warn('sleep_mode cancel decision failed:', error); }
      await mergeSessionProfileJson(sessionId, sleepConfig);
      await mergePlanContainer(sessionId, { intelligentHistory: clampHistory(sleepHistory) });
      
      console.log(`✅ Session ${sessionId} set to sleep mode for 2h`);
      return true; // Still successful, but in sleep mode
    }
    
    // Enhanced conflict check with multi-agent support (Phase 2)
    const currentAgentCount = await getActiveAgentCountForSymbol(bestOpportunity.symbol, sessionId);
    const strongMomentum = Math.abs(bestOpportunity.metrics.momentum) > 2.0; // Strong movement exception
    
    if (currentAgentCount > 1 && !strongMomentum) {
      console.log(`🚫 Agent limit exceeded for ${bestOpportunity.symbol} (${currentAgentCount} active, momentum: ${bestOpportunity.metrics.momentum.toFixed(2)})`);
      const retry = await getBestIntelligentOpportunity(sessionId);
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
async function checkSessionForBetterOpportunityOptimized(session: any): Promise<void> {
  try {
    const config = session.profileJson as any;
    const now = new Date();
    // Configurable recent-activity window (hours). Default 3h (was 12h).
    const activityWindowHours = Math.max(1, Number(process.env.SMART_RECENT_ACTIVITY_HOURS || '3'));
    
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
        const best = await getBestIntelligentOpportunity(session.id);
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
      const bestOpportunity = await getBestIntelligentOpportunity(session.id, { relaxSteps: miss >= 2 ? 1 : 0 });
      
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
      console.log(`⏱️ Session ${session.id}: Only ${hoursSinceSelection.toFixed(1)}h since selection (${minHoldHours}h minimum)`);
      return;
    }
    
    // RULE 2: Check if there were any trades (fills) in the last X hours ONLY (default 3h)
    let recentTrades = 0;
    try {
      const windowStart = new Date(now.getTime() - activityWindowHours * 60 * 60 * 1000);
      recentTrades = await prisma.fill.count({
        where: { sessionId: session.id, ts: { gte: windowStart } }
      });
    } catch (err) {
      console.warn(`⚠️ Failed to count recent fills for session ${session.id}:`, err);
      // fallback: do not block rotation on error
      recentTrades = 0;
    }
    const hasRecentActivity = recentTrades > 0;
    
    if (hasRecentActivity) {
      console.log(`📈 Session ${session.id}: ${recentTrades} fills in last ${activityWindowHours}h — keep ${session.symbol}`);
      // Update next check to 6h (was 12h): be more responsive to market rotation
      const nextCheck = new Date(now.getTime() + 6 * 60 * 60 * 1000); // 6h (was 12h)
      await updateSessionNextCheck(session.id, nextCheck);
      return;
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
    
    // Get current best opportunity (cost-optimized scan, exclude current session)
    const bestOpportunity = await getBestIntelligentOpportunity(session.id);
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
    
    // Compute best opportunity with confidence filter (exclude current session)
    const best = await getBestIntelligentOpportunity(sessionId);

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
  
  // Determine minimum movement threshold (based on liquidity, not arbitrary names)
  let minMovement = 0.5; // Default
  if (params.volumeUsd < 50_000_000) minMovement = 3.0; // Need big moves to justify risk
  else if (params.volumeUsd < 200_000_000) minMovement = 1.5; // Moderate threshold
  else if (params.volumeUsd > 1_000_000_000) minMovement = 0.3; // Can trade small moves
  
  // Label based on actual characteristics, not name
  let label = 'Unknown';
  if (params.volumeUsd > 5_000_000_000) label = 'Mega Cap (Excellent)';
  else if (params.volumeUsd > 1_000_000_000) label = 'Large Cap (Very Good)';
  else if (params.volumeUsd > 200_000_000) label = 'Mid Cap (Good)';
  else if (params.volumeUsd > 50_000_000) label = 'Small Cap (Risky)';
  else label = 'Micro Cap (Very Risky)';
  
  return { adjustments, reasons, minMovement, label };
}

/**
 * @deprecated Use applySmartQualityAdjustments instead
 * Kept for backward compatibility during migration
 */
export function getCryptoTier(symbol: string, volumeUsd: number, marketCap?: number): {
  tier: 1 | 2 | 3 | 4;
  bonus: number;
  minMovement: number;
  reputation: 'excellent' | 'good' | 'moderate' | 'unknown';
  label: string;
} {
  // Fallback to Smart Quality for backward compatibility
  const smartQuality = applySmartQualityAdjustments({
    symbol,
    volumeUsd,
    movement: 1.0, // Neutral movement for tier lookup
  });
  
  // Map to old tier structure
  let tier: 1 | 2 | 3 | 4 = 4;
  if (volumeUsd > 5_000_000_000) tier = 1;
  else if (volumeUsd > 1_000_000_000) tier = 2;
  else if (volumeUsd > 200_000_000) tier = 3;
  
  return {
    tier,
    bonus: smartQuality.adjustments,
    minMovement: smartQuality.minMovement,
    reputation: tier === 1 ? 'excellent' : tier === 2 ? 'good' : tier === 3 ? 'moderate' : 'unknown',
    label: smartQuality.label,
  };
}

// Smart eligibility criteria (dynamic, not static):
// - Must pass a minimum USD volume (relâché de $500K à $200K)
// - Stricter thresholds for sub-penny and complex/long symbols
export function isSymbolEligibleForAuto(base: string, params: { last: number; volumeUsd: number }, opts?: { aggressiveness?: 'conservative'|'reactive'|'aggressive' }): { ok: boolean; reason?: string; minRequired?: number } {
  const cfg = getConfig();
  const level = opts?.aggressiveness || 'reactive';
  const minByLevel = level === 'conservative' ? cfg.AUTO_MIN_USD_VOLUME_CONSERVATIVE || 50000 : 
                     level === 'aggressive' ? cfg.AUTO_MIN_USD_VOLUME_AGGRESSIVE || 10000 : 
                     cfg.AUTO_MIN_USD_VOLUME_REACTIVE || 25000; // Très accessible: $25K pour plus d'opportunités
  const vol = Number(params.volumeUsd || 0);
  const px = Number(params.last || 0);
  if (vol < minByLevel) return { ok: false, reason: 'min_usd_volume', minRequired: minByLevel };
  // Sub-penny tokens must have substantial volume (relâché)
  if (px > 0 && px < 0.01 && vol < 2_000_000) return { ok: false, reason: 'subpenny_low_volume', minRequired: 2_000_000 };
  // Complex/long symbols (often micro-caps) must have higher volume (relâché)
  const isComplex = base.length >= 6 || /[0-9]/.test(base);
  if (isComplex && vol < 1_000_000) return { ok: false, reason: 'complex_symbol_low_volume', minRequired: 1_000_000 };
  // Meme-like names must have strong liquidity (relâché)
  const memeLike = ['BOME', 'WIF', 'PEPE', 'SHIB', 'FLOKI', 'BONK'];
  if (memeLike.includes(base.toUpperCase()) && vol < 5_000_000) return { ok: false, reason: 'meme_low_volume', minRequired: 5_000_000 };
  return { ok: true };
}
