import React, { useEffect, useState } from 'react';
import { Card, Row, Col, Badge, Typography, Spin, Alert, Tooltip, Tag } from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ClockCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { api } from '../api';

const { Text } = Typography;

interface SubagentStatus {
  subagent: string;
  health: 'healthy' | 'warning' | 'error';
  active: boolean;
  recommendation: any;
  lastUpdate: string | null;
  score?: number;
  sampleCount?: number;
}

interface SubagentStatusCardsProps {
  sessionId: string;
}

const subagentInfo: Record<string, { name: string; icon: string; description: string }> = {
  risk_governor: {
    name: 'Risk Governor',
    icon: '🛡️',
    description: 'Capital allocation, leverage limits, hedging',
  },
  execution: {
    name: 'Execution',
    icon: '⚡',
    description: 'Order execution strategy (market/sweep/TWAP)',
  },
  predictor: {
    name: 'ML Predictor',
    icon: '🧠',
    description: 'Machine learning price direction prediction',
  },
  sentiment: {
    name: 'Sentiment',
    icon: '📰',
    description: 'News analysis, whale activity, market mood',
  },
  market_quality: {
    name: 'Market Quality',
    icon: '💧',
    description: 'Liquidity, spread, depth assessment',
  },
  entry_timing: {
    name: 'Entry Timing',
    icon: '⏰',
    description: 'Entry optimization (immediate/pullback/confirmation)',
  },
  exit_strategy: {
    name: 'Exit Strategy',
    icon: '🎯',
    description: 'Partial exits, trailing stops, profit locking',
  },
};

const healthColors: Record<string, string> = {
  healthy: '#52c41a',
  warning: '#faad14',
  error: '#ff4d4f',
};

const healthIcons: Record<string, React.ReactNode> = {
  healthy: <CheckCircleOutlined style={{ color: '#52c41a' }} />,
  warning: <ExclamationCircleOutlined style={{ color: '#faad14' }} />,
  error: <ClockCircleOutlined style={{ color: '#ff4d4f' }} />,
};

export default function SubagentStatusCards({ sessionId }: SubagentStatusCardsProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    const fetchSubagentStatus = async () => {
      try {
        setLoading(true);
        // Using learning endpoint since subagents endpoint was removed
        const response = await api.getLearningSession(sessionId);
        
        // Transform learning data into subagent status format
        const subagentStatuses = response.learningStates.map((state: any) => ({
          subagent: state.subagent,
          health: state.sampleCount === 0 ? 'warning' : 'healthy',
          active: state.sampleCount > 0,
          recommendation: state.tuning,
          lastUpdate: state.lastUpdated,
          score: state.score,
          sampleCount: state.sampleCount,
        }));

        setData({ subagents: subagentStatuses });
        setError(null);
      } catch (err: any) {
        setError(err.message || 'Failed to fetch subagent status');
      } finally {
        setLoading(false);
      }
    };

    fetchSubagentStatus();
    const interval = setInterval(fetchSubagentStatus, 30000); // Update every 30 seconds

    return () => clearInterval(interval);
  }, [sessionId]);

  if (loading) {
    return (
      <Card title="Subagent Status" bordered={false}>
        <Spin />
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="Subagent Status" bordered={false}>
        <Alert message="Error" description={error} type="error" showIcon />
      </Card>
    );
  }

  if (!data) {
    return null;
  }

  const { subagents } = data;

  return (
    <div>
      <Row gutter={[16, 16]}>
        {subagents.map((subagent: SubagentStatus) => {
          const info = subagentInfo[subagent.subagent] || {
            name: subagent.subagent,
            icon: '🔧',
            description: 'No description available',
          };
          
          return (
            <Col xs={24} sm={12} md={8} key={subagent.subagent}>
              <Card
                size="small"
                bordered
                style={{
                  borderColor: healthColors[subagent.health],
                  borderWidth: 2,
                }}
                bodyStyle={{ padding: 12 }}
              >
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 20 }}>{info.icon}</span>
                    <Text strong style={{ fontSize: 14 }}>
                      {info.name}
                    </Text>
                  </div>
                  {healthIcons[subagent.health]}
                </div>

                {/* Description */}
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                  {info.description}
                </Text>

                {/* Status Badge */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <Badge
                    status={subagent.active ? 'processing' : 'default'}
                    text={
                      <Text style={{ fontSize: 12 }}>
                        {subagent.active ? 'Active' : 'Inactive'}
                      </Text>
                    }
                  />
                  {subagent.sampleCount !== undefined && (
                    <Tag color={subagent.sampleCount === 0 ? 'default' : 'blue'} style={{ fontSize: 11 }}>
                      {subagent.sampleCount} samples
                    </Tag>
                  )}
                </div>

                {/* Recommendation Summary */}
                {subagent.recommendation && subagent.active && (
                  <div
                    style={{
                      background: 'rgba(30, 41, 59, 0.65)',
                      border: '1px solid rgba(148, 163, 184, 0.22)',
                      padding: 8,
                      borderRadius: 4,
                      fontSize: 12,
                      marginTop: 8,
                      color: '#e2e8f0',
                    }}
                  >
                    {renderRecommendation(subagent.subagent, subagent.recommendation)}
                  </div>
                )}

                {!subagent.active && (
                  <div
                    style={{
                      background: 'rgba(30, 41, 59, 0.65)',
                      border: '1px solid rgba(148, 163, 184, 0.22)',
                      padding: 8,
                      borderRadius: 4,
                      fontSize: 12,
                      marginTop: 8,
                      color: '#94a3b8',
                    }}
                  >
                    No data yet. Will activate after first trades.
                  </div>
                )}

                {/* Last Update */}
                {subagent.lastUpdate && (
                  <Text type="secondary" style={{ fontSize: 11, marginTop: 8, display: 'block' }}>
                    Updated: {new Date(subagent.lastUpdate).toLocaleTimeString()}
                  </Text>
                )}
              </Card>
            </Col>
          );
        })}
      </Row>
    </div>
  );
}

function renderRecommendation(subagent: string, recommendation: any): React.ReactNode {
  if (!recommendation) return <Text type="secondary">No recommendation</Text>;

  switch (subagent) {
    case 'risk_governor':
      return (
        <>
          <div>
            <ThunderboltOutlined /> Leverage: <strong>{recommendation.recommendedMaxLeverage?.toFixed(1)}x</strong>
          </div>
          <div>Position: <strong>{(recommendation.recommendedMaxPositionPct * 100)?.toFixed(0)}%</strong></div>
        </>
      );

    case 'predictor':
      const bias = recommendation.directionBias || 'neutral';
      return (
        <>
          <div>Direction: <Tag color={bias === 'bullish' ? 'green' : bias === 'bearish' ? 'red' : 'default'}>{bias.toUpperCase()}</Tag></div>
          <div>Threshold: <strong>{(recommendation.confidenceThreshold * 100)?.toFixed(0)}%</strong></div>
        </>
      );

    case 'execution':
      return (
        <>
          <div>Strategy: <strong>{recommendation.executionStrategy || 'market'}</strong></div>
          <div>Slippage Tol: <strong>{(recommendation.slippageTolerance * 100)?.toFixed(2)}%</strong></div>
        </>
      );

    case 'sentiment':
      return (
        <>
          <div>News Weight: <strong>{(recommendation.newsWeight * 100)?.toFixed(0)}%</strong></div>
          <div>Whale Weight: <strong>{(recommendation.whaleWeight * 100)?.toFixed(0)}%</strong></div>
        </>
      );

    case 'market_quality':
      return (
        <>
          <div>Min Liquidity: <strong>{(recommendation.minLiquidityScore * 100)?.toFixed(0)}%</strong></div>
          <div>Max Spread: <strong>{(recommendation.maxSpreadPct * 100)?.toFixed(2)}%</strong></div>
        </>
      );

    case 'entry_timing':
      return (
        <>
          <div>Patience: <strong>{(recommendation.patience * 100)?.toFixed(0)}%</strong></div>
          <div>Recommendation: <strong>{recommendation.recommendation}</strong></div>
        </>
      );

    case 'exit_strategy':
      return (
        <>
          <div>Scale-Out: <strong>{recommendation.scaleOutPlan?.length || 4} levels</strong></div>
          <div>Trailing Stop: <strong>{(recommendation.trailingStopDistance * 100)?.toFixed(1)}%</strong></div>
        </>
      );

    default:
      return <Text type="secondary">Active</Text>;
  }
}
