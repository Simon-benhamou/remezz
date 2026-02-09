import React from 'react';
import {
  Clock,
  Target,
  AlertTriangle,
  Thermometer,
  Activity,
  Zap,
  TrendingUp,
  TrendingDown,
  Loader2,
  DollarSign,
  Eye,
  RefreshCw,
  Flame,
  ScrollText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import { useMultiDataCache } from '../hooks/useMultiDataCache';
import { AppMode } from '../store';
import { wsManager } from '../ws';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentLog {
  timestamp: string;
  sessionId: string;
  symbol: string;
  kind: string;
  message: string;
  level: 'info' | 'warn' | 'error';
  details?: Record<string, any>;
}

interface RadarEvent {
  type: 'symbol_proximity' | 'market_regime' | 'market_volatility' | 'position_update' | 'opportunity_alert';
  severity: 'info' | 'warning' | 'success';
  title: string;
  message: string;
  symbol?: string;
  data?: Record<string, any>;
  timestamp: number;
}

/** Unified timeline item */
interface TimelineItem {
  id: string;
  ts: number;
  source: 'log' | 'radar';
  symbol?: string;
  log?: AgentLog;
  radar?: RadarEvent;
}

type FilterType = 'all' | 'entries' | 'exits' | 'signals' | 'errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const formatTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const cleanSymbol = (s?: string) =>
  s?.replace('/USDT:USDT', '').replace('/USDT', '') || '';

function getLogMeta(log: AgentLog) {
  const isWin = log.kind === 'exit' && (log.details?.pnl ?? 0) > 0;
  const isLoss = log.kind === 'exit' && (log.details?.pnl ?? 0) < 0;
  switch (log.kind) {
    case 'entry':
      return { icon: <Zap size={14} />, color: 'text-success', bg: 'bg-success/10', label: 'ENTRY' };
    case 'exit':
      return {
        icon: <DollarSign size={14} />,
        color: isWin ? 'text-success' : 'text-destructive',
        bg: isWin ? 'bg-success/10' : 'bg-destructive/10',
        label: isWin ? 'WIN' : isLoss ? 'LOSS' : 'EXIT',
      };
    case 'signal':
      return { icon: <Target size={14} />, color: 'text-warning', bg: 'bg-warning/10', label: 'SIGNAL' };
    case 'order':
      return { icon: <Loader2 size={14} />, color: 'text-violet-400', bg: 'bg-violet-500/10', label: 'ORDER' };
    case 'tick':
      return { icon: <Clock size={14} />, color: 'text-muted-foreground', bg: 'bg-muted/50', label: 'WATCH' };
    case 'error':
      return { icon: <AlertTriangle size={14} />, color: 'text-destructive', bg: 'bg-destructive/10', label: 'ERROR' };
    default:
      return { icon: <Eye size={14} />, color: 'text-muted-foreground', bg: 'bg-muted/50', label: log.kind.toUpperCase() };
  }
}

function getRadarMeta(event: RadarEvent) {
  switch (event.type) {
    case 'symbol_proximity': {
      const score = event.data?.newScore as number | undefined;
      if (score && score >= 70)
        return { icon: <Flame size={14} />, color: 'text-warning', bg: 'bg-orange-500/10', label: 'HOT' };
      if (score && score >= 50)
        return { icon: <Thermometer size={14} />, color: 'text-warning', bg: 'bg-warning/10', label: 'WARM' };
      return { icon: <Activity size={14} />, color: 'text-muted-foreground', bg: 'bg-muted/50', label: 'PROXIMITY' };
    }
    case 'market_regime': {
      const isBull = event.data?.newRegime === 'BULL';
      return {
        icon: isBull ? <TrendingUp size={14} /> : <TrendingDown size={14} />,
        color: isBull ? 'text-success' : 'text-destructive',
        bg: isBull ? 'bg-success/10' : 'bg-destructive/10',
        label: isBull ? 'BULL' : 'BEAR',
      };
    }
    case 'market_volatility': {
      const isHigh = event.data?.newVolatility === 'HIGH';
      return {
        icon: <Zap size={14} />,
        color: isHigh ? 'text-warning' : 'text-muted-foreground',
        bg: isHigh ? 'bg-orange-500/10' : 'bg-muted/50',
        label: 'VOLATILITY',
      };
    }
    case 'position_update':
      return {
        icon: <Zap size={14} />,
        color: event.severity === 'success' ? 'text-success' : 'text-warning',
        bg: event.severity === 'success' ? 'bg-success/10' : 'bg-warning/10',
        label: 'POSITION',
      };
    case 'opportunity_alert':
      return { icon: <Target size={14} />, color: 'text-violet-400', bg: 'bg-violet-500/10', label: 'OPPORTUNITY' };
    default:
      return { icon: <Activity size={14} />, color: 'text-muted-foreground', bg: 'bg-muted/50', label: 'EVENT' };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function FeedPage() {
  const [radarEvents, setRadarEvents] = React.useState<RadarEvent[]>([]);
  const [filterType, setFilterType] = React.useState<FilterType>('all');
  const { mode } = useMode();

  // Fetch agent logs via cache
  const { data, isInitialLoad, isRefreshing, refresh } = useMultiDataCache<{
    logs: AgentLog[];
  }>({
    cacheKey: 'feed',
    mode: mode as AppMode,
    sources: {
      logs: {
        key: 'logs',
        fetcher: async () => {
          const res = await api.getAgentLogs?.(mode as 'paper' | 'live', 100, 'all').catch(() => ({ logs: [] }));
          return Array.isArray(res) ? res : res?.logs || [];
        },
        ttlMs: 10000,
      },
    },
    autoRefreshMs: 15000,
  });

  const logs = data.logs || [];

  const handleRefresh = React.useCallback(() => {
    refresh(undefined, true);
  }, [refresh]);

  // WebSocket listener for radar events
  React.useEffect(() => {
    const API_BASE = (import.meta as any).env.VITE_API_BASE || 'http://localhost:4000';
    const apiKey = localStorage.getItem('apiKey') || '';
    if (!apiKey) return;

    // Ensure the shared connection is open
    wsManager.connect(API_BASE);

    // Subscribe only to radar_event messages
    const unsub = wsManager.subscribe('radar_event', (msg: any) => {
      if (msg?.data) {
        setRadarEvents((prev) => [msg.data as RadarEvent, ...prev].slice(0, 50));
      }
    });

    return () => {
      unsub();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Build unified timeline
  // ---------------------------------------------------------------------------

  const timeline = React.useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [];

    // Add logs (skip tick/watch kind — they're noise)
    for (const log of logs) {
      if (log.kind === 'tick') continue;
      items.push({
        id: `log-${log.timestamp}-${log.sessionId}`,
        ts: new Date(log.timestamp).getTime(),
        source: 'log',
        symbol: cleanSymbol(log.symbol),
        log,
      });
    }

    // Add radar events
    for (const event of radarEvents) {
      items.push({
        id: `radar-${event.timestamp}-${event.type}`,
        ts: event.timestamp,
        source: 'radar',
        symbol: cleanSymbol(event.symbol),
        radar: event,
      });
    }

    // Sort newest first
    items.sort((a, b) => b.ts - a.ts);
    return items;
  }, [logs, radarEvents]);

  // ---------------------------------------------------------------------------
  // Filter
  // ---------------------------------------------------------------------------

  const matchesFilter = React.useCallback(
    (item: TimelineItem): boolean => {
      if (filterType === 'all') return true;
      if (item.source === 'radar') {
        // Radar events map to signals
        if (filterType === 'signals') return true;
        return false;
      }
      const kind = item.log?.kind;
      switch (filterType) {
        case 'entries':
          return kind === 'entry';
        case 'exits':
          return kind === 'exit';
        case 'signals':
          return kind === 'signal';
        case 'errors':
          return kind === 'error';
        default:
          return true;
      }
    },
    [filterType],
  );

  const filteredTimeline = React.useMemo(
    () => timeline.filter(matchesFilter),
    [timeline, matchesFilter],
  );

  // Counts for filter badges
  const counts = React.useMemo(() => {
    const c = { all: timeline.length, entries: 0, exits: 0, signals: 0, errors: 0 };
    for (const item of timeline) {
      if (item.source === 'radar') {
        c.signals++;
      } else {
        const kind = item.log?.kind;
        if (kind === 'entry') c.entries++;
        else if (kind === 'exit') c.exits++;
        else if (kind === 'signal') c.signals++;
        else if (kind === 'error') c.errors++;
      }
    }
    return c;
  }, [timeline]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const filters: { key: FilterType; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'entries', label: 'Entries' },
    { key: 'exits', label: 'Exits' },
    { key: 'signals', label: 'Signals' },
    { key: 'errors', label: 'Errors' },
  ];

  return (
    <div className="mx-auto max-w-[1400px] px-4 pb-4 sm:px-6 sm:pb-6">
      {/* Header */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h3 className="m-0 flex items-center gap-2.5 text-xl font-semibold text-foreground">
            <ScrollText size={22} /> Activity Log
            <span
              className={cn(
                'inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold',
                mode === 'live'
                  ? 'bg-destructive/15 text-destructive'
                  : 'bg-blue-500/15 text-blue-400',
              )}
            >
              {mode?.toUpperCase()}
            </span>
          </h3>
          <span className="text-[13px] text-muted-foreground">
            Real-time agent activity and market events
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCw size={16} className={cn(isRefreshing && 'animate-spin')} />
          </Button>
          {isRefreshing && !isInitialLoad && (
            <span className="inline-flex items-center gap-1 rounded bg-blue-500/15 px-2 py-0.5 text-xs font-semibold text-blue-400">
              <Loader2 size={12} className="animate-spin" />
            </span>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {filters.map((f) => {
          const count = counts[f.key];
          return (
            <button
              key={f.key}
              onClick={() => setFilterType(f.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer',
                filterType === f.key
                  ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
                  : 'bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-muted',
              )}
            >
              {f.label}
              {count > 0 && (
                <span
                  className={cn(
                    'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold',
                    filterType === f.key
                      ? 'bg-primary/20 text-primary'
                      : 'bg-muted-foreground/15 text-muted-foreground',
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}

        {/* Live indicator */}
        <div className="ml-auto flex items-center gap-1.5">
          <div className="h-1.5 w-1.5 rounded-full bg-success animate-[pulse_2s_infinite]" />
          <span className="text-[11px] text-muted-foreground">Live</span>
        </div>
      </div>

      {/* Unified Timeline */}
      <div className="rounded-xl border border-border bg-card">
        {isInitialLoad ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : filteredTimeline.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <ScrollText className="mb-3 h-10 w-10 text-muted-foreground/30" />
            <span className="text-sm text-muted-foreground">
              {timeline.length === 0
                ? 'No activity yet. Start an agent to see events here.'
                : 'No events match this filter.'}
            </span>
          </div>
        ) : (
          <div className="max-h-[680px] overflow-y-auto divide-y divide-border">
            {filteredTimeline.map((item) => (
              <TimelineRow key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline Row
// ---------------------------------------------------------------------------

function TimelineRow({ item }: { item: TimelineItem }) {
  if (item.source === 'radar' && item.radar) {
    return <RadarRow event={item.radar} ts={item.ts} />;
  }
  if (item.source === 'log' && item.log) {
    return <LogRow log={item.log} ts={item.ts} />;
  }
  return null;
}

function RadarRow({ event, ts }: { event: RadarEvent; ts: number }) {
  const meta = getRadarMeta(event);
  const symbol = cleanSymbol(event.symbol);

  return (
    <div className="flex items-start gap-3 px-4 py-3 sm:px-5 transition-colors hover:bg-muted/30">
      <span className="min-w-[60px] shrink-0 font-mono text-[11px] text-muted-foreground pt-0.5">
        {formatTime(ts)}
      </span>

      {symbol && (
        <span className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-foreground">
          {symbol}
        </span>
      )}

      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold',
          meta.bg,
          meta.color,
        )}
      >
        {meta.icon}
        {meta.label}
      </span>

      <div className="min-w-0 flex-1">
        <span className="text-xs text-foreground">{event.title.replace(/\[.*?\]\s*/, '')}</span>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{event.message}</div>
      </div>
    </div>
  );
}

function LogRow({ log, ts }: { log: AgentLog; ts: number }) {
  const meta = getLogMeta(log);
  const isLoss = meta.label === 'LOSS';

  return (
    <div className="flex items-start gap-3 px-4 py-3 sm:px-5 transition-colors hover:bg-muted/30">
      <span className="min-w-[60px] shrink-0 font-mono text-[11px] text-muted-foreground pt-0.5">
        {formatTime(ts)}
      </span>

      <span className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-foreground">
        {cleanSymbol(log.symbol)}
      </span>

      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold',
          meta.bg,
          meta.color,
        )}
      >
        {meta.icon}
        {meta.label}
      </span>

      <div className="min-w-0 flex-1">
        <span
          className={cn(
            'text-xs',
            isLoss ? 'text-destructive' : 'text-foreground',
            (log.kind === 'entry' || log.kind === 'exit') && 'font-medium',
          )}
        >
          {log.message}
        </span>

        {(log.kind === 'entry' || log.kind === 'exit') && log.details && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            {log.details.price != null && (
              <span className="text-[11px] text-muted-foreground">
                Price: ${log.details.price}
              </span>
            )}
            {log.details.pnl != null && (
              <span
                className={cn(
                  'text-[11px] font-semibold',
                  log.details.pnl >= 0 ? 'text-success' : 'text-destructive',
                )}
              >
                PnL: {log.details.pnl >= 0 ? '+' : ''}${log.details.pnl.toFixed(2)}
              </span>
            )}
            {log.details.leverage != null && (
              <span className="text-[11px] text-muted-foreground">
                {log.details.leverage}x
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
