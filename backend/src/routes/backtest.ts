import { Router } from "express";
import { runBacktest, BacktestParams, BacktestResult } from "../services/backtestService.js";
import { authenticateUser, AuthenticatedRequest } from "../middleware/auth.js";
// V2 parity verification with fixed regime detection
import { verifyTradeV2, verifyAllTradesV2, getParityResultsV2 } from "../services/parityVerificationServiceV2.js";
import { runWalkForward, type WalkForwardConfig } from "../services/walkForwardService.js";
import { runOptimization, type ParameterGrid, type OptimizationConfig } from "../services/optimizationService.js";
import { MomentumConfig } from "../strategies/config/momentumConfig.js";
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
    // V5.114: Include postProcess1m in hash — different mode = different results
    postProcess1m: params.postProcess1m === true,
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
  // Allow up to 15 minutes for long backtests (data fetching from REST + simulation)
  req.setTimeout(15 * 60 * 1000);
  res.setTimeout(15 * 60 * 1000);
  try {
    const { 
      startDate, 
      endDate, 
      initialCapital = 2000,
      // V5.130: Default to 19 Tier A+B symbols
      symbols = ['WIF/USDT:USDT', 'UNI/USDT:USDT', 'FET/USDT:USDT', 'STX/USDT:USDT', 'IMX/USDT:USDT', 'ARB/USDT:USDT', 'SEI/USDT:USDT', 'SUI/USDT:USDT', 'NEAR/USDT:USDT', 'ADA/USDT:USDT', 'APT/USDT:USDT', 'ETH/USDT:USDT', 'SONIC/USDT:USDT', 'RENDER/USDT:USDT', 'XRP/USDT:USDT', 'DOGE/USDT:USDT', 'DOT/USDT:USDT', 'BCH/USDT:USDT', 'SOL/USDT:USDT'],
      leverage = 4.5,
      postProcess1m = false,
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
      postProcess1m: postProcess1m === true,
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
    // V5.130: 26 symbols tested individually (Jan-Dec 2025, $2000, 5x)
    symbols: [
      // TIER A — Sharpe>=2, PF>=1.3
      { value: 'WIF/USDT:USDT', label: 'WIF/USDT', tier: 'A', roi24m: '+$28,969' },
      { value: 'UNI/USDT:USDT', label: 'UNI/USDT', tier: 'A', roi24m: '+$8,275' },
      { value: 'FET/USDT:USDT', label: 'FET/USDT', tier: 'A', roi24m: '+$7,727' },
      { value: 'STX/USDT:USDT', label: 'STX/USDT', tier: 'A', roi24m: '+$7,674' },
      { value: 'IMX/USDT:USDT', label: 'IMX/USDT', tier: 'A', roi24m: '+$6,374' },
      { value: 'ARB/USDT:USDT', label: 'ARB/USDT', tier: 'A', roi24m: '+$4,077' },
      { value: 'SEI/USDT:USDT', label: 'SEI/USDT', tier: 'A', roi24m: '+$3,675' },
      { value: 'SUI/USDT:USDT', label: 'SUI/USDT', tier: 'A', roi24m: '+$3,504' },
      { value: 'NEAR/USDT:USDT', label: 'NEAR/USDT', tier: 'A', roi24m: '+$3,456' },
      // TIER B — Sharpe>=1, PF>=1.1
      { value: 'ADA/USDT:USDT', label: 'ADA/USDT', tier: 'B', roi24m: '+$3,220' },
      { value: 'APT/USDT:USDT', label: 'APT/USDT', tier: 'B', roi24m: '+$2,615' },
      { value: 'ETH/USDT:USDT', label: 'ETH/USDT', tier: 'B', roi24m: '+$2,503' },
      { value: 'SONIC/USDT:USDT', label: 'SONIC/USDT', tier: 'B', roi24m: '+$2,321' },
      { value: 'RENDER/USDT:USDT', label: 'RENDER/USDT', tier: 'B', roi24m: '+$1,997' },
      { value: 'XRP/USDT:USDT', label: 'XRP/USDT', tier: 'B', roi24m: '+$1,575' },
      { value: 'DOGE/USDT:USDT', label: 'DOGE/USDT', tier: 'B', roi24m: '+$1,508' },
      { value: 'DOT/USDT:USDT', label: 'DOT/USDT', tier: 'B', roi24m: '+$1,491' },
      { value: 'BCH/USDT:USDT', label: 'BCH/USDT', tier: 'B', roi24m: '+$1,276' },
      { value: 'SOL/USDT:USDT', label: 'SOL/USDT', tier: 'B', roi24m: '+$1,212' },
      // TIER C — Marginal (available but not recommended)
      { value: 'OP/USDT:USDT', label: 'OP/USDT', tier: 'C', roi24m: '+$1,078' },
      { value: 'LINK/USDT:USDT', label: 'LINK/USDT', tier: 'C', roi24m: '+$955' },
      { value: 'AVAX/USDT:USDT', label: 'AVAX/USDT', tier: 'C', roi24m: '+$767' },
      { value: 'BTC/USDT:USDT', label: 'BTC/USDT', tier: 'C', roi24m: 'low freq' },
    ],
    // V5.130: Default = 19 Tier A+B symbols
    defaultSymbols: ['WIF/USDT:USDT', 'UNI/USDT:USDT', 'FET/USDT:USDT', 'STX/USDT:USDT', 'IMX/USDT:USDT', 'ARB/USDT:USDT', 'SEI/USDT:USDT', 'SUI/USDT:USDT', 'NEAR/USDT:USDT', 'ADA/USDT:USDT', 'APT/USDT:USDT', 'ETH/USDT:USDT', 'SONIC/USDT:USDT', 'RENDER/USDT:USDT', 'XRP/USDT:USDT', 'DOGE/USDT:USDT', 'DOT/USDT:USDT', 'BCH/USDT:USDT', 'SOL/USDT:USDT'],
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

    const result = await verifyTradeV2(tradeId);
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

    const result = await verifyAllTradesV2({
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
    const mode = req.query.mode === 'paper' || req.query.mode === 'live' ? req.query.mode : undefined;

    const result = await getParityResultsV2({
      limit,
      offset,
      onlyMismatches,
      userId: req.user?.id,
      mode,
    });

    res.json(result);
  } catch (error: any) {
    console.error('[Parity] Error fetching results:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch results' });
  }
});

// ============================================================================
// Walk-Forward Testing
// ============================================================================

router.post('/walk-forward', authenticateUser, async (req, res) => {
  try {
    const {
      startDate, endDate,
      trainWindowMonths = 6, testWindowMonths = 2, stepMonths = 2,
      symbols, initialCapital = 2000, leverage = 4.5,
      signalOverrides,
    } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const config: WalkForwardConfig = {
      fullStartDate: new Date(startDate),
      fullEndDate: new Date(endDate),
      trainWindowMonths, testWindowMonths, stepMonths,
      symbols: symbols || MomentumConfig.SYMBOLS,
      initialCapital, leverage, signalOverrides,
    };

    const result = await runWalkForward(config);
    res.json(result);
  } catch (error: any) {
    console.error('[Walk-Forward] Error:', error);
    res.status(500).json({ error: error.message || 'Walk-forward failed' });
  }
});

// ============================================================================
// Grid Search / Optimization
// ============================================================================

router.post('/optimize', authenticateUser, async (req, res) => {
  try {
    const {
      grid, startDate, endDate,
      trainWindowMonths = 6, testWindowMonths = 2, stepMonths = 2,
      symbols, initialCapital = 2000, leverage = 4.5,
      topN = 5,
    } = req.body;

    if (!grid || !startDate || !endDate) {
      return res.status(400).json({ error: 'grid, startDate, and endDate are required' });
    }

    const config: OptimizationConfig = {
      grid: grid as ParameterGrid,
      walkForward: {
        fullStartDate: new Date(startDate),
        fullEndDate: new Date(endDate),
        trainWindowMonths, testWindowMonths, stepMonths,
        symbols: symbols || MomentumConfig.SYMBOLS,
        initialCapital, leverage,
      },
      topN,
    };

    const result = await runOptimization(config);
    res.json(result);
  } catch (error: any) {
    console.error('[Optimization] Error:', error);
    res.status(500).json({ error: error.message || 'Optimization failed' });
  }
});
