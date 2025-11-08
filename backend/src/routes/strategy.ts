import { Router } from "express";
import { prisma } from "../db/client.js";
import { selectBestPerp } from "../ai/orchestrator.js";
import { proposePlan } from "../ai/planOrchestrator.js";
import { PlanZ } from "../agent/planSchema.js";
import { activeSession } from "../session/session.js";
import { AgentHub } from "../agent/hub.js";
import { requestStrategy } from "../ai/strategyManager.js";
import { levels as calcLevels } from "../risk/brackets.js";
import { optimizeSymbolParameters, optimizeAllSymbols } from "../learning/strategyOptimizer.js";
import { savePersonalityProfile } from "../learning/personalityProfile.js";
import { getSymbolProfile, optimizeAllActiveSymbols } from "../services/symbolSpecificOptimization.js";
export const router = Router();
router.post("/generate", async (req, res) => {
  const symbol = String(req.body?.symbol || "BTCUSDT");
  const trigger = String(req.body?.trigger || "manual");
  const { strategy, levels } = await requestStrategy({ symbol, trigger });
  res.json({ ...(strategy as any), levels });
});
router.get("/today", async (req, res) => {
  const symbol = String(req.query?.symbol || "BTCUSDT");
  const today = new Date().toISOString().slice(0, 10);
  const s = await prisma.strategy.findFirst({
    where: { symbol, id: { startsWith: `${today}:` } },
    orderBy: { createdAt: "desc" },
  });
  if (!s) return res.json(null);
  try {
    const entry: any = (s as any).entryJson || null;
    const risk: any = (s as any).riskJson || null;
    const bias: any = (s as any).bias || 'none';
    const side = bias === 'long' ? 'buy' : 'sell';
    const entryMid = entry?.price ?? (
      typeof entry?.zone?.min === 'number' && typeof entry?.zone?.max === 'number'
        ? (entry.zone.min + entry.zone.max) / 2
        : undefined
    );
    let levels: any = undefined;
    if (typeof entryMid === 'number' && Number.isFinite(entryMid) && entryMid > 0 && risk?.stop && risk?.target) {
      levels = calcLevels(entryMid, side as any, risk.stop, risk.target);
    }
    res.json({
      id: s.id,
      symbol: s.symbol,
      bias: s.bias,
      confidence: s.confidence,
      entry,
      risk,
      validity: { from: s.validityFrom, to: s.validityTo },
      rationale: s.rationale,
      trigger: s.trigger,
      levels,
    });
  } catch {
    res.json(s);
  }
});
// New: Ask LLM for rebound/rejection plan JSON (PlanZ)
router.post('/propose-plan', async (req, res) => {
  const symbol = String(req.body?.symbol || 'BTCUSDT');
  const sessionId = req.body?.sessionId ? String(req.body.sessionId) : undefined;
  const fresh = String(req.body?.fresh || '').toLowerCase() === 'true' || req.body?.fresh === true;
  try {
    if (sessionId) {
      const agent = AgentHub.get(sessionId);
      if (agent) {
        const plan = await agent.nextPlan({ fresh });
        return res.json(PlanZ.parse(plan));
      }
    }
    const plan = await proposePlan(symbol, { fresh, sessionId });
    // Respond with validated plan (schema enforced)
    res.json(PlanZ.parse(plan));
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
router.post('/rank', async (req,res)=>{
  const s = await activeSession();
  if (!s) return res.status(400).json({ error:'no active session' });
  const has = await prisma.order.count({ where:{ sessionId:s.id, status: { in: ['open','new','partially_filled']} }});
  const pos = await prisma.position.count({ where:{ sessionId:s.id }});
  if (has>0 || pos>0) return res.status(409).json({ error:'ranking_disabled_with_open_exposure' });

  const perps = (req.body?.perps as string[]) ?? ['BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT','AVAX/USDT'];
  const ranked = await selectBestPerp(perps);
  res.json(ranked);
});

// Optimize strategy parameters for a specific symbol
router.post('/optimize-symbol', async (req, res) => {
  try {
    const symbol = String(req.body?.symbol);
    const regimeAware = req.body?.regimeAware === true || req.body?.regimeAware === 'true';
    
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required' });
    }

    const optimalParams = await optimizeSymbolParameters(symbol, { regimeAware });
    
    if (!optimalParams) {
      return res.status(404).json({ 
        error: 'Insufficient data',
        message: `Not enough trade evaluation data available for ${symbol} to perform optimization` 
      });
    }

    // Save the optimized parameters
    await savePersonalityProfile(symbol, optimalParams);

    res.json({
      success: true,
      symbol,
      parameters: optimalParams,
      regimeAware,
      message: `Successfully optimized ${regimeAware ? 'regime-aware ' : ''}parameters for ${symbol}`
    });
  } catch (error: any) {
    console.error('Strategy optimization error:', error);
    res.status(500).json({ 
      error: 'Optimization failed',
      message: error?.message || String(error)
    });
  }
});

// Optimize strategy parameters for all symbols with sufficient data
router.post('/optimize-all', async (req, res) => {
  try {
    console.log('🚀 Starting optimize-all request...');
    const regimeAware = req.body?.regimeAware === true || req.body?.regimeAware === 'true';
    
    console.log(`   Regime-aware: ${regimeAware}`);
    
    const results = await optimizeAllSymbols({ regimeAware });
    
    const symbolsOptimized = Array.from(results.keys());
    const parameters = Object.fromEntries(results);

    console.log(`✅ Optimization completed: ${symbolsOptimized.length} symbols optimized`);

    res.json({
      success: true,
      count: symbolsOptimized.length,
      symbols: symbolsOptimized,
      parameters,
      regimeAware,
      message: `Successfully optimized ${regimeAware ? 'regime-aware ' : ''}parameters for ${symbolsOptimized.length} symbols`
    });
  } catch (error: any) {
    console.error('❌ Batch optimization error:', error);
    console.error('   Stack:', error?.stack);
    res.status(500).json({ 
      error: 'Batch optimization failed',
      message: error?.message || String(error),
      details: process.env.NODE_ENV === 'development' ? error?.stack : undefined
    });
  }
});

// Get symbol profile with custom thresholds and performance metrics
router.get('/symbol-profile/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol).toUpperCase();
    
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required' });
    }

    const profile = await getSymbolProfile(symbol);
    
    if (!profile) {
      return res.status(404).json({ 
        error: 'Profile not found',
        message: `No symbol profile found for ${symbol}` 
      });
    }

    res.json({
      success: true,
      profile,
    });
  } catch (error: any) {
    console.error('Get symbol profile error:', error);
    res.status(500).json({ 
      error: 'Failed to get symbol profile',
      message: error?.message || String(error)
    });
  }
});

// Build symbol profiles for all active symbols with sufficient trade history
router.post('/build-symbol-profiles', async (req, res) => {
  try {
    const lookbackDays = Number(req.body?.lookbackDays) || 30;
    
    console.log(`🏗️  Building symbol profiles (lookback: ${lookbackDays} days)...`);
    const results = await optimizeAllActiveSymbols(lookbackDays);
    
    res.json({
      success: true,
      optimized: results.optimized,
      skipped: results.skipped,
      failed: results.failed,
      summary: {
        total: results.optimized.length + results.skipped.length + results.failed.length,
        optimizedCount: results.optimized.length,
        skippedCount: results.skipped.length,
        failedCount: results.failed.length,
      },
      message: `Built symbol profiles: ${results.optimized.length} optimized, ${results.skipped.length} skipped, ${results.failed.length} failed`
    });
  } catch (error: any) {
    console.error('Build symbol profiles error:', error);
    res.status(500).json({ 
      error: 'Failed to build symbol profiles',
      message: error?.message || String(error)
    });
  }
});

// Get all symbol profiles
router.get('/symbol-profiles', async (req, res) => {
  try {
    const profiles = await prisma.$queryRaw<any[]>`
      SELECT * FROM symbol_profiles
      ORDER BY last_optimized_at DESC NULLS LAST
    `.catch(() => []);

    res.json({
      success: true,
      profiles,
      count: profiles.length,
    });
  } catch (error: any) {
    console.error('Get symbol profiles error:', error);
    res.status(500).json({ 
      error: 'Failed to get symbol profiles',
      message: error?.message || String(error)
    });
  }
});
