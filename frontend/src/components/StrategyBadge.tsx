/**
 * Badge pour afficher la stratégie utilisée dans un trade
 */

import React from 'react';
import { Tag } from 'antd';
import { 
  StrategyType, 
  STRATEGY_COLORS, 
  STRATEGY_LABELS 
} from '../types/strategy';
import { 
  LineChartOutlined, 
  SwapOutlined, 
  ThunderboltOutlined, 
  RocketOutlined 
} from '@ant-design/icons';

interface StrategyBadgeProps {
  strategy?: string | null;
  confidence?: number | null;
  size?: 'small' | 'default';
  showIcon?: boolean;
}

const STRATEGY_ICONS: Record<StrategyType, React.ReactNode> = {
  trend_following: <LineChartOutlined />,
  mean_reversion: <SwapOutlined />,
  breakout: <ThunderboltOutlined />,
  momentum: <RocketOutlined />,
};

export default function StrategyBadge({ 
  strategy, 
  confidence, 
  size = 'default',
  showIcon = true 
}: StrategyBadgeProps) {
  if (!strategy) {
    return <Tag>Unknown</Tag>;
  }

  const strategyType = strategy as StrategyType;
  const color = STRATEGY_COLORS[strategyType] || '#d9d9d9';
  const label = STRATEGY_LABELS[strategyType] || strategy;
  const icon = showIcon ? STRATEGY_ICONS[strategyType] : null;

  return (
    <Tag 
      color={color} 
      style={{ 
        fontSize: size === 'small' ? '11px' : '12px',
        padding: size === 'small' ? '0 4px' : '2px 8px',
        fontWeight: 500,
      }}
    >
      {icon && <span style={{ marginRight: 4 }}>{icon}</span>}
      {label}
      {confidence != null && confidence > 0 && (
        <span style={{ 
          marginLeft: 4, 
          opacity: 0.8,
          fontSize: size === 'small' ? '10px' : '11px' 
        }}>
          {(confidence * 100).toFixed(0)}%
        </span>
      )}
    </Tag>
  );
}
