import React from "react";
import { Table, Tag, Tooltip, Space, Badge } from "antd";
import { CheckCircleOutlined, ClockCircleOutlined, CloseCircleOutlined } from "@ant-design/icons";

export default function OrdersTable({ rows = [] }: any) {
  const getStatusBadge = (status: string) => {
    const statusMap: Record<string, { color: string; icon: any; text: string }> = {
      'filled': { color: 'success', icon: <CheckCircleOutlined />, text: 'Filled' },
      'partial': { color: 'processing', icon: <ClockCircleOutlined />, text: 'Partial' },
      'pending': { color: 'warning', icon: <ClockCircleOutlined />, text: 'Pending' },
      'canceled': { color: 'error', icon: <CloseCircleOutlined />, text: 'Canceled' },
      'rejected': { color: 'error', icon: <CloseCircleOutlined />, text: 'Rejected' },
    };
    const config = statusMap[status?.toLowerCase()] || { color: 'default', icon: null, text: status };
    return (
      <Badge 
        status={config.color as any} 
        text={
          <Space size={4}>
            {config.icon}
            <span style={{ fontSize: 12, fontWeight: 500 }}>{config.text}</span>
          </Space>
        } 
      />
    );
  };

  const cols: any = [
    {
      title: "Time",
      dataIndex: "createdAt",
      width: 140,
      render: (v: any) => (
        <div style={{ fontSize: 12 }}>
          <div style={{ fontWeight: 500, color: '#374151' }}>
            {new Date(v).toLocaleDateString()}
          </div>
          <div style={{ color: '#6b7280' }}>
            {new Date(v).toLocaleTimeString()}
          </div>
        </div>
      ),
    },
    {
      title: "Order",
      width: 120,
      render: (_: any, record: any) => {
        const isExit = record.clientOrderId?.endsWith?.('.exit');
        return (
          <Space direction="vertical" size={2}>
            <Tag 
              color={isExit ? 'orange' : 'blue'} 
              style={{ margin: 0, fontSize: 11, fontWeight: 500 }}
            >
              {isExit ? 'EXIT' : 'ENTRY'}
            </Tag>
            <Tooltip title={record.clientOrderId}>
              <code style={{ 
                fontSize: 10, 
                color: '#6b7280',
                background: '#f9fafb',
                padding: '1px 4px',
                borderRadius: 3
              }}>
                {record.clientOrderId?.slice(-8) || 'N/A'}
              </code>
            </Tooltip>
          </Space>
        );
      },
    },
    {
      title: "Side",
      dataIndex: "side",
      width: 80,
      render: (v: any) => (
        <Tag 
          color={v === "buy" ? "success" : "error"} 
          style={{ 
            margin: 0, 
            fontSize: 12, 
            fontWeight: 600,
            textTransform: 'uppercase'
          }}
        >
          {v}
        </Tag>
      ),
    },
    {
      title: "Type",
      dataIndex: "type",
      width: 80,
      render: (v: any) => (
        <span style={{ 
          fontSize: 12, 
          color: '#374151',
          textTransform: 'capitalize',
          fontWeight: 500
        }}>
          {v}
        </span>
      ),
    },
    {
      title: "Quantity",
      dataIndex: "qty",
      width: 100,
      align: 'right',
      render: (v: any) => (
        <span style={{ 
          fontSize: 12, 
          fontWeight: 600, 
          color: '#111827',
          fontFamily: 'Monaco, monospace'
        }}>
          {Number(v || 0).toFixed(4)}
        </span>
      )
    },
    {
      title: "Price",
      dataIndex: "price",
      width: 100,
      align: 'right',
      render: (v: any) => (
        <span style={{ 
          fontSize: 12, 
          fontWeight: 600, 
          color: '#111827',
          fontFamily: 'Monaco, monospace'
        }}>
          {v != null ? `$${Number(v).toFixed(4)}` : '-'}
        </span>
      )
    },
    {
      title: "Notional",
      width: 100,
      align: 'right',
      render: (_: any, record: any) => {
        const notional = (Number(record.qty) || 0) * (Number(record.price) || 0);
        const cap = Number(record.notionalCapUsd || 0);
        const ratio = cap > 0 && notional > 0 ? Math.min(999, (notional / cap) * 100) : null;
        return (
          <div style={{ textAlign:'right' }}>
            <div style={{
              fontSize: 12,
              fontWeight: 600,
              color: '#2563eb',
              fontFamily: 'Monaco, monospace'
            }}>
              {notional ? `$${notional.toFixed(2)}` : '-'}
            </div>
            {cap > 0 && (
              <div style={{ fontSize: 10, color: '#6b7280' }}>
                cap ${cap.toFixed(0)}{ratio != null ? ` · ${ratio.toFixed(0)}%` : ''}
              </div>
            )}
          </div>
        );
      },
    },
    {
      title: "Leverage",
      width: 80,
      align: 'center',
      render: (_: any, record: any) => {
        const lev = record.leverage || record.estLev;
        if (!lev) return <span style={{ color: '#9ca3af' }}>-</span>;
        return (
          <Tag style={{ 
            margin: 0, 
            fontSize: 11,
            background: '#f9fafb',
            color: '#6b7280',
            border: '1px solid #e5e7eb'
          }}>
            {Number(lev).toFixed(1)}x
          </Tag>
        );
      },
    },
    {
      title: "PnL",
      width: 100,
      align: 'right',
      render: (_: any, record: any) => {
        if (!record.clientOrderId?.endsWith?.('.exit')) {
          return <span style={{ color: '#9ca3af', fontSize: 12 }}>-</span>;
        }
        
        const pnl = Number(record.realizedPnlUsd || 0);
        const roi = Number(record.roePct || 0);
        const isProfit = pnl >= 0;
        
        return (
          <Space direction="vertical" size={1} style={{ alignItems: 'flex-end' }}>
            <span style={{ 
              color: isProfit ? '#059669' : '#dc2626', // Ultra-discret
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'Monaco, monospace'
            }}>
              ${pnl.toFixed(2)}
            </span>
            <span style={{ 
              color: isProfit ? '#059669' : '#dc2626', // Ultra-discret
              fontSize: 10,
              fontWeight: 500
            }}>
              {roi >= 0 ? '+' : ''}{roi.toFixed(1)}%
            </span>
          </Space>
        );
      },
    },
    {
      title: "Status",
      dataIndex: "status",
      width: 100,
      render: (status: string) => getStatusBadge(status),
    },
  ];

  return (
    <Table 
      rowKey="id" 
      dataSource={rows} 
      columns={cols} 
      size="small" 
      pagination={{
        pageSize: 10,
        showSizeChanger: false,
        showQuickJumper: false,
        showTotal: (total) => `${total} orders`
      }}
      scroll={{ x: 900 }}
      className="enhanced-orders-table"
    />
  );
}
