import React from 'react';
import { Card, Table, Select, Space, DatePicker, Segmented, Button, Statistic, Tag, message, InputNumber, Row, Col, Input, Tooltip, Typography } from 'antd';
import { SearchOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';

const { RangePicker } = DatePicker;
const { Title, Text } = Typography;

type Outcome = 'win' | 'loss' | 'breakeven';

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
};

function asOutcome(row: TradeRow): Outcome {
  const pnl = Number(row.realizedPnlUsd || 0);
  if (Math.abs(pnl) < 1e-8) return 'breakeven';
  return pnl > 0 ? 'win' : 'loss';
}

function formatUsd(v?: number | null, digits = 2) {
  if (v == null || Number.isNaN(Number(v))) return '-';
  return `$${Number(v).toFixed(digits)}`;
}

export default function TradesJournalPage() {
  const [sessions, setSessions] = React.useState<any[]>([]);
  const [sessionId, setSessionId] = React.useState<string>('');
  const [rows, setRows] = React.useState<TradeRow[]>([]);
  const [allSessionData, setAllSessionData] = React.useState<TradeRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [filterOutcome, setFilterOutcome] = React.useState<'all' | Outcome>('all');
  const [filterSymbol, setFilterSymbol] = React.useState<string>('all');
  const [searchText, setSearchText] = React.useState<string>('');
  const [range, setRange] = React.useState<[Dayjs | null, Dayjs | null]>([dayjs().subtract(14, 'day'), dayjs()]);
  const [limit, setLimit] = React.useState<number>(200);
  const [viewMode, setViewMode] = React.useState<'session' | 'global'>('session');
  const { mode } = useMode();

  React.useEffect(() => {
    (async () => {
      try {
        const list = await api.listSessions(mode);
        setSessions(list);
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
        // Load data from all sessions
        const allData = await Promise.all(
          sessions.map(async (session) => {
            try {
              const res = await api.getTrades(session.id, params);
              const data = Array.isArray(res) ? res : (res?.trades || []);
              return data.map((trade: any) => ({ ...trade, sessionSymbol: session.symbol, sessionMode: session.mode }));
            } catch {
              return [];
            }
          })
        );
        const flatData = allData.flat().sort((a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf());
        setAllSessionData(flatData);
        setRows(flatData);
      } else {
        // Load data from selected session only
        const res = await api.getTrades(sessionId, params);
        const data = Array.isArray(res) ? res : (res?.trades || []);
        setRows(data);
      }
    } catch (e: any) {
      message.error(String(e?.response?.data?.error || e?.message || 'Failed to load trades'));
    }
    setLoading(false);
  }, [sessionId, range, limit, viewMode, sessions]);

  React.useEffect(() => {
    if (viewMode === 'session' && sessionId) loadTrades();
    else if (viewMode === 'global' && sessions.length) loadTrades();
  }, [sessionId, loadTrades, viewMode, sessions.length]);

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
    
    return mapped;
  }, [rows, filterOutcome, filterSymbol, searchText]);

  // Get unique symbols for filter
  const symbols = React.useMemo(() => {
    const symbolSet = new Set<string>();
    rows.forEach(row => {
      if (row.symbol) symbolSet.add(row.symbol);
      if ((row as any).sessionSymbol) symbolSet.add((row as any).sessionSymbol);
    });
    return Array.from(symbolSet).sort();
  }, [rows]);

  const summary = React.useMemo(() => {
    if (!rows.length) return null;
    const base = rows.reduce((acc, row) => {
      const pnl = Number(row.realizedPnlUsd || 0);
      const outcome = asOutcome(row);
      acc.trades += 1;
      if (outcome === 'win') acc.wins += 1;
      if (outcome === 'loss') acc.losses += 1;
      acc.pnl += pnl;
      acc.avgRoe += Number(row.roePct || 0);
      return acc;
    }, { trades: 0, wins: 0, losses: 0, pnl: 0, avgRoe: 0 });
    const winRate = base.trades ? base.wins / base.trades : 0;
    const avgRoe = base.trades ? base.avgRoe / base.trades : 0;
    return { ...base, winRate, avgRoe };
  }, [rows]);

  const exportCsv = React.useCallback(() => {
    if (!data.length) return;
    const headers = ['Date', 'Symbol', 'Side', 'Qty', 'Entry', 'Exit', 'PnL_USD', 'PnL_%', 'Leverage', 'EstLev', 'Outcome'];
    const lines = data.map((row) => [
      dayjs(row.createdAt).format('YYYY-MM-DD HH:mm:ss'),
      row.symbol,
      row.positionSide,
      Number(row.qty || 0).toFixed(4),
      row.entryPrice != null ? Number(row.entryPrice).toFixed(4) : '',
      row.exitPrice != null ? Number(row.exitPrice).toFixed(4) : '',
      Number(row.realizedPnlUsd || 0).toFixed(2),
      row.pctChange != null ? Number(row.pctChange).toFixed(2) : '',
      row.leverage != null ? Number(row.leverage).toFixed(2) : '',
      row.estLev != null ? Number(row.estLev).toFixed(2) : '',
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
  }, [data, sessionId]);

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
        <Title level={3}>📖 Comprehensive Trading Journal</Title>
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
                valueStyle={{ color: 'var(--success)' }}
              />
            </Col>
            <Col xs={24} sm={8} md={4}>
              <Statistic 
                title="Losses" 
                value={summary.losses} 
                valueStyle={{ color: 'var(--error)' }}
              />
            </Col>
            <Col xs={24} sm={8} md={4}>
              <Statistic 
                title="Win Rate" 
                value={summary.winRate * 100} 
                suffix="%" 
                precision={1}
                valueStyle={{ 
                  color: summary.winRate >= 0.6 ? 'var(--success)' : 
                         summary.winRate >= 0.5 ? '#faad14' : 'var(--error)' 
                }}
              />
            </Col>
            <Col xs={24} sm={8} md={4}>
              <Statistic 
                title="Total P&L" 
                value={summary.pnl} 
                precision={2} 
                prefix="$"
                valueStyle={{ color: summary.pnl >= 0 ? 'var(--success)' : 'var(--error)' }}
              />
            </Col>
            <Col xs={24} sm={8} md={4}>
              <Statistic 
                title="Avg ROI" 
                value={summary.avgRoe} 
                suffix="%" 
                precision={2}
                valueStyle={{ color: summary.avgRoe >= 0 ? 'var(--success)' : 'var(--error)' }}
              />
            </Col>
          </Row>
        </Card>
      )}

      {/* Enhanced Trades Table */}
      <Card title={`📊 ${viewMode === 'global' ? 'All Sessions' : 'Session'} Trades Journal`}>
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
