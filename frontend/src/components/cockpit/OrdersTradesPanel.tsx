/**
 * V5.79: OrdersTradesPanel Component - Full Data Display
 *
 * Tabbed panel for orders and trades with all available fields.
 * Smart defaults: Orders when IN_POSITION, Trades when WATCHING.
 */

import React, { useState, useMemo } from 'react';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { Filter, X, Inbox } from 'lucide-react';
import type { Order, Trade, TradeFilters, OrdersTradesPanelProps } from '../../types/cockpit';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const formatPrice = (value: number | undefined): string => {
  if (!value || !Number.isFinite(value)) return '\u2014';
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
  if (isNaN(date.getTime())) return '\u2014';
  return date.toLocaleTimeString(undefined, { hour12: false });
};

const formatDateTime = (ts: string | number): string => {
  const date = new Date(ts);
  if (isNaN(date.getTime())) return '\u2014';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString(undefined, { hour12: false })}`;
};

const formatDuration = (mins: number | undefined): string => {
  if (!mins || !Number.isFinite(mins)) return '\u2014';
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${Math.round(mins % 60)}m`;
  return `${Math.round(mins)}m`;
};

const getOrderStatusClasses = (status: string): string => {
  switch (status.toLowerCase()) {
    case 'filled':
      return 'bg-green-500/10 text-green-400 ring-1 ring-green-500/20';
    case 'pending':
    case 'open':
    case 'new':
      return 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20';
    case 'canceled':
    case 'expired':
      return 'bg-zinc-500/10 text-zinc-400 ring-1 ring-zinc-500/20';
    case 'rejected':
      return 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20';
    default:
      return 'bg-zinc-500/10 text-zinc-400 ring-1 ring-zinc-500/20';
  }
};

const getOrderTypeClasses = (type: string): string => {
  switch (type.toLowerCase()) {
    case 'market':
      return 'bg-cyan-500/10 text-cyan-400 ring-1 ring-cyan-500/20';
    case 'limit':
      return 'bg-purple-500/10 text-purple-400 ring-1 ring-purple-500/20';
    case 'stop_market':
      return 'bg-orange-500/10 text-orange-400 ring-1 ring-orange-500/20';
    case 'stop_loss':
      return 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20';
    case 'take_profit_market':
    case 'take_profit':
      return 'bg-green-500/10 text-green-400 ring-1 ring-green-500/20';
    case 'trailing_stop':
      return 'bg-pink-500/10 text-pink-400 ring-1 ring-pink-500/20';
    default:
      return 'bg-zinc-500/10 text-zinc-400 ring-1 ring-zinc-500/20';
  }
};

const getExitReasonClasses = (reason: string): string => {
  const r = reason?.toLowerCase() || '';
  if (r.includes('tp') || r.includes('take_profit')) return 'bg-green-500/10 text-green-400 ring-1 ring-green-500/20';
  if (r.includes('sl') || r.includes('stop_loss')) return 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20';
  if (r.includes('trailing')) return 'bg-orange-500/10 text-orange-400 ring-1 ring-orange-500/20';
  if (r.includes('manual')) return 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20';
  if (r.includes('regime')) return 'bg-purple-500/10 text-purple-400 ring-1 ring-purple-500/20';
  return 'bg-zinc-500/10 text-zinc-400 ring-1 ring-zinc-500/20';
};

const tagBase = 'inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold whitespace-nowrap';

// ============================================================================
// EMPTY STATE COMPONENT
// ============================================================================

const EmptyState: React.FC<{ description: string }> = ({ description }) => (
  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
    <Inbox size={32} className="mb-2 opacity-50" />
    <span className="text-sm">{description}</span>
  </div>
);

// ============================================================================
// PAGINATION COMPONENT
// ============================================================================

interface PaginationProps {
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  label: string;
}

const SimplePagination: React.FC<PaginationProps> = ({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  label,
}) => {
  const totalPages = Math.ceil(total / pageSize);
  if (total === 0) return null;

  return (
    <div className="flex items-center justify-between px-4 py-3 text-xs text-[var(--text-muted)]">
      <span className="font-mono">{total} {label}</span>
      <div className="flex items-center gap-2">
        <Select
          value={String(pageSize)}
          onValueChange={(v) => { onPageSizeChange(Number(v)); onPageChange(1); }}
        >
          <SelectTrigger className="h-7 w-[70px] text-xs bg-[rgba(30,41,59,0.8)] border-[var(--border-subtle)]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[10, 15, 25, 50].map((s) => (
              <SelectItem key={s} value={String(s)}>{s} / page</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="px-2 py-1 rounded border border-[var(--border-subtle)] disabled:opacity-30 hover:bg-[var(--bg-card-hover)]"
        >
          Prev
        </button>
        <span className="font-mono">{page}/{totalPages}</span>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="px-2 py-1 rounded border border-[var(--border-subtle)] disabled:opacity-30 hover:bg-[var(--bg-card-hover)]"
        >
          Next
        </button>
      </div>
    </div>
  );
};

// ============================================================================
// ORDERS TABLE - FULL COLUMNS
// ============================================================================

interface OrdersTableProps {
  orders: Order[];
}

const OrdersTable: React.FC<OrdersTableProps> = ({ orders }) => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  const pagedOrders = useMemo(() => {
    const start = (page - 1) * pageSize;
    return orders.slice(start, start + pageSize);
  }, [orders, page, pageSize]);

  if (orders.length === 0) {
    return <EmptyState description="No orders" />;
  }

  return (
    <TooltipProvider>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider sticky left-0 bg-[rgba(30,41,59,0.6)] z-10">Created</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Updated</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Side</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Symbol</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Type</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">TIF</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Price</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Qty</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Notional</th>
              <th className="px-2 py-1.5 text-center font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Lev</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">SL</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">TP</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Status</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Fill %</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Slip</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Latency</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Chg %</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Source</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Strategy</th>
              <th className="px-2 py-1.5 text-center font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Retry</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Error</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Order ID</th>
            </tr>
          </thead>
          <tbody>
            {pagedOrders.map((order: any) => {
              const notional = (order.qty || 0) * (order.price || 0);
              return (
                <tr key={order.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  {/* Created */}
                  <td className="px-2 py-1.5 whitespace-nowrap sticky left-0 bg-[var(--bg-primary)] z-10">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="otp-table__time">{formatTime(order.createdAt)}</span>
                      </TooltipTrigger>
                      <TooltipContent>{formatDateTime(order.createdAt)}</TooltipContent>
                    </Tooltip>
                  </td>
                  {/* Updated */}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="otp-table__time">{formatTime(order.updatedAt)}</span>
                      </TooltipTrigger>
                      <TooltipContent>{formatDateTime(order.updatedAt)}</TooltipContent>
                    </Tooltip>
                  </td>
                  {/* Side */}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <span className={cn(tagBase, order.side === 'buy' ? 'bg-green-500/10 text-green-400 ring-1 ring-green-500/20' : 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20')}>
                      {order.side?.toUpperCase() || '\u2014'}
                    </span>
                  </td>
                  {/* Symbol */}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <span className={cn(tagBase, 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20')}>
                      {order.symbol?.replace('/USDT:USDT', '') || '\u2014'}
                    </span>
                  </td>
                  {/* Type */}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <span className={cn(tagBase, getOrderTypeClasses(order.type))}>
                      {order.type?.replace('_', ' ').toUpperCase() || '\u2014'}
                    </span>
                  </td>
                  {/* TIF */}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {order.tif ? (
                      <span className={cn(tagBase, 'bg-zinc-500/10 text-zinc-400 ring-1 ring-zinc-500/20')}>{order.tif}</span>
                    ) : '\u2014'}
                  </td>
                  {/* Price */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="otp-table__number">
                          {order.avgPrice ? `$${formatPrice(order.avgPrice)}` : order.price ? `$${formatPrice(order.price)}` : 'Market'}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{order.requestedPrice ? `Requested: $${formatPrice(order.requestedPrice)}` : 'No requested price'}</TooltipContent>
                    </Tooltip>
                  </td>
                  {/* Qty */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="otp-table__number">{order.qty?.toFixed(4) || '\u2014'}</span>
                      </TooltipTrigger>
                      <TooltipContent>{order.requestedQty ? `Requested: ${order.requestedQty.toFixed(4)}` : 'No requested qty'}</TooltipContent>
                    </Tooltip>
                  </td>
                  {/* Notional */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    <span className="otp-table__number">{notional > 0 ? formatUsd(notional) : '\u2014'}</span>
                  </td>
                  {/* Lev */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-center">
                    {order.leverage ? (
                      <span className={cn(tagBase, 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20')}>{order.leverage}x</span>
                    ) : '\u2014'}
                  </td>
                  {/* SL */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    {order.sl ? <span className="otp-table__number otp-table__number--negative">${formatPrice(order.sl)}</span> : '\u2014'}
                  </td>
                  {/* TP */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    {order.tp ? <span className="otp-table__number otp-table__number--positive">${formatPrice(order.tp)}</span> : '\u2014'}
                  </td>
                  {/* Status */}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <span className={cn(tagBase, getOrderStatusClasses(order.status))}>
                      {order.status?.toUpperCase() || '\u2014'}
                    </span>
                  </td>
                  {/* Fill % */}
                  <td className="px-2 py-1.5 whitespace-nowrap" style={{ minWidth: 80 }}>
                    {order.fillRatio && Number.isFinite(order.fillRatio) ? (
                      <div className="flex items-center gap-1.5">
                        <Progress
                          value={Math.round(order.fillRatio * 100)}
                          className={cn('h-1.5 w-12', Math.round(order.fillRatio * 100) >= 100 && '[&>div]:bg-green-500')}
                        />
                        <span className="otp-table__number text-[10px]">{Math.round(order.fillRatio * 100)}%</span>
                      </div>
                    ) : '\u2014'}
                  </td>
                  {/* Slip */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    {order.slippageBps && Number.isFinite(order.slippageBps) ? (
                      <span className={cn('otp-table__number', order.slippageBps > 10 && 'otp-table__number--negative', order.slippageBps < 0 && 'otp-table__number--positive')}>
                        {order.slippageBps.toFixed(1)}
                      </span>
                    ) : '\u2014'}
                  </td>
                  {/* Latency */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    {order.latencyMs && Number.isFinite(order.latencyMs) ? (
                      <span className={cn('otp-table__number', order.latencyMs > 1000 && 'otp-table__number--negative', order.latencyMs < 200 && 'otp-table__number--positive')}>
                        {order.latencyMs}ms
                      </span>
                    ) : '\u2014'}
                  </td>
                  {/* Chg % */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    {order.pctChange && Number.isFinite(order.pctChange) ? (
                      <span className={cn('otp-table__number', order.pctChange >= 0 ? 'otp-table__number--positive' : 'otp-table__number--negative')}>
                        {formatPercent(order.pctChange)}
                      </span>
                    ) : '\u2014'}
                  </td>
                  {/* Source */}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {order.source ? (() => {
                      const sourceClasses: Record<string, string> = {
                        agent: 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20',
                        manual: 'bg-green-500/10 text-green-400 ring-1 ring-green-500/20',
                        api: 'bg-purple-500/10 text-purple-400 ring-1 ring-purple-500/20',
                        system: 'bg-orange-500/10 text-orange-400 ring-1 ring-orange-500/20',
                      };
                      return (
                        <span className={cn(tagBase, sourceClasses[order.source.toLowerCase()] || 'bg-zinc-500/10 text-zinc-400 ring-1 ring-zinc-500/20')}>
                          {order.source}
                        </span>
                      );
                    })() : '\u2014'}
                  </td>
                  {/* Strategy */}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {order.strategyUsed ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={cn(tagBase, 'bg-purple-500/10 text-purple-400 ring-1 ring-purple-500/20')}>
                            {order.strategyUsed}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{order.strategyConfidence ? `Confidence: ${(order.strategyConfidence * 100).toFixed(1)}%` : 'No confidence data'}</TooltipContent>
                      </Tooltip>
                    ) : '\u2014'}
                  </td>
                  {/* Retry */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-center">
                    {(order.attempts || order.cancelCount) ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="otp-table__number">{order.attempts || 0}/{order.cancelCount || 0}</span>
                        </TooltipTrigger>
                        <TooltipContent>Attempts: {order.attempts || 0}, Cancels: {order.cancelCount || 0}</TooltipContent>
                      </Tooltip>
                    ) : '\u2014'}
                  </td>
                  {/* Error */}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {order.error ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={cn(tagBase, 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20 max-w-[90px] overflow-hidden text-ellipsis')}>
                            {order.error.substring(0, 12)}...
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{order.error}</TooltipContent>
                      </Tooltip>
                    ) : '\u2014'}
                  </td>
                  {/* Order ID */}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="otp-table__muted" style={{ fontSize: 10 }}>
                          {order.clientOrderId ? order.clientOrderId.substring(0, 14) + '...' : '\u2014'}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>Exchange: {order.exchangeOrderId || 'N/A'}</TooltipContent>
                    </Tooltip>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <SimplePagination
        total={orders.length}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        label="orders"
      />
    </TooltipProvider>
  );
};

// ============================================================================
// TRADES TABLE - FULL COLUMNS
// ============================================================================

interface TradesTableProps {
  trades: Trade[];
}

const TradesTable: React.FC<TradesTableProps> = ({ trades }) => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  const pagedTrades = useMemo(() => {
    const start = (page - 1) * pageSize;
    return trades.slice(start, start + pageSize);
  }, [trades, page, pageSize]);

  if (trades.length === 0) {
    return <EmptyState description="No trades yet" />;
  }

  return (
    <TooltipProvider>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider sticky left-0 bg-[rgba(30,41,59,0.6)] z-10">Entry</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Exit</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Side</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Symbol</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Entry $</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Exit $</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Qty</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Notional</th>
              <th className="px-2 py-1.5 text-center font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Lev</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">P&L</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">ROI %</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">ROE %</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Chg %</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Max %</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Fees</th>
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Duration</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Exit Reason</th>
              <th className="px-2 py-1.5 text-center font-medium text-muted-foreground whitespace-nowrap text-[10px] uppercase tracking-wider">Orders</th>
            </tr>
          </thead>
          <tbody>
            {pagedTrades.map((trade: any) => {
              const isPositive = trade.realizedPnlUsd >= 0;
              return (
                <tr key={trade.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  {/* Entry */}
                  <td className="px-2 py-1.5 whitespace-nowrap sticky left-0 bg-[var(--bg-primary)] z-10">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="otp-table__time">{formatTime(trade.entryTs)}</span>
                      </TooltipTrigger>
                      <TooltipContent>{formatDateTime(trade.entryTs)}</TooltipContent>
                    </Tooltip>
                  </td>
                  {/* Exit */}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="otp-table__time">{formatTime(trade.exitTs)}</span>
                      </TooltipTrigger>
                      <TooltipContent>{formatDateTime(trade.exitTs)}</TooltipContent>
                    </Tooltip>
                  </td>
                  {/* Side */}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <span className={cn(tagBase, trade.positionSide === 'long' ? 'bg-green-500/10 text-green-400 ring-1 ring-green-500/20' : 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20')}>
                      {trade.positionSide?.toUpperCase() || '\u2014'}
                    </span>
                  </td>
                  {/* Symbol */}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <span className={cn(tagBase, 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20')}>
                      {trade.symbol?.replace('/USDT:USDT', '') || '\u2014'}
                    </span>
                  </td>
                  {/* Entry $ */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    <span className="otp-table__number">${formatPrice(trade.entryPrice)}</span>
                  </td>
                  {/* Exit $ */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    <span className="otp-table__number">${formatPrice(trade.exitPrice)}</span>
                  </td>
                  {/* Qty */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    <span className="otp-table__number">{trade.qty?.toFixed(4) || '\u2014'}</span>
                  </td>
                  {/* Notional */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    <span className="otp-table__number">{trade.entryNotional ? formatUsd(trade.entryNotional) : '\u2014'}</span>
                  </td>
                  {/* Lev */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-center">
                    {trade.leverage ? (
                      <span className={cn(tagBase, 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20')}>{trade.leverage}x</span>
                    ) : '\u2014'}
                  </td>
                  {/* P&L */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    <span className={cn('otp-table__number', isPositive ? 'otp-table__number--positive' : 'otp-table__number--negative')}>
                      {formatUsd(trade.realizedPnlUsd)}
                    </span>
                  </td>
                  {/* ROI % */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    {trade.roiPct && Number.isFinite(trade.roiPct) ? (
                      <span className={cn('otp-table__number', trade.roiPct >= 0 ? 'otp-table__number--positive' : 'otp-table__number--negative')}>
                        {formatPercent(trade.roiPct)}
                      </span>
                    ) : '\u2014'}
                  </td>
                  {/* ROE % */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    {trade.roePct && Number.isFinite(trade.roePct) ? (
                      <span className={cn('otp-table__number', trade.roePct >= 0 ? 'otp-table__number--positive' : 'otp-table__number--negative')}>
                        {formatPercent(trade.roePct)}
                      </span>
                    ) : '\u2014'}
                  </td>
                  {/* Chg % */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    {trade.pctChange && Number.isFinite(trade.pctChange) ? (
                      <span className={cn('otp-table__number', trade.pctChange >= 0 ? 'otp-table__number--positive' : 'otp-table__number--negative')}>
                        {formatPercent(trade.pctChange)}
                      </span>
                    ) : '\u2014'}
                  </td>
                  {/* Max % */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    {trade.maxPnlPct && Number.isFinite(trade.maxPnlPct) ? (
                      <span className={cn('otp-table__number', trade.maxPnlPct >= 0 ? 'otp-table__number--positive' : 'otp-table__number--negative')}>
                        {formatPercent(trade.maxPnlPct)}
                      </span>
                    ) : '\u2014'}
                  </td>
                  {/* Fees */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    <span className="otp-table__muted">{trade.feesUsd ? formatUsd(trade.feesUsd) : '\u2014'}</span>
                  </td>
                  {/* Duration */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    <span className="otp-table__number">{formatDuration(trade.durationMinutes)}</span>
                  </td>
                  {/* Exit Reason */}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {trade.exitReason ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={cn(tagBase, getExitReasonClasses(trade.exitReason))}>{trade.exitReason}</span>
                        </TooltipTrigger>
                        <TooltipContent>{trade.exitReason}</TooltipContent>
                      </Tooltip>
                    ) : '\u2014'}
                  </td>
                  {/* Orders */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-center">
                    {trade.orderCount ? <span className="otp-table__number">{trade.orderCount}</span> : '\u2014'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <SimplePagination
        total={trades.length}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        label="trades"
      />
    </TooltipProvider>
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
    <TooltipProvider>
      <div className="otp-filters">
        <Filter size={14} color="var(--text-muted)" />

        {showSideFilter && (
          <Select
            value={filters.side || ''}
            onValueChange={(value) => onFilterChange({ ...filters, side: value as TradeFilters['side'] })}
          >
            <SelectTrigger className="h-7 min-w-[100px] text-xs bg-[rgba(30,41,59,0.8)] border-[var(--border-subtle)]">
              <SelectValue placeholder="Side" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="long">Long</SelectItem>
              <SelectItem value="short">Short</SelectItem>
            </SelectContent>
          </Select>
        )}

        <Select
          value={filters.result || ''}
          onValueChange={(value) => onFilterChange({ ...filters, result: value as TradeFilters['result'] })}
        >
          <SelectTrigger className="h-7 min-w-[100px] text-xs bg-[rgba(30,41,59,0.8)] border-[var(--border-subtle)]">
            <SelectValue placeholder="Result" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="win">Win</SelectItem>
            <SelectItem value="loss">Loss</SelectItem>
            <SelectItem value="breakeven">Break-even</SelectItem>
          </SelectContent>
        </Select>

        {hasFilters && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="otp-filters__clear" onClick={clearFilters}>
                <X size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Clear filters</TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
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
        {/* Segmented toggle group */}
        <div className="inline-flex rounded-lg bg-muted p-1">
          <button
            className={cn(
              'inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              activeTab === 'trades'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => setActiveTab('trades')}
          >
            <span className="otp-tab">
              Trades <span className="otp-tab__count">{filteredTrades.length}</span>
            </span>
          </button>
          <button
            className={cn(
              'inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              activeTab === 'orders'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => setActiveTab('orders')}
          >
            <span className="otp-tab">
              Orders{' '}
              {activeOrdersCount > 0 && (
                <span className="otp-tab__count otp-tab__count--active">{activeOrdersCount}</span>
              )}
            </span>
          </button>
        </div>

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
    background: var(--bg-primary);
    border-radius: 16px;
    border: 1px solid var(--border-subtle);
    overflow: hidden;
  }

  .otp-panel__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-subtle);
    flex-wrap: wrap;
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
    color: var(--accent);
  }

  .otp-filters {
    display: flex;
    align-items: center;
    gap: 8px;
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
    color: var(--error);
    transition: background 0.2s;
  }

  .otp-filters__clear:hover {
    background: rgba(239, 68, 68, 0.3);
  }

  .otp-panel__content {
    padding: 0;
    overflow-x: auto;
  }

  .otp-table__time {
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
    color: var(--text-muted);
  }

  .otp-table__number {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text-primary);
  }

  .otp-table__muted {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: var(--text-muted);
  }

  .otp-table__number--positive {
    color: var(--success) !important;
  }

  .otp-table__number--negative {
    color: var(--error) !important;
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
    color: var(--text-muted);
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
