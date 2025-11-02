import { Broker, NewOrder, PlacedOrder, BrokerMarginSnapshot, BrokerPositionMargin, BrokerCorrelatedExposure } from './types.js';
import { getUserExchange, resolveSymbol } from '../exchange/ccxtClient.js';
import { emitAlert } from '../monitor/policy.js';
import { getConfig } from '../utils/env.js';
import { fetchDepth } from '../data/depth.js';
import { walkBook } from '../exec/bookWalkSlippage.js';
import { getIntradayRuntimeConfig } from '../config/intraday.js';
import type { Cfg } from '../utils/env.js';
import { logImprovementAuto } from '../monitor/backlog.js';
import { getUserCredentials } from '../services/userCredentials.js';
import type { UserCredentials as StoredUserCredentials } from '../services/userCredentials.js';

type BrokerTestOverrides = {
  getUserExchange?: (userId: string, credentials: StoredUserCredentials) => Promise<any>;
  getUserCredentials?: (userId: string) => Promise<StoredUserCredentials | null>;
  resolveSymbol?: (requested: string) => Promise<string>;
};

let brokerTestOverrides: BrokerTestOverrides | null = null;

export function __setLiveBrokerTestOverrides(overrides?: BrokerTestOverrides | null): void {
  brokerTestOverrides = overrides ?? null;
}

export function __resetLiveBrokerTestOverrides(): void {
  brokerTestOverrides = null;
}

async function resolveUserCredentials(userId: string): Promise<StoredUserCredentials | null> {
  if (brokerTestOverrides?.getUserCredentials) {
    return brokerTestOverrides.getUserCredentials(userId);
  }
  return getUserCredentials(userId);
}

async function resolveUserExchange(userId: string, credentials: StoredUserCredentials): Promise<any> {
  if (brokerTestOverrides?.getUserExchange) {
    return brokerTestOverrides.getUserExchange(userId, credentials);
  }
  return getUserExchange(userId, credentials);
}

async function resolveSymbolWithOverrides(requested: string, userId?: string): Promise<string> {
  if (brokerTestOverrides?.resolveSymbol) {
    return brokerTestOverrides.resolveSymbol(requested);
  }
  return resolveSymbol(requested, userId);
}

type CommittedMarginInput = {
  equityUsd?: number;
  freeUsd?: number;
  positionCost?: number;
  openOrderMargin?: number;
  positions?: BrokerPositionMargin[];
};

const toFiniteNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export function computeCommittedMargin(input: CommittedMarginInput): number {
  const equity = toFiniteNumber(input.equityUsd);
  const free = toFiniteNumber(input.freeUsd);
  const positionCost = toFiniteNumber(input.positionCost);
  const openOrderMargin = toFiniteNumber(input.openOrderMargin);
  const positions = Array.isArray(input.positions) ? input.positions : [];

  let reportedInitial = 0;
  let impliedInitial = 0;

  for (const pos of positions) {
    const initial = toFiniteNumber(pos?.initialMarginUsd);
    if (initial !== undefined && initial > 0) {
      reportedInitial += initial;
      continue;
    }

    const notional = toFiniteNumber(pos?.notionalUsd);
    const leverage = toFiniteNumber(pos?.leverage);
    if (notional !== undefined && leverage !== undefined && leverage > 0) {
      impliedInitial += notional / leverage;
    }
  }

  let committed = 0;
  if (reportedInitial > 0) {
    committed = reportedInitial;
  } else if (impliedInitial > 0) {
    committed = impliedInitial;
  } else if (positionCost !== undefined && positionCost > 0) {
    committed = positionCost;
  } else if (equity !== undefined && free !== undefined) {
    committed = Math.max(0, equity - free);
  }

  if (openOrderMargin !== undefined && openOrderMargin > 0) {
    committed += openOrderMargin;
  }

  if (equity !== undefined) {
    committed = Math.min(Math.max(committed, 0), Math.max(0, equity));
  }

  if (!Number.isFinite(committed) || committed < 0) {
    return 0;
  }

  return committed;
}

function inferBaseQuote(symbol: string): { base?: string; quote?: string } {
  if (!symbol) return {};
  const trimmed = symbol.trim();
  if (!trimmed) return {};

  const normalized = trimmed.toUpperCase();
  const [corePart, settlementPart] = normalized.split(':', 2);
  const main = corePart;
  let settlement = settlementPart;

  if (settlement) {
    settlement = settlement.split('-')[0]?.split('_')[0] ?? settlement;
  }

  let base: string | undefined;
  let quote: string | undefined;

  if (main.includes('/')) {
    const [basePart, quotePartRaw] = main.split('/', 2);
    base = basePart;
    quote = quotePartRaw;
  } else if (main.includes('-')) {
    const [basePart, quotePartRaw] = main.split('-', 2);
    base = basePart;
    quote = quotePartRaw;
  } else if (main.includes('_')) {
    const [basePart, quotePartRaw] = main.split('_', 2);
    base = basePart;
    quote = quotePartRaw;
  } else {
    const suffixes = [
      'USD_PERP',
      'USDT',
      'USDC',
      'FDUSD',
      'TUSD',
      'USDP',
      'BUSD',
      'USD',
      'BTC',
      'ETH',
      'BNB',
      'EUR',
      'TRY',
      'GBP',
    ];
    for (const suffix of suffixes) {
      if (main.endsWith(suffix)) {
        base = main.slice(0, -suffix.length);
        quote = suffix;
        break;
      }
    }
  }

  if (!quote && settlement) {
    quote = settlement;
  }

  const sanitize = (value?: string) => {
    if (!value) return undefined;
    const cleaned = value.replace(/[^A-Z0-9]/g, '');
    return cleaned.length ? cleaned : undefined;
  };

  base = sanitize(base);
  quote = sanitize(quote);

  if (quote === 'USDPERP' || quote === 'USD_PERP') {
    quote = 'USD';
  }

  return { base, quote };
}

const CAPACITY_LOG = new Map<string, number[]>();
const BREACH_WINDOW_MS = 60 * 60 * 1000;
const LIMIT_SLIP_PCT = Number(process.env.ORDER_LIMIT_SLIP_PCT || '0.15'); // percent

export function resolveOrderFillTimeoutSec(cfg: Cfg, orderType: 'market' | 'limit'): number {
  const base = Math.max(1, Number(cfg.ORDER_FILL_TIMEOUT_SEC || 0) || 0);
  if (orderType === 'limit') {
    const limit = Number(cfg.ORDER_FILL_TIMEOUT_LIMIT_SEC);
    if (Number.isFinite(limit) && limit > 0) {
      return Math.max(base, limit);
    }
  }
  return base;
}

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
    const userCredentials = await resolveUserCredentials(this.userId);
    if (!userCredentials) {
      throw new Error('User API credentials not found');
    }
    return await resolveUserExchange(this.userId, userCredentials);
  }

  async balance() {
    // 🚀 WebSocket for Binance (0 weight)
    let ex: any;
    let b: any;
    const userCredentials = await resolveUserCredentials(this.userId);

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
          ex = await this.getExchange();
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
        ex = await this.getExchange();
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
      ex = await this.getExchange();
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
    let maintenanceUsd = num(raw?.total_maint_margin)
      ?? num(raw?.totalMaintenanceMargin)
      ?? num(raw?.totalMaintMargin)
      ?? num(raw?.maintMargin);
    let marginRatio = num(raw?.margin_ratio) ?? num(raw?.marginRatio);
    let marginLevel = num(raw?.margin_level) ?? num(raw?.marginLevel);
    let marginMode = typeof raw?.margin_mode === 'string' ? String(raw.margin_mode) : undefined;

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
      if (maintenanceUsd === undefined) {
        maintenanceUsd = num(src?.total_maint_margin)
          ?? num(src?.totalMaintenanceMargin)
          ?? num(src?.totalMaintMargin)
          ?? num(src?.maintMargin);
      }
      if (marginRatio === undefined) {
        marginRatio = num(src?.margin_ratio)
          ?? num(src?.marginRatio)
          ?? num(src?.positionMarginRatio)
          ?? num(src?.info?.margin_ratio);
      }
      if (marginLevel === undefined) {
        marginLevel = num(src?.margin_level)
          ?? num(src?.marginLevel)
          ?? num(src?.info?.margin_level);
      }
      if (!marginMode && typeof src?.margin_mode === 'string') {
        marginMode = String(src.margin_mode);
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

    const normalizedFreeUsd = Number.isFinite(freeUsd) ? freeUsd : 0;
    const normalizedEquityUsd = Number.isFinite(equityUsd) ? equityUsd : 0;

    if (normalizedEquityUsd > 0 && normalizedFreeUsd <= 0) {
      console.debug('[Risk] Free balance collapsed while equity positive', {
        equityUsd: normalizedEquityUsd,
        freeUsd: normalizedFreeUsd,
      });
    }

    const pickNum = (...values: any[]) => {
      for (const value of values) {
        const parsed = num(value);
        if (parsed !== undefined) return parsed;
      }
      return undefined;
    };

    const positions: BrokerPositionMargin[] = [];
    const exposureMap = new Map<string, BrokerCorrelatedExposure>();
    let maintenanceFromPositions = 0;

    const recordExposure = (
      key: string,
      params: { base?: string; quote?: string; notional?: number; side: 'long'|'short'; symbol: string }
    ) => {
      const notional = Number(params.notional || 0);
      if (!(notional > 0)) return;
      const current = exposureMap.get(key) || {
        key,
        base: params.base,
        quote: params.quote,
        totalNotionalUsd: 0,
        longNotionalUsd: 0,
        shortNotionalUsd: 0,
        positions: [] as string[],
      };
      if (!current.base && params.base) current.base = params.base;
      if (!current.quote && params.quote) current.quote = params.quote;
      current.totalNotionalUsd += notional;
      if (params.side === 'long') current.longNotionalUsd += notional; else current.shortNotionalUsd += notional;
      if (!current.positions.includes(params.symbol)) current.positions.push(params.symbol);
      exposureMap.set(key, current);
    };

    if (!ex) {
      try { ex = await this.getExchange(); } catch {}
    }

    if (ex && typeof (ex as any).fetchPositions === 'function') {
      try {
        const fetched = await (ex as any).fetchPositions().catch(() => []);
        if (Array.isArray(fetched)) {
          for (const pos of fetched) {
            const symbolRaw = pos?.symbol || pos?.info?.symbol || pos?.info?.symbolName || '';
            const symbol = typeof symbolRaw === 'string' && symbolRaw.length ? symbolRaw : (pos?.id || 'UNKNOWN');
            const contracts = pickNum(pos?.contracts, pos?.size, pos?.positionAmt, pos?.amount, pos?.qty);
            const absQty = contracts !== undefined ? Math.abs(contracts) : pickNum(pos?.quantity, pos?.baseSize) || 0;
            if (!absQty || !(absQty > 0)) continue;
            let side: 'long'|'short' = 'long';
            const declaredSide = typeof pos?.side === 'string' ? pos.side.toLowerCase() : '';
            if (declaredSide.includes('short') || declaredSide.includes('sell')) side = 'short';
            else if (declaredSide.includes('long') || declaredSide.includes('buy')) side = 'long';
            else if (contracts !== undefined && contracts < 0) side = 'short';

            const entryPrice = pickNum(pos?.entryPrice, pos?.avgEntryPrice, pos?.average, pos?.info?.avgEntryPrice, pos?.info?.entryPrice);
            const markPrice = pickNum(pos?.markPrice, pos?.lastPrice, pos?.info?.markPrice, pos?.info?.lastPrice, pos?.info?.indexPrice);
            let notional = pickNum(pos?.notional, pos?.notionalUsd, pos?.notionalValue, pos?.positionValue, pos?.info?.notionalValue, pos?.info?.positionValue);
            if (notional === undefined && markPrice !== undefined) notional = absQty * markPrice;
            if (notional === undefined && entryPrice !== undefined) notional = absQty * entryPrice;
            const liquidationPrice = pickNum(pos?.liquidationPrice, pos?.liquidation, pos?.liqPrice, pos?.liquidationPrice1, pos?.info?.liquidationPrice, pos?.info?.liqPrice);
            const maintenance = pickNum(pos?.maintenanceMargin, pos?.maintMargin, pos?.info?.maintMargin, pos?.info?.maintenanceMargin);
            const initialMargin = pickNum(pos?.initialMargin, pos?.initialMarginUsd, pos?.marginInitial, pos?.info?.initialMargin, pos?.info?.positionInitialMargin);
            const leverage = pickNum(pos?.leverage, pos?.info?.leverage, pos?.info?.marginLeverage);
            const unrealized = pickNum(pos?.unrealizedPnl, pos?.unrealizedPnlUsd, pos?.info?.unrealizedProfit, pos?.info?.unrealisedPnl);
            const positionMarginRatio = pickNum(pos?.marginRatio, pos?.info?.marginRatio, pos?.info?.positionMarginRatio);

            const market = symbol && ex?.markets ? ex.markets[symbol] : undefined;
            const base = market?.base || (typeof symbol === 'string' && symbol.includes('/') ? symbol.split('/')[0] : undefined);
            const quote = market?.quote || (typeof symbol === 'string' && symbol.includes('/') ? symbol.split('/')[1]?.split(':')[0] : undefined);

            if (Number.isFinite(maintenance)) maintenanceFromPositions += Math.max(Number(maintenance), 0);

            const position: BrokerPositionMargin = {
              symbol,
              side,
              qty: absQty,
              notionalUsd: Number.isFinite(notional) ? Math.abs(Number(notional)) : undefined,
              entryPrice: entryPrice,
              markPrice: markPrice,
              liquidationPrice: liquidationPrice,
              maintenanceMarginUsd: Number.isFinite(maintenance) ? Number(maintenance) : undefined,
              initialMarginUsd: Number.isFinite(initialMargin) ? Number(initialMargin) : undefined,
              leverage: Number.isFinite(leverage) ? Number(leverage) : undefined,
              unrealizedPnlUsd: Number.isFinite(unrealized) ? Number(unrealized) : undefined,
              marginRatio: Number.isFinite(positionMarginRatio) ? Number(positionMarginRatio) : undefined,
              raw: pos,
            };
            positions.push(position);

            const exposureKey = base || symbol;
            recordExposure(exposureKey, {
              base,
              quote,
              notional: position.notionalUsd,
              side,
              symbol,
            });
          }
        }
      } catch (err) {
        console.debug('⚠️ Failed to fetch positions for margin snapshot:', err);
      }
    }

    if (!Number.isFinite(maintenanceUsd) && maintenanceFromPositions > 0) {
      maintenanceUsd = maintenanceFromPositions;
    } else if (Number.isFinite(maintenanceUsd) && maintenanceFromPositions > 0) {
      maintenanceUsd = Math.max(Number(maintenanceUsd), maintenanceFromPositions);
    }

    const committedUsd = computeCommittedMargin({
      equityUsd: normalizedEquityUsd,
      freeUsd: normalizedFreeUsd,
      positionCost: baseCommitted,
      openOrderMargin: ordersCommitted,
      positions,
    });

    if ((marginRatio === undefined || Number.isNaN(Number(marginRatio))) && normalizedEquityUsd > 0) {
      if (Number.isFinite(maintenanceUsd)) {
        marginRatio = Number(maintenanceUsd) / normalizedEquityUsd;
      } else {
        marginRatio = committedUsd / normalizedEquityUsd;
      }
    }

    if ((marginLevel === undefined || Number.isNaN(Number(marginLevel))) && normalizedEquityUsd > 0) {
      marginLevel = normalizedEquityUsd / Math.max(committedUsd || normalizedEquityUsd, 1e-8);
    }

    let correlatedExposure: Record<string, BrokerCorrelatedExposure> | undefined;
    if (exposureMap.size) {
      const totalExposure = Array.from(exposureMap.values()).reduce((acc, item) => acc + item.totalNotionalUsd, 0);
      correlatedExposure = {};
      exposureMap.forEach((value, key) => {
        const concentration = totalExposure > 0 ? (value.totalNotionalUsd / totalExposure) * 100 : 0;
        correlatedExposure![key] = {
          ...value,
          concentrationPct: Number.isFinite(concentration) ? concentration : undefined,
        };
      });
    }

    const snapshot: BrokerMarginSnapshot = {
      freeUsd: normalizedFreeUsd,
      equityUsd: normalizedEquityUsd,
      committedUsd,
      maintenanceMarginUsd: Number.isFinite(maintenanceUsd) ? Number(maintenanceUsd) : undefined,
      marginRatio: Number.isFinite(marginRatio) ? Number(marginRatio) : undefined,
      marginLevel: Number.isFinite(marginLevel) ? Number(marginLevel) : undefined,
      marginMode,
      positions: positions.length ? positions : undefined,
      correlatedExposure,
      timestamp: Date.now(),
    };

    return snapshot;
  }

  async place(o: NewOrder): Promise<PlacedOrder> {
    const ex = await this.getExchange();
    const symbol = await resolveSymbolWithOverrides(o.symbol);
    const startTs = Date.now();
    const { slip } = getIntradayRuntimeConfig();
    let estImpactBps: number | undefined;
    let usedDepth = false;
    let depthFallback = false;

    if (slip.bookWalkEnabled && o.type === 'market') {
      try {
        const depth = await fetchDepth(o.symbol, slip.depthLevels, this.userId);
        if (depth) {
          const walked = walkBook(o.side, o.qty, depth);
          estImpactBps = walked.impactBps;
          usedDepth = walked.filled > 0 && !walked.fallback;
          depthFallback = walked.fallback || !(walked.filled > 0);
          if (depthFallback && estImpactBps !== undefined) {
            estImpactBps *= slip.fallbackInflation;
          }
        } else {
          depthFallback = true;
        }
      } catch {
        depthFallback = true;
      }
    }

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
    const timeoutSec = resolveOrderFillTimeoutSec(cfg, o.type === 'limit' ? 'limit' : 'market');
    const deadline = Date.now() + Math.max(1000, timeoutSec * 1000);
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
    if (estImpactBps !== undefined) {
      placed.estImpactBps = estImpactBps;
    }
    if (o.type === 'market') {
      placed.usedDepth = usedDepth;
      placed.depthFallback = depthFallback;
    }

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
    const symbol = await resolveSymbolWithOverrides(params.symbol);
    const { slip } = getIntradayRuntimeConfig();
    const maxImpactPct = params.maxImpactPct ?? Number(process.env.ORDER_MAX_IMPACT_PCT || '0.35');
    let market: any;
    try {
      const isBinanceExchange = String((ex as any)?.id || '').toLowerCase().includes('binance');
      if (!ex.markets && !isBinanceExchange) { await ex.loadMarkets(); }
      market = ex.market ? ex.market(symbol) : ex.markets?.[symbol];
    } catch {}

    let minQty: number | undefined;
    try {
      minQty = Number(market?.limits?.amount?.min);
    } catch {}

    const desiredQty = Math.max(0, params.desiredQty || 0);
    if (!(desiredQty > 0)) {
      return { fillableQty: desiredQty, impactPct: 0, minQty };
    }

    let depthSim: ReturnType<typeof walkBook> | null = null;
    if (slip.bookWalkEnabled) {
      try {
        const depth = await fetchDepth(params.symbol, slip.depthLevels, this.userId);
        if (depth) {
          depthSim = walkBook(params.side, desiredQty, depth);
        }
      } catch {}
    }

    const usedDepth = Boolean(depthSim && depthSim.filled > 0 && !depthSim.fallback);
    let fillableQty = depthSim ? Math.min(desiredQty, depthSim.filled > 0 ? depthSim.filled : desiredQty) : desiredQty;
    if (!(fillableQty > 0)) {
      fillableQty = desiredQty;
    }

    let impactPct = depthSim ? Math.max(0, depthSim.impactBps / 100) : 0;
    let fallback = !depthSim || depthSim.fallback || !(depthSim.filled > 0);

    if (fallback) {
      try {
        const ticker = await ex.fetchTicker(symbol);
        const bid = Number(ticker?.bid);
        const ask = Number(ticker?.ask);
        const best = params.side === 'buy' ? ask : bid;
        const other = params.side === 'buy' ? bid : ask;
        if (Number.isFinite(best) && Number.isFinite(other) && best > 0 && other > 0) {
          const spread = Math.abs(best - other);
          const baseImpact = (spread / best) * 100;
          if (Number.isFinite(baseImpact)) {
            impactPct = Math.max(impactPct, baseImpact * slip.fallbackInflation);
          }
        }
      } catch {}
    }

    if (impactPct > maxImpactPct && maxImpactPct > 0) {
      const scale = maxImpactPct / Math.max(0.0001, impactPct);
      fillableQty = Math.min(fillableQty, desiredQty * Math.max(0, Math.min(1, scale)));
      if (minQty) {
        fillableQty = Math.max(fillableQty, minQty);
      }
    }

    fillableQty = Math.max(0, Math.min(desiredQty, fillableQty));
    return {
      fillableQty,
      impactPct,
      minQty,
      usedDepth,
      simFallback: fallback,
      simImpactBps: impactPct * 100,
    } as any;
  }

  async syncProtective(params: { symbol: string; side: 'buy'|'sell'; qty: number; stopLoss?: number; takeProfit?: number | number[]; slOrderId?: string|null; tpOrderId?: string|null }) {
    const ex = await this.getExchange();
    const symbol = await resolveSymbolWithOverrides(params.symbol);
    const reduceSide = params.side === 'buy' ? 'sell' : 'buy';
    const result: { slOrderId?: string | null; tpOrderId?: string | null } = {};
    const tpLevels = Array.isArray(params.takeProfit)
      ? params.takeProfit.filter(v => typeof v === 'number' && Number.isFinite(v))
      : (typeof params.takeProfit === 'number' && Number.isFinite(params.takeProfit) ? [params.takeProfit] : []);
    const primaryTp = tpLevels[0];

    const pickNum = (...values: any[]) => {
      for (const value of values) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return undefined;
    };

    const normalizeId = (order: any) => String(order?.id || order?.clientOrderId || order?.orderId || order?.info?.orderId || '');
    const toLower = (value: any) => String(value ?? '').toLowerCase();
    const desiredStop = Number(params.stopLoss);
    const stopLossValid = params.stopLoss !== undefined && params.stopLoss !== null && Number.isFinite(desiredStop);
    const wantsStop = stopLossValid && params.qty > 0;
    const wantsTp = primaryTp !== undefined && params.qty > 0;

    let openOrders: any[] = [];
    try {
      const fetched = await ex.fetchOpenOrders(symbol).catch(() => []);
      if (Array.isArray(fetched)) openOrders = fetched;
    } catch {}

    const reduceOrders = openOrders.filter(order => {
      const orderSide = toLower(order?.side ?? order?.info?.side);
      if (orderSide && orderSide !== reduceSide) return false;
      const reduceOnly = Boolean((order as any)?.reduceOnly || (order as any)?.reduce_only || (order?.info && ((order.info.reduceOnly ?? order.info.reduce_only) === true)));
      return reduceOnly || orderSide === reduceSide;
    });

    const stopOrders = reduceOrders.filter(order => {
      const type = toLower(order?.type ?? order?.info?.type);
      const stopPrice = pickNum((order as any)?.stopPrice, (order as any)?.triggerPrice, order?.info?.stopPrice, order?.info?.triggerPrice);
      return type.includes('stop') || type.includes('trigger') || stopPrice !== undefined;
    });

    const tpOrders = reduceOrders.filter(order => {
      const type = toLower(order?.type ?? order?.info?.type);
      if (type.includes('stop') || type.includes('trigger')) return false;
      if (type.includes('take')) return true;
      const limitPrice = pickNum(order?.price, order?.info?.price, order?.info?.avgPrice);
      return type.includes('limit') && limitPrice !== undefined;
    });

    const cancelOrderSafe = async (order: any) => {
      const id = normalizeId(order);
      if (!id) return;
      try { await ex.cancelOrder(id, symbol).catch(()=>{}); } catch {}
    };

    if (!wantsStop) {
      for (const order of stopOrders) {
        await cancelOrderSafe(order);
      }
      if (stopOrders.length) {
        result.slOrderId = null;
      }
    }

    if (!wantsTp) {
      for (const order of tpOrders) {
        await cancelOrderSafe(order);
      }
      if (tpOrders.length) {
        result.tpOrderId = null;
      }
    }

    const tolerate = (target: number) => Math.max(0.0001, Math.abs(target) * 0.001);

    const selectStopOrder = () => {
      if (!stopOrders.length) return null;
      if (params.slOrderId) {
        const match = stopOrders.find(order => normalizeId(order) === params.slOrderId);
        if (match) return match;
      }
      if (!Number.isFinite(desiredStop)) return stopOrders[0] ?? null;
      const tolerance = tolerate(desiredStop);
      let candidate: any = null;
      let bestGap = Number.POSITIVE_INFINITY;
      for (const order of stopOrders) {
        const maybePrice = pickNum((order as any)?.stopPrice, (order as any)?.triggerPrice, order?.info?.stopPrice, order?.info?.triggerPrice, order?.info?.price);
        if (!Number.isFinite(maybePrice)) continue;
        const orderPrice = Number(maybePrice);
        const gap = Math.abs(orderPrice - desiredStop);
        if (gap <= tolerance && gap < bestGap) {
          bestGap = gap;
          candidate = order;
        }
      }
      return candidate;
    };

    const selectTpOrder = () => {
      if (!tpOrders.length) return null;
      if (params.tpOrderId) {
        const match = tpOrders.find(order => normalizeId(order) === params.tpOrderId);
        if (match) return match;
      }
      if (!Number.isFinite(primaryTp)) return tpOrders[0] ?? null;
      const tolerance = tolerate(primaryTp);
      let candidate: any = null;
      let bestGap = Number.POSITIVE_INFINITY;
      for (const order of tpOrders) {
        const maybePrice = pickNum(order?.price, order?.info?.price, order?.info?.avgPrice, order?.info?.takeProfitPrice);
        if (!Number.isFinite(maybePrice)) continue;
        const orderPrice = Number(maybePrice);
        const gap = Math.abs(orderPrice - primaryTp);
        if (gap <= tolerance && gap < bestGap) {
          bestGap = gap;
          candidate = order;
        }
      }
      return candidate;
    };

    let retainedStop: any = null;
    if (wantsStop) {
      const current = selectStopOrder();
      const desiredPrice = Number.isFinite(desiredStop) ? desiredStop : undefined;
      const tolerance = desiredPrice !== undefined ? tolerate(desiredPrice) : undefined;
      const currentPrice = current ? pickNum((current as any)?.stopPrice, (current as any)?.triggerPrice, current?.info?.stopPrice, current?.info?.triggerPrice, current?.info?.price) : undefined;
      const priceMatches = desiredPrice === undefined || (Number.isFinite(currentPrice) && Math.abs(currentPrice! - desiredPrice) <= (tolerance ?? 0));
      for (const order of stopOrders) {
        if (order === current) continue;
        await cancelOrderSafe(order);
      }
      if (current && priceMatches) {
        retainedStop = current;
      } else {
        if (current) {
          await cancelOrderSafe(current);
        }
        if (Number.isFinite(desiredStop) && params.qty > 0) {
          try {
            const slParams: any = { reduceOnly: true, stopPrice: desiredStop, triggerPrice: desiredStop };
            if (String(ex.id).toLowerCase() === 'cryptocom') slParams.type = 'stop_market';
            const slo = await ex.createOrder(symbol, 'market', reduceSide, params.qty, undefined, slParams);
            retainedStop = slo;
          } catch {}
        }
      }
      if (retainedStop) {
        result.slOrderId = normalizeId(retainedStop) || null;
      } else if (result.slOrderId === undefined && wantsStop) {
        result.slOrderId = null;
      }
    }

    let retainedTp: any = null;
    if (wantsTp) {
      const current = selectTpOrder();
      const desiredPrice = Number.isFinite(primaryTp) ? Number(primaryTp) : undefined;
      const tolerance = desiredPrice !== undefined ? tolerate(desiredPrice) : undefined;
      const currentPrice = current ? pickNum(current?.price, current?.info?.price, current?.info?.avgPrice, current?.info?.takeProfitPrice) : undefined;
      const priceMatches = desiredPrice === undefined || (Number.isFinite(currentPrice) && Math.abs(currentPrice! - desiredPrice) <= (tolerance ?? 0));
      for (const order of tpOrders) {
        if (order === current) continue;
        await cancelOrderSafe(order);
      }
      if (current && priceMatches) {
        retainedTp = current;
      } else {
        if (current) {
          await cancelOrderSafe(current);
        }
        if (desiredPrice !== undefined && params.qty > 0) {
          try {
            const tpParams: any = { reduceOnly: true, takeProfitPrice: desiredPrice };
            if (String(ex.id).toLowerCase() === 'cryptocom') tpParams.type = 'take_profit_limit';
            const tpo = await ex.createOrder(symbol, 'limit', reduceSide, params.qty, desiredPrice, tpParams);
            retainedTp = tpo;
          } catch {}
        }
      }
      if (retainedTp) {
        result.tpOrderId = normalizeId(retainedTp) || null;
      } else if (result.tpOrderId === undefined && wantsTp) {
        result.tpOrderId = null;
      }
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

  const userCredentials = await resolveUserCredentials(userId);
  if (!userCredentials) {
    return null;
  }

  const ex = await resolveUserExchange(userId, userCredentials);
  const s = await resolveSymbolWithOverrides(symbol, userId);
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
    const market = ex?.markets?.[s];
    const inferred = inferBaseQuote(s);
    const base = market?.base?.toUpperCase() || inferred.base;
    const quote = market?.quote?.toUpperCase() || inferred.quote;
    if (marketType === 'spot' && base) {

      // 🚀 WebSocket for Binance (0 weight)
      let b: any;
      if (userId && userCredentials?.exchange === 'binance' && quote === 'USDT') {
        try {
          const { getBalanceFromWebSocket, seedBalanceCache, runExclusiveBalanceFetch } = await import('../services/binanceWebSocket.js');
          const assetKey = base;
          const wsBalance = await getBalanceFromWebSocket(userId, assetKey);
          if (wsBalance) {
            b = { total: { [base]: wsBalance.total }, free: { [base]: wsBalance.free } };
            console.log(`✅ [WebSocket] Balance for ghost exposure - 0 weight`);
          } else {
            b = await runExclusiveBalanceFetch(userId, assetKey, () => ex.fetchBalance());
            try {
              const total = Number(b?.total?.[base] ?? 0);
              const free = Number(b?.free?.[base] ?? 0);
              const locked = Number(b?.used?.[base] ?? 0);
              if (Number.isFinite(total) || Number.isFinite(free) || Number.isFinite(locked)) {
                seedBalanceCache(userId, assetKey, { total, free, locked });
              }
            } catch {}
          }
        } catch (error) {
          const { runExclusiveBalanceFetch, seedBalanceCache } = await import('../services/binanceWebSocket.js');
          const assetKey = base;
          b = await runExclusiveBalanceFetch(userId, assetKey, () => ex.fetchBalance());
          try {
            const total = Number(b?.total?.[base] ?? 0);
            const free = Number(b?.free?.[base] ?? 0);
            const locked = Number(b?.used?.[base] ?? 0);
            if (Number.isFinite(total) || Number.isFinite(free) || Number.isFinite(locked)) {
              seedBalanceCache(userId, assetKey, { total, free, locked });
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
