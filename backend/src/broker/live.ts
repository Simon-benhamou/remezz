import { Broker, NewOrder, PlacedOrder } from './types.js';
import { getUserExchange, resolveSymbol } from '../exchange/ccxtClient.js';
import { emitAlert } from '../monitor/policy.js';
import { getConfig } from '../utils/env.js';
import { logImprovementAuto } from '../monitor/backlog.js';
import { getUserCredentials } from '../services/userCredentials.js';

const CAPACITY_LOG = new Map<string, number[]>();
const BREACH_WINDOW_MS = 60 * 60 * 1000;
const LIMIT_SLIP_PCT = Number(process.env.ORDER_LIMIT_SLIP_PCT || '0.15'); // percent

function parsePositiveNumber(value: any): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function extractFilledPrice(order: any, fallback?: number): number | undefined {
  if (!order) return parsePositiveNumber(fallback);

  const info = order?.info;
  const candidates: any[] = [
    order?.average,
    order?.price,
    info?.avgPrice,
    info?.averagePrice,
    info?.avgExecutionPrice,
    info?.price,
    info?.p,
    info?.ap,
    info?.lastFilledPrice,
    fallback,
  ];

  for (const candidate of candidates) {
    const price = parsePositiveNumber(candidate);
    if (price !== undefined) return price;
  }

  const fills: any[] = Array.isArray(info?.fills) ? info.fills : Array.isArray(order?.trades) ? order.trades : [];
  for (const fill of fills) {
    const price = parsePositiveNumber(fill?.price);
    if (price !== undefined) return price;
  }

  return undefined;
}

function recordCapacityBreach(symbol: string) {
  const key = symbol.toUpperCase();
  const arr = CAPACITY_LOG.get(key) || [];
  const now = Date.now();
  arr.push(now);
  while (arr.length && now - arr[0] > BREACH_WINDOW_MS) arr.shift();
  CAPACITY_LOG.set(key, arr);
}

export function getCapacityPressure(symbol: string, windowMs = BREACH_WINDOW_MS) {
  const arr = CAPACITY_LOG.get(symbol.toUpperCase());
  if (!arr?.length) return 0;
  const now = Date.now();
  return arr.filter(ts => now - ts <= windowMs).length;
}

// Minimal ccxt-backed live broker (spot or swap per env config)
export class LiveBroker implements Broker {
  mode: 'paper'|'live' = 'live';
  private userId: string;

  constructor(userId: string) {
    this.userId = userId;
  }

  private async getExchange() {
    const userCredentials = await getUserCredentials(this.userId);
    if (!userCredentials) {
      throw new Error('User API credentials not found');
    }
    return await getUserExchange(this.userId, userCredentials);
  }

  async balance() {
    // 🚀 WebSocket for Binance (0 weight)
    let b: any;
    const userCredentials = await getUserCredentials(this.userId);

    if (userCredentials?.exchange === 'binance') {
      try {
        const { getBalanceFromWebSocket, subscribeToUserData, seedBalanceCache, runExclusiveBalanceFetch } = await import('../services/binanceWebSocket.js');
        await subscribeToUserData(this.userId, userCredentials.apiKey, userCredentials.apiSecret);
        const wsBalance = await getBalanceFromWebSocket(this.userId, 'USDT');
        if (wsBalance) {
          b = {
            total: { USDT: wsBalance.total },
            free: { USDT: wsBalance.free },
            used: { USDT: wsBalance.locked },
            info: {}
          };
          console.log(`✅ [WebSocket] Balance fetched in broker - 0 weight`);
        } else {
          const ex = await this.getExchange();
          b = await runExclusiveBalanceFetch(this.userId, 'USDT', () => ex.fetchBalance());
          console.log(`⚠️ [REST] Balance fetched in broker - 40 weight`);
          try {
            const total = Number(b?.total?.USDT ?? 0);
            const free = Number(b?.free?.USDT ?? 0);
            const locked = Number(b?.used?.USDT ?? 0);
            if (Number.isFinite(total) || Number.isFinite(free) || Number.isFinite(locked)) {
              seedBalanceCache(this.userId, 'USDT', { total, free, locked });
            }
          } catch {}
        }
      } catch (error) {
        console.warn('⚠️ WebSocket balance failed in broker, using REST:', error);
        const ex = await this.getExchange();
        const { runExclusiveBalanceFetch, seedBalanceCache } = await import('../services/binanceWebSocket.js');
        b = await runExclusiveBalanceFetch(this.userId, 'USDT', () => ex.fetchBalance());
        try {
          const total = Number(b?.total?.USDT ?? 0);
          const free = Number(b?.free?.USDT ?? 0);
          const locked = Number(b?.used?.USDT ?? 0);
          if (Number.isFinite(total) || Number.isFinite(free) || Number.isFinite(locked)) {
            seedBalanceCache(this.userId, 'USDT', { total, free, locked });
          }
        } catch {}
      }
    } else {
      const ex = await this.getExchange();
      b = await ex.fetchBalance();
    }
    
    const raw = Array.isArray(b?.info?.result?.data) ? b.info.result.data[0] : undefined;
    const infoSources: any[] = [];
    if (raw) infoSources.push(raw);
    if (b?.info && !infoSources.includes(b.info)) infoSources.push(b.info);
    const nestedInfo = (b?.info as any)?.info;
    if (nestedInfo && !infoSources.includes(nestedInfo)) infoSources.push(nestedInfo);

    const num = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    let avail = num(raw?.total_available_balance);
    let marginBal = num(raw?.total_margin_balance) ?? num(raw?.total_collateral_value);
    let positionCost = num(raw?.total_position_cost);
    let openOrderMargin: number | undefined;

    for (const src of infoSources) {
      if (avail === undefined) {
        avail = num(src?.total_available_balance)
          ?? num(src?.availableBalance)
          ?? num(src?.maxWithdrawAmount)
          ?? num(src?.totalAvailableBalance);
      }
      if (marginBal === undefined) {
        marginBal = num(src?.total_margin_balance)
          ?? num(src?.total_collateral_value)
          ?? num(src?.totalMarginBalance)
          ?? num(src?.totalWalletBalance)
          ?? num(src?.totalCrossWalletBalance);
      }
      if (positionCost === undefined) {
        positionCost = num(src?.total_position_cost)
          ?? num(src?.totalPositionInitialMargin)
          ?? num(src?.totalInitialMargin)
          ?? num(src?.totalMaintMargin);
      }
      if (openOrderMargin === undefined) {
        openOrderMargin = num(src?.total_open_order_margin)
          ?? num(src?.totalOpenOrderInitialMargin);
      }
    }

    // Fallbacks to legacy spot fields if derivatives-specific fields are absent.
    const fallbackTotal = (b?.total?.USDT ?? 0) + (b?.total?.USD ?? 0);
    const fallbackFree = (b?.free?.USDT ?? 0) + (b?.free?.USD ?? 0);

    const equityUsd = marginBal ?? fallbackTotal;
    const freeUsd = avail ?? fallbackFree;
    const inferredCommit = (Number.isFinite(equityUsd) && Number.isFinite(freeUsd))
      ? Math.max(0, equityUsd - freeUsd)
      : 0;
    const baseCommitted = positionCost ?? inferredCommit;
    const ordersCommitted = Number.isFinite(openOrderMargin) ? Math.max(openOrderMargin!, 0) : 0;
    let committedUsd = Math.max(0, baseCommitted);
    if (ordersCommitted > 0) {
      committedUsd = Math.max(committedUsd, (positionCost ?? 0) + ordersCommitted);
    }
    if (Number.isFinite(equityUsd)) {
      committedUsd = Math.min(committedUsd, Math.max(0, Number(equityUsd)));
    }
    if (!Number.isFinite(committedUsd)) committedUsd = 0;

    const normalizedFreeUsd = Number.isFinite(freeUsd) ? freeUsd : 0;
    const normalizedEquityUsd = Number.isFinite(equityUsd) ? equityUsd : 0;

    if (normalizedEquityUsd > 0 && normalizedFreeUsd <= 0) {
      console.debug('[Risk] Free balance collapsed while equity positive', {
        equityUsd: normalizedEquityUsd,
        freeUsd: normalizedFreeUsd,
      });
    }

    return {
      freeUsd: normalizedFreeUsd,
      equityUsd: normalizedEquityUsd,
      committedUsd,
    };
  }

  async place(o: NewOrder): Promise<PlacedOrder> {
    const ex = await this.getExchange();
    const symbol = await resolveSymbol(o.symbol);
    const startTs = Date.now();

    // Try set leverage if available and provided
    if (o.leverage && typeof (ex as any).setLeverage === 'function') {
      try { await (ex as any).setLeverage(o.leverage, symbol); } catch {}
    }

    let order: any;
    const params: any = {};
    const tif = o.type === 'limit' ? (o.timeInForce || 'GTC') : o.timeInForce;
    if (o.reduceOnly) params.reduceOnly = true;
    if (o.postOnly) params.postOnly = true;
    if (o.timeInForce) params.timeInForce = o.timeInForce;
    const cfg = getConfig();
    const deadline = Date.now() + Math.max(1000, cfg.ORDER_FILL_TIMEOUT_SEC * 1000);
    const pollMs = Math.max(100, cfg.ORDER_FILL_POLL_MS);
    const maxRetry = Math.max(0, cfg.ORDER_RETRY_MAX);
    let attempts = 1;
    let cancelCount = 0;

    async function waitForFill(ordId: string) {
      while (Date.now() < deadline) {
        try {
          const fo = await ex.fetchOrder(ordId, symbol).catch(()=>null);
          const st = String(fo?.status || '').toLowerCase();
          if (st.includes('closed') || st.includes('filled')) return { filledQty: Number(fo?.filled||0), avgPrice: extractFilledPrice(fo, o.price), status: 'filled' };
          if (st.includes('canceled') || st.includes('rejected')) return { filledQty: Number(fo?.filled||0), avgPrice: extractFilledPrice(fo, o.price), status: 'rejected' };
        } catch {}
        await new Promise(r=> setTimeout(r, pollMs));
      }
      return { filledQty: undefined, avgPrice: undefined, status: 'open' } as any;
    }
    try {
      if (o.type === 'market') {
        order = await ex.createOrder(symbol, 'market', o.side, o.qty, undefined, params);
      } else {
        const limitParams: any = { ...params };
        if (tif) limitParams.timeInForce = tif;
        order = await ex.createOrder(symbol, 'limit', o.side, o.qty, o.price, limitParams);
      }
    } catch (e: any) {
      const details = { error: String(e?.message||e), symbol, side: o.side, qty: o.qty };
      try { await emitAlert({ kind:'capacity_breach' as any, severity:'med', details }); } catch {}
      recordCapacityBreach(symbol);
      await logImprovementAuto({
        title: 'Capacity breach when placing order',
        description: `Exchange rejected order ${o.side} ${o.qty} ${symbol}.`,
        severity: 'high',
        tags: ['execution', 'capacity'],
        context: { ...details, mode: 'live' },
      });
      return { ...o, id: 'rejected', status: 'rejected', ts: Date.now() };
    }

    const filledQty = Number(order?.filled ?? 0) || undefined;
    const avgPrice = extractFilledPrice(order, o.price);
    const status: PlacedOrder['status'] = (order?.status === 'closed' || order?.status === 'filled') ? 'filled'
      : (order?.status === 'canceled' ? 'canceled' : 'open');

    const id = String(order?.id || order?.clientOrderId || '');
    let placed: PlacedOrder = { ...o, id, status, filledQty, avgPrice, ts: Date.now() };

    // Ensure fill: poll and retry if needed
    if (placed.status !== 'filled') {
      const res = await waitForFill(id);
      if (res.status === 'filled') {
        placed = { ...placed, status: 'filled', filledQty: res.filledQty, avgPrice: res.avgPrice };
      } else if (res.status !== 'rejected') {
        try { await ex.cancelOrder(id, symbol).catch(()=>{}); cancelCount += 1; } catch {}
        let retry = 0;
        while (retry < maxRetry) {
          retry++;
          attempts = retry + 1;
          try {
            let re:any;
            if (LIMIT_SLIP_PCT > 0) {
              try {
                const book = await ex.fetchOrderBook(symbol, 10).catch(()=>null as any);
                const best = o.side === 'buy' ? book?.asks?.[0]?.[0] : book?.bids?.[0]?.[0];
                if (best) {
                  const slip = LIMIT_SLIP_PCT / 100;
                  const limitPx = o.side === 'buy' ? best * (1 + slip) : best * (1 - slip);
                  re = await ex.createOrder(symbol, 'limit', o.side, o.qty, limitPx, { ...params, timeInForce: 'IOC' });
                }
              } catch {}
            }
            if (!re) {
              re = await ex.createOrder(symbol, 'market', o.side, o.qty, undefined, params);
            }
            const rid = String(re?.id || re?.clientOrderId || '');
            const rr = await waitForFill(rid);
            if (rr.status === 'filled') { placed = { ...placed, id: rid, status:'filled', filledQty: rr.filledQty, avgPrice: rr.avgPrice }; break; }
          } catch {}
        }
        if (placed.status !== 'filled') {
          try { await emitAlert({ kind:'order_unfilled' as any, severity:'high', details:{ symbol, side:o.side, qty:o.qty } }); } catch {}
          placed.status = 'rejected';
        }
      } else {
        placed.status = 'rejected';
      }
    }

    placed.latencyMs = Math.max(0, Date.now() - startTs);
    placed.attempts = attempts;
    placed.cancelCount = cancelCount;
    placed.requestedQty = o.qty;
    placed.requestedPrice = o.type === 'limit' ? o.price : undefined;

    // Best-effort: create protective SL/TP orders if provided
    try {
      if (placed.status==='filled' && placed.filledQty && placed.avgPrice && (o.stopLoss || o.takeProfit)) {
        const reduceSide = o.side === 'buy' ? 'sell' : 'buy';
        // Stop-loss as stop-market
        if (o.stopLoss) {
          try {
            const slParams: any = { reduceOnly: true, stopPrice: o.stopLoss, triggerPrice: o.stopLoss };
            // Vendor-guard for Crypto.com swaps: hint stop type when supported
            if (String(ex.id).toLowerCase() === 'cryptocom') slParams.type = 'stop_market';
            const slo = await ex.createOrder(symbol, 'market', reduceSide, placed.filledQty, undefined, slParams);
            placed.slOrderId = String(slo?.id || slo?.clientOrderId || '');
          } catch {}
        }
        // Take-profit as limit reduce-only
        if (o.takeProfit) {
          try {
            const tpParams: any = { reduceOnly: true, takeProfitPrice: o.takeProfit };
            if (String(ex.id).toLowerCase() === 'cryptocom') tpParams.type = 'take_profit_limit';
            const tpo = await ex.createOrder(symbol, 'limit', reduceSide, placed.filledQty, o.takeProfit, tpParams);
            placed.tpOrderId = String(tpo?.id || tpo?.clientOrderId || '');
          } catch {}
        }
      }
    } catch {}

    return placed;
  }

  async cancel(id: string) {
    const ex = await this.getExchange();
    try { await ex.cancelOrder(id); } catch {}
  }

  async estimateFillableQty(params: { symbol: string; side: 'buy'|'sell'; desiredQty: number; maxImpactPct?: number }) {
    const ex = await this.getExchange();
    const symbol = await resolveSymbol(params.symbol);
    const maxImpactPct = params.maxImpactPct ?? Number(process.env.ORDER_MAX_IMPACT_PCT || '0.35');
    let market: any;
    try {
      const isBinanceExchange = String((ex as any)?.id || '').toLowerCase().includes('binance');
      if (!ex.markets && !isBinanceExchange) { await ex.loadMarkets(); }
      market = ex.market ? ex.market(symbol) : ex.markets?.[symbol];
    } catch {}
    const book = await ex.fetchOrderBook(symbol, 40).catch(()=>null as any);
    const levels = params.side === 'buy' ? book?.asks : book?.bids;
    let cumQty = 0;
    let bestPrice = levels?.[0]?.[0];
    let worstPrice = bestPrice;
    if (Array.isArray(levels)) {
      for (const [price, qty] of levels) {
        if (typeof price !== 'number' || typeof qty !== 'number') continue;
        if (cumQty === 0 && !bestPrice) bestPrice = price;
        cumQty += qty;
        worstPrice = price;
        if (cumQty >= params.desiredQty) break;
      }
    }
    const impactPct = bestPrice && worstPrice
      ? Math.abs((worstPrice - bestPrice) / bestPrice) * 100
      : 0;
    const fillableQty = cumQty > 0 ? Math.min(params.desiredQty, cumQty) : params.desiredQty;
    let minQty: number | undefined;
    try {
      minQty = Number(market?.limits?.amount?.min);
    } catch {}
    if (impactPct > maxImpactPct && cumQty >= params.desiredQty) {
      const scaled = Math.max(minQty ?? 0, params.desiredQty * (maxImpactPct / Math.max(0.0001, impactPct)));
      return { fillableQty: scaled, impactPct, minQty };
    }
    return { fillableQty, impactPct, minQty };
  }

  async syncProtective(params: { symbol: string; side: 'buy'|'sell'; qty: number; stopLoss?: number; takeProfit?: number | number[]; slOrderId?: string|null; tpOrderId?: string|null }) {
    const ex = await this.getExchange();
    const symbol = await resolveSymbol(params.symbol);
    const reduceSide = params.side === 'buy' ? 'sell' : 'buy';
    const result: { slOrderId?: string; tpOrderId?: string } = {};
    const tpLevels = Array.isArray(params.takeProfit)
      ? params.takeProfit.filter(v => typeof v === 'number' && Number.isFinite(v))
      : (typeof params.takeProfit === 'number' && Number.isFinite(params.takeProfit) ? [params.takeProfit] : []);
    const primaryTp = tpLevels[0];
    if (params.slOrderId) {
      try { await ex.cancelOrder(params.slOrderId, symbol).catch(()=>{}); } catch {}
    }
    if (params.tpOrderId) {
      try { await ex.cancelOrder(params.tpOrderId, symbol).catch(()=>{}); } catch {}
    }
    const stopLossValid = params.stopLoss !== undefined && params.stopLoss !== null && Number.isFinite(Number(params.stopLoss));
    if (stopLossValid && params.qty > 0) {
      try {
        const slParams: any = { reduceOnly: true, stopPrice: params.stopLoss, triggerPrice: params.stopLoss };
        if (String(ex.id).toLowerCase() === 'cryptocom') slParams.type = 'stop_market';
        const slo = await ex.createOrder(symbol, 'market', reduceSide, params.qty, undefined, slParams);
        result.slOrderId = String(slo?.id || slo?.clientOrderId || '');
      } catch {}
    }
    if (primaryTp !== undefined && params.qty > 0) {
      try {
        const tpParams: any = { reduceOnly: true, takeProfitPrice: primaryTp };
        if (String(ex.id).toLowerCase() === 'cryptocom') tpParams.type = 'take_profit_limit';
        const tpo = await ex.createOrder(symbol, 'limit', reduceSide, params.qty, primaryTp, tpParams);
        result.tpOrderId = String(tpo?.id || tpo?.clientOrderId || '');
      } catch {}
    }
    return result;
  }
}

// Inspect current live exposure for a symbol.
// Returns null if no position or exchange doesn't support positions for current market type.
export async function inspectExposure(symbol: string, userId?: string): Promise<{ side: 'buy'|'sell'; qty: number; entry?: number } | null> {
  if (!userId) {
    return null; // No user specified, cannot access authenticated exchange
  }
  
  const userCredentials = await getUserCredentials(userId);
  if (!userCredentials) {
    return null;
  }
  
  const ex = await getUserExchange(userId, userCredentials);
  const s = await resolveSymbol(symbol);
  try {
    // Try unified positions API (perps/swaps)
    if (typeof (ex as any).fetchPositions === 'function') {
      const positions = await (ex as any).fetchPositions([s]).catch(()=>[]);
      const p = Array.isArray(positions) ? positions.find((x:any)=> (x?.symbol === s) && Math.abs(Number(x?.contracts || x?.size || x?.positionAmt || 0)) > 0) : null;
      if (p) {
        const rawSize = Number(p.contracts || p.size || p.positionAmt || 0);
        const qty = Math.abs(rawSize);
        if (qty > 0) {
          const side: 'buy'|'sell' = rawSize > 0 ? 'buy' : 'sell';
          const entry = Number(p.entryPrice || p.avgEntryPrice || p.average || p.markPrice || 0) || undefined;
          return { side, qty, entry };
        }
      }
    }
  } catch {}

  // Fallback (spot): only infer from balances when explicitly trading spot pairs.
  // For swaps/perps the exchange may not report positions, but using spot balances would
  // create "ghost" exposures when residual tokens sit in the wallet. Guard with market type.
  try {
    const marketType = String(process.env.MARKET_TYPE || 'spot').toLowerCase();
    if (marketType === 'spot' && ex.markets && ex.markets[s]) {
      const base = ex.markets[s].base;
      
      // 🚀 WebSocket for Binance (0 weight)
      let b: any;
      if (userId && userCredentials?.exchange === 'binance' && base === 'USDT') {
        try {
          const { getBalanceFromWebSocket, seedBalanceCache, runExclusiveBalanceFetch } = await import('../services/binanceWebSocket.js');
          const wsBalance = await getBalanceFromWebSocket(userId, base);
          if (wsBalance) {
            b = { total: { [base]: wsBalance.total }, free: { [base]: wsBalance.free } };
            console.log(`✅ [WebSocket] Balance for ghost exposure - 0 weight`);
          } else {
            b = await runExclusiveBalanceFetch(userId, base, () => ex.fetchBalance());
            try {
              const total = Number(b?.total?.[base] ?? 0);
              const free = Number(b?.free?.[base] ?? 0);
              const locked = Number(b?.used?.[base] ?? 0);
              if (Number.isFinite(total) || Number.isFinite(free) || Number.isFinite(locked)) {
                seedBalanceCache(userId, base, { total, free, locked });
              }
            } catch {}
          }
        } catch (error) {
          const { runExclusiveBalanceFetch, seedBalanceCache } = await import('../services/binanceWebSocket.js');
          b = await runExclusiveBalanceFetch(userId, base, () => ex.fetchBalance());
          try {
            const total = Number(b?.total?.[base] ?? 0);
            const free = Number(b?.free?.[base] ?? 0);
            const locked = Number(b?.used?.[base] ?? 0);
            if (Number.isFinite(total) || Number.isFinite(free) || Number.isFinite(locked)) {
              seedBalanceCache(userId, base, { total, free, locked });
            }
          } catch {}
        }
      } else {
        b = await ex.fetchBalance();
      }
      
      const held = Number((b?.total?.[base] ?? b?.free?.[base] ?? 0));
      if (held > 0) return { side: 'buy', qty: held };
    }
  } catch {}

  return null;
}
