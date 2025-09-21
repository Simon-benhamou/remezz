import { prisma } from '../db/client.js';
import { getTicker } from '../data/market.js';
import { 
  scanIntelligentOpportunities, 
  getBestIntelligentOpportunity, 
  initializeIntelligentAgent, 
  checkIntelligentOpportunities,
  type IntelligentAnalysis 
} from './intelligentAgent.js';

interface SmartConfig {
  minHoldDuration: number;
  rescanInterval: number;
  momentumThreshold: number;
  volumeThreshold: number;
}

interface OpportunityResult {
  symbol: string;
  momentum: number;
  change24h: number;
  volume24h: number;
  reason: string;
}

// Fallback symbols for legacy compatibility
const SMART_SYMBOLS = [
  'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'BNB/USDT',
  'ADA/USDT', 'AVAX/USDT', 'DOGE/USDT', 'DOT/USDT', 'MATIC/USDT',
  'LTC/USDT', 'LINK/USDT', 'UNI/USDT', 'BCH/USDT', 'XLM/USDT'
];

/**
 * Legacy momentum calculation for fallback compatibility
 */
function calculateMomentumScore(data: {
  change24h: number;
  volume24h: number;
  price: number;
}): number {
  const changeScore = Math.max(1, Math.min(10, 
    Math.abs(data.change24h) * 2 + (data.change24h > 0 ? 3 : 1)
  ));
  
  const volumeScore = Math.max(2, Math.min(10, 
    Math.log10(Math.max(data.volume24h, 1000) / 10000) * 3
  ));
  
  const baseScore = Math.max(2, Math.min(10, 
    (Math.abs(data.change24h) > 1 ? 4 : 2) + (data.volume24h > 100000 ? 3 : 1)
  ));
  
  return Math.max(1.5, (changeScore + volumeScore + baseScore) / 3);
}

/**
 * Main opportunity scanner - uses intelligent system with legacy fallback
 */
export async function scanBestOpportunity(): Promise<OpportunityResult | null> {
  console.log('🧠 Using Intelligent Opportunity Scanner...');
  
  try {
    // Primary: Use intelligent system
    const intelligent = await getBestIntelligentOpportunity();
    if (intelligent) {
      console.log(`✅ Intelligent system found: ${intelligent.symbol} (Score: ${intelligent.score})`);
      return {
        symbol: intelligent.symbol,
        momentum: intelligent.score,
        change24h: intelligent.metrics.momentum,
        volume24h: intelligent.metrics.volume24h,
        reason: intelligent.reasoning.summary
      };
    }
    
    console.log('⚠️ Intelligent system returned null, using legacy fallback...');
    
    // Fallback: Legacy system
    for (const symbol of SMART_SYMBOLS) {
      try {
        const ticker = await getTicker(symbol);
        if (!ticker) continue;
        
        const change24h = Number(ticker.percentage || 0);
        const volume24h = Number(ticker.baseVolume || 0);
        const price = Number(ticker.last || 0);
        
        if (price <= 0) continue;
        
        const score = calculateMomentumScore({ change24h, volume24h, price });
        
        if (score >= 1.5) {
          console.log(`✅ Legacy system found: ${symbol} (Score: ${score.toFixed(1)})`);
          return {
            symbol,
            momentum: score,
            change24h,
            volume24h,
            reason: `Legacy: Score ${score.toFixed(1)}, Change ${change24h.toFixed(1)}%, Volume $${(volume24h/1000000).toFixed(1)}M`
          };
        }
      } catch (err) {
        console.warn(`Error analyzing ${symbol}:`, err);
        continue;
      }
    }
    
    // Emergency fallback
    console.log('🆘 Emergency fallback to BTC/USDT');
    return {
      symbol: 'BTC/USDT',
      momentum: 3.0,
      change24h: 0,
      volume24h: 1000000,
      reason: 'Emergency fallback to BTC/USDT'
    };
    
  } catch (error) {
    console.error('Error in opportunity scan:', error);
    return {
      symbol: 'BTC/USDT',
      momentum: 3.0,
      change24h: 0,
      volume24h: 1000000,
      reason: 'Error fallback to BTC/USDT'
    };
  }
}

/**
 * Initialize Smart Agent with Intelligent Analysis System
 */
export async function initializeIntelligentSmartAgent(sessionId: number): Promise<boolean> {
  console.log(`🧠 Initializing Intelligent Smart Agent for session ${sessionId}...`);
  
  try {
    const success = await initializeIntelligentAgent(sessionId);
    
    if (success) {
      console.log(`✅ Intelligent Smart Agent successfully initialized`);
      return true;
    }
    
    console.error('❌ Failed to initialize with intelligent system');
    return false;
    
  } catch (error) {
    console.error('❌ Error initializing Intelligent Smart Agent:', error);
    return false;
  }
}

/**
 * Legacy Smart Agent initialization for backward compatibility
 */
export async function initializeSmartAgent(sessionId: string, config: SmartConfig): Promise<string | null> {
  console.log(`🤖 Legacy Smart Agent initialization for session ${sessionId}`);
  
  try {
    const opportunity = await scanBestOpportunity();
    
    if (!opportunity) {
      console.error('❌ No opportunities found');
      return null;
    }
    
    console.log(`🎯 Selected: ${opportunity.symbol} - ${opportunity.reason}`);
    return opportunity.symbol;
    
  } catch (error) {
    console.error('❌ Error in legacy Smart Agent initialization:', error);
    return null;
  }
}

/**
 * Check for better opportunities - intelligent version
 */
export async function checkSmartOpportunities(): Promise<void> {
  console.log('🔄 Checking for intelligent opportunities...');
  
  try {
    await checkIntelligentOpportunities();
  } catch (error) {
    console.error('❌ Error checking intelligent opportunities:', error);
  }
}

/**
 * Get all intelligent opportunities for API
 */
export async function getAllIntelligentOpportunities(): Promise<IntelligentAnalysis[]> {
  try {
    return await scanIntelligentOpportunities();
  } catch (error) {
    console.error('Error getting intelligent opportunities:', error);
    return [];
  }
}

/**
 * Get intelligent Smart Agent status for a session
 */
export async function getIntelligentAgentStatus(sessionId: string): Promise<any> {
  try {
    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId }
    });
    
    if (!session) {
      return null;
    }
    
    const config = session.profileJson as any;
    const isIntelligent = config?.isIntelligent === true;
    
    if (!isIntelligent) {
      return { isSmartAgent: false, isIntelligent: false };
    }
    
    const history = session.planJson as any;
    
    return {
      isSmartAgent: true,
      isIntelligent: true,
      currentSymbol: session.symbol,
      analysis: config.analysis || null,
      selectedAt: config.selectedAt || null,
      lastScan: config.lastScan || null,
      nextScanDue: config.nextScanDue || null,
      history: history?.intelligentHistory || []
    };
    
  } catch (error) {
    console.error('Error getting intelligent agent status:', error);
    return null;
  }
}

/**
 * Export types for external use
 */
export type { IntelligentAnalysis, SmartConfig, OpportunityResult };