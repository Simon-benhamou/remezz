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
  const month = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${month} ${time}`;
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
        title: 'SYMBOL',
        dataIndex: 'symbol',
        key: 'symbol',
        width: 110,
        render: (symbol: string, row: TradeRow) => (
          <Text strong style={{ fontSize: 13 }}>{symbol?.replace('/USDT', '') || '—'}</Text>
        ),
      },
      {
        title: 'QTY',
        dataIndex: 'qty',
        key: 'qty',
        width: 90,
        align: 'right' as const,
        render: (value: number) => <Text style={{ fontSize: 12 }}>{formatNumber(value, 1)}</Text>,
      },
      {
        title: 'ENTRY',
        dataIndex: 'entryPrice',
        key: 'entryPrice',
        width: 90,
        align: 'right' as const,
        render: (value: number | null) => <Text style={{ fontSize: 12 }}>{formatNumber(value, 4)}</Text>,
      },
      {
        title: 'EXIT',
        dataIndex: 'exitPrice',
        key: 'exitPrice',
        width: 90,
        align: 'right' as const,
        render: (value: number | null) => <Text style={{ fontSize: 12 }}>{formatNumber(value, 4)}</Text>,
      },
      {
        title: 'ROE',
        dataIndex: 'roePct',
        key: 'roePct',
        width: 80,
        align: 'right' as const,
        render: (value: number | null) => {
          const color = value != null && value >= 0 ? '#34d399' : '#f87171';
          return value != null ? (
            <Text style={{ color, fontWeight: 600, fontSize: 13 }}>{formatNumber(value, 1)}%</Text>
          ) : <Text style={{ fontSize: 12 }}>—</Text>;
        },
      },
      {
        title: 'PNL',
        dataIndex: 'realizedPnlUsd',
        key: 'realizedPnlUsd',
        width: 100,
        align: 'right' as const,
        render: (value: number) => (
          <Space size={4}>
            {value >= 0 ? <ArrowUpOutlined style={{ color: '#34d399', fontSize: 11 }} /> : <ArrowDownOutlined style={{ color: '#f87171', fontSize: 11 }} />}
            <Text style={{ color: value >= 0 ? '#34d399' : '#f87171', fontWeight: 600, fontSize: 13 }}>{formatUsd(value)}</Text>
          </Space>
        ),
      },
      {
        title: 'LEVERAGE',
        dataIndex: 'estLev',
        key: 'estLev',
        width: 85,
        align: 'center' as const,
        render: (value: number | null) => <Text style={{ fontSize: 12 }}>{value != null ? `${formatNumber(value, 1)}×` : '—'}</Text>,
      },
      {
        title: 'TIME',
        dataIndex: 'createdAt',
        key: 'createdAt',
        width: 120,
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
      bodyStyle={{ padding: 0 }}
      title={
        <Space size={12}>
          <span style={{ color: isDarkTheme ? '#f8fafc' : token.colorText, fontSize: 15, fontWeight: 600 }}>Recent trades</span>
          <Tag color='blue'>{sortedTrades.length}</Tag>
        </Space>
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
          dataSource={sortedTrades.slice(0, 10)}
          rowKey={(row) => row.id}
          pagination={false}
          loading={loading}
          style={{ color: isDarkTheme ? '#e2e8f0' : token.colorText }}
          className="compact-trades-table"
        />
      )}
      <style>{`
        .compact-trades-table .ant-table-thead > tr > th {
          padding: 8px 12px !important;
          font-size: 11px !important;
          font-weight: 700 !important;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: ${isDarkTheme ? 'rgba(148, 163, 184, 0.8)' : token.colorTextSecondary} !important;
        }
        .compact-trades-table .ant-table-tbody > tr > td {
          padding: 6px 12px !important;
          line-height: 1.4;
        }
        .compact-trades-table .ant-table-tbody > tr {
          transition: background 0.2s;
        }
        .compact-trades-table .ant-table-tbody > tr:hover {
          background: ${isDarkTheme ? 'rgba(59, 130, 246, 0.08)' : 'rgba(59, 130, 246, 0.04)'} !important;
        }
      `}</style>
    </Card>
  );
};

export default RecentTradesTable;
