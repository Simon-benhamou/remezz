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

// POST endpoint for trading diagnostics - avoids URL slash issues completely
router.post('/trading-diagnostics', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { symbol, force = false } = req.body;
    
    if (!symbol) {
      return res.status(400).json({ 
        error: 'symbol_required', 
        message: 'Symbol must be provided in request body',
        example: { symbol: 'DOT/USDT' }
      });
    }
    
    const normalizedSymbol = normalizeSymbol(symbol);
    const userId = req.user!.id;
    
    // Validate symbol format (allow letters, numbers, slashes, dashes)
    if (!/^[A-Z0-9\/\-]+$/.test(normalizedSymbol)) {
      return res.status(400).json({ 
        error: 'invalid_symbol_format', 
        received: normalizedSymbol,
        expected: 'Letters, numbers, slashes and dashes only'
      });
    }
    
    console.log(`POST /trading-diagnostics: ${normalizedSymbol} (user: ${userId})`);
    
    // Generate new analysis
    const analysisData = await generateTradingDiagnostics(normalizedSymbol, userId);
    
    res.json({
      data: analysisData,
      cached: false,
      timestamp: new Date(),
      method: 'POST',
      symbol: normalizedSymbol
    });
    
  } catch (error) {
    console.error('Trading diagnostics error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'internal_error', details: errorMessage });
  }
});

// Force refresh endpoint - POST to avoid slash issues
router.post('/trading-diagnostics/refresh', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { symbol } = req.body;
    
    if (!symbol) {
      return res.status(400).json({ 
        error: 'symbol_required', 
        message: 'Symbol must be provided in request body',
        example: { symbol: 'DOT/USDT' }
      });
    }
    
    const normalizedSymbol = normalizeSymbol(symbol);
    const userId = req.user!.id;
    
    // Validate symbol format
    if (!/^[A-Z0-9\/\-]+$/.test(normalizedSymbol)) {
      return res.status(400).json({ error: 'invalid_symbol_format' });
    }
    
    console.log(`POST /trading-diagnostics/refresh: ${normalizedSymbol} (user: ${userId})`);
    
    // Generate fresh analysis
    const analysisData = await generateTradingDiagnostics(normalizedSymbol, userId);
    
    res.json({
      data: analysisData,
      cached: false,
      timestamp: new Date(),
      force: true,
      method: 'POST',
      symbol: normalizedSymbol
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