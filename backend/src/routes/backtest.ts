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
      symbols = ['SEI/USDT:USDT', 'XRP/USDT:USDT', 'ETH/USDT:USDT', 'IMX/USDT:USDT'],
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
 * Get available preset configurations
 */
router.get('/presets', authenticateUser, (req, res) => {
  res.json({
    symbols: [
      { value: 'SEI/USDT:USDT', label: 'SEI/USDT', tier: 'LOW' },
      { value: 'XRP/USDT:USDT', label: 'XRP/USDT', tier: 'MEDIUM' },
      { value: 'ETH/USDT:USDT', label: 'ETH/USDT', tier: 'HIGH' },
      { value: 'IMX/USDT:USDT', label: 'IMX/USDT', tier: 'LOW' },
      { value: 'SOL/USDT:USDT', label: 'SOL/USDT', tier: 'MEDIUM' },
      { value: 'DOT/USDT:USDT', label: 'DOT/USDT', tier: 'LOW' },
    ],
    defaultSymbols: ['SEI/USDT:USDT', 'XRP/USDT:USDT', 'ETH/USDT:USDT', 'IMX/USDT:USDT'],
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
