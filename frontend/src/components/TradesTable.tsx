import React from 'react';
import { Table, Tag } from 'antd';
import { formatDisplaySymbol } from '../utils/symbols';

type TradesTableProps = {
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

const formatPercent = (value: any) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num >= 0 ? '+' : ''}${num.toFixed(2)}%`;
};

export default function TradesTable({ rows = [] }: TradesTableProps) {
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
      dataIndex: 'positionSide',
      width: 90,
      render: (side: string) => (
        <Tag color={side === 'long' ? 'green' : 'volcano'} className='session-table__tag'>
          {String(side || '—').toUpperCase()}
        </Tag>
      ),
    },
    {
      title: 'Symbol',
      dataIndex: 'symbol',
      width: 110,
      render: (_: any, record: any) => {
        const sym = formatDisplaySymbol(record?.symbol);
        return (
          <Tag color='geekblue' className='session-table__tag'>
            {sym}
          </Tag>
        );
      },
    },
    {
      title: 'Price',
      align: 'right' as const,
      render: (_: any, record: any) => (
        <div className='session-table__stack'>
          <span className='session-table__number'>{formatNumber(record.entryPrice)}</span>
          <span className='session-table__muted'>→ {formatNumber(record.exitPrice)}</span>
        </div>
      ),
    },
    {
      title: 'Amount',
      dataIndex: 'qty',
      align: 'right' as const,
      render: (value: any) => <span className='session-table__number'>{formatNumber(value)}</span>,
    },
    {
      title: 'Total',
      align: 'right' as const,
      render: (_: any, record: any) => {
        const qty = Number(record.qty) || 0;
        const price = Number(record.exitPrice || record.entryPrice) || 0;
        const total = qty * price;
        return <span className='session-table__number'>{total ? formatUsd(total) : '—'}</span>;
      },
    },
    {
      title: 'P&L',
      align: 'right' as const,
      render: (_: any, record: any) => {
        const pnl = Number(record.realizedPnlUsd || 0);
        const roi = Number(record.roePct || 0);
        const tone = pnl >= 0 ? 'session-table__number--positive' : 'session-table__number--negative';
        return (
          <div className='session-table__stack session-table__stack--right'>
            <span className={`session-table__number ${tone}`}>{formatUsd(pnl)}</span>
            <span className={`session-table__muted ${tone}`}>{formatPercent(roi)}</span>
          </div>
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
      rowKey={(record: any) => record.id || record.createdAt}
    />
  );
}
