import React, { useEffect, useState } from 'react';
import { Card, Progress, Row, Col, Statistic, Typography, Tag, Spin, Alert } from 'antd';
import { RocketOutlined, CheckCircleOutlined, SyncOutlined } from '@ant-design/icons';
import { api } from '../api';

const { Text } = Typography;

interface SubagentLearning {
  subagent: string;
  confidence: number;
  sampleCount: number;
  score: number;
  tuning: any;
  lastUpdated: string | null;
}

interface LearningProgressProps {
  sessionId: string;
}

const subagentLabels: Record<string, string> = {
  risk_governor: 'Risk Governor',
  execution: 'Execution',
  predictor: 'ML Predictor',
  sentiment: 'Sentiment',
  market_quality: 'Market Quality',
  entry_timing: 'Entry Timing',
  exit_strategy: 'Exit Strategy',
};

const subagentIcons: Record<string, string> = {
  risk_governor: '🛡️',
  execution: '⚡',
  predictor: '🧠',
  sentiment: '📰',
  market_quality: '💧',
  entry_timing: '⏰',
  exit_strategy: '🎯',
};

export default function LearningProgressPanel({ sessionId }: LearningProgressProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    const fetchLearningData = async () => {
      try {
        setLoading(true);
        const response = await api.getLearningSession(sessionId);
        setData(response);
        setError(null);
      } catch (err: any) {
        setError(err.message || 'Failed to fetch learning data');
      } finally {
        setLoading(false);
      }
    };

    fetchLearningData();
    const interval = setInterval(fetchLearningData, 60000); // Update every minute

    return () => clearInterval(interval);
  }, [sessionId]);

  if (loading) {
    return (
      <Card title="Learning Progress" bordered={false}>
        <Spin />
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="Learning Progress" bordered={false}>
        <Alert message="Error" description={error} type="error" showIcon />
      </Card>
    );
  }

  if (!data) {
    return null;
  }

  const { learningStates, performance } = data;
  const avgConfidence = performance.avgConfidence || 0;

  return (
    <Card
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span><RocketOutlined /> Learning Progress</span>
          <Tag color={avgConfidence > 0.75 ? 'green' : avgConfidence > 0.50 ? 'orange' : 'blue'}>
            {performance.totalTrades} trades
          </Tag>
        </div>
      }
      bordered={false}
    >
      {/* Overall Summary */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col span={8}>
          <Statistic
            title="Avg Confidence"
            value={avgConfidence * 100}
            precision={0}
            suffix="%"
            valueStyle={{ color: avgConfidence > 0.75 ? '#3f8600' : avgConfidence > 0.50 ? '#faad14' : '#1890ff' }}
          />
        </Col>
        <Col span={8}>
          <Statistic
            title="Win Rate"
            value={performance.winRate * 100}
            precision={1}
            suffix="%"
            valueStyle={{ color: performance.winRate > 0.50 ? '#3f8600' : '#cf1322' }}
          />
        </Col>
        <Col span={8}>
          <Statistic
            title="Total Trades"
            value={performance.totalTrades}
            prefix={<CheckCircleOutlined />}
          />
        </Col>
      </Row>

      {/* Subagent Progress Bars */}
      <div style={{ marginTop: 16 }}>
        <Text strong style={{ fontSize: 14, marginBottom: 12, display: 'block' }}>
          Subagent Confidence Levels
        </Text>
        {learningStates.map((state: SubagentLearning) => {
          const confidence = state.confidence * 100;
          const isNeutral = state.sampleCount === 0;
          const label = subagentLabels[state.subagent] || state.subagent;
          const icon = subagentIcons[state.subagent] || '🔧';

          return (
            <div key={state.subagent} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={{ fontSize: 13 }}>
                  {icon} {label}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {state.sampleCount}/40 samples
                  {isNeutral && ' (neutral)'}
                </Text>
              </div>
              <Progress
                percent={confidence}
                strokeColor={
                  isNeutral
                    ? '#d9d9d9'
                    : confidence > 75
                    ? '#52c41a'
                    : confidence > 50
                    ? '#faad14'
                    : '#1890ff'
                }
                size="small"
                status={isNeutral ? 'normal' : 'active'}
              />
            </div>
          );
        })}
      </div>

      {/* Learning Status Message */}
      <div style={{ marginTop: 16, padding: 12, background: '#f0f2f5', borderRadius: 4 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {avgConfidence < 0.50 ? (
            <>
              <SyncOutlined spin /> System is learning... Confidence will increase as more trades are executed
              (target: 40 trades for full confidence)
            </>
          ) : avgConfidence < 0.75 ? (
            <>
              📈 Adapting strategy based on {performance.totalTrades} trades. Continue trading to reach optimal
              confidence.
            </>
          ) : (
            <>
              ✅ High confidence achieved! System has learned from {performance.totalTrades} trades and is
              adapting parameters.
            </>
          )}
        </Text>
      </div>
    </Card>
  );
}
