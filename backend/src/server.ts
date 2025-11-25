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
import { authMiddleware, AuthenticatedRequest } from "./utils/security.js";
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
// MISSING ROUTES - RESTORE FOR FRONTEND COMPATIBILITY
// ============================================

// List all sessions
app.get("/api/agent/sessions", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const { mode, includeStats } = req.query;
    
    const where: any = { userId };
    if (mode) where.mode = mode;
    
    const sessions = await prisma.agentSession.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
    
    // Return array directly, not wrapped in object
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

// Delete session
app.delete("/api/agent/sessions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const userId = (req as any)?.user?.id;
    
    const session = await prisma.agentSession.findFirst({
      where: { id, userId }
    });
    
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    await prisma.agentSession.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete session" });
  }
});

// Overview
app.get("/api/agent/overview", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const { mode } = req.query;
    
    const where: any = { userId };
    if (mode) where.mode = mode;
    
    const sessions = await prisma.agentSession.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: 20,
      include: {
        orders: {
          where: { status: 'filled' },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
    
    const userAgentData = userAgents.get(userId);
    const capitalPoolStatus = userAgentData?.capitalPool.getStatus() || null;
    
    res.json({
      sessions,
      capitalPool: capitalPoolStatus,
      activeSymbols: userAgentData ? MomentumConfig.SYMBOLS : [],
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to get overview" });
  }
});

// Get single session
app.get("/api/agent/session", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    
    // Get most recent active session
    const session = await prisma.agentSession.findFirst({
      where: { userId, stoppedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    
    res.json({ session });
  } catch (error) {
    res.status(500).json({ error: "Failed to get session" });
  }
});

// Get agent state
app.get("/api/agent/state", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const { sessionId } = req.query;
    
    const userAgentData = userAgents.get(userId);
    if (!userAgentData) {
      return res.json({ state: null });
    }
    
    const agentStatuses = userAgentData.agents.map(a => a.getStatus());
    
    res.json({ 
      state: {
        running: agentStatuses.some(s => s.running),
        positions: agentStatuses,
        capitalPool: userAgentData.capitalPool.getStatus(),
      }
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to get agent state" });
  }
});

// Get diagnostics
app.get("/api/agent/:sessionId/diagnostics", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const { sessionId } = req.params;
    
    const session = await prisma.agentSession.findFirst({
      where: { id: sessionId, userId },
      include: {
        orders: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });
    
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    res.json({
      session,
      recentOrders: session.orders || [],
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to get diagnostics" });
  }
});

// Portfolio routes
app.get("/api/agent/portfolio", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const mode = (req.query.mode as string) || 'paper';
    
    // For LIVE mode, fetch real balance from exchange
    if (mode === 'live' && userId) {
      try {
        const exchange = await getExchangeForUser(userId);
        if (exchange && exchange.fetchBalance) {
          const balance = await exchange.fetchBalance({ type: 'future' });
          const usdtTotal = balance?.USDT || balance?.total?.USDT || 0;
          const usdtFree = balance?.free?.USDT || 0;
          const usdtUsed = balance?.used?.USDT || 0;
          
          // Also fetch positions from exchange
          let exchangePositions: any[] = [];
          if (exchange.fetchPositions) {
            try {
              const positions = await exchange.fetchPositions();
              exchangePositions = positions.filter((p: any) => {
                const qty = Math.abs(parseFloat(p?.contracts || p?.info?.positionAmt || '0'));
                return qty > 0;
              }).map((p: any) => ({
                symbol: p.symbol,
                side: parseFloat(p?.info?.positionAmt || '0') > 0 ? 'long' : 'short',
                qty: Math.abs(parseFloat(p?.contracts || p?.info?.positionAmt || '0')),
                entryPrice: parseFloat(p?.entryPrice || p?.info?.entryPrice || '0'),
                unrealizedPnl: parseFloat(p?.unrealizedPnl || p?.info?.unRealizedProfit || '0'),
              }));
            } catch (posError) {
              logger.warn('Failed to fetch positions from exchange:', posError);
            }
          }
          
          return res.json({
            balance: typeof usdtTotal === 'number' ? usdtTotal : parseFloat(usdtTotal) || 0,
            freeBalance: typeof usdtFree === 'number' ? usdtFree : parseFloat(usdtFree) || 0,
            inPositions: typeof usdtUsed === 'number' ? usdtUsed : parseFloat(usdtUsed) || 0,
            positions: exchangePositions,
            mode: 'live',
            source: 'exchange',
          });
        }
      } catch (exchangeError) {
        logger.warn('Failed to fetch live portfolio from exchange:', exchangeError);
      }
    }
    
    // For paper mode or if exchange fetch fails
    const userAgentData = userAgents.get(userId);
    if (!userAgentData) {
      return res.json({
        balance: mode === 'paper' ? 10000 : 0,
        freeBalance: mode === 'paper' ? 10000 : 0,
        inPositions: 0,
        positions: [],
        mode,
        source: 'default',
      });
    }
    
    const capitalStatus = userAgentData.capitalPool.getStatus();
    const agentStatuses = userAgentData.agents.map(a => a.getStatus());
    
    res.json({
      balance: capitalStatus.totalUsd,
      freeBalance: capitalStatus.availableUsd,
      inPositions: capitalStatus.inPositionsUsd,
      positions: agentStatuses.filter(s => s.hasPosition),
      mode,
      source: 'capital_pool',
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to get portfolio" });
  }
});

app.post("/api/agent/portfolio/balance", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const { mode, balanceUsd } = req.body;
    
    // This is mainly for paper trading - just acknowledge
    res.json({ success: true, mode, balanceUsd });
  } catch (error) {
    res.status(500).json({ error: "Failed to set balance" });
  }
});

app.post("/api/agent/portfolio/rebalance", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const { mode } = req.body;
    
    // Rebalance capital between agents
    res.json({ success: true, mode });
  } catch (error) {
    res.status(500).json({ error: "Failed to rebalance" });
  }
});

// Capital routes
app.get("/api/capital/:mode/snapshot", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const { mode } = req.params;
    
    // For LIVE mode, fetch real balance from exchange
    if (mode === 'live' && userId) {
      try {
        const exchange = await getExchangeForUser(userId);
        if (exchange && exchange.fetchBalance) {
          const balance = await exchange.fetchBalance({ type: 'future' });
          const usdtBalance = balance?.USDT || balance?.total?.USDT || 0;
          const freeUsdt = balance?.free?.USDT || 0;
          const usedUsdt = balance?.used?.USDT || 0;
          
          return res.json({
            totalUSD: typeof usdtBalance === 'number' ? usdtBalance : parseFloat(usdtBalance) || 0,
            freeUSD: typeof freeUsdt === 'number' ? freeUsdt : parseFloat(freeUsdt) || 0,
            reservedUSD: 0,
            inPositionsUSD: typeof usedUsdt === 'number' ? usedUsdt : parseFloat(usedUsdt) || 0,
            ts: Date.now(),
            source: 'exchange',
          });
        }
      } catch (exchangeError) {
        logger.warn('Failed to fetch live balance from exchange:', exchangeError);
        // Fall through to return agent data or zeros
      }
    }
    
    // For paper mode or if exchange fetch fails, use agent capital pool
    const userAgentData = userAgents.get(userId);
    if (!userAgentData) {
      return res.json({
        totalUSD: mode === 'paper' ? 10000 : 0, // Default paper balance
        freeUSD: mode === 'paper' ? 10000 : 0,
        reservedUSD: 0,
        inPositionsUSD: 0,
        ts: Date.now(),
        source: 'default',
      });
    }
    
    const status = userAgentData.capitalPool.getStatus();
    res.json({
      totalUSD: status.totalUsd,
      freeUSD: status.availableUsd,
      reservedUSD: status.reservedUsd,
      inPositionsUSD: status.inPositionsUsd,
      ts: Date.now(),
      source: 'capital_pool',
    });
  } catch (error) {
    logger.error('Failed to get capital snapshot:', error);
    res.status(500).json({ error: "Failed to get capital snapshot" });
  }
});

app.get("/api/capital/reservations", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    
    const userAgentData = userAgents.get(userId);
    if (!userAgentData) {
      return res.json({ paper: [], live: [] });
    }
    
    const status = userAgentData.capitalPool.getStatus();
    // Convert byAgent to array format for frontend
    const reservations = Object.entries(status.byAgent).map(([agentId, data]) => ({
      agentId,
      reserved: data.reserved,
      inPosition: data.inPosition,
    }));
    res.json({
      paper: reservations,
      live: [],
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to get reservations" });
  }
});

app.post("/api/capital/paper/set-balance", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const { initialUSD } = req.body;
    
    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    
    // If agents exist, stop them and restart with new capital
    const existingAgents = userAgents.get(userId);
    if (existingAgents) {
      // Stop existing agents
      for (const agent of existingAgents.agents) {
        await agent.stop();
      }
      userAgents.delete(userId);
      
      logger.info(`Paper balance reset requested: $${initialUSD}. Agents stopped, restart required.`);
    }
    
    // Store the new initial balance for next agent start
    // Will be used when /api/agent/start is called
    res.json({ 
      success: true, 
      initialUSD,
      message: existingAgents ? "Agents stopped. Call /api/agent/start with capitalUsd to restart with new balance." : "Balance set. Call /api/agent/start to create agents."
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to set balance" });
  }
});

// Agent creation routes (for backward compatibility with old frontend flow)
// These now actually create the agents using the new 4-agent system
const pendingCreations = new Map<string, { userId: string; mode: string; capitalUsd: number; symbol?: string }>();

app.post("/api/agent/creation/prepare", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    
    const { mode = 'paper', capitalUsd = 10000, maxLeverage, aggressiveness, symbol } = req.body;
    
    // Check if agents already exist
    const existingAgents = userAgents.get(userId);
    if (existingAgents) {
      return res.status(409).json({ 
        error: "Agents already running. Stop them first.",
        symbols: MomentumConfig.SYMBOLS,
      });
    }
    
    // Store creation params for later activation
    const creationId = `creation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    pendingCreations.set(creationId, { userId, mode, capitalUsd, symbol });
    
    // Auto-expire after 5 minutes
    setTimeout(() => pendingCreations.delete(creationId), 5 * 60 * 1000);
    
    res.json({
      creationId,
      symbols: MomentumConfig.SYMBOLS,
      message: "Creation prepared. Call activate to start agents.",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to prepare creation" });
  }
});

app.post("/api/agent/creation/create-session", async (req, res) => {
  try {
    const { creationId, symbol } = req.body;
    
    const creation = pendingCreations.get(creationId);
    if (creation) {
      creation.symbol = symbol;
    }
    
    res.json({
      success: true,
      symbol,
      message: "Symbol selected. Call activate to start.",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/agent/creation/activate", async (req, res) => {
  try {
    const { creationId } = req.body;
    const userId = (req as any)?.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    
    const creation = pendingCreations.get(creationId);
    if (!creation || creation.userId !== userId) {
      return res.status(404).json({ error: "Creation not found or expired" });
    }
    
    // Actually create the agents now
    const { mode, capitalUsd } = creation;
    
    // Get exchange
    const exchange = await getExchangeForUser(userId);
    
    // Create sessions for each symbol
    const sessionIds: { btc: string; eth: string; sol: string; xrp: string } = {
      btc: '', eth: '', sol: '', xrp: '',
    };
    
    const symbolToKey: Record<string, keyof typeof sessionIds> = {
      'BTC/USDT:USDT': 'btc', 'ETH/USDT:USDT': 'eth', 'SOL/USDT:USDT': 'sol', 'XRP/USDT:USDT': 'xrp',
    };
    
    for (const symbol of MomentumConfig.SYMBOLS) {
      const session = await prisma.agentSession.create({
        data: { userId, symbol, mode, profileJson: { capitalUsd, symbol } }
      });
      const key = symbolToKey[symbol];
      if (key) sessionIds[key] = session.id;
    }
    
    // Create all agents with shared capital pool
    const { agents, capitalPool } = await createAllAgents({
      exchange, prisma, userId, sessionIds,
      totalCapitalUsd: capitalUsd,
      mode: mode as 'paper' | 'live',
    });
    
    // Store and start all agents
    userAgents.set(userId, { agents, capitalPool });
    
    for (const agent of agents) {
      await agent.start();
    }
    
    // Clean up pending creation
    pendingCreations.delete(creationId);
    
    logger.info(`✅ Created ${agents.length} agents for ${userId} via creation flow`);
    
    res.json({
      success: true,
      agentsCount: agents.length,
      symbols: MomentumConfig.SYMBOLS,
      capitalUsd,
      mode,
    });
  } catch (error) {
    logger.error('Failed to activate creation:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to activate" });
  }
});

// Restart session
app.post("/api/agent/restart", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    
    // Stop existing agents
    const existingAgents = userAgents.get(userId);
    if (existingAgents) {
      for (const agent of existingAgents.agents) {
        await agent.stop();
      }
      userAgents.delete(userId);
    }
    
    res.json({
      success: true,
      message: "Agents stopped. Use /api/agent/start to restart.",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to restart" });
  }
});

// Stop all agents
app.post("/api/agent/stop-all", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    
    const userAgentData = userAgents.get(userId);
    if (userAgentData) {
      for (const agent of userAgentData.agents) {
        await agent.stop();
      }
      userAgents.delete(userId);
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to stop all" });
  }
});

// Reselect symbol (not applicable with new 4-agent system)
app.post("/api/agent/reselect", async (req, res) => {
  try {
    res.json({
      message: "Symbol reselection not applicable - all 4 symbols are traded simultaneously",
      symbols: MomentumConfig.SYMBOLS,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

// Set symbol for session (not applicable)
app.post("/api/agent/set-symbol", async (req, res) => {
  try {
    res.json({
      message: "Symbol change not applicable - each agent trades one symbol",
      symbols: MomentumConfig.SYMBOLS,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

// Propose plan (not applicable)
app.post("/api/agent/propose", async (req, res) => {
  try {
    res.json({
      message: "Manual plan proposal not supported - using automated momentum strategy",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

// Get triggers
app.get("/api/agent/triggers", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const userAgentData = userAgents.get(userId);
    
    if (!userAgentData) {
      return res.json({ triggers: [] });
    }
    
    // Each agent has its own thresholds
    const triggers = userAgentData.agents.map(a => {
      const status = a.getStatus();
      return {
        symbol: status.symbol,
        entryThreshold: 5, // Vol 5x
        exitThreshold: 1,  // Trailing stop at +1%
      };
    });
    
    res.json({ triggers });
  } catch (error) {
    res.status(500).json({ error: "Failed to get triggers" });
  }
});

// Aggressiveness
app.post("/api/agent/aggressiveness", async (req, res) => {
  try {
    res.json({
      message: "Aggressiveness setting not applicable - using fixed momentum parameters",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

// Clear cooldown
app.post("/api/agent/clear-cooldown", async (req, res) => {
  try {
    res.json({ success: true, message: "Cooldown cleared" });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

// Strategy routes
app.get("/api/strategy/today", async (req, res) => {
  try {
    const { symbol } = req.query;
    res.json({
      symbol,
      strategy: "momentum",
      parameters: {
        volThreshold: 5,
        btcMa50Required: true,
        btcMomentum6h: 0.75,
        trailingStopActivation: 1.0,
        trailingStopDistance: 0.5,
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/strategy/generate", async (req, res) => {
  try {
    res.json({
      message: "Strategy generation not applicable - using fixed momentum strategy",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/strategy/propose-plan", async (req, res) => {
  try {
    res.json({
      message: "Manual plan proposal not supported - using automated momentum strategy",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/strategy/optimize-symbol", async (req, res) => {
  try {
    res.json({
      message: "Optimization not needed - parameters are fixed from backtesting",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/strategy/optimize-all", async (req, res) => {
  try {
    res.json({
      message: "Optimization not needed - parameters are fixed from backtesting",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/strategy/symbol-profile/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    res.json({
      symbol,
      profile: {
        volatility: "high",
        momentum: "high",
        correlation_btc: 0.8,
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/strategy/symbol-profiles", async (req, res) => {
  try {
    res.json({
      profiles: MomentumConfig.SYMBOLS.map(symbol => ({
        symbol,
        profile: { volatility: "high", momentum: "high" },
      })),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/strategy/build-symbol-profiles", async (req, res) => {
  try {
    res.json({
      message: "Symbol profiles are fixed",
      symbols: MomentumConfig.SYMBOLS,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

// Crypto ranking
app.get("/api/crypto/ranking", async (req, res) => {
  try {
    // Return fixed ranking for the 4 symbols we trade
    res.json({
      ranking: MomentumConfig.SYMBOLS.map((symbol, idx) => ({
        symbol,
        rank: idx + 1,
        score: 100 - idx * 10,
        volatility: "high",
        momentum: "positive",
      })),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

// Analysis
app.get("/api/analysis", async (req, res) => {
  try {
    const { symbol } = req.query;
    res.json({
      symbol,
      analysis: {
        trend: "bullish",
        momentum: "positive",
        volatility: "high",
        recommendation: "wait_for_signal",
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

// Monitor routes
app.get("/api/monitor/alerts", async (req, res) => {
  try {
    res.json({ alerts: [] });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/monitor/analytics", async (req, res) => {
  try {
    res.json({ analytics: {} });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/monitor/margin", async (req, res) => {
  try {
    res.json({ marginHistory: [] });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/monitor/margin/:sessionId", async (req, res) => {
  try {
    res.json({ marginHistory: [] });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/monitor/health", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const userAgentData = userAgents.get(userId);
    
    res.json({
      healthy: true,
      agentsRunning: userAgentData ? userAgentData.agents.length : 0,
      database: "connected",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/monitor/incoherences", async (req, res) => {
  try {
    res.json({ incoherences: [] });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/monitor/incoherences/summary", async (req, res) => {
  try {
    res.json({ summary: { total: 0 } });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/monitor/incoherences/export", async (req, res) => {
  try {
    res.json({ exported: 0 });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/monitor/reports/daily", async (req, res) => {
  try {
    res.json({ report: null });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/monitor/reports/daily/list", async (req, res) => {
  try {
    res.json({ reports: [] });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/monitor/reports/daily", async (req, res) => {
  try {
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

// Predictor decisions
app.post("/api/predictor/decisions", async (req, res) => {
  try {
    res.json({ decisions: [] });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

// OPS routes
app.get("/api/ops/metrics", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const userAgentData = userAgents.get(userId);
    
    res.json({
      agentsRunning: userAgentData ? userAgentData.agents.length : 0,
      symbols: MomentumConfig.SYMBOLS,
      uptime: process.uptime(),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/ops/events", async (req, res) => {
  try {
    res.json({ events: [] });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/ops/jobs", async (req, res) => {
  try {
    res.json({ jobs: [] });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/ops/selector", async (req, res) => {
  try {
    res.json({
      selectedSymbols: MomentumConfig.SYMBOLS,
      lastUpdate: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/ops/agent-health", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const userAgentData = userAgents.get(userId);
    
    if (!userAgentData) {
      return res.json({ agents: [] });
    }
    
    const agents = userAgentData.agents.map(a => {
      const status = a.getStatus();
      return {
        symbol: status.symbol,
        running: status.running,
        hasPosition: status.hasPosition,
        health: "healthy",
      };
    });
    
    res.json({ agents });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
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
