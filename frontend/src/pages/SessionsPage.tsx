import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LayoutGrid,
  List,
  Trash2,
  Eye,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  Loader2,
  Bot,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import { useDataCache } from '../hooks/useDataCache';
import AgentCreationModal from '../components/AgentCreationModal';
import type { AppMode } from '../store';
import type { StrategySnapshot } from '../types/strategies';
import { type StrategyEngineOption } from '../utils/strategies';

type ViewMode = 'cards' | 'table';

type AgentSession = {
  id: string;
  name?: string;
  symbol?: string;
  mode: AppMode;
  startBalanceUsd?: number;
  pnlUsd?: number;
  roiPct?: number;
  netRoiPct?: number;
  winRate?: number;
  totalTrades?: number;
  haltedAt?: string | null;
  stoppedAt?: string | null;
  startedAt?: string | null;
  profile?: Record<string, any> | null;
  runtimeBalance?: { allocatedUsd?: number } | null;
  strategyFamily?: string | null;
  isSmartAgent?: boolean;
  strategyEngine?: StrategyEngineOption | null;
  strategy?: StrategySnapshot | string | null;
  openPositions?: number;
};

const isSessionActive = (session: AgentSession) => !session.haltedAt && !session.stoppedAt;

const formatUsd = (value?: number | null) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '\u2014';
  const amount = Number(value);
  const prefix = amount >= 0 ? '$' : '-$';
  return `${prefix}${Math.abs(amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
};

const formatPercent = (value?: number | null) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '\u2014';
  const percent = Number(value);
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
};

const resolveAgentLabel = (session: AgentSession) => {
  if (session.name) return session.name;
  if (session.symbol) return `${session.symbol.replace('/USDT:USDT', '').replace('/USDT', '')}/USDT-USDT Agent`;
  return 'Trading Agent';
};

async function enrichSession(session: AgentSession): Promise<AgentSession> {
  if (!session.id) return session;
  try {
    const perf = await api.getPerf(session.id).catch(() => null);
    const realized = Number(perf?.realizedPnlUsd ?? 0);
    const unrealized = Number(perf?.unrealizedPnlUsd ?? 0);
    const startBalance = Number(session.startBalanceUsd ?? 0);
    const roiPct = Number(perf?.roiPct ?? (startBalance > 0 ? (realized / startBalance) * 100 : 0));
    return {
      ...session,
      pnlUsd: realized + unrealized,
      roiPct,
      winRate: perf?.winRate ?? session.winRate,
      totalTrades: perf?.totalTrades ?? session.totalTrades ?? 0,
    };
  } catch {
    return session;
  }
}

export default function SessionsPage() {
  const navigate = useNavigate();
  const { mode: currentMode } = useMode();
  const isMobile = React.useMemo(() => typeof window !== 'undefined' && window.innerWidth < 768, []);
  const [viewMode, setViewMode] = React.useState<ViewMode>(isMobile ? 'cards' : 'table');
  const [createModalOpen, setCreateModalOpen] = React.useState(false);

  const [confirmState, setConfirmState] = React.useState<{
    open: boolean;
    title: string;
    description: string;
    variant: 'default' | 'destructive';
    onConfirm: () => Promise<void>;
  }>({ open: false, title: '', description: '', variant: 'default', onConfirm: async () => {} });

  // Fetch sessions WITH enrichment included (avoids N+1 after cache)
  const fetchEnrichedSessions = React.useCallback(async (): Promise<AgentSession[]> => {
    const sessions = await api.listSessions(currentMode, true);
    const sessionsList = Array.isArray(sessions) ? sessions : [];

    // Enrich all sessions in PARALLEL
    const enriched = await Promise.all(sessionsList.map(enrichSession));
    return enriched;
  }, [currentMode]);

  // Use caching hook - enrichment is now part of the cached data
  const {
    data: enrichedSessions,
    isInitialLoad,
    isRefreshing,
    refresh,
    invalidate,
  } = useDataCache<AgentSession[]>({
    cacheKey: 'sessions-enriched',
    fetcher: fetchEnrichedSessions,
    mode: currentMode as AppMode,
    ttlMs: 15000, // 15s TTL
    autoRefreshMs: 30000, // Auto-refresh every 30s
  });

  const handleRefresh = React.useCallback(() => {
    refresh(true);
  }, [refresh]);

  const invalidateCache = React.useCallback(() => {
    invalidate();
  }, [invalidate]);

  const sessionsList = enrichedSessions || [];
  const activeSessions = sessionsList.filter(isSessionActive);
  const pausedSessions = sessionsList.filter((s) => s.haltedAt && !s.stoppedAt);
  const stoppedSessions = sessionsList.filter((s) => s.stoppedAt);

  const handleAction = React.useCallback(
    async (action: 'stop' | 'start' | 'delete', session: AgentSession) => {
      const label = resolveAgentLabel(session);
      const config = {
        stop: { title: 'Stop Agent', description: `Stop ${label}?`, variant: 'destructive' as const },
        start: { title: 'Restart Agent', description: `Restart ${label}?`, variant: 'default' as const },
        delete: { title: 'Delete Agent', description: `Permanently delete ${label}?`, variant: 'destructive' as const },
      }[action];

      setConfirmState({
        open: true,
        title: config.title,
        description: config.description,
        variant: config.variant,
        onConfirm: async () => {
          try {
            if (action === 'stop') await api.stopSession(session.id);
            else if (action === 'delete') await api.deleteSession(session.id);
            else await api.restartSession(session.id, { mode: session.mode, maxLeverage: 4, strategyEngine: 'meta_adaptive' });
            toast.success(`Agent ${action === 'delete' ? 'deleted' : action === 'stop' ? 'stopped' : 'restarted'}`);
            invalidateCache();
            await refresh(true);
          } catch (e: any) {
            toast.error(e?.response?.data?.message || `Failed to ${action} agent`);
          }
          setConfirmState((prev) => ({ ...prev, open: false }));
        },
      });
    },
    [invalidateCache, refresh]
  );

  if (isInitialLoad) {
    return (
      <div className="p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
          <div className="mt-6 space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="px-6 pb-6 max-w-[1400px] mx-auto">
        {/* Header */}
        <div className="mb-6">
          <div className="flex justify-between items-center mb-3">
            <div>
              <h3 className="text-xl font-semibold text-foreground flex items-center gap-3 m-0">
                AI Trading Agents
                <span
                  className={cn(
                    'inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium',
                    currentMode === 'live'
                      ? 'bg-destructive/12 text-destructive'
                      : 'bg-blue-500/12 text-blue-500'
                  )}
                >
                  {currentMode?.toUpperCase()}
                </span>
              </h3>
              <span className="text-muted-foreground text-[13px]">
                Autonomous multi-agent system with intelligent portfolio diversification
              </span>
            </div>
            <div className="flex items-center gap-3">
              <ToggleGroup
                type="single"
                value={viewMode}
                onValueChange={(v) => v && setViewMode(v as ViewMode)}
                className="bg-muted rounded-md"
              >
                <ToggleGroupItem value="cards" aria-label="Card view" size="sm">
                  <LayoutGrid className="h-4 w-4" />
                </ToggleGroupItem>
                <ToggleGroupItem value="table" aria-label="Table view" size="sm">
                  <List className="h-4 w-4" />
                </ToggleGroupItem>
              </ToggleGroup>
              <Button variant="outline" size="icon" onClick={handleRefresh} disabled={isRefreshing}>
                <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
              </Button>
              {isRefreshing && !isInitialLoad && (
                <span className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs bg-blue-500/12 text-blue-500">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Updating...
                </span>
              )}
              <Button onClick={() => setCreateModalOpen(true)}>
                <Plus className="h-4 w-4" />
                Create Agent
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-success" />
              <span className="text-muted-foreground text-[13px]">{activeSessions.length} Active</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-warning" />
              <span className="text-muted-foreground text-[13px]">{pausedSessions.length} Paused</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-muted-foreground" />
              <span className="text-muted-foreground text-[13px]">{stoppedSessions.length} Stopped</span>
            </div>
          </div>
        </div>

        {/* Table View */}
        {viewMode === 'table' && (
          <div className="overflow-auto rounded-2xl border border-border bg-card">
            <div className="min-w-[900px]">
              {/* Header Row */}
              <div className="grid grid-cols-[2fr_85px_80px_100px_100px_80px_80px_60px_120px] px-4 py-3 border-b border-border bg-card">
                {['Agent', 'Selection', 'Status', 'Capital', 'PnL', 'ROI', 'Win Rate', 'Trades', 'Actions'].map((h, i) => (
                  <span key={h} className={cn("text-[11px] uppercase tracking-wide text-muted-foreground whitespace-nowrap", i >= 4 && i <= 7 && "text-right", i === 8 && "text-right")}>{h}</span>
                ))}
              </div>

              {sessionsList.length === 0 ? (
                <div className="py-12 flex flex-col items-center justify-center gap-3">
                  <Bot className="h-10 w-10 text-muted-foreground" />
                  <span className="text-muted-foreground text-sm">No agents yet</span>
                  <Button onClick={() => setCreateModalOpen(true)}>Create Your First Agent</Button>
                </div>
              ) : (
                sessionsList.map((session) => {
                  const pnl = Number(session.pnlUsd ?? 0);
                  const roi = Number(session.roiPct ?? 0);
                  const winRate = Number(session.winRate ?? 0);
                  const isActive = isSessionActive(session);
                  const hasPosition = (session.openPositions ?? 0) > 0;

                  return (
                    <div
                      key={session.id}
                      onClick={() => navigate(`/agents/${session.id}`)}
                      className="grid grid-cols-[2fr_85px_80px_100px_100px_80px_80px_60px_120px] px-4 py-2.5 border-b border-border items-center transition-colors duration-150 cursor-pointer hover:bg-muted/30"
                    >
                      {/* Agent */}
                      <div className="flex items-center gap-2">
                        <span className="text-foreground font-semibold text-[13px]">{resolveAgentLabel(session)}</span>
                        <span
                          className={cn(
                            'inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold w-fit',
                            session.mode === 'live'
                              ? 'bg-destructive/15 text-destructive'
                              : 'bg-accent/15 text-accent'
                          )}
                        >
                          {session.mode?.toUpperCase()}
                        </span>
                      </div>

                      {/* Selection */}
                      <span className="text-muted-foreground text-[11px]">{session.isSmartAgent ? 'Smart Auto' : 'Manual'}</span>

                      {/* Status */}
                      <span
                        className={cn(
                          'inline-flex items-center w-fit rounded px-1.5 py-0.5 text-[9px] font-semibold',
                          isActive
                            ? hasPosition
                              ? 'bg-success/15 text-success'
                              : 'bg-warning/15 text-warning'
                            : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {isActive ? (hasPosition ? 'Trading' : 'Watching') : session.haltedAt ? 'Paused' : 'Stopped'}
                      </span>

                      {/* Capital */}
                      <span className="inline-flex items-center w-fit rounded px-1.5 py-0.5 text-[9px] font-semibold bg-accent/12 text-accent">
                        Shared pool
                      </span>

                      {/* PnL */}
                      <span className={cn("text-xs font-semibold text-right block", pnl >= 0 ? "text-success" : "text-destructive")}>
                        {formatUsd(pnl)}
                      </span>

                      {/* ROI */}
                      <span className={cn("text-[11px] font-medium text-right block", roi >= 0 ? "text-success" : "text-destructive")}>
                        {formatPercent(roi)}
                      </span>

                      {/* Win Rate */}
                      <span className={cn("text-[11px] font-medium text-right block", winRate >= 50 ? "text-success" : "text-destructive")}>
                        {formatPercent(winRate)}
                      </span>

                      {/* Trades */}
                      <span className="text-muted-foreground text-[11px] text-right block">
                        {session.totalTrades ?? 0}
                      </span>

                      {/* Actions */}
                      <div className="flex gap-1 justify-end" onClick={(e) => e.stopPropagation()}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className={cn(
                                'h-7 w-7 rounded-md',
                                isActive
                                  ? 'text-destructive hover:bg-destructive/15'
                                  : 'text-success hover:bg-success/15'
                              )}
                              onClick={() => handleAction(isActive ? 'stop' : 'start', session)}
                            >
                              {isActive ? <PauseCircle className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{isActive ? 'Pause' : 'Start'}</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted"
                              onClick={() => navigate(`/agents/${session.id}`)}
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>View</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-md text-destructive hover:bg-destructive/15"
                              onClick={() => handleAction('delete', session)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Delete</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* Cards View */}
        {viewMode === 'cards' && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
            {sessionsList.length === 0 ? (
              <div className="col-span-full py-12 flex flex-col items-center justify-center gap-3">
                <Bot className="h-10 w-10 text-muted-foreground" />
                <span className="text-muted-foreground text-sm">No agents yet</span>
                <Button onClick={() => setCreateModalOpen(true)}>Create Your First Agent</Button>
              </div>
            ) : (
              sessionsList.map((session) => {
                const pnl = Number(session.pnlUsd ?? 0);
                const roi = Number(session.roiPct ?? 0);
                const winRate = Number(session.winRate ?? 0);
                const isActive = isSessionActive(session);
                const hasPosition = (session.openPositions ?? 0) > 0;

                return (
                  <div
                    key={session.id}
                    onClick={() => navigate(`/agents/${session.id}`)}
                    className="rounded-2xl border border-border bg-card p-5 cursor-pointer transition-all duration-200 hover:border-primary/30 hover:shadow-md"
                  >
                    {/* Card header: name + badges */}
                    <div className="flex items-start justify-between gap-2 mb-4">
                      <div className="min-w-0">
                        <span className="text-foreground font-semibold text-sm block truncate">{resolveAgentLabel(session)}</span>
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <span
                            className={cn(
                              'inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold',
                              session.mode === 'live'
                                ? 'bg-destructive/15 text-destructive'
                                : 'bg-accent/15 text-accent'
                            )}
                          >
                            {session.mode?.toUpperCase()}
                          </span>
                          <span className="text-muted-foreground text-[10px]">{session.isSmartAgent ? 'Smart Auto' : 'Manual'}</span>
                        </div>
                      </div>
                      <span
                        className={cn(
                          'inline-flex items-center shrink-0 rounded px-2 py-0.5 text-[9px] font-semibold',
                          isActive
                            ? hasPosition
                              ? 'bg-success/15 text-success'
                              : 'bg-warning/15 text-warning'
                            : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {isActive ? (hasPosition ? 'Trading' : 'Watching') : session.haltedAt ? 'Paused' : 'Stopped'}
                      </span>
                    </div>

                    {/* Metrics grid */}
                    <div className="grid grid-cols-4 gap-3 mb-4 py-3 border-t border-b border-border">
                      <div>
                        <span className="text-muted-foreground text-[10px] uppercase tracking-wide block mb-0.5">PnL</span>
                        <span className={cn('font-semibold text-sm block', pnl >= 0 ? 'text-success' : 'text-destructive')}>
                          {formatUsd(pnl)}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground text-[10px] uppercase tracking-wide block mb-0.5">ROI</span>
                        <span className={cn('font-semibold text-sm block', roi >= 0 ? 'text-success' : 'text-destructive')}>
                          {formatPercent(roi)}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground text-[10px] uppercase tracking-wide block mb-0.5">Win Rate</span>
                        <span className={cn('font-semibold text-sm block', winRate >= 50 ? 'text-success' : 'text-destructive')}>
                          {formatPercent(winRate)}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground text-[10px] uppercase tracking-wide block mb-0.5">Trades</span>
                        <span className="font-semibold text-sm block text-foreground">
                          {session.totalTrades ?? 0}
                        </span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className={cn(
                              'h-8 rounded-md flex-1',
                              isActive
                                ? 'text-destructive hover:bg-destructive/10'
                                : 'text-success hover:bg-success/10'
                            )}
                            onClick={() => handleAction(isActive ? 'stop' : 'start', session)}
                          >
                            {isActive ? <PauseCircle className="h-3.5 w-3.5 mr-1.5" /> : <PlayCircle className="h-3.5 w-3.5 mr-1.5" />}
                            {isActive ? 'Pause' : 'Start'}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{isActive ? 'Pause agent' : 'Start agent'}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-md text-muted-foreground hover:bg-muted"
                            onClick={() => navigate(`/agents/${session.id}`)}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>View cockpit</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-md text-destructive hover:bg-destructive/10"
                            onClick={() => handleAction('delete', session)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Delete agent</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Confirm Dialog */}
        <Dialog open={confirmState.open} onOpenChange={(open) => setConfirmState((prev) => ({ ...prev, open }))}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{confirmState.title}</DialogTitle>
              <DialogDescription>{confirmState.description}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmState((prev) => ({ ...prev, open: false }))}>
                Cancel
              </Button>
              <Button variant={confirmState.variant} onClick={confirmState.onConfirm}>
                Confirm
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AgentCreationModal
          visible={createModalOpen}
          onClose={() => setCreateModalOpen(false)}
          onSuccess={() => { setCreateModalOpen(false); invalidateCache(); refresh(true); }}
          mode={currentMode as AppMode}
        />
      </div>
    </TooltipProvider>
  );
}
