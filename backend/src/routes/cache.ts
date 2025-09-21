import { Router } from 'express';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.js';

export const router = Router();

// Helper function to normalize symbol for API routes
function normalizeSymbol(symbolParam: string): string {
  // Handle URL encoding and normalize to uppercase
  const decoded = decodeURIComponent(symbolParam);
  return decoded.toUpperCase();
}

// Test endpoint to verify symbol parsing
router.get('/test-symbol/:symbol(*)', (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol);
  res.json({ 
    received: req.params.symbol,
    normalized: symbol,
    path: req.path,
    url: req.url
  });
});

// Cache for trading diagnostics with intelligent refresh
// Using wildcard pattern to capture symbols with slashes like AVAX/USDT
router.get('/trading-diagnostics/:symbol(*)', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const userId = req.user!.id;
    
    if (!symbol) {
      return res.status(400).json({ error: 'symbol_required' });
    }
    
    // Validate symbol format (allow letters, numbers, slashes, dashes)
    if (!/^[A-Z0-9\/\-]+$/.test(symbol)) {
      return res.status(400).json({ 
        error: 'invalid_symbol_format', 
        received: symbol,
        expected: 'Letters, numbers, slashes and dashes only'
      });
    }
    
    // For now, generate analysis without cache until Prisma is fixed
    const analysisData = await generateTradingDiagnostics(symbol, userId);
    
    res.json({
      data: analysisData,
      cached: false,
      timestamp: new Date(),
      message: 'Cache temporarily disabled - generating fresh analysis'
    });
    
  } catch (error) {
    console.error('Trading diagnostics error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'internal_error', details: errorMessage });
  }
});

// Force refresh endpoint
router.post('/trading-diagnostics/:symbol(*)/refresh', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const userId = req.user!.id;
    
    if (!symbol) {
      return res.status(400).json({ error: 'symbol_required' });
    }
    
    // Validate symbol format
    if (!/^[A-Z0-9\/\-]+$/.test(symbol)) {
      return res.status(400).json({ error: 'invalid_symbol_format' });
    }
    
    // Generate fresh analysis
    const analysisData = await generateTradingDiagnostics(symbol, userId);
    
    res.json({
      data: analysisData,
      cached: false,
      timestamp: new Date(),
      message: 'Fresh analysis generated'
    });
    
  } catch (error) {
    console.error('Trading diagnostics refresh error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'internal_error', details: errorMessage });
  }
});

async function generateTradingDiagnostics(symbol: string, userId: string) {
  // Import the existing trading analysis logic
  const { buildTechSnapshot } = await import('../ai/tech.js');
  const { requestStrategy } = await import('../ai/strategyManager.js');
  
  try {
    const [tech, strategy] = await Promise.all([
      buildTechSnapshot(symbol),
      requestStrategy({ 
        symbol, 
        trigger: 'diagnostics',
        fresh: true,
        force: false // Don't force to respect AI limits
      }).catch(() => null)
    ]);
    
    return {
      symbol,
      technical: tech,
      strategy: strategy?.strategy || null,
      levels: strategy?.levels || null,
      timestamp: new Date().toISOString(),
      source: 'fresh_analysis'
    };
  } catch (error) {
    console.error('Error generating trading diagnostics:', error);
    throw error;
  }
}