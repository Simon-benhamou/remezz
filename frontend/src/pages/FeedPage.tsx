import React from 'react';
import { Clock, Target, AlertTriangle, Thermometer, Activity, Zap, TrendingUp, TrendingDown, Loader2, DollarSign, Eye, RefreshCw, Flame } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import { useMultiDataCache } from '../hooks/useMultiDataCache';
import { AppMode } from '../store';
import { openWS } from '../ws';

interface AgentLog {
  timestamp: string;
  sessionId: string;
  symbol: string;
  kind: string;
  message: string;
  level: 'info' | 'warn' | 'error';
  details?: Record<string, any>;
}

// V5.71: Signal Radar events from WebSocket
interface RadarEvent {
  type: 'symbol_proximity' | 'market_regime' | 'market_volatility' | 'position_update' | 'opportunity_alert';
  severity: 'info' | 'warning' | 'success';
  title: string;
  message: string;
  symbol?: string;
  data?: Record<string, any>;
  timestamp: number;
}

interface AgentState {
  sessionId: string;
  symbol: string;
  running: boolean;
  hasPosition: boolean;
  bias: 'long' | 'short' | null;
}

type FilterType = 'all' | 'futures' | 'exits' | 'orders' | 'triggers';
type BiasFilter = 'all' | 'long' | 'short' | 'watch';

export default function FeedPage() {
  const [radarEvents, setRadarEvents] = React.useState<RadarEvent[]>([]);
  const [filterType, setFilterType] = React.useState<FilterType>('all');
  const [biasFilter, setBiasFilter] = React.useState<BiasFilter>('all');
  const { mode } = useMode();
  const wsRef = React.useRef<ReturnType<typeof openWS> | null>(null);

  // Use multi-data cache for feed data
  const {
    data,
    isInitialLoad,
    isRefreshing,
    refresh,
  } = useMultiDataCache<{
    logs: AgentLog[];
    agentStates: AgentState[];
  }>({
    cacheKey: 'feed',
    mode: mode as AppMode,
    sources: {
      logs: {
        key: 'logs',
        fetcher: async () => {
          const res = await api.getAgentLogs?.(mode as 'paper' | 'live', 100, 'memory').catch(() => ({ logs: [] }));
          return Array.isArray(res) ? res : res?.logs || [];
        },
        ttlMs: 10000, // 10s TTL for logs
      },
      agentStates: {
        key: 'agentStates',
        fetcher: async () => {
          const sessionsRes = await api.listSessions(mode).catch(() => []);
          return (sessionsRes || [])
            .filter((s: any) => !s.stoppedAt && !s.haltedAt)
            .map((s: any) => ({
              sessionId: s.id,
              symbol: s.symbol?.replace('/USDT:USDT', '/USDT-USDT') || 'Unknown',
              running: true,
              hasPosition: false,
              bias: null,
            }));
        },
        ttlMs: 30000, // 30s TTL for sessions
      },
    },
    autoRefreshMs: 15000, // Reduced from 5s to 15s
  });

  const logs = data.logs || [];
  const agentStates = data.agentStates || [];

  const handleRefresh = React.useCallback(() => {
    refresh(undefined, true);
  }, [refresh]);

  // V5.71: WebSocket listener for radar events
  React.useEffect(() => {
    const API_BASE = (import.meta as any).env.VITE_API_BASE || 'http://localhost:4000';
    const apiKey = localStorage.getItem('apiKey') || '';

    if (!apiKey) return;

    wsRef.current = openWS(
      API_BASE,
      apiKey,
      undefined,
      (msg: any) => {
        if (msg?.type === 'radar_event' && msg?.data) {
          const event = msg.data as RadarEvent;
          setRadarEvents(prev => [event, ...prev].slice(0, 50)); // Keep last 50 events
        }
      },
      undefined,
      undefined,
      undefined
    );

    return () => {
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
    };
  }, []);

  // Filter logs
  const filteredLogs = React.useMemo(() => {
    let filtered = logs;
    if (filterType === 'futures') filtered = filtered.filter(l => ['entry', 'exit', 'signal'].includes(l.kind));
    if (filterType === 'exits') filtered = filtered.filter(l => l.kind === 'exit');
    if (filterType === 'orders') filtered = filtered.filter(l => l.kind === 'order');
    if (filterType === 'triggers') filtered = filtered.filter(l => ['support-touch', 'resistance-touch', 'volume-spike'].includes(l.kind));
    if (biasFilter === 'long') filtered = filtered.filter(l => l.message?.toLowerCase().includes('long'));
    if (biasFilter === 'short') filtered = filtered.filter(l => l.message?.toLowerCase().includes('short'));
    if (biasFilter === 'watch') filtered = filtered.filter(l => l.kind === 'tick' || l.message?.toLowerCase().includes('watch'));
    return filtered;
  }, [logs, filterType, biasFilter]);

  const formatTime = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const getLogMeta = (log: AgentLog) => {
    const isLoss = log.kind === 'exit' && (log.details?.pnl ?? 0) < 0;
    const isWin = log.kind === 'exit' && (log.details?.pnl ?? 0) > 0;
    switch (log.kind) {
      case 'entry': return { icon: <Zap size={14} />, color: 'text-success', colorVar: 'var(--success)', bg: 'bg-success/10', label: 'ENTRY' };
      case 'exit': return { icon: <DollarSign size={14} />, color: isWin ? 'text-success' : 'text-destructive', colorVar: isWin ? 'var(--success)' : 'var(--error)', bg: isWin ? 'bg-success/10' : 'bg-destructive/10', label: isWin ? 'WIN' : 'LOSS' };
      case 'signal': return { icon: <Target size={14} />, color: 'text-warning', colorVar: 'var(--warning)', bg: 'bg-warning/10', label: 'SIGNAL' };
      case 'order': return { icon: <Loader2 size={14} />, color: 'text-violet-400', colorVar: '#a78bfa', bg: 'bg-violet-500/10', label: 'ORDER' };
      case 'tick': return { icon: <Clock size={14} />, color: 'text-muted-foreground', colorVar: 'var(--text-secondary)', bg: 'bg-muted/50', label: 'WATCH' };
      case 'error': return { icon: <AlertTriangle size={14} />, color: 'text-destructive', colorVar: 'var(--error)', bg: 'bg-destructive/10', label: 'ERROR' };
      default: return { icon: <Eye size={14} />, color: 'text-muted-foreground', colorVar: 'var(--text-secondary)', bg: 'bg-muted/50', label: log.kind.toUpperCase() };
    }
  };

  // V5.71: Get radar event display info
  const getRadarMeta = (event: RadarEvent) => {
    switch (event.type) {
      case 'symbol_proximity':
        const score = event.data?.newScore as number | undefined;
        if (score && score >= 70) return { icon: <Flame size={14} />, color: 'text-warning', colorVar: 'var(--warning)', bg: 'bg-orange-500/10', label: 'HOT' };
        if (score && score >= 50) return { icon: <Thermometer size={14} />, color: 'text-warning', colorVar: 'var(--warning)', bg: 'bg-warning/10', label: 'WARM' };
        return { icon: <Activity size={14} />, color: 'text-muted-foreground', colorVar: 'var(--text-secondary)', bg: 'bg-muted/50', label: 'PROXIMITY' };
      case 'market_regime':
        const isBull = event.data?.newRegime === 'BULL';
        return { icon: isBull ? <TrendingUp size={14} /> : <TrendingDown size={14} />, color: isBull ? 'text-success' : 'text-destructive', colorVar: isBull ? 'var(--success)' : 'var(--error)', bg: isBull ? 'bg-success/10' : 'bg-destructive/10', label: isBull ? 'BULL' : 'BEAR' };
      case 'market_volatility':
        const isHigh = event.data?.newVolatility === 'HIGH';
        return { icon: <Zap size={14} />, color: isHigh ? 'text-warning' : 'text-muted-foreground', colorVar: isHigh ? 'var(--warning)' : 'var(--text-secondary)', bg: isHigh ? 'bg-orange-500/10' : 'bg-muted/50', label: 'VOLATILITY' };
      case 'position_update':
        return { icon: <Zap size={14} />, color: event.severity === 'success' ? 'text-success' : 'text-warning', colorVar: event.severity === 'success' ? 'var(--success)' : 'var(--warning)', bg: event.severity === 'success' ? 'bg-success/10' : 'bg-warning/10', label: 'POSITION' };
      case 'opportunity_alert':
        return { icon: <Target size={14} />, color: 'text-violet-400', colorVar: '#a78bfa', bg: 'bg-violet-500/10', label: 'OPPORTUNITY' };
    }
  };

  const formatRadarTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Parse tick message to extract status
  const parseTickStatus = (message: string): { status: string; price?: string; bias?: string; sinceCandle?: string } | null => {
    // Match: WATCH AVAX/USDT $14.02 +0.4% LONG Dec~1h
    const match = message.match(/WATCH\s+(\S+)\s+\$?([\d.]+)\s+([+-]?[\d.]+%)\s+(LONG|SHORT)\s+\u{1F56F}\s*(.+)/iu);
    if (match) {
      return { status: 'watching', price: match[2], bias: match[4], sinceCandle: match[5] };
    }
    // Match position: [SOL] #1 IN_LONG@$127.00
    const posMatch = message.match(/IN_(LONG|SHORT)@\$?([\d.]+)/i);
    if (posMatch) {
      return { status: 'in_position', price: posMatch[2], bias: posMatch[1] };
    }
    return null;
  };

  return (
    <div className="mx-auto max-w-[1400px] px-6 pb-6">
      {/* Header */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h3 className="m-0 flex items-center gap-2.5 text-xl font-semibold text-foreground">
            <Zap size={24} /> Agent Feed
            <span className={cn(
              "inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold",
              mode === 'live' ? "bg-destructive/15 text-destructive" : "bg-blue-500/15 text-blue-400"
            )}>
              {mode?.toUpperCase()}
            </span>
          </h3>
          <span className="text-[13px] text-muted-foreground">
            {agentStates.length} active session(s) -- Real-time agent activity ({mode})
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCw size={16} className={cn(isRefreshing && "animate-spin")} />
          </Button>
          {isRefreshing && !isInitialLoad && (
            <span className="inline-flex items-center gap-1 rounded bg-blue-500/15 px-2 py-0.5 text-xs font-semibold text-blue-400">
              <Loader2 size={12} className="animate-spin" />
              Updating...
            </span>
          )}
        </div>
      </div>

      {/* Active Agents Bar */}
      {agentStates.length > 0 && (
        <div className="mb-5 rounded-xl border border-border bg-[var(--bg-primary)] p-4">
          <div className="mb-3 flex items-center gap-2">
            <Zap size={14} className="text-warning" />
            <span className="text-[13px] font-semibold text-foreground">Active Agents</span>
          </div>
          <div className="flex flex-wrap gap-2.5">
            {agentStates.map((agent) => (
              <div
                key={agent.sessionId}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2",
                  agent.hasPosition
                    ? "border-success/20 bg-success/[0.08]"
                    : "border-blue-500/20 bg-blue-500/[0.08]"
                )}
              >
                <div className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  agent.hasPosition ? "bg-success" : "bg-accent"
                )} />
                <span className="text-[13px] font-medium text-foreground">{agent.symbol}</span>
                <span className={cn(
                  "text-[11px]",
                  agent.hasPosition ? "text-success" : "text-accent"
                )}>
                  {agent.hasPosition ? `Trading ${agent.bias?.toUpperCase()}` : 'Watching'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="mb-5 rounded-xl border border-border bg-[var(--bg-primary)] p-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Filter by:</span>
            {(['all', 'futures', 'exits', 'orders', 'triggers'] as FilterType[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilterType(f)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                  filterType === f
                    ? "bg-accent/20 text-accent border border-accent/40"
                    : "bg-muted/50 text-muted-foreground hover:text-foreground"
                )}
              >
                {f === 'all' ? 'All' : f}
              </button>
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            {(['all', 'long', 'short', 'watch'] as BiasFilter[]).map((b) => (
              <button
                key={b}
                onClick={() => setBiasFilter(b)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors border",
                  biasFilter === b
                    ? b === 'long' ? "bg-success/15 text-success border-success/40"
                    : b === 'short' ? "bg-destructive/15 text-destructive border-destructive/40"
                    : "bg-accent/20 text-accent border-accent/40"
                    : "bg-muted/50 text-muted-foreground hover:text-foreground border-transparent"
                )}
              >
                {b === 'all' ? 'All Types' : b}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* V5.71: Signal Radar - Real-time market intelligence */}
      <div className="mb-5 rounded-xl border border-border bg-[var(--bg-primary)]">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Activity size={14} className="text-warning" />
            <span className="font-semibold text-foreground">Signal Radar</span>
            <span className="inline-flex items-center rounded bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
              LIVE
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-1.5 rounded-full bg-warning animate-[pulse_2s_infinite]" />
            <span className="text-[11px] text-muted-foreground">WebSocket</span>
          </div>
        </div>

        {radarEvents.length === 0 ? (
          <div className="p-6 text-center">
            <span className="text-[13px] text-muted-foreground">
              Waiting for market events... Signal changes will appear here in real-time.
            </span>
          </div>
        ) : (
          <div className="max-h-[300px] overflow-y-auto">
            {radarEvents.map((event, idx) => {
              const meta = getRadarMeta(event);
              const symbol = event.symbol?.replace('/USDT:USDT', '').replace('/USDT', '');

              return (
                <div
                  key={`${event.timestamp}-${idx}`}
                  className="flex items-start gap-3 px-5 py-2.5 transition-colors border-b border-slate-400/[0.04] hover:bg-slate-400/[0.03]"
                >
                  {/* Time */}
                  <span className="min-w-[65px] font-mono text-[11px] text-muted-foreground">
                    {formatRadarTime(event.timestamp)}
                  </span>

                  {/* Symbol Tag (if present) */}
                  {symbol && (
                    <span className="inline-flex items-center rounded bg-slate-400/10 px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
                      {symbol}
                    </span>
                  )}

                  {/* Status Tag */}
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold",
                      meta?.bg,
                      meta?.color
                    )}
                  >
                    {meta?.icon}
                    {meta?.label}
                  </span>

                  {/* Content */}
                  <div className="flex-1">
                    <span className="text-xs text-foreground">{event.title.replace(/\[.*?\]\s*/, '')}</span>
                    <div className="mt-0.5">
                      <span className="text-[11px] text-muted-foreground">{event.message}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Activity Feed */}
      <div className="rounded-xl border border-border bg-[var(--bg-primary)]">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-muted-foreground" />
            <span className="font-semibold text-foreground">Activity Feed</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-1.5 rounded-full bg-success animate-[pulse_2s_infinite]" />
            <span className="text-[11px] text-muted-foreground">Live updates</span>
          </div>
        </div>

        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <span className="text-muted-foreground">
              {agentStates.length === 0 ? 'No active agents. Start an agent to see the feed.' : 'No activity yet. Waiting for market events...'}
            </span>
          </div>
        ) : (
          <div className="max-h-[600px] overflow-y-auto">
            {filteredLogs.map((log, idx) => {
              const meta = getLogMeta(log);
              const tickStatus = log.kind === 'tick' ? parseTickStatus(log.message) : null;
              const isLoss = meta.label === 'LOSS';

              return (
                <div
                  key={`${log.timestamp}-${idx}`}
                  className="flex items-start gap-3 px-5 py-3 transition-colors border-b border-slate-400/[0.04] hover:bg-slate-400/[0.03]"
                >
                  {/* Time */}
                  <span className="min-w-[70px] font-mono text-xs text-muted-foreground">
                    {formatTime(log.timestamp)}
                  </span>

                  {/* Symbol Tag */}
                  <span className="inline-flex items-center rounded bg-slate-400/10 px-1.5 py-0.5 text-[11px] font-semibold text-foreground">
                    {log.symbol?.replace('/USDT:USDT', '').replace('/USDT', '')}
                  </span>

                  {/* Status Tag */}
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold",
                      meta.bg,
                      meta.color
                    )}
                  >
                    {meta.icon}
                    {meta.label}
                  </span>

                  {/* Content */}
                  <div className="flex-1">
                    {log.kind === 'tick' && tickStatus ? (
                      <div className="flex items-center gap-2.5">
                        <span className="font-medium text-foreground">{log.symbol?.replace('/USDT:USDT', '/USDT')}</span>
                        <span className="font-semibold text-success">${tickStatus.price}</span>
                        {tickStatus.bias && (
                          <span className={cn(
                            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold",
                            tickStatus.bias === 'LONG' ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"
                          )}>
                            {tickStatus.bias === 'LONG' ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                            {tickStatus.bias}
                          </span>
                        )}
                        {tickStatus.sinceCandle && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex items-center rounded bg-slate-400/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                  &#x1F56F; {tickStatus.sinceCandle}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>Time since last valid candle</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </div>
                    ) : log.kind === 'signal' ? (
                      <div className="flex items-center gap-2">
                        <span className="text-foreground">{log.message}</span>
                      </div>
                    ) : (
                      <span className={cn(
                        isLoss ? "text-destructive" : "text-foreground",
                        (log.kind === 'entry' || log.kind === 'exit') ? "font-medium" : "font-normal"
                      )}>
                        {log.message}
                      </span>
                    )}

                    {/* Entry/Exit Details */}
                    {(log.kind === 'entry' || log.kind === 'exit') && log.details && (
                      <div className="mt-1.5 flex gap-3">
                        {log.details.price && <span className="text-[11px] text-muted-foreground">Price: ${log.details.price}</span>}
                        {log.details.pnl != null && (
                          <span className={cn(
                            "text-[11px] font-semibold",
                            log.details.pnl >= 0 ? "text-success" : "text-destructive"
                          )}>
                            PnL: {log.details.pnl >= 0 ? '+' : ''}${log.details.pnl.toFixed(2)}
                          </span>
                        )}
                        {log.details.leverage && <span className="text-[11px] text-muted-foreground">Leverage: {log.details.leverage}x</span>}
                      </div>
                    )}
                  </div>

                  {/* Right side status */}
                  <div className="ml-auto">
                    {log.kind === 'tick' && (
                      <span className="inline-flex items-center rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                        WAITING FOR NEW CANDLE
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
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
