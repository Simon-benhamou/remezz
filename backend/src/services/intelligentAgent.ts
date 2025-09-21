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
 * Fetch all available perpetual contracts from Crypto.com dynamically
 */
async function fetchCryptoComPerpetuals(): Promise<string[]> {
  try {
    const { EXCHANGE_ID } = getConfig();
    const ExchangeClass = (ccxt as any)[EXCHANGE_ID];
    
    if (!ExchangeClass) {
      console.warn('Exchange not available, using fallback symbols');
      return getFallbackSymbols();
    }

    const exchange = new ExchangeClass({
      enableRateLimit: true,
      options: { defaultType: 'swap' } // Perpetuals
    });

    await exchange.loadMarkets();
    
    // Filter for USDT perpetuals with good volume
    const perpetuals = Object.values(exchange.markets)
      .filter((market: any) => 
        market.swap === true && 
        market.quote === 'USDT' &&
        market.active === true
      )
      .map((market: any) => market.symbol)
      .sort();

    console.log(`Fetched ${perpetuals.length} perpetual contracts from ${EXCHANGE_ID}`);
    return perpetuals.length > 0 ? perpetuals : getFallbackSymbols();
    
  } catch (error) {
    console.error('Failed to fetch perpetuals from exchange:', error);
    return getFallbackSymbols();
  }
}

/**
 * Fallback symbols if exchange is not accessible
 */
function getFallbackSymbols(): string[] {
  return [
    'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'BNB/USDT',
    'ADA/USDT', 'AVAX/USDT', 'DOGE/USDT', 'DOT/USDT', 'MATIC/USDT',
    'LTC/USDT', 'LINK/USDT', 'UNI/USDT', 'BCH/USDT', 'XLM/USDT',
    'ATOM/USDT', 'VET/USDT', 'ICP/USDT', 'FIL/USDT', 'ETC/USDT',
    'NEAR/USDT', 'ALGO/USDT', 'HBAR/USDT', 'APT/USDT', 'OP/USDT',
    'ARB/USDT', 'SUI/USDT', 'TON/USDT', 'TRX/USDT', 'DAI/USDT'
  ];
}

/**
 * Advanced scoring algorithm using our full technical analysis
 */
async function calculateIntelligentScore(symbol: string): Promise<IntelligentAnalysis | null> {
  try {
    // Get full technical analysis
    const analysis = await fullAnalysis(symbol);
    const technical = analysis.technical;
    const sentiment = analysis.sentiment;
    const ticker = analysis.ticker;

    if (!technical || !sentiment || !ticker) {
      return null;
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

    // Advanced scoring components
    const momentumScore = calculateMomentumComponent(metrics);
    const trendScore = calculateTrendComponent(metrics, technical);
    const sentimentScore = calculateSentimentComponent(sentiment);
    const volatilityScore = calculateVolatilityComponent(metrics);
    const volumeScore = calculateVolumeComponent(metrics.volume24h);
    const regimeScore = calculateRegimeComponent(technical.regime);

    // Weighted composite score
    const compositeScore = (
      momentumScore * 0.25 +      // 25% momentum
      trendScore * 0.20 +         // 20% trend
      sentimentScore * 0.15 +     // 15% sentiment
      volatilityScore * 0.15 +    // 15% volatility
      volumeScore * 0.15 +        // 15% volume
      regimeScore * 0.10          // 10% regime
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

    return {
      symbol,
      score: Math.round(compositeScore * 100) / 100,
      rank: 0, // Will be set after ranking all symbols
      confidence: Math.round(confidence * 100) / 100,
      reasoning,
      metrics,
      opportunity,
      regime: technical.regime?.label || 'unknown'
    };

  } catch (error) {
    console.error(`Error analyzing ${symbol}:`, error);
    return null;
  }
}

/**
 * Momentum component scoring
 */
function calculateMomentumComponent(metrics: any): number {
  const { momentum, rsi } = metrics;
  
  // Strong momentum signals
  if (Math.abs(momentum) > 5 && ((momentum > 0 && rsi > 60) || (momentum < 0 && rsi < 40))) {
    return 9.0; // Excellent momentum with RSI confirmation
  }
  
  // Good momentum
  if (Math.abs(momentum) > 3) {
    return 7.0 + Math.min(2.0, Math.abs(momentum) / 10);
  }
  
  // Moderate momentum
  if (Math.abs(momentum) > 1) {
    return 5.0 + Math.abs(momentum);
  }
  
  // Low momentum
  return 3.0 + Math.abs(momentum);
}

/**
 * Trend component scoring
 */
function calculateTrendComponent(metrics: any, technical: any): number {
  const { trend, trendStrength, adx } = metrics;
  
  // Strong trending market
  if (adx > 25 && trendStrength > 2) {
    return 8.5 + Math.min(1.5, trendStrength / 5);
  }
  
  // Moderate trend
  if (adx > 15 && trendStrength > 1) {
    return 6.0 + Math.min(2.0, adx / 15);
  }
  
  // Weak trend but some direction
  if (Math.abs(trend) > 0) {
    return 4.0 + Math.min(2.0, Math.abs(trend) / (technical.last || 1) * 100);
  }
  
  return 3.0;
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
 * Volatility component scoring
 */
function calculateVolatilityComponent(metrics: any): number {
  const { volatility, hurst } = metrics;
  
  // Optimal volatility range (2-8%)
  if (volatility >= 2 && volatility <= 8) {
    const base = 7.0;
    const persistency = hurst > 0.6 ? 1.5 : hurst < 0.4 ? 1.0 : 1.2;
    return base + persistency;
  }
  
  // High volatility (risky but opportunity)
  if (volatility > 8) {
    return 6.0 + Math.min(2.0, 10 / volatility);
  }
  
  // Low volatility
  return 4.0 + Math.min(2.0, volatility);
}

/**
 * Volume component scoring
 */
function calculateVolumeComponent(volume: number): number {
  if (volume > 10000000) return 9.0; // Very high volume
  if (volume > 5000000) return 8.0;  // High volume
  if (volume > 1000000) return 7.0;  // Good volume
  if (volume > 500000) return 6.0;   // Moderate volume
  if (volume > 100000) return 5.0;   // Low volume
  return 3.0; // Very low volume
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
 * Main function to scan and rank all opportunities
 */
export async function scanIntelligentOpportunities(): Promise<IntelligentAnalysis[]> {
  console.log('🔍 Starting intelligent opportunity scan...');
  
  // Get all available perpetuals
  const symbols = await fetchCryptoComPerpetuals();
  console.log(`📊 Analyzing ${symbols.length} perpetual contracts...`);
  
  // Analyze all symbols in parallel (but limit concurrency)
  const analyses: IntelligentAnalysis[] = [];
  const batchSize = 10;
  
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const batchPromises = batch.map(symbol => calculateIntelligentScore(symbol));
    const batchResults = await Promise.all(batchPromises);
    
    // Filter out null results and add to analyses
    analyses.push(...batchResults.filter(result => result !== null) as IntelligentAnalysis[]);
    
    // Progress log
    console.log(`📈 Analyzed ${Math.min(i + batchSize, symbols.length)}/${symbols.length} symbols`);
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
    console.log('⚠️ No opportunities found, falling back to BTC/USDT');
    return await calculateIntelligentScore('BTC/USDT');
  }
  
  const best = opportunities[0];
  console.log(`🎯 Best opportunity: ${best.symbol} (Score: ${best.score}, Confidence: ${best.confidence})`);
  console.log(`📝 Reasoning: ${best.reasoning.summary}`);
  
  return best;
}

/**
 * Initialize intelligent agent for a session
 */
export async function initializeIntelligentAgent(sessionId: number): Promise<boolean> {
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
      nextScanDue: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
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
 * Background job to check for better opportunities
 */
export async function checkIntelligentOpportunities(): Promise<void> {
  try {
    console.log('🔄 Checking for better intelligent opportunities...');
    
    // Get all sessions with intelligent configuration using profileJson
    const sessions = await prisma.agentSession.findMany({
      where: {
        stoppedAt: null, // Active sessions
        profileJson: {
          path: ['isIntelligent'],
          equals: true
        }
      }
    });
    
    if (sessions.length === 0) {
      console.log('📋 No active intelligent agent sessions found');
      return;
    }
    
    console.log(`🤖 Found ${sessions.length} active intelligent agent sessions`);
    
    for (const session of sessions) {
      await checkSessionForBetterOpportunity(session);
    }
    
  } catch (error) {
    console.error('❌ Error in intelligent opportunities check:', error);
  }
}

/**
 * Check if a session should switch to a better opportunity
 */
async function checkSessionForBetterOpportunity(session: any): Promise<void> {
  try {
    const config = session.profileJson as any;
    const now = new Date();
    const lastScan = new Date(config?.lastScan || 0);
    const nextScanDue = new Date(config?.nextScanDue || 0);
    
    // Only scan if it's time
    if (now < nextScanDue) {
      return;
    }
    
    console.log(`🔍 Scanning for better opportunities for session ${session.id} (${session.symbol})`);
    
    // Get current best opportunity
    const bestOpportunity = await getBestIntelligentOpportunity();
    
    if (!bestOpportunity) {
      console.log(`⚠️ No opportunities found for session ${session.id}`);
      return;
    }
    
    // Check if we should switch (better score + confidence, different symbol)
    const currentAnalysis = config?.analysis;
    const shouldSwitch = bestOpportunity.symbol !== session.symbol &&
                        bestOpportunity.score > (currentAnalysis?.score || 0) + 0.5 &&
                        bestOpportunity.confidence > 0.7;
    
    if (shouldSwitch) {
      console.log(`🔄 Switching session ${session.id} from ${session.symbol} to ${bestOpportunity.symbol}`);
      console.log(`📊 Score improvement: ${currentAnalysis?.score || 0} → ${bestOpportunity.score}`);
      
      // Update session with new data
      const updatedConfig = {
        ...config,
        analysis: bestOpportunity,
        lastScan: now.toISOString(),
        nextScanDue: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };
      
      const existingHistory = session.planJson?.intelligentHistory || [];
      const newHistory = [...existingHistory, {
        timestamp: now.toISOString(),
        action: 'intelligent_switch',
        fromSymbol: session.symbol,
        toSymbol: bestOpportunity.symbol,
        score: bestOpportunity.score,
        confidence: bestOpportunity.confidence,
        reasoning: bestOpportunity.reasoning.summary,
      }];
      
      await prisma.agentSession.update({
        where: { id: session.id },
        data: {
          symbol: bestOpportunity.symbol,
          profileJson: updatedConfig as any,
          planJson: {
            intelligentHistory: newHistory
          } as any
        }
      });
      
    } else {
      // Just update scan times
      const updatedConfig = {
        ...config,
        lastScan: now.toISOString(),
        nextScanDue: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };
      
      await prisma.agentSession.update({
        where: { id: session.id },
        data: {
          profileJson: updatedConfig as any
        }
      });
      
      console.log(`✅ No switch needed for session ${session.id} (${session.symbol})`);
    }
    
  } catch (error) {
    console.error(`❌ Error checking opportunities for session ${session.id}:`, error);
  }
}