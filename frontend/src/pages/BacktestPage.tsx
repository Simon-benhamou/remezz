import React, { useEffect, useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ArrowUpRight,
  ArrowDownRight,
  LineChart,
  Zap,
  AlertTriangle,
  Filter,
  RefreshCw,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
} from 'lucide-react';
import dayjs from 'dayjs';
import { api } from '../api';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Alert, AlertDescription } from '@/components/ui/alert';

// ============================================================================
// TYPES
// ============================================================================

interface BacktestTrade {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  holdMinutes: number;
  grossPnlPct: number;
  netPnlPct: number;
  netPnlUsd: number;
  feesUsd: number;
  exitReason: string;
  capitalBefore: number;
  capitalAfter: number;
  month: string;
  day: string;
  wasCapped: boolean;
  slippagePct: number;
}

interface MonthlyStats {
  month: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnlUsd: number;
  pnlPct: number;
  longTrades: number;
  shortTrades: number;
  avgTradeUsd: number;
  maxWinUsd: number;
  maxLossUsd: number;
  capitalStart: number;
  capitalEnd: number;
}

interface BacktestResult {
  runId?: string;
  cachedAt?: string;
  cacheHit?: boolean;
  params: {
    startDate: string;
    endDate: string;
    initialCapital: number;
    symbols: string[];
    leverage: number;
  };
  summary: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnlUsd: number;
    totalPnlPct: number;
    maxDrawdownPct: number;
    avgTradeUsd: number;
    avgWinUsd: number;
    avgLossUsd: number;
    profitFactor: number;
    sharpeRatio: number;
    finalCapital: number;
    longTrades: number;
    shortTrades: number;
    avgHoldMinutes: number;
    totalFeesUsd: number;
  };
  trades: BacktestTrade[];
  monthlyStats: MonthlyStats[];
  equityCurve: { date: string; equity: number }[];
  drawdownCurve: { date: string; drawdown: number }[];
}

type BacktestRunListItem = {
  id: string;
  createdAt: string;
  params: BacktestResult['params'];
  summary: BacktestResult['summary'];
};

// ============================================================================
// FORM SCHEMA
// ============================================================================

const backtestSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  initialCapital: z.number().min(100).max(1000000),
  leverage: z.number(),
  symbols: z.array(z.string()).min(1),
});

type BacktestFormValues = z.infer<typeof backtestSchema>;

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

const formatCurrency = (value: number | null | undefined) => {
  if (value == null) return '$0.00';
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatPercent = (value: number | null | undefined) => {
  if (value == null) return '0.00%';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
};

const SideTag: React.FC<{ side: 'long' | 'short' }> = ({ side }) => (
  <span className={cn(
    "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-semibold",
    side === 'long' ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
  )}>
    {side === 'long' ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
    {side.toUpperCase()}
  </span>
);

const ExitReasonTag: React.FC<{ reason: string }> = ({ reason }) => {
  const colorMap: Record<string, string> = {
    'SL': 'bg-destructive/15 text-destructive',
    'TP': 'bg-success/15 text-success',
    'TRAIL': 'bg-primary/15 text-primary',
    'TIME': 'bg-warning/15 text-warning',
    'END': 'bg-muted text-muted-foreground',
  };
  return <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", colorMap[reason] || "bg-muted text-muted-foreground")}>{reason}</span>;
};

const PnlText: React.FC<{ value: number; showCurrency?: boolean }> = ({ value, showCurrency = true }) => (
  <span className={cn("font-semibold", value >= 0 ? "text-success" : "text-destructive")}>
    {showCurrency ? formatCurrency(value) : formatPercent(value)}
  </span>
);

// ============================================================================
// CHART COMPONENTS (Simple SVG)
// ============================================================================

const MiniEquityChart: React.FC<{ data: { date: string; equity: number }[] }> = ({ data }) => {
  if (!data || data.length < 2) return null;

  const width = 600;
  const height = 200;
  const padding = { top: 20, right: 20, bottom: 30, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const values = data.map(d => d.equity);
  const minVal = Math.min(...values) * 0.95;
  const maxVal = Math.max(...values) * 1.05;

  const xScale = (i: number) => padding.left + (i / (data.length - 1)) * chartWidth;
  const yScale = (val: number) => padding.top + (1 - (val - minVal) / (maxVal - minVal)) * chartHeight;

  const pathD = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.equity)}`).join(' ');
  const areaD = pathD + ` L ${xScale(data.length - 1)} ${height - padding.bottom} L ${padding.left} ${height - padding.bottom} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', borderRadius: 8 }}>
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map((pct, i) => (
        <g key={i}>
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={padding.top + pct * chartHeight}
            y2={padding.top + pct * chartHeight}
            stroke="rgba(148,163,184,0.2)"
            strokeDasharray="3,3"
          />
          <text
            x={padding.left - 5}
            y={padding.top + pct * chartHeight + 4}
            fill="#94a3b8"
            fontSize={10}
            textAnchor="end"
          >
            ${((maxVal - minVal) * (1 - pct) + minVal).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </text>
        </g>
      ))}

      {/* Area fill */}
      <defs>
        <linearGradient id="equityGradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#10b981" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaD} fill="url(#equityGradient)" />

      {/* Line */}
      <path d={pathD} fill="none" stroke="#10b981" strokeWidth={2.5} />

      {/* Final value dot */}
      <circle
        cx={xScale(data.length - 1)}
        cy={yScale(data[data.length - 1].equity)}
        r={4}
        fill="#10b981"
      />
    </svg>
  );
};

const MiniDrawdownChart: React.FC<{ data: { date: string; drawdown: number }[] }> = ({ data }) => {
  if (!data || data.length < 2) return null;

  const width = 600;
  const height = 150;
  const padding = { top: 10, right: 20, bottom: 30, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxDD = Math.max(...data.map(d => d.drawdown), 5);

  const xScale = (i: number) => padding.left + (i / (data.length - 1)) * chartWidth;
  const yScale = (val: number) => padding.top + (val / maxDD) * chartHeight;

  const pathD = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.drawdown)}`).join(' ');
  const areaD = `M ${padding.left} ${padding.top} ` + pathD.substring(2) + ` L ${xScale(data.length - 1)} ${padding.top} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', borderRadius: 8 }}>
      {/* Area fill */}
      <defs>
        <linearGradient id="ddGradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#ef4444" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#ef4444" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaD} fill="url(#ddGradient)" />

      {/* Line */}
      <path d={pathD} fill="none" stroke="#ef4444" strokeWidth={2.5} />

      {/* Max DD line */}
      <line
        x1={padding.left}
        x2={width - padding.right}
        y1={yScale(maxDD)}
        y2={yScale(maxDD)}
        stroke="#ef4444"
        strokeDasharray="5,5"
        opacity={0.6}
      />
      <text
        x={width - padding.right}
        y={yScale(maxDD) - 5}
        fill="#f87171"
        fontSize={10}
        textAnchor="end"
      >
        Max DD: {maxDD.toFixed(1)}%
      </text>
    </svg>
  );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function BacktestPage() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runs, setRuns] = useState<BacktestRunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | 'all'>('all');
  const [selectedSymbol, setSelectedSymbol] = useState<string | 'all'>('all');
  const [selectedSide, setSelectedSide] = useState<'all' | 'long' | 'short'>('all');
  const [tradePage, setTradePage] = useState(1);
  const [tradePageSize, setTradePageSize] = useState(50);
  const [tradeSortField, setTradeSortField] = useState<'netPnlUsd' | null>(null);
  const [tradeSortDir, setTradeSortDir] = useState<'asc' | 'desc'>('desc');
  const [monthlySortField, setMonthlySortField] = useState<'pnlUsd' | null>(null);
  const [monthlySortDir, setMonthlySortDir] = useState<'asc' | 'desc'>('desc');

  // V5.93: Combined backtest winners (Jan-Dec 2025, $2000, 4.5x) -> +1308% ROI
  const defaultSymbols = ['AVAX/USDT:USDT', 'FET/USDT:USDT', 'WIF/USDT:USDT', 'DOT/USDT:USDT', 'TIA/USDT:USDT', 'IMX/USDT:USDT', 'STX/USDT:USDT', 'DOGE/USDT:USDT', 'ADA/USDT:USDT', 'BTC/USDT:USDT'];
  const symbolOptions = [
    // TOP 10 -- combined backtest winners
    { value: 'AVAX/USDT:USDT', label: 'AVAX/USDT (+$4,850)' },
    { value: 'FET/USDT:USDT', label: 'FET/USDT (+$4,558)' },
    { value: 'WIF/USDT:USDT', label: 'WIF/USDT (+$3,686)' },
    { value: 'DOT/USDT:USDT', label: 'DOT/USDT (+$3,630)' },
    { value: 'TIA/USDT:USDT', label: 'TIA/USDT (+$3,087)' },
    { value: 'IMX/USDT:USDT', label: 'IMX/USDT (+$2,552)' },
    { value: 'STX/USDT:USDT', label: 'STX/USDT (+$1,761)' },
    { value: 'DOGE/USDT:USDT', label: 'DOGE/USDT (+$1,617)' },
    { value: 'ADA/USDT:USDT', label: 'ADA/USDT (+$1,241)' },
    { value: 'BTC/USDT:USDT', label: 'BTC/USDT (+$339)' },
    // OK -- available but not defaults
    { value: 'RENDER/USDT:USDT', label: 'RENDER/USDT (+15%)' },
    { value: 'SOL/USDT:USDT', label: 'SOL/USDT (+25%)' },
    { value: 'XRP/USDT:USDT', label: 'XRP/USDT (+12%)' },
    { value: 'NEAR/USDT:USDT', label: 'NEAR/USDT (+19%)' },
    { value: 'LINK/USDT:USDT', label: 'LINK/USDT (+7%)' },
  ];

  const form = useForm<BacktestFormValues>({
    resolver: zodResolver(backtestSchema as any),
    defaultValues: {
      startDate: '2024-01-01',
      endDate: '2025-12-26',
      initialCapital: 2000,
      leverage: 4.5,
      symbols: defaultSymbols,
    },
  });

  const watchSymbols = form.watch('symbols');

  const toggleSymbol = (value: string) => {
    const current = form.getValues('symbols');
    if (current.includes(value)) {
      if (current.length > 1) {
        form.setValue('symbols', current.filter(s => s !== value));
      }
    } else {
      form.setValue('symbols', [...current, value]);
    }
  };

  const refreshRuns = async () => {
    setRunsLoading(true);
    try {
      const data = await api.backtest.listRuns(20);
      setRuns(data.runs);
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Failed to load backtest history');
    } finally {
      setRunsLoading(false);
    }
  };

  useEffect(() => {
    void refreshRuns();
  }, []);

  const handleLoadRun = async (id: string) => {
    setLoading(true);
    try {
      const data = await api.backtest.getRun(id);
      setResult(data);
      setSelectedRunId(id);
      toast.success('Loaded cached backtest');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Failed to load cached backtest');
    } finally {
      setLoading(false);
    }
  };

  const handleClearRuns = async () => {
    setRunsLoading(true);
    try {
      await api.backtest.clearRuns();
      setRuns([]);
      toast.success('Backtest history cleared');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Failed to clear history');
    } finally {
      setRunsLoading(false);
    }
  };

  const handleRunBacktest = (values: BacktestFormValues) => {
    setLoading(true);
    setResult(null);
    setSelectedRunId(null);

    const params = {
      startDate: new Date(values.startDate).toISOString(),
      endDate: new Date(values.endDate).toISOString(),
      initialCapital: values.initialCapital,
      symbols: values.symbols,
      leverage: values.leverage,
    };

    toast.info('Starting backtest... This may take a few minutes.');
    api.backtest.run(params).then((data) => {
      setResult(data);
      toast.success(`Backtest completed! ${data.trades.length} trades analyzed.`);
      void refreshRuns();
    }).catch((error: any) => {
      toast.error(error?.response?.data?.error || 'Backtest failed');
    }).finally(() => {
      setLoading(false);
    });
  };

  // Filter trades
  const filteredTrades = useMemo(() => {
    if (!result) return [];
    return result.trades.filter(t => {
      if (selectedMonth !== 'all' && t.month !== selectedMonth) return false;
      if (selectedSymbol !== 'all' && t.symbol !== selectedSymbol) return false;
      if (selectedSide !== 'all' && t.side !== selectedSide) return false;
      return true;
    });
  }, [result, selectedMonth, selectedSymbol, selectedSide]);

  // Calculate filtered stats
  const filteredStats = useMemo(() => {
    if (filteredTrades.length === 0) return null;
    const wins = filteredTrades.filter(t => t.netPnlUsd > 0);
    const pnl = filteredTrades.reduce((sum, t) => sum + t.netPnlUsd, 0);
    return {
      trades: filteredTrades.length,
      wins: wins.length,
      losses: filteredTrades.length - wins.length,
      winRate: (wins.length / filteredTrades.length) * 100,
      pnlUsd: pnl,
    };
  }, [filteredTrades]);

  // Months for filter
  const months = useMemo(() => {
    if (!result) return [];
    return [...new Set(result.trades.map(t => t.month))].sort();
  }, [result]);

  // Sorted + paginated trades
  const sortedTrades = useMemo(() => {
    const arr = [...filteredTrades];
    if (tradeSortField === 'netPnlUsd') {
      arr.sort((a, b) => tradeSortDir === 'asc' ? a.netPnlUsd - b.netPnlUsd : b.netPnlUsd - a.netPnlUsd);
    }
    return arr;
  }, [filteredTrades, tradeSortField, tradeSortDir]);

  const paginatedTrades = useMemo(() => {
    const start = (tradePage - 1) * tradePageSize;
    return sortedTrades.slice(start, start + tradePageSize);
  }, [sortedTrades, tradePage, tradePageSize]);

  const totalTradePages = Math.ceil(sortedTrades.length / tradePageSize);

  // Sorted monthly stats
  const sortedMonthly = useMemo(() => {
    if (!result) return [];
    const arr = [...result.monthlyStats];
    if (monthlySortField === 'pnlUsd') {
      arr.sort((a, b) => monthlySortDir === 'asc' ? a.pnlUsd - b.pnlUsd : b.pnlUsd - a.pnlUsd);
    }
    return arr;
  }, [result, monthlySortField, monthlySortDir]);

  // Reset page when filters change
  useEffect(() => {
    setTradePage(1);
  }, [selectedMonth, selectedSymbol, selectedSide]);

  return (
    <TooltipProvider>
      <div className="mx-auto max-w-[1600px] px-4 py-4 sm:p-6">
        <h2 className="mb-6 flex items-center gap-3 text-2xl font-bold text-foreground">
          <LineChart className="h-7 w-7" />
          Strategy Backtester
        </h2>

        {/* History */}
        <div className="mb-6 rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <span className="text-sm font-medium text-foreground">Recent Backtests (cached)</span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refreshRuns()}
                disabled={runsLoading}
              >
                {runsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Refresh
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void handleClearRuns()}
                disabled={runsLoading}
              >
                Clear
              </Button>
            </div>
          </div>
          <div className="p-4">
            {runsLoading && runs.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : runs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <LineChart className="mb-2 h-10 w-10 opacity-30" />
                <span className="text-sm">No cached runs yet</span>
              </div>
            ) : (
              <div className="max-h-[400px] space-y-2 overflow-y-auto">
                {runs.map(r => {
                  const isSelected = selectedRunId === r.id;
                  return (
                    <button
                      key={r.id}
                      onClick={() => void handleLoadRun(r.id)}
                      className={cn(
                        "w-full text-left rounded-lg border border-border p-3 transition-colors hover:bg-muted",
                        isSelected && "bg-muted border-primary/40"
                      )}
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-sm text-foreground">
                            {dayjs(r.createdAt).format('DD/MM/YY HH:mm')} · ${r.params.initialCapital.toLocaleString()} · {r.params.leverage}x
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {dayjs(r.params.startDate).format('YYYY-MM-DD')} &rarr; {dayjs(r.params.endDate).format('YYYY-MM-DD')} · {r.params.symbols.length} symbols
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className={cn("text-sm font-medium", r.summary.totalPnlUsd >= 0 ? "text-success" : "text-destructive")}>
                            {formatCurrency(r.summary.totalPnlUsd)} ({formatPercent(r.summary.totalPnlPct)})
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {r.summary.totalTrades} trades · WR {(r.summary.winRate ?? 0).toFixed(1)}% · DD {(r.summary.maxDrawdownPct ?? 0).toFixed(1)}%
                          </p>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Form */}
        <div className="mb-6 rounded-xl border border-border bg-card p-6">
          <form onSubmit={form.handleSubmit(handleRunBacktest)} className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <label className="text-sm text-muted-foreground">Start Date</label>
              <Controller
                control={form.control}
                name="startDate"
                render={({ field }) => (
                  <input
                    type="date"
                    value={field.value}
                    onChange={field.onChange}
                    className="h-9 rounded-md border border-border bg-card px-3 text-sm text-foreground"
                  />
                )}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm text-muted-foreground">End Date</label>
              <Controller
                control={form.control}
                name="endDate"
                render={({ field }) => (
                  <input
                    type="date"
                    value={field.value}
                    onChange={field.onChange}
                    max={dayjs().format('YYYY-MM-DD')}
                    className="h-9 rounded-md border border-border bg-card px-3 text-sm text-foreground"
                  />
                )}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm text-muted-foreground">Capital ($)</label>
              <Controller
                control={form.control}
                name="initialCapital"
                render={({ field }) => (
                  <input
                    type="number"
                    min={100}
                    max={1000000}
                    step={1}
                    value={field.value}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                    className="h-9 w-[120px] rounded-md border border-border bg-card px-3 text-sm text-foreground"
                  />
                )}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm text-muted-foreground">Leverage</label>
              <Controller
                control={form.control}
                name="leverage"
                render={({ field }) => (
                  <Select value={String(field.value)} onValueChange={(v: string) => field.onChange(Number(v))}>
                    <SelectTrigger className="w-[80px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="3">3x</SelectItem>
                      <SelectItem value="4">4x</SelectItem>
                      <SelectItem value="4.5">4.5x</SelectItem>
                      <SelectItem value="5">5x</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="w-full space-y-1.5">
              <label className="text-sm text-muted-foreground">Symbols ({watchSymbols.length} selected)</label>
              <div className="flex flex-wrap gap-1.5">
                {symbolOptions.map(opt => {
                  const selected = watchSymbols.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => toggleSymbol(opt.value)}
                      className={cn(
                        "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                        selected ? "bg-primary/20 text-primary border border-primary/40" : "bg-muted text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <Button
              type="submit"
              size="lg"
              disabled={loading}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
              Run Backtest
            </Button>
          </form>
        </div>

        {/* Loading */}
        {loading && (
          <div className="mb-6 rounded-xl border border-border bg-card p-12 text-center">
            <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary" />
            <p className="mt-4 text-sm text-muted-foreground">
              Fetching market data and running simulation...
            </p>
            <div className="mx-auto mt-4 max-w-[400px]">
              <Progress value={30} />
            </div>
          </div>
        )}

        {/* Results */}
        {result && !loading && (
          <>
            {/* Summary Stats */}
            <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
              <div className="rounded-xl border border-border bg-card p-6">
                <p className="text-sm text-muted-foreground">Total PnL</p>
                <p className={cn("mt-1 text-2xl font-bold", result.summary.totalPnlUsd >= 0 ? "text-success" : "text-destructive")}>
                  ${Math.abs(result.summary.totalPnlUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatPercent(result.summary.totalPnlPct)} ROI
                </p>
              </div>
              <div className="rounded-xl border border-border bg-card p-6">
                <p className="text-sm text-muted-foreground">Win Rate</p>
                <p className={cn("mt-1 text-2xl font-bold", result.summary.winRate >= 50 ? "text-success" : "text-destructive")}>
                  {result.summary.winRate.toFixed(1)}%
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {result.summary.wins}W / {result.summary.losses}L ({result.summary.totalTrades} total)
                </p>
              </div>
              <div className="rounded-xl border border-border bg-card p-6">
                <p className="text-sm text-muted-foreground">Max Drawdown</p>
                <p className="mt-1 flex items-center gap-1.5 text-2xl font-bold text-destructive">
                  <AlertTriangle className="h-5 w-5" />
                  {result.summary.maxDrawdownPct.toFixed(1)}%
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Profit Factor: {(result.summary.profitFactor ?? 0).toFixed(2)}
                </p>
              </div>
              <div className="rounded-xl border border-border bg-card p-6">
                <p className="text-sm text-muted-foreground">Final Capital</p>
                <p className="mt-1 text-2xl font-bold text-primary">
                  ${result.summary.finalCapital.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Started with ${result.params.initialCapital.toLocaleString()}
                </p>
              </div>
            </div>

            {/* Additional Stats Row */}
            <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-6">
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="text-[11px] text-muted-foreground">Avg Win</p>
                <p className="mt-1 text-lg font-bold text-success">
                  ${(result.summary.avgWinUsd ?? 0).toFixed(2)}
                </p>
              </div>
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="text-[11px] text-muted-foreground">Avg Loss</p>
                <p className="mt-1 text-lg font-bold text-destructive">
                  ${(result.summary.avgLossUsd ?? 0).toFixed(2)}
                </p>
              </div>
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="text-[11px] text-muted-foreground">Long Trades</p>
                <p className="mt-1 text-lg font-bold text-primary">
                  {result.summary.longTrades}
                </p>
              </div>
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="text-[11px] text-muted-foreground">Short Trades</p>
                <p className="mt-1 text-lg font-bold" style={{ color: '#f472b6' }}>
                  {result.summary.shortTrades}
                </p>
              </div>
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="text-[11px] text-muted-foreground">Avg Hold</p>
                <p className="mt-1 text-lg font-bold" style={{ color: '#a78bfa' }}>
                  {((result.summary.avgHoldMinutes ?? 0) / 60).toFixed(1)}h
                </p>
              </div>
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="text-[11px] text-muted-foreground">Total Fees</p>
                <p className="mt-1 text-lg font-bold" style={{ color: '#fb923c' }}>
                  ${(result.summary.totalFeesUsd ?? 0).toFixed(0)}
                </p>
              </div>
            </div>

            {/* Charts */}
            <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-border bg-card">
                <div className="border-b border-border px-6 py-4">
                  <span className="text-sm font-medium text-foreground">Equity Curve</span>
                </div>
                <div className="p-6">
                  <MiniEquityChart data={result.equityCurve} />
                </div>
              </div>
              <div className="rounded-xl border border-border bg-card">
                <div className="border-b border-border px-6 py-4">
                  <span className="text-sm font-medium text-foreground">Drawdown</span>
                </div>
                <div className="p-6">
                  <MiniDrawdownChart data={result.drawdownCurve} />
                </div>
              </div>
            </div>

            {/* Tabs for Monthly/Trades */}
            <div className="rounded-xl border border-border bg-card p-6">
              <Tabs defaultValue="monthly">
                <TabsList>
                  <TabsTrigger value="monthly">Monthly Breakdown</TabsTrigger>
                  <TabsTrigger value="trades">Individual Trades ({filteredTrades.length})</TabsTrigger>
                </TabsList>

                <TabsContent value="monthly">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[100px]">Month</TableHead>
                          <TableHead className="w-[80px] text-right">Trades</TableHead>
                          <TableHead className="w-[80px]">W/L</TableHead>
                          <TableHead className="w-[90px] text-right">Win Rate</TableHead>
                          <TableHead className="w-[100px] text-right">
                            <button
                              className="inline-flex items-center gap-1 hover:text-foreground"
                              onClick={() => {
                                if (monthlySortField === 'pnlUsd') {
                                  setMonthlySortDir(d => d === 'asc' ? 'desc' : 'asc');
                                } else {
                                  setMonthlySortField('pnlUsd');
                                  setMonthlySortDir('desc');
                                }
                              }}
                            >
                              PnL <ArrowUpDown className="h-3 w-3" />
                            </button>
                          </TableHead>
                          <TableHead className="w-[80px] text-right">ROI</TableHead>
                          <TableHead className="w-[100px]">Long/Short</TableHead>
                          <TableHead className="w-[90px] text-right">Best</TableHead>
                          <TableHead className="w-[90px] text-right">Worst</TableHead>
                          <TableHead className="w-[110px] text-right">Capital End</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sortedMonthly.map((r) => (
                          <TableRow
                            key={r.month}
                            className="cursor-pointer"
                            onClick={() => setSelectedMonth(r.month)}
                          >
                            <TableCell>{dayjs(r.month).format('MMM YYYY')}</TableCell>
                            <TableCell className="text-right">{r.trades}</TableCell>
                            <TableCell>
                              <span className="text-success">{r.wins}</span>
                              {' / '}
                              <span className="text-destructive">{r.losses}</span>
                            </TableCell>
                            <TableCell className={cn("text-right", (r.winRate ?? 0) >= 50 ? "text-success" : "text-destructive")}>
                              {(r.winRate ?? 0).toFixed(1)}%
                            </TableCell>
                            <TableCell className="text-right"><PnlText value={r.pnlUsd} /></TableCell>
                            <TableCell className="text-right"><PnlText value={r.pnlPct} showCurrency={false} /></TableCell>
                            <TableCell>{r.longTrades}L / {r.shortTrades}S</TableCell>
                            <TableCell className="text-right text-success">${(r.maxWinUsd ?? 0).toFixed(0)}</TableCell>
                            <TableCell className="text-right text-destructive">${Math.abs(r.maxLossUsd ?? 0).toFixed(0)}</TableCell>
                            <TableCell className="text-right">${r.capitalEnd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </TabsContent>

                <TabsContent value="trades">
                  {/* Filters */}
                  <div className="mb-4 flex flex-wrap items-center gap-3">
                    <span className="flex items-center gap-1 text-sm text-muted-foreground">
                      <Filter className="h-4 w-4" /> Filters:
                    </span>
                    <Select value={selectedMonth} onValueChange={(v: string) => setSelectedMonth(v)}>
                      <SelectTrigger className="w-[140px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Months</SelectItem>
                        {months.map(m => (
                          <SelectItem key={m} value={m}>{dayjs(m).format('MMM YYYY')}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={selectedSymbol} onValueChange={(v: string) => setSelectedSymbol(v)}>
                      <SelectTrigger className="w-[140px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Symbols</SelectItem>
                        {result.params.symbols.map(s => (
                          <SelectItem key={s} value={s}>{s.replace('/USDT:USDT', '')}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={selectedSide} onValueChange={(v: string) => setSelectedSide(v as 'all' | 'long' | 'short')}>
                      <SelectTrigger className="w-[100px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Sides</SelectItem>
                        <SelectItem value="long">Long</SelectItem>
                        <SelectItem value="short">Short</SelectItem>
                      </SelectContent>
                    </Select>
                    {filteredStats && (
                      <Alert className="border-primary/30 bg-card px-3 py-1.5">
                        <AlertDescription className="text-xs">
                          Filtered: {filteredStats.trades} trades | {filteredStats.wins}W/{filteredStats.losses}L |{' '}
                          <PnlText value={filteredStats.pnlUsd} /> | WR: {filteredStats.winRate.toFixed(1)}%
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>

                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[140px]">Date</TableHead>
                          <TableHead className="w-[120px]">Symbol</TableHead>
                          <TableHead className="w-[80px]">Side</TableHead>
                          <TableHead className="w-[100px] text-right">Entry</TableHead>
                          <TableHead className="w-[100px] text-right">Exit</TableHead>
                          <TableHead className="w-[100px] text-right">Notional</TableHead>
                          <TableHead className="w-[80px] text-right">Hold</TableHead>
                          <TableHead className="w-[100px] text-right">
                            <button
                              className="inline-flex items-center gap-1 hover:text-foreground"
                              onClick={() => {
                                if (tradeSortField === 'netPnlUsd') {
                                  setTradeSortDir(d => d === 'asc' ? 'desc' : 'asc');
                                } else {
                                  setTradeSortField('netPnlUsd');
                                  setTradeSortDir('desc');
                                }
                              }}
                            >
                              PnL $ <ArrowUpDown className="h-3 w-3" />
                            </button>
                          </TableHead>
                          <TableHead className="w-[80px] text-right">PnL %</TableHead>
                          <TableHead className="w-[70px]">Exit</TableHead>
                          <TableHead className="w-[100px] text-right">Capital</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {paginatedTrades.map((t) => (
                          <TableRow key={t.id} className={t.netPnlUsd >= 0 ? 'trade-row-win' : 'trade-row-loss'}>
                            <TableCell>{dayjs(t.entryTime).format('DD/MM/YY HH:mm')}</TableCell>
                            <TableCell>{t.symbol.replace('/USDT:USDT', '')}</TableCell>
                            <TableCell><SideTag side={t.side} /></TableCell>
                            <TableCell className="text-right">${(t.entryPrice ?? 0).toFixed(4)}</TableCell>
                            <TableCell className="text-right">${(t.exitPrice ?? 0).toFixed(4)}</TableCell>
                            <TableCell className="text-right">${(t.notionalUsd ?? 0).toFixed(0)}</TableCell>
                            <TableCell className="text-right">
                              {t.holdMinutes >= 60 ? `${(t.holdMinutes / 60).toFixed(1)}h` : `${t.holdMinutes}m`}
                            </TableCell>
                            <TableCell className="text-right"><PnlText value={t.netPnlUsd} /></TableCell>
                            <TableCell className="text-right"><PnlText value={t.netPnlPct} showCurrency={false} /></TableCell>
                            <TableCell><ExitReasonTag reason={t.exitReason} /></TableCell>
                            <TableCell className="text-right">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="text-muted-foreground">${(t.capitalAfter ?? 0).toFixed(0)}</span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  Before: ${(t.capitalBefore ?? 0).toFixed(0)} &rarr; After: ${(t.capitalAfter ?? 0).toFixed(0)}
                                </TooltipContent>
                              </Tooltip>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Pagination */}
                  <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
                    <span>{sortedTrades.length} trades</span>
                    <div className="flex items-center gap-2">
                      <Select value={String(tradePageSize)} onValueChange={(v: string) => { setTradePageSize(Number(v)); setTradePage(1); }}>
                        <SelectTrigger className="h-8 w-[70px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="25">25</SelectItem>
                          <SelectItem value="50">50</SelectItem>
                          <SelectItem value="100">100</SelectItem>
                        </SelectContent>
                      </Select>
                      <span>/ page</span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={tradePage <= 1}
                        onClick={() => setTradePage(p => p - 1)}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <span>{tradePage} / {totalTradePages || 1}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={tradePage >= totalTradePages}
                        onClick={() => setTradePage(p => p + 1)}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </>
        )}

        {/* Empty state */}
        {!result && !loading && (
          <div className="rounded-xl border border-border bg-card p-12 text-center">
            <LineChart className="mx-auto mb-4 h-12 w-12 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">
              Configure backtest parameters and click &quot;Run Backtest&quot; to analyze historical performance
            </p>
          </div>
        )}

        {/* CSS */}
        <style>{`
          .trade-row-win { background: hsl(var(--success) / 0.05) !important; }
          .trade-row-loss { background: hsl(var(--destructive) / 0.05) !important; }
          .trade-row-win:hover { background: hsl(var(--success) / 0.1) !important; }
          .trade-row-loss:hover { background: hsl(var(--destructive) / 0.1) !important; }
        `}</style>
      </div>
    </TooltipProvider>
  );
}
