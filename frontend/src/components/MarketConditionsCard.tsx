import React from 'react';
import { Card, Tag, Space, Tooltip, Typography, Spin } from 'antd';
import { 
  ThunderboltOutlined, 
  ArrowUpOutlined, 
  ArrowDownOutlined,
  MinusOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined
} from '@ant-design/icons';
import { api } from '../api';

const { Text } = Typography;

interface MarketConditions {
  status: 'favorable_long' | 'favorable_short' | 'neutral' | 'unfavorable' | 'unknown';
  btcAboveMa50: boolean | null;
  btcMomentum6h: number | null;
  btcTrend: 'bullish' | 'bearish' | 'neutral' | null;
  isTradingDay: boolean | null;
  reason: string;
  tradingRecommended: boolean;
}

const statusConfig = {
  favorable_long: {
    color: 'var(--success)',
    bgColor: 'rgba(82, 196, 26, 0.1)',
    icon: <ArrowUpOutlined />,
    label: 'FAVORABLE LONG',
    description: 'Conditions idéales pour entrer en position longue',
  },
  favorable_short: {
    color: 'var(--error)',
    bgColor: 'rgba(255, 77, 79, 0.1)',
    icon: <ArrowDownOutlined />,
    label: 'FAVORABLE SHORT',
    description: 'Conditions idéales pour entrer en position short',
  },
  neutral: {
    color: '#faad14',
    bgColor: 'rgba(250, 173, 20, 0.1)',
    icon: <MinusOutlined />,
    label: 'NEUTRAL',
    description: 'Conditions mitigées - attendre un signal plus clair',
  },
  unfavorable: {
    color: 'var(--error)',
    bgColor: 'rgba(255, 77, 79, 0.1)',
    icon: <WarningOutlined />,
    label: 'UNFAVORABLE',
    description: 'Mauvaises conditions - ne pas ouvrir de position',
  },
  unknown: {
    color: '#d9d9d9',
    bgColor: 'rgba(217, 217, 217, 0.1)',
    icon: <ClockCircleOutlined />,
    label: 'UNKNOWN',
    description: 'En attente des données de marché...',
  },
};

export default function MarketConditionsCard() {
  const [conditions, setConditions] = React.useState<MarketConditions | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    try {
      const data = await api.getMarketConditions();
      setConditions(data);
    } catch (error) {
      console.warn('Failed to load market conditions:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
    const interval = setInterval(load, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, [load]);

  if (loading) {
    return (
      <Card size="small" style={{ textAlign: 'center' }}>
        <Spin size="small" />
        <Text type="secondary"> Loading market conditions...</Text>
      </Card>
    );
  }

  if (!conditions) {
    return null;
  }

  const config = statusConfig[conditions.status];

  return (
    <Card 
      size="small"
      style={{ 
        borderLeft: `4px solid ${config.color}`,
        background: config.bgColor,
      }}
    >
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        {/* Status Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            <ThunderboltOutlined style={{ color: config.color, fontSize: 18 }} />
            <Text strong style={{ fontSize: 14 }}>Market Conditions</Text>
          </Space>
          <Tag 
            color={conditions.tradingRecommended ? 'green' : 'default'}
            icon={conditions.tradingRecommended ? <CheckCircleOutlined /> : <WarningOutlined />}
          >
            {conditions.tradingRecommended ? 'TRADE OK' : 'WAIT'}
          </Tag>
        </div>

        {/* Main Status */}
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: 8,
          padding: '8px 0'
        }}>
          <span style={{ fontSize: 24, color: config.color }}>{config.icon}</span>
          <div>
            <div style={{ fontSize: 18, fontWeight: 'bold', color: config.color }}>
              {config.label}
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {config.description}
            </Text>
          </div>
        </div>

        {/* Details */}
        <div style={{ 
          background: 'rgba(255,255,255,0.5)', 
          padding: 8, 
          borderRadius: 4,
          fontSize: 12,
        }}>
          <div style={{ marginBottom: 4 }}>
            <Text type="secondary">Raison: </Text>
            <Text>{conditions.reason}</Text>
          </div>
          
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {conditions.btcTrend && (
              <Tooltip title="Tendance BTC actuelle">
                <Tag color={
                  conditions.btcTrend === 'bullish' ? 'green' : 
                  conditions.btcTrend === 'bearish' ? 'red' : 'default'
                }>
                  BTC: {conditions.btcTrend.toUpperCase()}
                </Tag>
              </Tooltip>
            )}
            
            {conditions.btcMomentum6h !== null && (
              <Tooltip title="Momentum BTC sur 6h">
                <Tag color={conditions.btcMomentum6h > 0.75 ? 'green' : conditions.btcMomentum6h < -0.75 ? 'red' : 'default'}>
                  Mom 6h: {conditions.btcMomentum6h.toFixed(2)}%
                </Tag>
              </Tooltip>
            )}
            
            {conditions.btcAboveMa50 !== null && (
              <Tooltip title="BTC au-dessus de sa MA50">
                <Tag color={conditions.btcAboveMa50 ? 'green' : 'red'}>
                  MA50: {conditions.btcAboveMa50 ? '✓' : '✗'}
                </Tag>
              </Tooltip>
            )}
            
            {conditions.isTradingDay !== null && (
              <Tooltip title="Est-ce un jour de trading?">
                <Tag color={conditions.isTradingDay ? 'green' : 'orange'}>
                  {conditions.isTradingDay ? 'Trading Day' : 'Off Day'}
                </Tag>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Zero trades explanation */}
        {!conditions.tradingRecommended && (
          <Text type="warning" style={{ fontSize: 11 }}>
            ⚠️ Si vous avez 0 trade, c'est normal - les conditions ne sont pas favorables.
          </Text>
        )}
      </Space>
    </Card>
  );
}
