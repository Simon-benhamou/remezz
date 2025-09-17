import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { getConfig } from "./utils/env.js";
import { authMiddleware } from "./utils/security.js";
import { router as authRouter } from "./routes/auth.js";
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
import { startWSHub } from "./ws/hub.js";
import { startEventEngine } from "./engine/events.js";
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
app.use("/api/strategy", strategyRouter);
app.use("/api/agent", agentRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/perf", perfRouter);
app.use("/api/analysis", analysisRouter);
app.use("/api/sim", simRouter);
app.use("/api/monitor", monitorRouter);
app.use("/api/llm", llmTestRouter);
app.use("/api/ops", opsRouter);
app.use("/api/improvements", improvementsRouter);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
startWSHub(wss);
startEventEngine();

server.listen(cfg.PORT, () => console.log(`[api] listening on :${cfg.PORT}`));
