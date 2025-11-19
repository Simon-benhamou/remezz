import React from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Tag,
  Typography,
  message,
  theme,
} from 'antd';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  CheckCircleOutlined,
  CloudOutlined,
  DatabaseOutlined,
  ExclamationCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  StopOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '../icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import RecentTradesTable from '../components/RecentTradesTable';
import AgentHealthTable, { type AgentHealthRow } from '../components/AgentHealthTable';
import { formatDisplaySymbol } from '../utils/symbols';
import PerformanceOverviewCard from '../components/PerformanceOverviewCard';
import { useDashboard } from '../hooks/useDashboard';
import { useAppStore } from '../store';
import JobsStatusPanel from '../components/JobsStatusPanel';
import { useOpsJobs } from '../hooks/useOpsJobs';
import { collectOpsEventReasons, formatOpsEventMessage } from '../utils/opsEvents';
import {
  STRATEGY_META,
  normalizeStrategyEngine,
  type StrategyEngineOption,
} from '../utils/strategies';

const { Title, Text } = Typography;

type ActivityPoint = {
  timestamp: number;
  label: string;
  trades: number;
};

type AggressivenessLevel = 'conservative' | 'reactive' | 'aggressive';

type GlobalHealth = {
  tone: 'success' | 'warning' | 'error' | 'info';
  icon: React.ReactNode;
  color: string;
  label: string;
  description: string;
};

type OpsEvent = {
  id: string;
  ts?: number;
  level?: 'info' | 'warn' | 'error';
  source?: string;
  message?: string;
  sessionId?: string;
  symbol?: string;
  details?: any;
};

type ChecklistStatus = 'pass' | 'fail' | 'warn' | 'n/a';

type MetaEntryChecklistRow = {
  key: string;
  label: string;
  status: ChecklistStatus;
  detail?: string | null;
  score?: number | null;
};

type MetaEntryChecklistDetails = {
  decision?: 'executed' | 'blocked';
  blockedReason?: string | null;
  registrationResult?: string;
  confidence?: { passed?: boolean; value?: number | null; threshold?: number | null };
  entryEligibility?: { passed?: boolean; score?: number | null; threshold?: number | null };
  rr?: { value?: number | null; threshold?: number | null; passed?: boolean };
  minHold?: { enabled?: boolean; minutes?: number };
  table?: MetaEntryChecklistRow[];
  failedChecks?: string[];
  strategy?: string;
  timestamp?: number;
  entryReasons?: string[];
  symbol?: string;
};

type IncoherenceSeverity = 'info' | 'low' | 'moderate' | 'high' | 'critical';
type IncoherenceCategory = 'predictor' | 'strategy' | 'execution' | 'state' | 'data' | 'ops';

type IncoherenceEvent = {
  id: string;
  ts: number;
  severity: IncoherenceSeverity;
  category: IncoherenceCategory;
  code: string;
  message: string;
  sessionId?: string | null;
  symbol?: string | null;
  source?: string | null;
  requiresAction?: boolean;
  details?: Record<string, any> | null;
  tags?: string[];
};

type IncoherenceSummary = {
  total: number;
  windowMs: number | null;
  bySeverity: Record<IncoherenceSeverity, number>;
  byCategory: Record<IncoherenceCategory, number>;
  topSessions: Array<{ sessionId: string | null; symbol: string | null; count: number; lastEventTs: number }>;
  topCodes: Array<{ code: string; count: number }>;
  newest?: IncoherenceEvent | null;
};

function formatPercent(value?: number | null, digits = 1) {
  if (value == null || Number.isNaN(value)) return '0%';
  return `${Number(value).toFixed(digits)}%`;
}

function formatUsd(value?: number | null, digits = 2) {
  if (value == null || Number.isNaN(value)) return '$0.00';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(Number(value)).toFixed(digits)}`;
}

function formatRelative(ts?: number | null) {
  if (!ts) return '—';
  const delta = Date.now() - ts;
  if (delta < 60_000) return 'Just now';
  if (delta < 3_600_000) {
    const minutes = Math.round(delta / 60_000);
    return `${minutes} min ago`;
  }
  if (delta < 86_400_000) {
    const hours = Math.round(delta / 3_600_000);
    return `${hours}h ago`;
  }
  const days = Math.round(delta / 86_400_000);
  return `${days}d ago`;
}

function resolveGlobalHealth(metrics?: any): GlobalHealth {
  const alerts = metrics?.alerts?.lastHour ?? {};
  const protectiveIssues = Number(metrics?.positions?.protectiveIssues || 0);
  const halted = Number(metrics?.sessions?.halted || 0);
  const managing = Number(metrics?.sessions?.managing || 0);

  if ((alerts.high ?? 0) > 0 || protectiveIssues > 0) {
    return {
      tone: 'error',
      icon: <ExclamationCircleOutlined />,
      color: '#f87171',
      label: 'Critical risk',
      description: 'Resolve protective gaps and high-severity alerts immediately.',
    };
  }
  if (halted > 0 || (alerts.med ?? 0) > 2) {
    return {
      tone: 'warning',
      icon: <WarningOutlined />,
      color: '#fbbf24',
      label: 'Degraded',
      description: 'Some agents require attention before resuming normal ops.',
    };
  }
  if (managing > 0) {
    return {
      tone: 'success',
      icon: <CheckCircleOutlined />,
      color: '#34d399',
      label: 'Operational',
      description: 'Agents are trading and protective systems are green.',
    };
  }
  return {
    tone: 'info',
    icon: <ThunderboltOutlined />,
    color: '#60a5fa',
    label: 'Idle',
    description: 'No active agents detected in the current mode.',
  };
}

function buildActivitySeries(trades: any[]): ActivityPoint[] {
  if (!Array.isArray(trades) || trades.length === 0) return [];
  const buckets = new Map<number, ActivityPoint>();
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  for (const trade of trades) {
    if (!trade?.createdAt) continue;
    const ts = new Date(trade.createdAt).getTime();
    if (!Number.isFinite(ts)) continue;
    const bucketTs = Math.floor(ts / (60 * 60 * 1000)) * 60 * 60 * 1000;
    const existing = buckets.get(bucketTs);
    if (existing) {
      existing.trades += 1;
    } else {
      buckets.set(bucketTs, {
        timestamp: bucketTs,
        label: formatter.format(new Date(bucketTs)),
        trades: 1,
      });
    }
  }
  const sorted = Array.from(buckets.values()).sort((a, b) => a.timestamp - b.timestamp);
  return sorted.slice(-12);
}

const severityMeta: Record<string, { color: string; label: string }> = {
  info: { color: '#38bdf8', label: 'Info' },
  warn: { color: '#fbbf24', label: 'Watch' },
  error: { color: '#f87171', label: 'Action' },
};

const COMPLIANCE_KEYWORDS = [
  'compliance',
  'protective',
  'security',
  'guardrail',
  'safeguard',
  'telemetry',
  'timeout',
  'halt',
  'lockdown',
  'kill switch',
  'risk',
];

const AGGRESSIVENESS_META: Record<AggressivenessLevel, { label: string; color: string }> = {
  conservative: { label: 'Conservative', color: '#0ea5e9' },
  reactive: { label: 'Reactive', color: '#a855f7' },
  aggressive: { label: 'Aggressive', color: '#ef4444' },
};

const incoherenceSeverityMeta: Record<IncoherenceSeverity, { label: string; color: string; bg: string }> = {
  critical: { label: 'Critical', color: '#f87171', bg: 'rgba(248, 113, 113, 0.16)' },
  high: { label: 'High', color: '#fb923c', bg: 'rgba(251, 146, 60, 0.16)' },
  moderate: { label: 'Moderate', color: '#facc15', bg: 'rgba(250, 204, 21, 0.16)' },
  low: { label: 'Low', color: '#34d399', bg: 'rgba(52, 211, 153, 0.16)' },
  info: { label: 'Info', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.16)' },
};

const incoherenceCategoryMeta: Record<IncoherenceCategory, { label: string; color: string }> = {
  predictor: { label: 'Predictor', color: '#60a5fa' },
  strategy: { label: 'Strategy', color: '#a855f7' },
  execution: { label: 'Execution', color: '#f97316' },
  state: { label: 'State', color: '#f472b6' },
  data: { label: 'Data', color: '#22d3ee' },
  ops: { label: 'Ops', color: '#38bdf8' },
};

const OperationsDashboardPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    overview,
    opsMetrics,
    opsEvents,
    loadOverview,
    loadOpsMetrics,
    loadOpsEvents,
  } = useDashboard();

  const [refreshing, setRefreshing] = React.useState(false);
  const [agentHealth, setAgentHealth] = React.useState<any>(null);
  const [agentHealthLoading, setAgentHealthLoading] = React.useState(false);
  const [recentTrades, setRecentTrades] = React.useState<any[]>([]);
  const [recentTradesLoading, setRecentTradesLoading] = React.useState(false);
  const [reselecting, setReselecting] = React.useState<Record<string, boolean>>({});
  const [strategyFilter, setStrategyFilter] = React.useState<'all' | StrategyEngineOption>('all');
  const [optimizing, setOptimizing] = React.useState(false);
  const [optimizingSymbol, setOptimizingSymbol] = React.useState('');
  const [incoherenceEvents, setIncoherenceEvents] = React.useState<IncoherenceEvent[]>([]);
  const [incoherenceSummary, setIncoherenceSummary] = React.useState<IncoherenceSummary | null>(null);
  const [incoherenceLoading, setIncoherenceLoading] = React.useState(false);
  const [incoherenceExporting, setIncoherenceExporting] = React.useState(false);
  const [viewMode, setViewMode] = React.useState<'overview' | 'positions' | 'agents' | 'performance'>('overview');
  const mode = useAppStore((state) => state.mode);
  const { jobs, loading: jobsLoading, refresh: refreshJobs, lastUpdated: jobsUpdatedAt } = useOpsJobs({ autoRefreshMs: 45000, enableLive: true });

  const strategyOptions = React.useMemo(
    () => {
      const rows = Array.isArray(agentHealth?.agents) ? (agentHealth.agents as AgentHealthRow[]) : [];
      const counts = new Map<StrategyEngineOption, number>();
      rows.forEach((row) => {
        const engine = normalizeStrategyEngine(row.strategyEngine);
        if (!engine) return;
        counts.set(engine, (counts.get(engine) ?? 0) + 1);
      });
      return Array.from(counts.entries()).map(([engine, count]) => ({ engine, count }));
    },
    [agentHealth],
  );

  const strategySelectOptions = React.useMemo(
    () => [
      { value: 'all' as const, label: 'All strategies' },
      ...strategyOptions.map(({ engine, count }) => ({
        value: engine,
        label: `${STRATEGY_META[engine].label} (${count})`,
      })),
    ],
    [strategyOptions],
  );

  React.useEffect(() => {
    if (strategyFilter === 'all') return;
    const stillAvailable = strategyOptions.some((option) => option.engine === strategyFilter);
    if (!stillAvailable) {
      setStrategyFilter('all');
    }
  }, [strategyFilter, strategyOptions]);

  const agentHealthForDisplay = React.useMemo(() => {
    if (!agentHealth) return null;
    if (strategyFilter === 'all') return agentHealth;
    const filtered = Array.isArray(agentHealth.agents)
      ? (agentHealth.agents as AgentHealthRow[]).filter(
          (row) => normalizeStrategyEngine(row.strategyEngine) === strategyFilter,
        )
      : [];
    return { ...agentHealth, agents: filtered };
  }, [agentHealth, strategyFilter]);

  const loadIncoherenceData = React.useCallback(async () => {
    setIncoherenceLoading(true);
    try {
      const [feedResp, summaryResp] = await Promise.all([
        api.getIncoherenceFeed({ limit: 40 }),
        api.getIncoherenceSummary(6 * 60 * 60 * 1000),
      ]);
      setIncoherenceEvents(Array.isArray(feedResp?.events) ? feedResp.events : []);
      setIncoherenceSummary(summaryResp?.summary ?? null);
    } catch (error) {
      console.error('Failed to load incoherence feed:', error);
    } finally {
      setIncoherenceLoading(false);
    }
  }, []);

  const loadRecentTrades = React.useCallback(async () => {
    setRecentTradesLoading(true);
    try {
      const trades = await api.getTrades(undefined, { limit: 120 });
      setRecentTrades(Array.isArray(trades) ? trades : []);
    } finally {
      setRecentTradesLoading(false);
    }
  }, []);

  const refreshAll = React.useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        loadOverview(true),
        loadOpsMetrics(),
        loadOpsEvents(),
        loadIncoherenceData(),
        (async () => {
          setAgentHealthLoading(true);
          try {
            const data = await api.getAgentHealth();
            setAgentHealth(data);
          } finally {
            setAgentHealthLoading(false);
          }
        })(),
        loadRecentTrades(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [loadOverview, loadOpsMetrics, loadOpsEvents, loadIncoherenceData]);

  React.useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // Auto-refresh recent trades every 10 seconds
  React.useEffect(() => {
    const interval = setInterval(() => {
      void loadRecentTrades();
    }, 10000);
    return () => clearInterval(interval);
  }, [loadRecentTrades]);

  React.useEffect(() => {
    void loadIncoherenceData();
    const interval = setInterval(() => {
      void loadIncoherenceData();
    }, 20000);
    return () => clearInterval(interval);
  }, [loadIncoherenceData]);

  const handleSmartReselect = React.useCallback(
    async (sessionId: string) => {
      if (!sessionId) return;
      setReselecting((prev) => ({ ...prev, [sessionId]: true }));
      try {
        const result = await api.triggerSmartReselect(sessionId);
        if (result?.success) {
          const from = result.oldSymbol || 'current';
          const to = result.newSymbol || result.currentSymbol || 'current';
          message.success(`Market refreshed: ${from} → ${to}`);
        } else {
          const reason = result?.reason ? String(result.reason) : 'No change required';
          message.info(reason);
        }
        await refreshAll();
      } catch (error: any) {
        const msg = error?.response?.data?.error || error?.message || 'Re-selection failed';
        message.error(msg);
      } finally {
        setReselecting((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
      }
    },
    [refreshAll],
  );

  const handleOptimizeSymbol = React.useCallback(async () => {
    const symbol = optimizingSymbol.trim();
    if (!symbol) {
      message.warning('Please enter a symbol');
      return;
    }

    setOptimizing(true);
    try {
      const result = await api.optimizeSymbol(symbol);
      if (result?.success) {
        message.success(result.message || `Optimized parameters for ${symbol}`);
        setOptimizingSymbol('');
      } else {
        message.warning(result?.message || 'Optimization completed with no changes');
      }
    } catch (error: any) {
      const msg = error?.response?.data?.message || error?.message || 'Optimization failed';
      message.error(msg);
    } finally {
      setOptimizing(false);
    }
  }, [optimizingSymbol]);

  const handleOptimizeAll = React.useCallback(async () => {
    console.log('🚀 Starting optimize all symbols (regime-aware)...');
    setOptimizing(true);
    try {
      const result = await api.optimizeAllSymbols();
      console.log('✅ Optimization result:', result);
      
      if (result?.success) {
        message.success(result.message || `Optimized ${result.count} symbols`);
      } else {
        console.warn('⚠️ No symbols were optimized');
        message.warning('No symbols were optimized');
      }
    } catch (error: any) {
      console.error('❌ Optimization error:', error);
      console.error('   Response data:', error?.response?.data);
      const msg = error?.response?.data?.message || error?.message || 'Batch optimization failed';
      message.error(msg);
      
      // Show more details in development
      if (error?.response?.data?.details) {
        console.error('   Details:', error.response.data.details);
      }
    } finally {
      setOptimizing(false);
    }
  }, []);

  const handleExportIncoherences = React.useCallback(async () => {
    setIncoherenceExporting(true);
    try {
      const bundle = await api.exportIncoherences({ limit: 400 });
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `incoherence-feed-${new Date().toISOString()}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      message.success('Incoherence feed exported');
    } catch (error) {
      console.error('Failed to export incoherences:', error);
      message.error('Export failed');
    } finally {
      setIncoherenceExporting(false);
    }
  }, []);

  const { token } = theme.useToken();
  const metricsTimestamp = opsMetrics?.timestamp
    ? new Date(opsMetrics.timestamp).toLocaleTimeString()
    : '—';

  const capitalPool = React.useMemo(() => {
    const pool = overview?.capitalPool;
    if (!pool) return null;
    if (mode === 'live') return pool.live ?? null;
    return pool.paper ?? null;
  }, [overview, mode]);

  const totalEquityUsd = Number(
    capitalPool?.totalUsd ??
      (mode === 'live' ? overview?.exchangeBalance?.totalUsd : overview?.paperBalance?.equityUsd) ??
      overview?.equityUsd ??
      0,
  );
  const freeCapitalUsd = Number(capitalPool?.freeUsd ?? 0);
  const reservedCapitalUsd = Number(capitalPool?.reservedUsd ?? 0);
  const inPositionsUsd = Number(capitalPool?.inPositionsUsd ?? 0);
  const pnlUsd = Number(overview?.pnlUsd || 0);
  const roiPct = Number(overview?.roiPct || 0);
  const netRoiCandidate = Number(overview?.netRoiPct);
  const netRoiPct = Number.isFinite(netRoiCandidate) ? netRoiCandidate : roiPct;
  const activeAgents = Number(overview?.activeCount || 0);
  const marketsTracked = Array.isArray(overview?.symbols) ? overview?.symbols.length : 0;

  const totalTrades24h = React.useMemo(() => {
    if (!agentHealthForDisplay?.agents) return 0;
    return (agentHealthForDisplay.agents as AgentHealthRow[]).reduce(
      (acc: number, row) => acc + Number(row.tradeCount24h || 0),
      0,
    );
  }, [agentHealthForDisplay]);

  const tradesSummary = React.useMemo(() => {
    if (!recentTrades.length) {
      return {
        totalPnl: 0,
        winRate: 0,
        lastTradeAt: null as number | null,
        closedTrades: 0,
        profitableTrades: 0,
        unprofitableTrades: 0,
      };
    }
    let wins = 0;
    let losses = 0;
    let totalPnlAcc = 0;
    let lastTs = 0;
    for (const trade of recentTrades) {
      const pnl = Number(trade?.realizedPnlUsd || 0);
      totalPnlAcc += pnl;
      if (pnl > 0) wins += 1;
      else if (pnl < 0) losses += 1;
      const ts = trade?.createdAt ? new Date(trade.createdAt).getTime() : 0;
      if (ts > lastTs) lastTs = ts;
    }
    const total = wins + losses;
    return {
      totalPnl: totalPnlAcc,
      winRate: total > 0 ? (wins / total) * 100 : 0,
      lastTradeAt: lastTs || null,
      closedTrades: total,
      profitableTrades: wins,
      unprofitableTrades: losses,
    };
  }, [recentTrades]);

  const highlightedIncoherenceEvents = React.useMemo(
    () => (Array.isArray(incoherenceEvents) ? incoherenceEvents.slice(0, 8) : []),
    [incoherenceEvents],
  );

  const incoherenceSeverityBreakdown = React.useMemo(() => {
    if (!incoherenceSummary?.bySeverity) return [];
    const order: IncoherenceSeverity[] = ['critical', 'high', 'moderate', 'low', 'info'];
    return order.map((severity) => ({
      severity,
      count: incoherenceSummary.bySeverity[severity] ?? 0,
    }));
  }, [incoherenceSummary]);

  const topIncoherenceSessions = React.useMemo(() => {
    if (!Array.isArray(incoherenceSummary?.topSessions)) return [];
    return incoherenceSummary.topSessions.slice(0, 4);
  }, [incoherenceSummary]);

  const topIncoherenceCodes = React.useMemo(() => {
    if (!Array.isArray(incoherenceSummary?.topCodes)) return [];
    return incoherenceSummary.topCodes.slice(0, 4);
  }, [incoherenceSummary]);

  const incoherenceWindowLabel = React.useMemo(() => {
    const windowMs = incoherenceSummary?.windowMs;
    if (!windowMs) return 'Full feed';
    if (windowMs >= 86_400_000) return `${Math.round(windowMs / 86_400_000)}d window`;
    if (windowMs >= 3_600_000) return `${Math.round(windowMs / 3_600_000)}h window`;
    if (windowMs >= 60_000) return `${Math.round(windowMs / 60_000)}m window`;
    return `${windowMs / 1000}s window`;
  }, [incoherenceSummary]);

  const activitySeries = React.useMemo(() => buildActivitySeries(recentTrades), [recentTrades]);
  const latestEvents = React.useMemo(
    () => (Array.isArray(opsEvents) ? opsEvents.slice(0, 6) : []),
    [opsEvents],
  );
  const complianceHighlights = React.useMemo(() => {
    if (!Array.isArray(opsEvents)) return [] as OpsEvent[];
    return opsEvents
      .filter((evt) => {
        const haystack = `${evt.message ?? ''} ${evt.source ?? ''} ${JSON.stringify(evt.details ?? {})}`.toLowerCase();
        return COMPLIANCE_KEYWORDS.some((keyword) => haystack.includes(keyword));
      })
      .slice(0, 5);
  }, [opsEvents]);
  const safeguardSnapshot = React.useMemo(() => {
    const protectiveIssues = Number(opsMetrics?.positions?.protectiveIssues ?? 0);
    const haltedSessions = Number(opsMetrics?.sessions?.halted ?? 0);
    const managingSessions = Number(opsMetrics?.sessions?.managing ?? 0);
    return {
      protectiveIssues,
      haltedSessions,
      managingSessions,
      complianceSignals: complianceHighlights.length,
    };
  }, [opsMetrics, complianceHighlights]);
  const metaChecklistEvents = React.useMemo(() => {
    if (!Array.isArray(opsEvents)) return [];
    return opsEvents
      .filter((evt) => evt.message === 'meta_entry_checklist')
      .slice(0, 4);
  }, [opsEvents]);

  const aggressivenessStats = React.useMemo(() => {
    const rows = Array.isArray(agentHealthForDisplay?.agents)
      ? (agentHealthForDisplay.agents as AgentHealthRow[])
      : [];
    if (!rows.length)
      return [] as Array<{
        level: AggressivenessLevel;
        label: string;
        successRate: number;
        totalAgents: number;
        profitableAgents: number;
        winTrades: number;
        lossTrades: number;
        breakevenTrades: number;
        avgTrades: number;
      }>;
    const order: AggressivenessLevel[] = ['conservative', 'reactive', 'aggressive'];
    const buckets: Record<
      AggressivenessLevel,
      {
        totalAgents: number;
        tradeCount: number;
        winTrades: number;
        lossTrades: number;
        breakevenTrades: number;
        profitableAgents: number;
      }
    > = {
      conservative: { totalAgents: 0, tradeCount: 0, winTrades: 0, lossTrades: 0, breakevenTrades: 0, profitableAgents: 0 },
      reactive: { totalAgents: 0, tradeCount: 0, winTrades: 0, lossTrades: 0, breakevenTrades: 0, profitableAgents: 0 },
      aggressive: { totalAgents: 0, tradeCount: 0, winTrades: 0, lossTrades: 0, breakevenTrades: 0, profitableAgents: 0 },
    };
    rows.forEach((row: AgentHealthRow) => {
      const raw = (row.aggressiveness ?? (row as any)?.profile?.aggressiveness ?? (row as any)?.profileJson?.aggressiveness) as AggressivenessLevel | undefined;
      const level = raw && AGGRESSIVENESS_META[raw] ? raw : row.aggressiveness === null ? null : 'reactive';
      if (!level) return;
      const bucket = buckets[level];
      bucket.totalAgents += 1;
      bucket.tradeCount += Number(row.tradeCount24h || 0);
      const wins = Number(row.wins24h || 0);
      const losses = Number(row.losses24h || 0);
      const breakeven = Number(row.breakeven24h || 0);
      bucket.winTrades += wins;
      bucket.lossTrades += losses;
      bucket.breakevenTrades += breakeven;
      if (wins > losses) {
        bucket.profitableAgents += 1;
      }
    });

    return order
      .map((level) => {
        const bucket = buckets[level];
        if (!bucket || bucket.totalAgents === 0) {
          return null;
        }
        const tradeDecisions = bucket.winTrades + bucket.lossTrades;
        const successRate = tradeDecisions ? Number(((bucket.winTrades / tradeDecisions) * 100).toFixed(1)) : 0;
        const avgTrades = bucket.totalAgents ? Number((bucket.tradeCount / bucket.totalAgents).toFixed(1)) : 0;
        return {
          level,
          label: AGGRESSIVENESS_META[level].label,
          successRate,
          totalAgents: bucket.totalAgents,
          profitableAgents: bucket.profitableAgents,
          winTrades: bucket.winTrades,
          lossTrades: bucket.lossTrades,
          breakevenTrades: bucket.breakevenTrades,
          avgTrades,
        };
      })
      .filter(Boolean) as Array<{
        level: AggressivenessLevel;
        label: string;
        successRate: number;
        totalAgents: number;
        profitableAgents: number;
        winTrades: number;
        lossTrades: number;
        breakevenTrades: number;
        avgTrades: number;
      }>;
  }, [agentHealthForDisplay]);

  const bestAggressiveness = React.useMemo(() => {
    if (!aggressivenessStats.length) return null;
    return aggressivenessStats.reduce((best, entry) => (entry.successRate > best.successRate ? entry : best), aggressivenessStats[0]);
  }, [aggressivenessStats]);

  const globalHealth = resolveGlobalHealth(opsMetrics);

  const summaryCards = [
    {
      key: 'capital',
      title: mode === 'live' ? 'Live capital pool' : 'Paper capital pool',
      value: formatUsd(totalEquityUsd),
      helper: `Free ${formatUsd(freeCapitalUsd)} · Reserved ${formatUsd(reservedCapitalUsd)} · In-pos ${formatUsd(inPositionsUsd)}`,
      accent: '#38bdf8',
    },
    {
      key: 'pnl',
      title: 'PnL',
      value: formatUsd(pnlUsd),
      helper: `Net equity ${formatUsd(totalEquityUsd)}`,
      accent: pnlUsd >= 0 ? '#34d399' : '#f87171',
    },
    {
      key: 'roi',
      title: 'ROI',
      value: formatPercent(roiPct, 2),
      helper: `Net ${formatPercent(netRoiPct, 2)}`,
      accent: roiPct >= 0 ? '#34d399' : '#f87171',
    },
    {
      key: 'agents',
      title: 'Active agents',
      value: activeAgents.toString(),
      helper: `${marketsTracked} markets tracked`,
      accent: '#a855f7',
    },
    {
      key: 'exec',
      title: '24h executions',
      value: totalTrades24h.toString(),
      helper: tradesSummary.lastTradeAt ? `Last trade ${formatRelative(tradesSummary.lastTradeAt)}` : 'No fills yet',
      accent: '#fbbf24',
    },
    {
      key: 'winRate',
      title: 'Win rate',
      value: formatPercent(tradesSummary.winRate, 1),
      helper: `Realised PnL ${formatUsd(tradesSummary.totalPnl)}`,
      accent: '#34d399',
    },
    {
      key: 'ai',
      title: 'AI calls',
      value: Number(opsMetrics?.ai?.totalCalls ?? overview?.aiCallsTotal ?? 0).toString(),
      helper: 'Model utilisation',
      accent: '#60a5fa',
    },
  ];

  const systemStatus = [
    {
      key: 'api',
      label: 'API Connection',
      icon: <DatabaseOutlined />,
      status: activeAgents > 0 ? 'Operational' : 'Idle',
      tone: activeAgents > 0 ? '#34d399' : '#fbbf24',
      helper: `${activeAgents} sessions connected`,
    },
    {
      key: 'market',
      label: 'Market Stream',
      icon: <CloudOutlined />,
      status: Number(opsMetrics?.alerts?.lastHour?.total || 0) > 0 ? 'Degraded' : 'Stable',
      tone: Number(opsMetrics?.alerts?.lastHour?.total || 0) > 0 ? '#fbbf24' : '#38bdf8',
      helper: `${Number(opsMetrics?.alerts?.lastHour?.total || 0)} alerts / 1h`,
    },
    {
      key: 'risk',
      label: 'Risk Monitor',
      icon: <WarningOutlined />,
      status: Number(opsMetrics?.positions?.protectiveIssues || 0) > 0
        ? `${opsMetrics?.positions?.protectiveIssues} issues`
        : 'Protected',
      tone: Number(opsMetrics?.positions?.protectiveIssues || 0) > 0 ? '#f87171' : '#34d399',
      helper: 'Protective coverage',
    },
  ];

  const diagnosticsEntries = React.useMemo(() => {
    const diagnostics = (opsMetrics?.diagnostics ?? opsMetrics?.health) as Record<string, any> | undefined;
    if (!diagnostics || typeof diagnostics !== 'object') return [] as Array<[string, string]>;
    return Object.entries(diagnostics)
      .filter(([key]) => !['timestamp', 'ts'].includes(key))
      .slice(0, 6)
      .map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value || '—')]);
  }, [opsMetrics]);

  const strategyHighlights = React.useMemo(() => {
    const raw = opsMetrics?.strategy?.conditions
      || opsMetrics?.strategy?.signals
      || opsMetrics?.strategy?.highlights;
    if (Array.isArray(raw)) {
      return raw.slice(0, 6).map((item: any, idx: number) => ({
        key: String(item?.id ?? idx),
        label: typeof item === 'string' ? item : item?.label ?? item?.title ?? 'Signal',
        detail: typeof item === 'string' ? undefined : item?.detail ?? item?.value,
      }));
    }
    if (raw && typeof raw === 'object') {
      return Object.entries(raw).slice(0, 6).map(([key, value]) => ({
        key,
        label: key,
        detail: typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—'),
      }));
    }
    return [] as Array<{ key: string; label: string; detail?: string }>;
  }, [opsMetrics]);

  return (
    <Space direction='vertical' size={24} style={{ width: '100%' }}>
      <Card
        style={{
          borderRadius: 20,
          border: `1px solid ${token.colorBorderSecondary}`,
          background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.92), rgba(30, 64, 175, 0.6))',
          overflow: 'hidden',
        }}
        bodyStyle={{ padding: 28 }}
      >
        <Row gutter={[24, 24]} align='middle'>
          <Col xs={24} md={16}>
            <Space direction='vertical' size={8}>
              <Tag color='blue' style={{ alignSelf: 'flex-start', borderRadius: 999 }}>
                Control Center
              </Tag>
              <Title level={2} style={{ margin: 0, color: '#e2e8f0' }}>
                Monitoring & automated execution overview
              </Title>
              <Text style={{ color: 'rgba(226, 232, 240, 0.72)', maxWidth: 520 }}>
                Track live performance, execution cadence and platform health across every autonomous agent.
              </Text>
            </Space>
          </Col>
          <Col xs={24} md={8}>
            <Space direction='vertical' size={12} style={{ width: '100%' }}>
              <Button
                type='primary'
                icon={<ReloadOutlined />}
                onClick={() => void refreshAll()}
                loading={refreshing || recentTradesLoading || agentHealthLoading}
                style={{ width: '100%', borderRadius: 12 }}
              >
                Refresh data
              </Button>
              <Alert
                message={
                  <Space align='center' size={8}>
                    <span style={{ color: globalHealth.color, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {globalHealth.icon}
                      {globalHealth.label}
                    </span>
                    <Tag color='geekblue' style={{ borderRadius: 8 }}>Snapshot {metricsTimestamp}</Tag>
                  </Space>
                }
                description={<span style={{ color: 'rgba(226, 232, 240, 0.78)' }}>{globalHealth.description}</span>}
                type={globalHealth.tone}
                showIcon={false}
                style={{
                  background: 'rgba(15, 23, 42, 0.85)',
                  borderRadius: 14,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  color: '#e2e8f0',
                }}
              />
            </Space>
          </Col>
        </Row>
      </Card>

      {/* Hero Section with Key Metrics */}
      <Card
        style={{
          borderRadius: 18,
          border: `1px solid ${token.colorBorderSecondary}`,
          background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.08), rgba(139, 92, 246, 0.05))',
          marginBottom: 24,
        }}
        bodyStyle={{ padding: '32px 24px' }}
      >
        <Row gutter={[24, 24]}>
          {/* Net P&L Card */}
          <Col xs={24} sm={12} lg={8}>
            <div
              style={{
                background: 'rgba(15, 23, 42, 0.7)',
                padding: 24,
                borderRadius: 16,
                border: `1px solid ${pnlUsd >= 0 ? 'rgba(52, 211, 153, 0.3)' : 'rgba(248, 113, 113, 0.3)'}`,
              }}
            >
              <Space direction='vertical' size={4} style={{ width: '100%' }}>
                <Text style={{ color: 'rgba(148, 163, 184, 0.85)', fontSize: 13 }}>Net P&L</Text>
                <Title level={2} style={{ margin: 0, color: pnlUsd >= 0 ? '#34d399' : '#f87171' }}>
                  {formatUsd(pnlUsd)}
                </Title>
                <Text style={{ color: 'rgba(148, 163, 184, 0.75)', fontSize: 12 }}>
                  {tradesSummary.closedTrades > 0 ? (
                    <>Realized: {formatUsd(tradesSummary.totalPnl)} · Unrealized: {formatUsd(pnlUsd - tradesSummary.totalPnl)}</>
                  ) : (
                    <>No closed trades yet</>
                  )}
                </Text>
              </Space>
            </div>
          </Col>

          {/* Win Rate Card */}
          <Col xs={24} sm={12} lg={8}>
            <div
              style={{
                background: 'rgba(15, 23, 42, 0.7)',
                padding: 24,
                borderRadius: 16,
                border: `1px solid rgba(96, 165, 250, 0.3)`,
              }}
            >
              <Space direction='vertical' size={4} style={{ width: '100%' }}>
                <Text style={{ color: 'rgba(148, 163, 184, 0.85)', fontSize: 13 }}>Win Rate</Text>
                <Title level={2} style={{ margin: 0, color: '#60a5fa' }}>
                  {formatPercent(tradesSummary.winRate, 1)}
                </Title>
                <Text style={{ color: 'rgba(148, 163, 184, 0.75)', fontSize: 12 }}>
                  {tradesSummary.closedTrades > 0 ? (
                    <>
                      {tradesSummary.profitableTrades}W / {tradesSummary.unprofitableTrades}L of {tradesSummary.closedTrades} trades
                    </>
                  ) : (
                    <>No closed trades yet</>
                  )}
                </Text>
              </Space>
            </div>
          </Col>

          {/* Risk Exposure Card */}
          <Col xs={24} sm={12} lg={8}>
            <div
              style={{
                background: 'rgba(15, 23, 42, 0.7)',
                padding: 24,
                borderRadius: 16,
                border: `1px solid rgba(168, 85, 247, 0.3)`,
              }}
            >
              <Space direction='vertical' size={4} style={{ width: '100%' }}>
                <Text style={{ color: 'rgba(148, 163, 184, 0.85)', fontSize: 13 }}>Risk Exposure</Text>
                <Title level={2} style={{ margin: 0, color: '#a855f7' }}>
                  {formatUsd(reservedCapitalUsd + inPositionsUsd)}
                </Title>
                <Text style={{ color: 'rgba(148, 163, 184, 0.75)', fontSize: 12 }}>
                  Reserved: {formatUsd(reservedCapitalUsd)} · In positions: {formatUsd(inPositionsUsd)}
                </Text>
              </Space>
            </div>
          </Col>
        </Row>

        {/* Quick Actions Bar */}
        <Row style={{ marginTop: 24 }} gutter={[12, 12]}>
          <Col xs={24} sm={12} lg={6}>
            <Button
              danger
              icon={<StopOutlined />}
              size='large'
              block
              style={{ borderRadius: 12, height: 48 }}
              onClick={() => {
                Modal.confirm({
                  title: 'Stop all agents?',
                  content: 'This will gracefully stop all active trading agents. Positions will be closed according to exit strategies.',
                  okText: 'Stop All',
                  okType: 'danger',
                  onOk: () => {
                    message.info('Stop all agents feature coming soon');
                  },
                });
              }}
            >
              Stop All Agents
            </Button>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Button
              type='primary'
              icon={<PlusOutlined />}
              size='large'
              block
              style={{ borderRadius: 12, height: 48, background: '#8b5cf6', borderColor: '#8b5cf6' }}
              onClick={() => navigate('/launch')}
            >
              Start New Agent
            </Button>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Button
              icon={<ReloadOutlined />}
              size='large'
              block
              style={{ borderRadius: 12, height: 48 }}
              onClick={() => void refreshAll()}
              loading={refreshing || recentTradesLoading || agentHealthLoading}
            >
              Refresh All
            </Button>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Button
              icon={<SettingOutlined />}
              size='large'
              block
              style={{ borderRadius: 12, height: 48 }}
              onClick={() => navigate('/settings')}
            >
              Settings
            </Button>
          </Col>
        </Row>
      </Card>

      {/* View Mode Selector */}
      <Card
        style={{
          borderRadius: 16,
          border: `1px solid ${token.colorBorderSecondary}`,
          marginBottom: 24,
        }}
        bodyStyle={{ padding: '16px 24px' }}
      >
        <Space size={12}>
          <Text style={{ color: 'rgba(148, 163, 184, 0.85)', fontWeight: 600 }}>View:</Text>
          <Button
            type={viewMode === 'overview' ? 'primary' : 'default'}
            onClick={() => setViewMode('overview')}
            style={{ borderRadius: 8 }}
          >
            Overview
          </Button>
          <Button
            type={viewMode === 'positions' ? 'primary' : 'default'}
            onClick={() => setViewMode('positions')}
            style={{ borderRadius: 8 }}
          >
            Positions
          </Button>
          <Button
            type={viewMode === 'agents' ? 'primary' : 'default'}
            onClick={() => setViewMode('agents')}
            style={{ borderRadius: 8 }}
          >
            Agents
          </Button>
          <Button
            type={viewMode === 'performance' ? 'primary' : 'default'}
            onClick={() => setViewMode('performance')}
            style={{ borderRadius: 8 }}
          >
            Performance
          </Button>
        </Space>
      </Card>

      {/* Conditional Alerts Section - Only shows when there are active alerts/risks */}
      {(() => {
        const alerts = opsMetrics?.alerts?.lastHour ?? {};
        const protectiveIssues = Number(opsMetrics?.positions?.protectiveIssues || 0);
        const halted = Number(opsMetrics?.sessions?.halted || 0);
        const circuitBreaker = opsMetrics?.circuitBreaker || null;
        const hasHighAlerts = (alerts.high ?? 0) > 0;
        const hasMediumAlerts = (alerts.med ?? 0) > 0;
        const hasIssues = protectiveIssues > 0 || halted > 0;
        const circuitBreakerTripped = circuitBreaker?.tripped === true;

        // Only show if there are actual issues
        if (!hasHighAlerts && !hasMediumAlerts && !hasIssues && !circuitBreakerTripped) {
          return null;
        }

        return (
          <Alert
            type={hasHighAlerts || protectiveIssues > 0 ? 'error' : 'warning'}
            showIcon
            style={{
              marginBottom: 24,
              borderRadius: 16,
              border: `1px solid ${hasHighAlerts || protectiveIssues > 0 ? 'rgba(248, 113, 113, 0.5)' : 'rgba(251, 191, 36, 0.5)'}`,
              background: hasHighAlerts || protectiveIssues > 0 ? 'rgba(248, 113, 113, 0.1)' : 'rgba(251, 191, 36, 0.1)',
            }}
            message={
              <Space>
                <Text style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 15 }}>
                  {hasHighAlerts || protectiveIssues > 0 ? '⚠️ Critical Issues Detected' : '⚡ Attention Required'}
                </Text>
              </Space>
            }
            description={
              <Space direction='vertical' size={12} style={{ width: '100%', marginTop: 8 }}>
                {hasHighAlerts && (
                  <div style={{ padding: '12px 16px', background: 'rgba(248, 113, 113, 0.15)', borderRadius: 12 }}>
                    <Space direction='vertical' size={4}>
                      <Text style={{ color: '#fca5a5', fontWeight: 600 }}>High Severity Alerts: {alerts.high}</Text>
                      <Text style={{ color: 'rgba(226, 232, 240, 0.85)', fontSize: 13 }}>
                        Immediate action required. Check the backlog for details.
                      </Text>
                    </Space>
                  </div>
                )}
                {protectiveIssues > 0 && (
                  <div style={{ padding: '12px 16px', background: 'rgba(248, 113, 113, 0.15)', borderRadius: 12 }}>
                    <Space direction='vertical' size={4}>
                      <Text style={{ color: '#fca5a5', fontWeight: 600 }}>Protective Issues: {protectiveIssues}</Text>
                      <Text style={{ color: 'rgba(226, 232, 240, 0.85)', fontSize: 13 }}>
                        Risk management systems have detected positions requiring attention.
                      </Text>
                    </Space>
                  </div>
                )}
                {halted > 0 && (
                  <div style={{ padding: '12px 16px', background: 'rgba(251, 191, 36, 0.15)', borderRadius: 12 }}>
                    <Space direction='vertical' size={4}>
                      <Text style={{ color: '#fbbf24', fontWeight: 600 }}>Halted Agents: {halted}</Text>
                      <Text style={{ color: 'rgba(226, 232, 240, 0.85)', fontSize: 13 }}>
                        Some agents have been automatically halted due to risk conditions.
                      </Text>
                    </Space>
                  </div>
                )}
                {circuitBreakerTripped && (
                  <div style={{ padding: '12px 16px', background: 'rgba(248, 113, 113, 0.2)', borderRadius: 12 }}>
                    <Space direction='vertical' size={4}>
                      <Text style={{ color: '#f87171', fontWeight: 600 }}>🛑 Circuit Breaker Activated</Text>
                      <Text style={{ color: 'rgba(226, 232, 240, 0.85)', fontSize: 13 }}>
                        Trading has been automatically paused. {circuitBreaker?.reason || 'Review system status before resuming.'}
                      </Text>
                    </Space>
                  </div>
                )}
                {hasMediumAlerts && !hasHighAlerts && (
                  <div style={{ padding: '12px 16px', background: 'rgba(251, 191, 36, 0.15)', borderRadius: 12 }}>
                    <Space direction='vertical' size={4}>
                      <Text style={{ color: '#fbbf24', fontWeight: 600 }}>Medium Severity Alerts: {alerts.med}</Text>
                      <Text style={{ color: 'rgba(226, 232, 240, 0.85)', fontSize: 13 }}>
                        Monitor these alerts to prevent escalation.
                      </Text>
                    </Space>
                  </div>
                )}
                <Button
                  type='primary'
                  danger={hasHighAlerts || protectiveIssues > 0}
                  onClick={() => navigate('/backlog')}
                  style={{ marginTop: 8 }}
                >
                  View All Alerts & Details
                </Button>
              </Space>
            }
          />
        );
      })()}

      {/* Active Positions Overview */}
      {(() => {
        const activePositions = (agentHealthForDisplay?.agents as any[] || [])
          .filter((agent: any) => {
            const positions = agent.positions as any[] || [];
            return positions.some((pos: any) => Number(pos?.qty || 0) > 0);
          })
          .flatMap((agent: any) => {
            const positions = agent.positions as any[] || [];
            return positions
              .filter((pos: any) => Number(pos?.qty || 0) > 0)
              .map((pos: any) => ({
                sessionId: agent.sessionId,
                agentId: agent.agentId || agent.sessionId?.slice(0, 8) || 'N/A',
                symbol: pos.symbol || agent.symbol || 'UNKNOWN',
                side: pos.side || 'UNKNOWN',
                leverage: Number(pos.leverage || 1),
                qty: Number(pos.qty || 0),
                entryPrice: Number(pos.entryPrice || 0),
                unrealizedPnl: Number(pos.unrealizedPnl || 0),
                healthStatus: agent.status || 'unknown',
              }));
          });

        if (activePositions.length === 0) return null;

        return (
          <Card
            title={
              <Space>
                <Text style={{ color: '#e2e8f0', fontSize: 16, fontWeight: 600 }}>
                  Active Positions ({activePositions.length})
                </Text>
              </Space>
            }
            style={{
              borderRadius: 18,
              border: `1px solid ${token.colorBorderSecondary}`,
              marginBottom: 24,
            }}
            bodyStyle={{ padding: 16 }}
          >
            <Row gutter={[16, 16]}>
              {activePositions.map((pos: any, idx: number) => {
                const pnlColor = pos.unrealizedPnl >= 0 ? '#34d399' : '#f87171';
                const pnlPercent = pos.entryPrice > 0 ? (pos.unrealizedPnl / (pos.entryPrice * pos.qty)) * 100 : 0;
                const healthColor = pos.healthStatus === 'ok' ? '#34d399' :
                                    pos.healthStatus === 'idle' ? '#60a5fa' :
                                    pos.healthStatus === 'stale' ? '#fbbf24' :
                                    pos.healthStatus === 'blocked' ? '#f87171' : '#94a3b8';

                return (
                  <Col xs={24} sm={12} lg={8} key={`${pos.sessionId}-${idx}`}>
                    <div
                      onClick={() => navigate(`/agents/${pos.sessionId}`)}
                      style={{
                        background: 'rgba(15, 23, 42, 0.7)',
                        padding: 16,
                        borderRadius: 14,
                        border: `1px solid ${token.colorBorderSecondary}`,
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = '#60a5fa';
                        e.currentTarget.style.transform = 'translateY(-2px)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = token.colorBorderSecondary;
                        e.currentTarget.style.transform = 'translateY(0)';
                      }}
                    >
                      <Space direction='vertical' size={8} style={{ width: '100%' }}>
                        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                          <Space size={8}>
                            <Tag color={pos.side === 'LONG' ? 'green' : pos.side === 'SHORT' ? 'red' : 'default'}>
                              {pos.side}
                            </Tag>
                            <Text style={{ color: '#e2e8f0', fontWeight: 600 }}>
                              {formatDisplaySymbol(pos.symbol)}
                            </Text>
                            {pos.leverage > 1 && (
                              <Tag color='purple' style={{ borderRadius: 6 }}>
                                {pos.leverage}x
                              </Tag>
                            )}
                          </Space>
                          <div
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              background: healthColor,
                            }}
                          />
                        </Space>
                        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                          <Space direction='vertical' size={2}>
                            <Text style={{ color: 'rgba(148, 163, 184, 0.75)', fontSize: 11 }}>P&L</Text>
                            <Text style={{ color: pnlColor, fontWeight: 600, fontSize: 14 }}>
                              {formatUsd(pos.unrealizedPnl)}
                            </Text>
                          </Space>
                          <Space direction='vertical' size={2} align='end'>
                            <Text style={{ color: 'rgba(148, 163, 184, 0.75)', fontSize: 11 }}>%</Text>
                            <Text style={{ color: pnlColor, fontWeight: 600, fontSize: 14 }}>
                              {formatPercent(pnlPercent, 2)}
                            </Text>
                          </Space>
                        </Space>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 11 }}>
                          Agent: {pos.agentId}
                        </Text>
                      </Space>
                    </div>
                  </Col>
                );
              })}
            </Row>
          </Card>
        );
      })()}

      {/* Overview Mode: Jobs + Summary Cards */}
      {(viewMode === 'overview') && (
        <>
          <Row gutter={[24, 24]}>
            <Col span={24}>
              <JobsStatusPanel
                jobs={jobs}
                loading={jobsLoading}
                onRefresh={refreshJobs}
                title='Background jobs'
                updatedAt={jobsUpdatedAt}
              />
            </Col>
          </Row>

          <Row gutter={[24, 24]}>
            {summaryCards.map((card) => (
              <Col xs={24} sm={12} xl={8} xxl={4} key={card.key}>
                <Card
                  style={{
                    borderRadius: 18,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    background: 'rgba(15, 23, 42, 0.92)',
                    height: '100%',
                  }}
                  bodyStyle={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}
                >
                  <Text style={{ color: 'rgba(148, 163, 184, 0.78)', fontSize: 12 }}>{card.title}</Text>
                  <Title level={3} style={{ margin: 0, color: card.accent }}>{card.value}</Title>
                  <Text style={{ color: 'rgba(148, 163, 184, 0.78)', fontSize: 12 }}>{card.helper}</Text>
                </Card>
              </Col>
            ))}
          </Row>
        </>
      )}

      {/* Performance Mode: Aggressiveness Chart */}
      {(viewMode === 'performance' || viewMode === 'overview') && (
      <>
      <Row gutter={[24, 24]}>
        <Col span={24}>
      <Card
        title={<span style={{ color: '#e2e8f0' }}>Execution success by aggressiveness</span>}
        extra={(
          <Space size={12}>
            <Select
              size='small'
              style={{ minWidth: 180 }}
              value={strategyFilter}
              onChange={(value) => setStrategyFilter(value as 'all' | StrategyEngineOption)}
              options={strategySelectOptions}
              disabled={strategySelectOptions.length <= 1}
              dropdownMatchSelectWidth={false}
            />
            {bestAggressiveness ? (
              <Tag color={AGGRESSIVENESS_META[bestAggressiveness.level].color}>
                Top: {bestAggressiveness.label} · {bestAggressiveness.successRate}%
              </Tag>
            ) : null}
          </Space>
        )}
        style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
        bodyStyle={{ padding: 24 }}
      >
        {aggressivenessStats.length === 0 ? (
          <Empty description='No agent activity captured yet.' style={{ color: 'rgba(148, 163, 184, 0.7)' }} />
        ) : (
          <Row gutter={[24, 24]} align='middle'>
            <Col xs={24} lg={14} style={{ height: 260 }}>
              <ResponsiveContainer width='100%' height='100%'>
                <BarChart data={aggressivenessStats} barSize={38}>
                  <CartesianGrid stroke='rgba(148, 163, 184, 0.15)' vertical={false} />
                  <XAxis dataKey='label' stroke='rgba(148, 163, 184, 0.7)' tickLine={false} axisLine={false} />
                  <YAxis stroke='rgba(148, 163, 184, 0.7)' tickFormatter={(value) => `${value}%`} tickLine={false} axisLine={false} domain={[0, 100]} />
                  <RechartsTooltip
                    contentStyle={{
                      background: 'rgba(15, 23, 42, 0.92)',
                      borderRadius: 12,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      color: '#e2e8f0',
                    }}
                    formatter={(value: number, _name, entry) => {
                      const stat = entry?.payload as typeof aggressivenessStats[number];
                      return [
                        `${value}% success`,
                        `${stat.totalAgents} agents · ${stat.avgTrades} trades/agent · ${stat.winTrades} wins / ${stat.lossTrades} losses`,
                      ];
                    }}
                  />
                  <Bar dataKey='successRate' radius={[8, 8, 0, 0]}>
                    {aggressivenessStats.map((entry) => (
                      <Cell key={entry.level} fill={AGGRESSIVENESS_META[entry.level].color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Col>
            <Col xs={24} lg={10}>
              <Space direction='vertical' size={16} style={{ width: '100%' }}>
                {aggressivenessStats.map((entry) => (
                  <div
                    key={entry.level}
                    style={{
                      borderRadius: 14,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      padding: 16,
                      background: 'rgba(15, 23, 42, 0.6)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <Space direction='vertical' size={4}>
                      <Space size={8}>
                        <Tag color={AGGRESSIVENESS_META[entry.level].color} style={{ borderRadius: 8 }}>
                          {entry.label}
                        </Tag>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.75)' }}>{entry.totalAgents} agents</Text>
                      </Space>
                      <Text style={{ color: '#e2e8f0' }}>
                        Success {entry.successRate}% · Avg trades {entry.avgTrades} · {entry.winTrades} wins
                      </Text>
                    </Space>
                    <Statistic
                      title={<span style={{ color: 'rgba(148, 163, 184, 0.75)' }}>Profitable agents</span>}
                      value={entry.profitableAgents}
                      valueStyle={{ color: '#34d399', fontSize: 24 }}
                      suffix={<span style={{ color: 'rgba(148, 163, 184, 0.75)', fontSize: 12 }}>/{entry.totalAgents}</span>}
                    />
                  </div>
                ))}
              </Space>
            </Col>
          </Row>
        )}
      </Card>
        </Col>
      </Row>

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={14}>
          <PerformanceOverviewCard
            trades={recentTrades}
            loading={recentTradesLoading || refreshing}
            title='Portfolio performance'
            subtitle='Cumulative realised PnL across the monitored sessions'
          />
        </Col>
        <Col xs={24} xl={10}>
          <Card
            title={<span style={{ color: '#e2e8f0' }}>Agent activity</span>}
            extra={<Tag color='geekblue'>Last 12 hours</Tag>}
            style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
            bodyStyle={{ height: 280, padding: 20 }}
          >
            {activitySeries.length === 0 ? (
              <Empty description='No executions yet.' style={{ marginTop: 40, color: 'rgba(148, 163, 184, 0.78)' }} />
            ) : (
              <ResponsiveContainer width='100%' height='100%'>
                <AreaChart data={activitySeries}>
                  <defs>
                    <linearGradient id='agentActivityGradient' x1='0' y1='0' x2='0' y2='1'>
                      <stop offset='0%' stopColor='#60a5fa' stopOpacity={0.8} />
                      <stop offset='100%' stopColor='#60a5fa' stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey='label' stroke='rgba(148, 163, 184, 0.7)' tickLine={false} axisLine={false} />
                  <YAxis stroke='rgba(148, 163, 184, 0.7)' tickLine={false} axisLine={false} allowDecimals={false} />
                  <RechartsTooltip
                    contentStyle={{
                      background: 'rgba(15, 23, 42, 0.92)',
                      borderRadius: 12,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      color: '#e2e8f0',
                    }}
                    formatter={(value: number) => [`${value} trades`, 'Executions']}
                  />
                  <Area type='monotone' dataKey='trades' stroke='#60a5fa' fill='url(#agentActivityGradient)' strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </Card>
        </Col>
      </Row>
      </>
      )}

      {/* Overview Mode: System Status + Strategy Optimizer */}
      {(viewMode === 'overview') && (
      <Row gutter={[24, 24]}>
        <Col xs={24} xl={10}>
          <Card
            title={<span style={{ color: '#e2e8f0' }}>System status</span>}
            style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
            bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 16 }}
          >
            {systemStatus.map((item) => (
              <div
                key={item.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: 'rgba(15, 23, 42, 0.7)',
                  padding: '14px 16px',
                  borderRadius: 14,
                  border: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <Space size={14}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 12,
                      background: 'rgba(96, 165, 250, 0.2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#60a5fa',
                      fontSize: 16,
                    }}
                  >
                    {item.icon}
                  </div>
                  <Space direction='vertical' size={2}>
                    <Text style={{ color: '#e2e8f0', fontWeight: 600 }}>{item.label}</Text>
                    <Text style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>{item.helper}</Text>
                  </Space>
                </Space>
                <Badge color={item.tone} text={<span style={{ color: item.tone }}>{item.status}</span>} />
              </div>
            ))}
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card
            title={<span style={{ color: '#e2e8f0' }}>Strategy Optimizer</span>}
            style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
            bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 16 }}
          >
            <Alert
              message='Machine Learning Parameter Optimization'
              description={
                <span style={{ color: 'rgba(226, 232, 240, 0.78)' }}>
                  Analyze historical trade evaluations to find optimal strategy parameters for each symbol using regime-aware optimization.
                  The optimizer uses grid search to maximize Sharpe ratio, win rate, and total PnL across different market regimes 
                  (volatility levels, direction bias, volume, and trending/ranging conditions).
                </span>
              }
              type='info'
              showIcon
              style={{
                background: 'rgba(59, 130, 246, 0.1)',
                borderRadius: 12,
                border: `1px solid rgba(59, 130, 246, 0.3)`,
              }}
            />
            <div
              style={{
                background: 'rgba(15, 23, 42, 0.7)',
                padding: '20px',
                borderRadius: 14,
                border: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <Space direction='vertical' size={16} style={{ width: '100%' }}>
                <div>
                  <Text style={{ color: '#e2e8f0', fontWeight: 600, display: 'block', marginBottom: 8 }}>
                    Optimize Single Symbol
                  </Text>
                  <Space.Compact style={{ width: '100%' }}>
                    <Input
                      placeholder='Enter symbol (e.g., BTC/USDT)'
                      value={optimizingSymbol}
                      onChange={(e) => setOptimizingSymbol(e.target.value)}
                      onPressEnter={handleOptimizeSymbol}
                      disabled={optimizing}
                      style={{ flex: 1 }}
                    />
                    <Button
                      type='primary'
                      icon={<ThunderboltOutlined />}
                      onClick={handleOptimizeSymbol}
                      loading={optimizing}
                      disabled={!optimizingSymbol.trim()}
                    >
                      Optimize
                    </Button>
                  </Space.Compact>
                </div>
                <Divider style={{ margin: 0, borderColor: token.colorBorderSecondary }} />
                <div>
                  <Text style={{ color: '#e2e8f0', fontWeight: 600, display: 'block', marginBottom: 8 }}>
                    Batch Optimization
                  </Text>
                  <Button
                    type='primary'
                    icon={<ThunderboltOutlined />}
                    onClick={handleOptimizeAll}
                    loading={optimizing}
                    block
                    style={{ background: '#8b5cf6', borderColor: '#8b5cf6' }}
                  >
                    Optimize All Symbols with Sufficient Data
                  </Button>
                  <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 12, display: 'block', marginTop: 8 }}>
                    This will analyze all symbols that have at least 20 trade evaluations per regime and update their personality profiles with regime-aware parameters.
                  </Text>
                </div>
              </Space>
            </div>
          </Card>
        </Col>
        <Col xs={24} xl={24}>
          <AgentHealthTable
            data={agentHealthForDisplay ?? agentHealth}
            loading={agentHealthLoading || refreshing}
            onRefresh={() => void refreshAll()}
            onReselect={handleSmartReselect}
            reselecting={reselecting}
          />
        </Col>
      </Row>
      )}

      {/* Agents Mode: Agent Health Table */}
      {(viewMode === 'agents' || viewMode === 'overview') && (
      <Row gutter={[24, 24]}>
        <Col xs={24} xl={24}>
          <AgentHealthTable
            data={agentHealthForDisplay ?? agentHealth}
            loading={agentHealthLoading || refreshing}
            onRefresh={() => void refreshAll()}
            onReselect={handleSmartReselect}
            reselecting={reselecting}
          />
        </Col>
      </Row>
      )}

      {/* Positions Mode: Recent Trades + Latest Alerts */}
      {(viewMode === 'positions' || viewMode === 'overview') && (
      <Row gutter={[24, 24]}>
        <Col xs={24} xl={14}>
          <RecentTradesTable
            trades={recentTrades}
            loading={recentTradesLoading || refreshing}
            onRefresh={() => void refreshAll()}
          />
        </Col>
        <Col xs={24} xl={10}>
          <Space direction='vertical' size={18} style={{ width: '100%' }}>
            <Card
              title={<span style={{ color: '#e2e8f0' }}>Latest alerts</span>}
              extra={<Button type='link' style={{ color: '#60a5fa', padding: 0 }} onClick={() => navigate('/backlog')}>Open feed</Button>}
              style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
              bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 16 }}
            >
              {latestEvents.length === 0 ? (
                <Empty description='No alerts captured.' style={{ margin: '32px 0', color: 'rgba(148, 163, 184, 0.78)' }} />
              ) : (
                latestEvents.map((evt: OpsEvent) => {
                  const meta = severityMeta[evt.level || 'info'] || severityMeta.info;
                  return (
                    <div
                      key={evt.id}
                      style={{
                        borderRadius: 14,
                        border: `1px solid ${token.colorBorderSecondary}`,
                        padding: 16,
                        background: 'rgba(15, 23, 42, 0.75)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <Space align='center' size={8}>
                        <Badge color={meta.color} />
                        <Text style={{ color: meta.color, fontWeight: 600 }}>{meta.label}</Text>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 12 }}>
                          {formatRelative(evt.ts)}
                        </Text>
                      </Space>
                      <Text style={{ color: '#e2e8f0', fontWeight: 600 }}>
                        {formatOpsEventMessage(evt.message)}
                      </Text>
                      {(() => {
                        const reasons = collectOpsEventReasons(evt.details);
                        if (!reasons.length) return null;
                        return (
                          <Space direction='vertical' size={4}>
                            {reasons.slice(0, 2).map((reason, idx) => (
                              <Text
                                key={`${evt.id}-reason-${idx}`}
                                style={{ color: 'rgba(148, 163, 184, 0.78)', fontSize: 12 }}
                              >
                                {reason}
                              </Text>
                            ))}
                          </Space>
                        );
                      })()}
                      <Space size={8} wrap style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>
                        {evt.symbol && <Tag color='geekblue'>{formatDisplaySymbol(evt.symbol)}</Tag>}
                        <span>{evt.source}</span>
                      </Space>
                    </div>
                  );
                })
              )}
            </Card>
            <Card
              title={<span style={{ color: '#e2e8f0' }}>Compliance & security guardrails</span>}
              extra={<Tag color='magenta'>{safeguardSnapshot.complianceSignals} signals</Tag>}
              style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
              bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 16 }}
            >
              <Row gutter={[16, 16]}>
                <Col xs={12}>
                  <Statistic
                    title={<span style={{ color: 'rgba(148, 163, 184, 0.72)' }}>Protective coverage</span>}
                    value={safeguardSnapshot.protectiveIssues}
                    suffix='issues'
                    valueStyle={{ color: safeguardSnapshot.protectiveIssues > 0 ? '#f87171' : '#34d399' }}
                  />
                </Col>
                <Col xs={12}>
                  <Statistic
                    title={<span style={{ color: 'rgba(148, 163, 184, 0.72)' }}>Halted sessions</span>}
                    value={safeguardSnapshot.haltedSessions}
                    suffix='active'
                    valueStyle={{ color: safeguardSnapshot.haltedSessions > 0 ? '#fbbf24' : '#60a5fa' }}
                  />
                </Col>
                <Col xs={12}>
                  <Statistic
                    title={<span style={{ color: 'rgba(148, 163, 184, 0.72)' }}>Managing</span>}
                    value={safeguardSnapshot.managingSessions}
                    suffix='sessions'
                    valueStyle={{ color: '#a855f7' }}
                  />
                </Col>
                <Col xs={12}>
                  <Statistic
                    title={<span style={{ color: 'rgba(148, 163, 184, 0.72)' }}>Compliance signals</span>}
                    value={safeguardSnapshot.complianceSignals}
                    suffix='recent'
                    valueStyle={{ color: safeguardSnapshot.complianceSignals > 0 ? '#f97316' : '#34d399' }}
                  />
                </Col>
              </Row>
              <Divider style={{ margin: '4px 0', borderColor: token.colorBorderSecondary }} />
              {complianceHighlights.length === 0 ? (
                <Empty
                  description='No compliance or security constraints triggered.'
                  style={{ margin: '16px 0', color: 'rgba(148, 163, 184, 0.78)' }}
                />
              ) : (
                complianceHighlights.map((evt) => {
                  const meta = severityMeta[evt.level || 'info'] || severityMeta.info;
                  const topReason = collectOpsEventReasons(evt.details)?.[0];
                  return (
                    <div
                      key={`compliance-${evt.id}`}
                      style={{
                        borderRadius: 12,
                        border: `1px solid ${token.colorBorderSecondary}`,
                        padding: 12,
                        background: 'rgba(15, 23, 42, 0.7)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      <Space align='center' size={8} wrap>
                        <Badge color={meta.color} />
                        <Text style={{ color: '#e2e8f0', fontWeight: 600 }}>
                          {formatOpsEventMessage(evt.message)}
                        </Text>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>
                          {formatRelative(evt.ts)}
                        </Text>
                      </Space>
                      {topReason && (
                        <Text style={{ color: 'rgba(148, 163, 184, 0.84)', fontSize: 12 }}>{topReason}</Text>
                      )}
                      <Space size={8} wrap style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>
                        {evt.symbol && <Tag color='geekblue'>{formatDisplaySymbol(evt.symbol)}</Tag>}
                        {evt.source && <Tag color='default'>{evt.source}</Tag>}
                      </Space>
                    </div>
                  );
                })
              )}
            </Card>
          </Space>
        </Col>
      </Row>
      )}

      {/* Overview Mode: Predictor Incoherence Feed + Compliance Signals */}
      {(viewMode === 'overview') && (
      <>
      <Row gutter={[24, 24]}>
        <Col xs={24} xl={14}>
          <Card
            title={<span style={{ color: '#e2e8f0' }}>Predictor incoherence feed</span>}
            extra={
              <Space size={8}>
                <Button
                  type='link'
                  icon={<ReloadOutlined />}
                  onClick={() => void loadIncoherenceData()}
                  loading={incoherenceLoading}
                  style={{ padding: 0 }}
                >
                  Refresh
                </Button>
                <Button
                  type='link'
                  onClick={() => void handleExportIncoherences()}
                  loading={incoherenceExporting}
                  style={{ padding: 0 }}
                >
                  Export JSON
                </Button>
              </Space>
            }
            style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
            bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 16 }}
          >
            <Spin spinning={incoherenceLoading} tip='Loading feed...'>
              {highlightedIncoherenceEvents.length === 0 ? (
                <Empty
                  description='No incoherence detected in the current window.'
                  style={{ margin: '32px 0', color: 'rgba(148, 163, 184, 0.78)' }}
                />
              ) : (
                highlightedIncoherenceEvents.map((evt) => {
                  const severityMeta = incoherenceSeverityMeta[evt.severity];
                  const categoryMeta = incoherenceCategoryMeta[evt.category];
                  return (
                    <div
                      key={evt.id}
                      style={{
                        borderRadius: 14,
                        border: `1px solid ${token.colorBorderSecondary}`,
                        padding: 16,
                        background: 'rgba(15, 23, 42, 0.75)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                      }}
                    >
                      <Space align='center' size={10} wrap>
                        <Tag
                          style={{
                            border: 'none',
                            background: severityMeta.bg,
                            color: severityMeta.color,
                            fontWeight: 600,
                          }}
                        >
                          {severityMeta.label}
                        </Tag>
                        <Tag
                          style={{ borderColor: categoryMeta.color, color: categoryMeta.color }}
                        >
                          {categoryMeta.label}
                        </Tag>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>
                          {formatRelative(evt.ts)}
                        </Text>
                        {evt.requiresAction && (
                          <Badge color='#f97316' text={<span style={{ color: '#f97316' }}>Action required</span>} />
                        )}
                      </Space>
                      <Text style={{ color: '#e2e8f0', fontWeight: 600 }}>{evt.message}</Text>
                      <Space size={8} wrap style={{ color: 'rgba(148, 163, 184, 0.78)', fontSize: 12 }}>
                        {evt.symbol && <Tag color='geekblue'>{formatDisplaySymbol(evt.symbol)}</Tag>}
                        {evt.sessionId && <Tag color='purple'>{evt.sessionId.slice(0, 6)}…</Tag>}
                        {evt.code && <Tag color='magenta'>{evt.code}</Tag>}
                        {evt.source && <span>Source: {evt.source}</span>}
                      </Space>
                      {Array.isArray(evt.tags) && evt.tags.length > 0 && (
                        <Space size={6} wrap>
                          {evt.tags.slice(0, 4).map((tag) => (
                            <Tag key={`${evt.id}-${tag}`} color='default' style={{ border: '1px solid rgba(148, 163, 184, 0.3)' }}>
                              {tag}
                            </Tag>
                          ))}
                        </Space>
                      )}
                    </div>
                  );
                })
              )}
            </Spin>
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card
            title={<span style={{ color: '#e2e8f0' }}>Incoherence snapshot</span>}
            style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
            bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 16 }}
          >
            <Spin spinning={incoherenceLoading}>
              {!incoherenceSummary ? (
                <Empty
                  description='Waiting for incoherence telemetry.'
                  style={{ margin: '32px 0', color: 'rgba(148, 163, 184, 0.78)' }}
                />
              ) : (
                <Space direction='vertical' size={16} style={{ width: '100%' }}>
                  <Space align='center' size={24}>
                    <Statistic
                      title={<span style={{ color: 'rgba(148, 163, 184, 0.72)' }}>{incoherenceWindowLabel}</span>}
                      value={incoherenceSummary.total}
                      suffix='events'
                      valueStyle={{ color: '#e2e8f0' }}
                    />
                    {incoherenceSummary.newest && (
                      <Space direction='vertical' size={0}>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>Newest</Text>
                        <Text style={{ color: '#e2e8f0' }}>{formatRelative(incoherenceSummary.newest.ts)}</Text>
                      </Space>
                    )}
                  </Space>
                  <Space size={8} wrap>
                    {incoherenceSeverityBreakdown.map(({ severity, count }) => {
                      const meta = incoherenceSeverityMeta[severity];
                      return (
                        <Tag
                          key={severity}
                          style={{ border: 'none', background: meta.bg, color: meta.color, fontWeight: 600 }}
                        >
                          {meta.label}: {count}
                        </Tag>
                      );
                    })}
                  </Space>
                  {topIncoherenceSessions.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <Text style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>Most impacted sessions</Text>
                      {topIncoherenceSessions.map((session) => (
                        <div
                          key={`${session.sessionId || 'global'}-${session.symbol || 'global'}`}
                          style={{
                            borderRadius: 12,
                            border: `1px solid ${token.colorBorderSecondary}`,
                            padding: '10px 12px',
                            background: 'rgba(15, 23, 42, 0.65)',
                          }}
                        >
                          <Space size={8} wrap>
                            {session.symbol && (
                              <Tag color='geekblue'>{formatDisplaySymbol(session.symbol)}</Tag>
                            )}
                            <Text style={{ color: '#e2e8f0', fontWeight: 600 }}>{session.count} events</Text>
                            <Text style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>
                              Last {formatRelative(session.lastEventTs)}
                            </Text>
                          </Space>
                          {session.sessionId && (
                            <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 12 }}>
                              Session: {session.sessionId}
                            </Text>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {topIncoherenceCodes.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <Text style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>Top triggers</Text>
                      <Space size={6} wrap>
                        {topIncoherenceCodes.map((code) => (
                          <Tag key={code.code} color='magenta'>
                            {code.code} · {code.count}
                          </Tag>
                        ))}
                      </Space>
                    </div>
                  )}
                </Space>
              )}
            </Spin>
          </Card>
        </Col>
      </Row>

      <Row gutter={[24, 24]}>
        <Col xs={24}>
          <Card
            title={<span style={{ color: '#e2e8f0' }}>Meta Explainability (last trades)</span>}
            bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 16 }}
            style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
            extra={
              <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 12 }}>
                PASS/FAIL checklist par trade
              </Text>
            }
          >
            {metaChecklistEvents.length === 0 ? (
              <Empty description='No recent Meta checklist entries.' style={{ margin: '32px 0', color: 'rgba(148, 163, 184, 0.78)' }} />
            ) : (
              metaChecklistEvents.map((evt) => {
                const details = (evt.details ?? {}) as MetaEntryChecklistDetails;
                const tableRows = Array.isArray(details.table) ? details.table : [];
                const failedChecks = Array.isArray(details.failedChecks) ? details.failedChecks : [];
                const statusPalette: Record<ChecklistStatus, { bg: string; fg: string; label: string }> = {
                  pass: { bg: 'rgba(34, 197, 94, 0.12)', fg: '#34d399', label: 'PASS' },
                  fail: { bg: 'rgba(248, 113, 113, 0.15)', fg: '#f87171', label: 'FAIL' },
                  warn: { bg: 'rgba(251, 191, 36, 0.15)', fg: '#fbbf24', label: 'WARN' },
                  'n/a': { bg: 'rgba(148, 163, 184, 0.12)', fg: '#94a3b8', label: 'N/A' },
                };
                const decisionTone = details.decision === 'blocked' ? '#f87171' : '#34d399';
                const decisionLabel = details.decision === 'blocked' ? 'Blocked' : 'Executed';
                const ts = details.timestamp ?? evt.ts;
                const symbolLabel = details.symbol || evt.symbol;
                return (
                  <div
                    key={evt.id}
                    style={{
                      borderRadius: 14,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      background: 'rgba(15, 23, 42, 0.75)',
                      padding: 16,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                    }}
                  >
                    <Space size={12} align='center' wrap>
                      <Tag color={decisionTone} style={{ color: '#0f172a', fontWeight: 600 }}>
                        {decisionLabel.toUpperCase()}
                      </Tag>
                      {symbolLabel && (
                        <Tag color='geekblue' style={{ fontWeight: 600 }}>
                          {formatDisplaySymbol(symbolLabel)}
                        </Tag>
                      )}
                      {details.strategy && (
                        <Tag color='volcano' style={{ fontWeight: 600 }}>
                          {formatOpsEventMessage(details.strategy)}
                        </Tag>
                      )}
                      <Text style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>
                        {formatRelative(ts)}
                      </Text>
                      {details.blockedReason && (
                        <Text style={{ color: '#f87171', fontSize: 12 }}>
                          {formatOpsEventMessage(details.blockedReason)}
                        </Text>
                      )}
                    </Space>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '180px 90px 1fr',
                        gap: 8,
                        rowGap: 10,
                      }}
                    >
                      {tableRows.map((row) => {
                        const palette = statusPalette[row.status] ?? statusPalette['n/a'];
                        return (
                          <React.Fragment key={`${evt.id}-${row.key}`}>
                            <Text style={{ color: '#e2e8f0', fontWeight: 600 }}>{row.label}</Text>
                            <div
                              style={{
                                background: palette.bg,
                                color: palette.fg,
                                padding: '2px 10px',
                                borderRadius: 999,
                                fontWeight: 600,
                                fontSize: 12,
                                textAlign: 'center',
                              }}
                            >
                              {palette.label}
                            </div>
                            <Space size={8} wrap style={{ color: 'rgba(148, 163, 184, 0.78)', fontSize: 12 }}>
                              <span>{row.detail || '—'}</span>
                              {typeof row.score === 'number' && Number.isFinite(row.score) && (
                                <Tag color='cyan'>{row.score.toFixed(3)}</Tag>
                              )}
                            </Space>
                          </React.Fragment>
                        );
                      })}
                    </div>
                    {failedChecks.length > 0 && (
                      <Space size={8} wrap>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>
                          Failed checks:
                        </Text>
                        {failedChecks.map((check) => (
                          <Tag key={`${evt.id}-fail-${check}`} color='red'>
                            {formatOpsEventMessage(check)}
                          </Tag>
                        ))}
                      </Space>
                    )}
                    {Array.isArray(details.entryReasons) && details.entryReasons.length > 0 && (
                      <Space direction='vertical' size={2} style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>
                        {details.entryReasons.slice(0, 3).map((reason, idx) => (
                          <Text key={`${evt.id}-reason-${idx}`}>{formatOpsEventMessage(reason)}</Text>
                        ))}
                      </Space>
                    )}
                  </div>
                );
              })
            )}
          </Card>
        </Col>
      </Row>
      </>
      )}
    </Space>
  );
};

export default OperationsDashboardPage;
