import React from 'react';
import { Card, Statistic, Button, Space, Typography, Tooltip, Modal, message, Badge, Tag } from 'antd';
import { CloseOutlined, WarningOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { api } from '../api';

const { Text, Title } = Typography;

interface PositionData {
  side?: string;
  entry?: number;
  stop?: number;
  targets?: number[];
  qty?: number;
  leverage?: number;
  peakPrice?: number;
  initialStopDistance?: number;
  openedAt?: number | string;
}

interface PositionInfoCardProps {
  position: PositionData | null | undefined;
  currentPrice?: number;
  symbol?: string;
  sessionId?: string;
  profile?: any;
  onClose?: () => void;
}

export default function PositionInfoCard({
  position,
  currentPrice,
  symbol,
  sessionId,
  profile,
  onClose,
}: PositionInfoCardProps) {
  const [closing, setClosing] = React.useState(false);

  if (!position || !position.entry) {
    return (
      <Card 
        title={<Space><InfoCircleOutlined /> Position Info</Space>}
        size="small"
        style={{ borderRadius: 8 }}
      >
        <Text type="secondary" style={{ fontSize: 13 }}>
          No open position
        </Text>
      </Card>
    );
  }

  const {
    side = 'buy',
    entry = 0,
    stop = 0,
    targets = [],
    qty = 0,
    leverage = 1,
    peakPrice,
    initialStopDistance,
    openedAt,
  } = position;

  const isLong = side === 'buy' || side === 'long';
  const price = currentPrice || entry;

  // Calculate unrealized PnL
  const pnlPerUnit = isLong ? (price - entry) : (entry - price);
  const pnlTotal = pnlPerUnit * qty;
  const pnlPct = ((pnlPerUnit / entry) * 100) * (leverage || 1);

  // Calculate R-multiple (position risk vs reward)
  let rMultiple = 0;
  let rMultipleColor = '#999';
  if (initialStopDistance && initialStopDistance > 0) {
    rMultiple = pnlPerUnit / initialStopDistance;
    if (rMultiple >= 2) rMultipleColor = '#16a34a'; // Green for >= 2R
    else if (rMultiple >= 1) rMultipleColor = '#0ea5e9'; // Blue for >= 1R
    else if (rMultiple >= 0) rMultipleColor = '#f59e0b'; // Orange for breakeven to 1R
    else rMultipleColor = '#dc2626'; // Red for negative R
  }

  // Calculate stop loss distance
  const stopDistance = Math.abs(entry - stop);
  const stopDistancePct = (stopDistance / entry) * 100;
  const stopHit = isLong ? price <= stop : price >= stop;

  // Calculate time held
  let timeHeld = '—';
  if (openedAt) {
    const openTime = typeof openedAt === 'number' ? openedAt : Date.parse(openedAt as string);
    if (openTime && Number.isFinite(openTime)) {
      const minutesHeld = (Date.now() - openTime) / 60000;
      if (minutesHeld < 60) {
        timeHeld = `${Math.floor(minutesHeld)}m`;
      } else if (minutesHeld < 1440) {
        timeHeld = `${Math.floor(minutesHeld / 60)}h ${Math.floor(minutesHeld % 60)}m`;
      } else {
        timeHeld = `${Math.floor(minutesHeld / 1440)}d ${Math.floor((minutesHeld % 1440) / 60)}h`;
      }
    }
  }

  // Format exit strategy mode from agent profile or defaults
  const exitStrategyMode: 'partial' | 'trailing' | 'hybrid' = profile?.exitStrategyMode || 'hybrid';
  const exitModeLabel = {
    partial: 'Partial exits at targets',
    trailing: 'Trailing stop only',
    hybrid: 'Hybrid (first TP + trailing)',
  }[exitStrategyMode] || 'Unknown';
  
  const exitModeDescription = {
    partial: 'Takes partial profits at each target price',
    trailing: 'Uses trailing stop to capture gains, no fixed targets',
    hybrid: 'Takes 50% at first target (2R), then trails remaining position',
  }[exitStrategyMode] || '';

  const handleClosePosition = () => {
    Modal.confirm({
      title: 'Close Position Manually?',
      icon: <WarningOutlined style={{ color: '#faad14' }} />,
      content: (
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Text>This will immediately close your {isLong ? 'LONG' : 'SHORT'} position:</Text>
          <div style={{ padding: 12, background: 'rgba(6, 182, 212, 0.06)', borderRadius: 6, marginTop: 8 }}>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Text strong>{qty.toFixed(4)} {symbol || ''}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Entry: ${entry.toFixed(4)} · Current: ${price.toFixed(4)}
              </Text>
              <Text 
                style={{ 
                  fontSize: 13, 
                  fontWeight: 600,
                  color: pnlTotal >= 0 ? '#16a34a' : '#dc2626' 
                }}
              >
                {pnlTotal >= 0 ? '+' : ''}${pnlTotal.toFixed(2)} ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
              </Text>
            </Space>
          </div>
          <Text type="warning" style={{ fontSize: 12, marginTop: 8 }}>
            ⚠️ This action cannot be undone. The position will be closed at market price.
          </Text>
        </Space>
      ),
      okText: 'Yes, Close Position',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        if (!sessionId) {
          message.error('Session ID not available');
          return;
        }

        setClosing(true);
        try {
          // Call backend API to close position
          await api.client.post(`/api/agent/close-position`, {
            sessionId,
            reason: 'manual_close_from_ui'
          });
          
          message.success('Position close order submitted');
          
          // Trigger refresh callback
          if (onClose) {
            setTimeout(onClose, 1500);
          }
        } catch (error: any) {
          console.error('Failed to close position:', error);
          const errorMsg = error?.response?.data?.error || error?.message || 'Unknown error';
          message.error(`Failed to close position: ${errorMsg}`);
        } finally {
          setClosing(false);
        }
      },
    });
  };

  return (
    <Card
      title={
        <Space>
          <Badge status={isLong ? 'success' : 'error'} />
          <span>{isLong ? 'LONG' : 'SHORT'} Position</span>
          {leverage > 1 && <Tag color="purple">{leverage.toFixed(1)}x</Tag>}
        </Space>
      }
      size="small"
      style={{ borderRadius: 8 }}
      extra={
        <Tooltip title="Close this position immediately at market price">
          <Button
            type="primary"
            danger
            size="small"
            icon={<CloseOutlined />}
            onClick={handleClosePosition}
            loading={closing}
          >
            Close
          </Button>
        </Tooltip>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/* PnL Overview */}
        <div style={{ 
          padding: 12, 
          borderRadius: 6, 
          background: pnlTotal >= 0 ? 'rgba(22, 163, 74, 0.08)' : 'rgba(220, 38, 38, 0.08)',
          border: `1px solid ${pnlTotal >= 0 ? 'rgba(22, 163, 74, 0.2)' : 'rgba(220, 38, 38, 0.2)'}`,
        }}>
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 11 }}>Unrealized P&L</Text>
            <Title 
              level={4} 
              style={{ 
                margin: 0, 
                color: pnlTotal >= 0 ? '#16a34a' : '#dc2626',
                fontSize: 20,
              }}
            >
              {pnlTotal >= 0 ? '+' : ''}${pnlTotal.toFixed(2)}
            </Title>
            <Text style={{ fontSize: 12, color: pnlTotal >= 0 ? '#16a34a' : '#dc2626' }}>
              {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}% {leverage > 1 && `(${leverage.toFixed(1)}x)`}
            </Text>
          </Space>
        </div>

        {/* R-Multiple */}
        {initialStopDistance && initialStopDistance > 0 && (
          <div style={{ 
            padding: 10, 
            borderRadius: 6, 
            background: 'rgba(15, 23, 42, 0.04)',
            border: '1px solid rgba(15, 23, 42, 0.08)',
          }}>
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
                <Text type="secondary" style={{ fontSize: 11 }}>R-Multiple</Text>
                <Tooltip title="Risk-adjusted return: how many times your initial risk (stop distance) you've gained/lost">
                  <InfoCircleOutlined style={{ fontSize: 12, color: '#999' }} />
                </Tooltip>
              </Space>
              <Text 
                strong 
                style={{ 
                  fontSize: 16, 
                  color: rMultipleColor,
                }}
              >
                {rMultiple >= 0 ? '+' : ''}{rMultiple.toFixed(2)}R
              </Text>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {rMultiple >= 2 
                  ? '🎯 Excellent reward' 
                  : rMultiple >= 1 
                    ? '✅ Profitable' 
                    : rMultiple >= 0 
                      ? '⚠️ Near breakeven' 
                      : '🛑 At loss'}
              </Text>
            </Space>
          </div>
        )}

        {/* Entry & Current Price */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Statistic
            title={<Text type="secondary" style={{ fontSize: 11 }}>Entry Price</Text>}
            value={entry}
            precision={4}
            prefix="$"
            valueStyle={{ fontSize: 14 }}
          />
          <Statistic
            title={<Text type="secondary" style={{ fontSize: 11 }}>Current Price</Text>}
            value={price}
            precision={4}
            prefix="$"
            valueStyle={{ fontSize: 14, color: pnlTotal >= 0 ? '#16a34a' : '#dc2626' }}
          />
        </div>

        {/* Stop Loss */}
        <div style={{ 
          padding: 10, 
          borderRadius: 6, 
          background: stopHit ? 'rgba(220, 38, 38, 0.08)' : 'rgba(15, 23, 42, 0.04)',
          border: `1px solid ${stopHit ? 'rgba(220, 38, 38, 0.2)' : 'rgba(15, 23, 42, 0.08)'}`,
        }}>
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
              <Text type="secondary" style={{ fontSize: 11 }}>Stop Loss</Text>
              {stopHit && <Tag color="red" style={{ margin: 0, fontSize: 10 }}>HIT</Tag>}
            </Space>
            <Text strong style={{ fontSize: 14 }}>
              ${stop.toFixed(4)}
            </Text>
            <Text type="secondary" style={{ fontSize: 11 }}>
              Distance: {stopDistancePct.toFixed(2)}% ({isLong ? 'below' : 'above'} entry)
            </Text>
          </Space>
        </div>

        {/* Take Profit Targets */}
        {targets && targets.length > 0 && (
          <div style={{ 
            padding: 10, 
            borderRadius: 6, 
            background: 'rgba(22, 163, 74, 0.06)',
            border: '1px solid rgba(22, 163, 74, 0.15)',
          }}>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Text type="secondary" style={{ fontSize: 11 }}>Take Profit Targets</Text>
              {targets.map((target, index) => {
                const targetHit = isLong ? price >= target : price <= target;
                const targetDistance = ((Math.abs(target - entry) / entry) * 100);
                return (
                  <div key={index} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 12 }}>
                      Target {index + 1}: ${target.toFixed(4)}
                    </Text>
                    {targetHit ? (
                      <Tag color="green" style={{ margin: 0, fontSize: 10 }}>✓ HIT</Tag>
                    ) : (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        +{targetDistance.toFixed(1)}%
                      </Text>
                    )}
                  </div>
                );
              })}
            </Space>
          </div>
        )}

        {/* Exit Strategy Mode */}
        <div style={{ 
          padding: 10, 
          borderRadius: 6, 
          background: 'rgba(99, 102, 241, 0.06)',
          border: '1px solid rgba(99, 102, 241, 0.15)',
        }}>
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
              <Text type="secondary" style={{ fontSize: 11 }}>Exit Strategy</Text>
              <Tooltip title={exitModeDescription}>
                <InfoCircleOutlined style={{ fontSize: 12, color: '#999' }} />
              </Tooltip>
            </Space>
            <Text strong style={{ fontSize: 12, color: '#6366f1' }}>
              {exitModeLabel}
            </Text>
            <Text type="secondary" style={{ fontSize: 11 }}>
              Time held: {timeHeld}
            </Text>
          </Space>
        </div>

        {/* Peak Price (for trailing stop reference) */}
        {peakPrice && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Statistic
              title={<Text type="secondary" style={{ fontSize: 11 }}>Peak Price</Text>}
              value={peakPrice}
              precision={4}
              prefix="$"
              valueStyle={{ fontSize: 13 }}
            />
            <Statistic
              title={<Text type="secondary" style={{ fontSize: 11 }}>Drawdown from Peak</Text>}
              value={Math.abs(((price - peakPrice) / peakPrice) * 100)}
              precision={2}
              suffix="%"
              valueStyle={{ fontSize: 13, color: '#dc2626' }}
            />
          </div>
        )}
      </Space>
    </Card>
  );
}
