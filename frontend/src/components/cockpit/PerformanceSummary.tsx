/**
 * V5.72: PerformanceSummary Component
 *
 * Simplified performance display with parity verification status.
 */

import React, { useMemo } from 'react';
import { Progress } from '@/components/ui/progress';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
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

  return tooltip ? (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : content;
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
      color: 'var(--success)',
      icon: <CheckCircle size={16} color="var(--success)" />,
      label: 'Healthy',
      tagClasses: 'bg-green-500/10 text-green-400 ring-1 ring-green-500/20',
    },
    warning: {
      color: 'var(--warning)',
      icon: <AlertTriangle size={16} color="var(--warning)" />,
      label: 'Warning',
      tagClasses: 'bg-orange-500/10 text-orange-400 ring-1 ring-orange-500/20',
    },
    critical: {
      color: 'var(--error)',
      icon: <XCircle size={16} color="var(--error)" />,
      label: 'Critical',
      tagClasses: 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20',
    },
  };

  const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.healthy;

  return (
    <TooltipProvider>
      <div className="parity-status">
        <div className="parity-status__header">
          {config.icon}
          <span className="parity-status__title">Backtest Parity</span>
          <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold', config.tagClasses)}>
            {config.label}
          </span>
        </div>

        <div className="parity-status__gauge">
          <div className="flex items-center gap-2">
            <Progress
              value={matchRate}
              className="h-1.5 flex-1"
              style={{ '--progress-color': config.color } as React.CSSProperties}
            />
            <span className="text-[11px] font-mono text-[var(--text-muted)]">
              {matchRate?.toFixed(0)}%
            </span>
          </div>
        </div>

        <div className="parity-status__stats">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="parity-status__stat">
                {verifiedTrades}/{totalTrades} verified
              </span>
            </TooltipTrigger>
            <TooltipContent>Trades verified against backtest</TooltipContent>
          </Tooltip>
          <span className="parity-status__divider">|</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="parity-status__stat">
                {matchedTrades} matched
              </span>
            </TooltipTrigger>
            <TooltipContent>Trades matching backtest behavior</TooltipContent>
          </Tooltip>
          {mismatches.length > 0 && (
            <>
              <span className="parity-status__divider">|</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="parity-status__stat parity-status__stat--warn">
                    {mismatches.length} mismatches
                  </span>
                </TooltipTrigger>
                <TooltipContent>
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
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      </div>
    </TooltipProvider>
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
        <Skeleton className="h-4 w-3/4 mb-3" />
        <Skeleton className="h-16 w-full mb-2" />
        <Skeleton className="h-16 w-full mb-2" />
        <Skeleton className="h-8 w-1/2" />
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
        <Target size={16} color="var(--text-muted)" />
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
                  <TrendingUp size={16} color="var(--success)" />
                ) : (
                  <TrendingDown size={16} color="var(--error)" />
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
                  <TrendingUp size={14} color="var(--success)" />
                ) : (
                  <TrendingDown size={14} color="var(--error)" />
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
    background: var(--bg-primary);
    border-radius: 16px;
    border: 1px solid var(--border-subtle);
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
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .perf-summary__trades {
    font-size: 11px;
    color: var(--text-muted);
    font-family: 'JetBrains Mono', monospace;
    margin-left: auto;
  }

  .perf-summary__empty {
    color: var(--text-muted);
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
    border: 1px solid var(--border-subtle);
    cursor: help;
    transition: border-color 0.2s;
  }

  .perf-metric:hover {
    border-color: var(--border-subtle);
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
    color: var(--text-muted);
  }

  .perf-metric__value {
    font-size: 16px;
    font-weight: 600;
    font-family: 'JetBrains Mono', monospace;
    color: var(--text-primary);
  }

  .perf-metric--positive .perf-metric__value {
    color: var(--success);
  }

  .perf-metric--negative .perf-metric__value {
    color: var(--error);
  }

  .perf-metric__sub {
    font-size: 10px;
    color: var(--text-muted);
    font-family: 'JetBrains Mono', monospace;
  }

  .perf-summary__parity {
    border-top: 1px solid var(--border-subtle);
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
    color: var(--text-muted);
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
    color: var(--text-muted);
  }

  .parity-status__gauge {
    padding: 0 4px;
  }

  .parity-status__stats {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .parity-status__stat {
    font-size: 11px;
    color: var(--text-muted);
    font-family: 'JetBrains Mono', monospace;
    cursor: help;
  }

  .parity-status__stat--warn {
    color: var(--warning);
  }

  .parity-status__divider {
    color: var(--text-secondary);
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
