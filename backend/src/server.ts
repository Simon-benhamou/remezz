import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { getConfig } from "./utils/env.js";
import { authMiddleware } from "./utils/security.js";
import { router as authRouter } from "./routes/auth.js";
import { router as userRouter } from "./routes/user.js";
import { router as debugRouter } from "./routes/debug.js";
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
import { checkSmartOpportunities } from "./services/smartAgent.js";
import { startIntegratedMonitoring } from "./services/integrated-performance-monitor.js";
import { startAdaptiveTrainingScheduler } from "./learning/trainer.js";
import { startWSHub } from "./ws/hub.js";
import { startEventEngine } from "./engine/events.js";
import { startArbitrageMonitor } from "./services/arbitrageMonitor.js";
import { getBinanceWebSocket } from "./services/binanceWebSocket.js";
import { startMarginMonitor } from "./services/marginMonitor.js";
import {
  startAgentCreation,
  PhaseError,
} from "./services/agentCreationFlow.js";
import {
  createAgentRateLimiters,
  createMonitorRateLimiters,
} from "./middleware/rateLimit.js";
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
app.post("/api/start-agent", async (req, res) => {
  try {
    const userId = typeof (req as any)?.user?.id === "string" ? (req as any).user.id : undefined;
    const result = await startAgentCreation(req.body ?? {}, userId);
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
startWSHub(wss);
startEventEngine();
startArbitrageMonitor();
startIntegratedMonitoring();
startMarginMonitor();
startAdaptiveTrainingScheduler({ intervalMs: 15 * 60 * 1000, familiesPerBatch: 12, runOnStart: true });

// Prime Binance WS early so UI/API has data immediately
try {
  if (getConfig().EXCHANGE_ID.toLowerCase().includes('binance')) {
    console.log('📡 Priming Binance WebSocket at server startup...');
    getBinanceWebSocket();
  }
} catch (e) { console.warn('WS prime failed:', e); }

// Start Smart Agent background job
console.log('🤖 Starting Smart Agent background checker...');
setInterval(async () => {
  try {
    await checkSmartOpportunities();
  } catch (error) {
    console.error('❌ Smart Agent background job failed:', error);
  }
}, 5 * 60 * 1000); // Check every 5 minutes

server.listen(cfg.PORT, () => console.log(`[api] listening on :${cfg.PORT}`));
