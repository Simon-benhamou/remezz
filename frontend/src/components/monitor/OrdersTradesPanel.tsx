import { Card, Table, Tag, Button, Space, Dropdown, Modal, message, Tooltip } from 'antd';
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
import { useState } from 'react';
import type { MenuProps } from 'antd';

interface OrdersTradesPanelProps {
  orders: any[];
  fills: any[];
  sessionId: string;
  onExitOrder?: (orderId: string) => Promise<void>;
  onCancelOrder?: (orderId: string) => Promise<void>;
  onStopSession?: () => Promise<void>;
  onDeleteSession?: () => Promise<void>;
}

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

  const getSideTag = (side: string) => {
    return side?.toLowerCase() === 'buy' ? (
      <Tag color="green">LONG</Tag>
    ) : (
      <Tag color="red">SHORT</Tag>
    );
  };

  const orderColumns = [
    {
      title: 'Time',
      dataIndex: 'timestamp',
      key: 'timestamp',
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
      width: 120,
      align: 'right' as const,
      render: (amount: number) => amount?.toFixed(4) || 'N/A',
    },
    {
      title: 'Filled',
      dataIndex: 'filled',
      key: 'filled',
      width: 120,
      align: 'right' as const,
      render: (filled: number, record: any) => {
        const percent = record.amount ? (filled / record.amount * 100).toFixed(1) : '0';
        return `${filled?.toFixed(4) || '0'} (${percent}%)`;
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

  const fillColumns = [
    {
      title: 'Time',
      dataIndex: 'timestamp',
      key: 'timestamp',
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

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {/* Active Orders */}
      <Card
        title={
          <Space>
            <ShoppingOutlined />
            <span>Active Orders</span>
            {activeOrders.length > 0 && (
              <Tag color="blue">{activeOrders.length}</Tag>
            )}
          </Space>
        }
        extra={
          <Dropdown menu={{ items: sessionActions }} trigger={['click']}>
            <Button icon={<MoreOutlined />} loading={loading}>
              Actions
            </Button>
          </Dropdown>
        }
        size="small"
      >
        <Table
          dataSource={orders}
          columns={orderColumns}
          rowKey="id"
          size="small"
          pagination={false}
          scroll={{ x: 1200 }}
          locale={{ emptyText: 'No orders' }}
        />
      </Card>

      {/* Trade History (Fills) */}
      <Card
        title={
          <Space>
            <CheckCircleOutlined />
            <span>Trade History</span>
            {fills.length > 0 && (
              <Tag color="green">{fills.length}</Tag>
            )}
          </Space>
        }
        size="small"
      >
        <Table
          dataSource={fills}
          columns={fillColumns}
          rowKey="id"
          size="small"
          pagination={{ pageSize: 10, showSizeChanger: false }}
          scroll={{ x: 1000 }}
          locale={{ emptyText: 'No trades yet' }}
        />
      </Card>
    </Space>
  );
}
