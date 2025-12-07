import React from 'react';
import { Card, Table, Space, Button, Statistic, Typography, theme, Row, Col, message, Tag, Input } from 'antd';
import { ReloadOutlined, DownloadOutlined, SearchOutlined } from '../icons';
import type { ColumnsType } from 'antd/es/table/interface';
import dayjs from 'dayjs';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';

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
  realizedPnlUsd?: number | null;
  leverage?: number | null;
  sessionSymbol?: string;
  sessionMode?: string;
  sessionId?: string;
  outcome?: Outcome;
  // V5.11: New fields for detailed trade analysis
  roePct?: number | null;
  notionalUsd?: number | null;
  exitReason?: string | null;
  durationMinutes?: number | null;
  maxPnlPct?: number | null;
  feesUsd?: number | null;
};

function formatUsd(v?: number | null, digits = 2) {
  if (v == null || Number.isNaN(Number(v))) return '-';
  return `$${Number(v).toFixed(digits)}`;
}

function resolvePerformanceSignal(row: TradeRow): number {
  const realized = Number(row.realizedPnlUsd ?? 0);
  if (!Number.isFinite(realized)) return 0;
  return realized;
}

function asOutcome(row: TradeRow): Outcome {
  const signal = resolvePerformanceSignal(row);
  if (Math.abs(signal) < 1e-8) return 'breakeven';
  return signal > 0 ? 'win' : 'loss';
}

export default function ExecutionLedgerPageNew() {
  const [trades, setTrades] = React.useState<TradeRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [searchText, setSearchText] = React.useState('');
  const { mode } = useMode();
  const { token } = theme.useToken();

  // Calculate summary metrics
  const summary = React.useMemo(() => {
    if (!trades.length) return null;
    
    let wins = 0;
    let losses = 0;
    let totalPnl = 0;
    let totalFees = 0;

    trades.forEach(trade => {
      const pnl = Number(trade.realizedPnlUsd ?? 0);
      totalPnl += pnl;
      
      // Estimate fees as 0.1% of notional value
      const notional = (trade.entryPrice ?? 0) * trade.qty;
      totalFees += notional * 0.001;

      const outcome = asOutcome(trade);
      if (outcome === 'win') wins++;
      else if (outcome === 'loss') losses++;
    });

    const winRate = trades.length ? (wins / trades.length) * 100 : 0;
    const netPnl = totalPnl - totalFees;
    
    return {
      total: trades.length,
      wins,
      losses,
      winRate,
      totalPnl,
      totalFees,
      netPnl,
    };
  }, [trades]);

  const loadTrades = React.useCallback(async () => {
    setLoading(true);
    try {
      // Load all trades across all sessions
      const sessionsList = await api.listSessions(mode);
      
      const allTrades: TradeRow[] = [];
      
      // Load trades from all active and recent sessions
      for (const session of sessionsList.slice(0, 20)) {
        try {
          const res = await api.getTrades(session.id, { limit: 100 });
          const sessionTrades = Array.isArray(res) ? res : (res?.trades || []);
          const decorated = sessionTrades.map((trade: any) => ({
            ...trade,
            sessionId: session.id,
            sessionSymbol: session.symbol,
            sessionMode: session.mode,
            outcome: asOutcome(trade),
          }));
          allTrades.push(...decorated);
        } catch (err) {
          console.error(`Failed to load trades for session ${session.id}:`, err);
        }
      }
      
      // Sort by date descending
      allTrades.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      
      setTrades(allTrades);
    } catch (e: any) {
      message.error(String(e?.response?.data?.error || e?.message || 'Failed to load trades'));
    }
    setLoading(false);
  }, [mode]);

  React.useEffect(() => {
    void loadTrades();
  }, [loadTrades]);

  const exportCsv = () => {
    if (!trades.length) return;
    
    const headers = ['Date', 'Session', 'Symbol', 'Side', 'Quantity', 'Entry', 'Exit', 'PnL_USD', 'ROE_Pct', 'Notional_USD', 'Leverage', 'Duration_Min', 'Exit_Reason', 'Max_PnL_Pct', 'Fees_USD', 'Outcome', 'Mode'];
    const rows = trades.map(trade => [
      dayjs(trade.createdAt).format('YYYY-MM-DD HH:mm:ss'),
      trade.sessionSymbol ?? '',
      trade.symbol,
      trade.positionSide,
      trade.qty?.toFixed(4) ?? '',
      trade.entryPrice?.toFixed(4) ?? '',
      trade.exitPrice?.toFixed(4) ?? '',
      trade.realizedPnlUsd?.toFixed(2) ?? '',
      trade.roePct?.toFixed(2) ?? '',
      trade.notionalUsd?.toFixed(2) ?? '',
      trade.leverage?.toFixed(2) ?? '',
      trade.durationMinutes ?? '',
      trade.exitReason ?? '',
      trade.maxPnlPct?.toFixed(2) ?? '',
      trade.feesUsd?.toFixed(2) ?? '',
      trade.outcome ?? '',
      trade.sessionMode?.toUpperCase() ?? '',
    ].join(','));
    
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trades_export_${dayjs().format('YYYYMMDD_HHmmss')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns: ColumnsType<TradeRow> = [
    {
      title: 'Date',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (val: string) => dayjs(val).format('YYYY-MM-DD HH:mm:ss'),
      sorter: (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      defaultSortOrder: 'descend',
    },
    {
      title: 'Session',
      dataIndex: 'sessionSymbol',
      key: 'sessionSymbol',
      width: 120,
      filters: Array.from(new Set(trades.map(t => t.sessionSymbol))).filter(Boolean).map(sym => ({
        text: sym!,
        value: sym!,
      })),
      onFilter: (value, record) => record.sessionSymbol === value,
      render: (val: string, record) => (
        <div>
          <div style={{ fontWeight: 600 }}>{val}</div>
          <Text type="secondary" style={{ fontSize: 11 }}>{record.sessionMode?.toUpperCase()}</Text>
        </div>
      ),
    },
    {
      title: 'Symbol',
      dataIndex: 'symbol',
      key: 'symbol',
      width: 110,
      filters: Array.from(new Set(trades.map(t => t.symbol))).map(sym => ({
        text: sym,
        value: sym,
      })),
      onFilter: (value, record) => record.symbol === value,
    },
    {
      title: 'Side',
      dataIndex: 'positionSide',
      key: 'positionSide',
      width: 100,
      filters: [
        { text: 'LONG', value: 'long' },
        { text: 'SHORT', value: 'short' },
      ],
      onFilter: (value, record) => record.positionSide?.toLowerCase() === value,
      render: (val: string) => (
        <Tag color={val?.toLowerCase() === 'long' ? 'green' : 'red'}>
          {val?.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: 'Quantity',
      dataIndex: 'qty',
      key: 'qty',
      width: 120,
      align: 'right',
      render: (val: number) => val?.toFixed(4) ?? '-',
      sorter: (a, b) => (a.qty ?? 0) - (b.qty ?? 0),
    },
    {
      title: 'Entry',
      dataIndex: 'entryPrice',
      key: 'entryPrice',
      width: 120,
      align: 'right',
      render: (val: number) => val?.toFixed(4) ?? '-',
      sorter: (a, b) => (a.entryPrice ?? 0) - (b.entryPrice ?? 0),
    },
    {
      title: 'Exit',
      dataIndex: 'exitPrice',
      key: 'exitPrice',
      width: 120,
      align: 'right',
      render: (val: number) => val?.toFixed(4) ?? '-',
      sorter: (a, b) => (a.exitPrice ?? 0) - (b.exitPrice ?? 0),
    },
    {
      title: 'P&L (USD)',
      dataIndex: 'realizedPnlUsd',
      key: 'realizedPnlUsd',
      width: 120,
      align: 'right',
      render: (val: number) => (
        <span style={{ 
          color: (val ?? 0) >= 0 ? '#16a34a' : '#dc2626',
          fontWeight: 600,
        }}>
          {formatUsd(val)}
        </span>
      ),
      sorter: (a, b) => (a.realizedPnlUsd ?? 0) - (b.realizedPnlUsd ?? 0),
    },
    {
      title: 'ROE %',
      dataIndex: 'roePct',
      key: 'roePct',
      width: 90,
      align: 'right',
      render: (val: number) => (
        <span style={{ 
          color: (val ?? 0) >= 0 ? '#16a34a' : '#dc2626',
          fontWeight: 500,
        }}>
          {val != null ? `${val >= 0 ? '+' : ''}${val.toFixed(1)}%` : '-'}
        </span>
      ),
      sorter: (a, b) => (a.roePct ?? 0) - (b.roePct ?? 0),
    },
    {
      title: 'Notional',
      dataIndex: 'notionalUsd',
      key: 'notionalUsd',
      width: 110,
      align: 'right',
      render: (val: number) => val != null ? `$${val.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '-',
      sorter: (a, b) => (a.notionalUsd ?? 0) - (b.notionalUsd ?? 0),
    },
    {
      title: 'Leverage',
      dataIndex: 'leverage',
      key: 'leverage',
      width: 80,
      align: 'right',
      render: (val: number) => val ? `${val.toFixed(1)}x` : '-',
      sorter: (a, b) => (a.leverage ?? 0) - (b.leverage ?? 0),
    },
    {
      title: 'Duration',
      dataIndex: 'durationMinutes',
      key: 'durationMinutes',
      width: 90,
      align: 'right',
      render: (val: number) => {
        if (val == null) return '-';
        if (val < 60) return `${val}m`;
        if (val < 1440) return `${(val / 60).toFixed(1)}h`;
        return `${(val / 1440).toFixed(1)}d`;
      },
      sorter: (a, b) => (a.durationMinutes ?? 0) - (b.durationMinutes ?? 0),
    },
    {
      title: 'Exit',
      dataIndex: 'exitReason',
      key: 'exitReason',
      width: 80,
      render: (val: string) => {
        if (!val) return '-';
        const colorMap: Record<string, string> = {
          'TRAIL': 'green',
          'SL': 'red',
          'TIME': 'orange',
          'SIGNAL': 'blue',
          'MANUAL': 'purple',
        };
        return <Tag color={colorMap[val] || 'default'}>{val}</Tag>;
      },
      filters: [
        { text: 'Trail', value: 'TRAIL' },
        { text: 'Stop Loss', value: 'SL' },
        { text: 'Time', value: 'TIME' },
        { text: 'Signal', value: 'SIGNAL' },
      ],
      onFilter: (value, record) => record.exitReason === value,
    },
    {
      title: 'Max PnL',
      dataIndex: 'maxPnlPct',
      key: 'maxPnlPct',
      width: 85,
      align: 'right',
      render: (val: number, record: TradeRow) => {
        if (val == null) return '-';
        const missed = val - (record.roePct ?? 0);
        return (
          <span title={missed > 1 ? `Missed: +${missed.toFixed(1)}%` : undefined}>
            {val >= 0 ? '+' : ''}{val.toFixed(1)}%
          </span>
        );
      },
      sorter: (a, b) => (a.maxPnlPct ?? 0) - (b.maxPnlPct ?? 0),
    },
    {
      title: 'Fees',
      dataIndex: 'feesUsd',
      key: 'feesUsd',
      width: 80,
      align: 'right',
      render: (val: number) => val != null ? `-$${val.toFixed(2)}` : '-',
      sorter: (a, b) => (a.feesUsd ?? 0) - (b.feesUsd ?? 0),
    },
    {
      title: 'Outcome',
      dataIndex: 'outcome',
      key: 'outcome',
      width: 100,
      filters: [
        { text: 'Win', value: 'win' },
        { text: 'Loss', value: 'loss' },
        { text: 'Breakeven', value: 'breakeven' },
      ],
      onFilter: (value, record) => record.outcome === value,
      render: (val: Outcome) => {
        const colorMap = { win: 'green', loss: 'red', breakeven: 'blue' };
        return <Tag color={colorMap[val]}>{val?.toUpperCase()}</Tag>;
      },
    },
  ];

  const filteredData = React.useMemo(() => {
    if (!searchText) return trades;
    const search = searchText.toLowerCase();
    return trades.filter(trade => 
      trade.symbol?.toLowerCase().includes(search) ||
      trade.sessionSymbol?.toLowerCase().includes(search) ||
      trade.positionSide?.toLowerCase().includes(search)
    );
  }, [trades, searchText]);

  const isDark = token.colorBgBase.toLowerCase() === '#0f172a' || token.colorBgBase.toLowerCase() === '#000000';

  return (
    <Space direction='vertical' size='large' style={{ width: '100%', padding: '24px' }}>
      <Card
        style={{
          borderRadius: 16,
          border: `1px solid ${token.colorBorderSecondary}`,
          background: isDark ? 'rgba(15, 23, 42, 0.6)' : token.colorBgContainer,
        }}
        bodyStyle={{ padding: '24px' }}
      >
        <Space direction='vertical' size={16} style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
            <Title level={3} style={{ margin: 0 }}>
              📊 Execution Ledger
            </Title>
            <Space>
              <Input
                placeholder="Search..."
                prefix={<SearchOutlined />}
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                style={{ width: 200 }}
                allowClear
              />
              <Button
                icon={<ReloadOutlined />}
                onClick={() => void loadTrades()}
                loading={loading}
              >
                Refresh
              </Button>
              <Button
                icon={<DownloadOutlined />}
                onClick={exportCsv}
                disabled={!trades.length}
              >
                Export CSV
              </Button>
            </Space>
          </div>

          {summary && (
            <Row gutter={[24, 16]}>
              <Col xs={12} sm={8} md={4}>
                <Statistic
                  title={<Text style={{ fontSize: 12, color: token.colorTextSecondary }}>Total Trades</Text>}
                  value={summary.total}
                  valueStyle={{ fontSize: 24, fontWeight: 600, color: token.colorText }}
                />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic
                  title={<Text style={{ fontSize: 12, color: token.colorTextSecondary }}>Wins / Losses</Text>}
                  value={`${summary.wins} / ${summary.losses}`}
                  valueStyle={{ fontSize: 24, fontWeight: 600, color: token.colorText }}
                />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic
                  title={<Text style={{ fontSize: 12, color: token.colorTextSecondary }}>Win Rate</Text>}
                  value={summary.winRate}
                  precision={1}
                  suffix='%'
                  valueStyle={{ fontSize: 24, fontWeight: 600, color: '#0ea5e9' }}
                />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic
                  title={<Text style={{ fontSize: 12, color: token.colorTextSecondary }}>Total P&L</Text>}
                  value={Math.abs(summary.totalPnl)}
                  precision={2}
                  prefix={summary.totalPnl >= 0 ? '+$' : '-$'}
                  valueStyle={{ 
                    fontSize: 24, 
                    fontWeight: 600, 
                    color: summary.totalPnl >= 0 ? '#16a34a' : '#dc2626' 
                  }}
                />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic
                  title={<Text style={{ fontSize: 12, color: token.colorTextSecondary }}>Total Fees</Text>}
                  value={summary.totalFees}
                  precision={2}
                  prefix='-$'
                  valueStyle={{ fontSize: 24, fontWeight: 600, color: '#f97316' }}
                />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic
                  title={<Text style={{ fontSize: 12, color: token.colorTextSecondary }}>Net P&L</Text>}
                  value={Math.abs(summary.netPnl)}
                  precision={2}
                  prefix={summary.netPnl >= 0 ? '+$' : '-$'}
                  valueStyle={{ 
                    fontSize: 24, 
                    fontWeight: 600, 
                    color: summary.netPnl >= 0 ? '#16a34a' : '#dc2626' 
                  }}
                />
              </Col>
            </Row>
          )}
        </Space>
      </Card>

      <Card
        style={{
          borderRadius: 16,
          border: `1px solid ${token.colorBorderSecondary}`,
          background: isDark ? 'rgba(15, 23, 42, 0.6)' : token.colorBgContainer,
        }}
        bodyStyle={{ padding: 0 }}
      >
        <Table
          columns={columns}
          dataSource={filteredData}
          rowKey="id"
          loading={loading}
          pagination={{
            pageSize: 50,
            showSizeChanger: true,
            pageSizeOptions: ['25', '50', '100', '200'],
            showTotal: (total) => `Total ${total} trades`,
          }}
          scroll={{ x: 1600 }}
          size="middle"
        />
      </Card>
    </Space>
  );
}
