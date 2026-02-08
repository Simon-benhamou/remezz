import React from 'react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import { useReportsCache } from '../hooks/useReportsCache';
import { AppMode } from '../store';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, Legend } from 'recharts';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table as UITable, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import {
  CheckCircle,
  XCircle,
  Loader2,
  RefreshCw,
  Filter,
  AlertCircle,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';

dayjs.extend(relativeTime);

// ============================================================================
// TYPES
// ============================================================================

type ParityCategory = 'MATCH' | 'EXIT_MISMATCH' | 'NO_SIGNAL' | 'PNL_VARIANCE' | 'DATA_ERROR';

interface ParityResult {
  id: string;
  tradeId: string;
  symbol: string;
  side: 'long' | 'short';
  liveEntryTs: string;
  liveExitTs: string;
  liveExitReason: string;
  livePnlPct: number;
  btEntryTs: string | null;
  btExitTs: string | null;
  btExitReason: string | null;
  btPnlPct: number | null;
  entryMatch: boolean;
  exitMatch: boolean;
  pnlMatch: boolean;
  overallMatch: boolean;
  mismatchDetails: string | null;
  verifiedAt: string;
  backtestDurationMs: number | null;
}

interface ParsedMismatchDetails {
  category: ParityCategory;
  details: string;
  signalCheck?: {
    wouldBacktestEnter: boolean;
    signalStrength: number | null;
    signalReason: string | null;
  };
}

// ============================================================================
// CATEGORY STYLING
// ============================================================================

const categoryConfig: Record<ParityCategory, { colorClass: string; bgClass: string; icon: React.ReactNode; label: string; description: string }> = {
  MATCH: {
    colorClass: 'text-emerald-500',
    bgClass: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    icon: <CheckCircle className="h-3.5 w-3.5" />,
    label: 'Match',
    description: 'Live and backtest behavior are identical',
  },
  EXIT_MISMATCH: {
    colorClass: 'text-red-500',
    bgClass: 'bg-red-500/10 text-red-500 border-red-500/20',
    icon: <XCircle className="h-3.5 w-3.5" />,
    label: 'Exit Mismatch',
    description: 'Same entry, but different exit reason - needs investigation',
  },
  NO_SIGNAL: {
    colorClass: 'text-amber-500',
    bgClass: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
    icon: <AlertCircle className="h-3.5 w-3.5" />,
    label: 'No Signal',
    description: 'Live entered but backtest would not have - potential regime bug',
  },
  PNL_VARIANCE: {
    colorClass: 'text-blue-500',
    bgClass: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
    icon: <Info className="h-3.5 w-3.5" />,
    label: 'PnL Variance',
    description: 'Same exit reason but PnL differs - usually acceptable slippage',
  },
  DATA_ERROR: {
    colorClass: 'text-muted-foreground',
    bgClass: 'bg-muted text-muted-foreground border-border',
    icon: <AlertTriangle className="h-3.5 w-3.5" />,
    label: 'Data Error',
    description: 'Could not verify due to missing data',
  },
};

// ============================================================================
// SORT HELPERS
// ============================================================================

type SortDir = 'asc' | 'desc' | null;
type SortField = 'symbol' | 'entry' | 'livePnl' | 'btPnl' | 'pnlDiff' | 'verifiedAt';

function nextSort(current: SortDir): SortDir {
  if (current === null) return 'asc';
  if (current === 'asc') return 'desc';
  return null;
}

function SortIcon({ dir }: { dir: SortDir }) {
  if (dir === 'asc') return <ArrowUp className="ml-1 inline h-3 w-3" />;
  if (dir === 'desc') return <ArrowDown className="ml-1 inline h-3 w-3" />;
  return <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-40" />;
}

// ============================================================================
// PARITY VERIFICATION PANEL
// ============================================================================

function ParityVerificationPanel() {
  const [results, setResults] = React.useState<ParityResult[]>([]);
  const [filteredResults, setFilteredResults] = React.useState<ParityResult[]>([]);
  const [summary, setSummary] = React.useState<{
    total: number;
    matched: number;
    mismatched: number;
    matchRate: number;
  }>({ total: 0, matched: 0, mismatched: 0, matchRate: 0 });
  const [loading, setLoading] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);
  const [days, setDays] = React.useState(30);
  const [symbolFilter, setSymbolFilter] = React.useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = React.useState<ParityCategory[]>([]);
  const [sideFilter, setSideFilter] = React.useState<string[]>([]);
  const [expandedRowKeys, setExpandedRowKeys] = React.useState<string[]>([]);

  // Sorting
  const [sortField, setSortField] = React.useState<SortField>('verifiedAt');
  const [sortDir, setSortDir] = React.useState<SortDir>('desc');

  // Pagination
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(15);

  // Dark mode detection
  const isDarkTheme = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  React.useEffect(() => {
    loadResults();
  }, []);

  // Valid category keys for validation
  const validCategories: ParityCategory[] = ['MATCH', 'EXIT_MISMATCH', 'NO_SIGNAL', 'PNL_VARIANCE', 'DATA_ERROR'];

  // Parse mismatch details from V2 format
  const parseDetails = React.useCallback((record: ParityResult): ParsedMismatchDetails | null => {
    if (!record.mismatchDetails) {
      return record.overallMatch
        ? { category: 'MATCH', details: 'Fully matched' }
        : null;
    }
    try {
      const parsed = JSON.parse(record.mismatchDetails);
      // V2 format: { category, details, signalCheck }
      if (parsed.category) {
        // Validate category is a known value to prevent undefined config access
        const category = validCategories.includes(parsed.category)
          ? parsed.category
          : 'DATA_ERROR';
        return { ...parsed, category } as ParsedMismatchDetails;
      }
      // V1 format: array of strings
      if (Array.isArray(parsed)) {
        return {
          category: record.overallMatch ? 'MATCH' : 'EXIT_MISMATCH',
          details: parsed.join('; '),
        };
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  // Get category for a result
  const getCategory = React.useCallback((record: ParityResult): ParityCategory => {
    if (record.overallMatch) return 'MATCH';
    const parsed = parseDetails(record);
    return parsed?.category || 'EXIT_MISMATCH';
  }, [parseDetails]);

  // Apply filters when results or filters change
  React.useEffect(() => {
    let filtered = [...results];

    // Symbol filter
    if (symbolFilter.length > 0) {
      filtered = filtered.filter(r => {
        const sym = r.symbol.replace('/USDT:USDT', '').toUpperCase();
        return symbolFilter.some(f => sym.includes(f.toUpperCase()));
      });
    }

    // Category filter
    if (categoryFilter.length > 0) {
      filtered = filtered.filter(r => categoryFilter.includes(getCategory(r)));
    }

    // Side filter
    if (sideFilter.length > 0) {
      filtered = filtered.filter(r => sideFilter.includes(r.side));
    }

    setFilteredResults(filtered);
    setPage(0);
  }, [results, symbolFilter, categoryFilter, sideFilter, getCategory]);

  // Get unique symbols from results
  const availableSymbols = React.useMemo(() => {
    const symbols = new Set(results.map(r => r.symbol.replace('/USDT:USDT', '')));
    return Array.from(symbols).sort();
  }, [results]);

  // Category statistics
  const categoryStats = React.useMemo(() => {
    const stats: Record<ParityCategory, number> = {
      MATCH: 0,
      EXIT_MISMATCH: 0,
      NO_SIGNAL: 0,
      PNL_VARIANCE: 0,
      DATA_ERROR: 0,
    };
    for (const r of results) {
      stats[getCategory(r)]++;
    }
    return stats;
  }, [results, getCategory]);

  const loadResults = async () => {
    setLoading(true);
    try {
      const data = await api.backtest.getParityResults({ limit: 200 });
      // Cast side to proper type since API returns string
      const typedResults = (data.results || []).map((r: any) => ({
        ...r,
        side: r.side as 'long' | 'short',
      })) as ParityResult[];
      setResults(typedResults);
      setSummary(data.summary || { total: 0, matched: 0, mismatched: 0, matchRate: 0 });
    } catch (error) {
      console.error('Failed to load parity results:', error);
      toast.error('Failed to load parity results');
    } finally {
      setLoading(false);
    }
  };

  const refreshAll = async () => {
    setVerifying(true);
    try {
      toast.info(`Starting verification for last ${days} days...`);
      const result = await api.backtest.verifyAll({ days });
      toast.success(`Verified ${result.total} trades: ${result.matched} matched, ${result.mismatched} mismatched`);
      await loadResults();
    } catch (error) {
      console.error('Bulk verification failed:', error);
      toast.error('Bulk verification failed');
    } finally {
      setVerifying(false);
    }
  };

  // Helper functions
  const getTimeDiffMinutes = (ts1: string | null, ts2: string | null): string => {
    if (!ts1 || !ts2) return 'N/A';
    const diff = Math.abs(dayjs(ts1).diff(dayjs(ts2), 'minute'));
    if (diff === 0) return 'Same';
    if (diff < 60) return `${diff}m`;
    return `${Math.floor(diff / 60)}h ${diff % 60}m`;
  };

  const isSameCandle = (ts1: string | null, ts2: string | null): boolean => {
    if (!ts1 || !ts2) return false;
    const CANDLE_MS = 15 * 60 * 1000;
    const c1 = Math.floor(dayjs(ts1).valueOf() / CANDLE_MS);
    const c2 = Math.floor(dayjs(ts2).valueOf() / CANDLE_MS);
    return c1 === c2;
  };

  const PNL_TOLERANCE = 0.5;

  // Sort + paginate
  const sortedAndPaged = React.useMemo(() => {
    let sorted = [...filteredResults];
    if (sortField && sortDir) {
      sorted.sort((a, b) => {
        let cmp = 0;
        switch (sortField) {
          case 'symbol':
            cmp = a.symbol.localeCompare(b.symbol);
            break;
          case 'entry':
            cmp = dayjs(a.liveEntryTs).valueOf() - dayjs(b.liveEntryTs).valueOf();
            break;
          case 'livePnl':
            cmp = (a.livePnlPct || 0) - (b.livePnlPct || 0);
            break;
          case 'btPnl':
            cmp = (a.btPnlPct || 0) - (b.btPnlPct || 0);
            break;
          case 'pnlDiff': {
            const diffA = a.btPnlPct != null ? Math.abs((a.livePnlPct || 0) - a.btPnlPct) : 0;
            const diffB = b.btPnlPct != null ? Math.abs((b.livePnlPct || 0) - b.btPnlPct) : 0;
            cmp = diffA - diffB;
            break;
          }
          case 'verifiedAt':
            cmp = dayjs(a.verifiedAt).valueOf() - dayjs(b.verifiedAt).valueOf();
            break;
        }
        return sortDir === 'desc' ? -cmp : cmp;
      });
    }
    return sorted;
  }, [filteredResults, sortField, sortDir]);

  const pagedResults = sortedAndPaged.slice(page * pageSize, (page + 1) * pageSize);
  const totalPages = Math.max(1, Math.ceil(sortedAndPaged.length / pageSize));

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      const next = nextSort(sortDir);
      setSortDir(next);
      if (next === null) setSortField('verifiedAt');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const toggleFilter = <T,>(arr: T[], val: T, setter: React.Dispatch<React.SetStateAction<T[]>>) => {
    setter(arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val]);
  };

  // Render expanded row details
  const renderExpandedRow = (record: ParityResult) => {
    const livePnl = record.livePnlPct ?? 0;
    const btPnl = record.btPnlPct;
    const pnlDiff = btPnl != null ? (livePnl - btPnl) : null;
    const holdTimeLive = record.liveExitTs && record.liveEntryTs
      ? Math.round(dayjs(record.liveExitTs).diff(dayjs(record.liveEntryTs), 'minute'))
      : null;
    const holdTimeBt = record.btExitTs && record.btEntryTs
      ? Math.round(dayjs(record.btExitTs).diff(dayjs(record.btEntryTs), 'minute'))
      : null;
    const parsed = parseDetails(record);
    const category = getCategory(record);
    const config = categoryConfig[category];

    return (
      <TableCell colSpan={8} className="p-0">
        <div className={cn(
          "rounded-lg p-4",
          isDarkTheme ? "bg-slate-900/95" : "bg-muted/50"
        )}>
          {/* Category Header */}
          <div className={cn(
            "mb-4 rounded-lg p-3",
            isDarkTheme ? "bg-slate-800/80" : "bg-card",
            category === 'MATCH' ? "border-l-4 border-l-emerald-500" :
            category === 'NO_SIGNAL' ? "border-l-4 border-l-amber-500" :
            "border-l-4 border-l-red-500"
          )}>
            <div className="flex items-center gap-2">
              <span className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
                config.bgClass
              )}>
                {config.icon}
                {config.label}
              </span>
              <span className="text-sm text-muted-foreground">{config.description}</span>
            </div>
            {parsed?.signalCheck && !parsed.signalCheck.wouldBacktestEnter && (
              <div className="mt-2">
                <span className="font-semibold text-red-500">Signal Rejection Reason: </span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{parsed.signalCheck.signalReason}</code>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Time Comparison */}
            <div className="rounded-xl border border-border bg-card p-4">
              <h4 className="mb-3 text-sm font-semibold text-foreground">Time Comparison</h4>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="py-2 text-left"></th>
                    <th className="py-2 text-left">LIVE</th>
                    <th className="py-2 text-left">BACKTEST</th>
                    <th className="py-2 text-left">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="py-1.5 text-muted-foreground">Entry</td>
                    <td>{dayjs(record.liveEntryTs).format('MM-DD HH:mm:ss')}</td>
                    <td>{record.btEntryTs ? dayjs(record.btEntryTs).format('MM-DD HH:mm:ss') : '-'}</td>
                    <td>
                      <span className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                        isSameCandle(record.liveEntryTs, record.btEntryTs) ? "bg-emerald-500/10 text-emerald-500" : "bg-amber-500/10 text-amber-500"
                      )}>
                        {getTimeDiffMinutes(record.liveEntryTs, record.btEntryTs)}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td className="py-1.5 text-muted-foreground">Exit</td>
                    <td>{dayjs(record.liveExitTs).format('MM-DD HH:mm:ss')}</td>
                    <td>{record.btExitTs ? dayjs(record.btExitTs).format('MM-DD HH:mm:ss') : '-'}</td>
                    <td>
                      <span className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                        isSameCandle(record.liveExitTs, record.btExitTs) ? "bg-emerald-500/10 text-emerald-500" : "bg-amber-500/10 text-amber-500"
                      )}>
                        {getTimeDiffMinutes(record.liveExitTs, record.btExitTs)}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td className="py-1.5 text-muted-foreground">Hold</td>
                    <td>{holdTimeLive != null ? `${holdTimeLive}m (${(holdTimeLive/15).toFixed(1)} candles)` : '-'}</td>
                    <td>{holdTimeBt != null ? `${holdTimeBt}m (${(holdTimeBt/15).toFixed(1)} candles)` : '-'}</td>
                    <td>
                      {holdTimeLive != null && holdTimeBt != null && (
                        <span className={cn(
                          "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                          Math.abs(holdTimeLive - holdTimeBt) <= 15 ? "bg-emerald-500/10 text-emerald-500" : "bg-amber-500/10 text-amber-500"
                        )}>
                          {Math.abs(holdTimeLive - holdTimeBt)}m
                        </span>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* PnL Comparison */}
            <div className="rounded-xl border border-border bg-card p-4">
              <h4 className="mb-3 text-sm font-semibold text-foreground">PnL Comparison</h4>
              <div className="grid grid-cols-3 gap-4">
                <div className="text-center">
                  <span className="text-[11px] text-muted-foreground">Live PnL</span>
                  <div className={cn("text-lg font-semibold", livePnl >= 0 ? "text-emerald-500" : "text-red-500")}>
                    {livePnl >= 0 ? '+' : ''}{livePnl.toFixed(2)}%
                  </div>
                </div>
                <div className="text-center">
                  <span className="text-[11px] text-muted-foreground">Backtest PnL</span>
                  <div className={cn("text-lg font-semibold", (btPnl ?? 0) >= 0 ? "text-emerald-500" : "text-red-500")}>
                    {btPnl != null ? `${btPnl >= 0 ? '+' : ''}${btPnl.toFixed(2)}%` : '-'}
                  </div>
                </div>
                <div className="text-center">
                  <span className="text-[11px] text-muted-foreground">Difference</span>
                  <div className={cn("text-lg font-semibold", pnlDiff != null && Math.abs(pnlDiff) <= PNL_TOLERANCE ? "text-emerald-500" : "text-red-500")}>
                    {pnlDiff != null ? `${Math.abs(pnlDiff).toFixed(2)}%` : '-'}
                  </div>
                </div>
              </div>
              <Separator className="my-3" />
              <div className="flex gap-2">
                <span className={cn(
                  "rounded-full border px-2 py-0.5 text-xs font-medium",
                  record.entryMatch ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : "bg-red-500/10 text-red-500 border-red-500/20"
                )}>
                  Entry {record.entryMatch ? '\u2713' : '\u2717'}
                </span>
                <span className={cn(
                  "rounded-full border px-2 py-0.5 text-xs font-medium",
                  record.exitMatch ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : "bg-red-500/10 text-red-500 border-red-500/20"
                )}>
                  Exit {record.exitMatch ? '\u2713' : '\u2717'}
                </span>
                <span className={cn(
                  "rounded-full border px-2 py-0.5 text-xs font-medium",
                  record.pnlMatch ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : "bg-red-500/10 text-red-500 border-red-500/20"
                )}>
                  PnL {record.pnlMatch ? '\u2713' : '\u2717'}
                </span>
              </div>
            </div>
          </div>

          {/* Details Section */}
          {parsed?.details && category !== 'MATCH' && (
            <div className={cn(
              "mt-4 rounded-lg border p-4",
              isDarkTheme ? "border-amber-500/30 bg-amber-500/10" : "border-amber-300 bg-amber-50"
            )}>
              <div className="mb-2 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <span className="font-semibold text-foreground">Details</span>
              </div>
              <p className="m-0 text-sm text-foreground">{parsed.details}</p>
            </div>
          )}

          {/* Footer */}
          <div className="mt-3 text-right">
            <span className="text-[11px] text-muted-foreground">
              Verified {dayjs(record.verifiedAt).fromNow()} &bull; Duration: {record.backtestDurationMs ? `${record.backtestDurationMs}ms` : 'N/A'}
            </span>
          </div>
        </div>
      </TableCell>
    );
  };

  // Chart data for category distribution
  const chartData = React.useMemo(() => {
    return Object.entries(categoryStats).map(([key, value]) => ({
      name: categoryConfig[key as ParityCategory].label,
      value,
      color: key === 'MATCH' ? 'var(--success)' : key === 'NO_SIGNAL' ? '#faad14' : key === 'PNL_VARIANCE' ? '#1890ff' : 'var(--error)',
    })).filter(d => d.value > 0);
  }, [categoryStats]);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="rounded-xl border border-border bg-card px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h4 className="m-0 text-lg font-semibold text-foreground">Parity Verification</h4>
            <span className="text-sm text-muted-foreground">Compare live trades against backtest simulation</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Last</span>
            <input
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(Number(e.target.value) || 30)}
              className="h-9 w-[70px] rounded-md border border-border bg-card px-2 text-sm text-foreground"
            />
            <span className="text-sm text-muted-foreground">days</span>
            <Button onClick={refreshAll} disabled={verifying}>
              {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Verify All
            </Button>
            <Button variant="outline" onClick={loadResults} disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {/* Statistics Row */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="col-span-1 md:col-span-2">
          <div className="rounded-xl border border-border bg-card p-4">
            <TooltipProvider>
              <div className="grid grid-cols-3 gap-4 md:grid-cols-6">
                <div>
                  <span className="text-xs uppercase tracking-wider text-muted-foreground">Total</span>
                  <div className="text-2xl font-bold text-blue-500">{summary.total}</div>
                </div>
                <div>
                  <span className="text-xs uppercase tracking-wider text-muted-foreground">Match</span>
                  <div className="flex items-center gap-1 text-2xl font-bold text-emerald-500">
                    <CheckCircle className="h-4 w-4" /> {categoryStats.MATCH}
                  </div>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="cursor-help">
                      <span className="text-xs uppercase tracking-wider text-muted-foreground">No Signal</span>
                      <div className="flex items-center gap-1 text-2xl font-bold text-amber-500">
                        <AlertCircle className="h-4 w-4" /> {categoryStats.NO_SIGNAL}
                      </div>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Live entered but backtest wouldn&apos;t</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="cursor-help">
                      <span className="text-xs uppercase tracking-wider text-muted-foreground">Exit Delta</span>
                      <div className="flex items-center gap-1 text-2xl font-bold text-red-500">
                        <XCircle className="h-4 w-4" /> {categoryStats.EXIT_MISMATCH}
                      </div>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Same entry, different exit</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="cursor-help">
                      <span className="text-xs uppercase tracking-wider text-muted-foreground">PnL Delta</span>
                      <div className="flex items-center gap-1 text-2xl font-bold text-blue-500">
                        <Info className="h-4 w-4" /> {categoryStats.PNL_VARIANCE}
                      </div>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Same exit, PnL differs</TooltipContent>
                </Tooltip>
                <div>
                  <span className="text-xs uppercase tracking-wider text-muted-foreground">Match Rate</span>
                  <div className={cn(
                    "text-2xl font-bold",
                    summary.matchRate >= 90 ? "text-emerald-500" : summary.matchRate >= 70 ? "text-amber-500" : "text-red-500"
                  )}>
                    {summary.matchRate.toFixed(1)}%
                  </div>
                </div>
              </div>
            </TooltipProvider>
          </div>
        </div>
        <div className="col-span-1">
          <div className="flex h-full items-center justify-center rounded-xl border border-border bg-card p-2">
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={80}>
                <PieChart>
                  <Pie data={chartData} dataKey="value" cx="50%" cy="50%" innerRadius={25} outerRadius={35} paddingAngle={2}>
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Legend layout="vertical" align="right" verticalAlign="middle" iconSize={8}
                          formatter={(value) => <span style={{ fontSize: '11px' }}>{value}</span>} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <span className="text-sm text-muted-foreground">No data</span>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card">
        {/* Table header bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground">Verification Results</span>
            {(symbolFilter.length > 0 || categoryFilter.length > 0 || sideFilter.length > 0) && (
              <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-500">
                {filteredResults.length} / {results.length}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {/* Symbol filter */}
            <div>
              <span className="mr-1 text-xs text-muted-foreground">Symbol:</span>
              <div className="inline-flex flex-wrap gap-1">
                {availableSymbols.map(sym => (
                  <button
                    key={sym}
                    onClick={() => toggleFilter(symbolFilter, sym, setSymbolFilter)}
                    className={cn(
                      "rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
                      symbolFilter.includes(sym) ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
                    )}
                  >
                    {sym}
                  </button>
                ))}
              </div>
            </div>
            {/* Category filter */}
            <div>
              <span className="mr-1 text-xs text-muted-foreground">Category:</span>
              <div className="inline-flex flex-wrap gap-1">
                {(['MATCH', 'NO_SIGNAL', 'EXIT_MISMATCH', 'PNL_VARIANCE'] as ParityCategory[]).map(cat => (
                  <button
                    key={cat}
                    onClick={() => toggleFilter(categoryFilter, cat, setCategoryFilter)}
                    className={cn(
                      "rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
                      categoryFilter.includes(cat) ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
                    )}
                  >
                    {categoryConfig[cat].label}
                  </button>
                ))}
              </div>
            </div>
            {/* Side filter */}
            <div>
              <span className="mr-1 text-xs text-muted-foreground">Side:</span>
              <div className="inline-flex flex-wrap gap-1">
                {(['long', 'short'] as const).map(side => (
                  <button
                    key={side}
                    onClick={() => toggleFilter(sideFilter, side, setSideFilter)}
                    className={cn(
                      "rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
                      sideFilter.includes(side) ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
                    )}
                  >
                    {side.charAt(0).toUpperCase() + side.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Loading overlay */}
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* Table content */}
        {!loading && (
          <>
            <UITable>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead className="w-[90px] cursor-pointer select-none" onClick={() => handleSort('symbol')}>
                    Symbol <SortIcon dir={sortField === 'symbol' ? sortDir : null} />
                  </TableHead>
                  <TableHead className="w-[130px]">Category</TableHead>
                  <TableHead className="w-[120px] cursor-pointer select-none" onClick={() => handleSort('entry')}>
                    Entry <SortIcon dir={sortField === 'entry' ? sortDir : null} />
                  </TableHead>
                  <TableHead className="w-[140px]">Exit Reason</TableHead>
                  <TableHead className="w-[90px] cursor-pointer select-none" onClick={() => handleSort('livePnl')}>
                    Live PnL <SortIcon dir={sortField === 'livePnl' ? sortDir : null} />
                  </TableHead>
                  <TableHead className="w-[90px] cursor-pointer select-none" onClick={() => handleSort('btPnl')}>
                    BT PnL <SortIcon dir={sortField === 'btPnl' ? sortDir : null} />
                  </TableHead>
                  <TableHead className="w-[80px] cursor-pointer select-none" onClick={() => handleSort('pnlDiff')}>
                    Delta PnL <SortIcon dir={sortField === 'pnlDiff' ? sortDir : null} />
                  </TableHead>
                  <TableHead className="w-[90px] cursor-pointer select-none" onClick={() => handleSort('verifiedAt')}>
                    Verified <SortIcon dir={sortField === 'verifiedAt' ? sortDir : null} />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedResults.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                      {results.length === 0
                        ? 'No verification results yet. Click "Verify All" to compare trades against backtest.'
                        : 'No trades match the current filters.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  <TooltipProvider>
                    {pagedResults.map(record => {
                      const category = getCategory(record);
                      const config = categoryConfig[category];
                      const isExpanded = expandedRowKeys.includes(record.id);

                      return (
                        <React.Fragment key={record.id}>
                          <TableRow
                            className="cursor-pointer"
                            onClick={() => setExpandedRowKeys(isExpanded ? [] : [record.id])}
                          >
                            <TableCell className="w-8 px-2">
                              {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                            </TableCell>
                            {/* Symbol */}
                            <TableCell>
                              <div className="flex flex-col">
                                <span className="text-[13px] font-semibold">{record.symbol.replace('/USDT:USDT', '')}</span>
                                <span className={cn(
                                  "mt-0.5 w-fit rounded-full px-1.5 py-0 text-[10px] font-medium",
                                  record.side === 'long' ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"
                                )}>
                                  {record.side.toUpperCase()}
                                </span>
                              </div>
                            </TableCell>
                            {/* Category */}
                            <TableCell>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className={cn(
                                    "inline-flex cursor-help items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
                                    config.bgClass
                                  )}>
                                    {config.icon}
                                    {config.label}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>{config.description}</TooltipContent>
                              </Tooltip>
                            </TableCell>
                            {/* Entry */}
                            <TableCell>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="text-xs">{dayjs(record.liveEntryTs).format('MM-DD HH:mm')}</span>
                                </TooltipTrigger>
                                <TooltipContent>{dayjs(record.liveEntryTs).format('YYYY-MM-DD HH:mm:ss')}</TooltipContent>
                              </Tooltip>
                            </TableCell>
                            {/* Exit Reason */}
                            <TableCell>
                              <div className="flex flex-col gap-0.5">
                                <span className="rounded-full bg-blue-500/10 px-1.5 py-0 text-[10px] font-medium text-blue-500 w-fit">
                                  {record.liveExitReason}
                                </span>
                                {record.btExitReason && record.btExitReason !== record.liveExitReason && (
                                  <span className="rounded-full bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-500 w-fit">
                                    BT: {record.btExitReason}
                                  </span>
                                )}
                              </div>
                            </TableCell>
                            {/* Live PnL */}
                            <TableCell>
                              <span className={cn("text-[13px] font-semibold", record.livePnlPct >= 0 ? "text-emerald-500" : "text-red-500")}>
                                {record.livePnlPct >= 0 ? '+' : ''}{record.livePnlPct?.toFixed(2)}%
                              </span>
                            </TableCell>
                            {/* BT PnL */}
                            <TableCell>
                              {record.btPnlPct != null ? (
                                <span className={cn("text-xs", record.btPnlPct >= 0 ? "text-emerald-500" : "text-red-500")}>
                                  {record.btPnlPct >= 0 ? '+' : ''}{record.btPnlPct?.toFixed(2)}%
                                </span>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                            {/* Delta PnL */}
                            <TableCell>
                              {record.btPnlPct != null ? (
                                <span className={cn(
                                  "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                                  Math.abs((record.livePnlPct || 0) - record.btPnlPct) <= PNL_TOLERANCE
                                    ? "bg-emerald-500/10 text-emerald-500"
                                    : "bg-amber-500/10 text-amber-500"
                                )}>
                                  {Math.abs((record.livePnlPct || 0) - record.btPnlPct).toFixed(2)}%
                                </span>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                            {/* Verified */}
                            <TableCell>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="text-[11px] text-muted-foreground">{dayjs(record.verifiedAt).fromNow()}</span>
                                </TooltipTrigger>
                                <TooltipContent>{dayjs(record.verifiedAt).format('YYYY-MM-DD HH:mm:ss')}</TooltipContent>
                              </Tooltip>
                            </TableCell>
                          </TableRow>
                          {isExpanded && (
                            <TableRow>
                              {renderExpandedRow(record)}
                            </TableRow>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </TooltipProvider>
                )}
              </TableBody>
            </UITable>

            {/* Pagination */}
            {sortedAndPaged.length > 0 && (
              <div className="flex items-center justify-between border-t border-border px-4 py-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>Rows per page:</span>
                  <select
                    value={pageSize}
                    onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
                    className="h-8 rounded-md border border-border bg-card px-2 text-sm text-foreground"
                  >
                    {[10, 15, 25, 50].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <span>
                    {page * pageSize + 1}-{Math.min((page + 1) * pageSize, sortedAndPaged.length)} of {sortedAndPaged.length}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(0)}
                    disabled={page === 0}
                  >
                    First
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={page === 0}
                  >
                    Prev
                  </Button>
                  <span className="px-2 text-sm text-muted-foreground">
                    {page + 1} / {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                  >
                    Next
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(totalPages - 1)}
                    disabled={page >= totalPages - 1}
                  >
                    Last
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function pct(val?: number | null, digits = 2) {
  if (val == null || Number.isNaN(Number(val))) return '-';
  return `${(Number(val) * 100).toFixed(digits)}%`;
}

// ============================================================================
// DAILY REPORTS TABLE (with expand, sort, pagination)
// ============================================================================

type DailySortField = 'date' | 'sessionsCount' | 'totalTrades' | 'winRate' | 'expectancy' | 'totalPnl' | 'profitFactor';

function DailyReportsTable({ reports, sessions, isRefreshing, isInitialLoad, handleRefresh }: {
  reports: any[];
  sessions: any[];
  isRefreshing: boolean;
  isInitialLoad: boolean;
  handleRefresh: () => void;
}) {
  const [expandedDate, setExpandedDate] = React.useState<string | null>(null);
  const [sortField, setSortField] = React.useState<DailySortField>('date');
  const [sortDir, setSortDir] = React.useState<SortDir>('desc');
  const [page, setPage] = React.useState(0);
  const pageSize = 10;

  const handleSort = (field: DailySortField) => {
    if (sortField === field) {
      const next = nextSort(sortDir);
      setSortDir(next);
      if (next === null) { setSortField('date'); setSortDir('desc'); }
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const sortedReports = React.useMemo(() => {
    if (!sortDir) return reports;
    const sorted = [...reports];
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'date': cmp = dayjs(a.date).valueOf() - dayjs(b.date).valueOf(); break;
        case 'sessionsCount': cmp = (a.sessionsCount || 0) - (b.sessionsCount || 0); break;
        case 'totalTrades': cmp = (a.totalTrades || 0) - (b.totalTrades || 0); break;
        case 'winRate': cmp = (a.winRate || 0) - (b.winRate || 0); break;
        case 'expectancy': cmp = (a.expectancy || 0) - (b.expectancy || 0); break;
        case 'totalPnl': cmp = (a.totalPnl || 0) - (b.totalPnl || 0); break;
        case 'profitFactor': cmp = (a.profitFactor || 0) - (b.profitFactor || 0); break;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return sorted;
  }, [reports, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedReports.length / pageSize));
  const pagedReports = sortedReports.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-foreground">Daily Reports</span>
          {isRefreshing && !isInitialLoad && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-500">
              <Loader2 className="h-3 w-3 animate-spin" />
              Updating...
            </span>
          )}
        </div>
        <Button variant="outline" onClick={handleRefresh} disabled={isRefreshing}>
          {isRefreshing && <Loader2 className="h-4 w-4 animate-spin" />}
          Refresh Reports
        </Button>
      </div>

      {isInitialLoad ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : reports.length === 0 ? (
        <div className="py-10 text-center text-muted-foreground">
          {sessions.length === 0 ? 'No trading sessions found' : 'No daily reports available yet'}
        </div>
      ) : (
        <>
          <UITable>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead className="cursor-pointer select-none" onClick={() => handleSort('date')}>
                  Date <SortIcon dir={sortField === 'date' ? sortDir : null} />
                </TableHead>
                <TableHead className="cursor-pointer select-none" onClick={() => handleSort('sessionsCount')}>
                  Sessions <SortIcon dir={sortField === 'sessionsCount' ? sortDir : null} />
                </TableHead>
                <TableHead className="cursor-pointer select-none" onClick={() => handleSort('totalTrades')}>
                  Trades <SortIcon dir={sortField === 'totalTrades' ? sortDir : null} />
                </TableHead>
                <TableHead className="cursor-pointer select-none" onClick={() => handleSort('winRate')}>
                  Win Rate <SortIcon dir={sortField === 'winRate' ? sortDir : null} />
                </TableHead>
                <TableHead className="cursor-pointer select-none" onClick={() => handleSort('expectancy')}>
                  Expectancy <SortIcon dir={sortField === 'expectancy' ? sortDir : null} />
                </TableHead>
                <TableHead className="cursor-pointer select-none" onClick={() => handleSort('totalPnl')}>
                  PnL <SortIcon dir={sortField === 'totalPnl' ? sortDir : null} />
                </TableHead>
                <TableHead className="cursor-pointer select-none" onClick={() => handleSort('profitFactor')}>
                  Profit Factor <SortIcon dir={sortField === 'profitFactor' ? sortDir : null} />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedReports.map((record: any) => {
                const isExpanded = expandedDate === record.date;
                const hasExpandable = record.sessions && record.sessions.length > 0;
                return (
                  <React.Fragment key={record.date}>
                    <TableRow
                      className={cn(hasExpandable && "cursor-pointer")}
                      onClick={() => hasExpandable && setExpandedDate(isExpanded ? null : record.date)}
                    >
                      <TableCell className="w-8 px-2">
                        {hasExpandable && (
                          isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell>{dayjs(record.date).format('MMM DD, YYYY')}</TableCell>
                      <TableCell><span className="text-blue-500">{record.sessionsCount}</span></TableCell>
                      <TableCell>{record.totalTrades}</TableCell>
                      <TableCell>
                        <span className={cn(
                          record.winRate > 0.5 ? "text-emerald-500" : record.winRate > 0.3 ? "text-amber-500" : "text-red-500"
                        )}>
                          {pct(record.winRate)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className={cn(record.expectancy > 0 ? "text-emerald-500" : "text-red-500")}>
                          {record.expectancy.toFixed(2)}%
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className={cn(record.totalPnl >= 0 ? "text-emerald-500" : "text-red-500")}>
                          ${record.totalPnl.toFixed(2)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className={cn(record.profitFactor > 1 ? "text-emerald-500" : "text-red-500")}>
                          {record.profitFactor.toFixed(2)}
                        </span>
                      </TableCell>
                    </TableRow>
                    {isExpanded && hasExpandable && (
                      <TableRow>
                        <TableCell colSpan={8} className="p-4">
                          <p className="mb-2 font-semibold text-foreground">Sessions for {dayjs(record.date).format('MMM DD, YYYY')}:</p>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
                            {record.sessions?.map((session: any, index: number) => (
                              <div key={index} className="rounded-lg border border-border bg-card p-3">
                                <span className="font-semibold text-foreground">{session.symbol}</span>
                                <br />
                                <span className="text-sm text-muted-foreground">Trades: {session.totalTrades}</span>
                                <br />
                                <span className="text-sm text-muted-foreground">WR: {pct(session.winRate)}</span>
                                <br />
                                <span className="text-sm text-muted-foreground">PnL: ${session.totalPnl.toFixed(2)}</span>
                                {session.llmSummary && (
                                  <>
                                    <br />
                                    <span className="text-[11px] text-muted-foreground">
                                      {session.llmSummary.substring(0, 100)}
                                      {session.llmSummary.length > 100 ? '...' : ''}
                                    </span>
                                  </>
                                )}
                              </div>
                            ))}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </UITable>

          {/* Pagination */}
          {sortedReports.length > pageSize && (
            <div className="flex items-center justify-between border-t border-border px-4 py-3">
              <span className="text-sm text-muted-foreground">
                {page * pageSize + 1}-{Math.min((page + 1) * pageSize, sortedReports.length)} of {sortedReports.length}
              </span>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>Prev</Button>
                <span className="px-2 text-sm text-muted-foreground">{page + 1} / {totalPages}</span>
                <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>Next</Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================================
// MAIN REPORTS PAGE
// ============================================================================

export default function ReportsPage() {
  const { mode } = useMode();
  const {
    reports,
    sessions,
    isRefreshing,
    isInitialLoad,
    error,
    loadReports,
    setupAutoRefresh
  } = useReportsCache();

  // Initial load and mode change
  React.useEffect(() => {
    loadReports(mode as AppMode).catch(console.error);
  }, [mode, loadReports]);

  // Setup auto-refresh (every 60s)
  React.useEffect(() => {
    return setupAutoRefresh(mode as AppMode);
  }, [mode, setupAutoRefresh]);

  // Manual refresh handler
  const handleRefresh = React.useCallback(() => {
    loadReports(mode as AppMode, true).catch(console.error);
  }, [mode, loadReports]);

  // Show error toast only once
  React.useEffect(() => {
    if (error) {
      toast.error(error);
    }
  }, [error]);

  const globalStats = React.useMemo(() => {
    const totalTrades = reports.reduce((sum: number, r: any) => sum + r.totalTrades, 0);
    const avgWinRate = reports.length > 0 ?
      reports.reduce((sum: number, r: any) => sum + r.winRate, 0) / reports.length : 0;
    const totalPnl = reports.reduce((sum: number, r: any) => sum + r.totalPnl, 0);
    const maxDrawdown = Math.min(...reports.map((r: any) => r.maxDrawdown), 0);

    return { totalTrades, avgWinRate, totalPnl, maxDrawdown };
  }, [reports]);

  return (
    <div className="p-5">
      <Tabs defaultValue="daily">
        <TabsList>
          <TabsTrigger value="daily">Daily Reports</TabsTrigger>
          <TabsTrigger value="parity">Backtest Parity</TabsTrigger>
        </TabsList>

        <TabsContent value="daily">
          <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-border bg-card p-6">
              <h3 className="m-0 text-xl font-semibold text-foreground">Global Trading Reports</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Comprehensive dashboard with performance metrics across all agents
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <div className="rounded-xl border border-border bg-card p-6">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">Total Trades</span>
                <div className="text-2xl font-bold text-blue-500">{globalStats.totalTrades}</div>
              </div>
              <div className="rounded-xl border border-border bg-card p-6">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">Average Win Rate</span>
                <div className={cn("text-2xl font-bold", globalStats.avgWinRate > 0.5 ? "text-emerald-500" : "text-red-500")}>
                  {pct(globalStats.avgWinRate)}
                </div>
              </div>
              <div className="rounded-xl border border-border bg-card p-6">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">Total P&L</span>
                <div className={cn("text-2xl font-bold", globalStats.totalPnl >= 0 ? "text-emerald-500" : "text-red-500")}>
                  ${globalStats.totalPnl.toFixed(2)}
                </div>
              </div>
              <div className="rounded-xl border border-border bg-card p-6">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">Max Drawdown</span>
                <div className="text-2xl font-bold text-red-500">
                  ${globalStats.maxDrawdown.toFixed(2)}
                </div>
              </div>
            </div>

            <DailyReportsTable
              reports={reports}
              sessions={sessions}
              isRefreshing={isRefreshing}
              isInitialLoad={isInitialLoad}
              handleRefresh={handleRefresh}
            />

            <div className="rounded-xl border border-border bg-card">
              <div className="border-b border-border px-6 py-3">
                <span className="text-sm font-semibold text-foreground">Active Sessions</span>
              </div>
              <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 md:grid-cols-3">
                {sessions.filter((s: any) => !s.stoppedAt).map((session: any) => (
                  <div key={session.id} className="rounded-lg border border-border bg-card p-3">
                    <span className="font-semibold text-foreground">{session.symbol}</span>
                    <br />
                    <span className="text-sm text-muted-foreground">
                      Mode: {session.mode?.toUpperCase()}
                    </span>
                    <br />
                    <span className="text-sm text-muted-foreground">
                      Started: {dayjs(session.startedAt).format('MM-DD HH:mm')}
                    </span>
                  </div>
                ))}
                {sessions.filter((s: any) => !s.stoppedAt).length === 0 && (
                  <div className="col-span-full py-4 text-center text-sm text-muted-foreground">
                    No active sessions
                  </div>
                )}
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="parity">
          <ParityVerificationPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
