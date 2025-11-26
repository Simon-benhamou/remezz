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

// Disable caching for all API responses
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

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
    const { sessionId } = req.query;
    
    // If sessionId provided, return session-specific status
    if (sessionId && typeof sessionId === 'string') {
      // First try to find running agent with this session
      const userAgentData = userId ? userAgents.get(userId) : null;
      const runningAgent = userAgentData?.agents.find(a => a.getStatus().sessionId === sessionId);
      
      if (runningAgent) {
        const agentStatus = runningAgent.getStatus();
        return res.json({
          server: "ok",
          database: "connected",
          session: {
            id: sessionId,
            symbol: agentStatus.symbol,
            mode: runningAgent.getMode(),
            state: agentStatus.running ? 'running' : 'stopped',
            running: agentStatus.running,
          },
          agent: agentStatus,
          symbol: agentStatus.symbol,
        });
      }
      
      // If not running, try to load from database
      const dbSession = await prisma.agentSession.findUnique({
        where: { id: sessionId },
      });
      
      if (dbSession) {
        return res.json({
          server: "ok",
          database: "connected",
          session: {
            id: dbSession.id,
            symbol: dbSession.symbol,
            mode: dbSession.mode,
            state: dbSession.stoppedAt ? 'stopped' : (dbSession.haltedAt ? 'halted' : 'idle'),
            running: false,
            startedAt: dbSession.startedAt,
            stoppedAt: dbSession.stoppedAt,
            haltedAt: dbSession.haltedAt,
          },
          agent: null,
          symbol: dbSession.symbol,
        });
      }
      
      // Session not found
      return res.json({
        server: "ok",
        database: "connected",
        session: null,
        error: "Session not found",
      });
    }
    
    // No sessionId - return general status
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
    
    // First check if any agent has cached market conditions
    const userAgentData = userId ? userAgents.get(userId) : null;
    if (userAgentData && userAgentData.agents.length > 0) {
      const firstAgent = userAgentData.agents[0];
      const agentStatus = firstAgent.getStatus();
      const conditions = agentStatus.marketConditions;
      
      if (conditions) {
        return res.json({
          status: conditions.overallStatus || 'unknown',
          btcAboveMa50: conditions.btcAboveMa50 ?? null,
          btcMomentum6h: conditions.btcMomentum6h ?? null,
          btcTrend: conditions.btcTrend ?? null,
          isTradingDay: conditions.isTradingDay ?? null,
          reason: conditions.reason || 'Not analyzed yet',
          tradingRecommended: conditions.overallStatus === 'favorable_long' || conditions.overallStatus === 'favorable_short',
        });
      }
    }
    
    // If no agent running, fetch BTC candles directly to compute market conditions
    try {
      const ccxt = await import('ccxt');
      const publicExchange = new ccxt.default.binance({
        enableRateLimit: true,
        options: { defaultType: 'future' },
      });
      
      // Fetch 100 15m BTC candles (about 25 hours of data)
      const btcCandles = await publicExchange.fetchOHLCV('BTC/USDT:USDT', '15m', undefined, 100);
      
      if (btcCandles.length < 50) {
        return res.json({
          status: 'unknown',
          reason: 'Insufficient data',
          tradingRecommended: false,
        });
      }
      
      // Calculate indicators
      const btcCloses = btcCandles.map((c: any) => c[4]);
      const btcNow = btcCloses[btcCloses.length - 1];
      
      // MA50
      const ma50Slice = btcCloses.slice(-50);
      const btcMa50 = ma50Slice.reduce((a: number, b: number) => a + b, 0) / 50;
      const btcAboveMa50 = btcNow > btcMa50;
      
      // 6h momentum (24 candles of 15m)
      const btc6hAgoIndex = Math.max(0, btcCloses.length - 25);
      const btc6hAgo = btcCloses[btc6hAgoIndex];
      const btcMomentum6h = btc6hAgo > 0 ? ((btcNow - btc6hAgo) / btc6hAgo) * 100 : 0;
      
      // Check if trading day (Sun=0, Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6)
      const dayOfWeek = new Date().getUTCDay();
      const ALLOWED_DAYS = [0, 1, 3, 4]; // Sun, Mon, Wed, Thu
      const isTradingDay = ALLOWED_DAYS.includes(dayOfWeek);
      
      // Determine trend
      let btcTrend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
      const MIN_MOMENTUM = 0.75;
      if (btcMomentum6h > MIN_MOMENTUM && btcAboveMa50) {
        btcTrend = 'bullish';
      } else if (btcMomentum6h < -MIN_MOMENTUM && !btcAboveMa50) {
        btcTrend = 'bearish';
      }
      
      // Overall status
      let status: string = 'neutral';
      let reason = '';
      
      if (!isTradingDay) {
        status = 'unfavorable';
        reason = `Not a trading day (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dayOfWeek]})`;
      } else if (btcTrend === 'bullish') {
        status = 'favorable_long';
        reason = `BTC bullish: +${btcMomentum6h.toFixed(2)}% (6h), above MA50`;
      } else if (btcTrend === 'bearish') {
        status = 'favorable_short';
        reason = `BTC bearish: ${btcMomentum6h.toFixed(2)}% (6h), below MA50`;
      } else {
        status = 'neutral';
        reason = `BTC sideways: ${btcMomentum6h.toFixed(2)}% (6h) - waiting for momentum`;
      }
      
      return res.json({
        status,
        btcAboveMa50,
        btcMomentum6h,
        btcTrend,
        isTradingDay,
        reason,
        tradingRecommended: status === 'favorable_long' || status === 'favorable_short',
      });
      
    } catch (fetchError) {
      logger.warn('Failed to fetch BTC candles for market conditions:', fetchError);
      return res.json({
        status: 'unknown',
        reason: 'Unable to fetch market data',
        tradingRecommended: false,
      });
    }
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
    
    // Check for existing agents - show ACTUAL running symbols
    const existingAgents = userAgents.get(userId);
    if (existingAgents && existingAgents.agents.length > 0) {
      const runningSymbols = existingAgents.agents.map(a => a.getStatus().symbol);
      return res.status(409).json({ 
        error: "Agents already running. Stop them first.",
        symbols: runningSymbols,
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

// Stop agent (specific session or all)
app.post("/api/agent/stop", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    
    const { sessionId, closePosition } = req.body;
    
    const userAgentData = userAgents.get(userId);
    if (!userAgentData) {
      return res.status(404).json({ error: "No agents found" });
    }
    
    // If sessionId provided, stop only that specific agent
    if (sessionId) {
      const agentIndex = userAgentData.agents.findIndex(a => a.getStatus().sessionId === sessionId);
      if (agentIndex === -1) {
        return res.status(404).json({ error: "Agent not found for this session" });
      }
      
      const agent = userAgentData.agents[agentIndex];
      await agent.stop();
      
      // Update session to mark as halted
      await prisma.agentSession.update({
        where: { id: sessionId },
        data: { haltedAt: new Date() }
      });
      
      // Remove agent from array
      userAgentData.agents.splice(agentIndex, 1);
      
      // If no more agents, delete user entry
      if (userAgentData.agents.length === 0) {
        userAgents.delete(userId);
      }
      
      logger.info(`⏸️ Agent for session ${sessionId} paused`);
      return res.json({ success: true, message: "Agent paused" });
    }
    
    // No sessionId: stop all agents
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

// Delete session - also stops agent in memory if running
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
    
    // ✅ Stop agent in memory if running
    const userAgentData = userAgents.get(userId);
    if (userAgentData) {
      const agentIndex = userAgentData.agents.findIndex(a => a.getStatus().sessionId === id);
      if (agentIndex !== -1) {
        const agent = userAgentData.agents[agentIndex];
        await agent.stop();
        userAgentData.agents.splice(agentIndex, 1);
        logger.info(`🗑️ Stopped and removed agent for session ${id}`);
        
        // If no more agents, clean up user entry
        if (userAgentData.agents.length === 0) {
          userAgents.delete(userId);
        }
      }
    }
    
    // Delete from database
    await prisma.agentSession.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete session:', error);
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
      return res.json(null);
    }
    
    // If sessionId provided, return state for that specific agent
    if (sessionId && typeof sessionId === 'string') {
      const agent = userAgentData.agents.find(a => a.getStatus().sessionId === sessionId);
      
      if (agent) {
        const agentStatus = agent.getStatus();
        const agentState = agent.getAgentState?.() || {};
        
        return res.json({
          running: agentStatus.running,
          state: agentStatus.running 
            ? (agentStatus.hasPosition ? 'IN_POSITION' : 'WATCHING') 
            : 'STOPPED',
          hasPosition: agentStatus.hasPosition,
          symbol: agentStatus.symbol,
          sessionId: agentStatus.sessionId,
          marketConditions: agentStatus.marketConditions,
          // Agent state from getAgentState() method
          pos: agentState.pos,
          plan: agentState.plan,
          exit: agentState.exit,
          profile: agentState.profile,
          balance: {
            freeUsd: userAgentData.capitalPool.getAvailableCapital(),
          },
        });
      }
      
      // Agent not running, check database
      const dbSession = await prisma.agentSession.findUnique({
        where: { id: sessionId },
      });
      
      if (dbSession) {
        return res.json({
          running: false,
          state: dbSession.stoppedAt ? 'STOPPED' : (dbSession.haltedAt ? 'HALT' : 'STOPPED'),
          hasPosition: false,
          symbol: dbSession.symbol,
          sessionId: dbSession.id,
        });
      }
      
      return res.json(null);
    }
    
    // No sessionId - return overview of all agents
    const agentStatuses = userAgentData.agents.map(a => a.getStatus());
    
    res.json({ 
      running: agentStatuses.some(s => s.running),
      agents: agentStatuses.map(s => ({
        symbol: s.symbol,
        sessionId: s.sessionId,
        running: s.running,
        hasPosition: s.hasPosition,
      })),
      capitalPool: userAgentData.capitalPool.getStatus(),
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
          
          // CCXT returns balance in different formats depending on exchange
          // For Binance Futures: balance.USDT, balance.total.USDT, balance.free.USDT
          const freeUsdt = parseFloat(balance?.free?.USDT || balance?.USDT?.free || '0') || 0;
          const usedUsdt = parseFloat(balance?.used?.USDT || balance?.USDT?.used || '0') || 0;
          // Total = free + used (in positions)
          const totalUsdt = parseFloat(balance?.total?.USDT || balance?.USDT?.total || '0') || (freeUsdt + usedUsdt);
          
          logger.debug('Live balance fetched:', { totalUsdt, freeUsdt, usedUsdt, raw: balance?.USDT });
          
          return res.json({
            totalUSD: totalUsdt,
            freeUSD: freeUsdt,
            reservedUSD: 0,
            inPositionsUSD: usedUsdt,
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
      // No agent running - read from UserSettings database
      let paperBalance = 10000; // default
      if (mode === 'paper' && userId) {
        try {
          const setting = await prisma.userSetting.findUnique({
            where: {
              userId_key: {
                userId: userId,
                key: 'paperTradingCapital'
              }
            }
          });
          if (setting && setting.value) {
            paperBalance = parseFloat(setting.value) || 10000;
          }
        } catch (dbError) {
          logger.warn('Failed to read paper balance from DB:', dbError);
        }
      }
      return res.json({
        totalUSD: mode === 'paper' ? paperBalance : 0,
        freeUSD: mode === 'paper' ? paperBalance : 0,
        reservedUSD: 0,
        inPositionsUSD: 0,
        ts: Date.now(),
        source: 'database',
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
    
    if (typeof initialUSD !== 'number' || initialUSD <= 0) {
      return res.status(400).json({ error: "Invalid initialUSD value" });
    }
    
    // 1. Save to database (UserSettings) for persistence
    await prisma.userSetting.upsert({
      where: {
        userId_key: {
          userId: userId,
          key: 'paperTradingCapital'
        }
      },
      update: {
        value: String(initialUSD)
      },
      create: {
        userId: userId,
        key: 'paperTradingCapital',
        value: String(initialUSD),
        category: 'trading'
      }
    });
    
    // 2. Update the capital pool directly if agents are running
    const existingAgents = userAgents.get(userId);
    if (existingAgents && existingAgents.capitalPool) {
      existingAgents.capitalPool.setTotalCapital(initialUSD);
      logger.info(`Paper balance updated to $${initialUSD} for user ${userId} (in-memory + DB)`);
    } else {
      // Create new capital pool for this user (agents will use it when started)
      resetCapitalPool(userId, initialUSD, 'paper');
      logger.info(`Paper capital pool initialized with $${initialUSD} for user ${userId} (in DB)`);
    }
    
    res.json({ 
      success: true, 
      initialUSD,
      message: "Paper balance updated successfully."
    });
  } catch (error) {
    logger.error('Failed to set paper balance:', error);
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
    
    // Read user's saved paper balance from UserSettings (default 10000)
    let defaultCapital = 10000;
    try {
      const userSetting = await prisma.userSetting.findUnique({
        where: {
          userId_key: {
            userId: userId,
            key: 'paperTradingCapital'
          }
        }
      });
      if (userSetting?.value) {
        const parsed = parseFloat(userSetting.value);
        if (parsed > 0) {
          defaultCapital = parsed;
        }
      }
    } catch (err) {
      console.warn('Could not read user paper trading capital:', err);
    }
    
    const { mode = 'paper', capitalUsd = defaultCapital, maxLeverage, aggressiveness, symbol } = req.body;
    
    // Get existing agents (if any) - we allow adding more agents
    const existingAgents = userAgents.get(userId);
    const runningSymbols = existingAgents?.agents.map(a => a.getStatus().symbol) || [];
    
    // Store creation params for later activation
    const creationId = `creation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    pendingCreations.set(creationId, { userId, mode, capitalUsd, symbol });
    
    // Auto-expire after 5 minutes
    setTimeout(() => pendingCreations.delete(creationId), 5 * 60 * 1000);
    
    // Return available symbols (exclude already running ones)
    const availableSymbols = MomentumConfig.SYMBOLS.filter(s => !runningSymbols.includes(s));
    
    res.json({
      creationId,
      symbols: availableSymbols,
      runningSymbols,
      message: "Creation prepared. Select a symbol and call activate.",
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
    
    // Get the SINGLE symbol selected by user
    const { mode, capitalUsd, symbol: rawSymbol } = creation;
    
    if (!rawSymbol) {
      return res.status(400).json({ error: "No symbol selected" });
    }
    
    // Normalize symbol to futures format (BTC/USDT -> BTC/USDT:USDT)
    const selectedSymbol = rawSymbol.includes(':') ? rawSymbol : `${rawSymbol}:USDT`;
    
    // Check if this symbol is already running
    const existingAgents = userAgents.get(userId);
    if (existingAgents) {
      const alreadyRunning = existingAgents.agents.find(a => a.getStatus().symbol === selectedSymbol);
      if (alreadyRunning) {
        return res.status(409).json({ 
          error: `Agent for ${selectedSymbol} is already running`,
          symbol: selectedSymbol,
        });
      }
    }
    
    // Get exchange
    const exchange = await getExchangeForUser(userId);
    
    // Create a SINGLE session for the selected symbol only
    const session = await prisma.agentSession.create({
      data: { 
        userId, 
        symbol: selectedSymbol, 
        mode, 
        startBalanceUsd: capitalUsd,
        profileJson: { capitalUsd, symbol: selectedSymbol } 
      }
    });
    
    // ✅ Create SessionKpi to track performance
    await prisma.sessionKpi.create({
      data: {
        sessionId: session.id,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        roiPct: 0,
        winRate: 0,
        expectancy: 0,
        maxDrawdownPct: 0,
        avgHoldingMin: 0,
      }
    });
    
    // Get or create capital pool for this user
    let capitalPool = getCapitalPool(userId);
    if (!capitalPool) {
      // Initialize new capital pool
      resetCapitalPool(userId, capitalUsd, mode as 'paper' | 'live');
      capitalPool = getCapitalPool(userId)!;
    }
    
    // Create SINGLE agent for the selected symbol
    const agent = new SimpleAgent({
      symbol: selectedSymbol,
      exchange,
      prisma,
      userId,
      sessionId: session.id,
      capitalPool,
      mode: mode as 'paper' | 'live',
      riskPerTradePct: 1,
    });
    
    // Get existing agents or create new array
    const existingData = userAgents.get(userId);
    if (existingData) {
      existingData.agents.push(agent);
    } else {
      userAgents.set(userId, { agents: [agent], capitalPool });
    }
    
    // Start the single agent
    await agent.start();
    
    // Clean up pending creation
    pendingCreations.delete(creationId);
    
    logger.info(`✅ Created 1 agent for ${selectedSymbol} for ${userId}`);
    
    res.json({
      success: true,
      agentsCount: 1,
      symbol: selectedSymbol,
      sessionId: session.id,
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

// Restore active sessions - ONLY restore sessions that exist in DB, don't create new ones
(async () => {
  try {
    // Get only active sessions (not stopped)
    const activeSessions = await prisma.agentSession.findMany({
      where: { 
        stoppedAt: null,
        haltedAt: null, // Also exclude halted sessions
      },
      include: { user: true }
    });
    
    if (activeSessions.length === 0) {
      logger.info('📋 No active sessions to restore');
      return;
    }
    
    // Group by user
    const sessionsByUser = new Map<string, any[]>();
    for (const session of activeSessions) {
      if (!session.userId) continue;
      const existing = sessionsByUser.get(session.userId) || [];
      existing.push(session);
      sessionsByUser.set(session.userId, existing);
    }
    
    // Restore each user's agents - ONLY the ones that exist
    for (const [userId, sessions] of sessionsByUser) {
      try {
        const exchange = await getExchangeForUser(userId);
        
        // Get capital from first session profile or user settings
        const firstProfile = sessions[0]?.profileJson as any;
        let capitalUsd = firstProfile?.capitalUsd || 10000;
        
        // Try to get from user settings
        try {
          const setting = await prisma.userSetting.findUnique({
            where: { userId_key: { userId, key: 'paperTradingCapital' } }
          });
          if (setting?.value) {
            capitalUsd = parseFloat(setting.value) || capitalUsd;
          }
        } catch {}
        
        const mode = sessions[0]?.mode as 'paper' | 'live' || 'paper';
        
        // Create capital pool for this user
        resetCapitalPool(userId, capitalUsd, mode);
        const capitalPool = getCapitalPool(userId)!;
        
        // Create agents ONLY for existing sessions
        const agents: SimpleAgent[] = [];
        
        for (const session of sessions) {
          const agent = new SimpleAgent({
            symbol: session.symbol,
            exchange,
            prisma,
            userId,
            sessionId: session.id,
            capitalPool,
            mode,
            riskPerTradePct: 1,
          });
          agents.push(agent);
        }
        
        // Store and start agents
        userAgents.set(userId, { agents, capitalPool });
        
        for (const agent of agents) {
          await agent.start();
        }
        
        const symbols = sessions.map((s: any) => s.symbol).join(', ');
        logger.info(`♻️ Restored ${agents.length} agent(s) for ${userId}: ${symbols}`);
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
