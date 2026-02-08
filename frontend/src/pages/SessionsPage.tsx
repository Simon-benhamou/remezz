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
  const [viewMode, setViewMode] = React.useState<ViewMode>('table');
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
              <span className="text-[var(--text-muted)] text-[13px]">
                Autonomous multi-agent system with intelligent portfolio diversification
              </span>
            </div>
            <div className="flex items-center gap-3">
              <ToggleGroup
                type="single"
                value={viewMode}
                onValueChange={(v) => v && setViewMode(v as ViewMode)}
                className="bg-[var(--bg-primary)] rounded-md"
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
              <div className="w-2 h-2 rounded-full bg-[var(--success)]" />
              <span className="text-[var(--text-secondary)] text-[13px]">{activeSessions.length} Active</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-[var(--warning)]" />
              <span className="text-[var(--text-secondary)] text-[13px]">{pausedSessions.length} Paused</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-[var(--text-secondary)]" />
              <span className="text-[var(--text-secondary)] text-[13px]">{stoppedSessions.length} Stopped</span>
            </div>
          </div>
        </div>

        {/* Table View */}
        {viewMode === 'table' && (
          <div className="bg-[var(--bg-primary)] rounded-2xl border border-[var(--border-subtle)] overflow-hidden">
            {/* Header Row */}
            <div
              className="grid px-5 py-3.5 border-b border-[var(--border-subtle)] bg-[var(--bg-primary)]"
              style={{ gridTemplateColumns: '2fr 100px 100px 120px 120px 100px 100px 80px 140px' }}
            >
              <span className="text-[var(--text-muted)] text-[11px] uppercase tracking-wide font-medium">Agent</span>
              <span className="text-[var(--text-muted)] text-[11px] uppercase tracking-wide font-medium">Selection</span>
              <span className="text-[var(--text-muted)] text-[11px] uppercase tracking-wide font-medium">Status</span>
              <span className="text-[var(--text-muted)] text-[11px] uppercase tracking-wide font-medium">Capital Source</span>
              <span className="text-[var(--text-muted)] text-[11px] uppercase tracking-wide font-medium text-right">PnL</span>
              <span className="text-[var(--text-muted)] text-[11px] uppercase tracking-wide font-medium text-right">ROI</span>
              <span className="text-[var(--text-muted)] text-[11px] uppercase tracking-wide font-medium text-right">Win Rate</span>
              <span className="text-[var(--text-muted)] text-[11px] uppercase tracking-wide font-medium text-center">Trades</span>
              <span className="text-[var(--text-muted)] text-[11px] uppercase tracking-wide font-medium text-right">Actions</span>
            </div>

            {sessionsList.length === 0 ? (
              <div className="py-12 flex flex-col items-center justify-center gap-3">
                <Bot className="h-10 w-10 text-[var(--text-muted)]" />
                <span className="text-[var(--text-secondary)] text-sm">No agents yet</span>
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
                    className="grid px-5 py-4 border-b border-[var(--border-subtle)] cursor-pointer transition-colors duration-150 items-center hover:bg-[var(--bg-card-hover)]"
                    style={{ gridTemplateColumns: '2fr 100px 100px 120px 120px 100px 100px 80px 140px' }}
                  >
                    {/* Agent */}
                    <div className="flex items-center gap-2.5">
                      <span className="text-[var(--text-primary)] font-semibold text-sm">{resolveAgentLabel(session)}</span>
                      <span
                        className={cn(
                          'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] leading-snug font-medium',
                          session.mode === 'live'
                            ? 'bg-red-500/12 text-[var(--error)]'
                            : 'bg-blue-500/12 text-[var(--accent)]'
                        )}
                      >
                        {session.mode?.toUpperCase()}
                      </span>
                    </div>

                    {/* Selection */}
                    <span className="text-[var(--text-secondary)] text-[13px]">{session.isSmartAgent ? 'Smart Auto' : 'Manual'}</span>

                    {/* Status */}
                    <span
                      className={cn(
                        'inline-flex items-center w-fit rounded px-2 py-0.5 text-[11px] font-medium',
                        isActive
                          ? hasPosition
                            ? 'bg-green-500/12 text-[var(--success)]'
                            : 'bg-amber-400/12 text-[var(--warning)]'
                          : 'bg-slate-400/10 text-[var(--text-secondary)]'
                      )}
                    >
                      {isActive ? (hasPosition ? 'Trading' : 'Watching') : session.haltedAt ? 'Paused' : 'Stopped'}
                    </span>

                    {/* Capital Source */}
                    <span className="inline-flex items-center w-fit rounded px-2 py-0.5 text-[11px] font-medium bg-blue-500/10 text-[var(--accent)]">
                      Shared pool
                    </span>

                    {/* PnL */}
                    <div className="text-right">
                      <span className={cn('block font-semibold text-sm', pnl >= 0 ? 'text-[var(--success)]' : 'text-[var(--error)]')}>
                        {formatUsd(pnl)}
                      </span>
                      <span className={cn('text-[11px]', roi >= 0 ? 'text-green-400/70' : 'text-red-400/70')}>
                        {formatPercent(roi)}
                      </span>
                    </div>

                    {/* ROI */}
                    <span className={cn('block text-right font-medium text-[13px]', roi >= 0 ? 'text-[var(--success)]' : 'text-[var(--error)]')}>
                      {formatPercent(roi)}
                    </span>

                    {/* Win Rate */}
                    <span className={cn('block text-right font-medium text-[13px]', winRate >= 50 ? 'text-[var(--success)]' : 'text-[var(--error)]')}>
                      {formatPercent(winRate)}
                    </span>

                    {/* Trades */}
                    <span className="block text-center text-[var(--text-secondary)] text-[13px]">
                      {session.totalTrades ?? 0}
                    </span>

                    {/* Actions */}
                    <div className="flex gap-1.5 justify-end" onClick={(e) => e.stopPropagation()}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                              'h-8 w-8 rounded-md',
                              isActive
                                ? 'bg-red-500/8 text-[var(--error)] hover:bg-red-500/15'
                                : 'bg-green-500/8 text-[var(--success)] hover:bg-green-500/15'
                            )}
                            onClick={() => handleAction(isActive ? 'stop' : 'start', session)}
                          >
                            {isActive ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{isActive ? 'Pause' : 'Start'}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-md bg-slate-400/8 hover:bg-slate-400/15"
                            onClick={() => navigate(`/agents/${session.id}`)}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>View</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-md bg-red-500/8 text-[var(--error)] hover:bg-red-500/15"
                            onClick={() => handleAction('delete', session)}
                          >
                            <Trash2 className="h-4 w-4" />
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
        )}

        {/* Cards View */}
        {viewMode === 'cards' && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
            {sessionsList.length === 0 ? (
              <div className="col-span-full py-12 flex flex-col items-center justify-center gap-3">
                <Bot className="h-10 w-10 text-[var(--text-muted)]" />
                <span className="text-[var(--text-secondary)] text-sm">No agents yet</span>
                <Button onClick={() => setCreateModalOpen(true)}>Create Your First Agent</Button>
              </div>
            ) : (
              sessionsList.map((session) => {
                const pnl = Number(session.pnlUsd ?? 0);
                const isActive = isSessionActive(session);
                const hasPosition = (session.openPositions ?? 0) > 0;

                return (
                  <div
                    key={session.id}
                    onClick={() => navigate(`/agents/${session.id}`)}
                    className="bg-[var(--bg-primary)] rounded-2xl border border-[var(--border-subtle)] p-5 cursor-pointer transition-all duration-200 hover:border-blue-500/30 hover:-translate-y-0.5"
                  >
                    <div className="flex justify-between mb-4">
                      <div>
                        <span className="text-[var(--text-primary)] font-semibold text-base block">{resolveAgentLabel(session)}</span>
                        <span
                          className={cn(
                            'inline-flex items-center mt-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium',
                            session.mode === 'live'
                              ? 'bg-red-500/12 text-[var(--error)]'
                              : 'bg-blue-500/12 text-[var(--accent)]'
                          )}
                        >
                          {session.mode?.toUpperCase()}
                        </span>
                      </div>
                      <span
                        className={cn(
                          'inline-flex items-center h-fit rounded px-2 py-0.5 text-[11px] font-medium',
                          isActive
                            ? hasPosition
                              ? 'bg-green-500/12 text-[var(--success)]'
                              : 'bg-amber-400/12 text-[var(--warning)]'
                            : 'bg-slate-400/10 text-[var(--text-secondary)]'
                        )}
                      >
                        {isActive ? (hasPosition ? 'Trading' : 'Watching') : session.haltedAt ? 'Paused' : 'Stopped'}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 mb-4">
                      <div>
                        <span className="text-[var(--text-muted)] text-[11px] block">PnL</span>
                        <span className={cn('font-bold text-xl', pnl >= 0 ? 'text-[var(--success)]' : 'text-[var(--error)]')}>
                          {formatUsd(pnl)}
                        </span>
                      </div>
                      <div>
                        <span className="text-[var(--text-muted)] text-[11px] block">Win Rate</span>
                        <span className={cn('font-semibold text-base', (session.winRate ?? 0) >= 50 ? 'text-[var(--success)]' : 'text-[var(--error)]')}>
                          {formatPercent(session.winRate)}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="sm"
                        variant={isActive ? 'destructive' : 'default'}
                        className="flex-1"
                        onClick={() => handleAction(isActive ? 'stop' : 'start', session)}
                      >
                        {isActive ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
                        {isActive ? 'Pause' : 'Start'}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => navigate(`/agents/${session.id}`)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => handleAction('delete', session)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
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
