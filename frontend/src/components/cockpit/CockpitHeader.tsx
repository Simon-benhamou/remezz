/**
 * V5.72: CockpitHeader Component
 *
 * PnL-focused header with session info, mode indicator, and sparkline.
 */

import React, { useMemo } from 'react';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import { RefreshCw, Wifi } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import type { CockpitHeaderProps, SessionState } from '../../types/cockpit';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const formatUsd = (value: number, digits = 2): string => {
  if (!Number.isFinite(value)) return '$0.00';
  const absValue = Math.abs(value);
  if (absValue >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}M`;
  }
  if (absValue >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  return `$${value.toFixed(digits)}`;
};

const formatPercent = (value: number, digits = 2): string => {
  if (!Number.isFinite(value)) return '0.00%';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
};

const getStateClasses = (state: SessionState): string => {
  switch (state) {
    case 'IN_POSITION':
      return 'bg-green-500/20 text-green-400 ring-1 ring-green-500/30';
    case 'WATCHING':
      return 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/30';
    case 'HALT':
      return 'bg-red-500/20 text-red-400 ring-1 ring-red-500/30';
    case 'STOPPED':
      return 'bg-zinc-500/20 text-zinc-400 ring-1 ring-zinc-500/30';
    default:
      return 'bg-zinc-500/20 text-zinc-400 ring-1 ring-zinc-500/30';
  }
};

const getStateLabel = (state: SessionState): string => {
  switch (state) {
    case 'IN_POSITION':
      return 'IN POSITION';
    case 'WATCHING':
      return 'WATCHING';
    case 'HALT':
      return 'HALTED';
    case 'STOPPED':
      return 'STOPPED';
    default:
      return state;
  }
};

// ============================================================================
// SPARKLINE COMPONENT
// ============================================================================

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
}

const Sparkline: React.FC<SparklineProps> = ({ data, width = 120, height = 40 }) => {
  const chartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    // Create cumulative sum for PnL line
    let cumulative = 0;
    return data.map((value, index) => {
      cumulative += value;
      return { index, value: cumulative };
    });
  }, [data]);

  const trend = useMemo(() => {
    if (chartData.length < 2) return 'neutral';
    const last = chartData[chartData.length - 1]?.value || 0;
    return last >= 0 ? 'positive' : 'negative';
  }, [chartData]);

  if (chartData.length === 0) {
    return (
      <div
        style={{
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          fontSize: 11,
        }}
      >
        No data
      </div>
    );
  }

  const strokeColor = trend === 'positive' ? 'var(--success)' : 'var(--error)';

  return (
    <ResponsiveContainer width={width} height={height}>
      <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <YAxis domain={['auto', 'auto']} hide />
        <Line
          type="monotone"
          dataKey="value"
          stroke={strokeColor}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
};

// ============================================================================
// COCKPIT HEADER COMPONENT
// ============================================================================

interface ExtendedCockpitHeaderProps extends CockpitHeaderProps {
  sessionName?: string;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

const CockpitHeader: React.FC<ExtendedCockpitHeaderProps> = ({
  symbol,
  netPnl,
  roiPct,
  mode,
  state,
  wsConnected,
  sparklineData,
  sessionName,
  onRefresh,
  isRefreshing,
}) => {
  const pnlColor = netPnl >= 0 ? 'var(--success)' : 'var(--error)';
  const pnlEmoji = netPnl >= 0 ? '' : '';

  return (
    <TooltipProvider>
      <div className="cockpit-header">
        <div className="cockpit-header__main">
          {/* Left: Session Info */}
          <div className="cockpit-header__info">
            <div className="cockpit-header__title-row">
              <h3 className="cockpit-header__title">
                {sessionName || symbol || 'Trading Session'}
              </h3>
              <div className="flex items-center gap-2 cockpit-header__tags">
                {/* Mode badge - subtle indicator */}
                <span
                  className={cn(
                    'inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide',
                    mode === 'live'
                      ? 'bg-yellow-500/20 text-yellow-400 ring-1 ring-yellow-500/30'
                      : 'bg-zinc-500/20 text-zinc-400 ring-1 ring-zinc-500/30'
                  )}
                >
                  {mode.toUpperCase()}
                </span>
                {/* State badge */}
                <span
                  className={cn(
                    'inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide',
                    getStateClasses(state)
                  )}
                >
                  {getStateLabel(state)}
                </span>
                {/* Connection indicator */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide cursor-default',
                        wsConnected
                          ? 'bg-green-500/20 text-green-400 ring-1 ring-green-500/30'
                          : 'bg-red-500/20 text-red-400 ring-1 ring-red-500/30'
                      )}
                    >
                      <Wifi size={12} />
                      {wsConnected ? 'LIVE' : 'OFFLINE'}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {wsConnected ? 'Connected - Live data' : 'Disconnected'}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
            <span className="cockpit-header__symbol">{symbol}</span>
          </div>

          {/* Center: PnL Focus */}
          <div className="cockpit-header__pnl">
            <div className="cockpit-header__pnl-main">
              <span className="cockpit-header__pnl-label">Net P&L</span>
              <span className="cockpit-header__pnl-value" style={{ color: pnlColor }}>
                {pnlEmoji} {formatUsd(netPnl)}
              </span>
              <span
                className="cockpit-header__pnl-pct"
                style={{ color: pnlColor, opacity: 0.85 }}
              >
                {formatPercent(roiPct)}
              </span>
            </div>
            {/* Sparkline */}
            <div className="cockpit-header__sparkline">
              <Sparkline data={sparklineData} width={100} height={36} />
            </div>
          </div>

          {/* Right: Actions */}
          <div className="cockpit-header__actions">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  onClick={onRefresh}
                  disabled={isRefreshing}
                  className="cockpit-header__refresh-btn"
                >
                  <RefreshCw size={14} className={cn(isRefreshing && 'animate-spin')} />
                  Refresh
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh session data</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Styles - scoped to this component */}
        <style>{`
          .cockpit-header {
            background: linear-gradient(135deg, rgba(99, 102, 241, 0.85) 0%, rgba(59, 130, 246, 0.80) 50%, rgba(6, 182, 212, 0.75) 100%);
            border-radius: 16px;
            padding: 20px 24px;
            color: var(--text-primary);
            box-shadow: 0 20px 40px rgba(15, 23, 42, 0.35);
            border: 1px solid var(--border-subtle);
          }

          .cockpit-header__main {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 24px;
            flex-wrap: wrap;
          }

          .cockpit-header__info {
            flex: 1 1 200px;
            min-width: 0;
          }

          .cockpit-header__title-row {
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
            margin-bottom: 4px;
          }

          .cockpit-header__title {
            margin: 0;
            color: var(--text-primary);
            font-size: 20px;
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .cockpit-header__tags {
            flex-shrink: 0;
          }

          .cockpit-header__symbol {
            font-size: 13px;
            color: var(--text-muted);
            font-family: 'JetBrains Mono', 'Menlo', monospace;
          }

          .cockpit-header__pnl {
            display: flex;
            align-items: center;
            gap: 20px;
            flex: 0 0 auto;
          }

          .cockpit-header__pnl-main {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 2px;
          }

          .cockpit-header__pnl-label {
            font-size: 10px;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            color: var(--text-muted);
          }

          .cockpit-header__pnl-value {
            font-size: 26px;
            font-weight: 700;
            font-family: 'JetBrains Mono', 'Menlo', monospace;
            line-height: 1.1;
          }

          .cockpit-header__pnl-pct {
            font-size: 14px;
            font-weight: 600;
            font-family: 'JetBrains Mono', 'Menlo', monospace;
          }

          .cockpit-header__sparkline {
            background: rgba(15, 23, 42, 0.3);
            border-radius: 8px;
            padding: 4px 8px;
            border: 1px solid var(--border-subtle);
          }

          .cockpit-header__actions {
            flex: 0 0 auto;
          }

          .cockpit-header__refresh-btn {
            background: rgba(255, 255, 255, 0.1) !important;
            border-color: rgba(255, 255, 255, 0.2) !important;
            color: var(--text-primary) !important;
          }

          .cockpit-header__refresh-btn:hover {
            background: rgba(255, 255, 255, 0.15) !important;
            border-color: rgba(255, 255, 255, 0.3) !important;
          }

          @media (max-width: 768px) {
            .cockpit-header {
              padding: 16px;
            }

            .cockpit-header__main {
              flex-direction: column;
              align-items: stretch;
              gap: 16px;
            }

            .cockpit-header__pnl {
              justify-content: space-between;
              width: 100%;
            }

            .cockpit-header__pnl-main {
              align-items: flex-start;
            }

            .cockpit-header__actions {
              width: 100%;
            }

            .cockpit-header__refresh-btn {
              width: 100%;
            }
          }
        `}</style>
      </div>
    </TooltipProvider>
  );
};

export default CockpitHeader;
