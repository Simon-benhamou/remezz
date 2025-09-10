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
import { startWSHub } from "./ws/hub.js";
import { startEventEngine } from "./engine/events.js";
const allowedOrigins = [
  "https://tai-cli.up.railway.app",
  "https://trading-agent-ia-v3-fronend-production.up.railway.app",
  "http://localhost:5173"
];
const cfg = getConfig();
const app = express();
app.use(express.json());
app.use(cors({ origin: cfg.CORS_ORIGIN }));
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    return allowedOrigins.includes(origin)
      ? cb(null, true)
      : cb(new Error("Not allowed by CORS: " + origin));
  },
  credentials: true, // indispensable si cookies; OK aussi avec Bearer
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

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

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
startWSHub(wss);
startEventEngine();

server.listen(cfg.PORT, () => console.log(`[api] listening on :${cfg.PORT}`));
