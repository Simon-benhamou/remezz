import { Card, Row, Col, Statistic, Progress, Tag, Space, Tooltip, Alert } from 'antd';
import {
  BulbOutlined,
  RiseOutlined,
  FallOutlined,
  MinusOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';

interface PredictorCardProps {
  data: any;
  symbolProfile?: any;
}

export function PredictorCard({ data, symbolProfile }: PredictorCardProps) {
  if (!data) {
    return (
      <Card title={<Space><BulbOutlined /><span>Predictor Analysis</span></Space>} size="small">
        <Alert message="Predictor not available" type="warning" />
      </Card>
    );
  }

  const getDirectionIcon = (direction: string) => {
    if (direction === 'bullish' || direction === 'long') return <RiseOutlined style={{ color: '#52c41a' }} />;
    if (direction === 'bearish' || direction === 'short') return <FallOutlined style={{ color: '#f5222d' }} />;
    return <MinusOutlined style={{ color: '#8c8c8c' }} />;
  };

  const getDirectionColor = (direction: string) => {
    if (direction === 'bullish' || direction === 'long') return 'green';
    if (direction === 'bearish' || direction === 'short') return 'red';
    return 'default';
  };

  const probLong = Math.round((data.probabilities?.long || data.probLong || 0) * 100);
  const probShort = Math.round((data.probabilities?.short || data.probShort || 0) * 100);
  const probNone = Math.round((data.probabilities?.none || data.probNone || 0) * 100);
  const confidence = Math.round((data.confidence || 0) * 100);
  const edge = Math.round((data.edge || 0) * 100);

  const isReliable = data.reliability?.isReliable ?? true;
  const reliabilityRate = Math.round((data.reliability?.reliabilityRate || 1) * 100);

  return (
    <Card
      title={
        <Space>
          <BulbOutlined />
          <span>Predictor Analysis</span>
          {data.available ? (
            <Tag color="green" icon={<CheckCircleOutlined />}>Active</Tag>
          ) : (
            <Tag color="red" icon={<CloseCircleOutlined />}>Unavailable</Tag>
          )}
        </Space>
      }
      size="small"
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {/* Decision & Direction */}
        <Row gutter={16}>
          <Col span={12}>
            <Statistic
              title="Decision"
              value={data.decision || 'none'}
              prefix={getDirectionIcon(data.decision)}
              valueStyle={{ 
                fontSize: '16px', 
                textTransform: 'uppercase',
                color: data.decision === 'long' ? '#52c41a' : data.decision === 'short' ? '#f5222d' : '#8c8c8c'
              }}
            />
          </Col>
          <Col span={12}>
            <Statistic
              title="Direction"
              value={data.direction || 'neutral'}
              prefix={getDirectionIcon(data.direction)}
              valueStyle={{ 
                fontSize: '16px', 
                textTransform: 'uppercase',
                color: data.direction === 'bullish' ? '#52c41a' : data.direction === 'bearish' ? '#f5222d' : '#8c8c8c'
              }}
            />
          </Col>
        </Row>

        {/* Probabilities */}
        <div>
          <div style={{ fontSize: '12px', color: '#8c8c8c', marginBottom: 8 }}>
            <strong>Probabilities</strong>
          </div>
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: '12px', color: '#52c41a' }}>Long</span>
                <span style={{ fontSize: '12px', fontWeight: 'bold' }}>{probLong}%</span>
              </div>
              <Progress percent={probLong} strokeColor="#52c41a" showInfo={false} size="small" />
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: '12px', color: '#f5222d' }}>Short</span>
                <span style={{ fontSize: '12px', fontWeight: 'bold' }}>{probShort}%</span>
              </div>
              <Progress percent={probShort} strokeColor="#f5222d" showInfo={false} size="small" />
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: '12px', color: '#8c8c8c' }}>None</span>
                <span style={{ fontSize: '12px', fontWeight: 'bold' }}>{probNone}%</span>
              </div>
              <Progress percent={probNone} strokeColor="#8c8c8c" showInfo={false} size="small" />
            </div>
          </Space>
        </div>

        {/* Metrics */}
        <Row gutter={16}>
          <Col span={8}>
            <Tooltip title="Model confidence in prediction">
              <Statistic
                title="Confidence"
                value={`${confidence}%`}
                valueStyle={{ fontSize: '14px' }}
              />
            </Tooltip>
          </Col>
          <Col span={8}>
            <Tooltip title="Edge over random (higher is better)">
              <Statistic
                title="Edge"
                value={`${edge}%`}
                valueStyle={{ fontSize: '14px' }}
              />
            </Tooltip>
          </Col>
          <Col span={8}>
            <Tooltip title="Entry weight multiplier">
              <Statistic
                title="Entry Weight"
                value={data.entryWeight?.toFixed(2) || 'N/A'}
                valueStyle={{ fontSize: '14px' }}
              />
            </Tooltip>
          </Col>
        </Row>

        {/* Reliability */}
        {data.reliability && (
          <div style={{ paddingTop: 8, borderTop: '1px solid #f0f0f0' }}>
            <Space size="small">
              <Tag color={isReliable ? 'green' : 'orange'}>
                {isReliable ? 'Reliable' : 'Unreliable'} ({reliabilityRate}%)
              </Tag>
              <span style={{ fontSize: '12px', color: '#8c8c8c' }}>
                {data.reliability.successfulCalls}/{data.reliability.totalCalls} successful
              </span>
              {data.source && (
                <Tag color="blue">{data.source}</Tag>
              )}
            </Space>
          </div>
        )}

        {/* Cooldown */}
        {data.cooldown?.active && (
          <Alert
            message={
              <Space>
                <ClockCircleOutlined />
                <span>Cooldown: {data.cooldown.seconds}s ({data.cooldown.reason})</span>
              </Space>
            }
            type="warning"
            showIcon={false}
            style={{ fontSize: '12px' }}
          />
        )}

        {/* Symbol Profile */}
        {symbolProfile && (
          <div style={{ paddingTop: 8, borderTop: '1px solid #f0f0f0' }}>
            <div style={{ fontSize: '12px', color: '#8c8c8c', marginBottom: 8 }}>
              <strong>Market Context</strong>
            </div>
            <Space wrap>
              <Tag color={symbolProfile.directionBias === 'long' ? 'green' : symbolProfile.directionBias === 'short' ? 'red' : 'default'}>
                {symbolProfile.directionBias || 'neutral'}
              </Tag>
              <Tag>{symbolProfile.trendingRanging || 'N/A'}</Tag>
              <Tag>{symbolProfile.volatilityRegime || 'N/A'} volatility</Tag>
              <Tag>ADX: {symbolProfile.adx?.toFixed(1) || 'N/A'}</Tag>
              <Tag>RSI: {symbolProfile.rsi?.toFixed(1) || 'N/A'}</Tag>
            </Space>
          </div>
        )}
      </Space>
    </Card>
  );
}
