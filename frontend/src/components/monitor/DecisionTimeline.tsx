import React from 'react';
import { Card, Timeline, Tag, Typography, Space, Tooltip, Empty } from 'antd';
import {
  SearchOutlined,
  ThunderboltOutlined,
  ClockCircleOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';

const { Text, Title } = Typography;

// Simple time ago function
function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

interface DecisionTimelineProps {
  sessionId: string;
  decisions: any[];
  loading?: boolean;
}

const PHASE_ICONS: Record<string, React.ReactNode> = {
  SCANNING: <SearchOutlined style={{ color: '#1890ff' }} />,
  EVALUATING: <ExclamationCircleOutlined style={{ color: '#faad14' }} />,
  WAITING: <ClockCircleOutlined style={{ color: '#8c8c8c' }} />,
  ENTERED: <CheckCircleOutlined style={{ color: '#52c41a' }} />,
  EXITED: <CheckCircleOutlined style={{ color: '#52c41a' }} />,
  FAILED: <CloseCircleOutlined style={{ color: '#ff4d4f' }} />,
};

const PHASE_COLORS: Record<string, string> = {
  SCANNING: 'blue',
  EVALUATING: 'orange',
  WAITING: 'default',
  ENTERED: 'green',
  EXITED: 'green',
  FAILED: 'red',
};

export default function DecisionTimeline({ sessionId, decisions, loading }: DecisionTimelineProps) {
  if (!decisions || decisions.length === 0) {
    return (
      <Card title="Decision Timeline" size="small">
        <Empty 
          description="No decisions yet" 
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      </Card>
    );
  }

  return (
    <Card 
      title={
        <Space>
          <ThunderboltOutlined />
          <span>Decision Timeline</span>
          <Tag color="blue">{decisions.length} decisions</Tag>
        </Space>
      }
      size="small"
      loading={loading}
      style={{ height: '100%', overflow: 'auto' }}
    >
      <Timeline mode="left">
        {decisions.map((decision, idx) => {
          const isRecent = idx < 3;
          const timestamp = new Date(decision.timestamp);
          
          return (
            <Timeline.Item
              key={decision.id}
              dot={PHASE_ICONS[decision.phase] || <SearchOutlined />}
              color={PHASE_COLORS[decision.phase]}
            >
              <div style={{ marginBottom: 12 }}>
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  {/* Header */}
                  <Space>
                    <Tag color={PHASE_COLORS[decision.phase]}>
                      {decision.phase}
                    </Tag>
                    <Text strong>{decision.action}</Text>
                    <Tooltip title={timestamp.toLocaleString()}>
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {timeAgo(timestamp)}
                      </Text>
                    </Tooltip>
                  </Space>
                  
                  {/* Confidence */}
                  {decision.confidence && (
                    <Space size={4}>
                      <Text type="secondary" style={{ fontSize: 12 }}>Confidence:</Text>
                      <Tag color={decision.confidence > 0.7 ? 'green' : decision.confidence > 0.5 ? 'orange' : 'red'}>
                        {(decision.confidence * 100).toFixed(0)}%
                      </Tag>
                    </Space>
                  )}
                  
                  {/* Reasoning */}
                  {decision.reasoning && (
                    <Text 
                      style={{ 
                        fontSize: 12, 
                        color: '#595959',
                        display: 'block',
                        marginTop: 4,
                        paddingLeft: 8,
                        borderLeft: '2px solid #d9d9d9'
                      }}
                    >
                      {decision.reasoning}
                    </Text>
                  )}
                  
                  {/* Duration */}
                  {decision.duration && (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      Duration: {(decision.duration / 1000).toFixed(1)}s
                    </Text>
                  )}
                  
                  {/* Payload preview (collapsed for older decisions) */}
                  {isRecent && decision.payload && (
                    <details style={{ fontSize: 11, color: '#8c8c8c', marginTop: 4 }}>
                      <summary style={{ cursor: 'pointer' }}>Details</summary>
                      <pre style={{ 
                        fontSize: 10, 
                        background: '#fafafa', 
                        padding: 8, 
                        borderRadius: 4,
                        marginTop: 4,
                        maxHeight: 100,
                        overflow: 'auto'
                      }}>
                        {JSON.stringify(decision.payload, null, 2)}
                      </pre>
                    </details>
                  )}
                </Space>
              </div>
            </Timeline.Item>
          );
        })}
      </Timeline>
    </Card>
  );
}
