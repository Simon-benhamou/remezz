import React from 'react';
import { Card, Row, Col, Statistic, Tag, Space, Typography, Tooltip, Progress } from 'antd';
import { 
  ArrowUpOutlined, 
  ArrowDownOutlined, 
  InfoCircleOutlined,
  ThunderboltOutlined 
} from '@ant-design/icons';

const { Text } = Typography;

interface MarketContext {
  last: number;
  change24h: number;
  volume24h: number;
  volumeMA: number;
  volumeRatio: number;
}

interface Props {
  market: MarketContext;
  symbol: string;
  loading?: boolean;
}

const formatVolume = (volume: number) => {
  if (volume >= 1_000_000_000) {
    return `${(volume / 1_000_000_000).toFixed(2)}B`;
  }
  if (volume >= 1_000_000) {
    return `${(volume / 1_000_000).toFixed(2)}M`;
  }
  if (volume >= 1_000) {
    return `${(volume / 1_000).toFixed(2)}K`;
  }
  return volume.toFixed(0);
};

const getVolumeColor = (ratio: number) => {
  if (ratio >= 1.5) return 'var(--success)'; // High volume
  if (ratio >= 1.2) return 'var(--success)'; // Above average
  if (ratio >= 0.8) return 'var(--text-secondary)'; // Normal
  if (ratio >= 0.5) return 'var(--warning)'; // Below average
  return 'var(--error)'; // Low volume
};

const getVolumeStatus = (ratio: number) => {
  if (ratio >= 1.5) return { text: 'High Volume', color: 'green' };
  if (ratio >= 1.2) return { text: 'Above Average', color: 'cyan' };
  if (ratio >= 0.8) return { text: 'Normal', color: 'blue' };
  if (ratio >= 0.5) return { text: 'Below Average', color: 'orange' };
  return { text: 'Low Volume', color: 'red' };
};

export default function MarketContextCard({ market, symbol, loading }: Props) {
  if (loading) {
    return <Card title="Market Context" loading />;
  }

  if (!market || market.last === 0) {
    return (
      <Card title="Market Context">
        <Text type="secondary">No market data available</Text>
      </Card>
    );
  }

  const volumeStatus = getVolumeStatus(market.volumeRatio);
  const isPositiveChange = market.change24h >= 0;

  return (
    <Card
      title={
        <Space>
          <span>{symbol} Market Context</span>
          <Tooltip title="Real-time market conditions and liquidity">
            <InfoCircleOutlined style={{ fontSize: 12, opacity: 0.6 }} />
          </Tooltip>
        </Space>
      }
      bordered={false}
      size="small"
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        
        {/* Price & 24h Change */}
        <Row gutter={16}>
          <Col span={12}>
            <Statistic
              title="Current Price"
              value={market.last}
              precision={market.last < 1 ? 6 : market.last < 100 ? 4 : 2}
              prefix="$"
              valueStyle={{ fontSize: 18, fontWeight: 600 }}
            />
          </Col>
          <Col span={12}>
            <Statistic
              title="24h Change"
              value={Math.abs(market.change24h)}
              precision={2}
              suffix="%"
              prefix={isPositiveChange ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
              valueStyle={{ 
                fontSize: 18, 
                fontWeight: 600,
                color: isPositiveChange ? 'var(--success)' : 'var(--error)' 
              }}
            />
          </Col>
        </Row>

        {/* Volume Analysis */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Volume Analysis
            </Text>
            <Tag color={volumeStatus.color} icon={<ThunderboltOutlined />}>
              {volumeStatus.text}
            </Tag>
          </div>
          
          <Row gutter={12} style={{ marginBottom: 12 }}>
            <Col span={12}>
              <div>
                <Text type="secondary" style={{ fontSize: 11 }}>24h Volume</Text>
                <div>
                  <Text strong style={{ fontSize: 14 }}>
                    ${formatVolume(market.volume24h)}
                  </Text>
                </div>
              </div>
            </Col>
            <Col span={12}>
              <div>
                <Text type="secondary" style={{ fontSize: 11 }}>Volume MA</Text>
                <div>
                  <Text strong style={{ fontSize: 14 }}>
                    ${formatVolume(market.volumeMA)}
                  </Text>
                </div>
              </div>
            </Col>
          </Row>

          {/* Volume Ratio Progress Bar */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text type="secondary" style={{ fontSize: 11 }}>
                Volume vs Average
              </Text>
              <Text strong style={{ fontSize: 12 }}>
                {market.volumeRatio.toFixed(2)}x
              </Text>
            </div>
            <Progress
              percent={Math.min(market.volumeRatio * 50, 100)} // Scale: 2x = 100%
              strokeColor={getVolumeColor(market.volumeRatio)}
              showInfo={false}
              size="small"
            />
          </div>
        </div>

        {/* Volume Insights */}
        <div style={{ 
          padding: 8, 
          background: market.volumeRatio >= 1.2 ? 'rgba(16, 185, 129, 0.08)' : market.volumeRatio < 0.8 ? 'rgba(239, 68, 68, 0.08)' : 'rgba(6, 182, 212, 0.06)',
          borderRadius: 4,
          border: `1px solid ${market.volumeRatio >= 1.2 ? 'rgba(16, 185, 129, 0.25)' : market.volumeRatio < 0.8 ? 'rgba(239, 68, 68, 0.25)' : 'var(--border-color, rgba(30, 58, 95, 0.4))'}`
        }}>
          <Text style={{ fontSize: 11 }}>
            {market.volumeRatio >= 1.5 && '🔥 Exceptional volume activity - Strong market interest'}
            {market.volumeRatio >= 1.2 && market.volumeRatio < 1.5 && '✅ Above-average volume - Good liquidity for entries'}
            {market.volumeRatio >= 0.8 && market.volumeRatio < 1.2 && 'ℹ️ Normal market activity - Standard conditions'}
            {market.volumeRatio >= 0.5 && market.volumeRatio < 0.8 && '⚠️ Below-average volume - Exercise caution'}
            {market.volumeRatio < 0.5 && '🚫 Low volume detected - Risk of slippage and poor fills'}
          </Text>
        </div>

      </Space>
    </Card>
  );
}
