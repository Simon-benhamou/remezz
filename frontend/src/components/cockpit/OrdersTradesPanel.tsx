/**
 * V5.72: OrdersTradesPanel Component
 *
 * Tabbed panel for orders and trades with filters.
 * Smart defaults: Orders when IN_POSITION, Trades when WATCHING.
 */

import React, { useState, useMemo } from 'react';
import { Table, Tag, Segmented, Select, Empty, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Filter, X } from 'lucide-react';
import type { Order, Trade, TradeFilters, OrdersTradesPanelProps } from '../../types/cockpit';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const formatPrice = (value: number | undefined): string => {
  if (!value || !Number.isFinite(value)) return '—';
  return value >= 100 ? value.toFixed(2) : value.toFixed(4);
};

const formatUsd = (value: number): string => {
  if (!Number.isFinite(value)) return '$0.00';
  const absValue = Math.abs(value);
  if (absValue >= 1000) return `$${(value / 1000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
};

const formatPercent = (value: number): string => {
  if (!Number.isFinite(value)) return '0.00%';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
};

const formatTime = (ts: string | number): string => {
  const date = new Date(ts);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, { hour12: false });
};

const formatDateTime = (ts: string | number): string => {
  const date = new Date(ts);
  if (isNaN(date.getTime())) return '—';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString(undefined, { hour12: false })}`;
};

const getOrderStatusColor = (status: string): string => {
  switch (status.toLowerCase()) {
    case 'filled':
      return 'green';
    case 'pending':
    case 'open':
    case 'new':
      return 'blue';
    case 'canceled':
    case 'expired':
      return 'default';
    default:
      return 'default';
  }
};

const getOrderTypeColor = (type: string): string => {
  switch (type.toLowerCase()) {
    case 'market':
      return 'cyan';
    case 'limit':
      return 'purple';
    case 'stop_market':
      return 'orange';
    case 'take_profit_market':
      return 'green';
    default:
      return 'default';
  }
};

// ============================================================================
// ORDERS TABLE
// ============================================================================

interface OrdersTableProps {
  orders: Order[];
}

const OrdersTable: React.FC<OrdersTableProps> = ({ orders }) => {
  const columns: ColumnsType<Order> = [
    {
      title: 'Time',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 100,
      render: (ts: string) => (
        <Tooltip title={formatDateTime(ts)}>
          <span className="otp-table__time">{formatTime(ts)}</span>
        </Tooltip>
      ),
    },
    {
      title: 'Side',
      dataIndex: 'side',
      key: 'side',
      width: 80,
      render: (side: string) => (
        <Tag color={side === 'buy' ? 'green' : 'red'} className="otp-table__tag">
          {side.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 120,
      render: (type: string) => (
        <Tag color={getOrderTypeColor(type)} className="otp-table__tag">
          {type.replace('_', ' ').toUpperCase()}
        </Tag>
      ),
    },
    {
      title: 'Price',
      dataIndex: 'price',
      key: 'price',
      width: 100,
      align: 'right',
      render: (price: number, record: Order) => (
        <span className="otp-table__number">
          {record.avgPrice ? `$${formatPrice(record.avgPrice)}` : price ? `$${formatPrice(price)}` : 'Market'}
        </span>
      ),
    },
    {
      title: 'Qty',
      dataIndex: 'qty',
      key: 'qty',
      width: 80,
      align: 'right',
      render: (qty: number) => <span className="otp-table__number">{qty.toFixed(4)}</span>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => (
        <Tag color={getOrderStatusColor(status)} className="otp-table__tag">
          {status.toUpperCase()}
        </Tag>
      ),
    },
  ];

  return (
    <Table
      dataSource={orders}
      columns={columns}
      rowKey="id"
      size="small"
      pagination={{ pageSize: 10, hideOnSinglePage: true }}
      className="otp-table"
      locale={{ emptyText: <Empty description="No orders" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
    />
  );
};

// ============================================================================
// TRADES TABLE
// ============================================================================

interface TradesTableProps {
  trades: Trade[];
}

const TradesTable: React.FC<TradesTableProps> = ({ trades }) => {
  const columns: ColumnsType<Trade> = [
    {
      title: 'Exit Time',
      dataIndex: 'exitTs',
      key: 'exitTs',
      width: 100,
      render: (ts: string) => (
        <Tooltip title={formatDateTime(ts)}>
          <span className="otp-table__time">{formatTime(ts)}</span>
        </Tooltip>
      ),
    },
    {
      title: 'Side',
      dataIndex: 'positionSide',
      key: 'positionSide',
      width: 80,
      render: (side: string) => (
        <Tag color={side === 'long' ? 'green' : 'red'} className="otp-table__tag">
          {side.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: 'Entry',
      dataIndex: 'entryPrice',
      key: 'entryPrice',
      width: 90,
      align: 'right',
      render: (price: number) => <span className="otp-table__number">${formatPrice(price)}</span>,
    },
    {
      title: 'Exit',
      dataIndex: 'exitPrice',
      key: 'exitPrice',
      width: 90,
      align: 'right',
      render: (price: number) => <span className="otp-table__number">${formatPrice(price)}</span>,
    },
    {
      title: 'P&L',
      key: 'pnl',
      width: 120,
      align: 'right',
      render: (_: unknown, record: Trade) => {
        const isPositive = record.realizedPnlUsd >= 0;
        return (
          <div className="otp-table__pnl">
            <span className={`otp-table__number ${isPositive ? 'otp-table__number--positive' : 'otp-table__number--negative'}`}>
              {formatUsd(record.realizedPnlUsd)}
            </span>
            <span className={`otp-table__pct ${isPositive ? 'otp-table__pct--positive' : 'otp-table__pct--negative'}`}>
              {formatPercent(record.pctChange)}
            </span>
          </div>
        );
      },
    },
    {
      title: 'Exit Reason',
      dataIndex: 'exitReason',
      key: 'exitReason',
      width: 120,
      render: (reason: string) => (
        <Tooltip title={reason}>
          <span className="otp-table__reason">{reason || '—'}</span>
        </Tooltip>
      ),
    },
    {
      title: 'Duration',
      dataIndex: 'durationMinutes',
      key: 'durationMinutes',
      width: 80,
      align: 'right',
      render: (mins: number) => {
        if (!mins) return '—';
        const hours = Math.floor(mins / 60);
        if (hours > 0) return `${hours}h ${mins % 60}m`;
        return `${mins}m`;
      },
    },
  ];

  return (
    <Table
      dataSource={trades}
      columns={columns}
      rowKey="id"
      size="small"
      pagination={{ pageSize: 10, hideOnSinglePage: true }}
      className="otp-table"
      locale={{ emptyText: <Empty description="No trades yet" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
    />
  );
};

// ============================================================================
// FILTERS COMPONENT
// ============================================================================

interface FiltersBarProps {
  filters: TradeFilters;
  onFilterChange: (filters: TradeFilters) => void;
  showSideFilter?: boolean;
}

const FiltersBar: React.FC<FiltersBarProps> = ({ filters, onFilterChange, showSideFilter = true }) => {
  const hasFilters = filters.side || filters.result || filters.dateRange;

  const clearFilters = () => {
    onFilterChange({});
  };

  return (
    <div className="otp-filters">
      <Filter size={14} color="rgba(226, 232, 240, 0.6)" />

      {showSideFilter && (
        <Select
          placeholder="Side"
          value={filters.side}
          onChange={(value) => onFilterChange({ ...filters, side: value })}
          allowClear
          size="small"
          className="otp-filters__select"
          options={[
            { value: 'long', label: 'Long' },
            { value: 'short', label: 'Short' },
          ]}
        />
      )}

      <Select
        placeholder="Result"
        value={filters.result}
        onChange={(value) => onFilterChange({ ...filters, result: value })}
        allowClear
        size="small"
        className="otp-filters__select"
        options={[
          { value: 'win', label: 'Win' },
          { value: 'loss', label: 'Loss' },
          { value: 'breakeven', label: 'Break-even' },
        ]}
      />

      {hasFilters && (
        <Tooltip title="Clear filters">
          <button className="otp-filters__clear" onClick={clearFilters}>
            <X size={14} />
          </button>
        </Tooltip>
      )}
    </div>
  );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

const OrdersTradesPanel: React.FC<OrdersTradesPanelProps> = ({
  orders,
  trades,
  defaultTab,
  filters,
  onFilterChange,
}) => {
  const [activeTab, setActiveTab] = useState<'orders' | 'trades'>(defaultTab);

  // Filter trades based on filters
  const filteredTrades = useMemo(() => {
    let result = [...trades];

    if (filters.side) {
      result = result.filter((t) => t.positionSide === filters.side);
    }

    if (filters.result) {
      result = result.filter((t) => {
        const pnl = t.realizedPnlUsd;
        if (filters.result === 'win') return pnl > 0;
        if (filters.result === 'loss') return pnl < 0;
        if (filters.result === 'breakeven') return pnl === 0;
        return true;
      });
    }

    if (filters.dateRange) {
      const [start, end] = filters.dateRange;
      result = result.filter((t) => {
        const exitDate = new Date(t.exitTs);
        return exitDate >= start && exitDate <= end;
      });
    }

    return result;
  }, [trades, filters]);

  // Count active orders
  const activeOrdersCount = useMemo(
    () =>
      orders.filter((o) =>
        ['new', 'open', 'pending', 'working'].includes(o.status.toLowerCase())
      ).length,
    [orders]
  );

  return (
    <div className="otp-panel">
      <div className="otp-panel__header">
        <Segmented
          value={activeTab}
          onChange={(value) => setActiveTab(value as 'orders' | 'trades')}
          options={[
            {
              label: (
                <span className="otp-tab">
                  Trades <span className="otp-tab__count">{filteredTrades.length}</span>
                </span>
              ),
              value: 'trades',
            },
            {
              label: (
                <span className="otp-tab">
                  Orders{' '}
                  {activeOrdersCount > 0 && (
                    <span className="otp-tab__count otp-tab__count--active">{activeOrdersCount}</span>
                  )}
                </span>
              ),
              value: 'orders',
            },
          ]}
          className="otp-panel__tabs"
        />

        {activeTab === 'trades' && (
          <FiltersBar filters={filters} onFilterChange={onFilterChange} />
        )}
      </div>

      <div className="otp-panel__content">
        {activeTab === 'trades' ? (
          <TradesTable trades={filteredTrades} />
        ) : (
          <OrdersTable orders={orders} />
        )}
      </div>

      <style>{styles}</style>
    </div>
  );
};

// ============================================================================
// STYLES
// ============================================================================

const styles = `
  .otp-panel {
    background: rgba(15, 23, 42, 0.92);
    border-radius: 16px;
    border: 1px solid rgba(100, 116, 139, 0.18);
    overflow: hidden;
  }

  .otp-panel__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 16px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.12);
    flex-wrap: wrap;
  }

  .otp-panel__tabs {
    background: rgba(30, 41, 59, 0.8) !important;
    border-radius: 8px !important;
  }

  .otp-tab {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .otp-tab__count {
    font-size: 11px;
    background: rgba(100, 116, 139, 0.3);
    padding: 1px 6px;
    border-radius: 4px;
    font-family: 'JetBrains Mono', monospace;
  }

  .otp-tab__count--active {
    background: rgba(59, 130, 246, 0.3);
    color: #60a5fa;
  }

  .otp-filters {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .otp-filters__select {
    min-width: 100px;
  }

  .otp-filters__select .ant-select-selector {
    background: rgba(30, 41, 59, 0.8) !important;
    border-color: rgba(148, 163, 184, 0.2) !important;
  }

  .otp-filters__clear {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    background: rgba(239, 68, 68, 0.2);
    border-radius: 4px;
    cursor: pointer;
    color: #ef4444;
    transition: background 0.2s;
  }

  .otp-filters__clear:hover {
    background: rgba(239, 68, 68, 0.3);
  }

  .otp-panel__content {
    padding: 0;
  }

  .otp-table .ant-table {
    background: transparent !important;
  }

  .otp-table .ant-table-thead > tr > th {
    background: rgba(30, 41, 59, 0.6) !important;
    color: rgba(226, 232, 240, 0.7) !important;
    border-bottom: 1px solid rgba(148, 163, 184, 0.12) !important;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 8px 12px !important;
  }

  .otp-table .ant-table-tbody > tr > td {
    background: transparent !important;
    border-bottom: 1px solid rgba(148, 163, 184, 0.08) !important;
    color: rgba(226, 232, 240, 0.85);
    padding: 8px 12px !important;
  }

  .otp-table .ant-table-tbody > tr:hover > td {
    background: rgba(59, 130, 246, 0.08) !important;
  }

  .otp-table__time {
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
    color: rgba(226, 232, 240, 0.7);
  }

  .otp-table__tag {
    font-size: 10px !important;
    padding: 0 6px !important;
    border-radius: 4px !important;
    font-weight: 600;
  }

  .otp-table__number {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: rgba(226, 232, 240, 0.9);
  }

  .otp-table__number--positive {
    color: #10b981 !important;
  }

  .otp-table__number--negative {
    color: #ef4444 !important;
  }

  .otp-table__pnl {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
  }

  .otp-table__pct {
    font-size: 10px;
    font-family: 'JetBrains Mono', monospace;
  }

  .otp-table__pct--positive {
    color: rgba(16, 185, 129, 0.8);
  }

  .otp-table__pct--negative {
    color: rgba(239, 68, 68, 0.8);
  }

  .otp-table__reason {
    font-size: 11px;
    color: rgba(226, 232, 240, 0.6);
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .otp-table .ant-pagination {
    margin: 12px !important;
  }

  .otp-table .ant-empty-description {
    color: rgba(226, 232, 240, 0.5);
  }

  @media (max-width: 768px) {
    .otp-panel__header {
      flex-direction: column;
      align-items: stretch;
    }

    .otp-filters {
      flex-wrap: wrap;
    }
  }
`;

export default OrdersTradesPanel;
