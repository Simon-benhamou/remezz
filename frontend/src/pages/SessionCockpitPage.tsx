import React from 'react';
import { useParams, Navigate, useNavigate } from 'react-router-dom';
import {
  Row,
  Col,
  Space,
  Tag,
  Card,
  Skeleton,
  Alert,
  Button,
  Typography,
  Tooltip,
  Select,
  message,
  List,
  Statistic,
  Segmented,
  Progress,
  theme,
  Flex,
} from 'antd';
import {
  ReloadOutlined,
  ExpandOutlined,
  CompressOutlined,
  InfoCircleOutlined,
} from '../icons';
import ProfessionalChart from '../components/charts/ProfessionalChart';
import LiveMetrics from '../components/LiveMetrics';
import StrategyPanel from '../components/StrategyPanel';
import PositionInfoCard from '../components/PositionInfoCard';
import type { StrategySnapshot } from '../types/strategies';
import PerfBreakdownPanel from '../components/PerfBreakdownPanel';
import OrdersTable from '../components/OrdersTable';
import TradesTable from '../components/TradesTable';
import { api, getApiKey } from '../api';
import { openWS, wsSend } from '../ws';
import '../styles/sessionMonitor.css';

const { Title, Text } = Typography;
// Memoized heavy components to avoid needless re-renders
// const MemoIndicatorsPanel = React.memo(IndicatorsPanel) as React.FC<any>;
// const MemoPerfPanel = React.memo(PerfPanel as any) as React.FC<any>;
const MemoOrdersTable = React.memo(OrdersTable as any) as React.FC<any>;
const MemoTradesTable = React.memo(TradesTable as any) as React.FC<any>;

// Loading phases for progressive loading
enum LoadingPhase {
  INITIALIZING = 'initializing',
  CORE_DATA = 'core_data',
  SECONDARY_DATA = 'secondary_data',
  COMPLETE = 'complete',
}

const OPEN_ORDER_STATUSES = new Set([
  'new',
  'open',
  'working',
  'pending',
  'accepted',
  'partially_filled',
]);

const formatUsd = (value: any, digits = 2) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `$${num.toFixed(digits)}`;
};

const formatPercent = (value: any, digits = 1) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num >= 0 ? '+' : ''}${num.toFixed(digits)}%`;
};

const deriveSymbol = (input: any): string => {
  if (!input) return '';
  if (typeof input === 'string') return input.toUpperCase();
  if (typeof input === 'object') {
    if (typeof input.symbol === 'string') return input.symbol.toUpperCase();
    if (typeof (input as Record<string, any>).ticker === 'string') {
      return (input as Record<string, any>).ticker.toUpperCase();
    }
    const base = (input as Record<string, any>).base;
    const quote = (input as Record<string, any>).quote;
    if (typeof base === 'string' && typeof quote === 'string') {
      return `${base}${quote}`.toUpperCase();
    }
  }
  return '';
};

type LoadingState = {
  phase: LoadingPhase;
  progress: number;
  message: string;
  errors: string[];
};

export default function SessionCockpitPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();

  // Loading state management
  const [loadingState, setLoadingState] = React.useState<LoadingState>({
    phase: LoadingPhase.INITIALIZING,
    progress: 0,
    message: 'Initializing monitor...',
    errors: [],
  });

  const [wsConnected, setWsConnected] = React.useState(false);
  const wsRef = React.useRef<ReturnType<typeof openWS> | null>(null);

  // Core data states (Phase 1)
  const [symbol, setSymbol] = React.useState<string>('');
  const [status, setStatus] = React.useState<any>({});
  const [agent, setAgent] = React.useState<any>(null);
  const [ticker, setTicker] = React.useState<any>(null);
  const [tickerStatus, setTickerStatus] = React.useState<'loading' | 'live' | 'stale' | 'error'>(
    'loading',
  );
  const [tickerError, setTickerError] = React.useState<string | null>(null);
  const lastTickerUpdateRef = React.useRef<number>(0);

  // Secondary data states (Phase 2)
  const [strategy, setStrategy] = React.useState<any>(null);
  const [analysis, setAnalysis] = React.useState<any>(null);
  const [kpi, setKpi] = React.useState<any>(null);
  const [orders, setOrders] = React.useState<any[]>([]);
  const [trades, setTrades] = React.useState<any[]>([]);
  const [ordersView, setOrdersView] = React.useState<'trades' | 'orders'>('trades');

  // Tertiary data states (Phase 3)
  const [alerts, setAlerts] = React.useState<any[]>([]);
  const [opsEvents, setOpsEvents] = React.useState<any[]>([]);
  const [feedLogs, setFeedLogs] = React.useState<any[]>([]);
  const [refreshing, setRefreshing] = React.useState(false);
  const [marginHealth, setMarginHealth] = React.useState<any>(null);
  const [diagnostics, setDiagnostics] = React.useState<any>(null);

  const normalizedSymbol = React.useMemo(
    () => deriveSymbol(status?.symbol || symbol),
    [status?.symbol, symbol],
  );

  const filteredTrades = React.useMemo(
    () =>
      (trades || []).filter((trade: any) => {
        if (!normalizedSymbol) return true;
        const tradeSymbol = deriveSymbol(trade?.symbol ?? trade?.instrument);
        if (!tradeSymbol) return true;
        return tradeSymbol === normalizedSymbol;
      }),
    [trades, normalizedSymbol],
  );

  const filteredOrders = React.useMemo(
    () =>
      (orders || []).filter((order: any) => {
        if (!normalizedSymbol) return true;
        const orderSymbol = deriveSymbol(order?.symbol ?? order?.instrument);
        if (!orderSymbol) return true;
        return orderSymbol === normalizedSymbol;
      }),
    [orders, normalizedSymbol],
  );

  const activeOrders = React.useMemo(
    () =>
      filteredOrders.filter((order: any) =>
        OPEN_ORDER_STATUSES.has(String(order?.status || '').toLowerCase()),
      ),
    [filteredOrders],
  );
  const statusSummary = React.useMemo(() => {
    const items: Array<{ label: string; value: string }> = [
      {
        label: 'Mode',
        value: status?.session?.mode ? String(status.session.mode).toUpperCase() : '—',
      },
      {
        label: 'Agent state',
        value: agent?.state || status?.session?.state || '—',
      },
      {
        label: 'Strategy',
        value: 'Momentum Simple',
      },
    ];
    items.push({ label: 'Capital source', value: 'Shared pool' });
    const available = agent?.profile?.availableUsd ?? agent?.balance?.freeUsd;
    if (Number.isFinite(Number(available))) {
      items.push({ label: 'Available', value: formatUsd(available) });
    }
    const todaysPnl = kpi?.today?.netPnlUsd ?? kpi?.today?.pnlUsd ?? kpi?.netPnlUsd ?? kpi?.pnlUsd;
    if (Number.isFinite(Number(todaysPnl))) {
      items.push({ label: 'Daily PnL', value: formatUsd(todaysPnl) });
    }
    return items;
  }, [status?.session, agent, kpi]);

  const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

  const refreshAll = React.useCallback(async () => {
    if (!sessionId) return;
    setRefreshing(true);
    try {
      const [sessionStatus, agentState, perf, ordersData, tradesData] = await Promise.all([
        api.status(sessionId, { includeBalance: false, includeTech: false }).catch((err) => {
          console.error('Refresh status failed', err);
          message.error('Unable to refresh session status');
          return null;
        }),
        api.getAgentState(sessionId).catch((err) => {
          console.error('Refresh agent state failed', err);
          return null;
        }),
        api.getPerf(sessionId).catch((err) => {
          console.error('Refresh performance failed', err);
          return null;
        }),
        api.getOrders(sessionId).catch((err) => {
          console.error('Refresh orders failed', err);
          return [] as any[];
        }),
        api.getTrades(sessionId).catch((err) => {
          console.error('Refresh trades failed', err);
          return [] as any[];
        }),
      ]);

      if (sessionStatus) setStatus(sessionStatus);
      if (agentState) setAgent(agentState);
      if (perf) setKpi(perf);
      setOrders(Array.isArray(ordersData) ? ordersData : []);
      setTrades(Array.isArray(tradesData) ? tradesData : []);

      if (symbol) {
        try {
          setStrategy(await api.strategyToday(symbol));
        } catch (err) {
          console.warn('Refresh strategy failed', err);
        }
        try {
          setAnalysis(await api.analysis(symbol));
        } catch (err) {
          console.warn('Refresh analysis failed', err);
        }
        try {
          const t = await api.getTicker(symbol);
          setTicker(t);
          setTickerStatus('live');
          setTickerError(null);
          lastTickerUpdateRef.current = Date.now();
        } catch (err) {
          console.warn('Refresh ticker failed', err);
        }
      }

      if (sessionStatus?.session?.id) {
        try {
          const margin = await api.getSessionMargin(sessionStatus.session.id);
          setMarginHealth(margin);
        } catch (err) {
          console.warn('Refresh margin failed', err);
        }
        try {
          const alertList = await api.getAlerts(sessionStatus.session.id);
          setAlerts(Array.isArray(alertList) ? alertList : []);
        } catch (err) {
          console.warn('Refresh alerts failed', err);
        }
        try {
          const logs = await api.getOpsEvents(40, sessionStatus.session.id);
          setOpsEvents(Array.isArray(logs) ? logs : []);
        } catch (err) {
          console.warn('Refresh ops events failed', err);
        }
      }
    } finally {
      setRefreshing(false);
    }
  }, [sessionId, symbol, lastTickerUpdateRef]);

  React.useEffect(() => {
    const interval = setInterval(() => {
      if (tickerStatus === 'live' && lastTickerUpdateRef.current) {
        const age = Date.now() - lastTickerUpdateRef.current;
        if (age > 15_000) {
          setTickerStatus('stale');
        }
      }
    }, 5_000);
    return () => clearInterval(interval);
  }, [tickerStatus]);

  // Update loading progress
  const updateProgress = (
    phase: LoadingPhase,
    progress: number,
    message: string,
    error?: string,
  ) => {
    setLoadingState((prev) => ({
      phase,
      progress,
      message,
      errors: error ? [...prev.errors, error] : prev.errors,
    }));
  };

  // Load ticker data for the symbol
  const loadTicker = async (sym: string, opts: { silent?: boolean } = {}) => {
    if (!sym) return;
    if (!opts.silent) {
      setTickerStatus((prev) => (prev === 'live' ? prev : 'loading'));
    }
    try {
      const tickerData = await api.getTicker(sym);
      setTicker(tickerData);
      setTickerError(null);
      setTickerStatus('live');
      lastTickerUpdateRef.current = Date.now();
      // Quick warm-up retry: if placeholder (last=0 and volumes=0), retry shortly
      const last = Number((tickerData as any)?.last || 0);
      const baseVol = Number((tickerData as any)?.baseVolume || 0);
      const quoteVol = Number((tickerData as any)?.quoteVolume || 0);
      if (last === 0 || (baseVol === 0 && quoteVol === 0)) {
        setTimeout(async () => {
          try {
            await loadTicker(sym, { silent: true });
          } catch {}
        }, 1500);
      }
    } catch (err: any) {
      console.error('Failed to load ticker:', err);
      const detail =
        err?.response?.data?.details || err?.response?.data?.error || err?.message || String(err);
      setTickerError(detail);
      setTickerStatus('error');
    }
  };

  // Progressive loading system with timeout
  React.useEffect(() => {
    if (!sessionId) return;

    const loadData = async () => {
      // ✅ FIX: Augmenter timeout à 20 secondes pour données complètes
      const loadingTimeout = setTimeout(() => {
        updateProgress(
          LoadingPhase.COMPLETE,
          100,
          'Load timeout - continuing with available data',
          'Loading timeout after 20 seconds',
        );
      }, 20000);

      try {
        // Phase 1: Core data (session, symbol, basic status)
        updateProgress(LoadingPhase.CORE_DATA, 10, 'Loading session data...');

        let s: any = null;
        try {
          s = await Promise.race([
            api.status(sessionId, { includeBalance: false, includeTech: false }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Status timeout')), 15000),
            ),
          ]);
        } catch (statusError: any) {
          clearTimeout(loadingTimeout);
          const detail =
            statusError?.response?.data?.details ||
            statusError?.response?.data?.error ||
            statusError?.message ||
            String(statusError);
          console.error('Status load failed:', statusError);
          setStatus({ error: detail });
          setTickerStatus('error');
          setTickerError(detail);
          updateProgress(LoadingPhase.COMPLETE, 100, 'Unable to load agent status', detail);
          message.error(`Monitor unavailable: ${detail}`);
          return;
        }

        if (!s?.session?.id) {
          navigate('/agents');
          return;
        }

        setStatus(s);
        try {
          const margin = await api.getSessionMargin(s.session.id).catch(() => null);
          if (margin) setMarginHealth(margin);
        } catch {}
        const sym = s?.session?.symbol || s?.symbol || symbol;
        if (sym) setSymbol(sym);

        updateProgress(LoadingPhase.CORE_DATA, 30, 'Loading agent state & diagnostics...');

        // ✅ FIX: Load core data + diagnostics (CRITIQUE) in parallel with timeout
        const [agentData, tickerData, diagnosticsData] = await Promise.allSettled([
          Promise.race([
            api.getAgentState(s.session.id),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Agent timeout')), 15000)),
          ]),
          sym
            ? Promise.race([
                api.getTicker(sym),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('Ticker timeout')), 15000),
                ),
              ])
            : Promise.resolve(null),
          // ✅ NOUVEAU: Diagnostics en Phase 1 car CRITIQUE pour comprendre pourquoi agent ne trade pas
          Promise.race([
            api.getDiagnostics(s.session.id),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Diagnostics timeout')), 15000),
            ),
          ]),
        ]);

        if (agentData.status === 'fulfilled') setAgent(agentData.value);
        if (tickerData.status === 'fulfilled' && tickerData.value) {
          setTicker(tickerData.value);
          setTickerStatus('live');
          setTickerError(null);
          lastTickerUpdateRef.current = Date.now();
        } else if (tickerData.status === 'rejected') {
          const detail =
            (tickerData.reason as any)?.response?.data?.details ||
            (tickerData.reason as any)?.message ||
            String(tickerData.reason);
          setTickerError(detail);
          setTickerStatus('error');
        }
        if (diagnosticsData.status === 'fulfilled' && diagnosticsData.value) {
          setAgent((prev: any) => ({ ...prev, diagnostics: diagnosticsData.value }));
        } else if (diagnosticsData.status === 'rejected') {
          const detail =
            (diagnosticsData.reason as any)?.response?.data?.details ||
            (diagnosticsData.reason as any)?.response?.data?.error ||
            (diagnosticsData.reason as any)?.message ||
            String(diagnosticsData.reason);
          console.warn('Diagnostics unavailable:', detail);
          updateProgress(LoadingPhase.CORE_DATA, 35, 'Diagnostics unavailable', detail);
          setAgent((prev: any) => ({ ...prev, diagnosticsError: detail }));
        }

        updateProgress(LoadingPhase.SECONDARY_DATA, 50, 'Loading trading data...');

        // Phase 2: Trading data (orders, trades, strategy, analysis, diagnostics)
        const [strategyData, analysisData, kpiData, ordersData, tradesData, diagnosticsData2] =
          await Promise.allSettled([
            sym
              ? api.strategyToday(sym).catch((e) => {
                  console.warn('Strategy failed:', e);
                  return null;
                })
              : Promise.resolve(null),
            sym
              ? api.analysis(sym).catch((e) => {
                  console.warn('Analysis failed:', e);
                  return null;
                })
              : Promise.resolve(null),
            api.getPerf(s.session.id).catch((e) => {
              console.warn('Perf failed:', e);
              return null;
            }),
            api.getOrders(s.session.id).catch((e) => {
              console.warn('Orders failed:', e);
              return [];
            }),
            api.getTrades(s.session.id).catch((e) => {
              console.warn('Trades failed:', e);
              return [];
            }),
            api.getDiagnostics(s.session.id).catch((e) => {
              console.warn('Diagnostics failed:', e);
              return null;
            }),
          ]);

        if (strategyData.status === 'fulfilled' && strategyData.value)
          setStrategy(strategyData.value);
        if (analysisData.status === 'fulfilled' && analysisData.value)
          setAnalysis(analysisData.value);
        if (kpiData.status === 'fulfilled') setKpi(kpiData.value);
        if (ordersData.status === 'fulfilled') {
          const o = ordersData.value;
          setOrders(Array.isArray(o) ? o : (o?.orders || []));
        }
        if (tradesData.status === 'fulfilled') {
          const t = tradesData.value;
          setTrades(Array.isArray(t) ? t : (t?.trades || []));
        }
        if (diagnosticsData2.status === 'fulfilled' && diagnosticsData2.value?.ok) {
          setDiagnostics(diagnosticsData2.value.diagnostics);
        }

        clearTimeout(loadingTimeout);
        updateProgress(LoadingPhase.COMPLETE, 100, 'Monitor ready!');

        // Additional timeout to ensure skeleton disappears
        setTimeout(() => {
          updateProgress(LoadingPhase.COMPLETE, 100, 'Monitor ready!');
        }, 500);
      } catch (error) {
        clearTimeout(loadingTimeout);
        console.error('Loading error:', error);
        updateProgress(LoadingPhase.COMPLETE, 100, 'Load completed with errors', String(error));
      }
    };

    loadData();
  }, [sessionId]);

  React.useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const fetchMargin = async () => {
      try {
        const margin = await api.getSessionMargin(sessionId);
        if (!cancelled && margin) setMarginHealth(margin);
      } catch {}
    };
    fetchMargin();
    const marginTimer = setInterval(fetchMargin, 30000);
    return () => {
      cancelled = true;
      clearInterval(marginTimer);
    };
  }, [sessionId]);

  // Periodic diagnostics refresh
  React.useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const fetchDiagnostics = async () => {
      try {
        const result = await api.getDiagnostics(sessionId);
        if (!cancelled && result?.ok && result.diagnostics) {
          setDiagnostics(result.diagnostics);
        }
      } catch (e) {
        console.warn('Diagnostics refresh failed:', e);
      }
    };
    fetchDiagnostics();
    const diagTimer = setInterval(fetchDiagnostics, 15000); // 15s refresh
    return () => {
      cancelled = true;
      clearInterval(diagTimer);
    };
  }, [sessionId]);

  // Periodic ticker refresh
  React.useEffect(() => {
    if (!symbol) return;
    setTickerStatus((prev) => (prev === 'live' ? prev : 'loading'));
    loadTicker(symbol);
    const tickerTimer = setInterval(() => {
      loadTicker(symbol, { silent: true });
    }, 30000); // 30s refresh
    return () => {
      clearInterval(tickerTimer);
    };
  }, [symbol]);

  React.useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const loadAlerts = async () => {
      try {
        const list = await api.getAlerts(sessionId);
        if (!cancelled) setAlerts(Array.isArray(list) ? list : []);
      } catch {}
    };
    loadAlerts();
    const timer = setInterval(loadAlerts, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  React.useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const loadLogs = async () => {
      try {
        const rows = await api.getOpsEvents(40, sessionId);
        if (!cancelled) setOpsEvents(Array.isArray(rows) ? rows : []);
      } catch {}
    };
    loadLogs();
    const timer = setInterval(loadLogs, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  // Load feed logs filtered by session symbol
  React.useEffect(() => {
    if (!sessionId || !symbol) return;
    let cancelled = false;
    const loadFeedLogs = async () => {
      try {
        const res = await api.getAgentLogs(undefined, 50) as any;
        if (!cancelled && res?.logs) {
          // Filter logs by this session's symbol
          const filtered = res.logs.filter((log: any) => 
            log.sessionId === sessionId || 
            log.symbol === symbol ||
            log.symbol?.toUpperCase().includes(symbol?.replace('/USDT:USDT', '').toUpperCase())
          );
          setFeedLogs(filtered.slice(0, 20));
        }
      } catch (err) {
        console.warn('Feed logs fetch failed:', err);
      }
    };
    loadFeedLogs();
    const timer = setInterval(loadFeedLogs, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, symbol]);

  // WS subscription dedicated to this monitor
  React.useEffect(() => {
    if (!sessionId || !symbol) return; // wait until symbol known to subscribe correctly
    const ws = openWS(
      API_BASE,
      getApiKey(),
      symbol,
      async (msg) => {
        if (msg?.sessionId && msg.sessionId !== sessionId) return; // strict filter
        if (msg.type === 'hello_ok') return;
        if (msg.type === 'sub_ok') {
          try {
            wsSend(ws, { type: 'fetch_now' });
          } catch {}
          return;
        }
        if (msg.type === 'tick') {
          // ✅ FIX: Only update if symbol matches current session
          const msgSymbol = msg.data?.symbol?.toUpperCase().replace(/[/:]/g, '');
          const currentSym = symbol?.toUpperCase().replace(/[/:]/g, '');
          
          if (!currentSym || !msgSymbol || msgSymbol !== currentSym) {
            return; // Skip tick for different symbol
          }
          
          setStatus((s: any) => ({
            ...s,
            symbol: msg.data.symbol,
            price: msg.data.price,
            sr: { support: msg.data.support, resistance: msg.data.resistance },
            pivots: msg.data.pivots,
          }));
        }
        // 🔥 REAL-TIME PRICE: High-frequency price updates from Binance WebSocket
        if (msg.type === 'price_update') {
          const { symbol: msgSymbol, last, bid, ask, timestamp } = msg.data;
          
          // ✅ FIX: Only update price if symbol matches current session
          const currentSymbol = symbol?.toUpperCase().replace(/[/:]/g, '');
          const receivedSymbol = msgSymbol?.toUpperCase().replace(/[/:]/g, '');
          
          if (!currentSymbol || !receivedSymbol || currentSymbol !== receivedSymbol) {
            return; // Skip price update for different symbol
          }
          
          if (last) {
            setStatus((s: any) => ({ ...s, price: last }));
            setTicker((prev: any) => ({
              ...prev,
              last,
              bid: bid ?? prev?.bid,
              ask: ask ?? prev?.ask,
            }));
            setTickerStatus('live');
            lastTickerUpdateRef.current = Date.now();
          }
        }
        if (msg.type === 'analysis') {
          setAnalysis(msg.data);
          // 🔥 REAL-TIME FIX: Update ticker from technical snapshot
          if (msg.data?.technical) {
            const tech = msg.data.technical;
            setTicker((prev: any) => ({
              ...prev,
              last: tech.last ?? prev?.last,
              bid: tech.bid ?? prev?.bid,
              ask: tech.ask ?? prev?.ask,
              high: tech.high24h ?? prev?.high,
              low: tech.low24h ?? prev?.low,
              baseVolume: tech.baseVolume24h ?? prev?.baseVolume,
              quoteVolume: tech.quoteVolume24h ?? prev?.quoteVolume,
              change: tech.change24h ?? prev?.change,
              percentage: tech.percentage24h ?? prev?.percentage,
            }));
            setTickerStatus('live');
            setTickerError(null);
            lastTickerUpdateRef.current = Date.now();
            
            // ✅ FIX: Update status.price for LiveMetrics header & charts
            if (tech.last) {
              setStatus((s: any) => ({
                ...s,
                price: tech.last,
              }));
            }
          }
        }
        if (msg.type === 'strategy') setStrategy(msg.data);
        if (msg.type === 'agent_state') {
          setAgent((prev: any) => ({ ...prev, ...msg.data }));
          // refresh balance snapshot
          try {
            setAgent(await api.getAgentState(sessionId));
          } catch {}
          // ✅ FIX: Refresh diagnostics automatiquement quand agent state change
          try {
            const diag = await api.getDiagnostics(sessionId);
            setAgent((prev: any) => ({ ...prev, diagnostics: diag }));
          } catch {}
          if (msg?.data?.exit) {
            try {
              setKpi(await api.getPerf(sessionId));
            } catch {}
          }
        }
        if (msg.type === 'session') {
          setStatus((s: any) => ({ ...s, session: msg.data, symbol: msg.data.symbol || s.symbol }));
          const sym = msg.data?.symbol || symbol;
          if (msg.data?.symbol) setSymbol(msg.data.symbol);
          try {
            wsSend(ws, { type: 'sub', symbol: sym, sessionId });
          } catch {}
          try {
            setStrategy(await api.strategyToday(sym));
          } catch {}
          try {
            setAnalysis(await api.analysis(sym));
          } catch {}
          try {
            setKpi(await api.getPerf(sessionId));
          } catch {}
          try {
            const ordersRes = await api.getOrders(sessionId);
            setOrders(Array.isArray(ordersRes) ? ordersRes : (ordersRes?.orders || []));
          } catch {}
        }
        if (msg.type === 'orders') {
          const ordersData = msg.data;
          setOrders(Array.isArray(ordersData) ? ordersData : (ordersData?.orders || []));
          try {
            if (sessionId) {
              const tradesRes = await api.getTrades(sessionId);
              setTrades(Array.isArray(tradesRes) ? tradesRes : (tradesRes?.trades || []));
            }
          } catch {}
          try {
            setAgent(await api.getAgentState(sessionId));
          } catch {}
        }
        if (msg.type === 'alert') {
          setAlerts((prev: any[]) => [msg.data, ...prev].slice(0, 50));
        }
      },
      (ok) => setWsConnected(ok),
      undefined,
      sessionId,
    );
    wsRef.current = ws;
    return () => {
      try {
        wsRef.current?.close?.();
      } catch {}
    };
  }, [API_BASE, sessionId, symbol]);

  if (!sessionId) return <Navigate to="/agents" replace />;
  const hasSession = !!status?.session?.id;
  const isLoading = loadingState.phase !== LoadingPhase.COMPLETE;

  // Don't redirect while loading; only redirect if definitively no session after 5 seconds
  // Give the API time to respond before redirecting
  if (!isLoading && !hasSession && loadingState.errors.length > 0) return <Navigate to="/agents" replace />;

  // Hide loading on user interaction
  React.useEffect(() => {
    if (!isLoading) return;

    const handleUserInteraction = () => {
      if (loadingState.progress > 50) {
        // Only if we're already past core loading
        setLoadingState((prev) => ({ ...prev, phase: LoadingPhase.COMPLETE }));
      }
    };

    const events = ['click', 'keydown', 'scroll'];
    events.forEach((event) => {
      document.addEventListener(event, handleUserInteraction, { once: true });
    });

    return () => {
      events.forEach((event) => {
        document.removeEventListener(event, handleUserInteraction);
      });
    };
  }, [isLoading, loadingState.progress]);

  // Helper to check if we should show content vs skeleton
  const shouldShowContent = (requiredPhase: LoadingPhase) => {
    const phaseOrder = {
      [LoadingPhase.INITIALIZING]: 0,
      [LoadingPhase.CORE_DATA]: 1,
      [LoadingPhase.SECONDARY_DATA]: 2,
      [LoadingPhase.COMPLETE]: 3,
    };

    const currentOrder = phaseOrder[loadingState.phase];
    const requiredOrder = phaseOrder[requiredPhase];

    return currentOrder >= requiredOrder;
  };

  const startBalance = Number(status?.session?.startBalanceUsd ?? status?.session?.startBalance ?? 0);
  const statsMeta = (kpi?.stats ?? {}) as Record<string, any>;
  const realizedPnl = Number(kpi?.realizedPnlUsd ?? 0);
  const unrealizedPnl = Number(kpi?.unrealizedPnlUsd ?? 0);
  const roi = startBalance > 0 ? (realizedPnl / startBalance) * 100 : Number(kpi?.roiPct ?? kpi?.roi ?? 0);
  const netRoi = Number.isFinite(Number(statsMeta?.netRoiPct))
    ? Number(statsMeta.netRoiPct)
    : startBalance > 0
      ? ((realizedPnl + unrealizedPnl) / startBalance) * 100
      : roi;
  const winRate = Number(kpi?.winRate ?? 0);
  const maxDrawdown = Number(kpi?.maxDrawdownPct ?? 0);
  const netPnl = realizedPnl + unrealizedPnl;
  const showNetRoi = Number.isFinite(netRoi) && Math.abs(netRoi - roi) > 0.05;

  // Modern Loading UI that respects sidebar on desktop, full screen on mobile
  const LoadingOverlay = () => {
    const [windowWidth, setWindowWidth] = React.useState(window.innerWidth);
    const { token } = theme.useToken();

    React.useEffect(() => {
      const handleResize = () => setWindowWidth(window.innerWidth);
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }, []);

    // On mobile (<768px), cover full screen. On desktop, leave space for sidebar.
    const isMobile = windowWidth < 768;
    const leftOffset = isMobile ? 0 : '200px';

    return (
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: leftOffset,
          right: 0,
          bottom: 0,
          background: `color-mix(in srgb, ${token.colorBgBase} 20%, transparent)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: isMobile ? 1001 : 100, // Higher z-index on mobile to cover mobile menu
          backdropFilter: 'blur(4px)',
          pointerEvents: isLoading ? 'auto' : 'none',
        }}
      >
        <Card
          style={{
            minWidth: 350,
            textAlign: 'center',
            maxWidth: '90%',
            boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
            borderRadius: 12,
            border: '1px solid rgba(0,0,0,0.08)',
          }}
        >
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <div
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, #1890ff 0%, #36cfc9 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <span style={{ color: 'white', fontSize: 18 }}>📊</span>
              </div>
              <Title level={4} style={{ margin: 0 }}>
                Loading Trading Monitor
              </Title>
            </div>

            <Progress
              percent={loadingState.progress}
              strokeColor={{
                '0%': '#108ee9',
                '100%': '#87d068',
              }}
              trailColor="#f0f0f0"
              showInfo={true}
              strokeWidth={8}
            />

            <div style={{ color: '#666', fontSize: 14 }}>{loadingState.message}</div>

            {loadingState.errors.length > 0 && (
              <Alert
                type="warning"
                message="Some data failed to load"
                description={`${loadingState.errors.length} errors occurred - continuing with available data`}
                showIcon
                style={{ textAlign: 'left' }}
                action={
                  <Button size="small" type="primary" onClick={() => window.location.reload()}>
                    Retry
                  </Button>
                }
              />
            )}

            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Button
                type="text"
                onClick={() => {
                  setLoadingState((prev) => ({ ...prev, phase: LoadingPhase.COMPLETE }));
                }}
              >
                Continue with available data
              </Button>
              <Button type="default" onClick={() => navigate('/agents')}>
                ← Back to Sessions
              </Button>
            </div>
          </Space>
        </Card>
      </div>
    );
  };

  return (
    <div className="session-monitor-page">
      {isLoading && <LoadingOverlay />}
      <Space
        direction="vertical"
        size={32}
        style={{ width: '100%', padding: 24, paddingBottom: 48 }}
      >
        <Card bordered={false} className="session-monitor-hero" bodyStyle={{ padding: 24 }}>
          <Space direction="vertical" size={24} style={{ width: '100%' }}>
            <Flex
              className="session-hero-header"
              align="flex-start"
              justify="space-between"
              wrap="wrap"
              gap={16}
            >
              <Space direction="vertical" size={12} style={{ flex: '1 1 260px', minWidth: 0 }}>
                <div>
                  <Title level={3} style={{ marginBottom: 4 }}>
                    {status?.session?.name ||
                      status?.session?.label ||
                      status?.symbol ||
                      'Trading session'}
                  </Title>
                  <Text type="secondary">{status?.symbol || '—'}</Text>
                </div>
                <Space size={[8, 8]} wrap className="session-hero-tags">
                  {status?.session?.mode && (
                    <Tag className="session-monitor-chip" color="geekblue">
                      {(status.session.mode as string).toUpperCase()}
                    </Tag>
                  )}
                  {status?.session?.state && (
                    <Tag
                      className="session-monitor-chip"
                      color={
                        status.session.state === 'IN_POSITION'
                          ? 'green'
                          : status.session.state === 'WATCHING'
                            ? 'blue'
                            : status.session.state === 'HALT'
                              ? 'red'
                              : 'default'
                      }
                    >
                      {status.session.state}
                    </Tag>
                  )}
                  <Tag className="session-monitor-chip" color={wsConnected ? 'green' : 'red'}>
                    {wsConnected ? 'LIVE DATA' : 'PAUSED'}
                  </Tag>
                </Space>
              </Space>
              <Space
                size={12}
                wrap
                align="end"
                className="session-hero-actions"
                style={{ justifyContent: 'flex-end' }}
              >
                <Tooltip title="Refresh session data">
                  <Button icon={<ReloadOutlined />} onClick={refreshAll} loading={refreshing}>
                    Refresh
                  </Button>
                </Tooltip>
                <Button onClick={() => navigate('/feed')}>View full feed</Button>
              </Space>
            </Flex>
            <Row gutter={[24, 24]} align="top">
              <Col xs={24} lg={10} xl={8}>
                <div className="session-hero-summary">
                  {statusSummary.length > 0 ? (
                    statusSummary.map((item) => (
                      <div key={item.label} className="session-hero-summary__item">
                        <span>{item.label}</span>
                        <strong>{item.value}</strong>
                      </div>
                    ))
                  ) : (
                    <Text type="secondary">Session diagnostics will appear here once available.</Text>
                  )}
                </div>
              </Col>
              <Col xs={24} lg={14} xl={16}>
                <div className="session-hero-metrics-grid">
                  <div className="session-hero-metric">
                    <Statistic
                      title="ROI (realized)"
                      value={roi*100}
                      precision={2}
                      suffix="%"
                      valueStyle={{ color: roi >= 0 ? '#16a34a' : '#dc2626' }}
                    />
                  </div>
                  {showNetRoi && (
                    <div className="session-hero-metric">
                      <Statistic
                        title="ROI (net)"
                        value={netRoi}
                        precision={2}
                        suffix="%"
                        valueStyle={{ color: netRoi >= 0 ? '#0ea5e9' : '#dc2626' }}
                      />
                    </div>
                  )}
                  <div className="session-hero-metric">
                    <Statistic
                      title="Win rate"
                      value={winRate}
                      precision={1}
                      suffix="%"
                      valueStyle={{ color: '#2563eb' }}
                    />
                  </div>
                  <div className="session-hero-metric">
                    <Statistic
                      title="Max drawdown"
                      value={Math.abs(maxDrawdown)}
                      precision={1}
                      suffix="%"
                      valueStyle={{ color: maxDrawdown <= 0 ? '#2563eb' : '#dc2626' }}
                    />
                  </div>
                  <div className="session-hero-metric">
                    <Statistic
                      title="Net PnL"
                      value={Math.abs(netPnl)}
                      precision={2}
                      prefix={netPnl >= 0 ? '+' : '-'}
                      suffix=" USD"
                      valueStyle={{ color: netPnl >= 0 ? '#16a34a' : '#dc2626' }}
                    />
                  </div>
                </div>
              </Col>
            </Row>
          </Space>
        </Card>
        <Card title="Market snapshot" bordered={false} className="session-section-card">
          {shouldShowContent(LoadingPhase.CORE_DATA) ? (
            <LiveMetrics
              symbol={status?.symbol}
              price={status?.price}
              ticker={ticker}
              lastUpdate={
                ticker?.lastUpdate ||
                (ticker?.timestamp ? new Date(ticker.timestamp).toISOString() : undefined)
              }
              status={tickerStatus}
              errorMessage={tickerError || undefined}
            />
          ) : (
            <Skeleton active paragraph={{ rows: 4 }} />
          )}
        </Card>

        <Row gutter={[24, 24]} className="session-grid">
          <Col xs={24} lg={agent?.pos ? 17 : 24}>
            <Card
              className="session-section-card session-section-card--flush w-full"
              bordered={false}
              bodyStyle={{ padding: 0 }}
            >
              {shouldShowContent(LoadingPhase.CORE_DATA) ? (
                <div className="session-chart-card w-full">
                  <ProfessionalChart
                    symbol={symbol || status?.symbol}
                    sessionId={sessionId}
                    orders={filteredOrders}
                    fills={filteredTrades}
                    position={agent?.pos ? {
                      entryPrice: agent.pos.entryPrice,
                      stopPrice: agent.pos.stopPrice || agent.pos.stop,
                      targets: agent.pos.targets || [],
                      side: agent.pos.side,
                    } : null}
                    technicalLevels={{
                      support: status?.sr?.support ?? null,
                      resistance: status?.sr?.resistance ?? null,
                      supports: [],
                      resistances: [],
                      pivots: status?.pivots || null,
                      srBias: null,
                    }}
                    strategy={strategy ? {
                      label: strategy.label || strategy.strategy,
                      bias: strategy.bias,
                      confidence: strategy.confidence,
                    } : null}
                  />
                </div>
              ) : (
                <Skeleton active paragraph={{ rows: 10 }} />
              )}
            </Card>
          </Col>
          {agent?.pos && (
            <Col xs={24} lg={7}>
              {shouldShowContent(LoadingPhase.CORE_DATA) ? (
                <PositionInfoCard
                  position={agent.pos}
                  currentPrice={status?.price}
                  symbol={status?.symbol}
                  sessionId={sessionId}
                  profile={agent?.profile}
                  onClose={refreshAll}
                />
              ) : (
                <Skeleton active paragraph={{ rows: 10 }} />
              )}
            </Col>
          )}
        </Row>
<Row>
  <Card title="Performance metrics" bordered={false} className="session-section-card">
                {shouldShowContent(LoadingPhase.SECONDARY_DATA) && status?.session?.id ? (
                  <PerfBreakdownPanel sessionId={status?.session?.id} api={api} />
                ) : (
                  <Skeleton active paragraph={{ rows: 8 }} />
                )}
              </Card>
</Row>
<Row gutter={[24, 24]}>
          <Col xs={24}>
            <Card 
              title={`Activity feed (${symbol || 'Agent'})`} 
              bordered={false} 
              className="session-section-card"
              extra={
                <Button size="small" onClick={() => navigate('/feed')}>
                  View all
                </Button>
              }
            >
              {shouldShowContent(LoadingPhase.CORE_DATA) ? (
                feedLogs.length > 0 ? (
                  <List
                    dataSource={feedLogs.slice(0, 10)}
                    renderItem={(log: any, idx: number) => {
                      const ts = log?.timestamp ? new Date(log.timestamp) : null;
                      const timeLabel = ts && !Number.isNaN(ts.getTime())
                        ? ts.toLocaleTimeString(undefined, { hour12: false })
                        : '';
                      const kind = log?.kind || 'info';
                      const level = log?.level || 'info';
                      const color = level === 'error'
                        ? 'red'
                        : level === 'warn'
                          ? 'orange'
                          : kind === 'entry'
                            ? 'green'
                            : kind === 'exit'
                              ? 'blue'
                              : kind === 'order'
                                ? 'purple'
                                : 'default';
                      return (
                        <List.Item key={`${log.timestamp}-${idx}`} style={{ padding: '8px 0' }}>
                          <Space direction="vertical" size={4} style={{ width: '100%' }}>
                            <Space size={8} align="center" wrap>
                              <Tag color={color}>{kind.toUpperCase()}</Tag>
                              <Tag>{log?.symbol || symbol}</Tag>
                              {timeLabel && <Text type="secondary" style={{ fontSize: 12 }}>{timeLabel}</Text>}
                            </Space>
                            <Text style={{ color: '#e2e8f0' }}>
                              {log?.message || '—'}
                            </Text>
                          </Space>
                        </List.Item>
                      );
                    }}
                  />
                ) : opsEvents.length > 0 ? (
                  <List
                    dataSource={opsEvents.slice(0, 8)}
                    renderItem={(evt: any) => {
                      const tsRaw = evt?.ts || evt?.createdAt;
                      const ts = tsRaw ? new Date(tsRaw) : null;
                      const timeLabel = ts && !Number.isNaN(ts.getTime())
                        ? ts.toLocaleTimeString(undefined, { hour12: false })
                        : '';
                      const level = String(evt?.level || '').toLowerCase();
                      const color = level === 'error'
                        ? 'red'
                        : level === 'warn'
                          ? 'orange'
                          : level === 'success'
                            ? 'green'
                            : 'blue';
                      return (
                        <List.Item key={evt?.id ?? `${timeLabel}-${level}`} style={{ padding: '8px 0' }}>
                          <Space direction="vertical" size={4} style={{ width: '100%' }}>
                            <Space size={8} align="center" wrap>
                              <Tag color={color}>{(evt?.level || 'INFO').toUpperCase()}</Tag>
                              <Text style={{ color: '#e2e8f0', fontWeight: 500 }}>{evt?.source || 'Agent'}</Text>
                              {timeLabel && <Text type="secondary" style={{ fontSize: 12 }}>{timeLabel}</Text>}
                            </Space>
                            <Text style={{ color: '#cbd5f5' }}>
                              {evt?.message || evt?.details?.message || '—'}
                            </Text>
                          </Space>
                        </List.Item>
                      );
                    }}
                  />
                ) : (
                  <Text type="secondary">No activity for this agent yet. Waiting for market events...</Text>
                )
              ) : (
                <Skeleton active paragraph={{ rows: 5 }} />
              )}
            </Card>
          </Col>
        </Row>

        <Row gutter={[24, 24]}>
          <Card title="Orders & trades" bordered={false} className="session-section-card  w-full">
            {shouldShowContent(LoadingPhase.SECONDARY_DATA) ? (
              <div className="session-trade-card">
                <Segmented
                  value={ordersView}
                  onChange={(value) => setOrdersView(value as 'trades' | 'orders')}
                  options={[
                    { label: `Recent trades (${filteredTrades.length})`, value: 'trades' },
                    { label: `Active orders (${activeOrders.length})`, value: 'orders' },
                  ]}
                  className="session-trade-card__toggle"
                />
                <div className="session-trade-card__table">
                  {ordersView === 'trades' ? (
                    <MemoTradesTable rows={trades} />
                  ) : (
                    <MemoOrdersTable rows={orders} />
                  )}
                </div>
              </div>
            ) : (
              <Skeleton active paragraph={{ rows: 6 }} />
            )}
          </Card>
        </Row>
      </Space>
    </div>
  );
}
