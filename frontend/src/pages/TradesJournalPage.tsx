import React from 'react';
import { Card, Table, Select, Space, DatePicker, Segmented, Button, Statistic, Tag, message, InputNumber } from 'antd';
import dayjs, { Dayjs } from 'dayjs';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';

const { RangePicker } = DatePicker;

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
  const [loading, setLoading] = React.useState(false);
  const [filterOutcome, setFilterOutcome] = React.useState<'all' | Outcome>('all');
  const [range, setRange] = React.useState<[Dayjs | null, Dayjs | null]>([dayjs().subtract(14, 'day'), dayjs()]);
  const [limit, setLimit] = React.useState<number>(200);
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
    if (!sessionId) return;
    setLoading(true);
    try {
      const params: { from?: string; to?: string; limit?: number } = { limit };
      if (range[0]) params.from = range[0].startOf('day').toISOString();
      if (range[1]) params.to = range[1].endOf('day').add(1, 'day').toISOString();
      const data = await api.getTrades(sessionId, params);
      setRows(data);
    } catch (e: any) {
      message.error(String(e?.response?.data?.error || e?.message || 'Failed to load trades'));
    }
    setLoading(false);
  }, [sessionId, range, limit]);

  React.useEffect(() => {
    if (sessionId) loadTrades();
  }, [sessionId, loadTrades]);

  const data = React.useMemo(() => {
    const mapped = rows.map((row) => ({
      ...row,
      outcome: asOutcome(row),
    }));
    if (filterOutcome === 'all') return mapped;
    return mapped.filter((row) => row.outcome === filterOutcome);
  }, [rows, filterOutcome]);

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
  ]), []);

  const sessionOptions = sessions.map((s: any) => ({
    value: s.id,
    label: `${s.symbol} · ${s.mode?.toUpperCase?.() || ''}${!s.stoppedAt ? ' (active)' : ''}`,
  }));

  return (
    <Space direction='vertical' size='large' style={{ width: '100%' }}>
      <Card>
        <Space wrap align='center'>
          <Select
            placeholder='Session'
            style={{ minWidth: 240 }}
            value={sessionId || undefined}
            options={sessionOptions}
            onChange={(v) => setSessionId(v)}
          />
          <RangePicker value={range} onChange={(vals) => setRange(vals as [Dayjs | null, Dayjs | null])} />
          <Segmented
            value={filterOutcome}
            onChange={(val) => setFilterOutcome(val as any)}
            options={[
              { label: 'All', value: 'all' },
              { label: 'Wins', value: 'win' },
              { label: 'Losses', value: 'loss' },
              { label: 'Breakeven', value: 'breakeven' },
            ]}
          />
          <Space>
            <span>Limit</span>
            <InputNumber min={20} max={500} step={20} value={limit} onChange={(v) => setLimit(Number(v || 20))} />
          </Space>
          <Button onClick={loadTrades}>Refresh</Button>
          <Button onClick={exportCsv} disabled={!data.length}>Export CSV</Button>
          {summary && (
            <Space size='large'>
              <Statistic title='Trades' value={summary.trades} />
              <Statistic title='Wins' value={summary.wins} />
              <Statistic title='Losses' value={summary.losses} />
              <Statistic title='Win rate' value={summary.winRate * 100} suffix='%' precision={1} />
              <Statistic title='PnL (USD)' value={summary.pnl} precision={2} valueStyle={{ color: summary.pnl >= 0 ? '#15803d' : '#b91c1c' }} />
              <Statistic title='Avg ROI %' value={summary.avgRoe} precision={2} />
            </Space>
          )}
        </Space>
      </Card>

      <Card title='Trades Journal'>
        <Table
          rowKey='id'
          loading={loading}
          dataSource={data}
          columns={columns}
          pagination={{ pageSize: 15 }}
          scroll={{ x: 900 }}
        />
      </Card>
    </Space>
  );
}
