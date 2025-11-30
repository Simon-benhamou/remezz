import { Router } from "express";
import { runBacktest, BacktestParams, BacktestResult } from "../services/backtestService.js";
import { authenticateUser, AuthenticatedRequest } from "../middleware/auth.js";

export const router = Router();

/**
 * POST /api/backtest/run
 * Run a detailed backtest with all individual trades
 */
router.post('/run', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { 
      startDate, 
      endDate, 
      initialCapital = 2000,
      // V5.7: Default to TOP 6 performers
      symbols = ['DOGE/USDT:USDT', 'IMX/USDT:USDT', 'SEI/USDT:USDT', 'SUI/USDT:USDT', 'XRP/USDT:USDT', 'ETH/USDT:USDT'],
      leverage = 4.5
    } = req.body;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }
    
    const params: BacktestParams = {
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      initialCapital: Number(initialCapital),
      symbols: Array.isArray(symbols) ? symbols : [symbols],
      leverage: Number(leverage),
    };
    
    console.log(`[Backtest] Running backtest from ${params.startDate.toISOString()} to ${params.endDate.toISOString()}`);
    console.log(`[Backtest] Capital: $${params.initialCapital}, Symbols: ${params.symbols.join(', ')}`);
    
    const result = await runBacktest(params);
    
    res.json(result);
  } catch (error: any) {
    console.error('[Backtest] Error:', error);
    res.status(500).json({ error: error.message || 'Backtest failed' });
  }
});

/**
 * GET /api/backtest/presets
 * Get available preset configurations - V5.7 with all tested symbols
 */
router.get('/presets', authenticateUser, (req, res) => {
  res.json({
    // V5.6: Tous les symbols testés avec ROI positif sur 24 mois
    symbols: [
      // 🏆 TOP PERFORMERS (ROI >200%)
      { value: 'DOGE/USDT:USDT', label: 'DOGE/USDT', tier: 'MEDIUM', roi24m: '+438%' },
      { value: 'IMX/USDT:USDT', label: 'IMX/USDT', tier: 'LOW', roi24m: '+344%' },
      { value: 'SEI/USDT:USDT', label: 'SEI/USDT', tier: 'LOW', roi24m: '+280%' },
      { value: 'SUI/USDT:USDT', label: 'SUI/USDT', tier: 'LOW', roi24m: '+266%' },
      // ✅ SOLID PERFORMERS (ROI >100%)
      { value: 'XRP/USDT:USDT', label: 'XRP/USDT', tier: 'MEDIUM', roi24m: '+185%' },
      { value: 'ETH/USDT:USDT', label: 'ETH/USDT', tier: 'HIGH', roi24m: '+173%' },
      { value: 'ADA/USDT:USDT', label: 'ADA/USDT', tier: 'MEDIUM', roi24m: '+173%' },
      { value: 'DOT/USDT:USDT', label: 'DOT/USDT', tier: 'LOW', roi24m: '+173%' },
      { value: 'LINK/USDT:USDT', label: 'LINK/USDT', tier: 'MEDIUM', roi24m: '+143%' },
      { value: 'AVAX/USDT:USDT', label: 'AVAX/USDT', tier: 'MEDIUM', roi24m: '+118%' },
      { value: 'SOL/USDT:USDT', label: 'SOL/USDT', tier: 'MEDIUM', roi24m: '+111%' },
      // ⚡ STABLE (lower ROI but consistent)
      { value: 'BTC/USDT:USDT', label: 'BTC/USDT', tier: 'HIGH', roi24m: '+65%' },
    ],
    // V5.7: Default = TOP 6 performers
    defaultSymbols: ['DOGE/USDT:USDT', 'IMX/USDT:USDT', 'SEI/USDT:USDT', 'SUI/USDT:USDT', 'XRP/USDT:USDT', 'ETH/USDT:USDT'],
    leverageOptions: [3, 4, 4.5, 5],
    capitalPresets: [1000, 2000, 5000, 10000, 50000, 100000],
    periods: [
      { label: '1 Month', months: 1 },
      { label: '3 Months', months: 3 },
      { label: '6 Months', months: 6 },
      { label: '12 Months', months: 12 },
      { label: '24 Months', months: 24 },
    ],
  });
});
