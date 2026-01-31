/**
 * V5.72: LiveMetricsBar Component
 *
 * Improved live market metrics bar with dark trading theme.
 */

import React, { useMemo } from 'react';
import { Alert, Tooltip, Skeleton } from 'antd';
import {
  ArrowUp,
  ArrowDown,
  TrendingUp,
  TrendingDown,
  BarChart3,
  Waves,
} from 'lucide-react';
import type { LiveMetricsBarProps } from '../../types/cockpit';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const formatPrice = (value: number, decimals?: number): string => {
  if (!Number.isFinite(value) || value === 0) return '—';
  const d = decimals ?? (value >= 100 ? 2 : value >= 1 ? 4 : 6);
  return value.toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
};

const formatVolume = (vol: number): string => {
  if (!Number.isFinite(vol) || vol === 0) return '—';
  if (vol >= 1e9) return `${(vol / 1e9).toFixed(2)}B`;
  if (vol >= 1e6) return `${(vol / 1e6).toFixed(2)}M`;
  if (vol >= 1e3) return `${(vol / 1e3).toFixed(1)}K`;
  return vol.toFixed(0);
};

const formatPercent = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
};

// ============================================================================
// METRIC ITEM COMPONENT
// ============================================================================

interface MetricItemProps {
  label: string;
  value: string;
  subValue?: string;
  icon?: React.ReactNode;
  color?: 'positive' | 'negative' | 'neutral';
  tooltip?: string;
}

const MetricItem: React.FC<MetricItemProps> = ({
  label,
  value,
  subValue,
  icon,
  color = 'neutral',
  tooltip,
}) => {
  const colorClass = `live-metrics__value--${color}`;

  const content = (
    <div className="live-metrics__item">
      {icon && <div className="live-metrics__icon">{icon}</div>}
      <div className="live-metrics__content">
        <span className="live-metrics__label">{label}</span>
        <span className={`live-metrics__value ${colorClass}`}>{value}</span>
        {subValue && <span className="live-metrics__sub">{subValue}</span>}
      </div>
    </div>
  );

  return tooltip ? <Tooltip title={tooltip}>{content}</Tooltip> : content;
};

// ============================================================================
// LIVE METRICS BAR COMPONENT
// ============================================================================

const LiveMetricsBar: React.FC<LiveMetricsBarProps> = ({ symbol, ticker, status }) => {
  // Derived values
  const data = useMemo(() => {
    if (!ticker) return null;

    const price = ticker.price || 0;
    const change = ticker.change24h || 0;
    const changePct = ticker.changePct24h || 0;
    const high = ticker.high24h || 0;
    const low = ticker.low24h || 0;
    const volume = ticker.volume24h || 0;
    const bid = ticker.bid || 0;
    const ask = ticker.ask || 0;
    const spread = bid && ask ? ((ask - bid) / ((ask + bid) / 2)) * 100 : 0;
    const range = high && low ? ((price - low) / (high - low)) * 100 : 50;

    return {
      price,
      change,
      changePct,
      high,
      low,
      volume,
      bid,
      ask,
      spread,
      range,
      isPositive: changePct >= 0,
    };
  }, [ticker]);

  // Loading state
  if (status === 'loading' && !data) {
    return (
      <div className="live-metrics live-metrics--loading">
        <Skeleton active paragraph={false} />
        <style>{styles}</style>
      </div>
    );
  }

  // Error state
  if (status === 'error') {
    return (
      <div className="live-metrics live-metrics--error">
        <Alert
          type="error"
          showIcon
          message="Market data unavailable"
          description="Unable to fetch ticker. Retrying..."
          style={{ background: 'rgba(239, 68, 68, 0.1)', border: 'none' }}
        />
        <style>{styles}</style>
      </div>
    );
  }

  // Warming state (placeholder data)
  const isWarming = data && (data.price === 0 || data.volume === 0);

  return (
    <div className={`live-metrics ${status === 'stale' ? 'live-metrics--stale' : ''}`}>
      {status === 'stale' && (
        <div className="live-metrics__stale-banner">
          Data may be stale - waiting for reconnection
        </div>
      )}

      {isWarming && (
        <div className="live-metrics__warming">
          WebSocket warming up... live data will appear shortly
        </div>
      )}

      <div className="live-metrics__grid">
        {/* Price */}
        <MetricItem
          label={symbol || 'Price'}
          value={`$${formatPrice(data?.price || 0)}`}
          icon={
            data?.isPositive ? (
              <TrendingUp size={16} color="var(--success)" />
            ) : (
              <TrendingDown size={16} color="var(--error)" />
            )
          }
          color="neutral"
          tooltip="Current market price"
        />

        {/* 24h Change */}
        <MetricItem
          label="24h Change"
          value={formatPercent(data?.changePct || 0)}
          subValue={`$${formatPrice(data?.change || 0)}`}
          icon={
            data?.isPositive ? (
              <ArrowUp size={14} color="var(--success)" />
            ) : (
              <ArrowDown size={14} color="var(--error)" />
            )
          }
          color={data?.isPositive ? 'positive' : 'negative'}
          tooltip="Price change in last 24 hours"
        />

        {/* 24h Range */}
        <div className="live-metrics__item live-metrics__range-item">
          <div className="live-metrics__range-header">
            <span className="live-metrics__label">24h Range</span>
          </div>
          <div className="live-metrics__range">
            <span className="live-metrics__range-low">${formatPrice(data?.low || 0)}</span>
            <div className="live-metrics__range-bar">
              <div
                className="live-metrics__range-fill"
                style={{ width: `${data?.range || 50}%` }}
              />
              <div
                className="live-metrics__range-marker"
                style={{ left: `${data?.range || 50}%` }}
              />
            </div>
            <span className="live-metrics__range-high">${formatPrice(data?.high || 0)}</span>
          </div>
        </div>

        {/* Volume */}
        <MetricItem
          label="24h Volume"
          value={formatVolume(data?.volume || 0)}
          icon={<BarChart3 size={14} color="var(--text-muted)" />}
          color="neutral"
          tooltip="Trading volume in last 24 hours"
        />

        {/* Spread */}
        <MetricItem
          label="Spread"
          value={`${(data?.spread || 0).toFixed(3)}%`}
          subValue={data?.bid && data?.ask ? `${formatPrice(data.bid)} / ${formatPrice(data.ask)}` : undefined}
          icon={<Waves size={14} color="var(--text-muted)" />}
          color={
            (data?.spread || 0) < 0.05
              ? 'positive'
              : (data?.spread || 0) > 0.1
                ? 'negative'
                : 'neutral'
          }
          tooltip="Bid-Ask spread (lower is better)"
        />
      </div>

      <style>{styles}</style>
    </div>
  );
};

// ============================================================================
// STYLES
// ============================================================================

const styles = `
  .live-metrics {
    background: var(--bg-primary);
    border-radius: 12px;
    border: 1px solid var(--border-subtle);
    padding: 12px 16px;
    margin-bottom: 16px;
  }

  .live-metrics--loading {
    padding: 20px;
  }

  .live-metrics--stale {
    border-color: rgba(234, 179, 8, 0.4);
  }

  .live-metrics__stale-banner {
    background: rgba(234, 179, 8, 0.15);
    color: var(--warning);
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 11px;
    text-align: center;
    margin-bottom: 12px;
    letter-spacing: 0.05em;
  }

  .live-metrics__warming {
    color: var(--text-muted);
    font-size: 12px;
    text-align: center;
    padding: 8px;
    margin-bottom: 8px;
  }

  .live-metrics__grid {
    display: flex;
    align-items: stretch;
    gap: 16px;
    flex-wrap: wrap;
  }

  .live-metrics__item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    flex: 1 1 120px;
    min-width: 0;
    padding: 8px 12px;
    background: rgba(30, 41, 59, 0.5);
    border-radius: 8px;
    border: 1px solid var(--border-subtle);
    cursor: default;
    transition: border-color 0.2s;
  }

  .live-metrics__item:hover {
    border-color: var(--border-subtle);
  }

  .live-metrics__icon {
    flex-shrink: 0;
    margin-top: 2px;
  }

  .live-metrics__content {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .live-metrics__label {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .live-metrics__value {
    font-size: 14px;
    font-weight: 600;
    font-family: 'JetBrains Mono', 'Menlo', monospace;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .live-metrics__value--positive {
    color: var(--success) !important;
  }

  .live-metrics__value--negative {
    color: var(--error) !important;
  }

  .live-metrics__value--neutral {
    color: var(--text-primary);
  }

  .live-metrics__sub {
    font-size: 11px;
    color: var(--text-muted);
    font-family: 'JetBrains Mono', 'Menlo', monospace;
  }

  /* Range item specific */
  .live-metrics__range-item {
    flex: 2 1 200px;
    flex-direction: column;
  }

  .live-metrics__range-header {
    margin-bottom: 4px;
  }

  .live-metrics__range {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  .live-metrics__range-low,
  .live-metrics__range-high {
    font-size: 11px;
    font-family: 'JetBrains Mono', 'Menlo', monospace;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .live-metrics__range-low {
    color: var(--error);
  }

  .live-metrics__range-high {
    color: var(--success);
  }

  .live-metrics__range-bar {
    flex: 1;
    height: 6px;
    background: rgba(100, 116, 139, 0.3);
    border-radius: 3px;
    position: relative;
    min-width: 60px;
  }

  .live-metrics__range-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--error), var(--warning), var(--success));
    border-radius: 3px;
  }

  .live-metrics__range-marker {
    position: absolute;
    top: -3px;
    width: 4px;
    height: 12px;
    background: var(--text-primary);
    border-radius: 2px;
    transform: translateX(-50%);
    box-shadow: 0 0 4px rgba(0, 0, 0, 0.3);
  }

  @media (max-width: 768px) {
    .live-metrics__grid {
      gap: 8px;
    }

    .live-metrics__item {
      flex: 1 1 calc(50% - 8px);
      padding: 6px 10px;
    }

    .live-metrics__range-item {
      flex: 1 1 100%;
    }

    .live-metrics__value {
      font-size: 13px;
    }
  }
`;

export default LiveMetricsBar;
