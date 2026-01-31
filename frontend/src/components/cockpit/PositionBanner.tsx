/**
 * V5.72: PositionBanner Component with HealthGauge
 *
 * Horizontal banner displaying position info when IN_POSITION.
 * Includes trailing stop status, health gauge, and key metrics.
 */

import React, { useMemo } from 'react';
import { Tag, Tooltip } from 'antd';
import {
  TrendingUp,
  TrendingDown,
  Clock,
  Target,
  Shield,
  AlertTriangle,
  Zap,
  Eye,
  Timer,
} from 'lucide-react';
import type { PositionBannerProps, HealthStatus } from '../../types/cockpit';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const formatUsd = (value: number): string => {
  if (!Number.isFinite(value)) return '$0.00';
  const absValue = Math.abs(value);
  if (absValue >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  return `$${value.toFixed(2)}`;
};

const formatPrice = (value: number): string => {
  if (!Number.isFinite(value) || value === 0) return '—';
  return value >= 100 ? value.toFixed(2) : value.toFixed(4);
};

const formatPercent = (value: number): string => {
  if (!Number.isFinite(value)) return '0.00%';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
};

const formatDuration = (ms: number): string => {
  if (!ms || ms < 0) return '0m';
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
};

const getHealthInfo = (
  status: HealthStatus
): { color: string; label: string; icon: React.ReactNode } => {
  switch (status) {
    case 'progressing':
      return {
        color: 'var(--success)',
        label: 'Progressing',
        icon: <Zap size={14} color="var(--success)" />,
      };
    case 'watching':
      return {
        color: 'var(--accent-secondary)',
        label: 'Watching',
        icon: <Eye size={14} color="var(--accent-secondary)" />,
      };
    case 'stagnant':
      return {
        color: 'var(--warning)',
        label: 'Stagnant',
        icon: <Timer size={14} color="var(--warning)" />,
      };
    case 'at_risk':
      return {
        color: 'var(--error)',
        label: 'At Risk',
        icon: <AlertTriangle size={14} color="var(--error)" />,
      };
    default:
      return {
        color: 'var(--text-secondary)',
        label: 'Unknown',
        icon: <Eye size={14} color="var(--text-secondary)" />,
      };
  }
};

// ============================================================================
// HEALTH GAUGE COMPONENT
// ============================================================================

interface HealthGaugeProps {
  stopPrice: number;
  currentPrice: number;
  peakPrice: number;
  entryPrice: number;
  side: 'long' | 'short';
  healthStatus: HealthStatus;
}

const HealthGauge: React.FC<HealthGaugeProps> = ({
  stopPrice,
  currentPrice,
  peakPrice,
  entryPrice,
  side,
  healthStatus,
}) => {
  // Calculate position within the range (stop -> peak)
  const { percent, distanceToStop } = useMemo(() => {
    if (!stopPrice || !currentPrice || !peakPrice) {
      return { percent: 50, distanceToStop: 0 };
    }

    const range = Math.abs(peakPrice - stopPrice);
    if (range === 0) return { percent: 50, distanceToStop: 0 };

    let position: number;
    if (side === 'long') {
      position = ((currentPrice - stopPrice) / range) * 100;
    } else {
      position = ((stopPrice - currentPrice) / range) * 100;
    }

    const distToStop = Math.abs((currentPrice - stopPrice) / currentPrice) * 100;

    return {
      percent: Math.max(0, Math.min(100, position)),
      distanceToStop: distToStop,
    };
  }, [stopPrice, currentPrice, peakPrice, side]);

  const healthInfo = getHealthInfo(healthStatus);

  // Gradient based on position health
  const gradientColors = useMemo(() => {
    if (percent < 20) return 'linear-gradient(90deg, var(--error), var(--warning))';
    if (percent < 40) return 'linear-gradient(90deg, var(--warning), #eab308)';
    if (percent < 60) return 'linear-gradient(90deg, #eab308, #84cc16)';
    return 'linear-gradient(90deg, #84cc16, var(--success))';
  }, [percent]);

  return (
    <div className="health-gauge">
      <div className="health-gauge__header">
        <div className="health-gauge__status">
          {healthInfo.icon}
          <span style={{ color: healthInfo.color }}>{healthInfo.label}</span>
        </div>
        <Tooltip title={`Distance to stop: ${distanceToStop.toFixed(2)}%`}>
          <span className="health-gauge__distance">
            <Shield size={12} />
            {distanceToStop.toFixed(1)}% to stop
          </span>
        </Tooltip>
      </div>

      <div className="health-gauge__bar-container">
        <div className="health-gauge__labels">
          <span className="health-gauge__label health-gauge__label--stop">
            Stop ${formatPrice(stopPrice)}
          </span>
          <span className="health-gauge__label health-gauge__label--entry">
            Entry ${formatPrice(entryPrice)}
          </span>
          <span className="health-gauge__label health-gauge__label--peak">
            Peak ${formatPrice(peakPrice)}
          </span>
        </div>

        <div className="health-gauge__bar">
          <div
            className="health-gauge__fill"
            style={{
              width: `${percent}%`,
              background: gradientColors,
            }}
          />
          <div
            className="health-gauge__marker"
            style={{ left: `${percent}%` }}
          />
          {/* Entry marker */}
          {entryPrice > 0 && (
            <div
              className="health-gauge__entry-marker"
              style={{
                left: `${
                  side === 'long'
                    ? ((entryPrice - stopPrice) / (peakPrice - stopPrice)) * 100
                    : ((stopPrice - entryPrice) / (stopPrice - peakPrice)) * 100
                }%`,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// TRAILING STOP INFO COMPONENT
// ============================================================================

interface TrailingInfoProps {
  active: boolean;
  activatedAt: number | null;
  updateCount: number;
  currentStopPrice: number | undefined;
  distanceFromPeak: number;
}

const TrailingInfo: React.FC<TrailingInfoProps> = ({
  active,
  activatedAt,
  updateCount,
  currentStopPrice,
  distanceFromPeak,
}) => {
  const activeDuration = activatedAt ? formatDuration(Date.now() - activatedAt) : null;

  return (
    <div className="trailing-info">
      <div className="trailing-info__header">
        <Target size={14} color={active ? 'var(--success)' : 'var(--text-secondary)'} />
        <span className={`trailing-info__label ${active ? 'trailing-info__label--active' : ''}`}>
          Trailing Stop
        </span>
        <Tag
          color={active ? 'green' : 'default'}
          className="trailing-info__tag"
        >
          {active ? 'ACTIVE' : 'INACTIVE'}
        </Tag>
      </div>

      {active && (
        <div className="trailing-info__details">
          <Tooltip title="Current trailing stop price">
            <span className="trailing-info__metric">
              Stop: ${formatPrice(currentStopPrice || 0)}
            </span>
          </Tooltip>
          <Tooltip title="Distance from peak price">
            <span className="trailing-info__metric">
              From peak: {distanceFromPeak.toFixed(2)}%
            </span>
          </Tooltip>
          {activeDuration && (
            <Tooltip title="Time since trailing activated">
              <span className="trailing-info__metric">
                Active: {activeDuration}
              </span>
            </Tooltip>
          )}
          <Tooltip title="Number of stop price updates">
            <span className="trailing-info__metric">
              Updates: {updateCount}
            </span>
          </Tooltip>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// POSITION BANNER COMPONENT
// ============================================================================

const PositionBanner: React.FC<PositionBannerProps> = ({ position }) => {
  if (!position) return null;

  const isLong = position.side === 'long';
  const pnlColor = position.pnlPct >= 0 ? 'var(--success)' : 'var(--error)';
  const sideColor = isLong ? 'var(--success)' : 'var(--error)';
  const SideIcon = isLong ? TrendingUp : TrendingDown;

  return (
    <div className="position-banner">
      {/* Left: Side & Symbol */}
      <div className="position-banner__side">
        <div
          className="position-banner__side-badge"
          style={{ background: sideColor }}
        >
          <SideIcon size={16} color="#fff" />
          <span>{isLong ? 'LONG' : 'SHORT'}</span>
        </div>
        <div className="position-banner__symbol">{position.symbol}</div>
      </div>

      {/* Center-Left: Entry & Current Price */}
      <div className="position-banner__prices">
        <div className="position-banner__price-item">
          <span className="position-banner__price-label">Entry</span>
          <span className="position-banner__price-value">
            ${formatPrice(position.entryPrice)}
          </span>
        </div>
        <div className="position-banner__price-separator">/</div>
        <div className="position-banner__price-item">
          <span className="position-banner__price-label">Current</span>
          <span className="position-banner__price-value position-banner__price-value--current">
            ${formatPrice(position.currentPrice)}
          </span>
        </div>
      </div>

      {/* Center: P&L */}
      <div className="position-banner__pnl" style={{ color: pnlColor }}>
        <span className="position-banner__pnl-value">{formatUsd(position.pnlUsd)}</span>
        <span className="position-banner__pnl-pct">{formatPercent(position.pnlPct)}</span>
      </div>

      {/* Center-Right: Health Gauge */}
      <div className="position-banner__health">
        <HealthGauge
          stopPrice={position.stopPrice}
          currentPrice={position.currentPrice}
          peakPrice={position.peakPrice}
          entryPrice={position.entryPrice}
          side={position.side}
          healthStatus={position.healthStatus}
        />
      </div>

      {/* Right: Trailing Info */}
      <div className="position-banner__trailing">
        <TrailingInfo
          active={position.trailingState.active}
          activatedAt={position.trailingState.activatedAt}
          updateCount={position.trailingState.updateCount}
          currentStopPrice={position.trailingState.currentStopPrice}
          distanceFromPeak={position.distanceFromPeak}
        />
      </div>

      {/* Far Right: Duration & Size */}
      <div className="position-banner__meta">
        <Tooltip title="Position hold time">
          <div className="position-banner__meta-item">
            <Clock size={12} />
            <span>{formatDuration(position.duration)}</span>
          </div>
        </Tooltip>
        <Tooltip title="Position notional value">
          <div className="position-banner__meta-item">
            <span className="position-banner__meta-label">Size</span>
            <span>{formatUsd(position.notionalUsd)}</span>
          </div>
        </Tooltip>
        {position.leverage && (
          <Tooltip title="Leverage">
            <div className="position-banner__meta-item">
              <span className="position-banner__meta-label">Lev</span>
              <span>{position.leverage}x</span>
            </div>
          </Tooltip>
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
  .position-banner {
    display: flex;
    align-items: stretch;
    gap: 16px;
    background: var(--card-gradient);
    border-radius: 12px;
    padding: 16px 20px;
    border: 1px solid var(--border-subtle);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    margin-bottom: 16px;
    flex-wrap: wrap;
  }

  /* Side Badge */
  .position-banner__side {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 0 0 auto;
  }

  .position-banner__side-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 6px;
    color: #fff;
    font-weight: 700;
    font-size: 12px;
    letter-spacing: 0.05em;
  }

  .position-banner__symbol {
    font-size: 11px;
    color: var(--text-muted);
    font-family: 'JetBrains Mono', monospace;
    text-align: center;
  }

  /* Prices */
  .position-banner__prices {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }

  .position-banner__price-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .position-banner__price-label {
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .position-banner__price-value {
    font-size: 13px;
    font-family: 'JetBrains Mono', monospace;
    color: var(--text-muted);
  }

  .position-banner__price-value--current {
    color: var(--text-primary);
    font-weight: 600;
  }

  .position-banner__price-separator {
    color: var(--text-secondary);
    font-size: 16px;
  }

  /* P&L */
  .position-banner__pnl {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 0 16px;
    border-left: 1px solid var(--border-subtle);
    border-right: 1px solid var(--border-subtle);
    flex: 0 0 auto;
  }

  .position-banner__pnl-value {
    font-size: 20px;
    font-weight: 700;
    font-family: 'JetBrains Mono', monospace;
    line-height: 1.1;
  }

  .position-banner__pnl-pct {
    font-size: 13px;
    font-weight: 600;
    font-family: 'JetBrains Mono', monospace;
    opacity: 0.9;
  }

  /* Health Gauge */
  .position-banner__health {
    flex: 1 1 200px;
    min-width: 180px;
  }

  .health-gauge {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .health-gauge__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .health-gauge__status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
  }

  .health-gauge__distance {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-muted);
    font-family: 'JetBrains Mono', monospace;
  }

  .health-gauge__bar-container {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .health-gauge__labels {
    display: flex;
    justify-content: space-between;
    font-size: 9px;
    color: var(--text-muted);
    font-family: 'JetBrains Mono', monospace;
  }

  .health-gauge__label--stop {
    color: var(--error);
  }

  .health-gauge__label--entry {
    color: var(--text-secondary);
  }

  .health-gauge__label--peak {
    color: var(--success);
  }

  .health-gauge__bar {
    height: 8px;
    background: rgba(100, 116, 139, 0.3);
    border-radius: 4px;
    position: relative;
    overflow: hidden;
  }

  .health-gauge__fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.3s ease;
  }

  .health-gauge__marker {
    position: absolute;
    top: -2px;
    width: 4px;
    height: 12px;
    background: var(--text-primary);
    border-radius: 2px;
    transform: translateX(-50%);
    box-shadow: 0 0 6px rgba(0, 0, 0, 0.4);
    transition: left 0.3s ease;
  }

  .health-gauge__entry-marker {
    position: absolute;
    top: 0;
    width: 2px;
    height: 8px;
    background: var(--text-secondary);
    transform: translateX(-50%);
    opacity: 0.7;
  }

  /* Trailing Info */
  .position-banner__trailing {
    flex: 0 0 auto;
    min-width: 140px;
  }

  .trailing-info {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .trailing-info__header {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .trailing-info__label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .trailing-info__label--active {
    color: var(--success);
  }

  .trailing-info__tag {
    font-size: 10px !important;
    padding: 0 6px !important;
    border-radius: 4px !important;
  }

  .trailing-info__details {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
  }

  .trailing-info__metric {
    font-size: 11px;
    color: var(--text-muted);
    font-family: 'JetBrains Mono', monospace;
    cursor: help;
  }

  /* Meta info */
  .position-banner__meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-left: 1px solid var(--border-subtle);
    padding-left: 16px;
    flex: 0 0 auto;
  }

  .position-banner__meta-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-muted);
    font-family: 'JetBrains Mono', monospace;
    cursor: help;
  }

  .position-banner__meta-label {
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
  }

  @media (max-width: 1024px) {
    .position-banner {
      flex-wrap: wrap;
      gap: 12px;
    }

    .position-banner__health {
      flex: 1 1 100%;
      order: 10;
    }

    .position-banner__trailing {
      flex: 1 1 100%;
      order: 11;
    }

    .position-banner__meta {
      flex: 0 0 auto;
      border-left: none;
      padding-left: 0;
      flex-direction: row;
      gap: 12px;
    }
  }

  @media (max-width: 640px) {
    .position-banner {
      padding: 12px;
      gap: 10px;
    }

    .position-banner__pnl {
      padding: 0 12px;
    }

    .position-banner__pnl-value {
      font-size: 16px;
    }
  }
`;

export default PositionBanner;
