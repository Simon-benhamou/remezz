import React from 'react';
import { Card, Progress, Space, Tag, Typography, Divider, Row, Col, Statistic, Tooltip, Empty } from 'antd';
import {
  RiseOutlined,
  FallOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DollarOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';

const { Text, Title } = Typography;

interface ExitTarget {
  rMultiple: number;
  exitPct: number;
  targetPrice: number;
  reached: boolean;
}

interface TrailingStop {
  active: boolean;
  activationR: number;
  distance: number;
  price: number | null;
}

interface Progress {
  percentClosed: number;
  realizedPnl: number;
  remainingQty: number;
}

interface ExitStrategyData {
  currentR: number;
  targets: ExitTarget[];
  trailingStop: TrailingStop;
  progress: Progress;
  strategy: {
    confidence: number;
    reason: string;
  };
}

interface ExitStrategyPanelProps {
  sessionId: string;
  exitPlan: ExitStrategyData | null;
  hasPosition: boolean;
  loading?: boolean;
}

export default function ExitStrategyPanel({ 
  sessionId, 
  exitPlan, 
  hasPosition, 
  loading 
}: ExitStrategyPanelProps) {
  if (!hasPosition || !exitPlan) {
    return (
      <Card title="Exit Strategy" size="small">
        <Empty 
          description="No active position" 
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      </Card>
    );
  }

  const { currentR, targets, trailingStop, progress, strategy } = exitPlan;
  
  // Find next target
  const nextTarget = targets.find(t => !t.reached);
  const reachedTargets = targets.filter(t => t.reached).length;
  
  // Calculate overall progress
  const targetProgress = (reachedTargets / targets.length) * 100;

  return (
    <Card
      title={
        <Space>
          <ThunderboltOutlined />
          <span>Exit Strategy</span>
          <Tag color={currentR > 0 ? 'green' : 'red'}>
            {currentR.toFixed(2)}R
          </Tag>
        </Space>
      }
      size="small"
      loading={loading}
      style={{ height: '100%' }}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {/* Current Progress */}
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>Position Closed</Text>
          <Progress 
            percent={progress.percentClosed} 
            status={progress.percentClosed === 100 ? 'success' : 'active'}
            strokeColor={progress.percentClosed > 0 ? '#52c41a' : '#1890ff'}
          />
          <Row gutter={8} style={{ marginTop: 8 }}>
            <Col span={12}>
              <Statistic
                title="Realized PnL"
                value={progress.realizedPnl}
                precision={2}
                prefix="$"
                valueStyle={{ 
                  fontSize: 16,
                  color: progress.realizedPnl >= 0 ? '#3f8600' : '#cf1322' 
                }}
              />
            </Col>
            <Col span={12}>
              <Statistic
                title="Remaining"
                value={progress.remainingQty}
                precision={2}
                valueStyle={{ fontSize: 16 }}
              />
            </Col>
          </Row>
        </div>

        <Divider style={{ margin: 0 }} />

        {/* Scale-Out Plan */}
        <div>
          <Text strong style={{ fontSize: 13 }}>Scale-Out Targets</Text>
          <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
            {targets.map((target, idx) => (
              <div 
                key={idx}
                style={{
                  padding: '8px 12px',
                  background: target.reached ? '#f6ffed' : '#fafafa',
                  border: `1px solid ${target.reached ? '#b7eb8f' : '#d9d9d9'}`,
                  borderRadius: 4,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <Space>
                  {target.reached ? (
                    <CheckCircleOutlined style={{ color: '#52c41a' }} />
                  ) : (
                    <ClockCircleOutlined style={{ color: '#8c8c8c' }} />
                  )}
                  <Text strong={!target.reached}>
                    {(target.exitPct * 100).toFixed(0)}% @ ${target.targetPrice.toFixed(2)}
                  </Text>
                </Space>
                <Space>
                  <Tag color={target.reached ? 'green' : 'default'}>
                    {target.rMultiple.toFixed(1)}R
                  </Tag>
                  {idx === reachedTargets && !target.reached && (
                    <Tag color="blue">NEXT</Tag>
                  )}
                </Space>
              </div>
            ))}
          </Space>
        </div>

        <Divider style={{ margin: 0 }} />

        {/* Trailing Stop */}
        <div>
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Text strong style={{ fontSize: 13 }}>Trailing Stop</Text>
            <Tag color={trailingStop.active ? 'green' : 'orange'}>
              {trailingStop.active ? 'ACTIVE' : 'WAITING'}
            </Tag>
          </Space>
          
          <div style={{ marginTop: 8 }}>
            {trailingStop.active ? (
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>Stop Price:</Text>
                  <Text strong>${trailingStop.price?.toFixed(2) || 'N/A'}</Text>
                </Space>
                <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>Distance:</Text>
                  <Text>-${trailingStop.distance.toFixed(2)}</Text>
                </Space>
              </Space>
            ) : (
              <Tooltip title={`Will activate at ${trailingStop.activationR.toFixed(1)}R`}>
                <Progress 
                  percent={(currentR / trailingStop.activationR) * 100} 
                  size="small"
                  status="normal"
                  format={() => `${trailingStop.activationR.toFixed(1)}R target`}
                />
              </Tooltip>
            )}
          </div>
        </div>

        <Divider style={{ margin: 0 }} />

        {/* Strategy Info */}
        <div>
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Text type="secondary" style={{ fontSize: 11 }}>Confidence:</Text>
            <Tag color={strategy.confidence > 0.7 ? 'green' : 'orange'}>
              {(strategy.confidence * 100).toFixed(0)}%
            </Tag>
          </Space>
          <Text 
            style={{ 
              fontSize: 11, 
              color: '#8c8c8c',
              display: 'block',
              marginTop: 4 
            }}
          >
            {strategy.reason}
          </Text>
        </div>
      </Space>
    </Card>
  );
}
