import React from 'react';
import { Card, Tag, Progress, Space, Typography, Divider, Timeline, Button, Tooltip, Badge } from 'antd';
import { RocketOutlined, ClockCircleOutlined, ThunderboltOutlined, HistoryOutlined, ReloadOutlined, SwapOutlined } from '@ant-design/icons';
import { api } from '../api';

const { Text, Title } = Typography;

interface SmartAgentStatusProps {
  sessionId: string;
}

interface SmartAgentStatus {
  isSmartAgent: boolean;
  currentSymbol: string;
  originalSymbol: string;
  config: {
    minHoldDuration: number;
    rescanInterval: number;
    momentumThreshold: number;
    volumeThreshold: number;
  };
  nextRescanAt: string;
  timeUntilRescanMs: number;
  lastSwitchAt: string;
  timeSinceSwitchMs: number;
  minHoldRemainingMs: number;
  canSwitchNow: boolean;
  selectionHistory: Array<{
    timestamp: string;
    symbol: string;
    previousSymbol?: string;
    reason: string;
    momentum: number;
    type: 'initial_selection' | 'auto_switch';
  }>;
  totalSwitches: number;
}

export default function SmartAgentStatusPanel({ sessionId }: SmartAgentStatusProps) {
  const [status, setStatus] = React.useState<SmartAgentStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [lastUpdate, setLastUpdate] = React.useState<Date | null>(null);

  const loadStatus = React.useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.client.get(`/api/agent/sessions/${sessionId}/smart-status`);
      setStatus(response.data);
      setLastUpdate(new Date());
    } catch (error) {
      console.error('Failed to load Smart Agent status:', error);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  React.useEffect(() => {
    loadStatus();
    
    // Auto-refresh every 30 seconds
    const interval = setInterval(loadStatus, 30000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  const formatDuration = (ms: number): string => {
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  const formatTimeLeft = (ms: number): string => {
    if (ms <= 0) return 'Now';
    
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
      return `${minutes}m`;
    }
    return '<1m';
  };

  if (loading) {
    return (
      <Card loading title="Smart Agent Status" />
    );
  }

  if (!status || !status.isSmartAgent) {
    return null; // Don't show panel for non-smart agents
  }

  const holdProgress = Math.min(100, Math.max(0, 
    ((status.timeSinceSwitchMs) / status.config.minHoldDuration) * 100
  ));

  const rescanProgress = Math.min(100, Math.max(0, 
    ((status.config.rescanInterval - status.timeUntilRescanMs) / status.config.rescanInterval) * 100
  ));

  return (
    <Card
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            <RocketOutlined style={{ color: '#722ed1', fontSize: '18px' }} />
            <span style={{ fontWeight: '700' }}>Smart Agent Status</span>
            <Tag color="purple">AUTO</Tag>
          </Space>
          <Space>
            {lastUpdate && (
              <Text type="secondary" style={{ fontSize: '12px' }}>
                Updated: {lastUpdate.toLocaleTimeString()}
              </Text>
            )}
            <Button 
              size="small" 
              icon={<ReloadOutlined />} 
              onClick={loadStatus}
              loading={loading}
            />
          </Space>
        </div>
      }
      style={{ marginBottom: '16px' }}
    >
      {/* Current Symbol & Status */}
      <div style={{
        background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)',
        borderRadius: '10px',
        padding: '16px',
        marginBottom: '16px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div>
            <Text type="secondary" style={{ fontSize: '12px' }}>Current Trading Symbol</Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
              <Text style={{ fontSize: '20px', fontWeight: 'bold', color: '#0369a1' }}>
                {status.currentSymbol}
              </Text>
              {status.currentSymbol !== status.originalSymbol && (
                <Tag color="blue" icon={<SwapOutlined />}>
                  Switched from {status.originalSymbol}
                </Tag>
              )}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <Text type="secondary" style={{ fontSize: '12px' }}>Total Switches</Text>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#0369a1' }}>
              {status.totalSwitches}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '16px' }}>
          <div style={{ flex: 1 }}>
            <Text type="secondary" style={{ fontSize: '11px' }}>Can Switch Now</Text>
            <div>
              <Badge 
                status={status.canSwitchNow ? 'success' : 'warning'} 
                text={
                  <Text style={{ fontSize: '12px', fontWeight: 600 }}>
                    {status.canSwitchNow ? 'Yes' : 'No'}
                  </Text>
                }
              />
            </div>
          </div>
          
          <div style={{ flex: 1 }}>
            <Text type="secondary" style={{ fontSize: '11px' }}>Next Rescan</Text>
            <div>
              <Text style={{ fontSize: '12px', fontWeight: 600 }}>
                {formatTimeLeft(status.timeUntilRescanMs)}
              </Text>
            </div>
          </div>
        </div>
      </div>

      {/* Progress Bars */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <Text style={{ fontSize: '12px', fontWeight: 600 }}>
              <ClockCircleOutlined style={{ marginRight: '4px', color: '#faad14' }} />
              Minimum Hold Progress
            </Text>
            <Text style={{ fontSize: '12px', color: '#666' }}>
              {formatDuration(status.timeSinceSwitchMs)} / {formatDuration(status.config.minHoldDuration)}
            </Text>
          </div>
          <Progress
            percent={holdProgress}
            strokeColor={holdProgress >= 100 ? '#52c41a' : '#faad14'}
            size="small"
            showInfo={false}
          />
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <Text style={{ fontSize: '12px', fontWeight: 600 }}>
              <ThunderboltOutlined style={{ marginRight: '4px', color: '#1890ff' }} />
              Rescan Countdown
            </Text>
            <Text style={{ fontSize: '12px', color: '#666' }}>
              {formatTimeLeft(status.timeUntilRescanMs)} remaining
            </Text>
          </div>
          <Progress
            percent={rescanProgress}
            strokeColor="#1890ff"
            size="small"
            showInfo={false}
          />
        </div>
      </div>

      {/* Configuration */}
      <div style={{ marginBottom: '16px' }}>
        <Title level={5} style={{ margin: 0, marginBottom: '8px', fontSize: '14px' }}>
          Smart Configuration
        </Title>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: '12px' }}>
          <div>
            <Text type="secondary">Min Hold Duration:</Text>
            <div style={{ fontWeight: 600 }}>{formatDuration(status.config.minHoldDuration)}</div>
          </div>
          <div>
            <Text type="secondary">Rescan Interval:</Text>
            <div style={{ fontWeight: 600 }}>{formatDuration(status.config.rescanInterval)}</div>
          </div>
          <div>
            <Text type="secondary">Momentum Threshold:</Text>
            <div style={{ fontWeight: 600 }}>{status.config.momentumThreshold}/10</div>
          </div>
          <div>
            <Text type="secondary">Volume Threshold:</Text>
            <div style={{ fontWeight: 600 }}>${(status.config.volumeThreshold / 1000000).toFixed(1)}M</div>
          </div>
        </div>
      </div>

      {/* Selection History */}
      {status.selectionHistory.length > 0 && (
        <>
          <Divider />
          <div>
            <Title level={5} style={{ margin: 0, marginBottom: '12px', fontSize: '14px' }}>
              <HistoryOutlined style={{ marginRight: '6px', color: '#722ed1' }} />
              Recent Symbol Selections
            </Title>
            <Timeline
              items={status.selectionHistory.map((item, index) => ({
                color: item.type === 'initial_selection' ? '#52c41a' : '#1890ff',
                children: (
                  <div style={{ fontSize: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text strong style={{ fontSize: '13px' }}>
                        {item.previousSymbol ? (
                          <span>{item.previousSymbol} → <strong style={{ color: '#1890ff' }}>{item.symbol}</strong></span>
                        ) : (
                          <span><strong style={{ color: '#52c41a' }}>{item.symbol}</strong> (Initial)</span>
                        )}
                      </Text>
                      <Tag color={item.type === 'initial_selection' ? 'green' : 'blue'}>
                        {item.type === 'initial_selection' ? 'Initial' : 'Auto Switch'}
                      </Tag>
                    </div>
                    <div style={{ marginTop: '4px', color: '#666' }}>
                      {item.reason}
                    </div>
                    <div style={{ marginTop: '2px', fontSize: '11px', color: '#999' }}>
                      {new Date(item.timestamp).toLocaleString()}
                    </div>
                  </div>
                )
              }))}
            />
          </div>
        </>
      )}

      {/* Footer */}
      <div style={{
        marginTop: '16px',
        padding: '8px',
        background: '#f8fafc',
        borderRadius: '6px',
        fontSize: '11px',
        color: '#64748b',
        textAlign: 'center'
      }}>
        💡 Smart Agent automatically monitors market conditions and switches to high-momentum cryptocurrencies every {formatDuration(status.config.rescanInterval)} or when trades complete.
      </div>
    </Card>
  );
}