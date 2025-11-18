/**
 * Real-Time News & Catalyst Detection
 * 
 * Uses Grok LLM to detect breaking news, regulatory announcements, and major
 * market catalysts that could invalidate technical analysis. News events can
 * cause 10-40% price moves in minutes, overriding all indicators.
 * 
 * Examples:
 * - SEC lawsuit updates (XRP +40% on dismissal)
 * - Exchange listings/delistings
 * - Major hacks or exploits
 * - Regulatory announcements
 * - Whale transactions
 */

import { llmJSONSafe } from '../../../ai/llm.js';

export type NewsImpact = 'extremely_bullish' | 'bullish' | 'neutral' | 'bearish' | 'extremely_bearish';
export type NewsSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';

export type NewsSignal = {
  hasBreakingNews: boolean;
  impact: NewsImpact;
  severity: NewsSeverity;
  confidence: number;        // 0-1, how confident is the assessment
  shouldBlock: boolean;      // Block entries when news is too uncertain
  penalty: number;           // Score multiplier (0-1.5)
  summary: string;           // Brief news summary
  reasons: string[];         // Specific news items
  timestamp: number;
};

// Cache news checks for 5 minutes per symbol (news doesn't change that fast)
const newsCache = new Map<string, { signal: NewsSignal; timestamp: number }>();
const NEWS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Track Grok API usage to avoid rate limits
let lastGrokCallTimestamp = 0;
const MIN_GROK_INTERVAL_MS = 10_000; // 10 seconds between Grok calls

/**
 * Extract base asset from trading pair
 * e.g., "ETH/USDT" -> "ETH", "BTC/USD:USD" -> "BTC"
 */
function extractBaseAsset(symbol: string): string {
  return symbol.split('/')[0].split(':')[0].toUpperCase();
}

/**
 * Use Grok to check for breaking news about a crypto asset
 */
async function checkNewsWithGrok(symbol: string): Promise<{
  hasNews: boolean;
  impact: NewsImpact;
  confidence: number;
  summary: string;
  reasons: string[];
}> {
  const baseAsset = extractBaseAsset(symbol);
  const now = Date.now();
  
  // Rate limiting: Don't call Grok too frequently
  const timeSinceLastCall = now - lastGrokCallTimestamp;
  if (timeSinceLastCall < MIN_GROK_INTERVAL_MS) {
    console.log(`[News Detection] Rate limiting: waiting ${(MIN_GROK_INTERVAL_MS - timeSinceLastCall) / 1000}s`);
    return {
      hasNews: false,
      impact: 'neutral',
      confidence: 0,
      summary: 'Rate limited',
      reasons: [],
    };
  }
  
  try {
    lastGrokCallTimestamp = now;
    
    const prompt = `You are a cryptocurrency news analyst. Check for BREAKING NEWS about ${baseAsset} in the last 6 hours.

Focus ONLY on major market-moving events:
- Regulatory announcements (SEC lawsuits, ETF approvals, etc.)
- Exchange listings or delistings
- Major hacks or security incidents
- Large whale transactions (>$100M)
- Protocol upgrades or hard forks
- Major partnerships or integrations
- Significant on-chain events

Ignore:
- General market sentiment
- Social media hype
- Technical analysis discussions
- Price movements without catalysts

Current time: ${new Date().toISOString()}

Respond in JSON format:
{
  "hasNews": boolean,
  "impact": "extremely_bullish" | "bullish" | "neutral" | "bearish" | "extremely_bearish",
  "confidence": 0.0 to 1.0,
  "summary": "Brief 1-sentence summary of the news",
  "reasons": ["reason1", "reason2"]
}

If no significant news in last 6 hours, return hasNews: false.`;

    const response = await llmJSONSafe(prompt, {
      provider: 'grok',
      ttlMin: 5, // Cache for 5 minutes
    }) as any; // Type assertion needed since llmJSONSafe returns string | null
    
    if (!response || typeof response !== 'object') {
      throw new Error('Invalid Grok response');
    }
    
    return {
      hasNews: Boolean(response.hasNews),
      impact: response.impact || 'neutral',
      confidence: Number(response.confidence || 0),
      summary: String(response.summary || 'No summary'),
      reasons: Array.isArray(response.reasons) ? response.reasons : [],
    };
  } catch (error) {
    console.error(`[News Detection] Grok API error for ${symbol}:`, error);
    
    // Return neutral on error (don't block trades due to our own failure)
    return {
      hasNews: false,
      impact: 'neutral',
      confidence: 0,
      summary: 'News check failed',
      reasons: [`error: ${(error as Error).message}`],
    };
  }
}

/**
 * Determine severity level from impact and confidence
 */
function calculateSeverity(impact: NewsImpact, confidence: number): NewsSeverity {
  if (confidence < 0.3) {
    return 'none';
  }
  
  if (impact === 'extremely_bullish' || impact === 'extremely_bearish') {
    if (confidence >= 0.7) return 'critical';
    if (confidence >= 0.5) return 'high';
    return 'medium';
  }
  
  if (impact === 'bullish' || impact === 'bearish') {
    if (confidence >= 0.7) return 'high';
    if (confidence >= 0.5) return 'medium';
    return 'low';
  }
  
  return 'none';
}

/**
 * Calculate penalty multiplier based on news impact and trade bias
 */
function calculatePenalty(
  impact: NewsImpact,
  severity: NewsSeverity,
  tradeBias: 'long' | 'short' | 'both'
): { shouldBlock: boolean; penalty: number } {
  // No news or low confidence = no impact
  if (severity === 'none' || severity === 'low') {
    return { shouldBlock: false, penalty: 1.0 };
  }
  
  // Extremely bullish news
  if (impact === 'extremely_bullish') {
    if (tradeBias === 'short') {
      // Block shorts during extremely bullish news
      return { shouldBlock: true, penalty: 0.0 };
    } else if (tradeBias === 'long') {
      // Boost longs during bullish news
      return { shouldBlock: false, penalty: severity === 'critical' ? 1.5 : 1.3 };
    }
  }
  
  // Extremely bearish news
  if (impact === 'extremely_bearish') {
    if (tradeBias === 'long') {
      // Block longs during extremely bearish news
      return { shouldBlock: true, penalty: 0.0 };
    } else if (tradeBias === 'short') {
      // Boost shorts during bearish news
      return { shouldBlock: false, penalty: severity === 'critical' ? 1.5 : 1.3 };
    }
  }
  
  // Moderately bullish news
  if (impact === 'bullish') {
    if (tradeBias === 'short') {
      // Penalize shorts during bullish news
      return { shouldBlock: false, penalty: severity === 'high' ? 0.4 : 0.6 };
    } else if (tradeBias === 'long') {
      // Slight boost to longs
      return { shouldBlock: false, penalty: 1.2 };
    }
  }
  
  // Moderately bearish news
  if (impact === 'bearish') {
    if (tradeBias === 'long') {
      // Penalize longs during bearish news
      return { shouldBlock: false, penalty: severity === 'high' ? 0.4 : 0.6 };
    } else if (tradeBias === 'short') {
      // Slight boost to shorts
      return { shouldBlock: false, penalty: 1.2 };
    }
  }
  
  // Neutral or mixed signals = no impact
  return { shouldBlock: false, penalty: 1.0 };
}

/**
 * Detect breaking news and assess impact on trading decisions
 * 
 * @param symbol - Trading pair symbol (e.g., "ETH/USDT")
 * @param bias - Trade direction ('long' or 'short')
 * @returns NewsSignal with penalty and blocking decision
 */
export async function detectNewsImpact(
  symbol: string,
  bias: 'long' | 'short' | 'both'
): Promise<NewsSignal> {
  const now = Date.now();
  const cacheKey = `${symbol}:${bias}`;
  
  // Check cache
  const cached = newsCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < NEWS_CACHE_TTL_MS) {
    return cached.signal;
  }
  
  try {
    // Fetch news from Grok
    const newsData = await checkNewsWithGrok(symbol);
    
    // Calculate severity
    const severity = calculateSeverity(newsData.impact, newsData.confidence);
    
    // Calculate penalty and blocking decision
    const { shouldBlock, penalty } = calculatePenalty(newsData.impact, severity, bias);
    
    // Build signal
    const signal: NewsSignal = {
      hasBreakingNews: newsData.hasNews,
      impact: newsData.impact,
      severity,
      confidence: newsData.confidence,
      shouldBlock,
      penalty,
      summary: newsData.summary,
      reasons: newsData.reasons,
      timestamp: now,
    };
    
    // Cache the result
    newsCache.set(cacheKey, { signal, timestamp: now });
    
    // Log significant news
    if (newsData.hasNews && severity !== 'none') {
      console.log(JSON.stringify({
        event: 'news_detection',
        symbol,
        bias,
        impact: newsData.impact,
        severity,
        confidence: newsData.confidence,
        shouldBlock,
        penalty,
        summary: newsData.summary,
        reasons: newsData.reasons,
      }));
    }
    
    return signal;
  } catch (error) {
    console.error('[News Detection] Error in detectNewsImpact:', error);
    
    // Return neutral signal on error (don't block trades due to our own failure)
    const neutralSignal: NewsSignal = {
      hasBreakingNews: false,
      impact: 'neutral',
      severity: 'none',
      confidence: 0,
      shouldBlock: false,
      penalty: 1.0,
      summary: 'News check failed',
      reasons: [`error: ${(error as Error).message}`],
      timestamp: now,
    };
    
    return neutralSignal;
  }
}

/**
 * Clear news cache (useful for testing or forcing refresh)
 */
export function clearNewsCache(): void {
  newsCache.clear();
}

/**
 * Get cache statistics for monitoring
 */
export function getNewsCacheStats(): {
  size: number;
  entries: Array<{ symbol: string; age: number; hasNews: boolean }>;
} {
  const now = Date.now();
  const entries = Array.from(newsCache.entries()).map(([key, value]) => ({
    symbol: key,
    age: now - value.timestamp,
    hasNews: value.signal.hasBreakingNews,
  }));
  
  return {
    size: newsCache.size,
    entries,
  };
}
