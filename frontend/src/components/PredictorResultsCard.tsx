import React from 'react';
import { Card, Tag, Progress, Row, Col, Typography, Tooltip, Badge } from 'antd';
import { InfoCircleOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';

const { Text, Title } = Typography;

export type PredictorResult = {
  available: boolean;
  decision: 'long' | 'short' | 'none';
  confidence: number;
  probabilities: {
    long: number;
    short: number;
    none: number;
  };
  primaryProbability: number;
  entryWeight: number;
  riskMultiplier: number;
  cooldown: {
    active: boolean;
    reason: string | null;
    seconds: number | null;
  };
} | null;

interface PredictorResultsCardProps {
  predictor: PredictorResult;
  loading?: boolean;
}

const getDecisionColor = (decision: string) => {
  switch (decision) {
    case 'long':
      return 'green';
    case 'short':
      return 'red';
    case 'none':
      return 'default';
    default:
      return 'default';
  }
};

const getConfidenceColor = (confidence: number) => {
  if (confidence >= 0.7) return '#16a34a';
  if (confidence >= 0.5) return '#ea580c';
  return '#dc2626';
};

const PredictorResultsCard: React.FC<PredictorResultsCardProps> = ({ predictor, loading }) => {
  if (loading) {
    return <Card title="AI Predictor" loading={loading} bordered={false} size="small" />;
  }

  if (!predictor || !predictor.available) {
    return (
      <Card
        title={
          <span>
            AI Predictor{' '}
            <Tooltip title="ML model predictions for market direction">
              <InfoCircleOutlined style={{ fontSize: 12, opacity: 0.6 }} />
            </Tooltip>
          </span>
        }
        bordered={false}
        size="small"
      >
        <Text type="secondary">No predictor data available</Text>
      </Card>
    );
  }

  return (
    <Card
      title={
        <span>
          AI Predictor{' '}
          <Badge
            status={predictor.cooldown.active ? 'error' : 'success'}
            text={predictor.cooldown.active ? 'Cooldown' : 'Active'}
          />
          <Tooltip title="ML model predictions for market direction">
            <InfoCircleOutlined style={{ fontSize: 12, opacity: 0.6, marginLeft: 8 }} />
          </Tooltip>
        </span>
      }
      bordered={false}
      size="small"
    >
      {/* Decision */}
      <div style={{ marginBottom: 16 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Decision
        </Text>
        <div style={{ marginTop: 4 }}>
          <Tag color={getDecisionColor(predictor.decision)} style={{ fontSize: 14, padding: '4px 12px' }}>
            {predictor.decision.toUpperCase()}
          </Tag>
          <Text style={{ fontSize: 13, marginLeft: 8 }}>
            {predictor.primaryProbability > 0 ? `${(predictor.primaryProbability * 100).toFixed(1)}%` : '—'}
          </Text>
        </div>
      </div>

      {/* Confidence Gauge */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Confidence
          </Text>
          <Text strong style={{ fontSize: 13 }}>
            {(predictor.confidence * 100).toFixed(1)}%
          </Text>
        </div>
        <Progress
          percent={predictor.confidence * 100}
          strokeColor={getConfidenceColor(predictor.confidence)}
          showInfo={false}
          size="small"
          style={{ marginTop: 4 }}
        />
      </div>

      {/* Probabilities Bar Chart */}
      <div style={{ marginBottom: 12 }}>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
          Probabilities
        </Text>
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
            <Text style={{ fontSize: 11 }}>LONG</Text>
            <Text style={{ fontSize: 11 }}>{(predictor.probabilities.long * 100).toFixed(1)}%</Text>
          </div>
          <Progress
            percent={predictor.probabilities.long * 100}
            strokeColor="#16a34a"
            showInfo={false}
            size="small"
          />
        </div>
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
            <Text style={{ fontSize: 11 }}>SHORT</Text>
            <Text style={{ fontSize: 11 }}>{(predictor.probabilities.short * 100).toFixed(1)}%</Text>
          </div>
          <Progress
            percent={predictor.probabilities.short * 100}
            strokeColor="#dc2626"
            showInfo={false}
            size="small"
          />
        </div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
            <Text style={{ fontSize: 11 }}>NONE</Text>
            <Text style={{ fontSize: 11 }}>{(predictor.probabilities.none * 100).toFixed(1)}%</Text>
          </div>
          <Progress
            percent={predictor.probabilities.none * 100}
            strokeColor="#d1d5db"
            showInfo={false}
            size="small"
          />
        </div>
      </div>

      {/* Entry Weight & Risk Multiplier */}
      <Row gutter={12} style={{ marginTop: 12 }}>
        <Col span={12}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            Entry Weight
          </Text>
          <div>
            <Text strong style={{ fontSize: 13 }}>
              {predictor.entryWeight.toFixed(2)}
            </Text>
          </div>
        </Col>
        <Col span={12}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            Risk Multiplier
          </Text>
          <div>
            <Text strong style={{ fontSize: 13 }}>
              {predictor.riskMultiplier.toFixed(2)}x
            </Text>
          </div>
        </Col>
      </Row>

      {/* Cooldown Status */}
      {predictor.cooldown.active && (
        <div style={{ marginTop: 12, padding: 8, background: '#fef2f2', borderRadius: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <CloseCircleOutlined style={{ color: '#dc2626' }} />
            <Text type="danger" style={{ fontSize: 12 }}>
              Cooldown: {predictor.cooldown.reason}
            </Text>
          </div>
          {predictor.cooldown.seconds && (
            <Text type="secondary" style={{ fontSize: 11, marginLeft: 22 }}>
              {Math.floor(predictor.cooldown.seconds / 60)}m {predictor.cooldown.seconds % 60}s remaining
            </Text>
          )}
        </div>
      )}
    </Card>
  );
};

export default PredictorResultsCard;
