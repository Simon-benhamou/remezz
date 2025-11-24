import React, { useEffect, useState } from 'react';
import { Card, Statistic, Row, Col, Space, Tag, Typography, Tooltip, Progress, Alert, Spin } from 'antd';
import { 
  TrophyOutlined, 
  RiseOutlined, 
  FallOutlined,
  ThunderboltOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { api } from '../api';

const { Text, Title } = Typography;

interface AdaptiveSummary {
  symbol: string;
  volatilityBuckets: {
    high_conf: { trades: number; winRate: number; avgCompatibility: number };
    medium_conf: { trades: number; winRate: number; avgCompatibility: number };
    low_conf: { trades: number; winRate: number; avgCompatibility: number };
  };
  overallRecommendation: string;
}

interface AdaptiveLearningCardProps {
  symbol: string;
  lookbackDays?: number;
}

export default function AdaptiveLearningCard({ 
  symbol, 
  lookbackDays = 30 
}: AdaptiveLearningCardProps) {
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<AdaptiveSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchSummary = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await api.getAdaptiveSummary(symbol, lookbackDays);
        setSummary(data);
      } catch (err: any) {
        console.error('Failed to fetch adaptive summary:', err);
        setError(err?.response?.data?.error || 'Failed to load adaptive learning data');
      } finally {
        setLoading(false);
      }
    };

    if (symbol) {
      fetchSummary();
    }
  }, [symbol, lookbackDays]);

  const getRecommendationColor = (recommendation: string): 'success' | 'info' | 'warning' | 'error' => {
    if (recommendation.includes('✅')) return 'success';
    if (recommendation.includes('⚠️')) return 'warning';
    if (recommendation.includes('❌')) return 'error';
    return 'info';
  };

  const getWinRateColor = (winRate: number) => {
    if (winRate >= 0.60) return '#52c41a'; // Green
    if (winRate >= 0.50) return '#1890ff'; // Blue
    if (winRate >= 0.40) return '#faad14'; // Orange
    return '#ff4d4f'; // Red
  };

  const formatWinRate = (winRate: number) => {
    return (winRate * 100).toFixed(1) + '%';
  };

  if (loading) {
    return (
      <Card 
        title={
          <Space>
            <ThunderboltOutlined />
            <span>Adaptive Learning</span>
          </Space>
        }
        bordered={false}
      >
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <Spin size="large" />
          <div style={{ marginTop: 16, color: '#999' }}>
            Analyzing historical performance...
          </div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card 
        title={
          <Space>
            <ThunderboltOutlined />
            <span>Adaptive Learning</span>
          </Space>
        }
        bordered={false}
      >
        <Alert
          message="Unable to load adaptive learning data"
          description={error}
          type="warning"
          showIcon
        />
      </Card>
    );
  }

  if (!summary) {
    return null;
  }

  const buckets = summary.volatilityBuckets;
  const hasData = 
    buckets.high_conf.trades > 0 || 
    buckets.medium_conf.trades > 0 || 
    buckets.low_conf.trades > 0;

  return (
    <Card
      title={
        <Space>
          <ThunderboltOutlined style={{ color: '#1890ff' }} />
          <span>Adaptive Learning</span>
          <Tooltip title="Performance-based threshold adjustment system. Learns which conditions produce profitable trades.">
            <InfoCircleOutlined style={{ color: '#999', fontSize: 14 }} />
          </Tooltip>
        </Space>
      }
      bordered={false}
      extra={
        <Tag color="purple">
          {lookbackDays} days
        </Tag>
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {/* Overall Recommendation */}
        <Alert
          message={summary.overallRecommendation}
          type={getRecommendationColor(summary.overallRecommendation)}
          showIcon
          icon={
            summary.overallRecommendation.includes('✅') ? <TrophyOutlined /> :
            summary.overallRecommendation.includes('⚠️') ? <InfoCircleOutlined /> :
            <FallOutlined />
          }
        />

        {!hasData ? (
          <Alert
            message="Insufficient Data"
            description="Not enough historical trades to provide adaptive recommendations. System will use default thresholds."
            type="info"
            showIcon
          />
        ) : (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {/* Performance by Confidence Level */}
            <div>
              <Title level={5} style={{ marginBottom: 12 }}>
                Performance by Confidence Level
              </Title>

              {/* High Confidence */}
              {buckets.high_conf.trades > 0 && (
                <Card 
                  size="small" 
                  style={{ marginBottom: 12, background: 'rgba(82, 196, 26, 0.1)', border: '1px solid rgba(82, 196, 26, 0.3)' }}
                >
                  <Row gutter={16} align="middle">
                    <Col span={8}>
                      <Space direction="vertical" size={0}>
                        <Text strong style={{ fontSize: 16 }}>High Confidence</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          ≥ 75% predictor
                        </Text>
                      </Space>
                    </Col>
                    <Col span={8}>
                      <Statistic
                        title="Win Rate"
                        value={formatWinRate(buckets.high_conf.winRate)}
                        valueStyle={{ 
                          color: getWinRateColor(buckets.high_conf.winRate),
                          fontSize: 20
                        }}
                        prefix={
                          buckets.high_conf.winRate >= 0.5 ? 
                          <RiseOutlined /> : 
                          <FallOutlined />
                        }
                      />
                    </Col>
                    <Col span={8}>
                      <Statistic
                        title="Trades"
                        value={buckets.high_conf.trades}
                        valueStyle={{ fontSize: 20 }}
                      />
                    </Col>
                  </Row>
                  <Progress
                    percent={buckets.high_conf.winRate * 100}
                    strokeColor={getWinRateColor(buckets.high_conf.winRate)}
                    showInfo={false}
                    style={{ marginTop: 8 }}
                  />
                </Card>
              )}

              {/* Medium Confidence */}
              {buckets.medium_conf.trades > 0 && (
                <Card 
                  size="small" 
                  style={{ marginBottom: 12, background: 'rgba(24, 144, 255, 0.1)', border: '1px solid rgba(24, 144, 255, 0.3)' }}
                >
                  <Row gutter={16} align="middle">
                    <Col span={8}>
                      <Space direction="vertical" size={0}>
                        <Text strong style={{ fontSize: 16 }}>Medium Confidence</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          55-75% predictor
                        </Text>
                      </Space>
                    </Col>
                    <Col span={8}>
                      <Statistic
                        title="Win Rate"
                        value={formatWinRate(buckets.medium_conf.winRate)}
                        valueStyle={{ 
                          color: getWinRateColor(buckets.medium_conf.winRate),
                          fontSize: 20
                        }}
                        prefix={
                          buckets.medium_conf.winRate >= 0.5 ? 
                          <RiseOutlined /> : 
                          <FallOutlined />
                        }
                      />
                    </Col>
                    <Col span={8}>
                      <Statistic
                        title="Trades"
                        value={buckets.medium_conf.trades}
                        valueStyle={{ fontSize: 20 }}
                      />
                    </Col>
                  </Row>
                  <Progress
                    percent={buckets.medium_conf.winRate * 100}
                    strokeColor={getWinRateColor(buckets.medium_conf.winRate)}
                    showInfo={false}
                    style={{ marginTop: 8 }}
                  />
                </Card>
              )}

              {/* Low Confidence */}
              {buckets.low_conf.trades > 0 && (
                <Card 
                  size="small" 
                  style={{ background: 'rgba(255, 77, 79, 0.1)', border: '1px solid rgba(255, 77, 79, 0.3)' }}
                >
                  <Row gutter={16} align="middle">
                    <Col span={8}>
                      <Space direction="vertical" size={0}>
                        <Text strong style={{ fontSize: 16 }}>Low Confidence</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          &lt; 55% predictor
                        </Text>
                      </Space>
                    </Col>
                    <Col span={8}>
                      <Statistic
                        title="Win Rate"
                        value={formatWinRate(buckets.low_conf.winRate)}
                        valueStyle={{ 
                          color: getWinRateColor(buckets.low_conf.winRate),
                          fontSize: 20
                        }}
                        prefix={
                          buckets.low_conf.winRate >= 0.5 ? 
                          <RiseOutlined /> : 
                          <FallOutlined />
                        }
                      />
                    </Col>
                    <Col span={8}>
                      <Statistic
                        title="Trades"
                        value={buckets.low_conf.trades}
                        valueStyle={{ fontSize: 20 }}
                      />
                    </Col>
                  </Row>
                  <Progress
                    percent={buckets.low_conf.winRate * 100}
                    strokeColor={getWinRateColor(buckets.low_conf.winRate)}
                    showInfo={false}
                    style={{ marginTop: 8 }}
                  />
                </Card>
              )}
            </div>

            {/* Key Insights */}
            <div style={{ 
              padding: 12, 
              background: '#fafafa', 
              borderRadius: 4,
              border: '1px solid #d9d9d9'
            }}>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Text strong style={{ fontSize: 13 }}>💡 Adaptive Insights</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  The system adjusts entry thresholds based on proven performance. 
                  High-confidence trades with good historical win rates can override 
                  strict compatibility filters.
                </Text>
              </Space>
            </div>
          </Space>
        )}
      </Space>
    </Card>
  );
}
