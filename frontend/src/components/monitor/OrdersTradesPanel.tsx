import { Card, Table, Tag, Button, Space, Dropdown, Modal, message, Tooltip, Segmented, Progress, Typography } from 'antd';
import {
  ShoppingOutlined,
  CloseOutlined,
  StopOutlined,
  DeleteOutlined,
  MoreOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';
import { useMemo, useState } from 'react';
import type { MenuProps } from 'antd';

const { Text } = Typography;

interface OrdersTradesPanelProps {
  orders: any[];
  fills: any[];
  sessionId: string;
  onExitOrder?: (orderId: string) => Promise<void>;
  onCancelOrder?: (orderId: string) => Promise<void>;
  onStopSession?: () => Promise<void>;
  onDeleteSession?: () => Promise<void>;
}

type GroupedTrade = {
  id: string;
  entryTime: string;
  exitTime: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  amount: number;
  pnl: number;
  roi: number;
  fees: number;
  duration: number;
};

export function OrdersTradesPanel({
  orders = [],
  fills = [],
  sessionId,
  onExitOrder,
  onCancelOrder,
  onStopSession,
  onDeleteSession,
}: OrdersTradesPanelProps) {
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'orders' | 'trades' | 'fills'>('orders');

  const handleExitOrder = async (orderId: string) => {
    if (!onExitOrder) return;
    
    Modal.confirm({
      title: 'Exit Order',
      content: 'Are you sure you want to exit this order?',
      okText: 'Exit',
      okType: 'danger',
      onOk: async () => {
        setActionLoading(orderId);
        try {
          await onExitOrder(orderId);
          message.success('Order exit initiated');
        } catch (error: any) {
          message.error(error.message || 'Failed to exit order');
        } finally {
          setActionLoading(null);
        }
      },
    });
  };

  const handleCancelOrder = async (orderId: string) => {
    if (!onCancelOrder) return;
    
    Modal.confirm({
      title: 'Cancel Order',
      content: 'Are you sure you want to cancel this order?',
      okText: 'Cancel Order',
      okType: 'danger',
      onOk: async () => {
        setActionLoading(orderId);
        try {
          await onCancelOrder(orderId);
          message.success('Order cancelled');
        } catch (error: any) {
          message.error(error.message || 'Failed to cancel order');
        } finally {
          setActionLoading(null);
        }
      },
    });
  };

  const handleStopSession = async () => {
    if (!onStopSession) return;
    
    Modal.confirm({
      title: 'Stop Agent Session',
      content: 'Are you sure you want to stop this agent? It will close all positions and cancel pending orders.',
      okText: 'Stop Agent',
      okType: 'danger',
      onOk: async () => {
        setLoading(true);
        try {
          await onStopSession();
          message.success('Agent stopped');
        } catch (error: any) {
          message.error(error.message || 'Failed to stop agent');
        } finally {
          setLoading(false);
        }
      },
    });
  };

  const handleDeleteSession = async () => {
    if (!onDeleteSession) return;
    
    Modal.confirm({
      title: 'Delete Agent Session',
      content: (
        <div>
          <p>⚠️ This will permanently delete this agent session and all related data.</p>
          <p>This action cannot be undone.</p>
        </div>
      ),
      okText: 'Delete Permanently',
      okType: 'danger',
      onOk: async () => {
        setLoading(true);
        try {
          await onDeleteSession();
          message.success('Agent deleted');
        } catch (error: any) {
          message.error(error.message || 'Failed to delete agent');
        } finally {
          setLoading(false);
        }
      },
    });
  };

  const getOrderStatusTag = (status: string) => {
    const statusMap: Record<string, { color: string; icon: any }> = {
      open: { color: 'blue', icon: <ClockCircleOutlined /> },
      filled: { color: 'green', icon: <CheckCircleOutlined /> },
      canceled: { color: 'default', icon: <CloseOutlined /> },
      expired: { color: 'orange', icon: <ExclamationCircleOutlined /> },
      rejected: { color: 'red', icon: <ExclamationCircleOutlined /> },
    };
    const config = statusMap[status?.toLowerCase()] || { color: 'default', icon: null };
    return <Tag color={config.color} icon={config.icon}>{status}</Tag>;
  };

  const resolveOrderIntent = (record: any): 'entry' | 'exit' => {
    if (!record) return 'entry';
    if (record.reduceOnly) return 'exit';
    const clientId = String(record.clientOrderId || '');
    if (/\.?(exit|close)/i.test(clientId)) return 'exit';
    if (record.intent === 'exit' || record.sideIntent === 'exit') return 'exit';
    return 'entry';
  };

  const getSideTag = (side: string, intent: 'entry' | 'exit' = 'entry', info?: string) => {
    const normalized = side?.toLowerCase();
    const isBuy = normalized === 'buy' || normalized === 'long';
    if (intent === 'exit') {
      return (
        <Tooltip title={info || 'Exit / reduce position'}>
          <Tag color="volcano">EXIT</Tag>
        </Tooltip>
      );
    }
    return (
      <Tooltip title={info}>
        {isBuy ? (
          <Tag color="green">LONG</Tag>
        ) : (
          <Tag color="red">SHORT</Tag>
        )}
      </Tooltip>
    );
  };

  const orderColumns = [
    {
      title: 'Time',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (ts: string) => {
        if (!ts) return 'N/A';
        const date = new Date(ts);
        return isNaN(date.getTime()) ? 'Invalid Date' : date.toLocaleString();
      },
    },
    {
      title: 'Intent',
      key: 'intent',
      width: 90,
      render: (_: any, record: any) => {
        const intent = resolveOrderIntent(record);
        const tone = intent === 'exit' ? { color: '#fb7185', bg: 'rgba(251, 113, 133, 0.12)' } : { color: '#22c55e', bg: 'rgba(34, 197, 94, 0.12)' };
        return (
          <Tag color={tone.color} style={{ background: tone.bg, border: 'none' }}>
            {intent === 'exit' ? 'Exit' : 'Entry'}
          </Tag>
        );
      },
    },
    {
      title: 'Side',
      dataIndex: 'side',
      key: 'side',
      width: 80,
      render: (side: string, record: any) => {
        const intent = resolveOrderIntent(record);
        const info = intent === 'exit' ? 'Exit/Close Position' : 'Open Position';
        return getSideTag(side, intent, info);
      },
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 100,
      render: (type: string) => <Tag>{type?.toUpperCase()}</Tag>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: string) => getOrderStatusTag(status),
    },
    {
      title: 'Price',
      dataIndex: 'price',
      key: 'price',
      width: 120,
      align: 'right' as const,
      render: (price: number) => price ? `$${price.toFixed(4)}` : 'Market',
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      width: 100,
      align: 'right' as const,
      render: (amount: number) => amount?.toFixed(4) || 'N/A',
    },
    {
      title: 'Notional',
      key: 'notional',
      width: 110,
      align: 'right' as const,
      render: (_: any, record: any) => {
        const notional = (record.price || 0) * (record.amount || 0);
        return notional > 0 ? `$${notional.toFixed(2)}` : '-';
      },
    },
    {
      title: 'Fill Progress',
      dataIndex: 'filled',
      key: 'filled',
      width: 160,
      render: (filled: number, record: any) => {
        const filledQty = filled ?? 0;
        const total = record.amount || 0;
        const percent = total ? Math.min(100, (filledQty / total) * 100) : 0;
        return (
          <div style={{ minWidth: 140 }}>
            <Progress
              percent={Number(percent.toFixed(1))}
              size="small"
              strokeColor={percent >= 100 ? '#22c55e' : '#60a5fa'}
              showInfo={false}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {filledQty?.toFixed(4) || '0'} / {total?.toFixed(4) || '0'} ({percent.toFixed(1)}%)
            </Text>
          </div>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      fixed: 'right' as const,
      render: (_: any, record: any) => {
        const isOpen = record.status?.toLowerCase() === 'open';
        const isPending = actionLoading === record.id;

        if (!isOpen) return <span style={{ color: '#8c8c8c' }}>-</span>;

        return (
          <Space size="small">
            <Tooltip title="Exit Order">
              <Button
                type="primary"
                danger
                size="small"
                icon={<CloseOutlined />}
                loading={isPending}
                onClick={() => handleExitOrder(record.id)}
              >
                Exit
              </Button>
            </Tooltip>
            <Tooltip title="Cancel Order">
              <Button
                size="small"
                icon={<CloseOutlined />}
                loading={isPending}
                onClick={() => handleCancelOrder(record.id)}
              >
                Cancel
              </Button>
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  // Group fills into completed trades (entry/exit pairs)
  const groupedTrades: GroupedTrade[] = [];
  const fillsByOrder = fills.reduce((acc, fill) => {
    if (!acc[fill.orderId]) acc[fill.orderId] = [];
    acc[fill.orderId].push(fill);
    return acc;
  }, {} as Record<string, any[]>);

  // Match entry/exit pairs from filled orders
  const filledOrders = orders.filter(o => o.status?.toLowerCase() === 'filled');
  for (let i = 0; i < filledOrders.length; i++) {
    const order = filledOrders[i];
    // Find opposite side order close in time (exit)
    const oppositeOrder = filledOrders.find((o, idx) => 
      idx > i && 
      ((order.side === 'buy' && o.side === 'sell') || (order.side === 'sell' && o.side === 'buy')) &&
      Math.abs(new Date(o.createdAt).getTime() - new Date(order.createdAt).getTime()) < 24 * 3600 * 1000
    );
    
    if (oppositeOrder) {
      const isLong = order.side === 'buy' || order.side === 'long';
      const entryPrice = order.price || 0;
      const exitPrice = oppositeOrder.price || 0;
      const amount = order.amount || 0;
      const pnl = isLong ? (exitPrice - entryPrice) * amount : (entryPrice - exitPrice) * amount;
      const roi = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice * 100 * (isLong ? 1 : -1)) : 0;
      const fees = (order.fee || 0) + (oppositeOrder.fee || 0);
      
      groupedTrades.push({
        id: `${order.id}-${oppositeOrder.id}`,
        entryTime: order.createdAt,
        exitTime: oppositeOrder.createdAt,
        side: isLong ? 'LONG' : 'SHORT',
        entryPrice,
        exitPrice,
        amount,
        pnl,
        roi,
        fees,
        duration: Math.floor((new Date(oppositeOrder.createdAt).getTime() - new Date(order.createdAt).getTime()) / 60000),
      });
      
      // Remove processed order from future iterations
      filledOrders.splice(filledOrders.indexOf(oppositeOrder), 1);
    }
  }

  const tradeColumns = [
    {
      title: 'Entry Time',
      dataIndex: 'entryTime',
      key: 'entryTime',
      width: 150,
      render: (ts: string) => {
        if (!ts) return 'N/A';
        const date = new Date(ts);
        return isNaN(date.getTime()) ? 'Invalid' : date.toLocaleString();
      },
    },
    {
      title: 'Side',
      dataIndex: 'side',
      key: 'side',
      width: 80,
      render: (side: string) => getSideTag(side, 'entry', 'Trade Direction'),
    },
    {
      title: 'Entry Price',
      dataIndex: 'entryPrice',
      key: 'entryPrice',
      width: 110,
      align: 'right' as const,
      render: (price: number) => `$${price.toFixed(4)}`,
    },
    {
      title: 'Exit Price',
      dataIndex: 'exitPrice',
      key: 'exitPrice',
      width: 110,
      align: 'right' as const,
      render: (price: number) => `$${price.toFixed(4)}`,
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      width: 100,
      align: 'right' as const,
      render: (amount: number) => amount?.toFixed(2),
    },
    {
      title: 'Notional',
      key: 'notional',
      width: 110,
      align: 'right' as const,
      render: (_: any, record: any) => {
        const notional = record.entryPrice * record.amount;
        return `$${notional.toFixed(2)}`;
      },
    },
    {
      title: 'PnL',
      dataIndex: 'pnl',
      key: 'pnl',
      width: 110,
      align: 'right' as const,
      render: (pnl: number) => (
        <Tooltip title="Profit & Loss">
          <span style={{ color: pnl >= 0 ? '#52c41a' : '#f5222d', fontWeight: 'bold' }}>
            {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} USDT
          </span>
        </Tooltip>
      ),
    },
    {
      title: 'ROI %',
      dataIndex: 'roi',
      key: 'roi',
      width: 100,
      align: 'right' as const,
      render: (roi: number) => {
        const color = roi >= 0 ? '#52c41a' : '#f5222d';
        const bgColor = roi >= 0 ? 'rgba(82, 196, 26, 0.1)' : 'rgba(245, 34, 45, 0.1)';
        return (
          <Tooltip title="Return on Investment">
            <span style={{ 
              color, 
              fontWeight: 'bold',
              backgroundColor: bgColor,
              padding: '2px 6px',
              borderRadius: '4px',
            }}>
              {roi >= 0 ? '+' : ''}{roi.toFixed(2)}%
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Duration',
      dataIndex: 'duration',
      key: 'duration',
      width: 90,
      align: 'right' as const,
      render: (mins: number) => `${mins}m`,
    },
    {
      title: 'Fees',
      dataIndex: 'fees',
      key: 'fees',
      width: 80,
      align: 'right' as const,
      render: (fees: number) => fees > 0 ? `$${fees.toFixed(2)}` : '-',
    },
  ];

  const fillColumns = [
    {
      title: 'Time',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (ts: number | string) => {
        const date = new Date(ts);
        return date.toLocaleString();
      },
    },
    {
      title: 'Side',
      dataIndex: 'side',
      key: 'side',
      width: 80,
      render: (side: string) => getSideTag(side),
    },
    {
      title: 'Price',
      dataIndex: 'price',
      key: 'price',
      width: 120,
      align: 'right' as const,
      render: (price: number) => `$${price.toFixed(4)}`,
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      width: 120,
      align: 'right' as const,
      render: (amount: number) => amount?.toFixed(4),
    },
    {
      title: 'Fee',
      dataIndex: 'fee',
      key: 'fee',
      width: 100,
      align: 'right' as const,
      render: (fee: any) => fee?.cost ? `$${fee.cost.toFixed(4)}` : '-',
    },
    {
      title: 'Order ID',
      dataIndex: 'orderId',
      key: 'orderId',
      width: 150,
      render: (id: string) => (
        <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>
          {id?.slice(0, 12)}...
        </span>
      ),
    },
  ];

  const sessionActions: MenuProps['items'] = [
    {
      key: 'stop',
      icon: <StopOutlined />,
      label: 'Stop Agent',
      onClick: handleStopSession,
      danger: true,
    },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      label: 'Delete Agent',
      onClick: handleDeleteSession,
      danger: true,
    },
  ];

  const activeOrders = orders.filter(o => o.status?.toLowerCase() === 'open');

  const summaryCards = useMemo(
    () => {
      const totalPnl = groupedTrades.reduce((acc, trade) => acc + (Number(trade.pnl) || 0), 0);
      return [
        { key: 'orders', label: 'Active', value: activeOrders.length },
        { key: 'trades', label: 'Completed', value: groupedTrades.length, extra: totalPnl },
        { key: 'fills', label: 'Fills', value: fills.length },
      ];
    },
    [activeOrders.length, groupedTrades, fills.length],
  );

  const currentColumns = viewMode === 'orders' ? orderColumns : viewMode === 'trades' ? tradeColumns : fillColumns;
  const currentData = viewMode === 'orders' ? orders : viewMode === 'trades' ? groupedTrades : fills;
  const emptyCopy = viewMode === 'orders'
    ? 'No broker instructions yet'
    : viewMode === 'trades'
    ? 'No completed trades'
    : 'No fills recorded';

  const viewDescriptions: Record<typeof viewMode, string> = {
    orders: 'Live orders currently managed by the agent (entry + exits).',
    trades: 'Paired entry/exit executions with realized PnL and ROI.',
    fills: 'Raw exchange fills (debug-level visibility).',
  } as const;

  return (
    <Card
      size="small"
      title={
        <Space size={12} align="center" wrap>
          <ShoppingOutlined />
          <span>Execution Console</span>
          <Tag color="blue">{activeOrders.length} live</Tag>
          <Tag color="green">{groupedTrades.length} trades</Tag>
          {fills.length > 0 && <Tag color="default">{fills.length} fills</Tag>}
        </Space>
      }
      extra={
        <Space size={12} align="center" wrap>
          <Segmented
            size="small"
            value={viewMode}
            onChange={(value) => setViewMode(value as typeof viewMode)}
            options={[
              { label: 'Orders', value: 'orders' },
              { label: 'Trades', value: 'trades' },
              { label: 'Fills', value: 'fills', disabled: fills.length === 0 },
            ]}
          />
          <Dropdown menu={{ items: sessionActions }} trigger={['click']}>
            <Button icon={<MoreOutlined />} loading={loading}>
              Actions
            </Button>
          </Dropdown>
        </Space>
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space size={24} wrap>
          {summaryCards.map((meta) => (
            <div key={meta.key} style={{ minWidth: 120 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>{meta.label}</Text>
              <div style={{ fontSize: 20, fontWeight: 600, color: '#e2e8f0' }}>{meta.value}</div>
              {typeof meta.extra === 'number' && Number.isFinite(meta.extra) && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Net PnL: {meta.extra >= 0 ? '+' : ''}{meta.extra.toFixed(2)} USDT
                </Text>
              )}
            </div>
          ))}
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }}>{viewDescriptions[viewMode]}</Text>
        <Table
          dataSource={currentData}
          columns={currentColumns}
          rowKey={viewMode === 'orders' ? 'id' : viewMode === 'trades' ? 'id' : 'id'}
          size="small"
          pagination={viewMode === 'orders' ? false : { pageSize: 10, showSizeChanger: false }}
          scroll={{ x: 1200 }}
          locale={{ emptyText: emptyCopy }}
          style={{ borderRadius: 12 }}
        />
      </Space>
    </Card>
  );
}
