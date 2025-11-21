import React from 'react';
import { ArrowDownOutlined, ArrowUpOutlined } from '../icons';
import { Badge, Card, Empty, Space, Table, Tag, Typography, theme } from 'antd';

const { Text } = Typography;

type TradeRow = {
  id: string;
  createdAt: string;
  symbol?: string;
  positionSide?: string;
  qty?: number;
  entryPrice?: number | null;
  exitPrice?: number | null;
  realizedPnlUsd?: number;
  roePct?: number | null;
  estLev?: number | null;
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
  // Format with proper precision to avoid rounding issues
  const formatted = Number(value).toFixed(digits);
  // Remove trailing zeros after decimal point for cleaner display
  return parseFloat(formatted).toString();
}

function formatTimestamp(ts?: string) {
  if (!ts) return '—';
  const date = new Date(ts);
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
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
  
  const columns = React.useMemo(
    () => [
      {
        title: 'Symbol',
        dataIndex: 'symbol',
        key: 'symbol',
        render: (symbol: string, row: TradeRow) => (
          <Space>
            <Badge color={row.positionSide === 'long' ? 'green' : 'volcano'} />
            <span style={{ fontWeight: 600 }}>{symbol || '—'}</span>
          </Space>
        ),
      },
      {
        title: 'Qty',
        dataIndex: 'qty',
        key: 'qty',
        render: (value: number) => formatNumber(value, 3),
      },
      {
        title: 'Entry',
        dataIndex: 'entryPrice',
        key: 'entryPrice',
        render: (value: number | null) => formatNumber(value, 4),
      },
      {
        title: 'Exit',
        dataIndex: 'exitPrice',
        key: 'exitPrice',
        render: (value: number | null) => formatNumber(value, 4),
      },
      {
        title: 'ROE',
        dataIndex: 'roePct',
        key: 'roePct',
        render: (value: number | null, row: TradeRow) => {
          const color = value != null && value >= 0 ? '#34d399' : '#f87171';
          return value != null ? (
            <span style={{ color, fontWeight: 600 }}>{formatNumber(value, 2)}%</span>
          ) : '—';
        },
      },
      {
        title: 'PnL',
        dataIndex: 'realizedPnlUsd',
        key: 'realizedPnlUsd',
        render: (value: number) => (
          <Space>
            {value >= 0 ? <ArrowUpOutlined style={{ color: '#34d399' }} /> : <ArrowDownOutlined style={{ color: '#f87171' }} />}
            <span style={{ color: value >= 0 ? '#34d399' : '#f87171', fontWeight: 600 }}>{formatUsd(value)}</span>
          </Space>
        ),
      },
      {
        title: 'Leverage',
        dataIndex: 'estLev',
        key: 'estLev',
        render: (value: number | null) => (value != null ? `${formatNumber(value, 2)}×` : '—'),
      },
      {
        title: 'Time',
        dataIndex: 'createdAt',
        key: 'createdAt',
        render: (value: string) => (
          <Text style={{ color: mutedText }}>{formatTimestamp(value)}</Text>
        ),
      },
    ],
    [mutedText],
  );

  return (
    <Card
      style={{ borderRadius: 16, border: `1px solid ${borderColor}`, background: cardBg }}
      bodyStyle={{ padding: 0 }}
      title={
        <Space size={12}>
          <span style={{ color: isDarkTheme ? '#f8fafc' : token.colorText }}>Recent trades</span>
          <Tag color='blue'>{sortedTrades.length}</Tag>
        </Space>
      }
      extra={onRefresh ? <a onClick={onRefresh}>Refresh</a> : undefined}
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
          dataSource={sortedTrades.slice(0, 10)}
          rowKey={(row) => row.id}
          pagination={false}
          loading={loading}
          style={{ color: isDarkTheme ? '#e2e8f0' : token.colorText }}
        />
      )}
    </Card>
  );
};

export default RecentTradesTable;
