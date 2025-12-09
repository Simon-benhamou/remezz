import React from 'react';
import { Card, Empty, Space, Table, Tag, Tooltip, Typography, theme } from 'antd';
import { TrendingUp, TrendingDown, Clock, DollarSign, Percent, ArrowRightLeft, Target } from 'lucide-react';

const { Text } = Typography;

type TradeRow = {
  id: string;
  createdAt: string;
  entryTimestamp?: string;
  symbol?: string;
  positionSide?: string;
  qty?: number;
  entryPrice?: number | null;
  exitPrice?: number | null;
  realizedPnlUsd?: number;
  roePct?: number | null;
  estLev?: number | null;
  exitReason?: string;
};

type Props = {
  trades: TradeRow[];
  loading?: boolean;
  onRefresh?: () => void;
};

function formatUsd(value?: number | null) {
  if (value == null || Number.isNaN(value)) return '$0.00';
  const sign = value >= 0 ? '' : '-';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatNumber(value?: number | null, digits = 2) {
  if (value == null || Number.isNaN(value)) return '—';
  const formatted = Number(value).toFixed(digits);
  return parseFloat(formatted).toString();
}

function formatTimestamp(ts?: string) {
  if (!ts) return '—';
  const date = new Date(ts);
  const month = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${month} ${time}`;
}

function formatDuration(entryTs?: string, exitTs?: string) {
  if (!entryTs || !exitTs) return '—';
  const entry = new Date(entryTs).getTime();
  const exit = new Date(exitTs).getTime();
  const diffMs = exit - entry;
  
  if (diffMs < 0) return '—';
  
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function getExitReasonDisplay(reason?: string): { label: string; color: string; emoji: string } {
  if (!reason) return { label: 'Unknown', color: 'default', emoji: '❓' };
  
  const lowerReason = reason.toLowerCase();
  
  if (lowerReason.includes('tp') || lowerReason.includes('take_profit') || lowerReason.includes('takeprofit')) {
    return { label: 'TP', color: 'success', emoji: '🎯' };
  }
  if (lowerReason.includes('trail')) {
    return { label: 'Trail', color: 'blue', emoji: '📈' };
  }
  if (lowerReason.includes('sl') || lowerReason.includes('stop_loss') || lowerReason.includes('stoploss')) {
    return { label: 'SL', color: 'error', emoji: '🛑' };
  }
  if (lowerReason.includes('manual')) {
    return { label: 'Manual', color: 'purple', emoji: '👤' };
  }
  if (lowerReason.includes('signal') || lowerReason.includes('reversal')) {
    return { label: 'Signal', color: 'orange', emoji: '⚡' };
  }
  
  return { label: reason.slice(0, 8), color: 'default', emoji: '📊' };
}

const RecentTradesTable: React.FC<Props> = ({ trades, loading, onRefresh }) => {
  const { token } = theme.useToken();
  const base = token.colorBgBase.toLowerCase();
  const isDarkTheme = !['#ffffff', '#fff', '#fafafa'].includes(base);
  const cardBg = isDarkTheme ? '#0f172a' : token.colorBgContainer;
  const borderColor = isDarkTheme ? 'rgba(148, 163, 184, 0.2)' : token.colorBorderSecondary;
  const mutedText = isDarkTheme ? 'rgba(226, 232, 240, 0.6)' : token.colorTextSecondary;
  
  // Sort trades by most recent first
  const sortedTrades = React.useMemo(() => {
    if (!Array.isArray(trades)) return [];
    return [...trades].sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [trades]);

  // Calculate summary stats
  const summaryStats = React.useMemo(() => {
    const totalPnl = sortedTrades.reduce((sum, t) => sum + (t.realizedPnlUsd || 0), 0);
    const wins = sortedTrades.filter(t => (t.realizedPnlUsd || 0) > 0).length;
    const losses = sortedTrades.filter(t => (t.realizedPnlUsd || 0) < 0).length;
    const avgRoe = sortedTrades.length > 0 
      ? sortedTrades.reduce((sum, t) => sum + (t.roePct || 0), 0) / sortedTrades.length 
      : 0;
    return { totalPnl, wins, losses, avgRoe };
  }, [sortedTrades]);
  
  const columns = React.useMemo(
    () => [
      {
        title: 'SYMBOL',
        dataIndex: 'symbol',
        key: 'symbol',
        width: 130,
        render: (symbol: string, row: TradeRow) => (
          <Space size={6}>
            {row.positionSide === 'long' ? (
              <TrendingUp size={12} color="#34d399" />
            ) : row.positionSide === 'short' ? (
              <TrendingDown size={12} color="#f87171" />
            ) : null}
            <Text strong style={{ fontSize: 13 }}>{symbol?.replace('/USDT', '') || '—'}</Text>
            <Tag 
              color={row.positionSide === 'long' ? 'success' : row.positionSide === 'short' ? 'error' : 'default'}
              style={{ fontSize: 9, padding: '0 4px', margin: 0 }}
            >
              {row.positionSide?.toUpperCase() || '—'}
            </Tag>
          </Space>
        ),
      },
      {
        title: 'ENTRY / EXIT',
        key: 'prices',
        width: 140,
        render: (_: unknown, row: TradeRow) => (
          <div style={{ fontSize: 12 }}>
            <div style={{ color: mutedText, display: 'flex', alignItems: 'center', gap: 4 }}>
              <ArrowRightLeft size={10} />
              {formatNumber(row.entryPrice, 4)} → {formatNumber(row.exitPrice, 4)}
            </div>
          </div>
        ),
      },
      {
        title: 'ROE %',
        dataIndex: 'roePct',
        key: 'roePct',
        width: 90,
        align: 'right' as const,
        sorter: (a: TradeRow, b: TradeRow) => (a.roePct || 0) - (b.roePct || 0),
        render: (value: number | null) => {
          const color = value != null && value >= 0 ? '#34d399' : '#f87171';
          return value != null ? (
            <Text style={{ color, fontWeight: 600, fontSize: 13 }}>
              {value >= 0 ? '+' : ''}{formatNumber(value, 1)}%
            </Text>
          ) : <Text style={{ fontSize: 12 }}>—</Text>;
        },
      },
      {
        title: 'PNL',
        dataIndex: 'realizedPnlUsd',
        key: 'realizedPnlUsd',
        width: 100,
        align: 'right' as const,
        sorter: (a: TradeRow, b: TradeRow) => (a.realizedPnlUsd || 0) - (b.realizedPnlUsd || 0),
        render: (value: number) => (
          <Space size={4} style={{ flexWrap: 'nowrap' }}>
            {value >= 0 ? <TrendingUp size={11} color="#34d399" /> : <TrendingDown size={11} color="#f87171" />}
            <Text style={{ color: value >= 0 ? '#34d399' : '#f87171', fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}>
              {value == null || Number.isNaN(value) ? '$0' : `${value >= 0 ? '+' : ''}$${Math.abs(value).toFixed(2)}`}
            </Text>
          </Space>
        ),
      },
      {
        title: 'EXIT',
        dataIndex: 'exitReason',
        key: 'exitReason',
        width: 80,
        align: 'center' as const,
        filters: [
          { text: '🎯 TP', value: 'tp' },
          { text: '📈 Trail', value: 'trail' },
          { text: '🛑 SL', value: 'sl' },
        ],
        onFilter: (value: unknown, record: TradeRow) => {
          const reason = record.exitReason?.toLowerCase() || '';
          if (value === 'tp') return reason.includes('tp') || reason.includes('take');
          if (value === 'trail') return reason.includes('trail');
          if (value === 'sl') return reason.includes('sl') || reason.includes('stop');
          return true;
        },
        render: (value: string) => {
          const { label, color, emoji } = getExitReasonDisplay(value);
          return (
            <Tooltip title={value || 'Unknown'}>
              <Tag color={color} style={{ fontSize: 11, margin: 0 }}>
                {emoji} {label}
              </Tag>
            </Tooltip>
          );
        },
      },
      {
        title: 'LEVERAGE',
        dataIndex: 'estLev',
        key: 'estLev',
        width: 85,
        align: 'center' as const,
        render: (value: number | null) => (
          <Text style={{ fontSize: 12 }}>{value != null ? `${formatNumber(value, 1)}×` : '—'}</Text>
        ),
      },
      {
        title: 'DURATION',
        key: 'duration',
        width: 90,
        align: 'center' as const,
        render: (_: unknown, row: TradeRow) => (
          <Tooltip title={`Entry: ${formatTimestamp(row.entryTimestamp)} → Exit: ${formatTimestamp(row.createdAt)}`}>
            <Text style={{ color: mutedText, fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Clock size={10} />
              {formatDuration(row.entryTimestamp, row.createdAt)}
            </Text>
          </Tooltip>
        ),
      },
      {
        title: 'TIME',
        dataIndex: 'createdAt',
        key: 'createdAt',
        width: 110,
        render: (value: string) => (
          <Text style={{ color: mutedText, fontSize: 12, whiteSpace: 'nowrap' }}>{formatTimestamp(value)}</Text>
        ),
      },
    ],
    [mutedText],
  );

  return (
    <Card
      style={{ borderRadius: 16, border: `1px solid ${borderColor}`, background: cardBg }}
      styles={{ body: { padding: 0 } }}
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space size={12}>
            <span style={{ color: isDarkTheme ? '#f8fafc' : token.colorText, fontSize: 16, fontWeight: 600 }}>Recent Trades</span>
            <Tag color='blue'>{sortedTrades.length}</Tag>
          </Space>
          
          {/* Summary Stats */}
          <Space size={16} style={{ marginRight: 16 }}>
            <Tooltip title="Total PnL">
              <Space size={4}>
                <DollarSign size={12} color={mutedText} />
                <Text style={{ 
                  color: summaryStats.totalPnl >= 0 ? '#34d399' : '#f87171', 
                  fontSize: 13, 
                  fontWeight: 600 
                }}>
                  {summaryStats.totalPnl >= 0 ? '+' : ''}{formatUsd(summaryStats.totalPnl)}
                </Text>
              </Space>
            </Tooltip>
            <Tooltip title="Win Rate">
              <Space size={4}>
                <Target size={12} color={mutedText} />
                <Text style={{ color: isDarkTheme ? '#f8fafc' : token.colorText, fontSize: 13 }}>
                  {summaryStats.wins}W/{summaryStats.losses}L
                </Text>
              </Space>
            </Tooltip>
            <Tooltip title="Average ROE">
              <Space size={4}>
                <Percent size={12} color={mutedText} />
                <Text style={{ 
                  color: summaryStats.avgRoe >= 0 ? '#34d399' : '#f87171', 
                  fontSize: 13 
                }}>
                  {summaryStats.avgRoe >= 0 ? '+' : ''}{summaryStats.avgRoe.toFixed(1)}%
                </Text>
              </Space>
            </Tooltip>
          </Space>
        </div>
      }
      extra={onRefresh ? <a onClick={onRefresh} style={{ fontSize: 13 }}>Refresh</a> : undefined}
    >
      {sortedTrades.length === 0 && !loading ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Space direction="vertical" size={4}>
              <span style={{ color: mutedText }}>No closed trades yet</span>
              <span style={{ color: mutedText, fontSize: 12, opacity: 0.7 }}>
                Trades will appear here once positions are closed
              </span>
            </Space>
          }
          style={{ margin: '32px 0', color: mutedText }}
        />
      ) : (
        <Table
          size='small'
          columns={columns}
          dataSource={sortedTrades.slice(0, 15)}
          rowKey={(row) => row.id}
          pagination={sortedTrades.length > 15 ? { pageSize: 15, size: 'small' } : false}
          loading={loading}
          style={{ color: isDarkTheme ? '#e2e8f0' : token.colorText }}
          className="compact-trades-table"
          scroll={{ x: 850 }}
        />
      )}
      <style>{`
        .compact-trades-table .ant-table-thead > tr > th {
          padding: 10px 12px !important;
          font-size: 11px !important;
          font-weight: 700 !important;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: ${isDarkTheme ? 'rgba(148, 163, 184, 0.8)' : token.colorTextSecondary} !important;
          background: ${isDarkTheme ? 'rgba(15, 23, 42, 0.6)' : token.colorFillQuaternary} !important;
        }
        .compact-trades-table .ant-table-tbody > tr > td {
          padding: 8px 12px !important;
          line-height: 1.4;
        }
        .compact-trades-table .ant-table-tbody > tr {
          transition: background 0.2s;
        }
        .compact-trades-table .ant-table-tbody > tr:hover {
          background: ${isDarkTheme ? 'rgba(59, 130, 246, 0.08)' : 'rgba(59, 130, 246, 0.04)'} !important;
        }
        .compact-trades-table .ant-table-tbody > tr:hover > td {
          background: transparent !important;
        }
      `}</style>
    </Card>
  );
};

export default RecentTradesTable;
