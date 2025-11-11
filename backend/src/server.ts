import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { configureLogging, createLogger } from "./utils/logger.js";
import { getConfig } from "./utils/env.js";
import { authMiddleware } from "./utils/security.js";
import { router as authRouter } from "./routes/auth.js";
import { router as userRouter } from "./routes/user.js";
import { router as debugRouter } from "./routes/debug.js";
import { router as debugApiKeysRouter } from "./routes/debug-apikeys.js";
import { router as statusRouter } from "./routes/status.js";
import { router as strategyRouter } from "./routes/strategy.js";
import { router as agentRouter } from "./routes/agent.js";
import { router as ordersRouter } from "./routes/orders.js";
import { router as perfRouter } from "./routes/perf.js";
import { router as analysisRouter } from "./routes/analysis.js";
import { router as simRouter } from "./routes/sim.js";
import { router as monitorRouter } from "./routes/monitor.js";
import { router as llmTestRouter } from "./routes/llmTest.js";
import { router as opsRouter } from "./routes/ops.js";
import { router as improvementsRouter } from "./routes/improvements.js";
import { router as marketRouter } from "./routes/market.js";
import { router as cacheRouter } from "./routes/cache.js";
import { batchRouter } from "./routes/batch.js";
import { scannerRouter } from "./routes/scanner.js";
import { router as intelligentRouter } from "./routes/intelligent.js";
import { router as arbitrageRouter } from "./routes/arbitrage.js";
import { router as debugSelectionRouter } from "./routes/debug-selection.js";
import { router as capitalRouter } from "./routes/capital.js";
import { router as entryAnalyticsRouter } from "./routes/entryAnalytics.js";
import smartSelectionRouter from "./routes/smart-selection.js";
import validationRouter from "./routes/validation.js";
import { checkSmartOpportunities } from "./services/smartAgent.js";
import { startIntegratedMonitoring } from "./services/integrated-performance-monitor.js";
import { startAdaptiveTrainingScheduler } from "./learning/trainer.js";
import { startPredictorRetrainingScheduler } from "./learning/predictorRetrainer.js";
import { startWSHub } from "./ws/hub.js";
import { startEventEngine } from "./engine/events.js";
import { startArbitrageMonitor } from "./services/arbitrageMonitor.js";
import { getBinanceWebSocket } from "./services/binanceWebSocket.js";
import { refreshLeverageConstraintInputs } from "./risk/leverageCaps.js";
import { startMarginMonitor } from "./services/marginMonitor.js";
import { stateReconciler } from "./services/stateReconciler.js";
import { prisma } from "./db/client.js";
import { initializeDatabaseConnection, disconnectDatabase } from "./db/connection.js";
import {
  startAgentCreation,
  PhaseError,
} from "./services/agentCreationFlow.js";
import { restoreAutoUniverseRetrySchedule } from "./services/intelligentAgent.js";
import {
  createAgentRateLimiters,
  createMonitorRateLimiters,
} from "./middleware/rateLimit.js";
import { rehydrateActiveAgentSessions } from "./services/sessionRehydration.js";
import { startSchedulerWorker } from "./services/schedulerJobService.js";
import { initMetaAdaptiveOrchestrator } from "./services/metaAdaptiveOrchestrator.js";

const logLevel = configureLogging();
const serverLogger = createLogger("server");
serverLogger.debug("Logging initialized", { level: logLevel });
const cfg = getConfig();
// Build allowed origins from env (comma-separated) plus safe defaults
const allowedFromEnv = (cfg.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const allowedOrigins = new Set<string>([
  ...allowedFromEnv,
  "http://localhost:5173",
  // Known deployment frontends (fixing earlier typo 'fronend')
  "https://quantai.up.railway.app",
  // Keep both to be safe if the deployed URL contains a typo
  "https://trading-agent-ia-v3-frontend-production.up.railway.app",
  "https://trading-agent-ia-v3-fronend-production.up.railway.app",
]);
const app = express();
app.use(express.json());
const agentRateLimiters = createAgentRateLimiters();
const monitorRateLimiters = createMonitorRateLimiters();
// CORS: allow only known origins and those provided via env; include x-api-key header
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // allow server-to-server/no-origin
    try {
      const u = new URL(origin);
      const normalized = `${u.protocol}//${u.host}`;
      if (allowedOrigins.has(normalized)) return cb(null, true);
    } catch {
      // fall through
    }
    return cb(new Error("Not allowed by CORS: " + origin));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-api-key",
    "X-API-Key",
    "Accept",
  ],
};
app.use(cors(corsOptions));
// Ensure preflight requests are handled
app.options("*", cors(corsOptions));

// Public routes (no API key required)
app.use("/api/auth", authRouter);

// Protected routes (API key required)
app.use(authMiddleware);

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

app.use("/api/status", statusRouter);
app.use("/api/user", userRouter);
app.use("/api/debug", debugRouter);
app.use("/api/debug-apikeys", debugApiKeysRouter);
app.use("/api/debug-selection", debugSelectionRouter);
app.use("/api/strategy", strategyRouter);
app.use("/api/agent", ...agentRateLimiters, agentRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/perf", perfRouter);
app.use("/api/analysis", analysisRouter);
app.use("/api/sim", simRouter);
app.use("/api/monitor", ...monitorRateLimiters, monitorRouter);
app.use("/api/market", marketRouter);
app.use("/api/cache", cacheRouter);
app.use("/api/batch", batchRouter);
app.use("/api/scanner", scannerRouter);
app.use("/api/intelligent", intelligentRouter);
app.use("/api/arbitrage", arbitrageRouter);
app.use("/api/llm", llmTestRouter);
app.use("/api/ops", opsRouter);
app.use("/api/improvements", improvementsRouter);
app.use("/api/capital", capitalRouter);
app.use("/api/entry-analytics", entryAnalyticsRouter);
app.use("/api/smart-selection", smartSelectionRouter);
app.use("/api/validation", validationRouter);
app.post("/api/start-agent", async (req, res) => {
  try {
    const userId = typeof (req as any)?.user?.id === "string" ? (req as any).user.id : undefined;
    const result = await startAgentCreation(req.body ?? {}, userId);
    
    // 🚀 Start state reconciliation for live mode agents
    if (result?.mode === 'live' && userId) {
      const reconStatus = stateReconciler.getReconciliationStatus(userId);
      if (!reconStatus.active) {
        stateReconciler.startPeriodicReconciliation(userId);
        serverLogger.info(`🔄 Started state reconciliation for new live agent (user: ${userId})`);
      }
    }
    
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof PhaseError) {
      const status =
        error.code === "start.validation_failed"
          ? 400
          : error.code === "start.universe_conflict" || error.code === "start.universe_empty"
          ? 409
          : 500;
      return res.status(status).json({ error: error.code, message: error.message, details: error.details });
    }
    res.status(500).json({
      error: "start.unexpected_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Initialize database connection with retry logic (handles Neon cold starts)
(async () => {
  try {
    serverLogger.info('🔌 Initializing database connection...');
    const connected = await initializeDatabaseConnection(false); // Non-critical, won't crash
    if (connected) {
      serverLogger.info('✅ Database ready');
    }
  } catch (error) {
    serverLogger.warn('⚠️ Database initialization warning:', error);
  }
})();

// Handle graceful shutdown
const shutdown = async () => {
  serverLogger.info('🛑 Shutting down gracefully...');
  await disconnectDatabase();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startWSHub(wss);
startEventEngine();
initMetaAdaptiveOrchestrator();
startArbitrageMonitor();
startIntegratedMonitoring();
startMarginMonitor();

// 🚀 Start state reconciliation for all active live sessions
(async () => {
  try {
    const activeSessions = await prisma.agentSession.findMany({
      where: { 
        stoppedAt: null,
        mode: 'live',
        userId: { not: null }
      },
      select: { userId: true },
      distinct: ['userId']
    });
    
    const uniqueUserIds = new Set(activeSessions.map(s => s.userId).filter(Boolean) as string[]);
    
    for (const userId of uniqueUserIds) {
      stateReconciler.startPeriodicReconciliation(userId);
      serverLogger.info(`🔄 Started state reconciliation for user: ${userId}`);
    }
    
    if (uniqueUserIds.size > 0) {
      serverLogger.info(`✅ State reconciliation service initialized for ${uniqueUserIds.size} users`);
    }
  } catch (error) {
    serverLogger.warn('⚠️ Failed to initialize state reconciliation:', error);
  }
})();

startAdaptiveTrainingScheduler({ intervalMs: 15 * 60 * 1000, familiesPerBatch: 12, runOnStart: true });

// Start intelligent predictor retraining scheduler
if (process.env.PREDICTOR_RETRAINING_DISABLED !== 'true') {
  startPredictorRetrainingScheduler();
  serverLogger.info('🤖 Predictor retraining scheduler started');
}

restoreAutoUniverseRetrySchedule().catch((error) => {
  serverLogger.warn('⚠️ Failed to restore auto universe retry schedule:', error);
});

startSchedulerWorker();

// Initialize adaptive threshold learning and related services
import { initializeAdaptiveLearning } from "./services/adaptiveThresholdLearning.js";
import { initializeSymbolProfiles, startSymbolOptimizationScheduler } from "./services/symbolSpecificOptimization.js";
import { initializeABTesting } from "./services/abTesting.js";
import { initializeOptimizerScheduling } from "./learning/optimizerJob.js";
import { initializeReoptimizationScheduling } from "./learning/reoptimizationScheduler.js";
import { startOutcomeUpdater } from "./learning/outcomeUpdater.js";

Promise.all([
  initializeAdaptiveLearning(),
  initializeSymbolProfiles(),
  initializeABTesting(),
  initializeOptimizerScheduling(),
  initializeReoptimizationScheduling(),
]).catch((error) => {
  serverLogger.warn('⚠️ Failed to initialize learning services:', error);
});

// Start personality profile outcome updater worker
if (process.env.OUTCOME_UPDATER_DISABLED !== 'true') {
  startOutcomeUpdater();
  serverLogger.info('📊 Personality profile outcome updater started');
}

// Start symbol optimization scheduler (runs daily)
if (process.env.SYMBOL_OPTIMIZATION_DISABLED !== 'true') {
  const optimizationHours = parseInt(process.env.SYMBOL_OPTIMIZATION_INTERVAL_HOURS || '24');
  startSymbolOptimizationScheduler(optimizationHours);
}

const DEFAULT_LEVERAGE_REFRESH_MS = 15 * 60 * 1000;
const LEVERAGE_REFRESH_INTERVAL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.LEVERAGE_REFRESH_INTERVAL_MS || `${DEFAULT_LEVERAGE_REFRESH_MS}`)
);
async function runLeverageRefresh(startup = false) {
  try {
    await refreshLeverageConstraintInputs({ force: startup });
  } catch (error) {
    serverLogger.error('⚠️ Failed to refresh leverage constraints:', error);
  }
}

if (process.env.LEVERAGE_CONSTRAINT_REFRESH_DISABLED !== 'true') {
  runLeverageRefresh(true);
  setInterval(() => runLeverageRefresh(false), LEVERAGE_REFRESH_INTERVAL_MS);
}

// Prime Binance WS early so UI/API has data immediately
try {
  if (getConfig().EXCHANGE_ID.toLowerCase().includes('binance')) {
    serverLogger.info('📡 Priming Binance WebSocket at server startup...');
    getBinanceWebSocket();
  }
} catch (e) { serverLogger.warn('WS prime failed:', e); }

// Start Smart Agent background jobs with EVENT-DRIVEN monitoring
serverLogger.info('🤖 Starting Smart Agent intelligent monitoring system...');

// ============================================================
// 🔥 EVENT-DRIVEN SMART SELECTION
// ============================================================
// Triggers:
// 1. Position closed → Immediate scan (handled by intelligent agent)
// 2. Market regime change → BTC ±5% (every 5 min check)
// 3. Volume spike → 2x normal + momentum (every 10 min)
// 4. Prolonged inactivity → 6+ hours idle (hourly fallback)
// 5. Manual trigger → API endpoint

let lastBtcPrice = 0;
let btcPriceHistory: Array<{ price: number; timestamp: number }> = [];
let lastVolumeCheck = Date.now();

// FALLBACK: Safety net every 60 minutes (not aggressive!)
setInterval(async () => {
  try {
    serverLogger.info('🔍 [Smart Selection] Hourly fallback check');
    const sessions = await prisma.agentSession.findMany({
      where: {
        stoppedAt: null,
        OR: [
          { isSmartAgent: true },
          { profileJson: { path: ['isIntelligent'], equals: true } }
        ]
      },
    });
    
    for (const session of sessions) {
      // Check if idle for 6+ hours
      const lastTradeAt = await prisma.fill.findFirst({
        where: { sessionId: session.id },
        orderBy: { ts: 'desc' },
        select: { ts: true },
      });
      
      const hoursSinceLastTrade = lastTradeAt 
        ? (Date.now() - new Date(lastTradeAt.ts).getTime()) / (1000 * 60 * 60)
        : 999;
      
      if (hoursSinceLastTrade > 6) {
        serverLogger.info(`⚠️ Session ${session.id} idle for ${hoursSinceLastTrade.toFixed(1)}h - checking opportunities`);
        const { evaluateSmartSwitch } = await import('./services/smartSelectionOrchestrator.js');
        const result = await evaluateSmartSwitch(session.id, session.symbol, session.id);
        if (result.shouldSwitch) {
          serverLogger.info(`🔄 IDLE SESSION: ${session.symbol} → ${result.targetSymbol} (target score: ${result.targetScore})`);
        }
      }
    }
  } catch (error) {
    serverLogger.error('❌ [Smart Selection] Fallback error:', error);
  }
}, 60 * 60 * 1000); // Hourly

// REGIME CHANGE: Monitor BTC momentum/acceleration every 5 minutes
setInterval(async () => {
  try {
    const { getTicker } = await import('./data/market.js');
    const btcTicker = await getTicker('BTC/USDT:USDT');
    if (!btcTicker) return;
    
    const currentPrice = Number(btcTicker.last);
    const now = Date.now();
    
    // Initialize
    if (lastBtcPrice === 0) {
      lastBtcPrice = currentPrice;
      btcPriceHistory.push({ price: currentPrice, timestamp: now });
      return;
    }
    
    // Add to history (keep last 30 minutes = 6 data points)
    btcPriceHistory.push({ price: currentPrice, timestamp: now });
    btcPriceHistory = btcPriceHistory.filter(p => now - p.timestamp < 30 * 60 * 1000);
    
    // Need at least 3 data points to detect acceleration
    if (btcPriceHistory.length < 3) return;
    
    // Calculate price velocity (rate of change)
    const velocities: number[] = [];
    for (let i = 1; i < btcPriceHistory.length; i++) {
      const timeDelta = (btcPriceHistory[i].timestamp - btcPriceHistory[i-1].timestamp) / (60 * 1000); // minutes
      const priceDelta = (btcPriceHistory[i].price - btcPriceHistory[i-1].price) / btcPriceHistory[i-1].price;
      velocities.push(priceDelta / timeDelta); // % change per minute
    }
    
    // Calculate acceleration (change in velocity)
    const recentVelocity = velocities[velocities.length - 1];
    const avgPastVelocity = velocities.slice(0, -1).reduce((a, b) => a + b, 0) / (velocities.length - 1);
    const acceleration = recentVelocity - avgPastVelocity;
    
    // Current price change from reference
    const priceChange = Math.abs((currentPrice - lastBtcPrice) / lastBtcPrice);
    
    // TRIGGERS:
    // 1. Strong acceleration (velocity doubled) - EARLY WARNING
    // 2. Price change ≥3% with positive velocity - CONFIRMATION
    // 3. Price change ≥7% - MAJOR REGIME CHANGE
    
    let triggerReason = '';
    let shouldTrigger = false;
    
    if (Math.abs(acceleration) > Math.abs(avgPastVelocity) * 1.5 && Math.abs(recentVelocity) > 0.0005) {
      // Acceleration detected: velocity increased by 50%+
      triggerReason = `acceleration (velocity: ${(recentVelocity * 100).toFixed(4)}%/min, accel: ${(acceleration * 100).toFixed(4)}%/min²)`;
      shouldTrigger = true;
    } else if (priceChange >= 0.03 && Math.abs(recentVelocity) > 0.0003) {
      // 3%+ move with momentum
      triggerReason = `momentum (${(priceChange * 100).toFixed(2)}% + velocity ${(recentVelocity * 100).toFixed(4)}%/min)`;
      shouldTrigger = true;
    } else if (priceChange >= 0.07) {
      // Major 7%+ move
      triggerReason = `major shift (${(priceChange * 100).toFixed(2)}%)`;
      shouldTrigger = true;
    }
    
    if (shouldTrigger) {
      serverLogger.info(`🚨 [Smart Selection] BTC regime change detected: ${triggerReason}`);
      const { forceUniverseRefresh, evaluateSmartSwitch } = await import('./services/smartSelectionOrchestrator.js');
      await forceUniverseRefresh();
      lastBtcPrice = currentPrice;
      
      // Evaluate all active sessions
      const sessions = await prisma.agentSession.findMany({
        where: { stoppedAt: null },
      });
      
      for (const session of sessions) {
        await evaluateSmartSwitch(session.id, session.symbol, session.id).catch(() => {});
      }
    }
  } catch (error) {
    // Silent - not critical
  }
}, 5 * 60 * 1000); // Every 5 min

// VOLUME SPIKE: Check for unusual activity every 10 minutes
setInterval(async () => {
  try {
    const now = Date.now();
    if (now - lastVolumeCheck < 10 * 60 * 1000) return;
    lastVolumeCheck = now;
    
    const { getAdaptiveUniverse, forceUniverseRefresh } = await import('./services/smartSelectionOrchestrator.js');
    const { getTicker } = await import('./data/market.js');
    
    const universe = await getAdaptiveUniverse();
    const tickers = await Promise.all(universe.map(s => getTicker(s).catch(() => null)));
    
    for (let i = 0; i < universe.length; i++) {
      const ticker = tickers[i];
      if (!ticker) continue;
      
      const volume24h = Number(ticker.quoteVolume || 0);
      const change24h = Math.abs(Number(ticker.percentage || 0));
      
      // 2x normal volume + momentum
      if (volume24h > 100_000_000 && change24h > 5) {
        serverLogger.info(`📊 [Smart Selection] Volume spike: ${universe[i]} $${(volume24h / 1_000_000).toFixed(1)}M (+${change24h.toFixed(1)}%)`);
        await forceUniverseRefresh();
        break;
      }
    }
  } catch (error) {
    // Silent
  }
}, 10 * 60 * 1000); // Every 10 min

await rehydrateActiveAgentSessions().catch((error) => {
  serverLogger.error('❌ Failed to rehydrate active agent sessions during startup:', error);
});

// Initialize paper balance from database
serverLogger.info('💰 Initializing paper balance from database...');
try {
  const { initializePaperBalance } = await import('./services/capitalPool.js');
  await initializePaperBalance();
} catch (error) {
  serverLogger.warn('⚠️ Failed to initialize paper balance from database:', error);
}

server.listen(cfg.PORT, () => serverLogger.info(`[api] listening on :${cfg.PORT}`));
