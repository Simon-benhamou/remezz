import { Router } from 'express';
import { getOptimizedCryptoList, getBestIntelligentOpportunity } from '../services/intelligentAgent.js';

export const router = Router();

// Quick debug endpoint to see crypto selection without full analysis
router.get('/current-selection', async (req, res) => {
  try {
    console.log('🔍 Debug: Getting current crypto selection...');
    
    // Get the optimized crypto list (this is what Smart Agent uses)
    const selectedCryptos = await getOptimizedCryptoList();
    
    console.log('📊 Selected cryptos:', selectedCryptos);
    
    res.json({
      success: true,
      selectedCryptos,
      count: selectedCryptos.length,
      containsBitcoin: selectedCryptos.includes('BTC/USDT'),
      bitcoinRank: selectedCryptos.indexOf('BTC/USDT') + 1,
      timestamp: new Date().toISOString()
    });
    
  } catch (error: any) {
    console.error('❌ Debug selection error:', error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

// Test Smart Agent best opportunity selection
router.get('/best-opportunity', async (req, res) => {
  try {
    console.log('🔍 Debug: Getting best Smart Agent opportunity...');
    
    const bestOpportunity = await getBestIntelligentOpportunity();
    
    if (!bestOpportunity) {
      return res.json({
        success: false,
        message: 'No opportunities found',
        wouldFallbackToBitcoin: true
      });
    }
    
    console.log(`🎯 Best opportunity: ${bestOpportunity.symbol} (Score: ${bestOpportunity.score})`);
    
    res.json({
      success: true,
      bestOpportunity: {
        symbol: bestOpportunity.symbol,
        score: bestOpportunity.score,
        confidence: bestOpportunity.confidence,
        reasoning: bestOpportunity.reasoning.summary,
        opportunity: bestOpportunity.opportunity
      },
      isBitcoin: bestOpportunity.symbol === 'BTC/USDT',
      timestamp: new Date().toISOString()
    });
    
  } catch (error: any) {
    console.error('❌ Debug best opportunity error:', error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

// Test Smart Agent creation (no auth needed for debug)
router.post('/create-test-smart-agent', async (req, res) => {
  try {
    console.log('🔍 Debug: Creating test Smart Agent...');
    
    const { startSession } = await import('../session/session.js');
    const { initializeIntelligentSmartAgent } = await import('../services/smartAgent.js');
    const { prisma } = await import('../db/client.js');
    
    // Create session with temporary symbol
    const session = await startSession('BTC/USDT', 'paper', 1000, {
      maxLeverage: 4,
      riskPerTradePct: 1.5,
      dailyLossLimitPct: 3.5,
      budgetFraction: 1,
      aggressiveness: 'conservative'
    });
    
    console.log(`📋 Created session with ID: ${session.id}`);
    
    // Mark as Smart Agent
    await (prisma.agentSession as any).update({
      where: { id: session.id },
      data: {
        isSmartAgent: true,
        smartConfig: {
          minHoldDuration: 86400000,
          rescanInterval: 21600000
        }
      }
    });
    
    console.log(`🧠 Initializing Smart Agent for session ${session.id}...`);
    
    // Initialize Smart Agent
    const success = await initializeIntelligentSmartAgent(session.id);
    
    if (success) {
      // Get updated session
      const updatedSession = await prisma.agentSession.findUnique({ 
        where: { id: session.id },
        include: { kpi: true }
      });
      
      res.json({
        success: true,
        message: 'Smart Agent created successfully',
        session: {
          id: updatedSession?.id,
          symbol: updatedSession?.symbol,
          isSmartAgent: (updatedSession as any)?.isSmartAgent,
          profileJson: updatedSession?.profileJson
        }
      });
    } else {
      res.json({
        success: false,
        message: 'Smart Agent initialization failed',
        sessionId: session.id,
        fallbackSymbol: 'BTC/USDT'
      });
    }
    
  } catch (error: any) {
    console.error('❌ Debug Smart Agent creation error:', error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});