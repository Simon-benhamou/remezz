import { prisma } from '../db/client';
import { getTicker } from '../data/market';

interface SmartConfig {
  minHoldDuration: number;     // ms - minimum time to hold a position
  rescanInterval: number;      // ms - how often to rescan for opportunities
  momentumThreshold: number;   // minimum momentum score to consider
  volumeThreshold: number;     // minimum volume USD
}

interface OpportunityResult {
  symbol: string;
  momentum: number;
  change24h: number;
  volume24h: number;
  reason: string;
}

// Popular cryptos for Smart Agent selection
const SMART_SYMBOLS = [
  'BTC/USDT', 'ETH/USDT', 'XRP/USDT', 'ADA/USDT', 'SOL/USDT',
  'DOGE/USDT', 'DOT/USDT', 'AVAX/USDT', 'SHIB/USDT', 'MATIC/USDT',
  'LTC/USDT', 'UNI/USDT', 'LINK/USDT', 'BCH/USDT', 'XLM/USDT',
  'ATOM/USDT', 'VET/USDT', 'ICP/USDT', 'FIL/USDT', 'ETC/USDT'
];

/**
 * Calculate momentum score for a crypto based on market data
 */
function calculateMomentumScore(data: {
  change24h: number;
  volume24h: number;
  price: number;
}): number {
  // Price change score (0-10)
  const changeScore = Math.max(0, Math.min(10, 
    Math.abs(data.change24h) * 0.5 + (data.change24h > 0 ? 2 : 0)
  ));
  
  // Volume score (0-10) - logarithmic
  const volumeScore = Math.max(0, Math.min(10, 
    Math.log10(data.volume24h / 1000000) * 2
  ));
  
  // Base technical score
  const baseScore = Math.max(0, Math.min(10, 
    (Math.abs(data.change24h) > 3 ? 3 : 1) + (data.volume24h > 5000000 ? 2 : 0)
  ));
  
  // Composite score
  return Math.round((volumeScore * 0.4 + changeScore * 0.4 + baseScore * 0.2) * 10) / 10;
}

/**
 * Scan for the best crypto opportunity
 */
export async function scanBestOpportunity(config: SmartConfig): Promise<OpportunityResult | null> {
  console.log('🔍 Smart Agent: Scanning for best opportunities...');
  
  try {
    const opportunities: OpportunityResult[] = [];
    
    // Get market data for all symbols
    for (const symbol of SMART_SYMBOLS) {
      try {
        const ticker = await getTicker(symbol);
        if (!ticker) continue;
        
        const change24h = ticker.percentage || 0;
        const volume24h = ticker.baseVolume || 0;
        const price = ticker.last || 0;
        
        // Filter by volume threshold
        if (volume24h < config.volumeThreshold) continue;
        
        const momentum = calculateMomentumScore({
          change24h,
          volume24h,
          price
        });
        
        // Filter by momentum threshold
        if (momentum < config.momentumThreshold) continue;
        
        opportunities.push({
          symbol,
          momentum,
          change24h,
          volume24h,
          reason: `Momentum: ${momentum}/10, Change: ${change24h.toFixed(1)}%, Volume: $${(volume24h/1000000).toFixed(1)}M`
        });
        
        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 50));
        
      } catch (error) {
        console.warn(`⚠️ Failed to get data for ${symbol}:`, error);
      }
    }
    
    // Sort by momentum score
    opportunities.sort((a, b) => b.momentum - a.momentum);
    
    const best = opportunities[0];
    if (best) {
      console.log(`✅ Smart Agent: Best opportunity found: ${best.symbol} (${best.reason})`);
      return best;
    }
    
    console.log('⚠️ Smart Agent: No opportunities found matching criteria');
    return null;
    
  } catch (error) {
    console.error('❌ Smart Agent scan failed:', error);
    return null;
  }
}

/**
 * Initialize a new Smart Agent session
 */
export async function initializeSmartAgent(sessionId: string, config: SmartConfig): Promise<string | null> {
  console.log(`🤖 Initializing Smart Agent for session ${sessionId}`);
  
  try {
    // Find best opportunity
    const opportunity = await scanBestOpportunity(config);
    if (!opportunity) {
      throw new Error('No suitable opportunities found');
    }
    
    // Update session with initial symbol and smart configuration
    const now = new Date();
    const nextRescan = new Date(now.getTime() + config.rescanInterval);
    
    await (prisma.agentSession as any).update({
      where: { id: sessionId },
      data: {
        currentSymbol: opportunity.symbol,
        symbol: opportunity.symbol, // Also update main symbol field
        lastSymbolSwitchAt: now,
        nextRescanAt: nextRescan,
        smartHistory: {
          selections: [{
            timestamp: now.toISOString(),
            symbol: opportunity.symbol,
            reason: opportunity.reason,
            momentum: opportunity.momentum,
            type: 'initial_selection'
          }]
        }
      }
    });
    
    console.log(`✅ Smart Agent initialized with ${opportunity.symbol}, next rescan at ${nextRescan.toISOString()}`);
    return opportunity.symbol;
    
  } catch (error) {
    console.error('❌ Smart Agent initialization failed:', error);
    return null;
  }
}

/**
 * Get Smart Agent status and next actions
 */
export async function getSmartAgentStatus(sessionId: string): Promise<any> {
  try {
    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
      include: {
        positions: {
          where: { 
            qty: { not: 0 } // Open positions (have quantity)
          },
          orderBy: { openedAt: 'desc' },
          take: 1
        }
      }
    }) as any;
    
    if (!session || !session.isSmartAgent) {
      return null;
    }
    
    const config = session.smartConfig as SmartConfig;
    const now = new Date();
    const history = session.smartHistory || { selections: [] };
    
    const nextRescan = session.nextRescanAt ? new Date(session.nextRescanAt) : null;
    const timeUntilRescan = nextRescan ? Math.max(0, nextRescan.getTime() - now.getTime()) : 0;
    
    const lastSwitch = session.lastSymbolSwitchAt ? new Date(session.lastSymbolSwitchAt) : null;
    const timeSinceSwitch = lastSwitch ? now.getTime() - lastSwitch.getTime() : 0;
    const minHoldRemaining = Math.max(0, config.minHoldDuration - timeSinceSwitch);
    
    return {
      isSmartAgent: true,
      currentSymbol: session.currentSymbol,
      originalSymbol: session.symbol,
      config,
      nextRescanAt: nextRescan?.toISOString(),
      timeUntilRescanMs: timeUntilRescan,
      lastSwitchAt: lastSwitch?.toISOString(),
      timeSinceSwitchMs: timeSinceSwitch,
      minHoldRemainingMs: minHoldRemaining,
      canSwitchNow: session.positions.length === 0 || minHoldRemaining <= 0,
      selectionHistory: history.selections?.slice(-5) || [], // Last 5 selections
      totalSwitches: (history.selections?.length || 1) - 1 // Exclude initial selection
    };
    
  } catch (error) {
    console.error(`❌ Failed to get Smart Agent status for ${sessionId}:`, error);
    return null;
  }
}

/**
 * Background job to check all Smart Agents for switches
 */
export async function checkAllSmartAgents(): Promise<void> {
  try {
    const smartSessions = await (prisma.agentSession as any).findMany({
      where: {
        isSmartAgent: true,
        stoppedAt: null, // Only active sessions
        nextRescanAt: {
          lte: new Date() // Due for rescan
        }
      }
    });
    
    console.log(`🔄 Checking ${smartSessions.length} Smart Agents for switches...`);
    
    for (const session of smartSessions) {
      // Check if this agent should switch symbols
      try {
        const shouldSwitch = await checkSmartAgentSwitch(session.id);
        if (shouldSwitch) {
          console.log(`✅ Smart Agent ${session.id} switched symbols successfully`);
        }
      } catch (error) {
        console.error(`❌ Failed to check Smart Agent ${session.id}:`, error);
      }
      
      // Small delay between checks
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
  } catch (error) {
    console.error('❌ Failed to check Smart Agents:', error);
  }
}

/**
 * Check if a Smart Agent should switch symbols
 */
async function checkSmartAgentSwitch(sessionId: string): Promise<boolean> {
  try {
    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
      include: {
        positions: {
          where: { 
            qty: { not: 0 } // Open positions (have quantity)
          },
          orderBy: { openedAt: 'desc' },
          take: 1
        }
      }
    }) as any;
    
    if (!session || !session.isSmartAgent || !session.smartConfig) {
      return false;
    }
    
    const config = session.smartConfig;
    const now = new Date();
    
    // Check if we should rescan (time-based)
    const shouldRescan = session.nextRescanAt && now >= new Date(session.nextRescanAt);
    
    // Check if we can switch (no open positions or minimum hold time passed)
    const hasOpenPosition = session.positions.length > 0;
    const minHoldPassed = session.lastSymbolSwitchAt && 
      (now.getTime() - new Date(session.lastSymbolSwitchAt).getTime()) >= config.minHoldDuration;
    
    const canSwitch = !hasOpenPosition || minHoldPassed;
    
    console.log(`🔍 Smart Agent ${sessionId}: shouldRescan=${shouldRescan}, canSwitch=${canSwitch}, hasOpenPosition=${hasOpenPosition}`);
    
    if (shouldRescan && canSwitch) {
      return await performSmartAgentSwitch(sessionId, config);
    }
    
    return false;
    
  } catch (error) {
    console.error(`❌ Smart Agent switch check failed for ${sessionId}:`, error);
    return false;
  }
}

/**
 * Perform the actual symbol switch for a Smart Agent
 */
async function performSmartAgentSwitch(sessionId: string, config: any): Promise<boolean> {
  console.log(`🔄 Smart Agent ${sessionId}: Performing symbol switch...`);
  
  try {
    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId }
    }) as any;
    
    if (!session) return false;
    
    // Find new best opportunity
    const opportunity = await scanBestOpportunity(config);
    if (!opportunity) {
      console.log('⚠️ No new opportunities found, keeping current symbol');
      // Update next rescan time
      await (prisma.agentSession as any).update({
        where: { id: sessionId },
        data: {
          nextRescanAt: new Date(Date.now() + config.rescanInterval)
        }
      });
      return false;
    }
    
    // Check if it's different from current symbol
    if (opportunity.symbol === session.currentSymbol) {
      console.log(`✅ Current symbol ${session.currentSymbol} is still the best, no switch needed`);
      await (prisma.agentSession as any).update({
        where: { id: sessionId },
        data: {
          nextRescanAt: new Date(Date.now() + config.rescanInterval)
        }
      });
      return false;
    }
    
    // Perform the switch
    const now = new Date();
    const nextRescan = new Date(now.getTime() + config.rescanInterval);
    
    // Update smart history
    const currentHistory = session.smartHistory || { selections: [] };
    currentHistory.selections.push({
      timestamp: now.toISOString(),
      symbol: opportunity.symbol,
      previousSymbol: session.currentSymbol,
      reason: opportunity.reason,
      momentum: opportunity.momentum,
      type: 'auto_switch'
    });
    
    await (prisma.agentSession as any).update({
      where: { id: sessionId },
      data: {
        currentSymbol: opportunity.symbol,
        symbol: opportunity.symbol, // Update main symbol for trading engine
        lastSymbolSwitchAt: now,
        nextRescanAt: nextRescan,
        smartHistory: currentHistory
      }
    });
    
    console.log(`✅ Smart Agent ${sessionId}: Switched to ${opportunity.symbol} (${opportunity.reason})`);
    return true;
    
  } catch (error) {
    console.error(`❌ Smart Agent switch failed for ${sessionId}:`, error);
    return false;
  }
}