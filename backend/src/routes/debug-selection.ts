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