/**
 * V5.72: CockpitHeader Component
 *
 * PnL-focused header with session info, mode indicator, and sparkline.
 */

import React, { useMemo } from 'react';
import { Space, Tag, Typography, Tooltip, Button } from 'antd';
import { ReloadOutlined, WifiOutlined } from '@ant-design/icons';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import type { CockpitHeaderProps, SessionState } from '../../types/cockpit';

const { Title, Text } = Typography;

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

const getStateColor = (state: SessionState): string => {
  switch (state) {
    case 'IN_POSITION':
      return 'green';
    case 'WATCHING':
      return 'blue';
    case 'HALT':
      return 'red';
    case 'STOPPED':
      return 'default';
    default:
      return 'default';
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
          color: 'rgba(226, 232, 240, 0.4)',
          fontSize: 11,
        }}
      >
        No data
      </div>
    );
  }

  const strokeColor = trend === 'positive' ? '#10b981' : '#ef4444';

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
  const pnlColor = netPnl >= 0 ? '#10b981' : '#ef4444';
  const pnlEmoji = netPnl >= 0 ? '' : '';

  return (
    <div className="cockpit-header">
      <div className="cockpit-header__main">
        {/* Left: Session Info */}
        <div className="cockpit-header__info">
          <div className="cockpit-header__title-row">
            <Title level={3} className="cockpit-header__title">
              {sessionName || symbol || 'Trading Session'}
            </Title>
            <Space size={8} className="cockpit-header__tags">
              {/* Mode badge - subtle indicator */}
              <Tag
                className="cockpit-header__mode-tag"
                color={mode === 'live' ? 'gold' : 'default'}
              >
                {mode.toUpperCase()}
              </Tag>
              {/* State badge */}
              <Tag className="cockpit-header__state-tag" color={getStateColor(state)}>
                {getStateLabel(state)}
              </Tag>
              {/* Connection indicator */}
              <Tooltip title={wsConnected ? 'Connected - Live data' : 'Disconnected'}>
                <Tag
                  className="cockpit-header__ws-tag"
                  color={wsConnected ? 'green' : 'red'}
                  icon={<WifiOutlined />}
                >
                  {wsConnected ? 'LIVE' : 'OFFLINE'}
                </Tag>
              </Tooltip>
            </Space>
          </div>
          <Text className="cockpit-header__symbol">{symbol}</Text>
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
          <Tooltip title="Refresh session data">
            <Button
              icon={<ReloadOutlined spin={isRefreshing} />}
              onClick={onRefresh}
              loading={isRefreshing}
              className="cockpit-header__refresh-btn"
            >
              Refresh
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* Styles - scoped to this component */}
      <style>{`
        .cockpit-header {
          background: linear-gradient(135deg, rgba(30, 64, 175, 0.92), rgba(12, 74, 110, 0.88));
          border-radius: 16px;
          padding: 20px 24px;
          color: #f8fafc;
          box-shadow: 0 20px 40px rgba(15, 23, 42, 0.35);
          border: 1px solid rgba(148, 163, 184, 0.18);
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
          margin: 0 !important;
          color: #f8fafc !important;
          font-size: 20px !important;
          font-weight: 600 !important;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .cockpit-header__tags {
          flex-shrink: 0;
        }

        .cockpit-header__mode-tag,
        .cockpit-header__state-tag,
        .cockpit-header__ws-tag {
          border-radius: 999px !important;
          font-weight: 600;
          font-size: 11px;
          letter-spacing: 0.05em;
          padding: 0 10px !important;
        }

        .cockpit-header__symbol {
          font-size: 13px;
          color: rgba(226, 232, 240, 0.7);
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
          color: rgba(226, 232, 240, 0.7);
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
          border: 1px solid rgba(148, 163, 184, 0.15);
        }

        .cockpit-header__actions {
          flex: 0 0 auto;
        }

        .cockpit-header__refresh-btn {
          background: rgba(255, 255, 255, 0.1) !important;
          border-color: rgba(255, 255, 255, 0.2) !important;
          color: #f8fafc !important;
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
  );
};

export default CockpitHeader;
