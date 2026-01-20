/**
 * V5.72: PerformanceSummary Component
 *
 * Simplified performance display with parity verification status.
 */

import React, { useMemo } from 'react';
import { Progress, Tooltip, Skeleton, Tag } from 'antd';
import {
  TrendingUp,
  TrendingDown,
  Target,
  AlertCircle,
  CheckCircle,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import type { PerformanceSummaryProps, ParityResult } from '../../types/cockpit';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const formatPercent = (value: number, decimals = 1): string => {
  if (!Number.isFinite(value)) return '0%';
  return `${value.toFixed(decimals)}%`;
};


// ============================================================================
// METRIC CARD COMPONENT
// ============================================================================

interface MetricCardProps {
  label: string;
  value: string | number;
  subValue?: string;
  icon?: React.ReactNode;
  color?: 'positive' | 'negative' | 'neutral' | 'warning';
  tooltip?: string;
}

const MetricCard: React.FC<MetricCardProps> = ({
  label,
  value,
  subValue,
  icon,
  color = 'neutral',
  tooltip,
}) => {
  const colorClass = `perf-metric--${color}`;

  const content = (
    <div className={`perf-metric ${colorClass}`}>
      {icon && <div className="perf-metric__icon">{icon}</div>}
      <div className="perf-metric__content">
        <span className="perf-metric__label">{label}</span>
        <span className="perf-metric__value">{value}</span>
        {subValue && <span className="perf-metric__sub">{subValue}</span>}
      </div>
    </div>
  );

  return tooltip ? <Tooltip title={tooltip}>{content}</Tooltip> : content;
};

// ============================================================================
// PARITY STATUS COMPONENT
// ============================================================================

interface ParityStatusProps {
  parity: ParityResult | null;
}

const ParityStatus: React.FC<ParityStatusProps> = ({ parity }) => {
  if (!parity) {
    return (
      <div className="parity-status parity-status--empty">
        <AlertCircle size={14} />
        <span>Parity data unavailable</span>
      </div>
    );
  }

  const { matchRate, status, totalTrades, verifiedTrades, matchedTrades, mismatches } = parity;

  const statusConfig = {
    healthy: {
      color: '#10b981',
      icon: <CheckCircle size={16} color="#10b981" />,
      label: 'Healthy',
      tagColor: 'green',
    },
    warning: {
      color: '#f59e0b',
      icon: <AlertTriangle size={16} color="#f59e0b" />,
      label: 'Warning',
      tagColor: 'orange',
    },
    critical: {
      color: '#ef4444',
      icon: <XCircle size={16} color="#ef4444" />,
      label: 'Critical',
      tagColor: 'red',
    },
  };

  const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.healthy;

  return (
    <div className="parity-status">
      <div className="parity-status__header">
        {config.icon}
        <span className="parity-status__title">Backtest Parity</span>
        <Tag color={config.tagColor} className="parity-status__tag">
          {config.label}
        </Tag>
      </div>

      <div className="parity-status__gauge">
        <Progress
          percent={matchRate}
          strokeColor={config.color}
          trailColor="rgba(100, 116, 139, 0.3)"
          size="small"
          format={(p) => `${p?.toFixed(0)}%`}
        />
      </div>

      <div className="parity-status__stats">
        <Tooltip title="Trades verified against backtest">
          <span className="parity-status__stat">
            {verifiedTrades}/{totalTrades} verified
          </span>
        </Tooltip>
        <span className="parity-status__divider">|</span>
        <Tooltip title="Trades matching backtest behavior">
          <span className="parity-status__stat">
            {matchedTrades} matched
          </span>
        </Tooltip>
        {mismatches.length > 0 && (
          <>
            <span className="parity-status__divider">|</span>
            <Tooltip
              title={
                <div>
                  <strong>Recent mismatches:</strong>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                    {mismatches.slice(0, 3).map((m: ParityResult['mismatches'][0], i: number) => (
                      <li key={i} style={{ fontSize: 11 }}>
                        {m.symbol}: {m.liveExitReason} vs {m.btExitReason}
                      </li>
                    ))}
                  </ul>
                </div>
              }
            >
              <span className="parity-status__stat parity-status__stat--warn">
                {mismatches.length} mismatches
              </span>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

const PerformanceSummary: React.FC<PerformanceSummaryProps> = ({
  performance,
  parity,
  loading,
}) => {
  if (loading) {
    return (
      <div className="perf-summary perf-summary--loading">
        <Skeleton active paragraph={{ rows: 3 }} />
        <style>{styles}</style>
      </div>
    );
  }

  const winRateColor = useMemo(() => {
    if (!performance) return 'neutral';
    if (performance.winRate >= 55) return 'positive';
    if (performance.winRate >= 45) return 'neutral';
    return 'negative';
  }, [performance?.winRate]);

  const expectancyColor = useMemo(() => {
    if (!performance) return 'neutral';
    if (performance.expectancy > 0.5) return 'positive';
    if (performance.expectancy >= 0) return 'neutral';
    return 'negative';
  }, [performance?.expectancy]);

  return (
    <div className="perf-summary">
      <div className="perf-summary__header">
        <Target size={16} color="rgba(226, 232, 240, 0.7)" />
        <span className="perf-summary__title">Performance</span>
        {performance && (
          <span className="perf-summary__trades">
            {performance.totalTrades} trades
          </span>
        )}
      </div>

      {!performance ? (
        <div className="perf-summary__empty">
          No performance data available yet
        </div>
      ) : (
        <>
          <div className="perf-summary__metrics">
            <MetricCard
              label="Win Rate"
              value={formatPercent(performance.winRate)}
              subValue={`${performance.wins}W / ${performance.losses}L`}
              icon={
                performance.winRate >= 50 ? (
                  <TrendingUp size={16} color="#10b981" />
                ) : (
                  <TrendingDown size={16} color="#ef4444" />
                )
              }
              color={winRateColor}
              tooltip="Percentage of winning trades"
            />

            <MetricCard
              label="Expectancy"
              value={formatPercent(performance.expectancy)}
              icon={
                performance.expectancy >= 0 ? (
                  <TrendingUp size={14} color="#10b981" />
                ) : (
                  <TrendingDown size={14} color="#ef4444" />
                )
              }
              color={expectancyColor}
              tooltip="Expected return per trade"
            />

            <MetricCard
              label="Avg Win"
              value={formatPercent(performance.avgWin)}
              color="positive"
              tooltip="Average winning trade return"
            />

            <MetricCard
              label="Avg Loss"
              value={formatPercent(performance.avgLoss)}
              color="negative"
              tooltip="Average losing trade return"
            />
          </div>

          <div className="perf-summary__parity">
            <ParityStatus parity={parity} />
          </div>
        </>
      )}

      <style>{styles}</style>
    </div>
  );
};

// ============================================================================
// STYLES
// ============================================================================

const styles = `
  .perf-summary {
    background: rgba(15, 23, 42, 0.92);
    border-radius: 16px;
    border: 1px solid rgba(100, 116, 139, 0.18);
    padding: 16px;
  }

  .perf-summary--loading {
    padding: 20px;
  }

  .perf-summary__header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
  }

  .perf-summary__title {
    font-size: 13px;
    font-weight: 600;
    color: rgba(226, 232, 240, 0.85);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .perf-summary__trades {
    font-size: 11px;
    color: rgba(226, 232, 240, 0.5);
    font-family: 'JetBrains Mono', monospace;
    margin-left: auto;
  }

  .perf-summary__empty {
    color: rgba(226, 232, 240, 0.5);
    font-size: 13px;
    text-align: center;
    padding: 20px;
  }

  .perf-summary__metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }

  .perf-metric {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 12px;
    background: rgba(30, 41, 59, 0.5);
    border-radius: 10px;
    border: 1px solid rgba(148, 163, 184, 0.1);
    cursor: help;
    transition: border-color 0.2s;
  }

  .perf-metric:hover {
    border-color: rgba(148, 163, 184, 0.25);
  }

  .perf-metric--positive {
    border-color: rgba(16, 185, 129, 0.2);
  }

  .perf-metric--negative {
    border-color: rgba(239, 68, 68, 0.2);
  }

  .perf-metric--warning {
    border-color: rgba(245, 158, 11, 0.2);
  }

  .perf-metric__icon {
    flex-shrink: 0;
    margin-top: 2px;
  }

  .perf-metric__content {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .perf-metric__label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(226, 232, 240, 0.5);
  }

  .perf-metric__value {
    font-size: 16px;
    font-weight: 600;
    font-family: 'JetBrains Mono', monospace;
    color: #f8fafc;
  }

  .perf-metric--positive .perf-metric__value {
    color: #10b981;
  }

  .perf-metric--negative .perf-metric__value {
    color: #ef4444;
  }

  .perf-metric__sub {
    font-size: 10px;
    color: rgba(226, 232, 240, 0.5);
    font-family: 'JetBrains Mono', monospace;
  }

  .perf-summary__parity {
    border-top: 1px solid rgba(148, 163, 184, 0.12);
    padding-top: 16px;
  }

  .parity-status {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .parity-status--empty {
    flex-direction: row;
    align-items: center;
    color: rgba(226, 232, 240, 0.5);
    font-size: 12px;
    gap: 6px;
  }

  .parity-status__header {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .parity-status__title {
    font-size: 12px;
    font-weight: 600;
    color: rgba(226, 232, 240, 0.8);
  }

  .parity-status__tag {
    font-size: 10px !important;
    padding: 0 6px !important;
    border-radius: 4px !important;
  }

  .parity-status__gauge {
    padding: 0 4px;
  }

  .parity-status__gauge .ant-progress-text {
    font-size: 11px !important;
    color: rgba(226, 232, 240, 0.7) !important;
    font-family: 'JetBrains Mono', monospace;
  }

  .parity-status__stats {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .parity-status__stat {
    font-size: 11px;
    color: rgba(226, 232, 240, 0.6);
    font-family: 'JetBrains Mono', monospace;
    cursor: help;
  }

  .parity-status__stat--warn {
    color: #f59e0b;
  }

  .parity-status__divider {
    color: rgba(148, 163, 184, 0.3);
  }

  @media (max-width: 640px) {
    .perf-summary__metrics {
      grid-template-columns: repeat(2, 1fr);
    }

    .perf-metric {
      padding: 10px;
    }

    .perf-metric__value {
      font-size: 14px;
    }
  }
`;

export default PerformanceSummary;
