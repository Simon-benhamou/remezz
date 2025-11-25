import React from 'react';
import { Card, Row, Col, Progress, Tag, Tooltip, Space, Typography, Divider, Alert } from 'antd';
import {
  RiseOutlined,
  ThunderboltOutlined,
  SwapOutlined,
  RocketOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  StopOutlined,
} from '@ant-design/icons';

const { Text } = Typography;

type ScoringBreakdown = {
  scores: { trend: number; breakout: number; meanReversion: number; momentum: number };
  components: {
    adx: number;
    rsi: number;
    cmf: number;
    volumeRatio: number;
    trendStrength: number;
    compressionScore: number;
    alignmentScore: number;
    emaAlignment: 'bullish' | 'bearish' | 'mixed';
  };
  detections: {
    btcCorrelation: { long: string; short: string } | null;
    flashEvent: string | null;
    rebound: { probability: number; reasons: string[] } | null;
    reversal: { probability: number; reasons: string[] } | null;
  };
  entryBlockers: string[];
  winner: { family: string; score: number; confidence: number; bias: string } | null;
};

interface Props {
  breakdown: ScoringBreakdown | null;
}

const getScoreColor = (score: number): string => {
  if (score >= 0.7) return '#22c55e';
  if (score >= 0.5) return '#f59e0b';
  if (score >= 0.3) return '#fb923c';
  return '#ef4444';
};

const getStrategyIcon = (family: string) => {
  switch (family) {
    case 'trend': return <RiseOutlined />;
    case 'breakout': return <ThunderboltOutlined />;
    case 'mean_reversion': return <SwapOutlined />;
    case 'momentum': return <RocketOutlined />;
    default: return <ThunderboltOutlined />;
  }
};

const getStrategyLabel = (family: string) => {
  switch (family) {
    case 'trend': return 'Trend Following';
    case 'breakout': return 'Squeeze Breakout';
    case 'mean_reversion': return 'Mean Reversion';
    case 'momentum': return 'CMF Momentum';
    default: return family;
  }
};

export default function ScoringBreakdownPanel({ breakdown }: Props) {
  if (!breakdown) {
    return null;
  }

  const { scores, components, detections, entryBlockers, winner } = breakdown;
  
  // Find the highest scoring strategy
  const scoreEntries = [
    { family: 'trend', score: scores.trend },
    { family: 'breakout', score: scores.breakout },
    { family: 'mean_reversion', score: scores.meanReversion },
    { family: 'momentum', score: scores.momentum },
  ].sort((a, b) => b.score - a.score);

  const hasBlockers = entryBlockers.length > 0;

  return (
    <Card 
      title={
        <Space>
          <span>Strategy Scoring</span>
          {winner ? (
            <Tag color="blue" icon={getStrategyIcon(winner.family)}>
              {getStrategyLabel(winner.family)} ({(winner.score * 100).toFixed(0)}%)
            </Tag>
          ) : (
            <Tag color="default">No active signal</Tag>
          )}
        </Space>
      }
      size="small"
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        
        {/* Strategy Scores Comparison */}
        <div>
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
            Strategy Scores (Higher = Better Match)
          </Text>
          {scoreEntries.map(({ family, score }) => (
            <div key={family} style={{ marginBottom: 6 }}>
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Space>
                  {getStrategyIcon(family)}
                  <Text style={{ fontSize: 12 }}>{getStrategyLabel(family)}</Text>
                </Space>
                <Text strong style={{ fontSize: 12, color: getScoreColor(score) }}>
                  {(score * 100).toFixed(1)}%
                </Text>
              </Space>
              <Progress
                percent={score * 100}
                size="small"
                showInfo={false}
                strokeColor={getScoreColor(score)}
                trailColor="#e5e7eb"
              />
            </div>
          ))}
        </div>

        <Divider style={{ margin: '8px 0' }} />

        {/* Key Components */}
        <div>
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
            Key Market Components
          </Text>
          <Row gutter={[8, 8]}>
            <Col span={8}>
              <Tooltip title="Average Directional Index - Trend Strength">
                <div style={{ textAlign: 'center', padding: 4, background: '#f8fafc', borderRadius: 4 }}>
                  <Text type="secondary" style={{ fontSize: 10, display: 'block' }}>ADX</Text>
                  <Text strong style={{ 
                    fontSize: 12, 
                    color: components.adx >= 25 ? '#22c55e' : components.adx >= 20 ? '#f59e0b' : '#94a3b8' 
                  }}>
                    {components.adx.toFixed(1)}
                  </Text>
                </div>
              </Tooltip>
            </Col>
            <Col span={8}>
              <Tooltip title="Chaikin Money Flow - Buy/Sell Pressure">
                <div style={{ textAlign: 'center', padding: 4, background: '#f8fafc', borderRadius: 4 }}>
                  <Text type="secondary" style={{ fontSize: 10, display: 'block' }}>CMF</Text>
                  <Text strong style={{ 
                    fontSize: 12, 
                    color: components.cmf >= 0.1 ? '#22c55e' : components.cmf <= -0.1 ? '#ef4444' : '#94a3b8'
                  }}>
                    {components.cmf.toFixed(3)}
                  </Text>
                </div>
              </Tooltip>
            </Col>
            <Col span={8}>
              <Tooltip title="Volume vs Moving Average">
                <div style={{ textAlign: 'center', padding: 4, background: '#f8fafc', borderRadius: 4 }}>
                  <Text type="secondary" style={{ fontSize: 10, display: 'block' }}>Volume</Text>
                  <Text strong style={{ 
                    fontSize: 12, 
                    color: components.volumeRatio >= 2 ? '#22c55e' : components.volumeRatio >= 1.5 ? '#f59e0b' : '#94a3b8'
                  }}>
                    {components.volumeRatio.toFixed(1)}x
                  </Text>
                </div>
              </Tooltip>
            </Col>
            <Col span={8}>
              <Tooltip title="Trend Strength (0-1)">
                <div style={{ textAlign: 'center', padding: 4, background: '#f8fafc', borderRadius: 4 }}>
                  <Text type="secondary" style={{ fontSize: 10, display: 'block' }}>Trend</Text>
                  <Text strong style={{ fontSize: 12 }}>
                    {(components.trendStrength * 100).toFixed(0)}%
                  </Text>
                </div>
              </Tooltip>
            </Col>
            <Col span={8}>
              <Tooltip title="Squeeze/Compression Detection">
                <div style={{ textAlign: 'center', padding: 4, background: '#f8fafc', borderRadius: 4 }}>
                  <Text type="secondary" style={{ fontSize: 10, display: 'block' }}>Squeeze</Text>
                  <Text strong style={{ 
                    fontSize: 12,
                    color: components.compressionScore >= 0.7 ? '#22c55e' : '#94a3b8'
                  }}>
                    {(components.compressionScore * 100).toFixed(0)}%
                  </Text>
                </div>
              </Tooltip>
            </Col>
            <Col span={8}>
              <Tooltip title="EMA Alignment (Bullish/Bearish/Mixed)">
                <div style={{ textAlign: 'center', padding: 4, background: '#f8fafc', borderRadius: 4 }}>
                  <Text type="secondary" style={{ fontSize: 10, display: 'block' }}>EMA</Text>
                  <Tag 
                    color={
                      components.emaAlignment === 'bullish' ? 'green' : 
                      components.emaAlignment === 'bearish' ? 'red' : 
                      'default'
                    }
                    style={{ fontSize: 10 }}
                  >
                    {components.emaAlignment.toUpperCase()}
                  </Tag>
                </div>
              </Tooltip>
            </Col>
          </Row>
        </div>

        {/* Detections */}
        {(detections.btcCorrelation || detections.flashEvent || detections.rebound || detections.reversal) && (
          <>
            <Divider style={{ margin: '8px 0' }} />
            <div>
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
                Special Detections
              </Text>
              <Space wrap size={4}>
                {detections.btcCorrelation && (
                  <Tooltip title={`Long: ${detections.btcCorrelation.long}, Short: ${detections.btcCorrelation.short}`}>
                    <Tag color="orange" icon={<WarningOutlined />}>BTC Correlation</Tag>
                  </Tooltip>
                )}
                {detections.flashEvent && (
                  <Tag color="red" icon={<WarningOutlined />}>Flash Event: {detections.flashEvent}</Tag>
                )}
                {detections.rebound && (
                  <Tooltip title={detections.rebound.reasons.join(', ')}>
                    <Tag color="cyan" icon={<RiseOutlined />}>
                      Rebound ({(detections.rebound.probability * 100).toFixed(0)}%)
                    </Tag>
                  </Tooltip>
                )}
                {detections.reversal && (
                  <Tooltip title={detections.reversal.reasons.join(', ')}>
                    <Tag color="purple" icon={<SwapOutlined />}>
                      Reversal ({(detections.reversal.probability * 100).toFixed(0)}%)
                    </Tag>
                  </Tooltip>
                )}
              </Space>
            </div>
          </>
        )}

        {/* Entry Blockers */}
        {hasBlockers && (
          <>
            <Divider style={{ margin: '8px 0' }} />
            <Alert
              type="warning"
              icon={<StopOutlined />}
              message={
                <Space direction="vertical" size={4}>
                  <Text strong style={{ fontSize: 12 }}>Entry Blocked</Text>
                  <Space wrap size={4}>
                    {entryBlockers.map((blocker, i) => (
                      <Tag key={i} color="orange" style={{ fontSize: 10 }}>
                        {blocker.replace(/_/g, ' ')}
                      </Tag>
                    ))}
                  </Space>
                </Space>
              }
              style={{ padding: '8px 12px' }}
            />
          </>
        )}

        {/* Winner Summary */}
        {winner && !hasBlockers && (
          <>
            <Divider style={{ margin: '8px 0' }} />
            <Alert
              type="success"
              icon={<CheckCircleOutlined />}
              message={
                <Space>
                  <Text strong style={{ fontSize: 12 }}>
                    Signal: {getStrategyLabel(winner.family)}
                  </Text>
                  <Tag color={winner.bias === 'long' ? 'green' : winner.bias === 'short' ? 'red' : 'blue'}>
                    {winner.bias.toUpperCase()}
                  </Tag>
                  <Text style={{ fontSize: 11 }}>
                    Confidence: {(winner.confidence * 100).toFixed(0)}%
                  </Text>
                </Space>
              }
              style={{ padding: '8px 12px' }}
            />
          </>
        )}

      </Space>
    </Card>
  );
}
