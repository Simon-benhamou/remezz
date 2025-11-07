/**
 * Regime-Aware Thresholds Display Component
 * 
 * Shows current threshold configuration and how they adapt to market regime
 */

import React, { useEffect, useState } from 'react';
import { Card, Descriptions, Tag, Alert, Spin, Space, Typography } from 'antd';
import { 
  ThunderboltOutlined,
  DashboardOutlined,
  RiseOutlined,
  FallOutlined,
  LineChartOutlined,
} from '@ant-design/icons';
import api from '../api';

const { Text, Paragraph } = Typography;

interface RegimeThresholds {
  confidence: number;
  atr: number;
  adx: number;
  eligibility: number;
  rrMin: number;
}

interface RegimeInfo {
  type: string;
  direction: string;
  momentum: number;
  volatility: number;
  tags: string[];
}

interface ThresholdsData {
  symbol: string;
  thresholds: RegimeThresholds;
  regime: RegimeInfo;
  tier: 'A' | 'B' | 'C';
  explanation: string;
}

interface Props {
  symbol: string;
  aggressiveness?: 'conservative' | 'reactive' | 'aggressive';
}

export const RegimeAwareThresholdsDisplay: React.FC<Props> = ({ 
  symbol, 
  aggressiveness = 'reactive' 
}) => {
  const [data, setData] = useState<ThresholdsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadThresholds();
    const interval = setInterval(loadThresholds, 60000); // Refresh every 60s
    return () => clearInterval(interval);
  }, [symbol, aggressiveness]);

  const loadThresholds = async () => {
    try {
      const response = await api.get(
        `/entry-analytics/thresholds/${encodeURIComponent(symbol)}`,
        { params: { aggressiveness } }
      );
      if (response.data.ok) {
        setData(response.data);
      }
    } catch (error) {
      console.error('Failed to load thresholds:', error);
    } finally {
      setLoading(false);
    }
  };

  const getRegimeColor = (regimeType: string): string => {
    switch (regimeType) {
      case 'trend': return 'blue';
      case 'breakout': return 'green';
      case 'range': return 'orange';
      case 'volatility_spike': return 'red';
      case 'illiquid': return 'grey';
      default: return 'default';
    }
  };

  const getDirectionIcon = (direction: string) => {
    switch (direction) {
      case 'bull': return <RiseOutlined style={{ color: '#52c41a' }} />;
      case 'bear': return <FallOutlined style={{ color: '#ff4d4f' }} />;
      default: return <LineChartOutlined style={{ color: '#999' }} />;
    }
  };

  const getTierBadge = (tier: 'A' | 'B' | 'C') => {
    const colors = { A: 'gold', B: 'blue', C: 'default' };
    const labels = { 
      A: 'Tier A (Major)', 
      B: 'Tier B (Mid-cap)', 
      C: 'Tier C (Alt)' 
    };
    return <Tag color={colors[tier]}>{labels[tier]}</Tag>;
  };

  if (loading) {
    return (
      <Card>
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      </Card>
    );
  }

  if (!data) {
    return (
      <Alert
        message="Failed to load thresholds"
        type="warning"
        showIcon
      />
    );
  }

  const { thresholds, regime, tier } = data;

  return (
    <Card
      title={
        <Space>
          <DashboardOutlined />
          <span>Regime-Aware Thresholds</span>
          {getTierBadge(tier)}
        </Space>
      }
      extra={
        <Tag color={getRegimeColor(regime.type)}>
          {regime.type.toUpperCase()}
        </Tag>
      }
    >
      {/* Regime Information */}
      <Alert
        message={
          <Space>
            <Text strong>Current Market Regime:</Text>
            <Tag color={getRegimeColor(regime.type)}>{regime.type}</Tag>
            {getDirectionIcon(regime.direction)}
            <Text>{regime.direction}</Text>
          </Space>
        }
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />

      {/* Thresholds */}
      <Descriptions column={2} size="small" bordered>
        <Descriptions.Item label="Confidence Threshold">
          <Text strong>{(thresholds.confidence * 100).toFixed(1)}%</Text>
          <Text type="secondary" style={{ marginLeft: 8 }}>
            (min confidence to enter)
          </Text>
        </Descriptions.Item>
        
        <Descriptions.Item label="ATR Threshold">
          <Text strong>{thresholds.atr.toFixed(2)}%</Text>
          <Text type="secondary" style={{ marginLeft: 8 }}>
            (min volatility required)
          </Text>
        </Descriptions.Item>

        <Descriptions.Item label="ADX Threshold">
          <Text strong>{thresholds.adx.toFixed(1)}</Text>
          <Text type="secondary" style={{ marginLeft: 8 }}>
            (min trend strength)
          </Text>
        </Descriptions.Item>

        <Descriptions.Item label="Eligibility Score">
          <Text strong>{(thresholds.eligibility * 100).toFixed(1)}%</Text>
          <Text type="secondary" style={{ marginLeft: 8 }}>
            (composite quality)
          </Text>
        </Descriptions.Item>

        <Descriptions.Item label="Risk/Reward Min">
          <Text strong>{thresholds.rrMin.toFixed(1)}:1</Text>
          <Text type="secondary" style={{ marginLeft: 8 }}>
            (min R:R ratio)
          </Text>
        </Descriptions.Item>

        <Descriptions.Item label="Aggressiveness">
          <Tag color={
            aggressiveness === 'aggressive' ? 'red' :
            aggressiveness === 'reactive' ? 'blue' : 'green'
          }>
            {aggressiveness.toUpperCase()}
          </Tag>
        </Descriptions.Item>
      </Descriptions>

      {/* Market Characteristics */}
      <div style={{ marginTop: 16 }}>
        <Text strong>Market Characteristics:</Text>
        <div style={{ marginTop: 8 }}>
          <Space wrap>
            <Tag>
              Momentum: {regime.momentum.toFixed(2)}
            </Tag>
            <Tag>
              Volatility: {regime.volatility.toFixed(2)}
            </Tag>
            {regime.tags.map(tag => (
              <Tag key={tag} color="blue">
                {tag.replace(/_/g, ' ')}
              </Tag>
            ))}
          </Space>
        </div>
      </div>

      {/* Explanation */}
      {data.explanation && (
        <div style={{ marginTop: 16 }}>
          <Alert
            message="Threshold Explanation"
            description={
              <pre style={{ 
                whiteSpace: 'pre-wrap', 
                fontFamily: 'monospace',
                fontSize: 12,
                margin: 0,
                background: 'transparent',
              }}>
                {data.explanation}
              </pre>
            }
            type="success"
            showIcon
            icon={<ThunderboltOutlined />}
          />
        </div>
      )}
    </Card>
  );
};

export default RegimeAwareThresholdsDisplay;
