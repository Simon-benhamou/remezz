import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  Trophy,
  DollarSign,
  BarChart3,
  Clock,
  TrendingUp,
  TrendingDown,
  Minus,
  Loader2,
  Activity,
  Power,
  Wallet,
  KeyRound,
  CheckCircle,
  XCircle,
  Trash2,
  Eye,
  EyeOff,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/api';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
} from '@tanstack/react-table';

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
  // Observation phase
  observationStatus: string | null;
  observationInitialAsk: number | null;
  observationBestAsk: number | null;
  observationTrigger: string | null;
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

interface SymbolStatusData {
  window: WindowData | null;
  klines1m: Kline1m[];
}

interface StatusData {
  symbols: Record<string, SymbolStatusData>;
}

const ALL_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'] as const;

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
  tradedWins: number;
  tradedLosses: number;
  tradedWinRate: number;
  tradedPnl: number;
  todayTradedWins: number;
  todayTradedLosses: number;
  todayTradedWinRate: number;
  todayTradedPnl: number;
  unredeemedCount: number;
  unredeemedUsdc: number;
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
  executionPrice: number | null;
  betAmount: number | null;
  simulatedPnl: number | null;
  realPnl: number | null;
  usdcReceived: number | null;
  sellPrice: number | null;
  soldAt: string | null;
  scoreBreakdown: Record<string, number> | null;
  isCorrect: boolean | null;
  skipped: boolean;
  skipReason: string | null;
  tradeType: 'prediction' | 'virtual' | 'live';
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

      {/* Observation phase */}
      {w.observationStatus === 'observing' && w.observationInitialAsk != null && (
        <div className="flex items-center gap-2 mb-3 px-2 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <Eye className="h-3.5 w-3.5 text-amber-500 animate-pulse" />
          <span className="text-[11px] text-amber-500 font-medium">
            Observing CLOB
          </span>
          <span className="text-[10px] text-muted-foreground font-mono ml-auto">
            init: {(w.observationInitialAsk * 100).toFixed(1)}c
            {w.observationBestAsk != null && w.observationBestAsk < w.observationInitialAsk && (
              <> · best: <span className="text-success">{(w.observationBestAsk * 100).toFixed(1)}c</span></>
            )}
          </span>
        </div>
      )}
      {w.observationStatus === 'filled' && w.observationTrigger && w.observationInitialAsk != null && (
        <div className="flex items-center gap-2 mb-3 px-2 py-1.5 rounded-lg bg-success/10 border border-success/20">
          <CheckCircle className="h-3.5 w-3.5 text-success" />
          <span className="text-[11px] text-success font-medium">
            Bought ({w.observationTrigger})
          </span>
          {w.observationBestAsk != null && (
            <span className="text-[10px] text-muted-foreground font-mono ml-auto">
              {((w.observationInitialAsk - w.observationBestAsk) * 100).toFixed(1)}c saved
            </span>
          )}
        </div>
      )}

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
// HISTORY TABLE (TanStack React Table)
// ============================================================================

interface HistoryTableProps {
  predictions: PredictionRow[];
}

const SYMBOL_COLORS: Record<string, string> = {
  BTC: 'bg-amber-500/15 text-amber-500',
  ETH: 'bg-indigo-500/15 text-indigo-500',
  SOL: 'bg-purple-500/15 text-purple-500',
  XRP: 'bg-cyan-500/15 text-cyan-500',
};

function HistoryTable({ predictions }: HistoryTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [symbolFilter, setSymbolFilter] = useState<Set<string>>(new Set(ALL_SYMBOLS));
  const [resultFilter, setResultFilter] = useState<Set<string>>(new Set(['win', 'loss', 'pending']));
  const [showSkipped, setShowSkipped] = useState(false);

  const columns = useMemo<ColumnDef<PredictionRow>[]>(() => [
    {
      accessorKey: 'windowStart',
      header: 'Date',
      size: 90,
      cell: ({ getValue }) => {
        const d = new Date(getValue<string>());
        return (
          <span className="font-mono text-muted-foreground">
            {String(d.getDate()).padStart(2, '0')}/{String(d.getMonth() + 1).padStart(2, '0')}{' '}
            {String(d.getHours()).padStart(2, '0')}:{String(d.getMinutes()).padStart(2, '0')}
          </span>
        );
      },
      sortingFn: (a, b) =>
        new Date(a.original.windowStart).getTime() - new Date(b.original.windowStart).getTime(),
    },
    {
      accessorKey: 'symbol',
      header: 'Sym',
      size: 50,
      cell: ({ getValue }) => {
        const sym = getValue<string>();
        return (
          <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold', SYMBOL_COLORS[sym] ?? 'bg-muted text-muted-foreground')}>
            {sym}
          </span>
        );
      },
    },
    {
      accessorKey: 'prediction',
      header: 'Dir',
      size: 50,
      cell: ({ row }) => {
        const p = row.original;
        if (p.skipped && !p.prediction) return <span className="text-muted-foreground">{'\u2014'}</span>;
        return p.prediction === 'UP'
          ? <ArrowUp className="h-3.5 w-3.5 text-success" />
          : p.prediction === 'DOWN'
            ? <ArrowDown className="h-3.5 w-3.5 text-destructive" />
            : <span className="text-muted-foreground">{'\u2014'}</span>;
      },
    },
    {
      accessorKey: 'isCorrect',
      header: 'Result',
      size: 50,
      cell: ({ row }) => {
        const p = row.original;
        if (p.skipped && p.isCorrect === null && !p.prediction) return <span className="text-muted-foreground">{'\u2014'}</span>;
        const awaiting = p.prediction && p.isCorrect === null;
        if (awaiting) return <span className="text-yellow-500">{'\u23F3'}</span>;
        if (p.isCorrect === true) return <CheckCircle className="h-3.5 w-3.5 text-success" />;
        if (p.isCorrect === false) return <XCircle className="h-3.5 w-3.5 text-destructive" />;
        return <span className="text-muted-foreground">{'\u2014'}</span>;
      },
      sortingFn: (a, b) => {
        const v = (p: PredictionRow) => p.isCorrect === true ? 2 : p.isCorrect === false ? 1 : 0;
        return v(a.original) - v(b.original);
      },
    },
    {
      accessorKey: 'confidence',
      header: 'Score',
      size: 50,
      cell: ({ getValue }) => {
        const c = getValue<number | null>();
        return <span className="font-mono text-muted-foreground">{c != null ? c : '\u2014'}</span>;
      },
    },
    {
      id: 'clob',
      header: 'CLOB',
      size: 60,
      accessorFn: (row) => row.executionPrice ?? row.entryOdds ?? null,
      cell: ({ row }) => {
        const p = row.original;
        if (p.skipped) return <span className="font-mono text-muted-foreground">{'\u2014'}</span>;
        const isTrade = p.tradeType === 'virtual' || p.tradeType === 'live';
        if (isTrade && p.executionPrice) {
          return <span className="font-mono text-muted-foreground">{(p.executionPrice * 100).toFixed(1)}c</span>;
        }
        if (p.entryOdds != null) {
          return <span className="font-mono text-muted-foreground">{(p.entryOdds * 100).toFixed(0)}c*</span>;
        }
        return <span className="font-mono text-muted-foreground">{'\u2014'}</span>;
      },
    },
    {
      id: 'pnl',
      header: 'P&L',
      size: 70,
      accessorFn: (row) => row.realPnl ?? row.simulatedPnl ?? 0,
      cell: ({ row }) => {
        const p = row.original;
        const isTrade = p.tradeType === 'virtual' || p.tradeType === 'live';
        const pnl = p.realPnl ?? p.simulatedPnl ?? 0;
        if (!isTrade || p.skipped || pnl === 0) {
          return <span className="font-mono text-muted-foreground">{'\u2014'}</span>;
        }
        return (
          <span className={cn('font-mono font-semibold', pnl > 0 ? 'text-success' : 'text-destructive')}>
            {pnl > 0 ? '+' : ''}${pnl.toFixed(2)}
          </span>
        );
      },
      sortingFn: (a, b) => {
        const va = a.original.realPnl ?? a.original.simulatedPnl ?? 0;
        const vb = b.original.realPnl ?? b.original.simulatedPnl ?? 0;
        return va - vb;
      },
    },
    {
      accessorKey: 'tradeType',
      header: 'Mode',
      size: 70,
      cell: ({ getValue }) => {
        const t = getValue<string>();
        if (t === 'live') return <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold', 'bg-emerald-500/15 text-emerald-500')}>LIVE</span>;
        if (t === 'virtual') return <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold', 'bg-blue-500/15 text-blue-500')}>VIRTUAL</span>;
        return <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold', 'bg-muted text-muted-foreground')}>SIGNAL</span>;
      },
    },
    {
      accessorKey: 'skipReason',
      header: 'Skip',
      size: 80,
      cell: ({ row }) => {
        const p = row.original;
        if (!p.skipped || !p.skipReason) return null;
        const labels: Record<string, { label: string; color: string }> = {
          low_score: { label: 'LOW SCORE', color: 'bg-yellow-500/15 text-yellow-500' },
          no_candles: { label: 'NO DATA', color: 'bg-gray-500/15 text-gray-400' },
          against_consensus: { label: 'VS CONS.', color: 'bg-orange-500/15 text-orange-500' },
          no_consensus: { label: 'NO CONS.', color: 'bg-orange-500/15 text-orange-400' },
          market_filter: { label: 'MKT FILT', color: 'bg-purple-500/15 text-purple-500' },
          cooldown: { label: 'COOLDOWN', color: 'bg-red-500/15 text-red-400' },
          toxic_hour: { label: 'TOXIC HR', color: 'bg-red-500/15 text-red-500' },
        };
        const info = labels[p.skipReason] ?? { label: p.skipReason.toUpperCase(), color: 'bg-muted text-muted-foreground' };
        return (
          <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold', info.color)}>
            {info.label}
          </span>
        );
      },
    },
  ], []);

  // Apply custom filters
  const filteredData = useMemo(() => {
    return predictions.filter((p) => {
      // Symbol filter
      if (!symbolFilter.has(p.symbol)) return false;
      // Skipped filter
      if (p.skipped && !showSkipped) return false;
      // Result filter
      if (!p.skipped) {
        const awaiting = p.prediction && p.isCorrect === null;
        if (p.isCorrect === true && !resultFilter.has('win')) return false;
        if (p.isCorrect === false && !resultFilter.has('loss')) return false;
        if (awaiting && !resultFilter.has('pending')) return false;
      }
      return true;
    });
  }, [predictions, symbolFilter, resultFilter, showSkipped]);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 50 } },
  });

  const toggleSymbol = (sym: string) => {
    setSymbolFilter((prev) => {
      const next = new Set(prev);
      if (next.has(sym)) {
        if (next.size > 1) next.delete(sym);
      } else {
        next.add(sym);
      }
      return next;
    });
  };

  const toggleResult = (key: string) => {
    setResultFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size > 1) next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const pageIdx = table.getState().pagination.pageIndex;
  const pageCount = table.getPageCount();

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      {/* Header + Filters */}
      <div className="px-4 py-3 border-b border-border space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm font-semibold text-foreground">Prediction History</span>
            <span className="text-xs text-muted-foreground ml-2">
              ({filteredData.length} prediction{filteredData.length !== 1 ? 's' : ''})
            </span>
          </div>
          {pageCount > 1 && (
            <span className="text-[10px] text-muted-foreground font-mono">
              Page {pageIdx + 1}/{pageCount}
            </span>
          )}
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Symbol chips */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider mr-1">Sym</span>
            {ALL_SYMBOLS.map((sym) => (
              <button
                key={sym}
                onClick={() => toggleSymbol(sym)}
                className={cn(
                  'rounded px-2 py-0.5 text-[10px] font-semibold transition-colors cursor-pointer',
                  symbolFilter.has(sym)
                    ? SYMBOL_COLORS[sym] ?? 'bg-muted text-foreground'
                    : 'bg-muted/40 text-muted-foreground/50',
                )}
              >
                {sym}
              </button>
            ))}
          </div>

          {/* Separator */}
          <div className="w-px h-4 bg-border" />

          {/* Result chips */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider mr-1">Result</span>
            {[
              { key: 'win', label: 'Win', active: 'bg-success/15 text-success', inactive: 'bg-muted/40 text-muted-foreground/50' },
              { key: 'loss', label: 'Loss', active: 'bg-destructive/15 text-destructive', inactive: 'bg-muted/40 text-muted-foreground/50' },
              { key: 'pending', label: 'Pending', active: 'bg-yellow-500/15 text-yellow-500', inactive: 'bg-muted/40 text-muted-foreground/50' },
            ].map(({ key, label, active, inactive }) => (
              <button
                key={key}
                onClick={() => toggleResult(key)}
                className={cn(
                  'rounded px-2 py-0.5 text-[10px] font-semibold transition-colors cursor-pointer',
                  resultFilter.has(key) ? active : inactive,
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Separator */}
          <div className="w-px h-4 bg-border" />

          {/* Skipped toggle */}
          <button
            onClick={() => setShowSkipped((v) => !v)}
            className={cn(
              'rounded px-2 py-0.5 text-[10px] font-semibold transition-colors cursor-pointer',
              showSkipped ? 'bg-muted text-foreground' : 'bg-muted/40 text-muted-foreground/50',
            )}
          >
            Skipped
          </button>
        </div>
      </div>

      {/* Table header */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-border">
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    className={cn(
                      'px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground',
                      header.column.getCanSort() && 'cursor-pointer select-none hover:text-foreground transition-colors',
                    )}
                    style={{ width: header.getSize() }}
                  >
                    <div className="flex items-center gap-1">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getCanSort() && (
                        header.column.getIsSorted() === 'asc'
                          ? <ArrowUp className="h-3 w-3" />
                          : header.column.getIsSorted() === 'desc'
                            ? <ArrowDown className="h-3 w-3" />
                            : <ArrowUpDown className="h-3 w-3 opacity-30" />
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No predictions match filters
                </td>
              </tr>
            )}
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="border-b border-border/50 last:border-b-0 hover:bg-muted/30 transition-colors">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2 text-[11px]" style={{ width: cell.column.getSize() }}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-border">
          <span className="text-[10px] text-muted-foreground font-mono">
            {filteredData.length} prediction{filteredData.length !== 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs text-muted-foreground font-mono px-2">
              {pageIdx + 1} / {pageCount}
            </span>
            <button
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
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
  const [activeSymbol, setActiveSymbol] = useState<string>('BTC');

  // Live mode state
  const [pmMode, setPmMode] = useState<'virtual' | 'live'>('virtual');
  const [pmAmount, setPmAmount] = useState(5);
  const [pmHedge, setPmHedge] = useState(1);
  const [pmHasCreds, setPmHasCreds] = useState(false);
  const [pmAddress, setPmAddress] = useState<string | null>(null);
  const [pmBalance, setPmBalance] = useState<number | null>(null);
  const [togglingMode, setTogglingMode] = useState(false);

  // Wallet credentials form
  const [showWalletForm, setShowWalletForm] = useState(false);
  const [privateKeyInput, setPrivateKeyInput] = useState('');
  const [proxyAddressInput, setProxyAddressInput] = useState('');
  const [showPk, setShowPk] = useState(false);
  const [savingCreds, setSavingCreds] = useState(false);
  const [credsError, setCredsError] = useState<string | null>(null);
  const [deletingCreds, setDeletingCreds] = useState(false);
  const [resetting, setResetting] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, statsRes, historyRes, settingsRes] = await Promise.all([
        api.polymarket.getStatus().catch(() => null),
        api.polymarket.getStats().catch(() => null),
        api.polymarket.getHistory(5000).catch(() => null),
        api.polymarket.getSettings().catch(() => null),
      ]);
      if (statusRes) setStatus(statusRes);
      if (statsRes) setStats(statsRes);
      if (historyRes) setHistory(historyRes);
      if (settingsRes) {
        setPmMode(settingsRes.mode);
        setPmAmount(settingsRes.amount);
        setPmHedge(settingsRes.hedgeAmount ?? 1);
        setPmHasCreds(settingsRes.hasCredentials);
        if (!settingsRes.hasCredentials) setPmAddress(null);
      }
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

  // Validate credentials on load to get the wallet address
  useEffect(() => {
    if (!pmHasCreds || pmAddress) return;
    api.polymarket.validateCredentials()
      .then((r) => { if (r.valid && r.address) setPmAddress(r.address); })
      .catch(() => {});
  }, [pmHasCreds, pmAddress]);

  const handleSaveCredentials = async () => {
    const key = privateKeyInput.trim();
    if (!key) { setCredsError('Clé privée requise'); return; }
    setSavingCreds(true);
    setCredsError(null);
    try {
      const proxy = proxyAddressInput.trim() || undefined;
      const res = await api.polymarket.saveCredentials(key, proxy);
      if (res.address) setPmAddress(res.address);
      setPmHasCreds(true);
      setPrivateKeyInput('');
      setShowWalletForm(false);
    } catch (err: any) {
      setCredsError(err?.response?.data?.error ?? err?.message ?? 'Erreur inconnue');
    } finally {
      setSavingCreds(false);
    }
  };

  const handleDeleteCredentials = async () => {
    setDeletingCreds(true);
    try {
      await api.polymarket.deleteCredentials();
      setPmHasCreds(false);
      setPmAddress(null);
      setPmMode('virtual');
      setShowWalletForm(false);
    } catch { /* ignore */ }
    setDeletingCreds(false);
  };

  // Fetch balance when live mode is active (once + every 60s)
  useEffect(() => {
    if (pmMode !== 'live' || !pmHasCreds) {
      setPmBalance(null);
      return;
    }
    const fetchBal = () => {
      api.polymarket.getBalance().then((r) => setPmBalance(r.balance)).catch(() => {});
    };
    fetchBal();
    const iv = setInterval(fetchBal, 60_000);
    return () => clearInterval(iv);
  }, [pmMode, pmHasCreds]);

  const handleReset = async () => {
    if (!confirm('Reset toutes les prédictions ? Cette action est irréversible.')) return;
    setResetting(true);
    try {
      await api.polymarket.resetHistory();
      await fetchAll();
    } catch { /* ignore */ }
    setResetting(false);
  };

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
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-foreground">Predictions</h1>
          <button
            onClick={handleReset}
            disabled={resetting || (stats?.totalWindows ?? 0) === 0}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold',
              'bg-muted text-muted-foreground border border-border',
              'hover:bg-destructive/15 hover:text-destructive hover:border-destructive/30 transition-colors cursor-pointer',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-muted disabled:hover:text-muted-foreground disabled:hover:border-border',
            )}
          >
            <RotateCcw className={cn('h-3 w-3', resetting && 'animate-spin')} />
            {resetting ? 'Reset...' : 'Reset'}
          </button>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          5-minute price direction predictions (Polymarket multi-symbol)
        </p>
      </div>

      {/* Symbol tabs */}
      <div className="flex items-center gap-1">
        {ALL_SYMBOLS.map((sym) => (
          <button
            key={sym}
            onClick={() => setActiveSymbol(sym)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer',
              activeSymbol === sym
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80',
            )}
          >
            {sym}
          </button>
        ))}
      </div>

      {/* Mode + Wallet — side by side */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Trading Mode Card */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-3">
            <Power className="h-4 w-4" />
            <span className="text-xs uppercase tracking-wider">Mode Trading</span>
          </div>

          <div className="flex items-center justify-between mb-3">
            <span className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold',
              pmMode === 'live'
                ? 'bg-emerald-500/15 text-emerald-500 border border-emerald-500/30'
                : 'bg-muted text-muted-foreground border border-border',
            )}>
              <Activity className="h-3 w-3" />
              {pmMode === 'live' ? `LIVE — $${pmAmount}+$${pmHedge}` : 'VIRTUAL'}
            </span>

            {pmMode === 'live' ? (
              <button
                onClick={async () => {
                  setTogglingMode(true);
                  try {
                    await api.polymarket.saveSettings('virtual', pmAmount, pmHedge);
                    setPmMode('virtual');
                  } catch { /* ignore */ }
                  setTogglingMode(false);
                }}
                disabled={togglingMode}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold',
                  'bg-destructive/15 text-destructive border border-destructive/30',
                  'hover:bg-destructive/25 transition-colors cursor-pointer',
                )}
              >
                <Power className="h-3 w-3" />
                {togglingMode ? 'Stopping...' : 'Stop Live'}
              </button>
            ) : pmHasCreds ? (
              <button
                onClick={async () => {
                  setTogglingMode(true);
                  try {
                    await api.polymarket.saveSettings('live', pmAmount, pmHedge);
                    setPmMode('live');
                  } catch { /* ignore */ }
                  setTogglingMode(false);
                }}
                disabled={togglingMode}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold',
                  'bg-emerald-500/15 text-emerald-500 border border-emerald-500/30',
                  'hover:bg-emerald-500/25 transition-colors cursor-pointer',
                )}
              >
                <Power className="h-3 w-3" />
                {togglingMode ? 'Starting...' : 'Go Live'}
              </button>
            ) : (
              <span className="text-[10px] text-muted-foreground">Connecter wallet pour live</span>
            )}
          </div>

          {/* Amount inputs */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <label className="text-xs text-muted-foreground whitespace-nowrap">Early Bird:</label>
              <span className="text-xs text-muted-foreground">$</span>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={pmAmount}
                onChange={(e) => setPmAmount(Math.max(1, parseInt(e.target.value) || 1))}
                onBlur={async () => {
                  try { await api.polymarket.saveSettings(pmMode, pmAmount, pmHedge); } catch { /* ignore */ }
                }}
                className="w-14 rounded border border-border bg-background px-2 py-1 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="flex items-center gap-1">
              <label className="text-xs text-muted-foreground whitespace-nowrap">Hedge:</label>
              <span className="text-xs text-muted-foreground">$</span>
              <input
                type="number"
                min={0}
                max={50}
                step={0.5}
                value={pmHedge}
                onChange={(e) => setPmHedge(Math.max(0, parseFloat(e.target.value) || 0))}
                onBlur={async () => {
                  try { await api.polymarket.saveSettings(pmMode, pmAmount, pmHedge); } catch { /* ignore */ }
                }}
                className="w-14 rounded border border-border bg-background px-2 py-1 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {/* Balance when live */}
          {pmMode === 'live' && pmBalance !== null && (
            <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-border">
              <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Balance:</span>
              <span className="text-sm font-mono font-semibold text-foreground">${pmBalance.toFixed(2)}</span>
            </div>
          )}
        </div>

        {/* Wallet Connection Card */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-3">
            <KeyRound className="h-4 w-4" />
            <span className="text-xs uppercase tracking-wider">Wallet Polymarket</span>
          </div>

          {pmHasCreds ? (
            <div className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-success" />
              <span className="text-xs font-mono text-muted-foreground truncate max-w-[180px]" title={pmAddress ?? ''}>
                {pmAddress ? `${pmAddress.slice(0, 6)}…${pmAddress.slice(-4)}` : 'Connecté'}
              </span>
              <button
                onClick={handleDeleteCredentials}
                disabled={deletingCreds}
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold bg-destructive/15 text-destructive border border-destructive/30 hover:bg-destructive/25 transition-colors cursor-pointer ml-auto"
              >
                <Trash2 className="h-3 w-3" />
                {deletingCreds ? '...' : 'Déconnecter'}
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={() => { setShowWalletForm((v) => !v); setCredsError(null); }}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-colors cursor-pointer"
              >
                <XCircle className="h-3 w-3" />
                Non connecté — Connecter
              </button>

              {/* Private key form */}
              {showWalletForm && (
                <div className="mt-4 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Compte <span className="font-semibold text-foreground">Magic.link/Google</span> : entre la clé privée exportée + l'adresse proxy affichée sur Polymarket.
                    Compte <span className="font-semibold text-foreground">MetaMask direct</span> : clé privée seulement.
                  </p>
                  {/* Private key */}
                  <div className="relative">
                    <input
                      type={showPk ? 'text' : 'password'}
                      value={privateKeyInput}
                      onChange={(e) => setPrivateKeyInput(e.target.value)}
                      placeholder="Clé privée (0x... 64 hex chars)"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary pr-8"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPk((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {showPk ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    </button>
                  </div>
                  {/* Proxy address (Magic.link only) */}
                  <input
                    type="text"
                    value={proxyAddressInput}
                    onChange={(e) => setProxyAddressInput(e.target.value)}
                    placeholder="Adresse proxy Polymarket (0x... — Magic.link seulement)"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <button
                    onClick={handleSaveCredentials}
                    disabled={savingCreds || !privateKeyInput.trim()}
                    className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                  >
                    {savingCreds ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
                    {savingCreds ? 'Connexion...' : 'Connecter'}
                  </button>
                  {credsError && (
                    <p className="text-xs text-destructive">{credsError}</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* KPI Cards — always use traded stats (virtual+live both have CLOB execution) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          icon={Trophy}
          label={pmMode === 'live' ? 'Live WR (today)' : 'Virtual WR (today)'}
          value={`${(stats?.todayTradedWinRate ?? 0).toFixed(1)}%`}
          sub={`${stats?.todayTradedWins ?? 0}W / ${stats?.todayTradedLosses ?? 0}L (CLOB-priced)`}
          color={(stats?.todayTradedWinRate ?? 0) >= 50 ? 'success' : (stats?.todayTradedWinRate ?? 0) > 0 ? 'destructive' : 'default'}
        />
        <KpiCard
          icon={DollarSign}
          label={pmMode === 'live' ? 'Real P&L (today)' : 'Virtual P&L (today)'}
          value={`${(stats?.todayTradedPnl ?? 0) >= 0 ? '+' : ''}$${(stats?.todayTradedPnl ?? 0).toFixed(2)}`}
          sub={`Cumul: ${(stats?.tradedPnl ?? 0) >= 0 ? '+' : ''}$${(stats?.tradedPnl ?? 0).toFixed(2)}`}
          color={(stats?.todayTradedPnl ?? 0) >= 0 ? 'success' : 'destructive'}
        />
        <KpiCard
          icon={BarChart3}
          label="Predictions / Windows"
          value={`${todayPredictions} / ${todayWindows}`}
          sub={`Total: ${stats?.totalPredictions ?? 0} preds / ${stats?.totalWindows ?? 0} win`}
          color="primary"
        />
        {(stats?.unredeemedCount ?? 0) > 0 && (
          <KpiCard
            icon={Wallet}
            label="Stuck Tokens"
            value={`${stats?.unredeemedCount ?? 0}`}
            sub={`~$${(stats?.unredeemedUsdc ?? 0).toFixed(2)} USDC pending`}
            color="destructive"
          />
        )}
      </div>

      {/* Live Window + Mini Chart (for active symbol) */}
      {(() => {
        const symData = status?.symbols?.[activeSymbol];
        const symWindow = symData?.window ?? null;
        const symKlines = symData?.klines1m ?? [];
        return (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {symWindow ? (
              <WindowProgress window={symWindow} />
            ) : (
              <div className="rounded-2xl border border-border bg-card p-4 flex items-center justify-center text-sm text-muted-foreground min-h-[140px]">
                <Clock className="h-4 w-4 mr-2" />
                [{activeSymbol}] Waiting for next window...
              </div>
            )}

            {symKlines.length > 0 ? (
              <MiniChart klines={symKlines} startPrice={symWindow?.startPrice} />
            ) : (
              <div className="rounded-2xl border border-border bg-card p-4 flex items-center justify-center text-sm text-muted-foreground min-h-[140px]">
                <BarChart3 className="h-4 w-4 mr-2" />
                [{activeSymbol}] No candle data
              </div>
            )}
          </div>
        );
      })()}

      {/* History Table — filterable with TanStack React Table */}
      <HistoryTable predictions={history?.predictions ?? []} />
    </div>
  );
}
