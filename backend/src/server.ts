/**
 * SIMPLIFIED TRADING SERVER
 * Momentum strategy only - Vol 5x + BTC MA50 + 2h momentum
 */
import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { configureLogging, createLogger } from "./utils/logger.js";
import { getConfig } from "./utils/env.js";
import { authMiddleware } from "./utils/security.js";
import { prisma } from "./db/client.js";
import { initializeDatabaseConnection, disconnectDatabase } from "./db/connection.js";
import { getUserExchange } from "./exchange/ccxtClient.js";
import { getUserCredentials } from "./services/userCredentials.js";

// Essential routes
import { router as authRouter } from "./routes/auth.js";
import { router as userRouter } from "./routes/user.js";
import { router as debugRouter } from "./routes/debug.js";
import { router as ordersRouter } from "./routes/orders.js";
import { router as perfRouter } from "./routes/perf.js";
import { router as marketRouter } from "./routes/market.js";
import portfolioRouter from "./routes/portfolio.js";

// Services
import { getBinanceWebSocket } from "./services/binanceWebSocket.js";

// Strategy
import { 
  SimpleAgent, 
  createAllAgents, 
  getCapitalPool,
  resetCapitalPool,
  type CapitalPool 
} from "./strategies/simpleAgent.js";
import { getMarketConditions, MomentumConfig } from "./strategies/momentumSimple.js";

const logLevel = configureLogging();
const logger = createLogger("server");
logger.info("🚀 Starting Simplified Trading Server", { level: logLevel });

// Process error handlers
process.on('uncaughtException', (error) => {
  logger.error('🚨 Uncaught Exception', { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('🚨 Unhandled Rejection', { reason: String(reason) });
});

const cfg = getConfig();

// CORS
const allowedFromEnv = (cfg.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
const allowedOrigins = new Set<string>([
  ...allowedFromEnv,
  "http://localhost:5173",
  "https://quantai.up.railway.app",
  "https://trading-agent-ia-v3-frontend-production.up.railway.app",
]);

const app = express();
app.use(express.json());

const corsOptions: cors.CorsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    try {
      const u = new URL(origin);
      const normalized = `${u.protocol}//${u.host}`;
      if (allowedOrigins.has(normalized)) return cb(null, true);
    } catch { /* ignore */ }
    return cb(new Error("Not allowed by CORS: " + origin));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "X-API-Key", "Accept"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Public routes
app.use("/api/auth", authRouter);

// Protected routes
app.use(authMiddleware);

app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use("/api/user", userRouter);
app.use("/api/debug", debugRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/perf", perfRouter);
app.use("/api/market", marketRouter);
app.use("/api/portfolio", portfolioRouter);

// ============================================
// AGENT MANAGEMENT
// ============================================

// Store all agents per user (4 agents sharing capital pool)
const userAgents = new Map<string, { agents: SimpleAgent[]; capitalPool: CapitalPool }>();

// Helper to get exchange for user
async function getExchangeForUser(userId: string): Promise<any> {
  const credentials = await getUserCredentials(userId);
  if (!credentials) {
    throw new Error("No exchange credentials found");
  }
  return getUserExchange(userId, credentials);
}

// Get status route
app.get("/api/status", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const userAgentData = userId ? userAgents.get(userId) : null;
    
    if (!userAgentData) {
      return res.json({
        server: "ok",
        database: "connected",
        agent: null,
      });
    }
    
    const { agents, capitalPool } = userAgentData;
    const positions = agents.map(a => a.getStatus());
    
    res.json({
      server: "ok",
      database: "connected",
      agent: {
        running: agents.some(a => a.getStatus().running),
        symbols: MomentumConfig.SYMBOLS,
        positions: positions.filter(p => p.hasPosition).map(p => p.symbol),
        capitalPool: capitalPool.getStatus(),
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Status check failed" });
  }
});

// Market Conditions endpoint - shows if trading conditions are favorable
app.get("/api/market-conditions", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    
    const userAgentData = userAgents.get(userId);
    if (!userAgentData) {
      return res.json({
        status: 'unknown',
        reason: 'No agent running',
        tradingRecommended: false,
      });
    }
    
    // Get conditions from first agent (they all use BTC conditions)
    const firstAgent = userAgentData.agents[0];
    const agentStatus = firstAgent.getStatus();
    const conditions = agentStatus.marketConditions;
    
    res.json({
      status: conditions?.overallStatus || 'unknown',
      btcAboveMa50: conditions?.btcAboveMa50 ?? null,
      btcMomentum6h: conditions?.btcMomentum6h ?? null,
      btcTrend: conditions?.btcTrend ?? null,
      isTradingDay: conditions?.isTradingDay ?? null,
      reason: conditions?.reason || 'Not analyzed yet',
      tradingRecommended: conditions?.overallStatus === 'favorable_long' || conditions?.overallStatus === 'favorable_short',
    });
  } catch (error) {
    logger.error("Failed to get market conditions", error);
    res.status(500).json({ error: "Failed to get market conditions" });
  }
});

// Start agent
app.post("/api/agent/start", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    
    const { mode = "paper", capitalUsd = 10000 } = req.body;
    
    // Check for existing agents
    const existingAgents = userAgents.get(userId);
    if (existingAgents) {
      return res.status(409).json({ 
        error: "Agents already running", 
        symbols: MomentumConfig.SYMBOLS,
      });
    }
    
    // Get exchange
    const exchange = await getExchangeForUser(userId);
    
    // Create sessions for each symbol
    const sessionIds: { btc: string; eth: string; sol: string; xrp: string } = {
      btc: '',
      eth: '',
      sol: '',
      xrp: '',
    };
    
    const symbolToKey: Record<string, keyof typeof sessionIds> = {
      'BTC/USDT:USDT': 'btc',
      'ETH/USDT:USDT': 'eth',
      'SOL/USDT:USDT': 'sol',
      'XRP/USDT:USDT': 'xrp',
    };
    
    for (const symbol of MomentumConfig.SYMBOLS) {
      const session = await prisma.agentSession.create({
        data: {
          userId,
          symbol,
          mode,
          profileJson: { capitalUsd, symbol },
        }
      });
      const key = symbolToKey[symbol];
      if (key) sessionIds[key] = session.id;
    }
    
    // Create all agents with shared capital pool
    const { agents, capitalPool } = await createAllAgents({
      exchange,
      prisma,
      userId,
      sessionIds,
      totalCapitalUsd: capitalUsd,
      mode: mode as 'paper' | 'live',
    });
    
    // Store and start all agents
    userAgents.set(userId, { agents, capitalPool });
    
    for (const agent of agents) {
      await agent.start();
    }
    
    logger.info(`✅ Started ${agents.length} agents for ${userId} with $${capitalUsd} capital (${mode})`);
    res.status(201).json({ 
      success: true, 
      agentsCount: agents.length,
      symbols: MomentumConfig.SYMBOLS,
      capitalUsd,
      mode,
    });
  } catch (error) {
    logger.error("Failed to start agents", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Stop agent
app.post("/api/agent/stop", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    
    const userAgentData = userAgents.get(userId);
    if (!userAgentData) {
      return res.status(404).json({ error: "No agents found" });
    }
    
    // Stop all agents
    for (const agent of userAgentData.agents) {
      await agent.stop();
    }
    
    userAgents.delete(userId);
    
    logger.info(`🛑 All agents stopped for ${userId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to stop agents", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Get agent status
app.get("/api/agent/status", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    
    const userAgentData = userAgents.get(userId);
    if (!userAgentData) {
      return res.json({ running: false });
    }
    
    const { agents, capitalPool } = userAgentData;
    const agentStatuses = agents.map(a => a.getStatus());
    
    res.json({
      running: agentStatuses.some(s => s.running),
      symbols: MomentumConfig.SYMBOLS,
      positions: agentStatuses.filter(s => s.hasPosition).map(s => ({
        symbol: s.symbol,
        hasPosition: s.hasPosition,
      })),
      capitalPool: capitalPool.getStatus(),
      marketConditions: agentStatuses[0]?.marketConditions || null,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// ============================================
// HTTP SERVER + WEBSOCKET
// ============================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const wsClients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  wsClients.add(ws);
  logger.debug("WebSocket client connected");
  
  ws.on("close", () => wsClients.delete(ws));
  ws.on("error", () => wsClients.delete(ws));
});

function broadcast(type: string, data: any) {
  const message = JSON.stringify({ type, data, timestamp: Date.now() });
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

// ============================================
// INITIALIZATION
// ============================================
(async () => {
  try {
    logger.info('🔌 Initializing database...');
    await initializeDatabaseConnection(false);
    logger.info('✅ Database ready');
  } catch (error) {
    logger.warn('⚠️ Database initialization warning:', error);
  }
})();

// Graceful shutdown
const shutdown = async () => {
  logger.info('🛑 Shutting down...');
  for (const [userId, userAgentData] of userAgents) {
    try {
      for (const agent of userAgentData.agents) {
        await agent.stop();
      }
      logger.info(`Stopped all agents for ${userId}`);
    } catch { /* ignore */ }
  }
  await disconnectDatabase();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Initialize Binance WebSocket
(async () => {
  try {
    if (cfg.EXCHANGE_ID.toLowerCase().includes('binance')) {
      logger.info('📡 Initializing Binance WebSocket...');
      const binanceWs = getBinanceWebSocket();
      binanceWs.onTicker((ticker) => {
        broadcast('price_update', {
          symbol: ticker.symbol,
          last: ticker.last,
          bid: ticker.bid,
          ask: ticker.ask,
        });
      });
    }
  } catch (e) { 
    logger.warn('WebSocket init failed:', e); 
  }
})();

// Restore active sessions
(async () => {
  try {
    // Group sessions by userId
    const activeSessions = await prisma.agentSession.findMany({
      where: { stoppedAt: null },
      include: { user: true }
    });
    
    // Group by user
    const sessionsByUser = new Map<string, any[]>();
    for (const session of activeSessions) {
      if (!session.userId) continue;
      const existing = sessionsByUser.get(session.userId) || [];
      existing.push(session);
      sessionsByUser.set(session.userId, existing);
    }
    
    // Restore each user's agents
    for (const [userId, sessions] of sessionsByUser) {
      try {
        const exchange = await getExchangeForUser(userId);
        
        // Get capital from first session profile
        const firstProfile = sessions[0]?.profileJson as any;
        const capitalUsd = firstProfile?.capitalUsd || 10000;
        
        // Build session IDs map
        const sessionIds: { btc: string; eth: string; sol: string; xrp: string } = {
          btc: '',
          eth: '',
          sol: '',
          xrp: '',
        };
        
        const symbolToKey: Record<string, keyof typeof sessionIds> = {
          'BTC/USDT:USDT': 'btc',
          'ETH/USDT:USDT': 'eth',
          'SOL/USDT:USDT': 'sol',
          'XRP/USDT:USDT': 'xrp',
        };
        
        for (const session of sessions) {
          const key = symbolToKey[session.symbol];
          if (key) sessionIds[key] = session.id;
        }
        
        // Fill in missing session IDs by creating new sessions
        for (const symbol of MomentumConfig.SYMBOLS) {
          const key = symbolToKey[symbol];
          if (key && !sessionIds[key]) {
            const newSession = await prisma.agentSession.create({
              data: {
                userId,
                symbol,
                mode: sessions[0]?.mode || 'paper',
                profileJson: { capitalUsd, symbol },
              }
            });
            sessionIds[key] = newSession.id;
          }
        }
        
        const mode = sessions[0]?.mode as 'paper' | 'live' || 'paper';
        
        const { agents, capitalPool } = await createAllAgents({
          exchange,
          prisma,
          userId,
          sessionIds,
          totalCapitalUsd: capitalUsd,
          mode,
        });
        
        userAgents.set(userId, { agents, capitalPool });
        
        for (const agent of agents) {
          await agent.start();
        }
        
        logger.info(`♻️ Restored ${agents.length} agents for ${userId}`);
      } catch (error) {
        logger.warn(`Failed to restore sessions for ${userId}:`, error);
      }
    }
  } catch (error) {
    logger.warn('⚠️ Failed to restore sessions:', error);
  }
})();

server.listen(cfg.PORT, () => {
  logger.info(`✅ Server listening on :${cfg.PORT}`);
  logger.info(`📈 Strategy: Momentum Simple (Vol 5x + BTC MA50 + 2h Mom)`);
});
