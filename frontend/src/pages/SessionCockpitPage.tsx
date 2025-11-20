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
  Drawer,
  Empty,
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
  SyncOutlined,
  InfoCircleOutlined,
} from '../icons';
import PriceChart from '../charts/PriceChart';
import LiveMetrics from '../components/LiveMetrics';
import StrategyPanel from '../components/StrategyPanel';
import MetaAdaptiveStatePanel from '../components/MetaAdaptiveStatePanel';
import MarketContextCard from '../components/MarketContextCard';
import PositionInfoCard from '../components/PositionInfoCard';
import SymbolProfileCard from '../components/SymbolProfileCard';
import PredictorResultsCard from '../components/PredictorResultsCard';
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
  const [savingAgg, setSavingAgg] = React.useState(false);

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
  const [activityOpen, setActivityOpen] = React.useState(false);
  const [rearming, setRearming] = React.useState(false);
  const [reselecting, setReselecting] = React.useState(false);
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
  const currentAggressiveness = React.useMemo(() => {
    const runtime = (agent as any)?.profile?.aggressiveness;
    const persisted = (status?.session as any)?.profileJson?.aggressiveness;
    return (runtime || persisted || 'reactive') as 'conservative' | 'reactive' | 'aggressive';
  }, [agent, status]);
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
        label: 'Aggressiveness',
        value: currentAggressiveness ? currentAggressiveness.toUpperCase() : '—',
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
  }, [status?.session, agent, currentAggressiveness, kpi]);

  const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

  const handleAggressivenessChange = async (val: 'conservative' | 'reactive' | 'aggressive') => {
    if (!status?.session?.id) return;
    try {
      setSavingAgg(true);
      await api.setAggressiveness(status.session.id, val);
      message.success(`Aggressiveness set to ${val}`);
    } catch (e) {
      console.error('Failed to set aggressiveness:', e);
      message.error('Failed to update aggressiveness');
    } finally {
      setSavingAgg(false);
    }
  };

  const handleRearm = async () => {
    if (!status?.session?.id) {
      message.error('No active session');
      return;
    }

    const rawPlan = (agent as any)?.plan?.plan || (agent as any)?.plan;
    if (!rawPlan) {
      message.warning('No trading plan available to rearm');
      return;
    }

    try {
      setRearming(true);
      await api.proposeAgentPlan(status.session.id, rawPlan);
      message.success('Agent rearmed with current plan');
    } catch (err: any) {
      const detail =
        err?.response?.data?.error || err?.response?.data?.message || err?.message || String(err);
      message.error(detail);
    } finally {
      setRearming(false);
    }
  };

  const handleReselect = async () => {
    if (!status?.session?.id) {
      message.error('No active session');
      return;
    }

    try {
      setReselecting(true);
      await api.triggerSmartReselect(status.session.id);
      message.success('Auto-select request sent');
    } catch (err: any) {
      const detail =
        err?.response?.data?.error || err?.response?.data?.message || err?.message || String(err);
      message.error(detail);
    } finally {
      setReselecting(false);
    }
  };

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
          navigate('/sessions');
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
        if (ordersData.status === 'fulfilled') setOrders(ordersData.value || []);
        if (tradesData.status === 'fulfilled') setTrades(tradesData.value || []);
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
          setStatus((s: any) => ({
            ...s,
            symbol: msg.data.symbol,
            price: msg.data.price,
            sr: { support: msg.data.support, resistance: msg.data.resistance },
            pivots: msg.data.pivots,
          }));
        }
        if (msg.type === 'analysis') setAnalysis(msg.data);
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
            setOrders(await api.getOrders(sessionId));
          } catch {}
        }
        if (msg.type === 'orders') {
          setOrders(msg.data);
          try {
            if (sessionId) setTrades(await api.getTrades(sessionId));
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

  if (!sessionId) return <Navigate to="/sessions" replace />;
  const hasSession = !!status?.session?.id;
  const isLoading = loadingState.phase !== LoadingPhase.COMPLETE;

  // Don't redirect while loading; only redirect if definitively no session
  if (!isLoading && !hasSession) return <Navigate to="/sessions" replace />;

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

  const activityItems = React.useMemo(() => {
    const items: Array<{
      id: string;
      ts: number;
      title: string;
      description?: string;
      meta?: string;
      tone?: 'info' | 'warn' | 'error' | 'success';
    }> = [];
    const toTs = (value: any) => {
      if (!value) return null;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    (alerts || []).forEach((alert: any, index: number) => {
      const ts = toTs(alert?.ts || alert?.createdAt);
      if (!ts) return;
      items.push({
        id: `alert-${alert?.id ?? index}-${ts}`,
        ts,
        title: alert?.kind || 'Policy alert',
        description: alert?.details?.message || alert?.details?.error || alert?.message || '',
        meta: alert?.symbol || status?.symbol,
        tone: alert?.severity === 'high' ? 'error' : alert?.severity === 'med' ? 'warn' : 'info',
      });
    });

    filteredTrades.forEach((trade: any, index: number) => {
      const ts = toTs(trade?.createdAt || trade?.ts);
      if (!ts) return;
      items.push({
        id: `trade-${trade?.id ?? index}-${ts}`,
        ts,
        title:
          `${String(trade?.side || '').toUpperCase()} ${trade?.symbol || status?.symbol || ''}`.trim(),
        description: trade?.qty ? `${trade.qty} @ ${trade.price}` : undefined,
        meta:
          typeof trade?.pnlUsd === 'number'
            ? `${trade.pnlUsd >= 0 ? '+' : ''}$${Math.abs(trade.pnlUsd).toFixed(2)}`
            : undefined,
        tone: trade?.pnlUsd > 0 ? 'success' : trade?.pnlUsd < 0 ? 'error' : 'info',
      });
    });

    filteredOrders.forEach((order: any, index: number) => {
      const ts = toTs(order?.createdAt || order?.ts);
      if (!ts) return;
      items.push({
        id: `order-${order?.id ?? index}-${ts}`,
        ts,
        title: `Order ${order?.status || ''}`.trim(),
        description: order?.symbol
          ? `${order.symbol} · ${order.side || ''} ${order.amount || ''}`.trim()
          : undefined,
        meta: order?.type,
        tone:
          order?.status === 'closed' ? 'success' : order?.status === 'canceled' ? 'warn' : 'info',
      });
    });

    (opsEvents || []).forEach((evt: any, index: number) => {
      const ts = toTs(evt?.ts || evt?.createdAt);
      if (!ts) return;
      const level = String(evt?.level || '').toLowerCase();
      const tone = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'success' ? 'success' : 'info';
      items.push({
        id: `log-${evt?.id ?? index}-${ts}`,
        ts,
        title: evt?.source || 'Agent log',
        description: evt?.message || evt?.details?.message || '',
        meta: level ? level.toUpperCase() : undefined,
        tone,
      });
    });

    return items.sort((a, b) => b.ts - a.ts).slice(0, 60);
  }, [alerts, filteredOrders, filteredTrades, opsEvents, status?.symbol]);

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
  const canRearm = React.useMemo(() => {
    const payload = (agent as any)?.plan;
    if (!payload) return false;
    return Boolean(payload?.plan || payload);
  }, [agent]);

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
              <Button type="default" onClick={() => navigate('/sessions')}>
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
                        status.session.state === 'MANAGE'
                          ? 'green'
                          : status.session.state === 'COOLDOWN'
                            ? 'orange'
                            : status.session.state === 'HALT'
                              ? 'red'
                              : 'blue'
                      }
                    >
                      {status.session.state}
                    </Tag>
                  )}
                  <Tag className="session-monitor-chip" color={wsConnected ? 'green' : 'red'}>
                    {wsConnected ? 'LIVE DATA' : 'PAUSED'}
                  </Tag>
                  {status?.session?.profileJson?.aggressiveness && (
                    <Tag className="session-monitor-chip" color="purple">
                      {(status.session.profileJson.aggressiveness as string).toUpperCase()}
                    </Tag>
                  )}
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
                  <Button icon={<ReloadOutlined />} onClick={refreshAll} loading={refreshing} />
                </Tooltip>
                <Button onClick={() => setActivityOpen(true)}>Activity feed</Button>
                <Select
                  value={currentAggressiveness}
                  loading={savingAgg}
                  onChange={handleAggressivenessChange}
                  options={[
                    { value: 'conservative', label: 'Conservative' },
                    { value: 'reactive', label: 'Reactive' },
                    { value: 'aggressive', label: 'Aggressive' },
                  ]}
                  style={{ minWidth: 160 }}
                />
                <Button icon={<SyncOutlined />} onClick={handleReselect} loading={reselecting}>
                  Auto-select agent
                </Button>
                <Button type="primary" onClick={handleRearm} loading={rearming} disabled={!canRearm}>
                  Rearm plan
                </Button>
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
        
        {/* Enhanced Monitoring: Symbol Profile & Predictor */}
        <Row gutter={[24, 24]}>
          <Col xs={24} md={12}>
            {shouldShowContent(LoadingPhase.SECONDARY_DATA) ? (
              <SymbolProfileCard profile={diagnostics?.symbolProfile} loading={false} />
            ) : (
              <Skeleton active paragraph={{ rows: 6 }} />
            )}
          </Col>
          <Col xs={24} md={12}>
            {shouldShowContent(LoadingPhase.SECONDARY_DATA) ? (
              <PredictorResultsCard predictor={diagnostics?.predictor} loading={false} />
            ) : (
              <Skeleton active paragraph={{ rows: 6 }} />
            )}
          </Col>
        </Row>
        
        <Row gutter={[24, 24]} className="session-grid">
          <Col xs={24} lg={agent?.pos ? 17 : 24}>
            <Card
              className="session-section-card session-section-card--flush w-full"
              bordered={false}
              bodyStyle={{ padding: 0 }}
            >
              {shouldShowContent(LoadingPhase.CORE_DATA) ? (
                <div className="session-chart-card w-full">
                  <PriceChart
                    symbol={status?.symbol}
                    price={status?.price}
                    support={status?.sr?.support}
                    resistance={status?.sr?.resistance}
                    agentPlan={agent?.plan}
                    agentPos={agent?.pos}
                    pivots={status?.pivots}
                    agentExit={agent?.exit}
                    orders={filteredOrders}
                    trades={filteredTrades}
                    projection={analysis?.projection}
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
          <Col xs={24} lg={14}>
            <Card title="Meta-Adaptive State" bordered={false} className="session-section-card">
              {shouldShowContent(LoadingPhase.CORE_DATA) && diagnostics ? (
                <MetaAdaptiveStatePanel diagnostics={diagnostics} />
              ) : (
                <Skeleton active paragraph={{ rows: 6 }} />
              )}
            </Card>
          </Col>
          <Col xs={24} lg={10}>
            <Card title="Market Context" bordered={false} className="session-section-card">
              {shouldShowContent(LoadingPhase.CORE_DATA) && diagnostics?.market ? (
                <MarketContextCard market={diagnostics.market} symbol={status?.symbol || ''} />
              ) : (
                <Skeleton active paragraph={{ rows: 6 }} />
              )}
            </Card>
          </Col>
        </Row>

        <Row gutter={[24, 24]}>
          <Col xs={24}>
            <Card title="Recent agent logs" bordered={false} className="session-section-card">
              {shouldShowContent(LoadingPhase.CORE_DATA) ? (
                opsEvents.length > 0 ? (
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
                  <Text type="secondary">No recent logs captured.</Text>
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

      <Drawer
        title="Activity feed"
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
        width={420}
      >
        {activityItems.length > 0 ? (
          <List
            itemLayout="vertical"
            dataSource={activityItems}
            renderItem={(item) => (
              <List.Item key={item.id}>
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <Space align="center" size={8} wrap>
                    <Tag
                      color={
                        item.tone === 'error'
                          ? 'red'
                          : item.tone === 'warn'
                            ? 'orange'
                            : item.tone === 'success'
                              ? 'green'
                              : 'blue'
                      }
                    >
                      {item.tone === 'error'
                        ? 'Alert'
                        : item.tone === 'warn'
                          ? 'Warning'
                          : item.tone === 'success'
                            ? 'Success'
                            : 'Info'}
                    </Tag>
                    <Text strong>{item.title}</Text>
                  </Space>
                  {item.description && <Text>{item.description}</Text>}
                  <Space size={8} wrap align="center">
                    <Text type="secondary">{new Date(item.ts).toLocaleString()}</Text>
                    {item.meta && <Tag>{item.meta}</Tag>}
                  </Space>
                </Space>
              </List.Item>
            )}
          />
        ) : (
          <Empty description="No recent activity" />
        )}
      </Drawer>
    </div>
  );
}
