import React from 'react';
import { Table, Tag, Tooltip, Progress } from 'antd';
import { formatDisplaySymbol } from '../utils/symbols';

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

const formatPercent = (value: any) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num >= 0 ? '+' : ''}${num.toFixed(2)}%`;
};

const formatDateTime = (value: any) => {
  if (!value) return null;
  const date = new Date(value);
  return {
    date: date.toLocaleDateString(),
    time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    full: date.toLocaleString(),
  };
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
  expired: { label: 'Expired', tone: 'default' },
};

const ORDER_TYPE_COLORS: Record<string, string> = {
  market: 'blue',
  limit: 'green',
  stop_market: 'orange',
  stop_loss: 'red',
  take_profit: 'cyan',
  take_profit_market: 'cyan',
  trailing_stop: 'purple',
};

export default function OrdersTable({ rows = [] }: OrdersTableProps) {
  const columns = [
    {
      title: 'Created',
      dataIndex: 'createdAt',
      width: 150,
      render: (value: any) => {
        const dt = formatDateTime(value);
        if (!dt) return '—';
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
      title: 'Updated',
      dataIndex: 'updatedAt',
      width: 150,
      render: (value: any) => {
        const dt = formatDateTime(value);
        if (!dt) return '—';
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
      dataIndex: 'side',
      width: 80,
      render: (side: string) => (
        <Tag color={side === 'buy' ? 'green' : 'volcano'} className='session-table__tag'>
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
      title: 'Type',
      dataIndex: 'type',
      width: 120,
      render: (value: string) => {
        if (!value) return '—';
        const color = ORDER_TYPE_COLORS[value.toLowerCase()] || 'default';
        return <Tag color={color}>{value.toUpperCase()}</Tag>;
      },
    },
    {
      title: 'TIF',
      dataIndex: 'tif',
      width: 60,
      align: 'center' as const,
      render: (value: string) => value ? <Tag>{value}</Tag> : '—',
    },
    {
      title: 'Price',
      dataIndex: 'price',
      width: 100,
      align: 'right' as const,
      render: (value: any, record: any) => {
        const price = Number(value);
        const requested = Number(record.requestedPrice);
        if (!Number.isFinite(price)) return '—';
        return (
          <Tooltip title={requested ? `Requested: $${formatNumber(requested)}` : undefined}>
            <span className='session-table__number'>${formatNumber(price)}</span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Qty',
      dataIndex: 'qty',
      width: 90,
      align: 'right' as const,
      render: (value: any, record: any) => {
        const qty = Number(value);
        const requested = Number(record.requestedQty);
        if (!Number.isFinite(qty)) return '—';
        return (
          <Tooltip title={requested ? `Requested: ${formatNumber(requested)}` : undefined}>
            <span className='session-table__number'>{formatNumber(qty)}</span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Notional',
      width: 100,
      align: 'right' as const,
      render: (_: any, record: any) => {
        const qty = Number(record.qty) || 0;
        const price = Number(record.price) || 0;
        const total = qty * price;
        return <span className='session-table__number'>{total ? formatUsd(total) : '—'}</span>;
      },
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
      title: 'SL',
      dataIndex: 'sl',
      width: 90,
      align: 'right' as const,
      render: (value: any) => {
        const sl = Number(value);
        if (!Number.isFinite(sl)) return '—';
        return <span className='session-table__number session-table__number--negative'>${formatNumber(sl)}</span>;
      },
    },
    {
      title: 'TP',
      dataIndex: 'tp',
      width: 90,
      align: 'right' as const,
      render: (value: any) => {
        const tp = Number(value);
        if (!Number.isFinite(tp)) return '—';
        return <span className='session-table__number session-table__number--positive'>${formatNumber(tp)}</span>;
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 100,
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
    {
      title: 'Fill %',
      dataIndex: 'fillRatio',
      width: 100,
      render: (value: any) => {
        const ratio = Number(value);
        if (!Number.isFinite(ratio)) return '—';
        const percent = Math.round(ratio * 100);
        return (
          <Progress
            percent={percent}
            size='small'
            status={percent >= 100 ? 'success' : 'active'}
            strokeWidth={6}
          />
        );
      },
    },
    {
      title: 'Slippage',
      dataIndex: 'slippageBps',
      width: 80,
      align: 'right' as const,
      render: (value: any) => {
        const bps = Number(value);
        if (!Number.isFinite(bps)) return '—';
        const tone = bps > 10 ? 'session-table__number--negative' : bps < 0 ? 'session-table__number--positive' : '';
        return <span className={`session-table__number ${tone}`}>{bps.toFixed(1)} bps</span>;
      },
    },
    {
      title: 'Latency',
      dataIndex: 'latencyMs',
      width: 80,
      align: 'right' as const,
      render: (value: any) => {
        const ms = Number(value);
        if (!Number.isFinite(ms)) return '—';
        const tone = ms > 1000 ? 'session-table__number--negative' : ms < 200 ? 'session-table__number--positive' : '';
        return <span className={`session-table__number ${tone}`}>{ms}ms</span>;
      },
    },
    {
      title: 'Change %',
      dataIndex: 'pctChange',
      width: 90,
      align: 'right' as const,
      render: (value: any) => {
        const pct = Number(value);
        if (!Number.isFinite(pct)) return '—';
        const tone = pct >= 0 ? 'session-table__number--positive' : 'session-table__number--negative';
        return <span className={`session-table__number ${tone}`}>{formatPercent(pct)}</span>;
      },
    },
    {
      title: 'Source',
      dataIndex: 'source',
      width: 80,
      align: 'center' as const,
      render: (value: string) => {
        if (!value) return '—';
        const colorMap: Record<string, string> = {
          agent: 'blue',
          manual: 'green',
          api: 'purple',
          system: 'orange',
        };
        return <Tag color={colorMap[value.toLowerCase()] || 'default'}>{value}</Tag>;
      },
    },
    {
      title: 'Strategy',
      dataIndex: 'strategyUsed',
      width: 120,
      render: (value: string, record: any) => {
        if (!value) return '—';
        const confidence = Number(record.strategyConfidence);
        return (
          <Tooltip title={confidence ? `Confidence: ${(confidence * 100).toFixed(1)}%` : undefined}>
            <Tag color='purple'>{value}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: 'Retries',
      dataIndex: 'attempts',
      width: 70,
      align: 'center' as const,
      render: (value: any, record: any) => {
        const attempts = Number(value) || 0;
        const cancels = Number(record.cancelCount) || 0;
        if (attempts === 0 && cancels === 0) return '—';
        return (
          <Tooltip title={`Attempts: ${attempts}, Cancels: ${cancels}`}>
            <span className='session-table__number'>{attempts}/{cancels}</span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Error',
      dataIndex: 'error',
      width: 150,
      render: (value: string) => {
        if (!value) return '—';
        return (
          <Tooltip title={value}>
            <Tag color='red' style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {value.substring(0, 20)}...
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: 'Order ID',
      dataIndex: 'clientOrderId',
      width: 150,
      render: (value: string, record: any) => {
        const exchangeId = record.exchangeOrderId;
        return (
          <Tooltip title={`Exchange: ${exchangeId || 'N/A'}`}>
            <span className='session-table__muted' style={{ fontSize: 11 }}>
              {value ? value.substring(0, 16) + '...' : '—'}
            </span>
          </Tooltip>
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
      pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `${total} orders` }}
      rowKey={(record: any) => record.id || record.clientOrderId || record.createdAt}
      scroll={{ x: 2200 }}
    />
  );
}
