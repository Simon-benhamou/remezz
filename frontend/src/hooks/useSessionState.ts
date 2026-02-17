/**
 * V5.72: useSessionState Hook
 *
 * Centralized session state management for the Cockpit page redesign.
 * Handles data fetching, WebSocket subscriptions, and real-time updates.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api } from '../api';
import { wsManager } from '../ws';
import type {
  Session,
  SessionState,
  SessionMode,
  Position,
  TickerData,
  AgentState,
  Order,
  Trade,
  PerformanceMetrics,
  ParityResult,
  ActivityEvent,
  HealthStatus,
  TrailingState,
} from '../types/cockpit';

// ============================================================================
// TYPES
// ============================================================================

export interface UseSessionStateOptions {
  sessionId: string;
  autoRefresh?: boolean;
  refreshInterval?: number;
}

export interface SessionStateData {
  // Session info
  session: Session | null;
  symbol: string;
  mode: SessionMode;
  state: SessionState;
  isLoading: boolean;
  error: string | null;

  // Agent state
  agent: AgentState | null;
  hasPosition: boolean;
  position: Position | null;

  // Market data
  ticker: TickerData | null;
  tickerStatus: 'loading' | 'live' | 'stale' | 'error';
  currentPrice: number | null;

  // Orders & Trades
  orders: Order[];
  trades: Trade[];
  activeOrders: Order[];

  // Performance
  performance: PerformanceMetrics | null;
  parity: ParityResult | null;

  // Activity
  activityEvents: ActivityEvent[];

  // Connection
  wsConnected: boolean;
  lastUpdate: number;

  // Derived data for UI
  netPnl: number;
  roiPct: number;
  sparklineData: number[];
}

export interface SessionStateActions {
  refresh: () => Promise<void>;
  refreshTicker: () => Promise<void>;
  refreshOrders: () => Promise<void>;
  refreshTrades: () => Promise<void>;
  refreshPerformance: () => Promise<void>;
  refreshParity: () => Promise<void>;
  refreshActivity: () => Promise<void>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

const OPEN_ORDER_STATUSES = new Set([
  'new',
  'open',
  'working',
  'pending',
  'accepted',
  'partially_filled',
]);

const STALE_THRESHOLD_MS = 15_000;
const DEFAULT_REFRESH_INTERVAL = 30_000;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function deriveSymbol(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input.toUpperCase();
  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>;
    if (typeof obj.symbol === 'string') return obj.symbol.toUpperCase();
    if (typeof obj.ticker === 'string') return obj.ticker.toUpperCase();
    const base = obj.base;
    const quote = obj.quote;
    if (typeof base === 'string' && typeof quote === 'string') {
      return `${base}${quote}`.toUpperCase();
    }
  }
  return '';
}

function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/[/:]/g, '');
}

function mapApiPosition(apiPos: any, currentPrice: number): Position | null {
  if (!apiPos) return null;

  const entryPrice = Number(apiPos.entryPrice) || 0;
  const entryTime = apiPos.entryTime || apiPos.entryTs || Date.now();
  const qty = Number(apiPos.qty) || 0;
  const side = apiPos.side || 'long';
  const stopPrice = Number(apiPos.stopPrice || apiPos.stop) || 0;

  // Calculate PnL
  const priceDiff = side === 'long'
    ? currentPrice - entryPrice
    : entryPrice - currentPrice;
  const pnlPct = entryPrice > 0 ? (priceDiff / entryPrice) * 100 : 0;
  const pnlUsd = priceDiff * qty;
  const notionalUsd = currentPrice * qty;

  // Duration
  const duration = Date.now() - (typeof entryTime === 'number' ? entryTime : new Date(entryTime).getTime());

  // Peak and distance from peak
  const peakPrice = Number(apiPos.peakPrice || (side === 'long' ? currentPrice : entryPrice)) || currentPrice;
  const distanceFromPeak = side === 'long'
    ? ((peakPrice - currentPrice) / peakPrice) * 100
    : ((currentPrice - peakPrice) / peakPrice) * 100;

  // Stop distance
  const stopDistancePct = stopPrice > 0
    ? Math.abs((currentPrice - stopPrice) / currentPrice) * 100
    : 0;

  // Trailing state from backend
  const trailingState: TrailingState = apiPos.trailingState || {
    active: apiPos.trailingActive || false,
    activatedAt: apiPos.trailingActivatedAt || null,
    updateCount: apiPos.trailingUpdateCount || 0,
    currentStopPrice: stopPrice || undefined,
    peakPrice: peakPrice,
    distanceFromPeak: distanceFromPeak,
  };

  // Health status from backend or derive
  let healthStatus: HealthStatus = apiPos.healthStatus || 'watching';
  let healthReason = apiPos.healthReason || '';

  if (!apiPos.healthStatus) {
    // Derive health status if not provided
    if (pnlPct > 0.5 && trailingState.active) {
      healthStatus = 'progressing';
      healthReason = 'In profit with trailing stop active';
    } else if (apiPos.stagnantState?.triggered) {
      healthStatus = 'stagnant';
      healthReason = 'Price stagnant for extended period';
    } else if (stopDistancePct < 0.5) {
      healthStatus = 'at_risk';
      healthReason = 'Close to stop loss';
    } else {
      healthStatus = 'watching';
      healthReason = 'Monitoring position';
    }
  }

  return {
    symbol: apiPos.symbol || '',
    side,
    entryPrice,
    currentPrice,
    qty,
    entryTime: typeof entryTime === 'number' ? entryTime : new Date(entryTime).getTime(),
    pnlUsd,
    pnlPct,
    notionalUsd,
    duration,
    stopPrice,
    stopLoss: apiPos.stopLoss,
    targets: apiPos.targets,
    trailingState,
    trailDistance: apiPos.trailDistance,
    healthStatus,
    healthReason,
    peakPrice,
    distanceFromPeak,
    stopDistancePct,
    leverage: apiPos.leverage,
    marginUsd: apiPos.marginUsd,
    maxPnlPct: apiPos.maxPnlPct,
    stagnantState: apiPos.stagnantState,
  };
}

function mapApiOrder(apiOrder: any): Order {
  return {
    id: apiOrder.id || apiOrder.orderId || '',
    sessionId: apiOrder.sessionId || '',
    symbol: apiOrder.symbol || '',
    side: apiOrder.side || 'buy',
    type: apiOrder.type || 'market',
    price: apiOrder.price,
    qty: Number(apiOrder.qty || apiOrder.amount || 0),
    status: apiOrder.status || 'pending',
    createdAt: apiOrder.createdAt || new Date().toISOString(),
    filledAt: apiOrder.filledAt,
    avgPrice: apiOrder.avgPrice || apiOrder.average,
    clientOrderId: apiOrder.clientOrderId,
  };
}

function mapApiTrade(apiTrade: any): Trade {
  // Backend returns createdAt: trade.exitTs, so check multiple field names
  const exitTs = apiTrade.exitTs || apiTrade.exitTime || apiTrade.createdAt || '';
  return {
    id: apiTrade.id || '',
    sessionId: apiTrade.sessionId || '',
    symbol: apiTrade.symbol || '',
    positionSide: apiTrade.positionSide || apiTrade.side || 'long',
    qty: Number(apiTrade.qty || 0),
    entryPrice: Number(apiTrade.entryPrice || 0),
    exitPrice: Number(apiTrade.exitPrice || 0),
    entryTs: apiTrade.entryTs || apiTrade.entryTime || '',
    exitTs,
    realizedPnlUsd: Number(apiTrade.realizedPnlUsd || apiTrade.pnlUsd || 0),
    pctChange: Number(apiTrade.pctChange || apiTrade.roiPct || 0),
    feesUsd: Number(apiTrade.feesUsd || 0),
    exitReason: apiTrade.exitReason,
    durationMinutes: apiTrade.durationMinutes,
  };
}

function mapApiActivityEvent(log: any, symbol: string): ActivityEvent {
  return {
    timestamp: log.timestamp || new Date().toISOString(),
    sessionId: log.sessionId || '',
    symbol: log.symbol || symbol,
    kind: log.kind || 'info',
    message: log.message || '',
    level: log.level || 'info',
    details: log.details,
  };
}

// ============================================================================
// HOOK IMPLEMENTATION
// ============================================================================

export function useSessionState(
  options: UseSessionStateOptions
): [SessionStateData, SessionStateActions] {
  const { sessionId, autoRefresh = true, refreshInterval = DEFAULT_REFRESH_INTERVAL } = options;

  // Core state
  const [session, setSession] = useState<Session | null>(null);
  const [symbol, setSymbol] = useState<string>('');
  const [mode, setMode] = useState<SessionMode>('paper');
  const [state, setState] = useState<SessionState>('WATCHING');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Agent state
  const [agent, setAgent] = useState<AgentState | null>(null);

  // Market data
  const [ticker, setTicker] = useState<TickerData | null>(null);
  const [tickerStatus, setTickerStatus] = useState<'loading' | 'live' | 'stale' | 'error'>('loading');
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);

  // Orders & Trades
  const [orders, setOrders] = useState<Order[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);

  // Performance
  const [performance, setPerformance] = useState<PerformanceMetrics | null>(null);
  const [parity, setParity] = useState<ParityResult | null>(null);

  // Activity
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);

  // Connection
  const [wsConnected, setWsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(Date.now());

  // Sparkline data for PnL visualization
  const [sparklineData, setSparklineData] = useState<number[]>([]);

  // Refs
  const lastTickerUpdateRef = useRef<number>(0);
  const mountedRef = useRef(true);

  // ============================================================================
  // FETCH FUNCTIONS
  // ============================================================================

  const fetchSessionStatus = useCallback(async () => {
    if (!sessionId) return;
    try {
      const status = await api.status(sessionId, { includeBalance: false, includeTech: false });
      if (!mountedRef.current) return;

      if (status?.session) {
        setSession({
          id: status.session.id,
          symbol: status.session.symbol,
          mode: status.session.mode,
          state: status.session.state,
          startedAt: status.session.startedAt || status.session.createdAt,
          stoppedAt: status.session.stoppedAt,
          profileJson: status.session.profileJson,
        });
        setSymbol(deriveSymbol(status.session.symbol) || deriveSymbol(status.symbol));
        setMode(status.session.mode || 'paper');
        setState(status.session.state || 'WATCHING');
        if (status.price) setCurrentPrice(Number(status.price));
      }
      setError(null);
    } catch (err: any) {
      if (!mountedRef.current) return;
      const detail = err?.response?.data?.error || err?.message || String(err);
      setError(detail);
    }
  }, [sessionId]);

  const fetchAgentState = useCallback(async () => {
    if (!sessionId) return;
    try {
      const agentData = await api.getAgentState(sessionId);
      if (!mountedRef.current) return;

      if (agentData) {
        const price = currentPrice || Number(agentData.pos?.currentPrice) || 0;
        const position = mapApiPosition(agentData.pos, price);

        setAgent({
          running: agentData.running,
          state: agentData.state,
          hasPosition: agentData.hasPosition || !!agentData.pos,
          symbol: agentData.symbol,
          sessionId: agentData.sessionId || sessionId,
          mode: agentData.mode || mode,
          pos: position,
          plan: agentData.plan || null,
          exit: agentData.exit || null,
          profile: agentData.profile || {
            riskPerTradePct: 1,
            dailyLossLimitPct: 5,
            maxLeverage: 10,
            aggressiveness: 'moderate',
            availableUsd: 0,
          },
          balance: agentData.balance || { freeUsd: 0, totalUsd: 0 },
          marketConditions: agentData.marketConditions,
          lastTickAt: agentData.lastTickAt || Date.now(),
          tickCount: agentData.tickCount || 0,
        });

        if (agentData.state) setState(agentData.state);
      }
    } catch (err) {
      console.warn('Failed to fetch agent state:', err);
    }
  }, [sessionId, currentPrice, mode]);

  const fetchTicker = useCallback(async (silent = false) => {
    if (!symbol) return;
    if (!silent) setTickerStatus('loading');

    try {
      const tickerData = await api.getTicker(symbol);
      if (!mountedRef.current) return;

      const mappedTicker: TickerData = {
        symbol: tickerData.symbol || symbol,
        price: Number(tickerData.last || tickerData.price) || 0,
        change24h: Number(tickerData.change) || 0,
        changePct24h: Number(tickerData.percentage) || 0,
        high24h: Number(tickerData.high) || 0,
        low24h: Number(tickerData.low) || 0,
        volume24h: Number(tickerData.quoteVolume || tickerData.baseVolume) || 0,
        bid: tickerData.bid,
        ask: tickerData.ask,
        timestamp: tickerData.timestamp || Date.now(),
      };

      setTicker(mappedTicker);
      setCurrentPrice(mappedTicker.price);
      setTickerStatus('live');
      lastTickerUpdateRef.current = Date.now();
    } catch (err: any) {
      if (!mountedRef.current) return;
      console.warn('Failed to fetch ticker:', err);
      setTickerStatus('error');
    }
  }, [symbol]);

  const fetchOrders = useCallback(async () => {
    if (!sessionId) return;
    try {
      const ordersData = await api.getOrders(sessionId);
      if (!mountedRef.current) return;

      const arr = Array.isArray(ordersData) ? ordersData : (ordersData?.orders || []);
      setOrders(arr.map(mapApiOrder));
    } catch (err) {
      console.warn('Failed to fetch orders:', err);
    }
  }, [sessionId]);

  const fetchTrades = useCallback(async () => {
    if (!sessionId) return;
    try {
      const tradesData = await api.getTrades(sessionId);
      if (!mountedRef.current) return;

      const arr = Array.isArray(tradesData) ? tradesData : (tradesData?.trades || []);
      const mappedTrades = arr.map(mapApiTrade);
      setTrades(mappedTrades);

      // Update sparkline from recent trades
      const recentPnls = arr.slice(0, 20).map((t: any) => Number(t.pctChange || t.roiPct || 0)).reverse();
      setSparklineData(recentPnls);

      // Calculate performance from trades directly (more reliable than Order-based calculation)
      if (mappedTrades.length > 0) {
        const wins = mappedTrades.filter((t: Trade) => t.realizedPnlUsd > 0).length;
        const losses = mappedTrades.filter((t: Trade) => t.realizedPnlUsd < 0).length;
        const totalTrades = mappedTrades.length;
        const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

        const winningTrades = mappedTrades.filter((t: Trade) => t.pctChange > 0);
        const losingTrades = mappedTrades.filter((t: Trade) => t.pctChange < 0);
        const avgWin = winningTrades.length > 0
          ? winningTrades.reduce((sum: number, t: Trade) => sum + t.pctChange, 0) / winningTrades.length
          : 0;
        const avgLoss = losingTrades.length > 0
          ? losingTrades.reduce((sum: number, t: Trade) => sum + t.pctChange, 0) / losingTrades.length
          : 0;

        const winRateFrac = totalTrades > 0 ? wins / totalTrades : 0;
        const expectancy = winRateFrac * avgWin + (1 - winRateFrac) * avgLoss;

        setPerformance({
          winRate,
          expectancy,
          totalTrades,
          wins,
          losses,
          avgWin,
          avgLoss,
        });
      }
    } catch (err) {
      console.warn('Failed to fetch trades:', err);
    }
  }, [sessionId]);

  const fetchPerformance = useCallback(async () => {
    if (!sessionId) return;
    try {
      const breakdown = await api.getPerfBreakdown(sessionId);
      if (!mountedRef.current) return;

      // Only set performance from backend if it has actual data
      // Otherwise, let fetchTrades calculate it from trades
      if (breakdown?.totals && breakdown.totals.n > 0) {
        setPerformance({
          winRate: (breakdown.totals.wins / breakdown.totals.n) * 100,
          expectancy: breakdown.totals.expectancy || 0,
          totalTrades: breakdown.totals.n,
          wins: breakdown.totals.wins || 0,
          losses: breakdown.totals.losses || 0,
          avgWin: breakdown.totals.avgWin || 0,
          avgLoss: breakdown.totals.avgLoss || 0,
        });
      }
      // If breakdown returns 0 trades, don't overwrite - let fetchTrades handle it
    } catch (err) {
      console.warn('Failed to fetch performance:', err);
    }
  }, [sessionId]);

  const fetchParity = useCallback(async () => {
    if (!sessionId) return;
    try {
      const parityData = await api.client.get('/api/perf/parity', {
        params: { sessionId },
      });
      if (!mountedRef.current) return;

      if (parityData.data) {
        setParity({
          totalTrades: parityData.data.totalTrades || 0,
          verifiedTrades: parityData.data.verifiedTrades || 0,
          matchedTrades: parityData.data.matchedTrades || 0,
          matchRate: parityData.data.matchRate || 100,
          status: parityData.data.status || 'healthy',
          mismatches: parityData.data.mismatches || [],
        });
      }
    } catch (err) {
      console.warn('Failed to fetch parity:', err);
    }
  }, [sessionId]);

  const fetchActivity = useCallback(async () => {
    if (!sessionId || !symbol) return;
    try {
      const baseSymbol = symbol.split('/')[0];
      const res = await api.getAgentLogs(undefined, 50, 'memory', baseSymbol);
      if (!mountedRef.current) return;

      if (res?.logs) {
        // Filter to this session and map
        const sessionLogs = res.logs
          .filter((l: any) => !l.sessionId || l.sessionId === sessionId)
          .slice(0, 30)
          .map((l: any) => mapApiActivityEvent(l, symbol));
        setActivityEvents(sessionLogs);
      }
    } catch (err) {
      console.warn('Failed to fetch activity:', err);
    }
  }, [sessionId, symbol]);

  // Combined refresh
  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      // First batch: fetch all data in parallel (except trades which calculates performance)
      await Promise.all([
        fetchSessionStatus(),
        fetchAgentState(),
        fetchTicker(),
        fetchOrders(),
        fetchParity(),
        fetchActivity(),
      ]);
      // Then fetch trades which also calculates performance from the actual trades
      // This ensures performance is always calculated from trades, not the Orders-based endpoint
      await fetchTrades();
      setLastUpdate(Date.now());
    } finally {
      setIsLoading(false);
    }
  }, [
    fetchSessionStatus,
    fetchAgentState,
    fetchTicker,
    fetchOrders,
    fetchTrades,
    fetchParity,
    fetchActivity,
  ]);

  // ============================================================================
  // WEBSOCKET SETUP
  // ============================================================================

  useEffect(() => {
    if (!sessionId || !symbol) return;

    // Ensure the shared connection is open
    wsManager.connect(API_BASE);

    // Register a backend subscription for this symbol + session
    const unsubSub = wsManager.subscribeSub({ symbol, sessionId });

    // Connection status listener
    const unsubConn = wsManager.onConnection((connected) => setWsConnected(connected));

    // Helper: filter messages by session
    const forThisSession = (msg: any): boolean => {
      if (msg?.sessionId && msg.sessionId !== sessionId) return false;
      return true;
    };

    // Subscribe to sub_ok to send fetch_now
    const unsubSubOk = wsManager.subscribe('sub_ok', () => {
      try { wsManager.send({ type: 'fetch_now' }); } catch {}
    });

    // Subscribe to tick messages
    const unsubTick = wsManager.subscribe('tick', (msg: any) => {
      if (!forThisSession(msg)) return;
      const msgSymbol = normalizeSymbol(msg.data?.symbol || '');
      const curSymbol = normalizeSymbol(symbol);
      if (msgSymbol === curSymbol) {
        setCurrentPrice(Number(msg.data.price));
        setLastUpdate(Date.now());
      }
    });

    // Subscribe to price_update messages
    const unsubPrice = wsManager.subscribe('price_update', (msg: any) => {
      if (!forThisSession(msg)) return;
      const { symbol: msgSymbol, last } = msg.data;
      const curSymbol = normalizeSymbol(symbol);
      const receivedSymbol = normalizeSymbol(msgSymbol || '');
      if (curSymbol === receivedSymbol && last) {
        setCurrentPrice(Number(last));
        setTicker((prev) =>
          prev
            ? {
                ...prev,
                price: Number(last),
                bid: msg.data.bid ?? prev.bid,
                ask: msg.data.ask ?? prev.ask,
                timestamp: msg.data.timestamp || Date.now(),
              }
            : prev
        );
        setTickerStatus('live');
        lastTickerUpdateRef.current = Date.now();
      }
    });

    // Subscribe to analysis messages
    const unsubAnalysis = wsManager.subscribe('analysis', (msg: any) => {
      if (!forThisSession(msg)) return;
      const tech = msg.data?.technical;
      if (tech?.last) {
        setCurrentPrice(Number(tech.last));
        setTicker((prev) =>
          prev
            ? {
                ...prev,
                price: Number(tech.last),
                high24h: tech.high24h ?? prev.high24h,
                low24h: tech.low24h ?? prev.low24h,
                volume24h: tech.quoteVolume24h ?? prev.volume24h,
                change24h: tech.change24h ?? prev.change24h,
                changePct24h: tech.percentage24h ?? prev.changePct24h,
                timestamp: Date.now(),
              }
            : prev
        );
        setTickerStatus('live');
        lastTickerUpdateRef.current = Date.now();
      }
    });

    // Subscribe to agent_state messages
    const unsubAgentState = wsManager.subscribe('agent_state', (msg: any) => {
      if (!forThisSession(msg)) return;
      fetchAgentState();
      if (msg.data?.exit) {
        fetchPerformance();
        fetchTrades();
      }
    });

    // Subscribe to session messages
    const unsubSession = wsManager.subscribe('session', (msg: any) => {
      if (!forThisSession(msg)) return;
      if (msg.data?.state) setState(msg.data.state);
      if (msg.data?.symbol) setSymbol(msg.data.symbol);
      fetchOrders();
      fetchTrades();
    });

    // Subscribe to orders messages
    const unsubOrders = wsManager.subscribe('orders', (msg: any) => {
      if (!forThisSession(msg)) return;
      const ordersData = msg.data;
      const arr = Array.isArray(ordersData) ? ordersData : (ordersData?.orders || []);
      setOrders(arr.map(mapApiOrder));
      fetchAgentState();
    });

    // Subscribe to alert messages
    const unsubAlert = wsManager.subscribe('alert', (msg: any) => {
      if (!forThisSession(msg)) return;
      setActivityEvents((prev) => [
        mapApiActivityEvent({ ...msg.data, kind: 'warn' }, symbol),
        ...prev,
      ].slice(0, 50));
    });

    // Subscribe to radar_event messages
    const unsubRadar = wsManager.subscribe('radar_event', (msg: any) => {
      if (!forThisSession(msg)) return;
      setActivityEvents((prev) => [
        mapApiActivityEvent(msg.data, symbol),
        ...prev,
      ].slice(0, 50));
    });

    return () => {
      unsubSub();
      unsubConn();
      unsubSubOk();
      unsubTick();
      unsubPrice();
      unsubAnalysis();
      unsubAgentState();
      unsubSession();
      unsubOrders();
      unsubAlert();
      unsubRadar();
    };
  }, [sessionId, symbol, fetchAgentState, fetchPerformance, fetchTrades, fetchOrders]);

  // ============================================================================
  // INITIAL LOAD & AUTO-REFRESH
  // ============================================================================

  // Initial load
  useEffect(() => {
    mountedRef.current = true;
    if (sessionId) {
      refresh();
    }
    return () => {
      mountedRef.current = false;
    };
  }, [sessionId]);

  // Symbol change triggers ticker fetch
  useEffect(() => {
    if (symbol) {
      fetchTicker();
    }
  }, [symbol, fetchTicker]);

  // Auto-refresh on interval
  useEffect(() => {
    if (!autoRefresh || !sessionId) return;

    const interval = setInterval(() => {
      // Skip polling when tab is not visible
      if (document.hidden) return;
      fetchAgentState();
      fetchActivity();
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [autoRefresh, sessionId, refreshInterval, fetchAgentState, fetchActivity]);

  // Stale ticker detection
  useEffect(() => {
    const interval = setInterval(() => {
      // Skip stale detection when tab is not visible
      if (document.hidden) return;
      if (tickerStatus === 'live' && lastTickerUpdateRef.current) {
        const age = Date.now() - lastTickerUpdateRef.current;
        if (age > STALE_THRESHOLD_MS) {
          setTickerStatus('stale');
        }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [tickerStatus]);

  // ============================================================================
  // DERIVED VALUES
  // ============================================================================

  const hasPosition = useMemo(() => !!agent?.pos, [agent?.pos]);

  const position = useMemo(() => {
    if (!agent?.pos || !currentPrice) return null;
    return mapApiPosition(agent.pos, currentPrice);
  }, [agent?.pos, currentPrice]);

  const activeOrders = useMemo(
    () => orders.filter((o) => OPEN_ORDER_STATUSES.has(String(o.status).toLowerCase())),
    [orders]
  );

  const netPnl = useMemo(() => {
    const realized = trades.reduce((sum, t) => sum + (t.realizedPnlUsd || 0) - (t.feesUsd || 0), 0);
    const unrealized = position?.pnlUsd || 0;
    return realized + unrealized;
  }, [trades, position]);

  const roiPct = useMemo(() => {
    // Try to get start balance from multiple sources
    const profileJson = session?.profileJson as Record<string, unknown> | undefined;
    const startBalance = Number(
      profileJson?.startBalanceUsd ||
      profileJson?.startBalance ||
      profileJson?.availableUsd ||
      profileJson?.budget ||
      0
    );

    // If we have a valid start balance, calculate ROI from it
    if (startBalance > 0) {
      return (netPnl / startBalance) * 100;
    }

    // Fallback: calculate average ROI from trades' pctChange values
    if (trades.length > 0) {
      const totalPctChange = trades.reduce((sum, t) => sum + (t.pctChange || 0), 0);
      return totalPctChange;
    }

    return 0;
  }, [netPnl, session, trades]);

  // ============================================================================
  // RETURN
  // ============================================================================

  const stateData: SessionStateData = {
    session,
    symbol,
    mode,
    state,
    isLoading,
    error,
    agent,
    hasPosition,
    position,
    ticker,
    tickerStatus,
    currentPrice,
    orders,
    trades,
    activeOrders,
    performance,
    parity,
    activityEvents,
    wsConnected,
    lastUpdate,
    netPnl,
    roiPct,
    sparklineData,
  };

  const actions: SessionStateActions = {
    refresh,
    refreshTicker: () => fetchTicker(),
    refreshOrders: fetchOrders,
    refreshTrades: fetchTrades,
    refreshPerformance: fetchPerformance,
    refreshParity: fetchParity,
    refreshActivity: fetchActivity,
  };

  return [stateData, actions];
}

export default useSessionState;
