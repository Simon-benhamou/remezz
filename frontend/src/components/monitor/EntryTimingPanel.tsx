import React from 'react';
import { Card, Space, Tag, Typography, Divider, Progress, Row, Col, Statistic, Tooltip, Empty } from 'antd';
import {
  ThunderboltOutlined,
  ClockCircleOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';

const { Text } = Typography;

interface EntryQualityStats {
  immediate: { count: number; avgQuality: number };
  pullback: { count: number; avgQuality: number };
  confirmation: { count: number; avgQuality: number };
}

interface EntryAnalysisData {
  recommendation: 'immediate' | 'wait_pullback' | 'wait_confirmation';
  aggressiveness: number;
  patience: number;
  optimalEntryOffset: number;
  confidence: number;
  reasoning: string;
  entryQualityStats: EntryQualityStats;
}

interface EntryTimingPanelProps {
  sessionId: string;
  analysis: EntryAnalysisData | null;
  hasSignal: boolean;
  loading?: boolean;
}

const RECOMMENDATION_CONFIG = {
  immediate: {
    color: 'green',
    icon: <ThunderboltOutlined />,
    label: 'IMMEDIATE',
    description: 'Enter now at market',
  },
  wait_pullback: {
    color: 'orange',
    icon: <ClockCircleOutlined />,
    label: 'PULLBACK',
    description: 'Wait for price retracement',
  },
  wait_confirmation: {
    color: 'blue',
    icon: <CheckCircleOutlined />,
    label: 'CONFIRMATION',
    description: 'Wait for breakout confirmation',
  },
};

export default function EntryTimingPanel({ 
  sessionId, 
  analysis, 
  hasSignal, 
  loading 
}: EntryTimingPanelProps) {
  if (!hasSignal || !analysis) {
    return (
      <Card title="Entry Timing Analysis" size="small">
        <Empty 
          description="No entry signal" 
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      </Card>
    );
  }

  const config = RECOMMENDATION_CONFIG[analysis.recommendation];
  
  return (
    <Card
      title={
        <Space>
          <ThunderboltOutlined />
          <span>Entry Timing Analysis</span>
        </Space>
      }
      size="small"
      loading={loading}
      style={{ height: '100%' }}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {/* Current Recommendation */}
        <div>
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Text strong style={{ fontSize: 13 }}>Recommendation</Text>
            <Tag 
              color={config.color} 
              icon={config.icon}
              style={{ fontSize: 13 }}
            >
              {config.label}
            </Tag>
          </Space>
          <Text 
            type="secondary" 
            style={{ fontSize: 12, display: 'block', marginTop: 4 }}
          >
            {config.description}
          </Text>
        </div>

        <Divider style={{ margin: 0 }} />

        {/* Metrics */}
        <Row gutter={16}>
          <Col span={12}>
            <div>
              <Text type="secondary" style={{ fontSize: 11 }}>Patience Score</Text>
              <Tooltip title="0 = urgent, 1 = wait for better setup">
                <Progress 
                  percent={analysis.patience * 100} 
                  size="small"
                  strokeColor={
                    analysis.patience > 0.7 ? '#faad14' : 
                    analysis.patience > 0.3 ? '#1890ff' : 
                    'var(--success)'
                  }
                  format={percent => `${(percent || 0).toFixed(0)}%`}
                />
              </Tooltip>
            </div>
          </Col>
          <Col span={12}>
            <div>
              <Text type="secondary" style={{ fontSize: 11 }}>Aggressiveness</Text>
              <Progress 
                percent={analysis.aggressiveness * 100} 
                size="small"
                strokeColor={
                  analysis.aggressiveness > 1.2 ? 'var(--error)' : 
                  analysis.aggressiveness > 0.8 ? 'var(--success)' : 
                  '#faad14'
                }
                format={percent => `${(percent || 0).toFixed(0)}%`}
              />
            </div>
          </Col>
        </Row>

        {/* Entry Offset */}
        {analysis.optimalEntryOffset !== 0 && (
          <div>
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <Text type="secondary" style={{ fontSize: 12 }}>Optimal Entry:</Text>
              <Tag color={analysis.optimalEntryOffset < 0 ? 'red' : 'green'}>
                {analysis.optimalEntryOffset > 0 ? '+' : ''}
                {(analysis.optimalEntryOffset / 100).toFixed(2)}%
              </Tag>
            </Space>
            <Text style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginTop: 4 }}>
              {analysis.optimalEntryOffset < 0 
                ? 'Wait for price to drop before entering'
                : 'Entry above current price recommended'}
            </Text>
          </div>
        )}

        <Divider style={{ margin: 0 }} />

        {/* Confidence */}
        <div>
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>Confidence</Text>
            <Tag color={analysis.confidence > 0.7 ? 'green' : analysis.confidence > 0.5 ? 'orange' : 'red'}>
              {(analysis.confidence * 100).toFixed(0)}%
            </Tag>
          </Space>
          <Text 
            style={{ 
              fontSize: 11, 
              color: 'var(--text-secondary)',
              display: 'block',
              marginTop: 4 
            }}
          >
            {analysis.reasoning}
          </Text>
        </div>

        <Divider style={{ margin: 0 }} />

        {/* Historical Performance */}
        <div>
          <Text strong style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
            Entry Quality (Last 10 Trades)
          </Text>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {Object.entries(analysis.entryQualityStats).map(([type, stats]) => {
              if (stats.count === 0) return null;
              
              const isGood = stats.avgQuality > 0;
              const label = type.replace('_', ' ').toUpperCase();
              
              return (
                <div key={type}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Space size={4}>
                      <Text style={{ fontSize: 11 }}>{label}</Text>
                      <Text type="secondary" style={{ fontSize: 10 }}>
                        ({stats.count} trades)
                      </Text>
                    </Space>
                    <Space size={4}>
                      <Tag 
                        color={isGood ? 'green' : 'red'}
                        style={{ fontSize: 10 }}
                      >
                        {isGood ? '+' : ''}{(stats.avgQuality * 100).toFixed(1)}%
                      </Tag>
                      {isGood ? (
                        <CheckCircleOutlined style={{ color: 'var(--success)', fontSize: 12 }} />
                      ) : (
                        <CloseCircleOutlined style={{ color: 'var(--error)', fontSize: 12 }} />
                      )}
                    </Space>
                  </Space>
                </div>
              );
            })}
          </Space>
          
          {Object.values(analysis.entryQualityStats).every(s => s.count === 0) && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              No historical data yet
            </Text>
          )}
        </div>
      </Space>
    </Card>
  );
}
