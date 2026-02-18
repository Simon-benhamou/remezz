import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Trophy,
  DollarSign,
  BarChart3,
  Clock,
  TrendingUp,
  TrendingDown,
  Minus,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/api';

// ============================================================================
// TYPES
// ============================================================================

interface WindowData {
  windowStart: number;
  windowEnd: number;
  startPrice: number;
  currentPrice: number;
  elapsed: number;
  prediction: {
    direction: string;
    confidence: number;
    score: Record<string, number>;
    microRocPct: number;
  } | null;
  entryOdds: number | null;
  status: string;
}

interface Kline1m {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isFinal: boolean;
}

interface StatusData {
  window: WindowData | null;
  klines1m: Kline1m[];
}

interface StatsData {
  totalWindows: number;
  totalPredictions: number;
  wins: number;
  losses: number;
  skips: number;
  winRate: number;
  cumulativePnl: number;
  todayWindows: number;
  todayPredictions: number;
  todayWins: number;
  todayLosses: number;
  todayWinRate: number;
  todayPnl: number;
}

interface PredictionRow {
  id: number;
  createdAt: string;
  symbol: string;
  windowStart: string;
  windowEnd: string;
  startPrice: number;
  endPrice: number | null;
  prediction: string | null;
  confidence: number | null;
  actualResult: string | null;
  entryOdds: number | null;
  simulatedPnl: number | null;
  scoreBreakdown: Record<string, number> | null;
  isCorrect: boolean | null;
  skipped: boolean;
}

interface HistoryData {
  predictions: PredictionRow[];
}

// ============================================================================
// KPI CARD
// ============================================================================

interface KpiCardProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  color?: 'default' | 'success' | 'destructive' | 'primary';
}

function KpiCard({ icon: Icon, label, value, sub, color = 'default' }: KpiCardProps) {
  const colorClasses: Record<string, string> = {
    default: 'text-foreground',
    success: 'text-success',
    destructive: 'text-destructive',
    primary: 'text-primary',
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground mb-2">
        <Icon className="h-4 w-4" />
        <span className="text-xs uppercase tracking-wider">{label}</span>
      </div>
      <div className={cn('text-2xl font-bold font-mono', colorClasses[color])}>
        {value}
      </div>
      {sub && (
        <div className="text-xs text-muted-foreground mt-1">{sub}</div>
      )}
    </div>
  );
}

// ============================================================================
// WINDOW PROGRESS
// ============================================================================

interface WindowProgressProps {
  window: WindowData;
}

function WindowProgress({ window: w }: WindowProgressProps) {
  const totalMs = w.windowEnd - w.windowStart;
  const elapsedMs = w.elapsed;
  const pct = totalMs > 0 ? Math.min(100, (elapsedMs / totalMs) * 100) : 0;
  const remainingSec = Math.max(0, Math.round((totalMs - elapsedMs) / 1000));
  const elapsedSec = Math.round(elapsedMs / 1000);

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const dirIcon = w.prediction?.direction === 'UP'
    ? <TrendingUp className="h-4 w-4 text-success" />
    : w.prediction?.direction === 'DOWN'
      ? <TrendingDown className="h-4 w-4 text-destructive" />
      : <Minus className="h-4 w-4 text-muted-foreground" />;

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs uppercase tracking-wider text-muted-foreground">Live Window</span>
        </div>
        <span className={cn(
          'inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold w-fit',
          w.status === 'active' ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground',
        )}>
          {w.status.toUpperCase()}
        </span>
      </div>

      {/* Prediction */}
      <div className="flex items-center gap-2 mb-3">
        {dirIcon}
        <span className="font-semibold text-sm">
          {w.prediction ? `${w.prediction.direction}` : 'No prediction'}
        </span>
        {w.prediction && (
          <span className="text-xs text-muted-foreground font-mono">
            ({(w.prediction.confidence * 100).toFixed(0)}%)
          </span>
        )}
        {w.entryOdds != null && (
          <span className="text-xs text-muted-foreground font-mono ml-auto">
            Odds: {(w.entryOdds * 100).toFixed(0)}c
          </span>
        )}
      </div>

      {/* Price */}
      <div className="flex items-center justify-between text-xs mb-3">
        <span className="text-muted-foreground">
          Start: <span className="font-mono text-foreground">${w.startPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        </span>
        <span className="text-muted-foreground">
          Now: <span className="font-mono text-foreground">${w.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-2 rounded-full bg-muted overflow-hidden mb-2">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            pct > 80 ? 'bg-destructive' : 'bg-primary',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono">
        <span>{formatTime(elapsedSec)}</span>
        <span>-{formatTime(remainingSec)}</span>
      </div>
    </div>
  );
}

// ============================================================================
// MINI CHART (Lightweight Charts)
// ============================================================================

interface MiniChartProps {
  klines: Kline1m[];
  startPrice?: number;
}

function MiniChart({ klines, startPrice }: MiniChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);
  const lineRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current || klines.length === 0) return;

    let disposed = false;

    import('lightweight-charts').then((lc) => {
      if (disposed || !containerRef.current) return;

      // Dispose previous chart if exists
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
        seriesRef.current = null;
        lineRef.current = null;
      }

      const chart = lc.createChart(containerRef.current!, {
        width: containerRef.current!.clientWidth,
        height: 180,
        layout: {
          background: { type: lc.ColorType.Solid, color: 'transparent' },
          textColor: '#94a3b8',
          fontSize: 10,
        },
        grid: {
          vertLines: { color: 'rgba(51, 65, 85, 0.3)' },
          horzLines: { color: 'rgba(51, 65, 85, 0.3)' },
        },
        rightPriceScale: {
          borderVisible: false,
        },
        timeScale: {
          borderVisible: false,
          timeVisible: true,
          secondsVisible: false,
        },
        crosshair: {
          horzLine: { visible: false },
          vertLine: { visible: false },
        },
      });

      const candleSeries = chart.addCandlestickSeries({
        upColor: '#22c55e',
        downColor: '#ef4444',
        borderUpColor: '#22c55e',
        borderDownColor: '#ef4444',
        wickUpColor: '#22c55e',
        wickDownColor: '#ef4444',
      });

      const data = klines.map((k) => ({
        time: (k.timestamp / 1000) as any,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      }));

      candleSeries.setData(data);

      // Add start price line
      if (startPrice != null) {
        candleSeries.createPriceLine({
          price: startPrice,
          color: '#60a5fa',
          lineWidth: 1,
          lineStyle: lc.LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'Start',
        });
      }

      chart.timeScale().fitContent();

      chartRef.current = chart;
      seriesRef.current = candleSeries;

      // Resize observer
      const ro = new ResizeObserver(() => {
        if (containerRef.current && chartRef.current) {
          chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
        }
      });
      ro.observe(containerRef.current!);

      // Cleanup resize observer on dispose
      const currentContainer = containerRef.current;
      return () => {
        ro.unobserve(currentContainer!);
      };
    });

    return () => {
      disposed = true;
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
        seriesRef.current = null;
        lineRef.current = null;
      }
    };
  }, [klines, startPrice]);

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground mb-3">
        <BarChart3 className="h-4 w-4" />
        <span className="text-xs uppercase tracking-wider">1m Candles</span>
        <span className="text-[10px] text-muted-foreground ml-auto font-mono">{klines.length} candles</span>
      </div>
      <div ref={containerRef} className="w-full" style={{ height: 180 }} />
    </div>
  );
}

// ============================================================================
// HISTORY TABLE
// ============================================================================

interface HistoryTableProps {
  predictions: PredictionRow[];
}

function HistoryTable({ predictions }: HistoryTableProps) {
  const gridCols = 'grid-cols-[100px_55px_55px_50px_55px_70px_100px]';

  const formatWindowTime = (ts: string) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <span className="text-sm font-semibold text-foreground">Prediction History</span>
        <span className="text-xs text-muted-foreground ml-2">({predictions.length})</span>
      </div>

      {/* Header */}
      <div className={cn('grid gap-2 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border', gridCols)}>
        <span>Window</span>
        <span>Pred</span>
        <span>Real</span>
        <span>Score</span>
        <span>Odds</span>
        <span>P&L</span>
        <span>Price</span>
      </div>

      {/* Rows */}
      <div className="max-h-[400px] overflow-y-auto">
        {predictions.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No predictions yet
          </div>
        )}
        {predictions.map((p) => {
          const isSkipped = p.skipped;
          const correct = p.isCorrect;
          const scoreIcon = isSkipped ? '\u2014' : correct === true ? '\u2713' : correct === false ? '\u2717' : '\u2014';
          const scoreColor = isSkipped ? 'text-muted-foreground' : correct === true ? 'text-success' : correct === false ? 'text-destructive' : 'text-muted-foreground';
          const pnl = p.simulatedPnl ?? 0;

          return (
            <div
              key={p.id}
              className={cn(
                'grid gap-2 px-4 py-2 text-[11px] items-center hover:bg-muted/30 transition-colors border-b border-border/50 last:border-b-0',
                gridCols,
              )}
            >
              {/* Window */}
              <span className="font-mono text-muted-foreground">
                {formatWindowTime(p.windowStart)}
              </span>

              {/* Pred */}
              <span className={cn(
                'font-mono font-semibold',
                isSkipped ? 'text-muted-foreground' : p.prediction === 'UP' ? 'text-success' : p.prediction === 'DOWN' ? 'text-destructive' : 'text-muted-foreground',
              )}>
                {isSkipped ? '\u2014' : p.prediction ?? '\u2014'}
              </span>

              {/* Real */}
              <span className={cn(
                'font-mono font-semibold',
                isSkipped ? 'text-muted-foreground' : p.actualResult === 'UP' ? 'text-success' : p.actualResult === 'DOWN' ? 'text-destructive' : 'text-muted-foreground',
              )}>
                {isSkipped ? '\u2014' : p.actualResult ?? '\u2014'}
              </span>

              {/* Score */}
              <span className={cn('font-bold', scoreColor)}>
                {scoreIcon}
              </span>

              {/* Odds */}
              <span className="font-mono text-muted-foreground">
                {isSkipped ? '\u2014' : p.entryOdds != null ? `${(p.entryOdds * 100).toFixed(0)}c` : '\u2014'}
              </span>

              {/* P&L */}
              <span className={cn(
                'font-mono font-semibold',
                isSkipped ? 'text-muted-foreground' : pnl > 0 ? 'text-success' : pnl < 0 ? 'text-destructive' : 'text-muted-foreground',
              )}>
                {isSkipped ? '\u2014' : pnl !== 0 ? `${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}` : '\u2014'}
              </span>

              {/* Price */}
              <span className="font-mono text-muted-foreground text-[10px]">
                {p.startPrice ? `$${p.startPrice.toLocaleString()}` : '\u2014'}
                {p.endPrice != null ? ` \u2192 $${p.endPrice.toLocaleString()}` : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// MAIN PAGE
// ============================================================================

export default function PolymarketPage() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, statsRes, historyRes] = await Promise.all([
        api.polymarket.getStatus().catch(() => null),
        api.polymarket.getStats().catch(() => null),
        api.polymarket.getHistory(50).catch(() => null),
      ]);
      if (statusRes) setStatus(statusRes);
      if (statsRes) setStats(statsRes);
      if (historyRes) setHistory(historyRes);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + polling every 3s
  useEffect(() => {
    void fetchAll();
    const iv = setInterval(() => void fetchAll(), 3000);
    return () => clearInterval(iv);
  }, [fetchAll]);

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mr-2" />
        Loading predictions...
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="flex items-center justify-center h-64 text-destructive">
        {error}
      </div>
    );
  }

  const todayWinRate = stats?.todayWinRate ?? 0;
  const todayPnl = stats?.todayPnl ?? 0;
  const todayPredictions = stats?.todayPredictions ?? 0;
  const todayWindows = stats?.todayWindows ?? 0;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-bold text-foreground">Predictions</h1>
        <p className="text-sm text-muted-foreground mt-1">
          5-minute BTC price direction predictions (Polymarket experiment)
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard
          icon={Trophy}
          label="Win Rate (today)"
          value={`${(todayWinRate * 100).toFixed(1)}%`}
          sub={`${stats?.todayWins ?? 0}W / ${stats?.todayLosses ?? 0}L`}
          color={todayWinRate >= 0.5 ? 'success' : todayWinRate > 0 ? 'destructive' : 'default'}
        />
        <KpiCard
          icon={DollarSign}
          label="Simulated P&L (today)"
          value={`${todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(2)}`}
          sub={`Cumulative: ${(stats?.cumulativePnl ?? 0) >= 0 ? '+' : ''}${(stats?.cumulativePnl ?? 0).toFixed(2)}`}
          color={todayPnl >= 0 ? 'success' : 'destructive'}
        />
        <KpiCard
          icon={BarChart3}
          label="Predictions / Windows"
          value={`${todayPredictions} / ${todayWindows}`}
          sub={`Total: ${stats?.totalPredictions ?? 0} preds / ${stats?.totalWindows ?? 0} windows`}
          color="primary"
        />
      </div>

      {/* Live Window + Mini Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {status?.window ? (
          <WindowProgress window={status.window} />
        ) : (
          <div className="rounded-2xl border border-border bg-card p-4 flex items-center justify-center text-sm text-muted-foreground min-h-[140px]">
            <Clock className="h-4 w-4 mr-2" />
            Waiting for next window...
          </div>
        )}

        {status?.klines1m && status.klines1m.length > 0 ? (
          <MiniChart klines={status.klines1m} startPrice={status.window?.startPrice} />
        ) : (
          <div className="rounded-2xl border border-border bg-card p-4 flex items-center justify-center text-sm text-muted-foreground min-h-[140px]">
            <BarChart3 className="h-4 w-4 mr-2" />
            No candle data
          </div>
        )}
      </div>

      {/* History Table */}
      <HistoryTable predictions={history?.predictions ?? []} />
    </div>
  );
}
