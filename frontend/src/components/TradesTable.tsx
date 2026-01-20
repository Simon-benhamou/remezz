import React from 'react';
import { Table, Tag, Tooltip } from 'antd';
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

const formatDuration = (minutes: any) => {
  const mins = Number(minutes);
  if (!Number.isFinite(mins)) return '—';
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = Math.floor(mins / 60);
  const remainingMins = Math.round(mins % 60);
  return `${hours}h ${remainingMins}m`;
};

const formatDateTime = (value: any) => {
  if (!value) return '—';
  const date = new Date(value);
  return {
    date: date.toLocaleDateString(),
    time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    full: date.toLocaleString(),
  };
};

export default function TradesTable({ rows = [] }: TradesTableProps) {
  const columns = [
    {
      title: 'Entry Time',
      dataIndex: 'entryTs',
      width: 150,
      render: (value: any) => {
        const dt = formatDateTime(value);
        if (dt === '—') return '—';
        return (
          <Tooltip title={dt.full}>
            <div className='session-table__time'>
              <span>{dt.date}</span>
              <span>{dt.time}</span>
            </div>
          </Tooltip>
        );
      },
    },
    {
      title: 'Exit Time',
      dataIndex: 'exitTs',
      width: 150,
      render: (value: any) => {
        const dt = formatDateTime(value);
        if (dt === '—') return '—';
        return (
          <Tooltip title={dt.full}>
            <div className='session-table__time'>
              <span>{dt.date}</span>
              <span>{dt.time}</span>
            </div>
          </Tooltip>
        );
      },
    },
    {
      title: 'Side',
      dataIndex: 'positionSide',
      width: 80,
      render: (side: string) => (
        <Tag color={side === 'long' ? 'green' : 'volcano'} className='session-table__tag'>
          {String(side || '—').toUpperCase()}
        </Tag>
      ),
    },
    {
      title: 'Symbol',
      dataIndex: 'symbol',
      width: 100,
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
      title: 'Entry',
      dataIndex: 'entryPrice',
      width: 100,
      align: 'right' as const,
      render: (value: any) => <span className='session-table__number'>${formatNumber(value)}</span>,
    },
    {
      title: 'Exit',
      dataIndex: 'exitPrice',
      width: 100,
      align: 'right' as const,
      render: (value: any) => <span className='session-table__number'>${formatNumber(value)}</span>,
    },
    {
      title: 'Qty',
      dataIndex: 'qty',
      width: 90,
      align: 'right' as const,
      render: (value: any) => <span className='session-table__number'>{formatNumber(value)}</span>,
    },
    {
      title: 'Notional',
      dataIndex: 'entryNotional',
      width: 100,
      align: 'right' as const,
      render: (value: any) => <span className='session-table__number'>{formatUsd(value)}</span>,
    },
    {
      title: 'Leverage',
      dataIndex: 'leverage',
      width: 70,
      align: 'center' as const,
      render: (value: any) => {
        const lev = Number(value);
        if (!Number.isFinite(lev)) return '—';
        return <Tag color='blue'>{lev}x</Tag>;
      },
    },
    {
      title: 'P&L',
      dataIndex: 'realizedPnlUsd',
      width: 100,
      align: 'right' as const,
      render: (value: any) => {
        const pnl = Number(value || 0);
        const tone = pnl >= 0 ? 'session-table__number--positive' : 'session-table__number--negative';
        return <span className={`session-table__number ${tone}`}>{formatUsd(pnl)}</span>;
      },
    },
    {
      title: 'ROI %',
      dataIndex: 'roiPct',
      width: 80,
      align: 'right' as const,
      render: (value: any) => {
        const roi = Number(value || 0);
        const tone = roi >= 0 ? 'session-table__number--positive' : 'session-table__number--negative';
        return <span className={`session-table__number ${tone}`}>{formatPercent(roi)}</span>;
      },
    },
    {
      title: 'ROE %',
      dataIndex: 'roePct',
      width: 80,
      align: 'right' as const,
      render: (value: any) => {
        const roe = Number(value || 0);
        const tone = roe >= 0 ? 'session-table__number--positive' : 'session-table__number--negative';
        return <span className={`session-table__number ${tone}`}>{formatPercent(roe)}</span>;
      },
    },
    {
      title: 'Change %',
      dataIndex: 'pctChange',
      width: 90,
      align: 'right' as const,
      render: (value: any) => {
        const pct = Number(value || 0);
        const tone = pct >= 0 ? 'session-table__number--positive' : 'session-table__number--negative';
        return <span className={`session-table__number ${tone}`}>{formatPercent(pct)}</span>;
      },
    },
    {
      title: 'Max P&L %',
      dataIndex: 'maxPnlPct',
      width: 90,
      align: 'right' as const,
      render: (value: any) => {
        const max = Number(value || 0);
        const tone = max >= 0 ? 'session-table__number--positive' : 'session-table__number--negative';
        return <span className={`session-table__number ${tone}`}>{formatPercent(max)}</span>;
      },
    },
    {
      title: 'Fees',
      dataIndex: 'feesUsd',
      width: 80,
      align: 'right' as const,
      render: (value: any) => <span className='session-table__muted'>{formatUsd(value)}</span>,
    },
    {
      title: 'Duration',
      dataIndex: 'durationMinutes',
      width: 90,
      align: 'right' as const,
      render: (value: any) => <span className='session-table__number'>{formatDuration(value)}</span>,
    },
    {
      title: 'Exit Reason',
      dataIndex: 'exitReason',
      width: 120,
      render: (value: any) => {
        if (!value) return '—';
        const colorMap: Record<string, string> = {
          tp: 'green',
          take_profit: 'green',
          sl: 'red',
          stop_loss: 'red',
          trailing: 'orange',
          trailing_stop: 'orange',
          manual: 'blue',
          regime_change: 'purple',
          timeout: 'default',
        };
        const color = colorMap[value.toLowerCase()] || 'default';
        return (
          <Tooltip title={value}>
            <Tag color={color}>{value}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: 'Orders',
      dataIndex: 'orderCount',
      width: 70,
      align: 'center' as const,
      render: (value: any) => {
        const count = Number(value);
        if (!Number.isFinite(count)) return '—';
        return <span className='session-table__number'>{count}</span>;
      },
    },
  ];

  return (
    <Table
      className='session-table'
      columns={columns}
      dataSource={rows}
      size='small'
      pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `${total} trades` }}
      rowKey={(record: any) => record.id || record.entryTs}
      scroll={{ x: 1800 }}
    />
  );
}
