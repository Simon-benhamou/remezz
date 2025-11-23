import React from 'react';
import { Card, Table, Select, Space, DatePicker, Segmented, Button, Statistic, Tag, message, InputNumber, Row, Col, Input, Tooltip, Typography, Alert } from 'antd';
import { SearchOutlined, DownloadOutlined, ReloadOutlined } from '../icons';
import dayjs, { Dayjs } from 'dayjs';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import StrategyBadge from '../components/StrategyBadge';

const { RangePicker } = DatePicker;
const { Title, Text } = Typography;

type Outcome = 'win' | 'loss' | 'breakeven';
type AggressivenessLevel = 'conservative' | 'reactive' | 'aggressive';

const AGGRESSIVENESS_META: Record<AggressivenessLevel, { label: string; color: string }> = {
  conservative: { label: 'Conservative', color: '#0ea5e9' },
  reactive: { label: 'Reactive', color: '#a855f7' },
  aggressive: { label: 'Aggressive', color: '#ef4444' },
};

type TradeRow = {
  id: string;
  createdAt: string;
  symbol: string;
  positionSide: string;
  qty: number;
  entryPrice?: number | null;
  exitPrice?: number | null;
  pctChange?: number | null;
  roePct?: number | null;
  realizedPnlUsd?: number | null;
  leverage?: number | null;
  estLev?: number | null;
  status?: string;
  sessionSymbol?: string;
  sessionMode?: string;
  sessionId?: string;
  aggressiveness?: AggressivenessLevel;
  strategyUsed?: string | null;
  strategyConfidence?: number | null;
};

type SessionMetrics = {
  sessionId: string;
  startingBalanceUsd: number;
  realizedPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  roiPct: number;
  tradeCount: number;
};

export function resolvePerformanceSignal(row: TradeRow): number {
  const percentLikeSources = [row.pctChange, row.roePct];
  for (const source of percentLikeSources) {
    if (source == null) continue;
    const value = Number(source);
    if (!Number.isFinite(value)) continue;
    if (Math.abs(value) < 1e-8) continue;
    return value;
  }

  const realized = Number(row.realizedPnlUsd ?? 0);
  if (!Number.isFinite(realized)) return 0;
  return realized;
}

export function asOutcome(row: TradeRow): Outcome {
  const signal = resolvePerformanceSignal(row);
  if (Math.abs(signal) < 1e-8) return 'breakeven';
  return signal > 0 ? 'win' : 'loss';
}

function formatUsd(v?: number | null, digits = 2) {
  if (v == null || Number.isNaN(Number(v))) return '-';
  return `$${Number(v).toFixed(digits)}`;
}

export default function ExecutionLedgerPage() {
  const [sessions, setSessions] = React.useState<any[]>([]);
  const [sessionId, setSessionId] = React.useState<string>('');
  const [rows, setRows] = React.useState<TradeRow[]>([]);
  const [allSessionData, setAllSessionData] = React.useState<TradeRow[]>([]);
  const [sessionPerf, setSessionPerf] = React.useState<SessionMetrics | null>(null);
  const [globalPerf, setGlobalPerf] = React.useState<SessionMetrics | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [filterOutcome, setFilterOutcome] = React.useState<'all' | Outcome>('all');
  const [filterSymbol, setFilterSymbol] = React.useState<string>('all');
  const [filterSessionMode, setFilterSessionMode] = React.useState<'all' | 'paper' | 'live'>('all');
  const [aggressivenessFilter, setAggressivenessFilter] = React.useState<'all' | AggressivenessLevel>('all');
  const [searchText, setSearchText] = React.useState<string>('');
  const [range, setRange] = React.useState<[Dayjs | null, Dayjs | null]>([dayjs().subtract(14, 'day'), dayjs()]);
  const [limit, setLimit] = React.useState<number>(200);
  const [viewMode, setViewMode] = React.useState<'session' | 'global'>('session');
  const { mode } = useMode();
  const [sessionMeta, setSessionMeta] = React.useState<Record<string, { symbol?: string; mode?: string; aggressiveness: AggressivenessLevel }>>({});

  React.useEffect(() => {
    (async () => {
      try {
        const list = await api.listSessions(mode);
        setSessions(list);
        const map: Record<string, { symbol?: string; mode?: string; aggressiveness: AggressivenessLevel }> = {};
        list.forEach((session: any) => {
          if (!session?.id) return;
          const rawLevel =
            (session?.aggressiveness as AggressivenessLevel | undefined)
            ?? (session?.profileJson?.aggressiveness as AggressivenessLevel | undefined)
            ?? (session?.profile?.aggressiveness as AggressivenessLevel | undefined);
          map[session.id] = {
            symbol: session.symbol,
            mode: session.mode,
            aggressiveness: rawLevel ?? 'reactive',
          };
        });
        setSessionMeta(map);
        const active = list.find((s: any) => !s.stoppedAt);
        const first = active || list[0];
        setSessionId(first?.id || '');
      } catch {}
    })();
  }, [mode]);

  const loadTrades = React.useCallback(async () => {
    if (viewMode === 'session' && !sessionId) return;
    setLoading(true);
    try {
      const params: { from?: string; to?: string; limit?: number } = { limit };
      if (range[0]) params.from = range[0].startOf('day').toISOString();
      if (range[1]) params.to = range[1].endOf('day').add(1, 'day').toISOString();

      if (viewMode === 'global') {
        const sessionIds = sessions.map((session) => session.id).filter((id: string) => !!id);
        const [allDataRaw, metricsListRaw, overviewData] = await Promise.all([
          Promise.all(
            sessions.map(async (session) => {
              try {
                const data = await api.getTrades(session.id, params);
                return data.map((trade: any) => {
                  const meta = sessionMeta[session.id] ?? {
                    symbol: session.symbol,
                    mode: session.mode,
                    aggressiveness: 'reactive' as AggressivenessLevel,
                  };
                  return {
                    ...trade,
                    sessionId: session.id,
                    sessionSymbol: session.symbol ?? meta.symbol,
                    sessionMode: session.mode ?? meta.mode,
                    aggressiveness: (trade?.aggressiveness as AggressivenessLevel | undefined) ?? meta.aggressiveness,
                  } as TradeRow;
                });
              } catch {
                return [];
              }
            })
          ),
          sessionIds.length ? api.getSessionMetrics(sessionIds) : Promise.resolve<SessionMetrics[]>([]),
          api.overview(mode),
        ]);
        const allData = allDataRaw as TradeRow[][];
        const flatData = allData
          .flat()
          .map((trade) => {
            if (trade.aggressiveness) return trade;
            const meta = trade.sessionId ? sessionMeta[trade.sessionId] : undefined;
            return {
              ...trade,
              aggressiveness: (trade.aggressiveness as AggressivenessLevel | undefined) ?? meta?.aggressiveness ?? 'reactive',
            };
          })
          .sort((a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf());
        setAllSessionData(flatData);
        setRows(flatData);
        const metricsListRawTyped = metricsListRaw as SessionMetrics | SessionMetrics[] | undefined;
        const metricsList = Array.isArray(metricsListRawTyped)
          ? metricsListRawTyped
          : metricsListRawTyped
          ? [metricsListRawTyped]
          : [];
        if (metricsList.length) {
          // Get actual portfolio capital from overview instead of summing session allocations
          const portfolioCapital = mode === 'paper'
            ? (overviewData?.paperBalance?.equityUsd ?? overviewData?.paperBalance?.freeUsd ?? 0)
            : (overviewData?.exchangeBalance?.totalUsd ?? 0);
          
          const aggregated = metricsList.reduce<SessionMetrics>(
            (acc, metric) => {
              acc.realizedPnlUsd += Number(metric?.realizedPnlUsd ?? 0);
              acc.feesUsd += Number(metric?.feesUsd ?? 0);
              acc.netPnlUsd += Number(metric?.netPnlUsd ?? 0);
              acc.tradeCount += Number(metric?.tradeCount ?? 0);
              return acc;
            },
            {
              sessionId: 'global',
              startingBalanceUsd: portfolioCapital,
              realizedPnlUsd: 0,
              feesUsd: 0,
              netPnlUsd: 0,
              roiPct: 0,
              tradeCount: 0,
            }
          );
          aggregated.roiPct = portfolioCapital > 0
            ? (aggregated.netPnlUsd / portfolioCapital) * 100
            : 0;
          setGlobalPerf(aggregated);
        } else {
          setGlobalPerf(null);
        }
        setSessionPerf(null);
      } else {
        const [data, metricsResponse, overviewData] = await Promise.all([
          api.getTrades(sessionId, params),
          api.getSessionMetrics(sessionId),
          api.overview(mode),
        ]);
        const meta = sessionMeta[sessionId];
        const decorated = data.map((trade: any) => ({
          ...trade,
          sessionId,
          sessionSymbol: trade.sessionSymbol ?? meta?.symbol,
          sessionMode: trade.sessionMode ?? meta?.mode,
          aggressiveness: (trade?.aggressiveness as AggressivenessLevel | undefined) ?? meta?.aggressiveness ?? 'reactive',
        }));
        setRows(decorated as TradeRow[]);
        const metricsArray = Array.isArray(metricsResponse) ? metricsResponse : [metricsResponse];
        let matched = metricsArray.find((metric: SessionMetrics) => metric.sessionId === sessionId) || null;
        
        // Recalculate ROI based on portfolio capital pool instead of session startBalance
        if (matched) {
          const portfolioCapital = mode === 'paper'
            ? (overviewData?.paperBalance?.equityUsd ?? overviewData?.paperBalance?.freeUsd ?? 0)
            : (overviewData?.exchangeBalance?.totalUsd ?? 0);
          matched = {
            ...matched,
            startingBalanceUsd: portfolioCapital,
            roiPct: portfolioCapital > 0 ? (matched.netPnlUsd / portfolioCapital) * 100 : 0,
          };
        }
        
        setSessionPerf(matched);
        setGlobalPerf(null);
      }
    } catch (e: any) {
      message.error(String(e?.response?.data?.error || e?.message || 'Failed to load trades'));
    }
    setLoading(false);
  }, [limit, range, sessionId, sessionMeta, sessions, viewMode]);

  React.useEffect(() => {
    if (viewMode === 'session' && sessionId) loadTrades();
    else if (viewMode === 'global' && sessions.length) loadTrades();
  }, [sessionId, loadTrades, viewMode, sessions.length]);

  const resolveAggressiveness = React.useCallback(
    (row: TradeRow): AggressivenessLevel | undefined => {
      if (row.aggressiveness) return row.aggressiveness;
      if (row.sessionId && sessionMeta[row.sessionId]) {
        return sessionMeta[row.sessionId].aggressiveness;
      }
      return 'reactive';
    },
    [sessionMeta],
  );

  const resolveMode = React.useCallback(
    (row: TradeRow): string | undefined => {
      if (row.sessionMode) return row.sessionMode;
      if (row.sessionId && sessionMeta[row.sessionId]) {
        return sessionMeta[row.sessionId].mode;
      }
      return undefined;
    },
    [sessionMeta],
  );

  const data = React.useMemo(() => {
    let mapped = rows.map((row) => ({
      ...row,
      outcome: asOutcome(row),
    }));
    
    // Apply filters
    if (filterOutcome !== 'all') {
      mapped = mapped.filter((row) => row.outcome === filterOutcome);
    }
    
    if (filterSymbol !== 'all') {
      mapped = mapped.filter((row) => row.symbol === filterSymbol || row.sessionSymbol === filterSymbol);
    }

    if (searchText) {
      const search = searchText.toLowerCase();
      mapped = mapped.filter((row) =>
        row.symbol?.toLowerCase().includes(search) ||
        row.sessionSymbol?.toLowerCase().includes(search) ||
        row.positionSide?.toLowerCase().includes(search)
      );
    }

    if (filterSessionMode !== 'all') {
      mapped = mapped.filter((row) => resolveMode(row) === filterSessionMode);
    }

    if (aggressivenessFilter !== 'all') {
      mapped = mapped.filter((row) => resolveAggressiveness(row) === aggressivenessFilter);
    }

    return mapped;
  }, [rows, filterOutcome, filterSymbol, searchText, filterSessionMode, aggressivenessFilter, resolveMode, resolveAggressiveness]);

  // Get unique symbols for filter
  const symbols = React.useMemo(() => {
    const symbolSet = new Set<string>();
    rows.forEach(row => {
      if (row.symbol) symbolSet.add(row.symbol);
      if ((row as any).sessionSymbol) symbolSet.add((row as any).sessionSymbol);
    });
    return Array.from(symbolSet).sort();
  }, [rows]);

  const availableModes = React.useMemo(() => {
    const set = new Set<string>();
    rows.forEach((row) => {
      const mode = resolveMode(row);
      if (mode) set.add(mode);
    });
    return Array.from(set) as Array<'paper' | 'live'>;
  }, [rows, resolveMode]);

  const availableAggressiveness = React.useMemo(() => {
    const set = new Set<AggressivenessLevel>();
    rows.forEach((row) => {
      const level = resolveAggressiveness(row);
      if (level) set.add(level);
    });
    return Array.from(set);
  }, [rows, resolveAggressiveness]);

  const summary = React.useMemo(() => {
    const metrics = viewMode === 'global' ? globalPerf : sessionPerf;
    if (!rows.length && !metrics) return null;
    const base = rows.reduce(
      (acc, row) => {
        const outcome = asOutcome(row);
        const pnlUsd = Number(row.realizedPnlUsd ?? 0);
        const leverageValue = Number(row.leverage ?? row.estLev ?? NaN);

        acc.trades += 1;
        if (outcome === 'win') {
          acc.wins += 1;
          if (pnlUsd > 0) acc.winPnls.push(pnlUsd);
          if (Number.isFinite(leverageValue) && leverageValue > 0) acc.winLeverages.push(leverageValue);
        }
        if (outcome === 'loss') {
          acc.losses += 1;
          if (pnlUsd < 0) acc.lossPnls.push(pnlUsd);
          if (Number.isFinite(leverageValue) && leverageValue > 0) acc.lossLeverages.push(leverageValue);
        }
        if (Number.isFinite(leverageValue) && leverageValue > 0) acc.allLeverages.push(leverageValue);
        return acc;
      },
      { trades: 0, wins: 0, losses: 0, winPnls: [] as number[], lossPnls: [] as number[], allLeverages: [] as number[], winLeverages: [] as number[], lossLeverages: [] as number[] }
    );
    const winRate = base.trades ? base.wins / base.trades : 0;
    const avgWinUsd = base.winPnls.length
      ? base.winPnls.reduce((sum, value) => sum + value, 0) / base.winPnls.length
      : 0;
    const avgLossUsd = base.lossPnls.length
      ? Math.abs(base.lossPnls.reduce((sum, value) => sum + value, 0) / base.lossPnls.length)
      : 0;
    const riskRewardRatio = avgLossUsd > 0 ? avgWinUsd / avgLossUsd : 0;
    const avgLeverage = base.allLeverages.length
      ? base.allLeverages.reduce((sum, value) => sum + value, 0) / base.allLeverages.length
      : null;
    const avgWinLeverage = base.winLeverages.length
      ? base.winLeverages.reduce((sum, value) => sum + value, 0) / base.winLeverages.length
      : null;
    const avgLossLeverage = base.lossLeverages.length
      ? base.lossLeverages.reduce((sum, value) => sum + value, 0) / base.lossLeverages.length
      : null;
    return {
      ...base,
      winRate,
      realizedPnlUsd: Number(metrics?.realizedPnlUsd ?? 0),
      feesUsd: Number(metrics?.feesUsd ?? 0),
      pnl: Number(metrics?.netPnlUsd ?? 0),
      roiPct: Number(metrics?.roiPct ?? 0),
      avgWinUsd,
      avgLossUsd,
      riskRewardRatio,
      avgLeverage,
      avgWinLeverage,
      avgLossLeverage,
    };
  }, [rows, sessionPerf, globalPerf, viewMode]);

  const exportCsv = React.useCallback(() => {
    if (!data.length) return;
    const headers = ['Date', 'Session', 'Symbol', 'Side', 'Qty', 'Entry', 'Exit', 'PnL_USD', 'PnL_%', 'Leverage', 'EstLev', 'Aggressiveness', 'Mode', 'Outcome'];
    const lines = data.map((row) => [
      dayjs(row.createdAt).format('YYYY-MM-DD HH:mm:ss'),
      row.sessionSymbol ?? '',
      row.symbol,
      row.positionSide,
      Number(row.qty || 0).toFixed(4),
      row.entryPrice != null ? Number(row.entryPrice).toFixed(4) : '',
      row.exitPrice != null ? Number(row.exitPrice).toFixed(4) : '',
      Number(row.realizedPnlUsd || 0).toFixed(2),
      row.pctChange != null ? Number(row.pctChange).toFixed(2) : '',
      row.leverage != null ? Number(row.leverage).toFixed(2) : '',
      row.estLev != null ? Number(row.estLev).toFixed(2) : '',
      resolveAggressiveness(row) ?? '',
      resolveMode(row) ?? '',
      asOutcome(row),
    ].join(','));
    const csv = [headers.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `journal_${sessionId}_${dayjs().format('YYYYMMDD_HHmm')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data, resolveAggressiveness, resolveMode, sessionId]);

  const columns = React.useMemo(() => ([
    {
      title: 'Date',
      dataIndex: 'createdAt',
      width: 170,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
      sorter: (a: any, b: any) => dayjs(a.createdAt).valueOf() - dayjs(b.createdAt).valueOf(),
    },
    ...(viewMode === 'global' ? [{
      title: 'Session',
      dataIndex: 'sessionSymbol',
      width: 120,
      render: (v: string, record: any) => (
        <div>
          <div><strong>{v}</strong></div>
          <Text type="secondary" style={{ fontSize: '12px' }}>{record.sessionMode?.toUpperCase()}</Text>
        </div>
      ),
    }] : []),
    { title: 'Symbol', dataIndex: 'symbol', width: 110 },
    {
      title: 'Strategy',
      dataIndex: 'strategyUsed',
      width: 160,
      render: (strategy: string | null, row: TradeRow) => (
        <StrategyBadge 
          strategy={strategy} 
          confidence={row.strategyConfidence}
          size="small"
        />
      ),
    },
    {
      title: 'Aggressiveness',
      dataIndex: 'aggressiveness',
      width: 150,
      render: (value: AggressivenessLevel) => {
        const meta = value ? AGGRESSIVENESS_META[value] : undefined;
        return meta ? <Tag color={meta.color}>{meta.label}</Tag> : '—';
      },
    },
    {
      title: 'Side',
      dataIndex: 'positionSide',
      width: 90,
      render: (v: string) => <Tag color={v === 'long' ? 'green' : 'red'}>{v}</Tag>,
    },
    { title: 'Qty', dataIndex: 'qty', width: 90, render: (v: number) => Number(v || 0).toFixed(4) },
    { title: 'Entry', dataIndex: 'entryPrice', width: 100, render: (v: number) => v != null ? Number(v).toFixed(4) : '-' },
    { title: 'Exit', dataIndex: 'exitPrice', width: 100, render: (v: number) => v != null ? Number(v).toFixed(4) : '-' },
    { title: 'PnL (USD)', dataIndex: 'realizedPnlUsd', width: 120, render: (v: number) => <span style={{ color: Number(v || 0) >= 0 ? '#15803d' : '#b91c1c' }}>{formatUsd(v)}</span> },
    { title: 'PnL %', dataIndex: 'pctChange', width: 90, render: (v: number) => v != null ? `${Number(v).toFixed(2)}%` : '-' },
    { title: 'ROI est. %', dataIndex: 'roePct', width: 110, render: (v: number) => v != null ? `${Number(v).toFixed(2)}%` : '-' },
    { title: 'Leverage', dataIndex: 'leverage', width: 100, render: (v: number) => v != null ? `x${Number(v).toFixed(2)}` : '-' },
    { title: 'Est Lev', dataIndex: 'estLev', width: 100, render: (v: number) => v != null ? `x${Number(v).toFixed(2)}` : '-' },
    {
      title: 'Outcome',
      dataIndex: 'outcome',
      width: 110,
      render: (_: any, row: any) => {
        const outcome = row.outcome as Outcome;
        if (outcome === 'breakeven') return <Tag color='blue'>breakeven</Tag>;
        return <Tag color={outcome === 'win' ? 'green' : 'red'}>{outcome}</Tag>;
      },
    },
  ]), [viewMode]);

  const sessionOptions = sessions.map((s: any) => ({
    value: s.id,
    label: `${s.symbol} · ${s.mode?.toUpperCase?.() || ''}${!s.stoppedAt ? ' (active)' : ''}`,
  }));

  return (
    <Space direction='vertical' size='large' style={{ width: '100%' }}>
      {/* Enhanced Header with Global Stats */}
      <Card>
        <Title level={3}>📈 Execution Ledger</Title>
        <Row gutter={[16, 16]} align="middle">
          <Col span={24}>
            <Space wrap align='center'>
              {/* View Mode Toggle */}
              <Segmented
                value={viewMode}
                onChange={(val) => setViewMode(val as any)}
                options={[
                  { label: '📊 Session View', value: 'session' },
                  { label: '🌍 Global View', value: 'global' },
                ]}
              />
              
              {/* Session Selection - only show in session mode */}
              {viewMode === 'session' && (
                <Select
                  placeholder='Select Session'
                  style={{ minWidth: 240 }}
                  value={sessionId || undefined}
                  options={sessionOptions}
                  onChange={(v) => setSessionId(v)}
                />
              )}
              
              {/* Date Range */}
              <RangePicker 
                value={range} 
                onChange={(vals) => setRange(vals as [Dayjs | null, Dayjs | null])} 
                presets={[
                  { label: 'Last 7 days', value: [dayjs().subtract(7, 'day'), dayjs()] },
                  { label: 'Last 14 days', value: [dayjs().subtract(14, 'day'), dayjs()] },
                  { label: 'Last 30 days', value: [dayjs().subtract(30, 'day'), dayjs()] },
                  { label: 'This month', value: [dayjs().startOf('month'), dayjs()] },
                ]}
              />
              
              {/* Filters */}
              <Segmented
                value={filterOutcome}
                onChange={(val) => setFilterOutcome(val as any)}
                options={[
                  { label: 'All', value: 'all' },
                  { label: '✅ Wins', value: 'win' },
                  { label: '❌ Losses', value: 'loss' },
                  { label: '➖ Breakeven', value: 'breakeven' },
                ]}
              />
              
              {/* Symbol Filter */}
              <Select
                placeholder="Symbol Filter"
                style={{ minWidth: 120 }}
                value={filterSymbol}
                onChange={(v) => setFilterSymbol(v)}
                options={[
                  { label: 'All Symbols', value: 'all' },
                  ...symbols.map(symbol => ({ label: symbol, value: symbol }))
                ]}
              />

              {/* Mode Filter */}
              <Select<'all' | 'paper' | 'live'>
                placeholder="Mode"
                style={{ minWidth: 120 }}
                value={filterSessionMode}
                onChange={(val) => setFilterSessionMode(val)}
                options={[
                  { label: 'All Modes', value: 'all' },
                  ...availableModes.map((mode) => ({
                    label: mode.toUpperCase(),
                    value: mode,
                  })),
                ]}
                disabled={!availableModes.length}
              />

              {/* Aggressiveness Filter */}
              <Select<'all' | AggressivenessLevel>
                placeholder="Aggressiveness"
                style={{ minWidth: 160 }}
                value={aggressivenessFilter}
                onChange={(val) => setAggressivenessFilter(val)}
                options={[
                  { label: 'All Levels', value: 'all' },
                  ...availableAggressiveness.map((level) => ({
                    label: AGGRESSIVENESS_META[level].label,
                    value: level,
                  })),
                ]}
                disabled={!availableAggressiveness.length}
              />

              {/* Search */}
              <Input
                placeholder="Search symbols..."
                prefix={<SearchOutlined />}
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                style={{ width: 200 }}
                allowClear
              />
              
              {/* Limit and Actions */}
              <Space>
                <span>Limit</span>
                <InputNumber min={20} max={1000} step={50} value={limit} onChange={(v) => setLimit(Number(v || 20))} />
              </Space>
              
              <Tooltip title="Refresh Data">
                <Button 
                  icon={<ReloadOutlined />} 
                  onClick={loadTrades}
                  loading={loading}
                >
                  Refresh
                </Button>
              </Tooltip>
              
              <Tooltip title="Export to CSV">
                <Button 
                  icon={<DownloadOutlined />}
                  onClick={exportCsv} 
                  disabled={!data.length}
                >
                  Export
                </Button>
              </Tooltip>
            </Space>
          </Col>
        </Row>
      </Card>

      {/* Enhanced Summary Stats */}
      {summary && (
        <Card>
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={8} md={4}>
              <Statistic 
                title={`${viewMode === 'global' ? 'Total' : 'Session'} Trades`} 
                value={summary.trades} 
                valueStyle={{ color: '#1890ff' }}
              />
            </Col>
            <Col xs={24} sm={8} md={4}>
              <Statistic 
                title="Wins" 
                value={summary.wins} 
                valueStyle={{ color: '#52c41a' }}
              />
            </Col>
            <Col xs={24} sm={8} md={4}>
              <Statistic
                title="Losses"
                value={summary.losses}
                valueStyle={{ color: '#ff4d4f' }}
              />
            </Col>
            <Col xs={24} sm={8} md={4}>
              <Statistic
                title="Win Rate"
                value={summary.winRate * 100}
                suffix="%"
                precision={1}
                valueStyle={{
                  color: summary.winRate >= 0.6 ? '#52c41a' :
                         summary.winRate >= 0.5 ? '#faad14' : '#ff4d4f'
                }}
              />
            </Col>
            <Col xs={24} sm={8} md={4}>
              <Statistic
                title="Realized P&L"
                value={summary.realizedPnlUsd}
                precision={2}
                prefix="$"
                valueStyle={{ color: summary.realizedPnlUsd >= 0 ? '#52c41a' : '#ff4d4f' }}
              />
            </Col>
            <Col xs={24} sm={8} md={4}>
              <Statistic
                title="Fees Paid"
                value={summary.feesUsd}
                prefix="$"
                precision={2}
                valueStyle={{ color: '#64748b' }}
              />
            </Col>
            <Col xs={24} sm={8} md={4}>
              <Statistic
                title="Net P&L"
                value={summary.pnl}
                precision={2}
                prefix="$"
                valueStyle={{ color: summary.pnl >= 0 ? '#52c41a' : '#ff4d4f' }}
              />
            </Col>
            <Col xs={24} sm={8} md={4}>
              <Statistic
                title="ROI (net)"
                value={summary.roiPct}
                suffix="%"
                precision={2}
                valueStyle={{ color: summary.roiPct >= 0 ? '#52c41a' : '#ff4d4f' }}
              />
            </Col>
            <Col xs={24} sm={8} md={4}>
              <Statistic
                title="Avg Win (USD)"
                value={summary.avgWinUsd}
                prefix="$"
                precision={2}
                valueStyle={{ color: summary.avgWinUsd > 0 ? '#52c41a' : '#64748b' }}
              />
            </Col>
            <Col xs={24} sm={8} md={4}>
              <Statistic
                title="Avg Loss (USD)"
                value={summary.avgLossUsd}
                prefix="$"
                precision={2}
                valueStyle={{ color: summary.avgLossUsd > 0 ? '#ff4d4f' : '#64748b' }}
              />
            </Col>
            <Col xs={24} sm={8} md={4}>
              <Statistic
                title="Win/Loss Ratio"
                value={summary.riskRewardRatio}
                precision={2}
                valueStyle={{
                  color:
                    summary.riskRewardRatio >= 1.2
                      ? '#52c41a'
                      : summary.riskRewardRatio >= 0.9
                        ? '#faad14'
                        : '#ff4d4f'
                }}
              />
            </Col>
            <Col xs={24} sm={8} md={4}>
              <Statistic
                title="Avg Leverage"
                value={summary.avgLeverage ?? 0}
                precision={2}
                suffix={summary.avgLeverage != null ? 'x' : undefined}
                formatter={(value) => (summary.avgLeverage != null ? Number(value).toFixed(2) : '-')}
                valueStyle={{
                  color:
                    summary.avgLeverage == null
                      ? '#64748b'
                      : summary.avgLeverage >= 1.5
                        ? '#52c41a'
                        : summary.avgLeverage >= 1.0
                          ? '#faad14'
                          : '#ff4d4f'
                }}
              />
            </Col>
            {summary.avgWinLeverage != null && summary.avgLossLeverage != null && (
              <>
                <Col xs={24} sm={8} md={4}>
                  <Statistic
                    title="Avg Win Lev"
                    value={summary.avgWinLeverage}
                    precision={2}
                    suffix="x"
                    valueStyle={{ color: '#52c41a' }}
                  />
                </Col>
                <Col xs={24} sm={8} md={4}>
                  <Statistic
                    title="Avg Loss Lev"
                    value={summary.avgLossLeverage}
                    precision={2}
                    suffix="x"
                    valueStyle={{ color: '#ff4d4f' }}
                  />
                </Col>
              </>
            )}
          </Row>
          {(() => {
            const riskSkew = summary.wins > 0 && summary.losses > 0 && summary.avgWinUsd < summary.avgLossUsd;
            const leverageLow = summary.avgLeverage != null && summary.avgLeverage < 1.2;
            if (!riskSkew && !leverageLow) return null;
            return (
              <Alert
                style={{ marginTop: 16 }}
                type='warning'
                showIcon
                message='Risk/Reward imbalance detected'
                description={(
                  <Space direction='vertical' size={4}>
                    {riskSkew && (
                      <span>
                        Average win {formatUsd(summary.avgWinUsd)} vs average loss {formatUsd(summary.avgLossUsd)} → ratio
                        {` ${summary.riskRewardRatio.toFixed(2)}.`} Consider tightening stops or scaling winners to improve the
                        payoff profile.
                      </span>
                    )}
                    {leverageLow && (
                      <span>
                        Average leverage {summary.avgLeverage?.toFixed(2)}x indicates under-utilised exposure on winners.
                        Review position sizing rules to ensure gains can offset losses when conviction is high.
                      </span>
                    )}
                  </Space>
                )}
              />
            );
          })()}
        </Card>
      )}

      {/* Enhanced Trades Table */}
      <Card title={`📊 ${viewMode === 'global' ? 'All Sessions' : 'Session'} Execution Ledger`}>
        <Table
          rowKey='id'
          loading={loading}
          dataSource={data}
          columns={columns}
          pagination={{ 
            pageSize: 15, 
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} trades`
          }}
          scroll={{ x: viewMode === 'global' ? 1200 : 900 }}
          size="small"
        />
      </Card>
    </Space>
  );
}
