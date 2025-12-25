/**
 * SIMPLIFIED TRADING SERVER
 * Momentum strategy only - Vol 5x + BTC MA50 + 2h momentum
 */
import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { WebSocketServer, WebSocket } from "ws";
import { configureLogging, createLogger, getRecentLogs } from "./utils/logger.js";
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
import { router as backtestRouter } from "./routes/backtest.js";

// Services
import { getBinanceWebSocket, seedBalanceCache, seedPositionCache, markPositionCacheSeeded } from "./services/binanceWebSocket.js";
import { initNotificationService } from "./services/notificationService.js";

// Strategy
import { 
  SimpleAgent, 
  createAllAgents, 
  getCapitalPool,
  resetCapitalPool,
  type CapitalPool 
} from "./strategies/simpleAgent.js";
import { getMarketConditions, MomentumConfig, LIQUIDITY_CONFIG, LIQUIDATION_CONFIG, getLiquidityTier, getMaxSafePositionSize } from "./strategies/momentumSimple.js";

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
app.use("/api/backtest", backtestRouter);

// ============================================
// AGENT MANAGEMENT
// ============================================

// Store agents per user+mode (allows Paper + Live simultaneously)
// Key format: "userId_paper" or "userId_live"
const userAgents = new Map<string, { agents: SimpleAgent[]; capitalPool: CapitalPool; mode: 'paper' | 'live' }>();

// Helper to get agent key
function getAgentKey(userId: string, mode: 'paper' | 'live'): string {
  return `${userId}_${mode}`;
}

// Helper to get all agent data for a user (both paper and live)
function getAllUserAgents(userId: string): { paper?: { agents: SimpleAgent[]; capitalPool: CapitalPool }; live?: { agents: SimpleAgent[]; capitalPool: CapitalPool } } {
  const paper = userAgents.get(getAgentKey(userId, 'paper'));
  const live = userAgents.get(getAgentKey(userId, 'live'));
  return {
    paper: paper ? { agents: paper.agents, capitalPool: paper.capitalPool } : undefined,
    live: live ? { agents: live.agents, capitalPool: live.capitalPool } : undefined,
  };
}

// Helper to find an agent by sessionId across both modes
function findAgentBySessionId(userId: string, sessionId: string): { agent: SimpleAgent; mode: 'paper' | 'live' } | null {
  const allAgents = getAllUserAgents(userId);
  
  // Check paper agents
  if (allAgents.paper) {
    const agent = allAgents.paper.agents.find(a => a.getStatus().sessionId === sessionId);
    if (agent) return { agent, mode: 'paper' };
  }
  
  // Check live agents
  if (allAgents.live) {
    const agent = allAgents.live.agents.find(a => a.getStatus().sessionId === sessionId);
    if (agent) return { agent, mode: 'live' };
  }
  
  return null;
}

// Helper to get all running agents for a user (combined paper + live)
function getAllRunningAgents(userId: string): SimpleAgent[] {
  const allAgents = getAllUserAgents(userId);
  const agents: SimpleAgent[] = [];
  if (allAgents.paper) agents.push(...allAgents.paper.agents);
  if (allAgents.live) agents.push(...allAgents.live.agents);
  return agents;
}

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
      // First try to find running agent with this session (checks both paper + live)
      const found = userId ? findAgentBySessionId(userId, sessionId) : null;
      
      if (found) {
        const agentStatus = found.agent.getStatus();
        const state = agentStatus.running 
          ? (agentStatus.hasPosition ? 'IN_POSITION' : 'WATCHING') 
          : 'STOPPED';
        return res.json({
          server: "ok",
          database: "connected",
          session: {
            id: sessionId,
            symbol: agentStatus.symbol,
            mode: found.mode,
            state: state,
            running: agentStatus.running,
            hasPosition: agentStatus.hasPosition,
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
    
    // No sessionId - return general status (combines both paper + live)
    const allAgentData = userId ? getAllUserAgents(userId) : null;
    const allAgents = userId ? getAllRunningAgents(userId) : [];
    
    if (!allAgentData || allAgents.length === 0) {
      return res.json({
        server: "ok",
        database: "connected",
        agent: null,
        paper: allAgentData?.paper ? { running: true, count: allAgentData.paper.agents.length } : null,
        live: allAgentData?.live ? { running: true, count: allAgentData.live.agents.length } : null,
      });
    }
    
    const positions = allAgents.map(a => a.getStatus());
    
    res.json({
      server: "ok",
      database: "connected",
      agent: {
        running: allAgents.some(a => a.getStatus().running),
        symbols: MomentumConfig.SYMBOLS,
        positions: positions.filter(p => p.hasPosition).map(p => p.symbol),
      },
      paper: allAgentData.paper ? {
        running: true,
        count: allAgentData.paper.agents.length,
        capitalPool: allAgentData.paper.capitalPool.getStatus(),
      } : null,
      live: allAgentData.live ? {
        running: true,
        count: allAgentData.live.agents.length,
        capitalPool: allAgentData.live.capitalPool.getStatus(),
      } : null,
    });
  } catch (error) {
    res.status(500).json({ error: "Status check failed" });
  }
});

// Market Conditions endpoint - shows if trading conditions are favorable
app.get("/api/market-conditions", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    
    // First check if any agent has cached market conditions (check both paper + live)
    const allAgents = userId ? getAllRunningAgents(userId) : [];
    if (allAgents.length > 0) {
      const firstAgent = allAgents[0];
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
          // V5.5: Market quality
          marketQuality: conditions.marketQuality ?? 'unknown',
          qualityReason: conditions.qualityReason ?? null,
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
      const ALLOWED_DAYS = [0, 1, 2, 3, 4, 5, 6]; // All days
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
        // V5.5: No market quality without agent (need altcoin data)
        marketQuality: 'unknown',
        qualityReason: 'No agent running - cannot assess altcoin momentum',
      });
      
    } catch (fetchError) {
      logger.warn('Failed to fetch BTC candles for market conditions:', fetchError);
      return res.json({
        status: 'unknown',
        reason: 'Unable to fetch market data',
        tradingRecommended: false,
        marketQuality: 'unknown',
        qualityReason: null,
      });
    }
  } catch (error) {
    logger.error("Failed to get market conditions", error);
    res.status(500).json({ error: "Failed to get market conditions" });
  }
});

// V5.5: Liquidity-aware position sizing info
app.get("/api/liquidity-info", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const capital = parseFloat(req.query.capital as string) || 10000;
    
    // Import getTicker for volume info
    const { getTicker } = await import('./data/market.js');
    
    const symbols = Object.keys(MomentumConfig.LEVERAGE);
    const results = await Promise.all(
      symbols.map(async (symbol) => {
        const tier = getLiquidityTier(symbol);
        const tierConfig = LIQUIDITY_CONFIG.POSITION_CAPS[tier];
        
        // Get 24h volume
        let volume24h = 0;
        try {
          const ticker = await getTicker(symbol, { userId });
          volume24h = ticker?.quoteVolume || 0;
        } catch {}
        
        const maxSafe = getMaxSafePositionSize(symbol, volume24h);
        const targetPosition = capital * MomentumConfig.RISK.POSITION_SIZE_PCT;
        const wouldBeCapped = targetPosition > maxSafe;
        const effectivePosition = Math.min(targetPosition, maxSafe);
        
        return {
          symbol: symbol.replace('/USDT:USDT', ''),
          tier,
          volume24h,
          volume24hFormatted: volume24h >= 1_000_000_000 
            ? `$${(volume24h / 1_000_000_000).toFixed(1)}B`
            : `$${(volume24h / 1_000_000).toFixed(1)}M`,
          maxSafePosition: maxSafe,
          targetPosition,
          effectivePosition,
          wouldBeCapped,
          cappedReason: wouldBeCapped 
            ? `Limited to ${tier === 'HIGH' ? '$500K' : tier === 'MEDIUM' ? '$100K' : '$25K'} (${tier} liquidity tier)` 
            : null,
        };
      })
    );
    
    // Calculate total deployment capacity
    const totalMaxDeployable = results.reduce((sum, r) => sum + r.maxSafePosition, 0);
    
    res.json({
      capitalUsd: capital,
      positionPct: MomentumConfig.RISK.POSITION_SIZE_PCT * 100,
      maxVolumeImpactPct: LIQUIDITY_CONFIG.MAX_POSITION_PCT_OF_VOLUME,
      symbols: results,
      totalMaxDeployable,
      warning: capital > totalMaxDeployable 
        ? `Your capital ($${capital.toLocaleString()}) exceeds safe deployment capacity ($${totalMaxDeployable.toLocaleString()}). Consider using fewer symbols or accepting slippage.`
        : null,
      // V5.6: Liquidation protection config
      leverageProtection: {
        enabled: LIQUIDATION_CONFIG.DYNAMIC_LEVERAGE,
        baseLeverage: 5,
        reducedLeverage: LIQUIDATION_CONFIG.REDUCED_LEVERAGE,
        atrThreshold: LIQUIDATION_CONFIG.HIGH_VOLATILITY_ATR_PCT,
        atrPeriod: LIQUIDATION_CONFIG.ATR_PERIOD,
        description: `Leverage is automatically reduced from 5x to ${LIQUIDATION_CONFIG.REDUCED_LEVERAGE}x when ATR > ${LIQUIDATION_CONFIG.HIGH_VOLATILITY_ATR_PCT}% (high volatility periods)`,
      },
    });
  } catch (error) {
    logger.error("Failed to get liquidity info", error);
    res.status(500).json({ error: "Failed to get liquidity info" });
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
    const agentKey = getAgentKey(userId, mode as 'paper' | 'live');
    
    // Check for existing agents FOR THIS MODE ONLY - allows Paper + Live simultaneously
    const existingAgents = userAgents.get(agentKey);
    if (existingAgents && existingAgents.agents.length > 0) {
      const runningSymbols = existingAgents.agents.map(a => a.getStatus().symbol);
      return res.status(409).json({ 
        error: `${mode.toUpperCase()} agents already running. Stop them first.`,
        mode,
        symbols: runningSymbols,
      });
    }
    
    // Get exchange first (needed for balance fetch in live mode)
    const exchange = await getExchangeForUser(userId);
    
    // 🔧 FIX: Calculate actual starting capital based on mode
    let actualCapital = capitalUsd;
    
    if (mode === 'live') {
      // 🔴 LIVE MODE: ALWAYS use real Binance balance, ignore capitalUsd parameter
      try {
        // Ensure markets are loaded for the exchange (critical for setLeverage later)
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
          logger.info('[Live] Loading markets for exchange...');
          await exchange.loadMarkets();
          logger.info(`[Live] Markets loaded: ${Object.keys(exchange.markets).length} markets`);
        }
        
        const balance = await exchange.fetchBalance({ type: 'future' });
        const totalUsdt = parseFloat(balance?.total?.USDT || balance?.USDT?.total || '0') || 0;
        const freeUsdt = parseFloat(balance?.free?.USDT || balance?.USDT?.free || '0') || 0;
        const lockedUsdt = totalUsdt - freeUsdt;
        
        if (totalUsdt > 0) {
          actualCapital = totalUsdt;
          // 🔧 FIX: Seed the WebSocket balance cache so syncWithExchange() works
          seedBalanceCache(userId, 'USDT', { total: totalUsdt, free: freeUsdt, locked: lockedUsdt });
          logger.info(`✅ [Live] Using REAL Binance balance: $${actualCapital.toFixed(2)} (ignoring request capitalUsd: $${capitalUsd})`);
          
          // 🔧 FIX: Subscribe to user data stream for real-time balance/position updates (0 weight)
          try {
            const credentials = await getUserCredentials(userId);
            if (credentials && credentials.apiKey && credentials.apiSecret) {
              const binanceWs = getBinanceWebSocket();
              await binanceWs.subscribeToUserData(userId, credentials.apiKey, credentials.apiSecret);
              logger.info(`✅ [Live] User data stream subscribed for ${userId} - will receive real-time balance/position updates`);
            }
          } catch (wsErr: any) {
            // Non-fatal: REST fallback will work, but log the issue
            logger.warn(`⚠️ [Live] Failed to subscribe to user data stream:`, wsErr?.message);
          }
          
          // 🔧 FIX: Fetch ALL positions ONCE at startup and seed cache
          // This prevents each agent from making individual REST calls (12 agents = 12 calls = rate limit!)
          try {
            if (exchange.fetchPositions) {
              const allPositions = await exchange.fetchPositions(MomentumConfig.SYMBOLS);
              let positionsSeeded = 0;
              for (const pos of allPositions) {
                const symbol = pos.symbol;
                const positionAmt = parseFloat(pos?.info?.positionAmt || '0');
                if (positionAmt !== 0) {
                  seedPositionCache(userId, symbol, {
                    positionAmt,
                    entryPrice: parseFloat(pos?.entryPrice || pos?.info?.entryPrice || '0'),
                    unrealizedPnl: parseFloat(pos?.unrealizedPnl || pos?.info?.unRealizedProfit || '0'),
                    side: positionAmt > 0 ? 'long' : 'short',
                    updateTime: Date.now(),
                  });
                  positionsSeeded++;
                  logger.info(`✅ [Live] Seeded position cache: ${symbol} ${positionAmt > 0 ? 'LONG' : 'SHORT'} ${Math.abs(positionAmt)}`);
                }
              }
              // Mark cache as seeded even if no positions - prevents REST fallback
              markPositionCacheSeeded(userId);
              logger.info(`✅ [Live] Position cache seeded: ${positionsSeeded} active positions (${allPositions.length} symbols checked)`);
            }
          } catch (posErr: any) {
            logger.warn(`⚠️ [Live] Failed to seed position cache:`, posErr?.message);
          }
        } else {
          // If balance fetch returned 0, refuse to start - this prevents trading with wrong capital
          logger.error(`❌ [Live] Binance balance is $0 or fetch failed. Cannot start live trading.`);
          return res.status(400).json({ 
            error: 'Cannot fetch Binance balance. Please check your API keys and try again.',
            detail: 'Live mode requires real balance from Binance to prevent over-sizing positions.'
          });
        }
      } catch (err: any) {
        logger.error('[Live] Failed to fetch Binance balance:', err?.message || err);
        return res.status(500).json({ 
          error: 'Failed to fetch Binance balance. Check API keys.',
          detail: err?.message || 'Unknown error'
        });
      }
    } else {
      // 🟢 PAPER MODE: Use capitalUsd + accumulated PnL from past sessions
      try {
        const pastKpis = await prisma.sessionKpi.findMany({
          where: {
            session: {
              userId,
              mode: 'paper',
            }
          },
          select: {
            realizedPnlUsd: true,
          }
        });
        const accumulatedPnl = pastKpis.reduce((sum, kpi) => sum + (kpi.realizedPnlUsd || 0), 0);
        actualCapital = capitalUsd + accumulatedPnl;
        logger.info(`[Paper] Capital: $${capitalUsd} (initial) + $${accumulatedPnl.toFixed(2)} (accumulated PnL) = $${actualCapital.toFixed(2)}`);
      } catch (err) {
        logger.warn('[Paper] Failed to fetch accumulated PnL:', err);
        actualCapital = capitalUsd;
      }
    }
    
    logger.info(`[Capital] Starting agents with $${actualCapital.toFixed(2)} (mode: ${mode})`);
    logger.info(`[Capital] Mode: ${mode}, User: ${userId}`);
    
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
          profileJson: { capitalUsd: actualCapital, symbol },
        }
      });
      const key = symbolToKey[symbol];
      if (key) sessionIds[key] = session.id;
    }
    
    // Create all agents with shared capital pool (using actual capital with PnL)
    const { agents, capitalPool } = await createAllAgents({
      exchange,
      prisma,
      userId,
      sessionIds,
      totalCapitalUsd: actualCapital,
      mode: mode as 'paper' | 'live',
    });
    
    // Store and start all agents (keyed by userId_mode)
    userAgents.set(agentKey, { agents, capitalPool, mode: mode as 'paper' | 'live' });
    
    for (const agent of agents) {
      // Configure tick broadcast callback
      agent.setOnTick((tick) => {
        broadcast('tick', {
          sessionId: agent.getStatus().sessionId,
          symbol: tick.symbol,
          price: tick.price,
          hasPosition: tick.hasPosition,
          positionSide: tick.positionSide,
          support: tick.support,
          resistance: tick.resistance,
          tickCount: tick.tickCount,
          timestamp: tick.timestamp.toISOString(),
        }, tick.symbol);
      });
      await agent.start();
    }
    
    logger.info(`✅ Started ${agents.length} agents for ${userId} with $${actualCapital.toFixed(2)} capital (${mode})`);
    res.status(201).json({ 
      success: true, 
      agentsCount: agents.length,
      symbols: MomentumConfig.SYMBOLS,
      capitalUsd: actualCapital,
      initialCapitalUsd: capitalUsd,
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
    
    const { sessionId, closePosition, mode } = req.body;
    
    // If sessionId provided, stop only that specific agent
    if (sessionId) {
      const found = findAgentBySessionId(userId, sessionId);
      if (!found) {
        return res.status(404).json({ error: "Agent not found for this session" });
      }
      
      const agentKey = getAgentKey(userId, found.mode);
      const agentData = userAgents.get(agentKey);
      if (!agentData) {
        return res.status(404).json({ error: "Agent data not found" });
      }
      
      const agentIndex = agentData.agents.findIndex(a => a.getStatus().sessionId === sessionId);
      const agent = agentData.agents[agentIndex];
      await agent.stop();
      
      // Update session to mark as halted
      await prisma.agentSession.update({
        where: { id: sessionId },
        data: { haltedAt: new Date() }
      });
      
      // Remove agent from array
      agentData.agents.splice(agentIndex, 1);
      
      // If no more agents for this mode, delete entry
      if (agentData.agents.length === 0) {
        userAgents.delete(agentKey);
      }
      
      logger.info(`⏸️ Agent for session ${sessionId} paused (${found.mode})`);
      return res.json({ success: true, message: "Agent paused", mode: found.mode });
    }
    
    // No sessionId: stop all agents for specified mode (or all if no mode)
    const modesToStop: ('paper' | 'live')[] = mode ? [mode as 'paper' | 'live'] : ['paper', 'live'];
    let stoppedCount = 0;
    
    for (const m of modesToStop) {
      const agentKey = getAgentKey(userId, m);
      const agentData = userAgents.get(agentKey);
      if (agentData) {
        for (const agent of agentData.agents) {
          await agent.stop();
          stoppedCount++;
        }
        userAgents.delete(agentKey);
      }
    }
    
    logger.info(`🛑 Stopped ${stoppedCount} agents for ${userId} (modes: ${modesToStop.join(', ')})`);
    res.json({ success: true, stoppedCount, modes: modesToStop });
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
    
    const allAgentData = getAllUserAgents(userId);
    const paperData = allAgentData.paper;
    const liveData = allAgentData.live;
    
    // Build response with both paper and live status
    const paperStatus = paperData ? {
      running: paperData.agents.some(a => a.getStatus().running),
      agents: paperData.agents.map(a => a.getStatus()),
      capitalPool: paperData.capitalPool.getStatus(),
    } : null;
    
    const liveStatus = liveData ? {
      running: liveData.agents.some(a => a.getStatus().running),
      agents: liveData.agents.map(a => a.getStatus()),
      capitalPool: liveData.capitalPool.getStatus(),
    } : null;
    
    const allAgents = getAllRunningAgents(userId);
    const allStatuses = allAgents.map(a => a.getStatus());
    
    res.json({
      running: allStatuses.some(s => s.running),
      symbols: MomentumConfig.SYMBOLS,
      positions: allStatuses.filter(s => s.hasPosition).map(s => ({
        symbol: s.symbol,
        hasPosition: s.hasPosition,
        mode: allAgentData.paper?.agents.some(a => a.getStatus().sessionId === s.sessionId) ? 'paper' : 'live',
      })),
      paper: paperStatus,
      live: liveStatus,
      marketConditions: allStatuses[0]?.marketConditions || null,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Get agent activity logs for Feed page
app.get("/api/agent/logs", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    
    const mode = req.query.mode as 'paper' | 'live' | undefined;
    const limit = Math.min(parseInt(String(req.query.limit || '100')), 500);
    const symbol = req.query.symbol as string | undefined;
    const source = req.query.source as 'memory' | 'db' | 'all' | undefined;
    
    // Get active sessions for this user
    const sessionsWhere: any = { userId };
    if (mode) sessionsWhere.mode = mode;
    
    const activeSessions = await prisma.agentSession.findMany({
      where: {
        ...sessionsWhere,
        stoppedAt: null,
      },
      select: { id: true, symbol: true, mode: true },
    });
    
    const sessionIds = activeSessions.map(s => s.id);
    
    // =========================================================================
    // IN-MEMORY LOGS (from logger buffer) - Real-time agent activity
    // =========================================================================
    const memoryLogs = getRecentLogs({
      limit: limit,
      scope: 'agent',
      symbol: symbol,
    }).map(log => ({
      timestamp: log.timestamp,
      sessionId: '', // Memory logs don't have session ID, will be matched by symbol
      symbol: log.symbol || '',
      kind: log.kind || 'info',
      message: log.message,
      level: log.level as 'info' | 'warn' | 'error',
      details: { source: 'memory', logId: log.id },
    }));
    
    // Return early if only memory logs requested
    if (source === 'memory') {
      // Get live agent states for current activity
      const allAgents = getAllRunningAgents(userId);
      const agentStates = allAgents
        .filter(a => !mode || (a.getStatus() as any).mode === mode)
        .map(a => {
          const status = a.getStatus();
          const state = a.getAgentState?.();
          return {
            sessionId: status.sessionId,
            symbol: status.symbol,
            running: status.running,
            hasPosition: status.hasPosition,
            bias: state?.plan?.bias || null,
            lastDecision: (state as any)?.lastDecision || null,
            marketConditions: status.marketConditions,
          };
        });
      
      return res.json({ 
        logs: memoryLogs.slice(0, limit),
        agentStates,
        activeSessions: activeSessions.length,
      });
    }
    
    // =========================================================================
    // DB LOGS (TriggerLogs, Orders, Fills) - Historical trade activity
    // =========================================================================
    const logs: Array<{
      timestamp: string;
      sessionId: string;
      symbol: string;
      kind: string;
      message: string;
      level: 'info' | 'warn' | 'error';
      details?: Record<string, any>;
    }> = [];
    
    // At this point, source is 'db', 'all', or undefined (not 'memory' due to early return above)
    // Get recent trigger logs from active sessions
    const triggerLogs = await prisma.triggerLog.findMany({
      where: sessionIds.length > 0 ? { sessionId: { in: sessionIds } } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    
    // Get recent orders for trade activity
    const recentOrders = await prisma.order.findMany({
      where: sessionIds.length > 0 ? { sessionId: { in: sessionIds } } : { session: { userId } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { fills: true },
    });
    
    // Add trigger logs
    for (const tl of triggerLogs) {
      logs.push({
        timestamp: tl.createdAt.toISOString(),
        sessionId: tl.sessionId || '',
        symbol: tl.symbol,
        kind: tl.kind,
        message: formatTriggerMessage(tl.kind, tl.payload as any),
        level: 'info',
        details: { ...tl.payload as any, source: 'db' },
      });
    }
    
    // Add order events with fills
    for (const order of recentOrders) {
      // Calculate average fill price if filled
      const avgFillPrice = order.fills.length > 0 
        ? order.fills.reduce((sum, f) => sum + (f.price * f.qty), 0) / order.fills.reduce((sum, f) => sum + f.qty, 0)
        : order.price;
      
      logs.push({
        timestamp: order.createdAt.toISOString(),
        sessionId: order.sessionId || '',
        symbol: order.symbol,
        kind: 'order',
        message: `${order.side} ${order.type} order: ${order.qty} @ ${order.status === 'filled' ? avgFillPrice?.toFixed(4) : order.price?.toFixed(4)}`,
        level: order.status === 'filled' ? 'info' : (order.status === 'canceled' ? 'warn' : 'info'),
        details: { orderId: order.id, status: order.status, fills: order.fills.length, source: 'db' },
      });
      
      // Add fill events for significant fills
      for (const fill of order.fills) {
        if (fill.realizedPnl != null && fill.realizedPnl !== 0) {
          logs.push({
            timestamp: fill.ts.toISOString(),
            sessionId: order.sessionId || '',
            symbol: fill.symbol || order.symbol,
            kind: fill.realizedPnl >= 0 ? 'exit' : 'exit',
            message: `Trade filled: ${fill.qty} @ $${fill.price.toFixed(4)} | PnL: ${fill.realizedPnl >= 0 ? '+' : ''}$${fill.realizedPnl.toFixed(2)}`,
            level: fill.realizedPnl >= 0 ? 'info' : 'warn',
            details: { fillId: fill.id, orderId: fill.orderId, realizedPnl: fill.realizedPnl, source: 'db' },
          });
        }
      }
    }
    
    // Combine memory logs with DB logs
    const allLogs = [...memoryLogs, ...logs];
    
    // Sort by timestamp descending and limit
    allLogs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    
    // Get live agent states for current activity
    const allAgents = getAllRunningAgents(userId);
    const agentStates = allAgents
      .filter(a => !mode || (a.getStatus() as any).mode === mode)
      .map(a => {
        const status = a.getStatus();
        const state = a.getAgentState?.();
        return {
          sessionId: status.sessionId,
          symbol: status.symbol,
          running: status.running,
          hasPosition: status.hasPosition,
          bias: state?.plan?.bias || null,
          lastDecision: (state as any)?.lastDecision || null,
          marketConditions: status.marketConditions,
        };
      });
    
    res.json({ 
      logs: allLogs.slice(0, limit),
      agentStates,
      activeSessions: activeSessions.length,
    });
  } catch (error) {
    logger.error("Failed to get agent logs:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to get logs" });
  }
});

// Helper function to format trigger messages
function formatTriggerMessage(kind: string, payload: any): string {
  switch (kind) {
    case 'support-touch':
      return `Price touched support at ${payload?.support || payload?.price}`;
    case 'resistance-touch':
      return `Price touched resistance at ${payload?.resistance || payload?.price}`;
    case 'sudden-move':
      return `Sudden price movement detected: ${payload?.changePercent ? payload.changePercent.toFixed(2) + '%' : ''}`;
    case 'volume-spike':
      return `Volume spike: ${payload?.volumeRatio ? payload.volumeRatio.toFixed(1) + 'x' : ''} average`;
    case 'news-spike':
      return `News/sentiment spike detected`;
    case 'tick':
      return `Tick: ${payload?.price || ''}`;
    default:
      return `${kind}: ${JSON.stringify(payload).slice(0, 100)}`;
  }
}

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
      include: {
        SessionKpi: true,
        positions: true,
      },
    });
    
    // Enrich sessions with runtime state from memory (search both paper and live)
    const allUserAgents = getAllUserAgents(userId);
    const allAgentsList = getAllRunningAgents(userId);
    const enrichedSessions = sessions.map(session => {
      const agent = allAgentsList.find(a => a.getStatus().sessionId === session.id);
      
      let state = 'STOPPED';
      let hasPosition = false;
      let bias: 'long' | 'short' | null = null;
      
      if (agent) {
        const status = agent.getStatus();
        const agentState = agent.getAgentState?.();
        state = status.running 
          ? (status.hasPosition ? 'IN_POSITION' : 'WATCHING') 
          : 'STOPPED';
        hasPosition = status.hasPosition;
        bias = agentState?.plan?.bias || null;
      } else if (!session.stoppedAt) {
        state = 'WATCHING'; // Session active but agent not in memory
      }
      
      return {
        ...session,
        state,
        hasPosition,
        bias,
        pnlUsd: session.SessionKpi?.realizedPnlUsd || 0,
        winRate: session.SessionKpi?.winRate || 0,
      };
    });
    
    // Return array directly, not wrapped in object
    res.json(enrichedSessions);
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
    
    // ✅ Stop agent in memory if running (check both paper + live)
    const found = findAgentBySessionId(userId, id);
    if (found) {
      const agentKey = getAgentKey(userId, found.mode);
      const agentData = userAgents.get(agentKey);
      if (agentData) {
        const agentIndex = agentData.agents.findIndex(a => a.getStatus().sessionId === id);
        if (agentIndex !== -1) {
          const agent = agentData.agents[agentIndex];
          await agent.stop();
          agentData.agents.splice(agentIndex, 1);
          logger.info(`🗑️ Stopped and removed agent for session ${id} (${found.mode})`);
          
          // If no more agents for this mode, clean up entry
          if (agentData.agents.length === 0) {
            userAgents.delete(agentKey);
          }
        }
      }
    }
    
    // ✅ Delete all related records first (cascade manually)
    await prisma.$transaction([
      prisma.sessionKpi.deleteMany({ where: { sessionId: id } }),
      prisma.triggerLog.deleteMany({ where: { sessionId: id } }),
      prisma.alert.deleteMany({ where: { sessionId: id } }),
      prisma.dailyReport.deleteMany({ where: { sessionId: id } }),
      prisma.agentOpsTelemetry.deleteMany({ where: { sessionId: id } }),
      prisma.agentActionIntent.deleteMany({ where: { sessionId: id } }),
      prisma.pendingIntent.deleteMany({ where: { sessionId: id } }),
      prisma.agentPerformanceLedger.deleteMany({ where: { sessionId: id } }),
      prisma.position.deleteMany({ where: { sessionId: id } }),
      prisma.fill.deleteMany({ where: { sessionId: id } }),
      prisma.order.deleteMany({ where: { sessionId: id } }),
      prisma.strategy.deleteMany({ where: { sessionId: id } }),
      // Finally delete the session itself
      prisma.agentSession.delete({ where: { id } }),
    ]);
    
    logger.info(`🗑️ Deleted session ${id} and all related records`);
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
        SessionKpi: true,
        positions: true,
      },
    });
    
    // Get agent data for both modes
    const allAgentData = getAllUserAgents(userId);
    const allAgentsRaw = getAllRunningAgents(userId);
    
    // Filter agents by mode if specified
    const allAgents = mode 
      ? allAgentsRaw.filter(a => a.getStatus().mode === mode)
      : allAgentsRaw;
    
    // Build capital pool status for requested mode or combined
    let capitalPoolStatus: any = null;
    if (mode === 'paper' && allAgentData.paper) {
      capitalPoolStatus = allAgentData.paper.capitalPool.getStatus();
    } else if (mode === 'live' && allAgentData.live) {
      capitalPoolStatus = allAgentData.live.capitalPool.getStatus();
    } else {
      // Combined status
      capitalPoolStatus = {
        paper: allAgentData.paper?.capitalPool.getStatus() || null,
        live: allAgentData.live?.capitalPool.getStatus() || null,
      };
    }
    
    // Enrich sessions with runtime state from memory
    const enrichedSessions = sessions.map(session => {
      // Find running agent for this session (in either paper or live)
      const agent = allAgents.find(a => a.getStatus().sessionId === session.id);
      
      let state = 'STOPPED';
      let hasPosition = false;
      const realizedPnlUsd = session.SessionKpi?.realizedPnlUsd || 0;
      let unrealizedPnlUsd = 0;
      let winRate = session.SessionKpi?.winRate || 0;
      let bias: 'long' | 'short' | null = null;
      
      if (agent) {
        const status = agent.getStatus();
        const agentState = agent.getAgentState?.();
        state = status.running 
          ? (status.hasPosition ? 'IN_POSITION' : 'WATCHING') 
          : 'STOPPED';
        hasPosition = status.hasPosition;
        bias = agentState?.plan?.bias || null;
        
        // Add unrealized PnL if in position
        unrealizedPnlUsd = agentState?.pos?.pnlUsd || 0;
      } else if (!session.stoppedAt) {
        // Session not stopped but agent not running - it crashed or was restarted
        state = 'WATCHING';
      }
      
      return {
        ...session,
        state,
        hasPosition,
        bias,
        pnlUsd: realizedPnlUsd + unrealizedPnlUsd,
        realizedPnlUsd,
        unrealizedPnlUsd,
        winRate,
      };
    });
    
    // Totals for header should be all-time and net of fees.
    // Source of truth: Fill ledger (realizedPnl - fee), NOT SessionKpi (which is already net).
    const requestedMode = mode === 'paper' || mode === 'live' ? mode : undefined;

    const [paperCapSetting, liveStartSetting] = userId
      ? await Promise.all([
          prisma.userSetting.findUnique({
            where: {
              userId_key: {
                userId,
                key: 'paperTradingCapital',
              },
            },
          }),
          prisma.userSetting.findUnique({
            where: {
              userId_key: {
                userId,
                key: 'liveStartBalance',
              },
            },
          }),
        ])
      : [null, null];

    const paperInitial = parseFloat(paperCapSetting?.value || '10000') || 10000;
    const liveInitial = parseFloat(liveStartSetting?.value || '500') || 500;
    const initialCapital = requestedMode === 'paper'
      ? paperInitial
      : requestedMode === 'live'
        ? liveInitial
        : (paperInitial + liveInitial);

    const pnlAgg = await prisma.fill.aggregate({
      where: {
        session: {
          userId,
          ...(requestedMode ? { mode: requestedMode } : {}),
        },
      },
      _sum: { realizedPnl: true, fee: true },
    });

    const totalPnlUsd = (pnlAgg._sum.realizedPnl || 0) - (pnlAgg._sum.fee || 0);
    
    // 📊 Calculate TODAY's PnL (trades closed today in local timezone)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const todayAgg = await prisma.fill.aggregate({
      where: {
        session: {
          userId,
          ...(requestedMode ? { mode: requestedMode } : {}),
        },
        ts: { gte: todayStart },
      },
      _sum: { realizedPnl: true, fee: true },
      _count: { _all: true },
    });

    const todayPnlUsd = (todayAgg._sum.realizedPnl || 0) - (todayAgg._sum.fee || 0);
    const todayTrades = todayAgg._count._all;

    // Unrealized PnL from running agents (mode-filtered above)
    const unrealizedPnlUsd = allAgents.reduce((sum, agent) => {
      const agentState = agent.getAgentState?.();
      return sum + (agentState?.pos?.pnlUsd || 0);
    }, 0);

    const netPnlUsd = totalPnlUsd + unrealizedPnlUsd;
    const roiPct = initialCapital > 0 ? (totalPnlUsd / initialCapital) * 100 : 0;
    const netRoiPct = initialCapital > 0 ? (netPnlUsd / initialCapital) * 100 : 0;
    
    // Avg win-rate should be computed from all sessions, not just the last 20.
    const allKpis = await prisma.sessionKpi.findMany({
      where: {
        session: {
          userId,
          ...(requestedMode ? { mode: requestedMode } : {}),
        },
      },
      select: { stats: true },
    });

    let totalWins = 0;
    let totalTrades = 0;
    for (const kpi of allKpis) {
      const stats = kpi.stats as any;
      if (stats?.trades && stats.trades > 0) {
        totalWins += stats.wins || 0;
        totalTrades += stats.trades || 0;
      }
    }
    const avgWinRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
    
    res.json({
      sessions: enrichedSessions,
      capitalPool: capitalPoolStatus,
      activeSymbols: allAgents.length > 0 ? MomentumConfig.SYMBOLS : [],
      // Add totals for header display
      pnlUsd: totalPnlUsd,
      unrealizedPnlUsd,
      netPnlUsd,
      todayPnlUsd,
      todayTrades,
      roiPct,
      netRoiPct,
      initialCapitalUsd: initialCapital,
      activeCount: allAgents.length,
      symbols: allAgents.map(a => a.getStatus().symbol),
      // Win rate aggregated from all sessions
      avgWinRate,
      totalTrades,
      totalWins,
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
    
    // If sessionId provided, return state for that specific agent
    if (sessionId && typeof sessionId === 'string') {
      const found = findAgentBySessionId(userId, sessionId);
      
      if (found) {
        const agentStatus = found.agent.getStatus();
        const agentState = found.agent.getAgentState?.() || {};
        const agentData = userAgents.get(getAgentKey(userId, found.mode));
        
        return res.json({
          running: agentStatus.running,
          state: agentStatus.running 
            ? (agentStatus.hasPosition ? 'IN_POSITION' : 'WATCHING') 
            : 'STOPPED',
          hasPosition: agentStatus.hasPosition,
          symbol: agentStatus.symbol,
          sessionId: agentStatus.sessionId,
          mode: found.mode,
          marketConditions: agentStatus.marketConditions,
          tickCount: agentStatus.tickCount,
          lastTickAt: agentStatus.lastTickAt,
          // Agent state from getAgentState() method
          pos: agentState.pos,
          plan: agentState.plan,
          exit: agentState.exit,
          profile: agentState.profile,
          balance: {
            freeUsd: agentData?.capitalPool.getAvailableCapital() || 0,
          },
        });
      }
      
      // Agent not running, check database for session and position
      const dbSession = await prisma.agentSession.findUnique({
        where: { id: sessionId },
      });
      
      if (dbSession) {
        // Also fetch any open position from DB
        const dbPosition = await prisma.position.findFirst({
          where: { sessionId },
        });
        
        let pos: any = null;
        if (dbPosition) {
          pos = {
            symbol: dbPosition.symbol,
            side: dbPosition.side,
            entryPrice: dbPosition.entryPrice,
            qty: dbPosition.qty,
            stopLoss: dbPosition.stopPrice,
            stopPrice: dbPosition.stopPrice,
            stop: dbPosition.stopPrice,
            leverage: dbPosition.leverage,
            entryTime: dbPosition.openedAt?.getTime() || Date.now(),
            openedAt: dbPosition.openedAt?.getTime() || Date.now(),
            // Frontend expects 'entry' as alias
            entry: dbPosition.entryPrice,
          };
        }
        
        return res.json({
          running: false,
          state: dbSession.stoppedAt ? 'STOPPED' : (dbSession.haltedAt ? 'HALT' : 'STOPPED'),
          hasPosition: !!dbPosition,
          symbol: dbSession.symbol,
          sessionId: dbSession.id,
          pos,
        });
      }
      
      return res.json(null);
    }
    
    // No sessionId - return overview of all agents (both paper + live)
    const allAgentData = getAllUserAgents(userId);
    const allAgents = getAllRunningAgents(userId);
    
    if (allAgents.length === 0) {
      return res.json({ running: false, agents: [] });
    }
    
    const agentStatuses = allAgents.map(a => a.getStatus());
    
    res.json({ 
      running: agentStatuses.some(s => s.running),
      agents: agentStatuses.map(s => ({
        symbol: s.symbol,
        sessionId: s.sessionId,
        running: s.running,
        hasPosition: s.hasPosition,
        mode: allAgentData.paper?.agents.some(a => a.getStatus().sessionId === s.sessionId) ? 'paper' : 'live',
      })),
      paper: allAgentData.paper ? { capitalPool: allAgentData.paper.capitalPool.getStatus() } : null,
      live: allAgentData.live ? { capitalPool: allAgentData.live.capitalPool.getStatus() } : null,
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
    
    // For paper mode or if exchange fetch fails - use mode-specific pool
    const agentKey = getAgentKey(userId, mode as 'paper' | 'live');
    const agentData = userAgents.get(agentKey);
    
    if (!agentData) {
      return res.json({
        balance: mode === 'paper' ? 10000 : 0,
        freeBalance: mode === 'paper' ? 10000 : 0,
        inPositions: 0,
        positions: [],
        mode,
        source: 'default',
      });
    }
    
    const capitalStatus = agentData.capitalPool.getStatus();
    const agentStatuses = agentData.agents.map(a => a.getStatus());
    
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
    logger.info(`[Capital] Snapshot request - userId: ${userId}, mode: ${mode}`);
    
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
    
    // For paper mode or if exchange fetch fails, use mode-specific capital pool
    const agentKey = getAgentKey(userId, mode as 'paper' | 'live');
    const agentData = userAgents.get(agentKey);
    
    // 🔧 FIX: For PAPER mode, ALWAYS calculate from DB (initialCapital + accumulatedPnL)
    // This ensures correct balance even after redeployment when agent is already running
    if (mode === 'paper' && userId) {
      try {
        // Get initial capital setting
        const setting = await prisma.userSetting.findUnique({
          where: {
            userId_key: {
              userId: userId,
              key: 'paperTradingCapital'
            }
          }
        });
        const initialCapital = parseFloat(setting?.value || '10000') || 10000;
        
        // Get accumulated PnL from ALL paper sessions
        const allKpis = await prisma.sessionKpi.findMany({
          where: {
            session: {
              userId,
              mode: 'paper',
            }
          },
          select: {
            realizedPnlUsd: true,
          }
        });
        const accumulatedPnl = allKpis.reduce((sum, kpi) => sum + (kpi.realizedPnlUsd || 0), 0);
        const actualBalance = initialCapital + accumulatedPnl;
        
        logger.info(`[Capital] Paper: $${initialCapital} (initial) + $${accumulatedPnl.toFixed(2)} (PnL) = $${actualBalance.toFixed(2)}`);
        
        // Get in-position amount from running agent if exists
        const inPositionsUsd = agentData ? agentData.capitalPool.getStatus().inPositionsUsd : 0;
        const reservedUsd = agentData ? agentData.capitalPool.getStatus().reservedUsd : 0;
        
        return res.json({
          totalUSD: actualBalance,
          freeUSD: actualBalance - inPositionsUsd - reservedUsd,
          reservedUSD: reservedUsd,
          inPositionsUSD: inPositionsUsd,
          ts: Date.now(),
          source: 'database',
          initialCapitalUsd: initialCapital,
          accumulatedPnlUsd: accumulatedPnl,
        });
      } catch (dbError) {
        logger.warn('Failed to read paper balance from DB:', dbError);
        // Fall through to capital pool if DB fails
      }
    }
    
    if (!agentData) {
      // No agent running - return zeros for live, or fallback for paper
      return res.json({
        totalUSD: 0,
        freeUSD: 0,
        reservedUSD: 0,
        inPositionsUSD: 0,
        ts: Date.now(),
        source: 'none',
      });
    }
    
    // For LIVE mode with running agent, use capital pool
    const status = agentData.capitalPool.getStatus();
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
    
    const allAgentData = getAllUserAgents(userId);
    
    // Get reservations from paper pool
    let paperReservations: any[] = [];
    if (allAgentData.paper) {
      const status = allAgentData.paper.capitalPool.getStatus();
      paperReservations = Object.entries(status.byAgent).map(([agentId, data]) => ({
        agentId,
        reserved: data.reserved,
        inPosition: data.inPosition,
      }));
    }
    
    // Get reservations from live pool
    let liveReservations: any[] = [];
    if (allAgentData.live) {
      const status = allAgentData.live.capitalPool.getStatus();
      liveReservations = Object.entries(status.byAgent).map(([agentId, data]) => ({
        agentId,
        reserved: data.reserved,
        inPosition: data.inPosition,
      }));
    }
    
    res.json({
      paper: paperReservations,
      live: liveReservations,
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
    const existingAgents = userAgents.get(getAgentKey(userId, 'paper'));
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
    const agentKey = getAgentKey(userId, mode as 'paper' | 'live');
    const existingAgents = userAgents.get(agentKey);
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
    
    // Check if this symbol is already running in this mode
    const modeAgentKey = getAgentKey(userId, mode as 'paper' | 'live');
    const existingAgents = userAgents.get(modeAgentKey);
    if (existingAgents) {
      const alreadyRunning = existingAgents.agents.find(a => a.getStatus().symbol === selectedSymbol);
      if (alreadyRunning) {
        return res.status(409).json({ 
          error: `Agent for ${selectedSymbol} is already running in ${mode} mode`,
          symbol: selectedSymbol,
        });
      }
    }
    
    // Get exchange
    const exchange = await getExchangeForUser(userId);
    
    // 🔧 FIX: Calculate actual starting balance based on mode
    let actualStartBalance = capitalUsd;
    
    if (mode === 'live') {
      // In LIVE mode: fetch real balance from Binance - REQUIRED
      try {
        const balance = await exchange.fetchBalance({ type: 'future' });
        const totalUsdt = parseFloat(balance?.total?.USDT || balance?.USDT?.total || '0') || 0;
        const freeUsdt = parseFloat(balance?.free?.USDT || balance?.USDT?.free || '0') || 0;
        
        if (totalUsdt > 0) {
          actualStartBalance = totalUsdt;
          logger.info(`[Live] ✅ Using actual Binance balance: $${actualStartBalance.toFixed(2)}`);
          
          // Seed WebSocket cache
          seedBalanceCache(userId, 'USDT', { total: totalUsdt, free: freeUsdt, locked: totalUsdt - freeUsdt });
          
          // 🔧 FIX: Subscribe to user data stream for real-time updates (0 weight)
          try {
            const credentials = await getUserCredentials(userId);
            if (credentials && credentials.apiKey && credentials.apiSecret) {
              const binanceWs = getBinanceWebSocket();
              await binanceWs.subscribeToUserData(userId, credentials.apiKey, credentials.apiSecret);
              logger.info(`✅ [Live] User data stream subscribed for ${userId}`);
            }
          } catch (wsErr: any) {
            logger.warn(`⚠️ [Live] Failed to subscribe to user data stream:`, wsErr?.message);
          }
        } else {
          // Balance is 0 or fetch failed - REFUSE to start
          logger.error(`[Live] ❌ Binance balance is $0 - cannot start live trading`);
          return res.status(400).json({ 
            error: 'Binance balance is $0. Please deposit funds before starting live trading.',
          });
        }
      } catch (err: any) {
        logger.error('[Live] ❌ Failed to fetch Binance balance:', err?.message || err);
        return res.status(500).json({ 
          error: 'Failed to fetch Binance balance. Check your API keys.',
          detail: err?.message || 'Unknown error'
        });
      }
    } else {
      // In PAPER mode: add accumulated PnL from past sessions
      try {
        const pastKpis = await prisma.sessionKpi.findMany({
          where: {
            session: {
              userId,
              mode: 'paper',
            }
          },
          select: { realizedPnlUsd: true }
        });
        const accumulatedPnl = pastKpis.reduce((sum, kpi) => sum + (kpi.realizedPnlUsd || 0), 0);
        actualStartBalance = capitalUsd + accumulatedPnl;
        logger.info(`[Paper] Actual balance: $${capitalUsd} (initial) + $${accumulatedPnl.toFixed(2)} (PnL) = $${actualStartBalance.toFixed(2)}`);
      } catch (err) {
        logger.warn('[Paper] Failed to fetch accumulated PnL:', err);
      }
    }
    
    // Create a SINGLE session for the selected symbol only
    const session = await prisma.agentSession.create({
      data: { 
        userId, 
        symbol: selectedSymbol, 
        mode, 
        startBalanceUsd: actualStartBalance,
        profileJson: { capitalUsd: actualStartBalance, symbol: selectedSymbol } 
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
    
    // Get or create capital pool for this user (separate pools for paper/live)
    // 🔧 FIX: For LIVE mode, ALWAYS use actualStartBalance (fetched from Binance above)
    const modeTyped = mode as 'paper' | 'live';
    let capitalPool = getCapitalPool(userId, undefined, modeTyped);
    
    if (!capitalPool) {
      // No pool exists - create new one with correct balance
      capitalPool = resetCapitalPool(userId, actualStartBalance, modeTyped);
      logger.info(`[CapitalPool] Created new ${modeTyped} pool with $${actualStartBalance.toFixed(2)}`);
    } else {
      // Pool exists - for LIVE mode, FORCE reset to ensure correct Binance balance
      if (modeTyped === 'live') {
        // Reset pool to actual Binance balance (already fetched above)
        capitalPool = resetCapitalPool(userId, actualStartBalance, modeTyped);
        logger.info(`[CapitalPool] Reset live pool to Binance balance: $${actualStartBalance.toFixed(2)}`);
      }
      // For paper mode, keep existing pool (it has accumulated PnL state)
    }
    
    // 🔧 FIX: Set exchange reference on pool for REST fallback in syncWithExchange
    if (modeTyped === 'live' && exchange) {
      capitalPool.setExchange(exchange);
    }
    
    // Create SINGLE agent for the selected symbol
    const agent = new SimpleAgent({
      symbol: selectedSymbol,
      exchange,
      prisma,
      userId,
      sessionId: session.id,
      capitalPool,
      mode: modeTyped,
      riskPerTradePct: 1,
    });
    
    // Get existing agents for this mode or create new entry
    const agentKey = getAgentKey(userId, modeTyped);
    const existingData = userAgents.get(agentKey);
    if (existingData) {
      existingData.agents.push(agent);
    } else {
      userAgents.set(agentKey, { agents: [agent], capitalPool, mode: modeTyped });
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

// Restart session - stops and restarts agents with fresh state
app.post("/api/agent/restart", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    
    const { mode, capitalUsd = 10000 } = req.body;
    
    if (!mode || !['paper', 'live'].includes(mode)) {
      return res.status(400).json({ error: "Mode must be 'paper' or 'live'" });
    }
    
    const modeTyped = mode as 'paper' | 'live';
    const agentKey = getAgentKey(userId, modeTyped);
    
    // 1. Stop existing agents for this mode
    const existingAgents = userAgents.get(agentKey);
    if (existingAgents) {
      logger.info(`[Restart] Stopping ${existingAgents.agents.length} existing ${mode} agents...`);
      for (const agent of existingAgents.agents) {
        await agent.stop();
      }
      userAgents.delete(agentKey);
    }
    
    // 2. Get exchange
    const exchange = await getExchangeForUser(userId);
    
    // 3. Calculate actual capital based on mode
    let actualCapital = capitalUsd;
    
    if (modeTyped === 'live') {
      // 🔴 LIVE MODE: ALWAYS use real Binance balance
      try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
          await exchange.loadMarkets();
        }
        
        const balance = await exchange.fetchBalance({ type: 'future' });
        const totalUsdt = parseFloat(balance?.total?.USDT || balance?.USDT?.total || '0') || 0;
        const freeUsdt = parseFloat(balance?.free?.USDT || balance?.USDT?.free || '0') || 0;
        const lockedUsdt = totalUsdt - freeUsdt;
        
        if (totalUsdt > 0) {
          actualCapital = totalUsdt;
          // 🔧 FIX: Seed the WebSocket balance cache so syncWithExchange() works
          seedBalanceCache(userId, 'USDT', { total: totalUsdt, free: freeUsdt, locked: lockedUsdt });
          logger.info(`✅ [Restart Live] Using REAL Binance balance: $${actualCapital.toFixed(2)}`);
          
          // 🔧 FIX: Subscribe to user data stream for real-time updates (0 weight)
          try {
            const credentials = await getUserCredentials(userId);
            if (credentials && credentials.apiKey && credentials.apiSecret) {
              const binanceWs = getBinanceWebSocket();
              await binanceWs.subscribeToUserData(userId, credentials.apiKey, credentials.apiSecret);
              logger.info(`✅ [Restart Live] User data stream subscribed for ${userId}`);
            }
          } catch (wsErr: any) {
            logger.warn(`⚠️ [Restart Live] Failed to subscribe to user data stream:`, wsErr?.message);
          }
        } else {
          return res.status(400).json({ 
            error: 'Binance balance is $0. Cannot restart live trading.',
          });
        }
      } catch (err: any) {
        logger.error('[Restart Live] Failed to fetch Binance balance:', err?.message || err);
        return res.status(500).json({ error: 'Failed to fetch Binance balance' });
      }
    } else {
      // 🟢 PAPER MODE: Use capitalUsd + accumulated PnL
      try {
        const pastKpis = await prisma.sessionKpi.findMany({
          where: {
            session: { userId, mode: 'paper' }
          },
          select: { realizedPnlUsd: true }
        });
        const accumulatedPnl = pastKpis.reduce((sum, kpi) => sum + (kpi.realizedPnlUsd || 0), 0);
        actualCapital = capitalUsd + accumulatedPnl;
        logger.info(`[Restart Paper] Capital: $${capitalUsd} + $${accumulatedPnl.toFixed(2)} PnL = $${actualCapital.toFixed(2)}`);
      } catch (err) {
        logger.warn('[Restart Paper] Failed to fetch accumulated PnL:', err);
        actualCapital = capitalUsd;
      }
    }
    
    // 4. Create new sessions
    const sessionIds: { btc: string; eth: string; sol: string; xrp: string } = {
      btc: '', eth: '', sol: '', xrp: ''
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
          mode: modeTyped,
          profileJson: { capitalUsd: actualCapital, symbol },
        }
      });
      const key = symbolToKey[symbol];
      if (key) sessionIds[key] = session.id;
    }
    
    // 5. Create and start all agents
    const { agents, capitalPool } = await createAllAgents({
      exchange,
      prisma,
      userId,
      sessionIds,
      totalCapitalUsd: actualCapital,
      mode: modeTyped,
    });
    
    userAgents.set(agentKey, { agents, capitalPool, mode: modeTyped });
    
    // 6. Configure and start each agent
    for (const agent of agents) {
      agent.setOnTick((tick) => {
        broadcast('tick', {
          sessionId: agent.getStatus().sessionId,
          symbol: tick.symbol,
          price: tick.price,
          hasPosition: tick.hasPosition,
          positionSide: tick.positionSide,
          support: tick.support,
          resistance: tick.resistance,
          tickCount: tick.tickCount,
          timestamp: tick.timestamp.toISOString(),
        }, tick.symbol);
      });
      
      await agent.start();
    }
    
    logger.info(`✅ [Restart] ${modeTyped.toUpperCase()} agents restarted with $${actualCapital.toFixed(2)}`);
    
    res.json({
      success: true,
      message: `${modeTyped.toUpperCase()} agents restarted successfully`,
      mode: modeTyped,
      capital: actualCapital,
      agents: agents.map(a => ({
        symbol: a.getStatus().symbol,
        sessionId: a.getStatus().sessionId,
      })),
    });
  } catch (error: any) {
    logger.error('[Restart] Failed:', error);
    res.status(500).json({ error: "Failed to restart", detail: error?.message });
  }
});

// Stop all agents (both paper + live)
app.post("/api/agent/stop-all", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    let stoppedCount = 0;
    
    // Stop both paper and live
    for (const mode of ['paper', 'live'] as const) {
      const agentKey = getAgentKey(userId, mode);
      const agentData = userAgents.get(agentKey);
      if (agentData) {
        for (const agent of agentData.agents) {
          await agent.stop();
          stoppedCount++;
        }
        userAgents.delete(agentKey);
      }
    }
    
    res.json({ success: true, stoppedCount });
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
    const allAgents = getAllRunningAgents(userId);
    
    if (allAgents.length === 0) {
      return res.json({ triggers: [] });
    }
    
    // Each agent has its own thresholds
    const triggers = allAgents.map(a => {
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
    const userId = (req as any)?.user?.id;
    const { symbol } = req.query;
    
    if (!symbol) {
      return res.status(400).json({ error: "Symbol required" });
    }
    
    // Try to get real analysis from running agent (check both paper + live)
    const allAgents = getAllRunningAgents(userId);
    if (allAgents.length > 0) {
      const normalizedSymbol = String(symbol).toUpperCase().replace(/[/:]/g, '');
      const agent = allAgents.find(a => {
        const agentSymbol = a.getStatus().symbol.toUpperCase().replace(/[/:]/g, '');
        return agentSymbol === normalizedSymbol;
      });
      
      if (agent) {
        const status = agent.getStatus();
        const state = agent.getAgentState?.() || {};
        
        return res.json({
          symbol,
          technical: {
            last: state.pos?.currentPrice || null,
            momentum: status.marketConditions?.btcMomentum6h || 0,
            btcAboveMa50: status.marketConditions?.btcAboveMa50,
          },
          plan: state.plan,
          position: state.pos,
          marketConditions: status.marketConditions,
          lastTickAt: status.lastTickAt,
          tickCount: status.tickCount,
          mode: agent.getMode(),
        });
      }
    }
    
    // Fallback for symbol not being traded
    res.json({
      symbol,
      technical: null,
      plan: null,
      position: null,
      marketConditions: null,
      message: "No active agent for this symbol",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to get analysis" });
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

// 🔧 WebSocket user data stream status endpoint
app.get("/api/monitor/websocket-status", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    const { getUserDataStreamStatus, isPositionCacheSeeded } = await import("./services/binanceWebSocket.js");
    const status = getUserDataStreamStatus(userId);
    const positionCacheSeeded = isPositionCacheSeeded(userId);
    
    res.json({
      userId,
      userDataStream: {
        connected: status.connected,
        hasListenKey: status.hasListenKey,
        readyState: status.readyState,
        readyStateLabel: status.readyState === 0 ? 'CONNECTING' : 
                         status.readyState === 1 ? 'OPEN' : 
                         status.readyState === 2 ? 'CLOSING' : 
                         status.readyState === 3 ? 'CLOSED' : 'UNKNOWN',
      },
      cache: {
        positionCacheSeeded,
        balanceAgeMs: status.cacheAge.balance,
        positionAgeMs: status.cacheAge.position,
        balanceAgeSec: status.cacheAge.balance ? Math.round(status.cacheAge.balance / 1000) : null,
        positionAgeSec: status.cacheAge.position ? Math.round(status.cacheAge.position / 1000) : null,
      },
      healthy: status.connected && positionCacheSeeded,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed" });
  }
});

app.get("/api/monitor/health", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const allAgents = getAllRunningAgents(userId);
    const allAgentData = getAllUserAgents(userId);
    
    res.json({
      healthy: true,
      agentsRunning: allAgents.length,
      paper: allAgentData.paper ? { count: allAgentData.paper.agents.length } : null,
      live: allAgentData.live ? { count: allAgentData.live.agents.length } : null,
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

// Get daily report for a specific session and date
app.get("/api/monitor/reports/daily", async (req, res) => {
  try {
    const sessionId = String(req.query.sessionId || "").trim();
    const dateStr = String(req.query.date || "").trim();
    const refresh = req.query.refresh === 'true';
    
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId required" });
    }
    
    // Default to today if no date provided
    const day = dateStr || new Date().toISOString().split('T')[0];
    
    // Check for existing report
    let report = await prisma.dailyReport.findUnique({
      where: { sessionId_day: { sessionId, day } },
    });
    
    // If refresh requested or no report exists, generate new stats
    if (refresh || !report) {
      // Calculate stats from fills for this day
      const dayStart = new Date(day + 'T00:00:00Z');
      const dayEnd = new Date(day + 'T23:59:59.999Z');
      
      const fills = await prisma.fill.findMany({
        where: {
          sessionId,
          ts: { gte: dayStart, lte: dayEnd },
          realizedPnl: { not: null },
        },
        orderBy: { ts: 'asc' },
      });
      
      const exitFills = fills.filter(f => f.realizedPnl !== null && f.realizedPnl !== 0);
      const trades = exitFills.length;
      const wins = exitFills.filter(f => (f.realizedPnl || 0) > 0).length;
      const losses = exitFills.filter(f => (f.realizedPnl || 0) < 0).length;
      const pnlUsd = exitFills.reduce((sum, f) => sum + (f.realizedPnl || 0), 0);
      const fees = fills.reduce((sum, f) => sum + (f.fee || 0), 0);
      const winRate = trades > 0 ? wins / trades : 0;
      
      const winPnls = exitFills.filter(f => (f.realizedPnl || 0) > 0).map(f => f.realizedPnl || 0);
      const lossPnls = exitFills.filter(f => (f.realizedPnl || 0) < 0).map(f => f.realizedPnl || 0);
      const avgWin = winPnls.length > 0 ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0;
      const avgLoss = lossPnls.length > 0 ? Math.abs(lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length) : 0;
      const expectancy = trades > 0 ? (pnlUsd - fees) / trades : 0;
      
      // Get session start balance for ROI calculation
      const session = await prisma.agentSession.findUnique({ where: { id: sessionId } });
      const startBalance = session?.startBalanceUsd || 1000;
      const roiPct = startBalance > 0 ? ((pnlUsd - fees) / startBalance) * 100 : 0;
      
      const stats = {
        trades,
        wins,
        losses,
        winRate,
        pnlUsd,
        fees,
        netPnl: pnlUsd - fees,
        avgWin,
        avgLoss,
        expectancy,
        roiPct,
      };
      
      // Upsert report
      report = await prisma.dailyReport.upsert({
        where: { sessionId_day: { sessionId, day } },
        update: { stats },
        create: { sessionId, day, stats, userId: session?.userId },
      });
    }
    
    res.json(report);
  } catch (error) {
    logger.error("Failed to get daily report:", error);
    res.status(500).json({ error: "Failed to get daily report" });
  }
});

// List daily reports for a session - auto-generates from fills if no reports exist
app.get("/api/monitor/reports/daily/list", async (req, res) => {
  try {
    const sessionId = String(req.query.sessionId || "").trim();
    const limitRaw = Number(req.query.limit ?? 30);
    const limit = Math.max(1, Math.min(365, Math.floor(limitRaw)));
    
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId required" });
    }
    
    // First try to get existing reports
    let reports = await prisma.dailyReport.findMany({
      where: { sessionId },
      orderBy: { day: 'desc' },
      take: limit,
    });
    
    // If no reports exist, generate them from fills data
    if (reports.length === 0) {
      // Get all fills for this session grouped by day
      const fills = await prisma.fill.findMany({
        where: { 
          sessionId,
          realizedPnl: { not: null },
        },
        orderBy: { ts: 'asc' },
      });
      
      if (fills.length > 0) {
        // Group fills by day
        const fillsByDay = new Map<string, typeof fills>();
        for (const fill of fills) {
          const day = fill.ts.toISOString().split('T')[0];
          if (!fillsByDay.has(day)) {
            fillsByDay.set(day, []);
          }
          fillsByDay.get(day)!.push(fill);
        }
        
        // Get session info
        const session = await prisma.agentSession.findUnique({ where: { id: sessionId } });
        const startBalance = session?.startBalanceUsd || 1000;
        
        // Generate reports for each day with trades
        const generatedReports: typeof reports = [];
        for (const [day, dayFills] of fillsByDay.entries()) {
          const exitFills = dayFills.filter(f => f.realizedPnl !== null && f.realizedPnl !== 0);
          const trades = exitFills.length;
          
          if (trades === 0) continue;
          
          const wins = exitFills.filter(f => (f.realizedPnl || 0) > 0).length;
          const losses = exitFills.filter(f => (f.realizedPnl || 0) < 0).length;
          const pnlUsd = exitFills.reduce((sum, f) => sum + (f.realizedPnl || 0), 0);
          const fees = dayFills.reduce((sum, f) => sum + (f.fee || 0), 0);
          const winRate = trades > 0 ? wins / trades : 0;
          
          const winPnls = exitFills.filter(f => (f.realizedPnl || 0) > 0).map(f => f.realizedPnl || 0);
          const lossPnls = exitFills.filter(f => (f.realizedPnl || 0) < 0).map(f => f.realizedPnl || 0);
          const avgWin = winPnls.length > 0 ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0;
          const avgLoss = lossPnls.length > 0 ? Math.abs(lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length) : 0;
          const expectancy = trades > 0 ? (pnlUsd - fees) / trades : 0;
          const roiPct = startBalance > 0 ? ((pnlUsd - fees) / startBalance) * 100 : 0;
          
          const stats = {
            trades,
            wins,
            losses,
            winRate,
            pnlUsd,
            fees,
            netPnl: pnlUsd - fees,
            avgWin,
            avgLoss,
            expectancy,
            roiPct,
          };
          
          // Upsert report
          const report = await prisma.dailyReport.upsert({
            where: { sessionId_day: { sessionId, day } },
            update: { stats },
            create: { sessionId, day, stats, userId: session?.userId },
          });
          
          generatedReports.push(report);
        }
        
        // Return newly generated reports
        reports = generatedReports.sort((a, b) => 
          new Date(b.day).getTime() - new Date(a.day).getTime()
        ).slice(0, limit);
      }
    }
    
    res.json(reports);
  } catch (error) {
    logger.error("Failed to list daily reports:", error);
    res.status(500).json({ error: "Failed to list daily reports" });
  }
});

// Save/update daily report
app.post("/api/monitor/reports/daily", async (req, res) => {
  try {
    const userId = (req as any)?.user?.id;
    const { sessionId, date, stats, llm } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId required" });
    }
    
    const day = date || new Date().toISOString().split('T')[0];
    
    const report = await prisma.dailyReport.upsert({
      where: { sessionId_day: { sessionId, day } },
      update: { stats, llm },
      create: { sessionId, day, stats, llm, userId },
    });
    
    res.json({ success: true, report });
  } catch (error) {
    logger.error("Failed to save daily report:", error);
    res.status(500).json({ error: "Failed to save daily report" });
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
    const allAgents = getAllRunningAgents(userId);
    const allAgentData = getAllUserAgents(userId);
    
    res.json({
      agentsRunning: allAgents.length,
      paper: allAgentData.paper ? { count: allAgentData.paper.agents.length } : null,
      live: allAgentData.live ? { count: allAgentData.live.agents.length } : null,
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
    const allAgents = getAllRunningAgents(userId);
    const allAgentData = getAllUserAgents(userId);
    
    if (allAgents.length === 0) {
      return res.json({ agents: [], paper: null, live: null });
    }
    
    const agents = allAgents.map(a => {
      const status = a.getStatus();
      // Determine mode
      const mode = allAgentData.paper?.agents.some(pa => pa.getStatus().sessionId === status.sessionId) ? 'paper' : 'live';
      return {
        symbol: status.symbol,
        running: status.running,
        hasPosition: status.hasPosition,
        health: "healthy",
        mode,
      };
    });
    
    res.json({ 
      agents,
      paper: allAgentData.paper ? { count: allAgentData.paper.agents.length } : null,
      live: allAgentData.live ? { count: allAgentData.live.agents.length } : null,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

// ============================================
// HTTP SERVER + WEBSOCKET
// ============================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ✅ Enhanced WebSocket client tracking with user/symbol subscription
interface WsClientData {
  ws: WebSocket;
  userId?: string;
  sessionId?: string;
  subscribedSymbol?: string;
  authenticated: boolean;
}

const wsClients = new Map<WebSocket, WsClientData>();

wss.on("connection", (ws) => {
  // Initialize client data
  wsClients.set(ws, { ws, authenticated: false });
  logger.debug("WebSocket client connected");
  
  ws.on("message", async (rawMsg) => {
    try {
      const msg = JSON.parse(rawMsg.toString());
      const clientData = wsClients.get(ws);
      if (!clientData) return;
      
      // Handle authentication
      if (msg.type === 'hello' && msg.token) {
        try {
          const decoded = jwt.verify(msg.token, cfg.JWT_SECRET || cfg.APP_API_KEY || 'default-secret') as any;
          if (decoded.userId) {
            clientData.userId = decoded.userId;
            clientData.authenticated = true;
            ws.send(JSON.stringify({ type: 'hello_ok', expiresAt: new Date(Date.now() + 3600000).toISOString() }));
            logger.debug(`WS authenticated for user ${decoded.userId}`);
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', code: 'ws.auth.invalid' }));
        }
        return;
      }
      
      // Handle subscription
      if (msg.type === 'sub') {
        if (msg.symbol) clientData.subscribedSymbol = msg.symbol;
        if (msg.sessionId) clientData.sessionId = msg.sessionId;
        ws.send(JSON.stringify({ type: 'sub_ok', symbol: msg.symbol, sessionId: msg.sessionId }));
        logger.debug(`WS subscribed to ${msg.symbol || 'all'} for session ${msg.sessionId || 'none'}`);
        return;
      }
      
      // Handle token refresh
      if (msg.type === 'refresh' && msg.token) {
        try {
          const decoded = jwt.verify(msg.token, cfg.JWT_SECRET || cfg.APP_API_KEY || 'default-secret') as any;
          if (decoded.userId) {
            clientData.userId = decoded.userId;
            clientData.authenticated = true;
            ws.send(JSON.stringify({ type: 'refresh_ok', expiresAt: new Date(Date.now() + 3600000).toISOString() }));
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', code: 'ws.auth.refresh_failed' }));
        }
        return;
      }
    } catch {
      // Ignore malformed messages
    }
  });
  
  ws.on("close", () => wsClients.delete(ws));
  ws.on("error", () => wsClients.delete(ws));
});

// ✅ Broadcast with optional symbol filtering - only sends to clients subscribed to that symbol
function broadcast(type: string, data: any, symbol?: string) {
  const message = JSON.stringify({ type, data, timestamp: Date.now() });
  for (const [ws, clientData] of wsClients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    
    // If symbol provided, only send to clients subscribed to that symbol
    if (symbol && clientData.subscribedSymbol) {
      // Normalize symbols for comparison (remove slashes and colons)
      const normalizedSub = clientData.subscribedSymbol.toUpperCase().replace(/[/:]/g, '');
      const normalizedData = symbol.toUpperCase().replace(/[/:]/g, '');
      if (normalizedSub !== normalizedData) continue;
    }
    
    ws.send(message);
  }
}

// Initialize notification service with broadcast function
initNotificationService(broadcast);

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
        // ✅ Pass symbol to broadcast for filtering
        broadcast('price_update', {
          symbol: ticker.symbol,
          last: ticker.last,
          bid: ticker.bid,
          ask: ticker.ask,
        }, ticker.symbol);
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
    
    // 🔧 FIX: Group by user AND mode (userId_paper, userId_live)
    const sessionsByUserMode = new Map<string, any[]>();
    for (const session of activeSessions) {
      if (!session.userId) continue;
      const key = `${session.userId}_${session.mode}`;
      const existing = sessionsByUserMode.get(key) || [];
      existing.push(session);
      sessionsByUserMode.set(key, existing);
    }
    
    // Restore each user's agents by mode
    for (const [userModeKey, sessions] of sessionsByUserMode) {
      const [userId, mode] = userModeKey.split('_') as [string, 'paper' | 'live'];
      
      try {
        const exchange = await getExchangeForUser(userId);
        
        // Get capital from first session profile or user settings
        const firstProfile = sessions[0]?.profileJson as any;
        let initialCapitalUsd = firstProfile?.capitalUsd || 10000;
        
        // Try to get from user settings (this is the INITIAL capital, not current)
        try {
          const setting = await prisma.userSetting.findUnique({
            where: { userId_key: { userId, key: 'paperTradingCapital' } }
          });
          if (setting?.value) {
            initialCapitalUsd = parseFloat(setting.value) || initialCapitalUsd;
          }
        } catch {}
        
        // 🔧 FIX: For PAPER mode, calculate current capital = initial + realized PnL from all sessions
        // 🔧 FIX: For LIVE mode, ALWAYS fetch real balance from Binance
        let currentCapitalUsd = initialCapitalUsd;
        
        if (mode === 'live') {
          // LIVE MODE: Fetch real balance from Binance
          try {
            const balance = await exchange.fetchBalance({ type: 'future' });
            const totalUsdt = parseFloat(balance?.total?.USDT || balance?.USDT?.total || '0') || 0;
            const freeUsdt = parseFloat(balance?.free?.USDT || balance?.USDT?.free || '0') || 0;
            
            if (totalUsdt > 0) {
              currentCapitalUsd = totalUsdt;
              logger.info(`📊 [LIVE] Restoring with Binance balance: $${currentCapitalUsd.toFixed(2)}`);
              
              // Seed WebSocket cache
              seedBalanceCache(userId, 'USDT', { total: totalUsdt, free: freeUsdt, locked: totalUsdt - freeUsdt });
              
              // 🔧 FIX: Subscribe to user data stream for real-time updates (0 weight)
              try {
                const credentials = await getUserCredentials(userId);
                if (credentials && credentials.apiKey && credentials.apiSecret) {
                  const binanceWs = getBinanceWebSocket();
                  await binanceWs.subscribeToUserData(userId, credentials.apiKey, credentials.apiSecret);
                  logger.info(`✅ [Restore] User data stream subscribed for ${userId}`);
                }
              } catch (wsErr: any) {
                logger.warn(`⚠️ [Restore] Failed to subscribe to user data stream:`, wsErr?.message);
              }
            } else {
              logger.warn(`⚠️ [LIVE] Binance balance is $0, using fallback: $${initialCapitalUsd.toFixed(2)}`);
            }
          } catch (err: any) {
            logger.warn(`⚠️ [LIVE] Failed to fetch Binance balance, using fallback:`, err?.message);
          }
        } else if (mode === 'paper') {
          try {
            // Sum up realized PnL from all active sessions' KPIs
            const sessionIds = sessions.map(s => s.id);
            const kpis = await prisma.sessionKpi.findMany({
              where: { sessionId: { in: sessionIds } },
              select: { realizedPnlUsd: true }
            });
            const totalRealizedPnl = kpis.reduce((sum, kpi) => sum + (kpi.realizedPnlUsd || 0), 0);
            currentCapitalUsd = initialCapitalUsd + totalRealizedPnl;
            
            if (Math.abs(totalRealizedPnl) > 0.01) {
              logger.info(`📊 [PAPER] Restoring capital with PnL: $${initialCapitalUsd.toFixed(2)} + $${totalRealizedPnl.toFixed(2)} = $${currentCapitalUsd.toFixed(2)}`);
            }
          } catch (pnlErr) {
            logger.warn(`⚠️ Failed to restore paper PnL, using initial capital:`, pnlErr);
          }
        }
        
        // Create capital pool for this user (separate for paper/live)
        // currentCapitalUsd is already set correctly:
        // - LIVE: fetched from Binance above
        // - PAPER: initial + realized PnL
        resetCapitalPool(userId, currentCapitalUsd, mode);
        const capitalPool = getCapitalPool(userId, undefined, mode)!;
        logger.info(`💰 [${mode.toUpperCase()}] Capital pool reset to $${currentCapitalUsd.toFixed(2)}`);
        
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
        
        // Store and start agents (by mode)
        const agentKey = getAgentKey(userId, mode as 'paper' | 'live');
        userAgents.set(agentKey, { agents, capitalPool, mode: mode as 'paper' | 'live' });
        
        for (const agent of agents) {
          // Configure tick broadcast callback
          agent.setOnTick((tick) => {
            broadcast('tick', {
              sessionId: agent.getStatus().sessionId,
              symbol: tick.symbol,
              price: tick.price,
              hasPosition: tick.hasPosition,
              positionSide: tick.positionSide,
              support: tick.support,
              resistance: tick.resistance,
              tickCount: tick.tickCount,
              timestamp: tick.timestamp.toISOString(),
            }, tick.symbol);
          });
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

// ============================================
// V5.24: INITIALIZE BINANCE WEBSOCKET BEFORE SERVER STARTS
// ============================================
// This ensures WebSocket is connected and ready before agents try to use it
// Prevents "WebSocket not ready" fallback to REST API on startup
(async () => {
  try {
    logger.info('🌐 Initializing Binance WebSocket...');
    const ws = getBinanceWebSocket();
    
    // Wait for WebSocket to connect (with timeout)
    const maxWait = 10000; // 10 seconds max
    const startTime = Date.now();
    
    while (!ws.isConnected() && Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    if (ws.isConnected()) {
      logger.info('✅ Binance WebSocket connected and ready');
      
      // Give it a moment to subscribe to initial streams
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      logger.info('✅ WebSocket initialization complete');
    } else {
      logger.warn('⚠️ WebSocket connection timeout - agents will use REST fallback initially');
    }
  } catch (error) {
    logger.warn('⚠️ Failed to initialize WebSocket:', error);
    logger.info('ℹ️ Agents will use REST fallback on startup');
  }
})();

server.listen(cfg.PORT, () => {
  logger.info(`✅ Server listening on :${cfg.PORT}`);
  logger.info(`📈 Strategy: Momentum Simple (Vol 5x + BTC MA50 + 2h Mom)`);
});
