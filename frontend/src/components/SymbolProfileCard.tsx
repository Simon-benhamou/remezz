import React from 'react';
import { Card, Tag, Statistic, Row, Col, Typography, Tooltip } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';

const { Text } = Typography;

export type SymbolProfile = {
  volatilityRegime: string;
  directionBias: string;
  volumeRegime: string;
  trendingRanging: string;
  atrPct: number;
  adx: number;
  rsi: number;
  trendStrength: number;
};

interface SymbolProfileCardProps {
  profile: SymbolProfile | null;
  loading?: boolean;
}

const getVolatilityColor = (regime: string) => {
  switch (regime?.toLowerCase()) {
    case 'low':
    case 'low_volatility':
      return 'green';
    case 'moderate':
    case 'moderate_volatility':
      return 'blue';
    case 'high':
    case 'high_volatility':
      return 'orange';
    case 'extreme':
    case 'extreme_volatility':
    case 'meme_volatility':
      return 'red';
    default:
      return 'default';
  }
};

const getDirectionColor = (bias: string) => {
  switch (bias?.toLowerCase()) {
    case 'bullish':
      return 'green';
    case 'bearish':
      return 'red';
    case 'neutral':
      return 'default';
    default:
      return 'default';
  }
};

const getVolumeColor = (regime: string) => {
  switch (regime?.toLowerCase()) {
    case 'low':
    case 'low_volume':
      return 'red';
    case 'normal':
    case 'normal_volume':
      return 'blue';
    case 'high':
    case 'high_volume':
      return 'green';
    default:
      return 'default';
  }
};

const getTrendColor = (trend: string) => {
  switch (trend?.toLowerCase()) {
    case 'trending':
      return 'green';
    case 'ranging':
      return 'orange';
    case 'neutral':
      return 'default';
    default:
      return 'default';
  }
};

const SymbolProfileCard: React.FC<SymbolProfileCardProps> = ({ profile, loading }) => {
  if (loading || !profile) {
    return (
      <Card title="Symbol Profile" loading={loading} bordered={false} size="small">
        <Text type="secondary">No data available</Text>
      </Card>
    );
  }

  return (
    <Card
      title={
        <span>
          Symbol Profile{' '}
          <Tooltip title="Market characteristics classification">
            <InfoCircleOutlined style={{ fontSize: 12, opacity: 0.6 }} />
          </Tooltip>
        </span>
      }
      bordered={false}
      size="small"
    >
      <Row gutter={[12, 12]}>
        <Col span={12}>
          <div style={{ marginBottom: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Volatility
            </Text>
            <div>
              <Tag color={getVolatilityColor(profile.volatilityRegime)}>
                {profile.volatilityRegime.replace(/_/g, ' ')}
              </Tag>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {profile.atrPct.toFixed(2)}%
              </Text>
            </div>
          </div>
        </Col>
        <Col span={12}>
          <div style={{ marginBottom: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Direction
            </Text>
            <div>
              <Tag color={getDirectionColor(profile.directionBias)}>
                {profile.directionBias}
              </Tag>
            </div>
          </div>
        </Col>
        <Col span={12}>
          <div style={{ marginBottom: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Volume
            </Text>
            <div>
              <Tag color={getVolumeColor(profile.volumeRegime)}>
                {profile.volumeRegime.replace(/_/g, ' ')}
              </Tag>
            </div>
          </div>
        </Col>
        <Col span={12}>
          <div style={{ marginBottom: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Market Type
            </Text>
            <div>
              <Tag color={getTrendColor(profile.trendingRanging)}>
                {profile.trendingRanging}
              </Tag>
            </div>
          </div>
        </Col>
      </Row>
      <Row gutter={16} style={{ marginTop: 12 }}>
        <Col span={8}>
          <Statistic
            title="ADX"
            value={profile.adx}
            precision={1}
            valueStyle={{ fontSize: 14 }}
          />
        </Col>
        <Col span={8}>
          <Statistic
            title="RSI"
            value={profile.rsi}
            precision={1}
            valueStyle={{ fontSize: 14 }}
          />
        </Col>
        <Col span={8}>
          <Statistic
            title="Trend"
            value={profile.trendStrength}
            precision={1}
            valueStyle={{ fontSize: 14 }}
          />
        </Col>
      </Row>
    </Card>
  );
};

export default SymbolProfileCard;
