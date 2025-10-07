import { Router } from "express";
import { getConfig } from "../utils/env.js";
import { getUserExchange, resolveSymbol } from "../exchange/ccxtClient.js";
import { computeCoreIndicators, getTicker } from "../data/market.js";
import { prisma } from "../db/client.js";
import { buildTechSnapshot } from "../ai/tech.js";
// Make /status usable without strict JWT when API key auth is disabled
// We keep optional user context when available, but do not enforce it here.
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { getUserCredentials } from '../services/userCredentials.js';

export const router = Router();
// Lightweight cache for /status when not asking heavy data
const STATUS_TTL_MS = 3000;
const statusCache = new Map<string, { ts: number; data: any }>();
router.get('/', async (req: AuthenticatedRequest, res) => {
  const cfg = getConfig();
  const testMode = (process.env.UNIT_TEST_MODE || 'false') === 'true';
  
  const userId = (req as any)?.user?.id;
  const userCredentials = userId ? await getUserCredentials(userId).catch((err) => {
    console.error('Failed to load user credentials for status:', err);
    return null;
  }) : null;

  const isBinanceUser = String(userCredentials?.exchange || '').toLowerCase() === 'binance';
  let exchange: any = null;

  async function ensureExchange(): Promise<any> {
    if (!userId || !userCredentials) return null;
    if (exchange) return exchange;
    try {
      exchange = await getUserExchange(userId, userCredentials);
      return exchange;
    } catch (error) {
      console.error('Failed to instantiate user exchange for status:', error);
      return null;
    }
  }
  
  const sessionId = String(req.query.sessionId || '');
  const s = sessionId
    ? await prisma.agentSession.findUnique({ where: { id: sessionId } })
    : await prisma.agentSession.findFirst({ where:{ stoppedAt:null }, orderBy:{ startedAt:'desc' } });

  const symbol = s?.symbol || cfg.SYMBOL;
  
  // Quick mode: only fetch heavy data if explicitly requested
  const includeBalance = req.query.includeBalance === 'true';
  const includeTech = req.query.includeTech === 'true';
  
  // Serve from cache when allowed
  try {
    if (!testMode && !includeBalance && !includeTech) {
      const cacheKey = `${(req as any)?.user?.id || 'legacy'}:${s?.id || 'no_session'}:${symbol}`;
      const cached = statusCache.get(cacheKey);
      if (cached && (Date.now() - cached.ts) < STATUS_TTL_MS) {
        return res.json(cached.data);
      }
    }
  } catch {}
  
  // In UNIT_TEST_MODE, return minimal payload quickly
  if (testMode) {
    const sRow = sessionId ? await prisma.agentSession.findUnique({ where: { id: sessionId } }) : await prisma.agentSession.findFirst({ where:{ stoppedAt:null }, orderBy:{ startedAt:'desc' } });
    return res.json({
      serverTime: new Date().toISOString(),
      exchangeId: cfg.EXCHANGE_ID,
      symbol,
      balance: null,
      orders: [],
      indicators: { ema20: 0, ema50: 0, rsi14: 50, atr14: 0, atrPct: 0, adx14: 0, ema20Slope: 0, price: 0 },
      session: sRow,
      sr: null,
      supports: [],
      resistances: [],
      pivots: null,
    });
  }

  // Parallel fetch with timeout for heavy operations
  const [balance, orders, indic] = await Promise.all([
    includeBalance && userCredentials ? (async () => {
      if (isBinanceUser) {
        if (!userId) return null;
        try {
          const { getBalanceFromWebSocket, subscribeToUserData } = await import('../services/binanceWebSocket.js');
          await subscribeToUserData(userId, userCredentials.apiKey, userCredentials.apiSecret);
          
          // Try to get USDT balance from WebSocket
          const wsBalanceUSDT = await getBalanceFromWebSocket(userId, 'USDT');
          
          // For USD fiat balance, we need to use REST API since WebSocket is for futures only
          let usdBalance = 0;
          try {
            const ex = await ensureExchange();
            if (ex) {
              const fullBalance = await ex.fetchBalance();
              usdBalance = Number(fullBalance?.total?.USD ?? 0);
              console.log(`💵 Retrieved USD balance: $${usdBalance}`);
            }
          } catch (error) {
            console.warn('⚠️ Failed to fetch USD balance:', error);
          }
          
          if (wsBalanceUSDT) {
            console.log(`✅ [WebSocket] /status balance for user ${userId} - 0 weight`);
            return {
              total: { USDT: wsBalanceUSDT.total, USD: usdBalance },
              free: { USDT: wsBalanceUSDT.free, USD: usdBalance }, // USD fiat is usually fully available
              used: { USDT: wsBalanceUSDT.locked, USD: 0 }
            };
          }
          console.log(`⚠️ [WebSocket] /status balance cache miss for user ${userId}`);
        } catch (error) {
          console.warn('⚠️ WebSocket balance failed on /status, falling back to REST:', error);
        }
      }
      const ex = await ensureExchange();
      if (!ex) return null;
      return await Promise.race([
        (async () => {
          if (isBinanceUser && userId) {
            try {
              const { runExclusiveBalanceFetch, seedBalanceCache } = await import('../services/binanceWebSocket.js');
              const balance: any = await runExclusiveBalanceFetch<any>(userId, 'USDT', () => ex.fetchBalance()) as any;
              const totalUSDT = Number(balance?.total?.USDT ?? 0);
              const freeUSDT = Number(balance?.free?.USDT ?? 0);
              const lockedUSDT = Number(balance?.used?.USDT ?? 0);
              const totalUSD = Number(balance?.total?.USD ?? 0);
              
              if (Number.isFinite(totalUSDT) || Number.isFinite(freeUSDT) || Number.isFinite(lockedUSDT)) {
                seedBalanceCache(userId, 'USDT', { total: totalUSDT, free: freeUSDT, locked: lockedUSDT });
              }
              
              // Return balance with both USDT and USD
              return {
                total: { USDT: totalUSDT, USD: totalUSD },
                free: { USDT: freeUSDT, USD: totalUSD }, // USD fiat is usually fully available
                used: { USDT: lockedUSDT, USD: 0 }
              };
            } catch (error) {
              console.warn('⚠️ Failed exclusive balance fetch, falling back to direct REST:', error);
            }
          }
          const direct: any = await ex.fetchBalance();
          if (isBinanceUser && userId) {
            try {
              const { seedBalanceCache } = await import('../services/binanceWebSocket.js');
              const totalUSDT = Number(direct?.total?.USDT ?? 0);
              const freeUSDT = Number(direct?.free?.USDT ?? 0);
              const lockedUSDT = Number(direct?.used?.USDT ?? 0);
              if (Number.isFinite(totalUSDT) || Number.isFinite(freeUSDT) || Number.isFinite(lockedUSDT)) {
                seedBalanceCache(userId, 'USDT', { total: totalUSDT, free: freeUSDT, locked: lockedUSDT });
              }
            } catch {}
          }
          
          // Return balance with both USDT and USD from direct fetch
          const totalUSDT = Number(direct?.total?.USDT ?? 0);
          const freeUSDT = Number(direct?.free?.USDT ?? 0);
          const lockedUSDT = Number(direct?.used?.USDT ?? 0);
          const totalUSD = Number(direct?.total?.USD ?? 0);
          
          return {
            total: { USDT: totalUSDT, USD: totalUSD },
            free: { USDT: freeUSDT, USD: totalUSD },
            used: { USDT: lockedUSDT, USD: 0 }
          };
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Balance timeout')), 8000))
      ]).catch(()=>null);
    })() : null,
    userCredentials ? (async ()=>{ 
      try { 
        const ex = await ensureExchange();
        if (!ex) return [];
        const s = await resolveSymbol(symbol); 
        return await Promise.race([
          ex.fetchOpenOrders(s),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Orders timeout')), 5000))
        ]);
      } catch { return []; } 
    })() : [],
    computeCoreIndicators(symbol).catch(()=>null),
  ]);

  let tech:any = null;
  if (includeTech) {
    try { 
      tech = await Promise.race([
        buildTechSnapshot(symbol),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tech timeout')), 10000))
      ]);
    } catch {}
  }

  let liveTicker: any = null;
  try {
    liveTicker = await getTicker(symbol, { forceRefresh: true, userId });
  } catch (error) {
    console.error('Status ticker validation failed:', error);
    return res.status(502).json({
      error: 'ticker_unavailable',
      details: String((error as any)?.message || error)
    });
  }

  const payload = {
    serverTime: new Date().toISOString(),
    exchangeId: exchange?.id || cfg.EXCHANGE_ID,
    symbol,
    balance,
    orders,
    // Merge indicators with tech snapshot for complete data
    indicators: indic ? {
      ...indic,
      atrPct: tech?.atrPct ?? 0,  // Add missing atrPct
      adx14: tech?.adx14 ?? 0,    // Add missing adx
      ema20Slope: tech?.ema20Slope ?? 0,
      price: liveTicker?.last,
    } : null,
    ticker: liveTicker ? {
      symbol: liveTicker.symbol,
      last: liveTicker.last,
      bid: liveTicker.bid,
      ask: liveTicker.ask,
      percentage: liveTicker.percentage,
      baseVolume: liveTicker.baseVolume,
      quoteVolume: liveTicker.quoteVolume,
      high: liveTicker.high,
      low: liveTicker.low,
      timestamp: liveTicker.timestamp,
    } : null,
    session: s,
    sr: tech ? { support: tech.support, resistance: tech.resistance } : null,
    // champs riches pour le front:
    supports: tech?.supports || [],
    resistances: tech?.resistances || [],
    pivots: tech?.pivots || null,
  };
  try {
    if (!testMode && !includeBalance && !includeTech) {
      const cacheKey = `${(req as any)?.user?.id || 'legacy'}:${s?.id || 'no_session'}:${symbol}`;
      statusCache.set(cacheKey, { ts: Date.now(), data: payload });
    }
  } catch {}
  res.json(payload);
});
