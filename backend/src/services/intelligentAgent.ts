import { prisma } from '../db/client.js';
import { getTicker } from '../data/market.js';
import { fullAnalysis } from '../ai/analysis.js';
import { buildTechSnapshot } from '../ai/tech.js';
import ccxt from 'ccxt';
import { getConfig } from '../utils/env.js';

export interface IntelligentAnalysis {
  symbol: string;
  score: number;
  rank: number;
  confidence: number;
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
  };
  regime: string;
}

/**
 * Get optimized list of top performing cryptos for analysis (max 20)
 */
export async function getOptimizedCryptoList(): Promise<string[]> {
  try {
    console.log('📊 Fetching top performing cryptos from last 24h...');
    
    const { EXCHANGE_ID } = getConfig();
    const ExchangeClass = (ccxt as any)[EXCHANGE_ID];
    
    if (!ExchangeClass) {
      console.log('📊 Exchange not available, using static top 20 cryptos list');
      return getTopCryptos();
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
    
    console.log(`� Found ${perpetualMarkets.length} perpetual markets, fetching tickers...`);
    
    if (perpetualMarkets.length === 0) {
      console.log('📊 No perpetual markets found, falling back to static list');
      return getTopCryptos();
    }

    // Fetch MORE tickers to get better selection (increased from 10 to 50)
    const sampleSize = Math.min(perpetualMarkets.length, 50); // Analyze more markets for better selection
    const sampleMarkets = perpetualMarkets.slice(0, sampleSize);
    
    // Fetch tickers one by one (Crypto.com limitation)
    const tickers = {};
    console.log(`📊 Fetching performance data for ${sampleMarkets.length} perpetual markets...`);
    
    for (let i = 0; i < sampleMarkets.length; i++) { // Analyze ALL sample markets, not just 10
      try {
        const symbol = sampleMarkets[i];
        console.log(`📈 Fetching ticker ${i+1}/${sampleMarkets.length}: ${symbol}...`);
        const ticker = await exchange.fetchTicker(symbol);
        tickers[symbol] = ticker;
        console.log(`✅ ${symbol}: ${ticker.percentage?.toFixed(2) || 0}% change, volume: $${((ticker.quoteVolume || 0) / 1000000).toFixed(2)}M`);
      } catch (error) {
        console.log(`⚠️ Failed to fetch ticker for ${sampleMarkets[i]}: ${error instanceof Error ? error.message : error}`);
      }
    }
    
    console.log(`📊 Successfully fetched ${Object.keys(tickers).length} tickers`);
    
    // Convert to array and calculate performance metrics
    const cryptoPerformance = Object.entries(tickers).map(([symbol, ticker]) => {
      const tickerData = ticker as any;
      const change24h = Number(tickerData.percentage || 0);
      const volume24h = Number(tickerData.baseVolume || 0);
      const quoteVolume24h = Number(tickerData.quoteVolume || 0);
      
      // Improved scoring: Performance weighted more for volatility detection
      const volumeScore = Math.min(10, Math.log10(Math.max(1, quoteVolume24h))); // Capped at 10
      const performanceScore = Math.abs(change24h); // Direct percentage
      const combinedScore = (performanceScore * 0.7) + (volumeScore * 0.3); // Favor performance more
      
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
    }).filter(crypto => 
      crypto.quoteVolume24h > 10000 && // Lowered from 50K to 10K for more opportunities
      crypto.absChange > 0.01 // Lowered from 0.05% to 0.01% for more opportunities
    );

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
    
    if (topPerformers.length > 0) {
      console.log(`✅ Selected ${topPerformers.length} top performing cryptos from ${Object.keys(tickers).length} perpetuals`);
      console.log('🏆 Top 5 selected:', topPerformers.slice(0, 5));
      return topPerformers;
    } else {
      console.log('⚠️ No qualifying perpetuals found, using static high-volume cryptos list');
      return getTopCryptos();
    }
    
  } catch (error) {
    console.error('Error getting dynamic crypto list:', error);
    console.log('📊 Falling back to static top cryptos list');
    return getTopCryptos(); // Fallback to our curated list
  }
}

/**
 * Top cryptos by volume/market cap - focus on liquid markets only
 */
function getTopCryptos(): string[] {
  // Top 20 most liquid perpetuals - high volume, tight spreads
  return [
    'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'BNB/USDT',
    'ADA/USDT', 'AVAX/USDT', 'DOGE/USDT', 'DOT/USDT', 'MATIC/USDT',
    'LTC/USDT', 'LINK/USDT', 'UNI/USDT', 'BCH/USDT', 'XLM/USDT',
    'ATOM/USDT', 'APT/USDT', 'OP/USDT', 'ARB/USDT', 'SUI/USDT'
  ];
}

/**
 * Emergency fallback symbols (top 5 only)
 */
function getFallbackSymbols(): string[] {
  return ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'BNB/USDT'];
}

/**
 * Optimized scoring algorithm - technical analysis first, minimal IA usage
 */
async function calculateIntelligentScore(symbol: string): Promise<IntelligentAnalysis | null> {
  try {
    console.log(`🔍 Analyzing ${symbol}...`);
    
    // Get technical snapshot first (no IA cost)
    const technical = await buildTechSnapshot(symbol);
    const ticker = await getTicker(symbol);
    
    if (!technical || !ticker) {
      console.log(`❌ ${symbol}: Missing data - technical:${!!technical}, ticker:${!!ticker}`);
      return null;
    }

    console.log(`📊 ${symbol}: RSI=${technical.rsi14}, ADX=${technical.adx14}, Vol=${ticker.baseVolume}, Change=${ticker.percentage}%`);

    // Only use full analysis (with IA) for top performers or significant moves
    let sentiment: any = null;
    const change24h = Number(ticker.percentage || 0);
    const shouldUseAI = Math.abs(change24h) > 3; // Only if >3% move
    
    if (shouldUseAI) {
      try {
        console.log(`🤖 ${symbol}: Using AI analysis (${change24h}% move)`);
        const fullAnalysisResult = await fullAnalysis(symbol);
        sentiment = fullAnalysisResult.sentiment;
      } catch {
        // If IA fails, continue with technical-only analysis
        console.log(`⚡ Skipping IA for ${symbol} - using technical analysis only`);
      }
    }

    // Core metrics
    const metrics = {
      momentum: Number(ticker.percentage || 0),
      trend: technical.trend || 0,
      volatility: technical.realizedVol || 0,
      volume24h: Number(ticker.baseVolume || 0),
      rsi: technical.rsi14 || 50,
      trendStrength: technical.trendStrength || 0,
      hurst: technical.hurst || 0.5,
      adx: technical.adx14 || 0,
    };

    // Optimized scoring - technical analysis focused
    const momentumScore = calculateMomentumComponent(metrics);
    const trendScore = calculateTrendComponent(metrics, technical);
    const volatilityScore = calculateVolatilityComponent(metrics);
    const volumeScore = calculateVolumeComponent(metrics.volume24h);
    const regimeScore = calculateRegimeComponent(technical.regime);
    
    // Sentiment score (only if IA was used)
    const sentimentScore = sentiment ? calculateSentimentComponent(sentiment) : 6.0; // Neutral default

    // Reweighted composite score - technical analysis priority
    const compositeScore = (
      momentumScore * 0.30 +      // 30% momentum (increased)
      trendScore * 0.25 +         // 25% trend (increased)
      volatilityScore * 0.20 +    // 20% volatility (increased)
      volumeScore * 0.15 +        // 15% volume
      regimeScore * 0.05 +        // 5% regime (reduced)
      sentimentScore * 0.05       // 5% sentiment (reduced, optional)
    );

    // Determine opportunity type and direction
    const opportunity = determineOpportunity(metrics, technical, sentiment);

    // Generate detailed reasoning
    const reasoning = generateReasoning(metrics, technical, sentiment, opportunity);

    // Calculate confidence based on convergence of signals
    const confidence = calculateConfidence(
      momentumScore, trendScore, sentimentScore, 
      volatilityScore, volumeScore, regimeScore
    );

    const finalScore = Math.round(compositeScore * 100) / 100;
    console.log(`🎯 ${symbol}: Final Score=${finalScore} (M:${momentumScore.toFixed(1)}, T:${trendScore.toFixed(1)}, V:${volatilityScore.toFixed(1)}, Vol:${volumeScore.toFixed(1)})`);

    return {
      symbol,
      score: finalScore,
      rank: 0, // Will be set after ranking all symbols
      confidence: Math.round(confidence * 100) / 100,
      reasoning,
      metrics,
      opportunity,
      regime: (technical.regime as any)?.label || 'unknown'
    };

  } catch (error) {
    console.error(`Error analyzing ${symbol}:`, error);
    return null;
  }
}

/**
 * Momentum component scoring - More permissive for real market conditions
 */
function calculateMomentumComponent(metrics: any): number {
  const { momentum, rsi } = metrics;
  
  // Strong momentum signals (lowered thresholds)
  if (Math.abs(momentum) > 3 && ((momentum > 0 && rsi > 55) || (momentum < 0 && rsi < 45))) {
    return 8.5; // Excellent momentum with RSI confirmation
  }
  
  // Good momentum (lowered from 3 to 2)
  if (Math.abs(momentum) > 2) {
    return 7.0 + Math.min(1.5, Math.abs(momentum) / 10);
  }
  
  // Moderate momentum (lowered from 1 to 0.5)
  if (Math.abs(momentum) > 0.5) {
    return 5.5 + Math.abs(momentum);
  }
  
  // Even small movements can be valid (base score increased)
  return 4.0 + Math.abs(momentum);
}

/**
 * Trend component scoring - More permissive for real market conditions
 */
function calculateTrendComponent(metrics: any, technical: any): number {
  const { trend, trendStrength, adx } = metrics;
  
  // Strong trending market (lowered thresholds)
  if (adx > 20 && trendStrength > 1.5) {
    return 8.0 + Math.min(1.0, trendStrength / 5);
  }
  
  // Moderate trend (lowered thresholds)
  if (adx > 12 && trendStrength > 0.8) {
    return 6.5 + Math.min(1.5, adx / 15);
  }
  
  // Weak trend but some direction (more generous)
  if (Math.abs(trend) > 0 || adx > 8) {
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
 * Volatility component scoring - More permissive for crypto markets
 */
function calculateVolatilityComponent(metrics: any): number {
  const { volatility, hurst } = metrics;
  
  // Optimal volatility range for crypto (broader range)
  if (volatility >= 1.5 && volatility <= 12) {
    const base = 7.5;
    const persistency = hurst > 0.6 ? 1.0 : hurst < 0.4 ? 0.8 : 0.9;
    return base + persistency;
  }
  
  // High volatility (opportunity in crypto)
  if (volatility > 12) {
    return 6.5 + Math.min(1.5, 15 / volatility);
  }
  
  // Low volatility (still tradeable in crypto)
  return 5.0 + Math.min(2.0, volatility);
}

/**
 * Volume component scoring - Lower thresholds for realistic crypto volumes
 */
function calculateVolumeComponent(volume: number): number {
  if (volume > 5000000) return 8.5; // High volume (lowered threshold)
  if (volume > 1000000) return 7.5;  // Good volume (lowered threshold)
  if (volume > 500000) return 6.5;   // Moderate volume (lowered threshold)
  if (volume > 100000) return 5.5;   // Low but tradeable volume (more generous)
  if (volume > 50000) return 4.5;    // Very low but still valid (new tier)
  return 3.5; // Minimal volume (increased base score)
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
function determineOpportunity(metrics: any, technical: any, sentiment: any): any {
  const { momentum, rsi, adx, trendStrength } = metrics;
  
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
      riskLevel: 'medium'
    };
  }
  
  // Reversal opportunity
  if ((rsi > 80 || rsi < 20) && Math.abs(momentum) > 2) {
    return {
      type: 'reversal',
      direction: rsi > 80 ? 'bearish' : 'bullish',
      timeframe: 'short',
      expectedReturn: Math.min(10, Math.abs(momentum) * 1.5),
      riskLevel: 'high'
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
      riskLevel: sentimentAligned ? 'medium' : 'high'
    };
  }
  
  // Default - volatility play
  return {
    type: 'volatility',
    direction: 'neutral',
    timeframe: 'short',
    expectedReturn: 5,
    riskLevel: 'medium'
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
 * Optimized scan focusing on top 10-20 cryptos only
 */
export async function scanIntelligentOpportunities(): Promise<IntelligentAnalysis[]> {
  console.log('🔍 Starting optimized opportunity scan (top cryptos only)...');
  
  // Get top 10-20 cryptos instead of all perpetuals
  const symbols = await getOptimizedCryptoList();
  console.log(`📊 Analyzing ${symbols.length} top cryptos (cost-optimized)...`);
  
  // Analyze in smaller batches for better performance
  const analyses: IntelligentAnalysis[] = [];
  const batchSize = 5; // Smaller batches for top cryptos
  
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const batchPromises = batch.map(symbol => calculateIntelligentScore(symbol));
    const batchResults = await Promise.all(batchPromises);
    
    // Filter out null results and add to analyses
    analyses.push(...batchResults.filter(result => result !== null) as IntelligentAnalysis[]);
    
    // Progress log
    console.log(`📈 Analyzed ${Math.min(i + batchSize, symbols.length)}/${symbols.length} top cryptos`);
  }
  
  // Sort by score (descending) and assign ranks
  analyses.sort((a, b) => b.score - a.score);
  analyses.forEach((analysis, index) => {
    analysis.rank = index + 1;
  });
  
  console.log(`✅ Intelligent scan complete. Found ${analyses.length} analyzed opportunities.`);
  console.log(`🏆 Top 3: ${analyses.slice(0, 3).map(a => `${a.symbol}(${a.score})`).join(', ')}`);
  
  return analyses;
}

/**
 * Get the best opportunity with detailed explanation
 */
export async function getBestIntelligentOpportunity(): Promise<IntelligentAnalysis | null> {
  const opportunities = await scanIntelligentOpportunities();
  
  if (opportunities.length === 0) {
    console.log('⚠️ No opportunities found - all cryptos failed analysis criteria');
    return null;
  }
  
  const best = opportunities[0];
  console.log(`🎯 Best opportunity: ${best.symbol} (Score: ${best.score}, Confidence: ${best.confidence})`);
  console.log(`📝 Reasoning: ${best.reasoning.summary}`);
  
  return best;
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
 * Initialize intelligent agent for a session
 */
export async function initializeIntelligentAgent(sessionId: string): Promise<boolean> {
  try {
    console.log(`🤖 Initializing Intelligent Agent for session ${sessionId}...`);
    
    const bestOpportunity = await getBestIntelligentOpportunity();
    
    if (!bestOpportunity) {
      console.error('❌ Failed to find any opportunities for Intelligent Agent');
      return false;
    }
    
    // Update session with the selected symbol using profileJson for metadata
    const intelligentConfig = {
      isIntelligent: true,
      selectedAt: new Date().toISOString(),
      analysis: bestOpportunity,
      lastScan: new Date().toISOString(),
      nextScanDue: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(), // 12h minimum
      minHoldHours: 12,
      strategy: 'optimized_cost_efficient'
    };
    
    const intelligentHistory = [{
      timestamp: new Date().toISOString(),
      action: 'intelligent_init',
      symbol: bestOpportunity.symbol,
      score: bestOpportunity.score,
      confidence: bestOpportunity.confidence,
      reasoning: bestOpportunity.reasoning.summary,
    }];
    
    await prisma.agentSession.update({
      where: { id: String(sessionId) }, // Convert to string
      data: {
        symbol: bestOpportunity.symbol,
        profileJson: {
          ...intelligentConfig,
          originalSymbol: bestOpportunity.symbol
        } as any,
        planJson: {
          intelligentHistory
        } as any
      }
    });
    
    console.log(`✅ Intelligent Agent initialized with ${bestOpportunity.symbol}`);
    console.log(`🎯 Score: ${bestOpportunity.score}, Confidence: ${bestOpportunity.confidence}`);
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
    
    // Get all sessions with intelligent configuration using profileJson
    const sessions = await prisma.agentSession.findMany({
      where: {
        stoppedAt: null, // Active sessions
        profileJson: {
          path: ['isIntelligent'],
          equals: true
        }
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
 * Optimized session check: 12h minimum + trade activity condition
 */
async function checkSessionForBetterOpportunityOptimized(session: any): Promise<void> {
  try {
    const config = session.profileJson as any;
    const now = new Date();
    const selectedAt = new Date(config?.selectedAt || now);
    const hoursSinceSelection = (now.getTime() - selectedAt.getTime()) / (1000 * 60 * 60);
    
    // RULE 1: Minimum 12h hold period
    if (hoursSinceSelection < 12) {
      console.log(`⏱️ Session ${session.id}: Only ${hoursSinceSelection.toFixed(1)}h since selection (12h minimum)`);
      return;
    }
    
    // RULE 2: Check if there were any trades in the last 12h
    const recentTrades = session.positions?.length || 0;
    const hasRecentActivity = recentTrades > 0;
    
    if (hasRecentActivity) {
      console.log(`📈 Session ${session.id}: Has ${recentTrades} recent trades - keeping current symbol ${session.symbol}`);
      // Update next check to 24h if there's trading activity
      const nextCheck = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      await updateSessionNextCheck(session.id, nextCheck);
      return;
    }
    
    console.log(`🔍 Session ${session.id}: No trades in 12h+ - evaluating switch from ${session.symbol}`);
    
    // Get current best opportunity (cost-optimized scan)
    const bestOpportunity = await getBestIntelligentOpportunity();
    
    if (!bestOpportunity) {
      console.log(`⚠️ No opportunities found for session ${session.id} - extending hold`);
      const nextCheck = new Date(now.getTime() + 6 * 60 * 60 * 1000); // 6h retry
      await updateSessionNextCheck(session.id, nextCheck);
      return;
    }
    
    // Check if we should switch (significant improvement + different symbol)
    const currentAnalysis = config?.analysis;
    const scoreImprovement = bestOpportunity.score - (currentAnalysis?.score || 0);
    const shouldSwitch = bestOpportunity.symbol !== session.symbol &&
                        scoreImprovement > 1.0 && // Higher threshold for switches
                        bestOpportunity.confidence > 0.75; // Higher confidence required
    
    if (shouldSwitch) {
      console.log(`🔄 SWITCH: ${session.id} from ${session.symbol} to ${bestOpportunity.symbol}`);
      console.log(`📈 Score improvement: ${scoreImprovement.toFixed(1)} points (confidence: ${bestOpportunity.confidence})`);
      
      // Update session with new selection
      const updatedConfig = {
        ...config,
        analysis: bestOpportunity,
        selectedAt: now.toISOString(),
        lastScan: now.toISOString(),
        nextScanDue: new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(), // 12h minimum
        switchReason: `No trades + ${scoreImprovement.toFixed(1)} score improvement`
      };
      
      const existingHistory = session.planJson?.intelligentHistory || [];
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
      
      await prisma.agentSession.update({
        where: { id: session.id },
        data: {
          symbol: bestOpportunity.symbol,
          profileJson: updatedConfig as any,
          planJson: { intelligentHistory: newHistory } as any
        }
      });
      
    } else {
      // Keep current symbol, extend hold period
      console.log(`✅ Session ${session.id} keeping ${session.symbol} (insufficient improvement: ${scoreImprovement.toFixed(1)})`);
      const nextCheck = new Date(now.getTime() + 12 * 60 * 60 * 1000); // 12h retry
      await updateSessionNextCheck(session.id, nextCheck);
    }
    
  } catch (error) {
    console.error(`❌ Error checking opportunities for session ${session.id}:`, error);
  }
}