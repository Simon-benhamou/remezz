import { Router } from "express";
import { runBacktest, BacktestParams, BacktestResult } from "../services/backtestService.js";
import { authenticateUser, AuthenticatedRequest } from "../middleware/auth.js";
import { verifyTrade, verifyAllTrades, getParityResults } from "../services/parityVerificationService.js";
import crypto from 'node:crypto';

export const router = Router();

type CachedBacktestRun = {
  id: string;
  createdAt: string;
  hash: string;
  params: BacktestParams;
  result: BacktestResult;
};

const backtestRunCacheByUser = new Map<string, CachedBacktestRun[]>();

function getCacheUserKey(req: AuthenticatedRequest): string {
  return req.user?.id || 'anonymous';
}

function getMaxCacheSize(): number {
  const raw = process.env.BACKTEST_CACHE_MAX_PER_USER;
  const n = raw ? Number(raw) : 10;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
}

function stableParamsHash(params: BacktestParams): string {
  const normalized = {
    startDate: params.startDate.toISOString(),
    endDate: params.endDate.toISOString(),
    initialCapital: Number(params.initialCapital),
    leverage: Number(params.leverage),
    symbols: [...params.symbols].sort(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function cacheListForUser(userKey: string): CachedBacktestRun[] {
  const existing = backtestRunCacheByUser.get(userKey);
  if (existing) return existing;
  const created: CachedBacktestRun[] = [];
  backtestRunCacheByUser.set(userKey, created);
  return created;
}

function upsertCache(userKey: string, entry: CachedBacktestRun) {
  const list = cacheListForUser(userKey);
  const existingIdx = list.findIndex((r) => r.hash === entry.hash);
  if (existingIdx >= 0) list.splice(existingIdx, 1);
  list.unshift(entry);
  const max = getMaxCacheSize();
  if (list.length > max) list.length = max;
}

/**
 * GET /api/backtest/runs
 * List cached runs for the authenticated user
 */
router.get('/runs', authenticateUser, (req: AuthenticatedRequest, res) => {
  const userKey = getCacheUserKey(req);
  const limitRaw = (req.query.limit as string | undefined) ?? '20';
  const limit = Math.min(50, Math.max(1, Number(limitRaw) || 20));

  const list = cacheListForUser(userKey)
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      params: {
        ...r.result.params,
        startDate: r.result.params.startDate.toISOString(),
        endDate: r.result.params.endDate.toISOString(),
      },
      summary: r.result.summary,
    }));

  res.json({ runs: list });
});

/**
 * GET /api/backtest/runs/:id
 * Fetch a cached run by id
 */
router.get('/runs/:id', authenticateUser, (req: AuthenticatedRequest, res) => {
  const userKey = getCacheUserKey(req);
  const id = req.params.id;
  const list = cacheListForUser(userKey);
  const hit = list.find((r) => r.id === id);
  if (!hit) return res.status(404).json({ error: 'not_found' });

  return res.json({
    runId: hit.id,
    cachedAt: hit.createdAt,
    cacheHit: true,
    ...hit.result,
  });
});

/**
 * DELETE /api/backtest/runs
 * Clear cached runs for the authenticated user
 */
router.delete('/runs', authenticateUser, (req: AuthenticatedRequest, res) => {
  const userKey = getCacheUserKey(req);
  backtestRunCacheByUser.set(userKey, []);
  res.json({ ok: true });
});

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
      leverage = 4.5,
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

    const userKey = getCacheUserKey(req);
    const hash = stableParamsHash(params);
    const list = cacheListForUser(userKey);
    const cached = list.find((r) => r.hash === hash);
    if (cached) {
      return res.json({
        runId: cached.id,
        cachedAt: cached.createdAt,
        cacheHit: true,
        ...cached.result,
      });
    }
    
    console.log(`[Backtest] Running backtest from ${params.startDate.toISOString()} to ${params.endDate.toISOString()}`);
    console.log(`[Backtest] Capital: $${params.initialCapital}, Symbols: ${params.symbols.join(', ')}`);
    
    const result = await runBacktest(params);

    const entry: CachedBacktestRun = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      hash,
      params,
      result,
    };
    upsertCache(userKey, entry);

    res.json({
      runId: entry.id,
      cachedAt: entry.createdAt,
      cacheHit: false,
      ...result,
    });
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

// ============================================================================
// PARITY VERIFICATION ENDPOINTS
// ============================================================================

/**
 * POST /api/backtest/verify-trade
 * Verify a single trade against backtest
 */
router.post('/verify-trade', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { tradeId } = req.body;

    if (!tradeId) {
      return res.status(400).json({ error: 'tradeId is required' });
    }

    const result = await verifyTrade(tradeId);
    res.json(result);
  } catch (error: any) {
    console.error('[Parity] Error verifying trade:', error);
    res.status(500).json({ error: error.message || 'Verification failed' });
  }
});

/**
 * POST /api/backtest/verify-all
 * Verify all trades within a time range
 */
router.post('/verify-all', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { days = 30, sessionId, symbol } = req.body;

    const result = await verifyAllTrades({
      days: Number(days),
      sessionId,
      symbol,
    });

    res.json(result);
  } catch (error: any) {
    console.error('[Parity] Error in bulk verification:', error);
    res.status(500).json({ error: error.message || 'Bulk verification failed' });
  }
});

/**
 * GET /api/backtest/parity-results
 * Get parity verification results for display
 */
router.get('/parity-results', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const onlyMismatches = req.query.onlyMismatches === 'true';

    const result = await getParityResults({
      limit,
      offset,
      onlyMismatches,
    });

    res.json(result);
  } catch (error: any) {
    console.error('[Parity] Error fetching results:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch results' });
  }
});
