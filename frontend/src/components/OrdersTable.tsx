import React from 'react';
import { Table, Tag } from 'antd';

type OrdersTableProps = {
  rows: Array<Record<string, any>>;
};

const formatNumber = (value: any, digits = 4) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num.toFixed(digits);
};

const formatUsd = (value: any) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `$${num.toFixed(2)}`;
};

const ORDER_STATUS_META: Record<string, { label: string; tone: string }> = {
  new: { label: 'New', tone: 'processing' },
  open: { label: 'Open', tone: 'processing' },
  working: { label: 'Working', tone: 'processing' },
  partially_filled: { label: 'Partial', tone: 'warning' },
  filled: { label: 'Filled', tone: 'success' },
  canceled: { label: 'Canceled', tone: 'default' },
  rejected: { label: 'Rejected', tone: 'error' },
  pending: { label: 'Pending', tone: 'warning' },
};

export default function OrdersTable({ rows = [] }: OrdersTableProps) {
  const columns = [
    {
      title: 'Time',
      dataIndex: 'createdAt',
      width: 160,
      render: (value: any) => {
        if (!value) return '—';
        const date = new Date(value);
        return (
          <div className='session-table__time'>
            <span>{date.toLocaleDateString()}</span>
            <span>{date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          </div>
        );
      },
    },
    {
      title: 'Type',
      dataIndex: 'side',
      width: 90,
      render: (side: string) => (
        <Tag color={side === 'buy' ? 'green' : 'volcano'} className='session-table__tag'>
          {String(side || '—').toUpperCase()}
        </Tag>
      ),
    },
    {
      title: 'Symbol',
      dataIndex: 'symbol',
      width: 110,
      render: (_: any, record: any) => {
        const sym = typeof record?.symbol === 'string' ? record.symbol.toUpperCase() : '';
        if (!sym) return '—';
        return (
          <Tag color='geekblue' className='session-table__tag'>
            {sym}
          </Tag>
        );
      },
    },
    {
      title: 'Price',
      dataIndex: 'price',
      align: 'right' as const,
      render: (value: any) => (
        <span className='session-table__number'>{formatNumber(value)}</span>
      ),
    },
    {
      title: 'Amount',
      dataIndex: 'qty',
      align: 'right' as const,
      render: (value: any) => (
        <span className='session-table__number'>{formatNumber(value)}</span>
      ),
    },
    {
      title: 'Total',
      align: 'right' as const,
      render: (_: any, record: any) => {
        const qty = Number(record.qty) || 0;
        const price = Number(record.price) || 0;
        const total = qty * price;
        return <span className='session-table__number'>{total ? formatUsd(total) : '—'}</span>;
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 120,
      render: (value: string) => {
        const meta = ORDER_STATUS_META[String(value || '').toLowerCase()] || {
          label: value || 'Unknown',
          tone: 'default',
        };
        return (
          <Tag color={meta.tone as any} className='session-table__tag'>
            {meta.label}
          </Tag>
        );
      },
    },
  ];

  return (
    <Table
      className='session-table'
      columns={columns}
      dataSource={rows}
      size='small'
      pagination={false}
      rowKey={(record: any) => record.id || record.clientOrderId || record.createdAt}
    />
  );
}
