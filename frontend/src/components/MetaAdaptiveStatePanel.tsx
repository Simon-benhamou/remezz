import React from 'react';
import { Card, Tag, Alert, Space, Typography, Row, Col, Statistic, Progress, Tooltip, Badge } from 'antd';
import { 
  CheckCircleOutlined, 
  CloseCircleOutlined, 
  InfoCircleOutlined,
  WarningOutlined,
  ThunderboltOutlined,
  AimOutlined
} from '@ant-design/icons';

const { Text } = Typography;

type MetaAdaptiveDiagnostics = {
  sessionId: string;
  symbol: string;
  symbolProfile: {
    volatilityRegime: string;
    directionBias: string;
    volumeRegime: string;
    trendingRanging: string;
    atrPct: number;
    adx: number;
    rsi: number;
    trendStrength: number;
  };
  predictor: {
    available: boolean;
    decision: 'long' | 'short' | 'none';
    confidence: number;
    probabilities: { long: number; short: number; none: number };
    primaryProbability: number;
    entryWeight: number;
    riskMultiplier: number;
    cooldown: {
      active: boolean;
      reason: string | null;
      seconds: number | null;
    };
  } | null;
  strategy: {
    current: string | null;
    confidence: number | null;
    score: number | null;
  } | null;
  position: {
    side: 'long' | 'short';
    entryPrice: number;
    currentPrice: number;
    rMultiple: number;
    pnlUsd: number;
    pnlPct: number;
    minutesOpen: number;
    stopPrice: number;
    targets: number[];
  } | null;
  market: {
    last: number;
    change24h: number;
    volume24h: number;
    volumeMA: number;
    volumeRatio: number;
  };
  timestamp: number;
};

interface Props {
  diagnostics: MetaAdaptiveDiagnostics | null;
  loading?: boolean;
}

const formatMinutes = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
};

export default function MetaAdaptiveStatePanel({ diagnostics, loading }: Props) {
  if (loading) {
    return <Card title="Agent State" loading />;
  }

  if (!diagnostics) {
    return (
      <Card title="Agent State">
        <Alert 
          type="info" 
          message="No diagnostic data available" 
          description="Agent is initializing or waiting for market data"
        />
      </Card>
    );
  }

  const { strategy, predictor, position, symbolProfile } = diagnostics;
  
  // Determine agent state
  const hasPosition = position !== null;
  const hasCooldown = predictor?.cooldown?.active || false;
  const hasStrategy = strategy?.current !== null;
  const isWaitingForData = symbolProfile?.volatilityRegime === 'waiting_for_data';

  // Status badge
  let statusBadge: React.ReactNode;
  if (isWaitingForData) {
    statusBadge = <Badge status="processing" text="Waiting for market data" />;
  } else if (hasCooldown) {
    statusBadge = <Badge status="error" text="Cooldown Active" />;
  } else if (hasPosition) {
    statusBadge = <Badge status="success" text={`In ${position.side.toUpperCase()} position`} />;
  } else if (hasStrategy) {
    statusBadge = <Badge status="processing" text="Scanning for entry" />;
  } else {
    statusBadge = <Badge status="default" text="Monitoring market" />;
  }

  return (
    <Card 
      title={
        <Space>
          <span>Agent State</span>
          {statusBadge}
        </Space>
      }
      size="small"
    >
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        
        {/* Critical Alerts */}
        {hasCooldown && predictor && (
          <Alert
            type="error"
            icon={<WarningOutlined />}
            message={
              <Space direction="vertical" size={0}>
                <Text strong>AI Predictor Cooldown</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {predictor.cooldown.reason}
                </Text>
                {predictor.cooldown.seconds && (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    Remaining: {Math.floor(predictor.cooldown.seconds / 60)}m {predictor.cooldown.seconds % 60}s
                  </Text>
                )}
              </Space>
            }
            showIcon
          />
        )}

        {/* Position Status */}
        {hasPosition ? (
          <Alert
            type="info"
            icon={<AimOutlined />}
            message={
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Space>
                  <Text strong>Position: {position.side.toUpperCase()}</Text>
                  <Tag color={position.side === 'long' ? 'green' : 'red'}>
                    Entry @ ${position.entryPrice.toFixed(4)}
                  </Tag>
                </Space>
                <Row gutter={16}>
                  <Col span={8}>
                    <Statistic
                      title="P&L"
                      value={position.pnlPct}
                      precision={2}
                      suffix="%"
                      valueStyle={{ 
                        fontSize: 14, 
                        color: position.pnlPct >= 0 ? '#16a34a' : '#dc2626' 
                      }}
                    />
                  </Col>
                  <Col span={8}>
                    <Statistic
                      title="R-Multiple"
                      value={position.rMultiple}
                      precision={2}
                      suffix="R"
                      valueStyle={{ fontSize: 14 }}
                    />
                  </Col>
                  <Col span={8}>
                    <Statistic
                      title="Duration"
                      value={formatMinutes(position.minutesOpen)}
                      valueStyle={{ fontSize: 14 }}
                    />
                  </Col>
                </Row>
                
                {/* Targets Progress */}
                {position.targets && position.targets.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <Text type="secondary" style={{ fontSize: 11 }}>Targets:</Text>
                    <Space size={4} wrap style={{ marginTop: 4 }}>
                      {position.targets.map((target, i) => {
                        const hit = position.side === 'long' 
                          ? position.currentPrice >= target
                          : position.currentPrice <= target;
                        return (
                          <Tag 
                            key={i} 
                            color={hit ? 'success' : 'default'}
                            icon={hit ? <CheckCircleOutlined /> : undefined}
                          >
                            T{i+1}: ${target.toFixed(4)}
                          </Tag>
                        );
                      })}
                    </Space>
                  </div>
                )}
              </Space>
            }
            showIcon
          />
        ) : (
          <Alert
            type="success"
            icon={<InfoCircleOutlined />}
            message={
              <Text>
                No active position - {hasStrategy ? 'Analyzing entry opportunities' : 'Monitoring market conditions'}
              </Text>
            }
            showIcon
          />
        )}

        {/* Strategy Status */}
        {!isWaitingForData && (
          <div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
              Current Strategy
            </Text>
            {hasStrategy && strategy ? (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Space>
                  <Tag color="blue" icon={<ThunderboltOutlined />}>
                    {strategy.current}
                  </Tag>
                  {strategy.confidence !== null && (
                    <Text style={{ fontSize: 12 }}>
                      Confidence: <Text strong>{(strategy.confidence * 100).toFixed(1)}%</Text>
                    </Text>
                  )}
                </Space>
                {strategy.score !== null && (
                  <div>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      Strategy Score
                    </Text>
                    <Progress 
                      percent={strategy.score * 100} 
                      size="small"
                      strokeColor={{
                        '0%': '#ef4444',
                        '50%': '#f59e0b',
                        '100%': '#22c55e',
                      }}
                      format={percent => `${percent?.toFixed(1)}%`}
                    />
                  </div>
                )}
              </Space>
            ) : (
              <Alert
                type="info"
                message="No strategy active - Scanning for opportunities"
                style={{ padding: '8px 12px' }}
              />
            )}
          </div>
        )}

        {/* Predictor Quick View */}
        {predictor && predictor.available && !hasCooldown && (
          <div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
              AI Predictor
            </Text>
            <Space>
              <Tag 
                color={
                  predictor.decision === 'long' ? 'green' : 
                  predictor.decision === 'short' ? 'red' : 
                  'default'
                }
              >
                {predictor.decision.toUpperCase()}
              </Tag>
              <Tooltip title="Model confidence in prediction">
                <Text style={{ fontSize: 12 }}>
                  {(predictor.confidence * 100).toFixed(1)}% confidence
                </Text>
              </Tooltip>
              <Tooltip title="Entry position sizing weight">
                <Text style={{ fontSize: 12 }}>
                  {predictor.entryWeight.toFixed(2)}x weight
                </Text>
              </Tooltip>
            </Space>
          </div>
        )}

        {/* Market Context Quick Stats */}
        {!isWaitingForData && (
          <Row gutter={12}>
            <Col span={8}>
              <Statistic
                title="RSI"
                value={symbolProfile.rsi}
                precision={1}
                valueStyle={{ 
                  fontSize: 14,
                  color: symbolProfile.rsi > 70 ? '#dc2626' : symbolProfile.rsi < 30 ? '#16a34a' : undefined
                }}
              />
            </Col>
            <Col span={8}>
              <Statistic
                title="ADX"
                value={symbolProfile.adx}
                precision={1}
                valueStyle={{ fontSize: 14 }}
              />
            </Col>
            <Col span={8}>
              <Statistic
                title="ATR%"
                value={symbolProfile.atrPct}
                precision={2}
                suffix="%"
                valueStyle={{ fontSize: 14 }}
              />
            </Col>
          </Row>
        )}

      </Space>
    </Card>
  );
}
