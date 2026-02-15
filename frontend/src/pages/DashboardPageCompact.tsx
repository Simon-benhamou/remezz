import React from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/api';
import { useMode } from '@/contexts/ModeContext';
import { useMultiDataCache } from '@/hooks/useMultiDataCache';
import { AppMode } from '@/store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import {
  Bot,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Activity,
  Loader2,
} from 'lucide-react';

// Market Conditions types V5
type MarketConditionsStatus = 'favorable_long' | 'favorable_short' | 'neutral' | 'unfavorable' | 'unknown';

interface MarketConditions {
  status: MarketConditionsStatus;
  btcAboveMa50: boolean | null;
  btcAboveSma200?: boolean | null;
  btcMomentum6h: number | null;
  btcTrend: 'bullish' | 'bearish' | 'neutral' | null;
  isTradingDay: boolean | null;
  reason: string;
  tradingRecommended: boolean;
  marketQuality?: 'momentum' | 'consolidation' | 'unknown' | 'analyzing';
  qualityReason?: string;
}

type Trade = {
  id: string;
  createdAt: string;
  symbol?: string;
  positionSide?: string;
  entryPrice?: number | null;
  exitPrice?: number | null;
  realizedPnlUsd?: number;
  feesUsd?: number;
  roePct?: number | null;
  estLev?: number | null;
};

export default function DashboardPageCompact() {
  const navigate = useNavigate();
  const { mode } = useMode();

  // Use multi-data cache for all dashboard data
  // Data stays visible while refreshing (stale-while-revalidate)
  const {
    data,
    isInitialLoad,
    isRefreshing,
    refresh,
  } = useMultiDataCache<{
    overview: any;
    trades: Trade[];
    marketConditions: MarketConditions | null;
  }>({
    cacheKey: 'dashboard',
    mode: mode as AppMode,
    sources: {
      overview: {
        key: 'overview',
        fetcher: async () => api.overview(mode),
        ttlMs: 30000, // 30s TTL
      },
      trades: {
        key: 'trades',
        fetcher: async () => {
          const tradesRes = await api.getTrades(undefined, { limit: 5000, mode: mode as any });
          const allTrades = Array.isArray(tradesRes) ? tradesRes : (tradesRes?.trades || []);
          return allTrades
            .filter((t: any) => t.exitPrice != null && t.entryPrice != null && t.realizedPnlUsd != null)
            .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        },
        ttlMs: 60000, // 60s TTL for trades (less frequent updates)
      },
      marketConditions: {
        key: 'marketConditions',
        fetcher: async () => api.getMarketConditions().catch(() => null),
        ttlMs: 30000, // 30s TTL
      },
    },
    autoRefreshMs: 30000, // Check for stale data every 30s
  });

  // Extract data with defaults
  const ov = data.overview || {};
  const trades = data.trades || [];
  const marketConditions = data.marketConditions || null;

  // Manual refresh handler
  const handleRefresh = React.useCallback(() => {
    refresh(undefined, true);
  }, [refresh]);

  // Build chart data - NET P&L (after fees)
  const chartData = React.useMemo(() => {
    if (!trades || trades.length === 0) return [];
    const sorted = [...trades].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    let cumulative = 0;
    const intl = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

    // Start from $0 baseline so the line has a visible origin
    const firstDate = new Date(sorted[0].createdAt);
    const baselineDate = new Date(firstDate);
    baselineDate.setHours(baselineDate.getHours() - 1); // Slightly before first trade
    const points = [
      { date: intl.format(baselineDate), value: 0, fullDate: baselineDate.toISOString() },
    ];

    for (const trade of sorted) {
      cumulative += Number(trade.realizedPnlUsd || 0) - Number(trade.feesUsd || 0);
      points.push({
        date: intl.format(new Date(trade.createdAt)),
        value: Number(cumulative.toFixed(2)),
        fullDate: trade.createdAt,
      });
    }
    return points;
  }, [trades]);

  // Stats - use ov.todayPnlUsd from backend (already includes fees) for accuracy
  const stats = React.useMemo(() => {
    const totalPnl = trades.reduce((sum, t) => sum + (t.realizedPnlUsd || 0) - (t.feesUsd || 0), 0);

    // Today's PnL - filter trades from today (midnight local time)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTrades = trades.filter(t => new Date(t.createdAt) >= todayStart);
    // Calculate net PnL (after fees) for today
    const todayPnl = todayTrades.reduce((sum, t) => sum + (t.realizedPnlUsd || 0) - (t.feesUsd || 0), 0);
    const todayWins = todayTrades.filter(t => (t.realizedPnlUsd || 0) > 0).length;
    const todayLosses = todayTrades.filter(t => (t.realizedPnlUsd || 0) < 0).length;
    const todayWinRate = (todayWins + todayLosses) > 0 ? (todayWins / (todayWins + todayLosses)) * 100 : 0;

    const wins = trades.filter(t => (t.realizedPnlUsd || 0) > 0).length;
    const losses = trades.filter(t => (t.realizedPnlUsd || 0) < 0).length;
    const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;
    const avgRoe = trades.length > 0
      ? trades.reduce((sum, t) => sum + (t.roePct || 0), 0) / trades.length
      : 0;
    const avgLev = trades.length > 0
      ? trades.reduce((sum, t) => sum + (t.estLev || 0), 0) / trades.length
      : 0;
    const longs = trades.filter(t => t.positionSide === 'long').length;
    const shorts = trades.filter(t => t.positionSide === 'short').length;
    return { totalPnl, todayPnl, todayTrades: todayTrades.length, todayWinRate, wins, losses, winRate, avgRoe, avgLev, longs, shorts };
  }, [trades]);

  const recentTrades = trades.slice(0, 6);
  const tradingCount = (ov?.sessions || []).filter((s: any) => s.state === 'IN_POSITION').length;
  const watchingCount = (ov?.sessions || []).filter((s: any) => s.state === 'WATCHING').length;

  return (
    <div className="mx-auto min-h-screen max-w-[1400px] p-5">

      {/* Refresh indicator - shows when updating data in background */}
      {isRefreshing && !isInitialLoad && (
        <div className="mb-2 flex justify-end">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            <Loader2 className="h-3 w-3 animate-spin" />
            Updating...
          </span>
        </div>
      )}

      {/* Top Stats Bar */}
      <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {/* Active Agents */}
        <div className="rounded-xl border border-border bg-gradient-to-br from-card to-muted/50 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Bot className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-medium text-primary">Active Agents</span>
          </div>
          <div className="text-3xl font-bold text-foreground">{ov?.activeCount || 0}</div>
          <span className="text-xs text-muted-foreground">{tradingCount} Trading Now</span>
        </div>

        {/* Today's PnL */}
        <div className="rounded-xl border border-border bg-gradient-to-br from-card to-muted/50 p-4">
          <div className="mb-2 flex items-center gap-2">
            {(ov?.todayPnlUsd ?? 0) >= 0
              ? <TrendingUp className="h-3.5 w-3.5 text-success" />
              : <TrendingDown className="h-3.5 w-3.5 text-destructive" />
            }
            <span className={cn(
              "text-xs font-medium",
              (ov?.todayPnlUsd ?? 0) >= 0 ? "text-success" : "text-destructive"
            )}>
              Today's PnL
            </span>
          </div>
          <div className={cn(
            "text-3xl font-bold",
            (ov?.todayPnlUsd ?? 0) >= 0 ? "text-success" : "text-destructive"
          )}>
            {(ov?.todayPnlUsd ?? 0) >= 0 ? '+' : '-'}${Math.abs(ov?.todayPnlUsd ?? 0).toFixed(2)}
          </div>
          <span className="text-xs text-muted-foreground">{ov?.todayTrades ?? stats.todayTrades} trades today</span>
        </div>

        {/* Today Win Rate */}
        <div className="rounded-xl border border-border bg-gradient-to-br from-card to-muted/50 p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-bold text-warning">%</span>
            <span className="text-xs font-medium text-warning">Today Win Rate</span>
          </div>
          <div className={cn(
            "text-3xl font-bold",
            stats.todayWinRate >= 50 ? "text-success" : stats.todayTrades > 0 ? "text-destructive" : "text-muted-foreground"
          )}>
            {stats.todayTrades > 0 ? `${stats.todayWinRate.toFixed(0)}%` : '\u2014'}
          </div>
          <span className="text-xs text-muted-foreground">
            All-time: {stats.winRate.toFixed(0)}% ({stats.wins}W/{stats.losses}L)
          </span>
        </div>

        {/* Total Trades */}
        <div className="rounded-xl border border-border bg-gradient-to-br from-card to-muted/50 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-accent" />
            <span className="text-xs font-medium text-accent">Total Trades</span>
          </div>
          <div className="text-3xl font-bold text-foreground">{trades.length}</div>
          <span className="text-xs text-muted-foreground">
            Avg ROE: {stats.avgRoe >= 0 ? '+' : ''}{stats.avgRoe.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* Market Conditions */}
      {marketConditions && (
        <div className="mb-5 rounded-2xl border border-border bg-card px-6 py-5">
          <h3 className="mb-5 text-base font-semibold text-foreground">
            Market Conditions
          </h3>
          <div className="grid grid-cols-2 items-center gap-x-8 gap-y-4 sm:grid-cols-4">
            {/* Overall Sentiment */}
            <div>
              <span className="mb-2 block text-[11px] uppercase tracking-wide text-muted-foreground">
                Overall Sentiment
              </span>
              <div className="flex items-center gap-2">
                {marketConditions.status === 'favorable_long' && (
                  <>
                    <TrendingUp className="h-4 w-4 text-success" />
                    <span className="text-base font-bold text-success">FAVORABLE LONG</span>
                  </>
                )}
                {marketConditions.status === 'favorable_short' && (
                  <>
                    <TrendingDown className="h-4 w-4 text-destructive" />
                    <span className="text-base font-bold text-destructive">FAVORABLE SHORT</span>
                  </>
                )}
                {marketConditions.status === 'neutral' && (
                  <span className="text-base font-bold text-warning">NEUTRAL</span>
                )}
                {marketConditions.status === 'unfavorable' && (
                  <span className="text-base font-bold text-destructive">UNFAVORABLE</span>
                )}
                {marketConditions.status === 'unknown' && (
                  <span className="text-base font-bold text-muted-foreground">UNKNOWN</span>
                )}
              </div>
            </div>

            {/* BTC 6H Momentum */}
            <div>
              <span className="mb-2 block text-[11px] uppercase tracking-wide text-muted-foreground">
                BTC 6H Momentum
              </span>
              <span className={cn(
                "text-lg font-bold",
                (marketConditions.btcMomentum6h || 0) >= 0 ? "text-success" : "text-destructive"
              )}>
                {(marketConditions.btcMomentum6h || 0) >= 0 ? '+' : ''}{(marketConditions.btcMomentum6h || 0).toFixed(2)}%
              </span>
            </div>

            {/* BTC vs MA200 */}
            <div>
              <span className="mb-2 block text-[11px] uppercase tracking-wide text-muted-foreground">
                BTC vs MA200 (1H)
              </span>
              <span className={cn(
                "text-lg font-bold",
                marketConditions.btcAboveMa50 ? "text-success" : "text-destructive"
              )}>
                {marketConditions.btcAboveMa50 ? 'BULLISH' : 'BEARISH'}
              </span>
            </div>

            {/* Trade Signal */}
            <div>
              <span className="mb-2 block text-[11px] uppercase tracking-wide text-muted-foreground">
                Trade Signal
              </span>
              <span className={cn(
                "inline-flex items-center rounded-md px-4 py-1.5 text-[13px] font-semibold",
                marketConditions.tradingRecommended
                  ? "border border-success bg-success/15 text-success"
                  : "border border-muted-foreground/30 bg-muted-foreground/15 text-muted-foreground"
              )}>
                {marketConditions.tradingRecommended ? 'RECOMMENDED' : 'WAIT'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Active Agents Grid */}
      <div className="mb-5 rounded-2xl border border-border bg-card">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            <span className="text-[15px] font-semibold text-foreground">Active Agents</span>
            <span className="ml-2 inline-flex items-center rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
              {tradingCount} Trading
            </span>
          </div>
          <span className="text-[13px] text-muted-foreground">{watchingCount} watching</span>
        </div>

        {/* Body */}
        <div className="p-5">
          {isInitialLoad ? (
            <div className="flex justify-center py-10">
              <div className="w-full max-w-md animate-pulse space-y-4">
                <div className="h-4 rounded bg-muted" />
                <div className="grid grid-cols-2 gap-4">
                  <div className="h-20 rounded-xl bg-muted" />
                  <div className="h-20 rounded-xl bg-muted" />
                </div>
                <div className="h-4 w-3/4 rounded bg-muted" />
                <div className="grid grid-cols-2 gap-4">
                  <div className="h-20 rounded-xl bg-muted" />
                  <div className="h-20 rounded-xl bg-muted" />
                </div>
              </div>
            </div>
          ) : (ov?.sessions || []).length === 0 ? (
            <div className="flex flex-col items-center py-10 text-muted-foreground">
              <Bot className="mb-4 h-12 w-12 opacity-50" />
              <div>No active agents</div>
              <Button className="mt-4" onClick={() => navigate('/agents')}>
                Create Agent
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
              {(ov?.sessions || []).map((session: any) => (
                <div
                  key={session.id}
                  onClick={() => navigate(`/agents/${session.id}`)}
                  className="cursor-pointer rounded-xl border border-border bg-background p-4 transition-all hover:border-primary/30 hover:bg-muted/50"
                >
                  <div className="mb-3 flex items-start justify-between">
                    <span className="text-sm font-semibold text-foreground">
                      {session.symbol?.replace('/USDT', '').replace(':USDT', '')}
                    </span>
                    <span className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
                      session.state === 'IN_POSITION'
                        ? "bg-primary/15 text-primary"
                        : "bg-warning/15 text-warning"
                    )}>
                      {session.state === 'IN_POSITION' ? 'TRADING' : 'WATCHING'}
                    </span>
                  </div>
                  <span className="mb-2 block text-[11px] text-muted-foreground">PnL</span>
                  <div className={cn(
                    "mb-1 text-[22px] font-bold",
                    (session.pnlUsd || 0) >= 0 ? "text-success" : "text-destructive"
                  )}>
                    {(session.pnlUsd || 0) >= 0 ? '' : '-'}${Math.abs(session.pnlUsd || 0).toFixed(2)}
                  </div>
                  <span className={cn(
                    "text-xs",
                    (session.winRate || 0) >= 50 ? "text-success" : "text-destructive"
                  )}>
                    Win Rate: {(session.winRate || 0).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Performance Overview + Recent Trades Side by Side */}
      <div className="mb-5 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        {/* Performance Chart */}
        <div className="rounded-2xl border border-border bg-card">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <span className="block text-[15px] font-semibold text-foreground">Performance Overview</span>
              <span className="text-xs text-muted-foreground">Cumulative PnL across all sessions</span>
            </div>
            <button
              onClick={handleRefresh}
              className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            </button>
          </div>

          {/* Body */}
          <div className="p-5">
            {/* Big PnL Display - use ov.pnlUsd from backend (accurate, includes all trades & fees) */}
            <div className="mb-5">
              <div className="mb-1">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Total PnL (All-Time)
                </span>
              </div>
              <span className={cn(
                "text-4xl font-bold",
                (ov?.pnlUsd ?? 0) >= 0 ? "text-success" : "text-destructive"
              )}>
                {(ov?.pnlUsd ?? 0) >= 0 ? '+' : '-'}${Math.abs(ov?.pnlUsd ?? 0).toFixed(2)}
              </span>
              <span className="ml-3 text-base text-muted-foreground">
                {ov?.totalTrades ?? trades.length} trades · {(ov?.avgWinRate ?? stats.winRate).toFixed(0)}% win rate
              </span>
            </div>

            {/* Chart */}
            <div className="h-[220px]">
              {chartData.length === 0 ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  No trade data available
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="pnlGradientPositive" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="pnlGradientNegative" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#ef4444" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(30, 58, 95, 0.25)" />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: '#94a3b8', fontSize: 11 }}
                      axisLine={{ stroke: 'rgba(30, 58, 95, 0.25)' }}
                      padding={{ left: 10, right: 10 }}
                    />
                    <YAxis
                      tick={{ fill: '#94a3b8', fontSize: 11 }}
                      axisLine={{ stroke: 'rgba(30, 58, 95, 0.25)' }}
                      tickFormatter={(v) => `$${v}`}
                      width={60}
                    />
                    <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                    <RechartsTooltip
                      content={({ label, payload }) => {
                        if (!payload || payload.length === 0) return null;
                        const value = payload[0]?.value as number;
                        return (
                          <div style={{
                            background: 'var(--bg-elevated, #1e293b)',
                            padding: '10px 14px',
                            borderRadius: 8,
                            border: '1px solid var(--border-color, rgba(30, 58, 95, 0.4))',
                            color: 'var(--text-primary, #f1f5f9)',
                          }}>
                            <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
                            <div style={{ color: value >= 0 ? '#10b981' : '#ef4444' }}>
                              PnL: {value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(2)}
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke={stats.totalPnl >= 0 ? '#10b981' : '#ef4444'}
                      strokeWidth={2}
                      fill={stats.totalPnl >= 0 ? 'url(#pnlGradientPositive)' : 'url(#pnlGradientNegative)'}
                      dot={chartData.length <= 20 ? { r: 3, fill: stats.totalPnl >= 0 ? '#10b981' : '#ef4444' } : false}
                      isAnimationActive={chartData.length > 2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Bottom Stats */}
            <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6 border-t border-border pt-4">
              <div>
                <span className="mb-1 block text-[11px] text-muted-foreground">Sample Size</span>
                <span className="text-lg font-bold text-foreground">{trades.length}</span>
              </div>
              <div>
                <span className="mb-1 block text-[11px] text-muted-foreground">Avg ROE</span>
                <span className={cn("text-lg font-bold", stats.avgRoe >= 0 ? "text-success" : "text-destructive")}>
                  {stats.avgRoe >= 0 ? '+' : ''}{stats.avgRoe.toFixed(1)}%
                </span>
              </div>
              <div>
                <span className="mb-1 block text-[11px] text-muted-foreground">Avg Leverage</span>
                <span className="text-lg font-bold text-foreground">{stats.avgLev.toFixed(2)}x</span>
              </div>
              <div>
                <span className="mb-1 block text-[11px] text-muted-foreground">Direction</span>
                <span className="text-lg font-bold text-foreground">{stats.longs}L / {stats.shorts}S</span>
              </div>
            </div>
          </div>
        </div>

        {/* Recent Trades Cards */}
        <div className="rounded-2xl border border-border bg-card">
          {/* Header */}
          <div className="border-b border-border px-5 py-4">
            <span className="block text-[15px] font-semibold text-foreground">Recent Trades</span>
            <span className="text-xs text-muted-foreground">Last {recentTrades.length} executions</span>
          </div>

          {/* Body */}
          <div className="p-4">
            <div className="flex flex-col gap-3">
              {recentTrades.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  No recent trades
                </div>
              ) : (
                recentTrades.map((trade) => (
                  <div
                    key={trade.id}
                    className="rounded-[10px] border border-border bg-muted/50 px-3.5 py-3"
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm font-semibold text-foreground">
                        {trade.symbol?.replace('/USDT', '').replace(':USDT', '')}
                      </span>
                      <div className="flex items-center gap-1">
                        {(trade.realizedPnlUsd || 0) >= 0 ? (
                          <TrendingUp className="h-3 w-3 text-success" />
                        ) : (
                          <TrendingDown className="h-3 w-3 text-destructive" />
                        )}
                        <span className={cn(
                          "text-sm font-bold",
                          (trade.realizedPnlUsd || 0) >= 0 ? "text-success" : "text-destructive"
                        )}>
                          {(trade.realizedPnlUsd || 0) >= 0 ? '+' : ''}${(trade.realizedPnlUsd || 0).toFixed(0)}
                        </span>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                      <div>
                        <span className="block text-[10px] text-muted-foreground">Entry</span>
                        <span className="text-xs text-foreground">{(trade.entryPrice || 0).toFixed(4)}</span>
                      </div>
                      <div>
                        <span className="block text-[10px] text-muted-foreground">Exit</span>
                        <span className="text-xs text-foreground">{(trade.exitPrice || 0).toFixed(4)}</span>
                      </div>
                      <div className="text-right">
                        <span className="block text-[10px] text-muted-foreground">&nbsp;</span>
                        <span className="text-[11px] text-muted-foreground">
                          {new Date(trade.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} {new Date(trade.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}
                        </span>
                      </div>
                    </div>
                    <div className="mt-2">
                      <span className={cn(
                        "mr-3 text-xs",
                        (trade.roePct || 0) >= 0 ? "text-success" : "text-destructive"
                      )}>
                        {(trade.roePct || 0) >= 0 ? '+' : ''}{(trade.roePct || 0).toFixed(1)}%
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {(trade.estLev || 0).toFixed(0)}x
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Quick Actions Footer */}
      <div className="mt-5 flex items-center justify-center gap-3">
        <Button variant="outline" onClick={() => navigate('/agents')}>
          All Sessions
        </Button>
        <Button onClick={() => navigate('/agents')}>
          New Agent
        </Button>
        <Button variant="outline" onClick={() => navigate('/feed')}>
          Agent Feed
        </Button>
      </div>
    </div>
  );
}
