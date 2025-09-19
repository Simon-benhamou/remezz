import React from 'react';
import { Card, Alert, Space, Tag, Badge, Tooltip, Progress, Row, Col } from 'antd';
import { 
  FireOutlined, 
  ThunderboltOutlined, 
  ArrowUpOutlined, 
  ArrowDownOutlined,
  ExclamationCircleOutlined,
  CheckCircleOutlined 
} from '@ant-design/icons';

interface Trigger {
  id: string;
  name: string;
  description: string;
  active: boolean;
  strength: 'weak' | 'medium' | 'strong';
  confidence: number;
  timeframe?: string;
  value?: number;
  threshold?: number;
}

interface MarketTriggersProps {
  triggers: Trigger[];
  style?: React.CSSProperties;
}

export default function MarketTriggersCard({ triggers = [], style }: MarketTriggersProps) {
  const activeTriggers = triggers.filter(t => t.active);
  const strongTriggers = triggers.filter(t => t.active && t.strength === 'strong');
  
  const getStrengthColor = (strength: string) => {
    switch (strength) {
      case 'strong': return '#ef4444';
      case 'medium': return '#f59e0b';
      case 'weak': return '#06b6d4';
      default: return '#6b7280';
    }
  };

  const getStrengthIcon = (strength: string) => {
    switch (strength) {
      case 'strong': return <FireOutlined />;
      case 'medium': return <ThunderboltOutlined />;
      case 'weak': return <ArrowUpOutlined />;
      default: return <ExclamationCircleOutlined />;
    }
  };

  const getTriggerBadge = (trigger: Trigger) => {
    const icon = trigger.active ? <CheckCircleOutlined /> : <ExclamationCircleOutlined />;
    const status = trigger.active ? 'success' : 'default';
    
    return (
      <Badge 
        status={status as any}
        text={
          <Space size={4}>
            {icon}
            <span style={{ fontWeight: 500, fontSize: 12 }}>
              {trigger.name}
            </span>
          </Space>
        }
      />
    );
  };

  return (
    <Card 
      title={
        <Space>
          <span>🎯 Market Triggers</span>
          <Badge 
            count={activeTriggers.length} 
            style={{ backgroundColor: activeTriggers.length > 0 ? '#10b981' : '#9ca3af' }}
          />
        </Space>
      }
      size="small"
      style={style}
      extra={
        <Tooltip title={`${activeTriggers.length} active triggers out of ${triggers.length}`}>
          <Progress 
            type="circle" 
            size={24}
            percent={triggers.length > 0 ? Math.round((activeTriggers.length / triggers.length) * 100) : 0}
            strokeWidth={8}
            strokeColor="#10b981"
            format={() => ''}
          />
        </Tooltip>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        {/* Quick Summary */}
        <Row gutter={[8, 8]} style={{ marginBottom: 8 }}>
          <Col span={8}>
            <div style={{ textAlign: 'center', padding: '8px', background: '#f9fafb', borderRadius: 6 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: '#111827' }}>
                {activeTriggers.length}
              </div>
              <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>
                Active
              </div>
            </div>
          </Col>
          <Col span={8}>
            <div style={{ textAlign: 'center', padding: '8px', background: '#fef2f2', borderRadius: 6 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: '#ef4444' }}>
                {strongTriggers.length}
              </div>
              <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>
                Strong
              </div>
            </div>
          </Col>
          <Col span={8}>
            <div style={{ textAlign: 'center', padding: '8px', background: '#f0f9ff', borderRadius: 6 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: '#2563eb' }}>
                {triggers.length}
              </div>
              <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>
                Total
              </div>
            </div>
          </Col>
        </Row>

        {/* Active Triggers */}
        {activeTriggers.length > 0 ? (
          <div>
            <div style={{ 
              fontSize: 12, 
              fontWeight: 600, 
              color: '#374151', 
              marginBottom: 8,
              textTransform: 'uppercase',
              letterSpacing: '0.025em'
            }}>
              Active Signals
            </div>
            <Space direction="vertical" style={{ width: '100%' }} size={4}>
              {activeTriggers.map(trigger => (
                <Alert
                  key={trigger.id}
                  type={trigger.strength === 'strong' ? 'error' : trigger.strength === 'medium' ? 'warning' : 'info'}
                  message={
                    <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                      <Space size={8}>
                        {getStrengthIcon(trigger.strength)}
                        <span style={{ fontWeight: 500, fontSize: 12 }}>
                          {trigger.name}
                        </span>
                        {trigger.timeframe && (
                          <Tag style={{ fontSize: 9 }}>
                            {trigger.timeframe}
                          </Tag>
                        )}
                      </Space>
                      <Space size={4}>
                        <Tag 
                          color={getStrengthColor(trigger.strength)} 
                          style={{ margin: 0, fontSize: 9, textTransform: 'uppercase' }}
                        >
                          {trigger.strength}
                        </Tag>
                        {trigger.confidence && (
                          <span style={{ fontSize: 10, color: '#6b7280' }}>
                            {trigger.confidence}%
                          </span>
                        )}
                      </Space>
                    </Space>
                  }
                  description={
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                      {trigger.description}
                      {trigger.value && trigger.threshold && (
                        <div style={{ marginTop: 2 }}>
                          <Progress 
                            percent={Math.min((trigger.value / trigger.threshold) * 100, 100)}
                            size="small"
                            strokeColor={getStrengthColor(trigger.strength)}
                            showInfo={false}
                          />
                          <span style={{ fontSize: 9, color: '#9ca3af' }}>
                            {trigger.value.toFixed(2)} / {trigger.threshold.toFixed(2)}
                          </span>
                        </div>
                      )}
                    </div>
                  }
                  showIcon={false}
                  style={{ 
                    margin: 0,
                    padding: '8px 12px',
                    border: '1px solid',
                    borderRadius: 6
                  }}
                />
              ))}
            </Space>
          </div>
        ) : (
          <Alert
            type="info"
            message="No Active Triggers"
            description="Market conditions do not meet entry criteria. Waiting for signals..."
            showIcon
            style={{ fontSize: 12 }}
          />
        )}

        {/* Inactive Triggers (collapsed) */}
        {triggers.length > activeTriggers.length && (
          <details style={{ marginTop: 8 }}>
            <summary style={{ 
              fontSize: 11, 
              color: '#6b7280', 
              cursor: 'pointer',
              userSelect: 'none'
            }}>
              {triggers.length - activeTriggers.length} inactive triggers
            </summary>
            <Space direction="vertical" style={{ width: '100%', marginTop: 4 }} size={2}>
              {triggers.filter(t => !t.active).map(trigger => (
                <div 
                  key={trigger.id}
                  style={{
                    padding: '4px 8px',
                    background: '#f9fafb',
                    borderRadius: 4,
                    fontSize: 11,
                    color: '#6b7280'
                  }}
                >
                  <Space>
                    <span>{trigger.name}</span>
                    <Tag color="default" style={{ fontSize: 9 }}>
                      {trigger.strength}
                    </Tag>
                  </Space>
                </div>
              ))}
            </Space>
          </details>
        )}
      </Space>
    </Card>
  );
}