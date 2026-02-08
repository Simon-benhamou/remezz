import React from 'react';
import { RefreshCw, Download, Search, Loader2 } from 'lucide-react';
import dayjs from 'dayjs';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import { useDataCache } from '../hooks/useDataCache';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type Outcome = 'win' | 'loss' | 'breakeven';

type TradeRow = {
  id: string;
  createdAt: string;
  symbol: string;
  positionSide: string;
  qty: number;
  entryPrice?: number | null;
  exitPrice?: number | null;
  realizedPnlUsd?: number | null;
  leverage?: number | null;
  sessionSymbol?: string;
  sessionMode?: string;
  sessionId?: string;
  outcome?: Outcome;
  roePct?: number | null;
  notionalUsd?: number | null;
  exitReason?: string | null;
  durationMinutes?: number | null;
  maxPnlPct?: number | null;
  feesUsd?: number | null;
};

function asOutcome(row: TradeRow): Outcome {
  const pnl = Number(row.realizedPnlUsd ?? 0);
  if (Math.abs(pnl) < 0.01) return 'breakeven';
  return pnl > 0 ? 'win' : 'loss';
}

function formatDuration(minutes?: number | null): string {
  if (minutes == null) return '-';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

export default function ExecutionLedgerPageNew() {
  const [searchText, setSearchText] = React.useState('');
  const { mode } = useMode();

  // Fetch all trades with caching and parallel loading
  const fetchAllTrades = React.useCallback(async (): Promise<TradeRow[]> => {
    // Load ALL sessions (paper + live) to see all trades
    const sessionsList = await api.listSessions();

    // Fetch trades from all sessions in PARALLEL (not sequential N+1)
    const tradePromises = sessionsList.map(async (session: any) => {
      try {
        const res = await api.getTrades(session.id, { limit: 250 });
        const sessionTrades = Array.isArray(res) ? res : (res?.trades || []);
        return sessionTrades.map((t: any) => ({
          ...t,
          sessionId: session.id,
          sessionSymbol: session.symbol,
          sessionMode: session.mode,
          outcome: asOutcome(t),
        }));
      } catch {
        return [];
      }
    });

    const tradeArrays = await Promise.all(tradePromises);
    const allTrades = tradeArrays.flat();
    allTrades.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return allTrades;
  }, []);

  // Use caching hook - data stays visible while refreshing
  const {
    data: allTrades,
    isInitialLoad,
    isRefreshing,
    refresh,
  } = useDataCache<TradeRow[]>({
    cacheKey: 'execution-ledger',
    fetcher: fetchAllTrades,
    ttlMs: 60000, // 60s TTL
    autoRefreshMs: 120000, // Auto-refresh every 2 minutes
    modeAware: false, // We load all modes, filter client-side
  });

  const trades = React.useMemo(() => {
    return (allTrades || []).filter(t => t.sessionMode === mode);
  }, [allTrades, mode]);

  const summary = React.useMemo(() => {
    if (!trades.length) return null;
    let wins = 0, losses = 0, totalPnl = 0, totalFees = 0;
    trades.forEach(trade => {
      const pnl = Number(trade.realizedPnlUsd ?? 0);
      const fees = Number(trade.feesUsd ?? 0);
      totalPnl += pnl;
      totalFees += fees;
      const outcome = asOutcome(trade);
      if (outcome === 'win') wins++;
      else if (outcome === 'loss') losses++;
    });
    return { total: trades.length, wins, losses, winRate: trades.length ? (wins / trades.length) * 100 : 0, totalPnl, totalFees, netPnl: totalPnl - totalFees };
  }, [trades]);

  const handleRefresh = React.useCallback(() => {
    refresh(true);
  }, [refresh]);

  const exportCsv = () => {
    if (!trades.length) return;
    const headers = ['Date', 'Symbol', 'Side', 'Qty', 'Entry', 'Exit', 'PnL', 'ROE%', 'Notional', 'Leverage', 'Duration', 'Exit Type', 'MaxPnL%', 'Fees', 'Outcome'];
    const rows = trades.map(t => [
      dayjs(t.createdAt).format('YYYY-MM-DD HH:mm'),
      t.symbol,
      t.positionSide,
      t.qty?.toFixed(4),
      t.entryPrice?.toFixed(4),
      t.exitPrice?.toFixed(4),
      t.realizedPnlUsd?.toFixed(2),
      t.roePct?.toFixed(2),
      t.notionalUsd?.toFixed(0),
      t.leverage?.toFixed(1),
      formatDuration(t.durationMinutes),
      t.exitReason || '',
      t.maxPnlPct?.toFixed(2),
      t.feesUsd?.toFixed(2),
      t.outcome,
    ].join(','));
    const blob = new Blob([[headers.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trades_${dayjs().format('YYYYMMDD')}.csv`;
    a.click();
  };

  const filteredTrades = React.useMemo(() => {
    if (!searchText) return trades;
    const s = searchText.toLowerCase();
    return trades.filter(t => t.symbol?.toLowerCase().includes(s) || t.sessionSymbol?.toLowerCase().includes(s));
  }, [trades, searchText]);

  const gridCols = 'grid-cols-[90px_55px_55px_55px_95px_50px_70px_70px_70px_75px_55px_65px_45px_50px_110px_55px_55px]';

  return (
    <div className="px-4 pb-4 sm:px-6 sm:pb-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex flex-col gap-3 mb-5 sm:flex-row sm:justify-between sm:items-center">
        <h3 className="text-xl font-semibold text-foreground flex items-center gap-2.5">
          <span className="text-xl">📊</span> Execution Ledger
        </h3>
        <div className="flex flex-wrap gap-2 sm:gap-3 items-center">
          <div className="relative flex-1 min-w-[140px] sm:flex-none">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              placeholder="Search..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="h-9 w-full sm:w-[200px] rounded-md border border-border bg-card pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
          {isRefreshing && !isInitialLoad && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-accent/15 px-2.5 py-1 text-xs font-medium text-accent">
              <Loader2 className="h-3 w-3 animate-spin" />
            </span>
          )}
          <Button size="sm" onClick={exportCsv} disabled={!trades.length}>
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Export CSV</span>
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
          <div className="rounded-xl border border-border bg-card px-5 py-4">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Trades</div>
            <div className="text-2xl font-bold text-foreground mt-1">{summary.total}</div>
          </div>
          <div className="rounded-xl border border-border bg-card px-5 py-4">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Win / Losses</div>
            <div className="text-2xl font-bold text-foreground mt-1">{summary.wins} / {summary.losses}</div>
          </div>
          <div className="rounded-xl border border-border bg-card px-5 py-4">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Win Rate</div>
            <div className="text-2xl font-bold text-accent mt-1">{summary.winRate.toFixed(1)}%</div>
          </div>
          <div className="rounded-xl border border-border bg-card px-5 py-4">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total P&L</div>
            <div className={cn("text-2xl font-bold mt-1", summary.totalPnl >= 0 ? "text-success" : "text-destructive")}>
              {summary.totalPnl >= 0 ? '+' : '-'}${Math.abs(summary.totalPnl).toFixed(2)}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card px-5 py-4">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Fees</div>
            <div className="text-2xl font-bold text-warning mt-1">-${summary.totalFees.toFixed(2)}</div>
          </div>
          <div className="rounded-xl border border-border bg-card px-5 py-4">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Net P&L</div>
            <div className={cn("text-2xl font-bold mt-1", summary.netPnl >= 0 ? "text-success" : "text-destructive")}>
              {summary.netPnl >= 0 ? '+' : '-'}${Math.abs(summary.netPnl).toFixed(2)}
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-auto rounded-2xl border border-border bg-card">
        <div className="min-w-[1200px]">
          {/* Table Header */}
          <div className={cn("grid px-4 py-3 border-b border-border bg-card", gridCols)}>
            {['Date', 'Outcome', 'Mode', 'Session', 'Symbol', 'Side', 'Qty', 'Entry', 'Exit', 'P&L', 'ROE%', 'Notional', 'Lev', 'Dur', 'Exit Type', 'MaxP&L', 'Fees'].map((h, i) => (
              <span key={i} className={cn("text-[11px] uppercase tracking-wide text-muted-foreground whitespace-nowrap", i >= 6 && "text-right")}>{h}</span>
            ))}
          </div>

          {/* Loading - only show skeleton on initial load */}
          {isInitialLoad && (
            <div className="p-12 space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </div>
          )}

          {/* Rows */}
          {filteredTrades.map((trade) => {
            const pnl = Number(trade.realizedPnlUsd ?? 0);
            const roe = Number(trade.roePct ?? 0);
            return (
              <div
                key={trade.id}
                className={cn("grid px-4 py-2.5 border-b border-border items-center transition-colors duration-150 hover:bg-muted/30", gridCols)}
              >
                {/* Date */}
                <div className="whitespace-nowrap">
                  <div className="text-foreground text-[11px]">{dayjs(trade.createdAt).format('YYYY-MM-DD')}</div>
                  <div className="text-muted-foreground text-[9px]">{dayjs(trade.createdAt).format('HH:mm:ss')}</div>
                </div>

                {/* Outcome */}
                <span className={cn(
                  "inline-flex items-center rounded px-1 py-0.5 text-[9px] font-semibold w-fit",
                  trade.outcome === 'win' ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
                )}>
                  {trade.outcome?.toUpperCase()}
                </span>

                {/* Mode */}
                <span className={cn(
                  "inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold w-fit",
                  trade.sessionMode === 'live' ? "bg-success/15 text-success" : "bg-accent/15 text-accent"
                )}>
                  {(trade.sessionMode || 'unknown').toUpperCase()}
                </span>

                {/* Session */}
                <div className="whitespace-nowrap">
                  <div className="text-foreground text-[11px]">{trade.sessionSymbol?.replace('/USDT:USDT', '')}</div>
                </div>

                {/* Symbol */}
                <span className="text-foreground text-[11px] whitespace-nowrap">{trade.symbol?.replace('/USDT:USDT', '/USDT')}</span>

                {/* Side */}
                <span className={cn(
                  "inline-flex items-center rounded-sm px-1 py-0.5 text-[9px] font-semibold w-fit",
                  trade.positionSide === 'long' ? "bg-success/12 text-success" : "bg-destructive/12 text-destructive"
                )}>
                  {trade.positionSide?.toUpperCase()}
                </span>

                {/* Quantity */}
                <span className="text-muted-foreground text-[11px] text-right block">{trade.qty?.toFixed(4)}</span>

                {/* Entry */}
                <span className="text-muted-foreground text-[11px] text-right block">{trade.entryPrice?.toFixed(4)}</span>

                {/* Exit */}
                <span className="text-muted-foreground text-[11px] text-right block">{trade.exitPrice?.toFixed(4)}</span>

                {/* P&L */}
                <span className={cn("text-xs font-semibold text-right block", pnl >= 0 ? "text-success" : "text-destructive")}>
                  {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                </span>

                {/* ROE */}
                <span className={cn("text-[11px] font-medium text-right block", roe >= 0 ? "text-success" : "text-destructive")}>
                  {roe >= 0 ? '+' : ''}{roe.toFixed(1)}%
                </span>

                {/* Notional */}
                <span className="text-muted-foreground text-[11px] text-right block">
                  ${(trade.notionalUsd ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>

                {/* Leverage */}
                <span className="text-muted-foreground text-[11px] text-right block">{trade.leverage?.toFixed(1)}x</span>

                {/* Duration */}
                <span className="text-muted-foreground text-[10px] text-right block">{formatDuration(trade.durationMinutes)}</span>

                {/* Exit Type */}
                {trade.exitReason ? (
                  <span className={cn(
                    "inline-flex items-center rounded-sm px-1 py-0.5 text-[8px] whitespace-nowrap w-fit",
                    trade.exitReason.includes('PROFIT') || trade.exitReason.includes('TRAILING')
                      ? "bg-success/10 text-success"
                      : "bg-destructive/10 text-destructive"
                  )}>
                    {trade.exitReason.includes('trailing_stop_exchange') ? 'TRAILING STOP' : trade.exitReason.replace(/_/g, ' ').toUpperCase()}
                  </span>
                ) : <span className="text-muted-foreground text-[10px]">-</span>}

                {/* Max P&L */}
                <span className="text-muted-foreground text-[10px] text-right block">
                  {trade.maxPnlPct != null ? `+${trade.maxPnlPct.toFixed(1)}%` : '-'}
                </span>

                {/* Fees */}
                <span className="text-warning text-[10px] text-right block">
                  -${(trade.feesUsd ?? 0).toFixed(2)}
                </span>
              </div>
            );
          })}

          {!isInitialLoad && filteredTrades.length === 0 && (
            <div className="p-12 text-center text-muted-foreground">No trades found</div>
          )}
        </div>
      </div>
    </div>
  );
}
