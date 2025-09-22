import React from 'react';
import { Card, Spin, Button, Collapse, Alert, Tag, Space, Progress, Descriptions } from 'antd';
import { EyeOutlined, ReloadOutlined, WarningOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { api } from '../api';

interface TradingDiagnosticsCollapsibleProps {
  sessionId: string;
  isActive: boolean;
}

export default function TradingDiagnosticsCollapsible({ sessionId, isActive }: TradingDiagnosticsCollapsibleProps) {
  const [diagnostics, setDiagnostics] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);

  const loadDiagnostics = async () => {
    if (!isActive) return;
    
    setLoading(true);
    setError(null);
    try {
      const data = await api.getDiagnostics(sessionId);
      setDiagnostics(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load diagnostics');
    } finally {
      setLoading(false);
    }
  };

  const handleExpand = async (key: string | string[]) => {
    const isExpanding = key.length > 0;
    setExpanded(isExpanding);
    
    // Load diagnostics when expanding for the first time
    if (isExpanding && !diagnostics && !loading) {
      await loadDiagnostics();
    }
  };

  if (!isActive) {
    return (
      <Alert 
        message="Session Inactive" 
        description="Trading diagnostics are only available for active sessions"
        type="info" 
        showIcon 
      />
    );
  }

  const getDiagnosticsStatus = () => {
    if (!diagnostics) return 'unknown';
    
    const signal = diagnostics.tradingSignal || 'neutral';
    const marketCondition = diagnostics.marketTriggers?.overall || 'neutral';
    const tradeVibes = diagnostics.tradeVibes?.overall || 'neutral';
    
    if (signal === 'bullish' || signal === 'bearish') return 'trading';
    if (marketCondition === 'poor' || tradeVibes === 'poor') return 'waiting';
    return 'monitoring';
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'trading': return 'green';
      case 'waiting': return 'orange';
      case 'monitoring': return 'blue';
      default: return 'default';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'trading': return <CheckCircleOutlined />;
      case 'waiting': return <WarningOutlined />;
      case 'monitoring': return <EyeOutlined />;
      default: return <CloseCircleOutlined />;
    }
  };

  const status = getDiagnosticsStatus();

  const items = [{
    key: '1',
    label: (
      <Space>
        <span>Trading Diagnostics</span>
        <Tag color={getStatusColor(status)} icon={getStatusIcon(status)}>
          {status.charAt(0).toUpperCase() + status.slice(1)}
        </Tag>
        {diagnostics && diagnostics.tradingSignal && (
          <Tag color={diagnostics.tradingSignal === 'bullish' ? 'green' : diagnostics.tradingSignal === 'bearish' ? 'red' : 'default'}>
            {diagnostics.tradingSignal.toUpperCase()}
          </Tag>
        )}
      </Space>
    ),
    children: (
      <div>
        {loading && (
          <div style={{ textAlign: 'center', padding: '20px' }}>
            <Spin tip="Loading diagnostics..." />
          </div>
        )}
        
        {error && (
          <Alert 
            message="Error Loading Diagnostics" 
            description={error}
            type="error" 
            showIcon 
            action={
              <Button size="small" onClick={loadDiagnostics}>
                <ReloadOutlined /> Retry
              </Button>
            }
          />
        )}
        
        {diagnostics && !loading && (
          <div>
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              {/* Trading Signal */}
              <Card size="small" title="Trading Signal">
                <Tag 
                  color={diagnostics.tradingSignal === 'bullish' ? 'green' : 
                         diagnostics.tradingSignal === 'bearish' ? 'red' : 'default'}
                  style={{ fontSize: '14px', padding: '4px 8px' }}
                >
                  {diagnostics.tradingSignal?.toUpperCase() || 'NEUTRAL'}
                </Tag>
                {diagnostics.tradingReason && (
                  <div style={{ marginTop: '8px', fontSize: '12px', color: '#666' }}>
                    {diagnostics.tradingReason}
                  </div>
                )}
              </Card>

              {/* Market Triggers */}
              {diagnostics.marketTriggers && (
                <Card size="small" title="Market Conditions">
                  <Descriptions size="small" column={2}>
                    <Descriptions.Item label="Overall">
                      <Tag color={diagnostics.marketTriggers.overall === 'good' ? 'green' : 
                                  diagnostics.marketTriggers.overall === 'poor' ? 'red' : 'orange'}>
                        {diagnostics.marketTriggers.overall?.toUpperCase()}
                      </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="Volatility">
                      {diagnostics.marketTriggers.volatility?.toFixed(2)}%
                    </Descriptions.Item>
                    <Descriptions.Item label="Volume">
                      {diagnostics.marketTriggers.volume24h ? 
                        `$${(diagnostics.marketTriggers.volume24h / 1000000).toFixed(1)}M` : 'N/A'}
                    </Descriptions.Item>
                    <Descriptions.Item label="Trend">
                      <Tag color={diagnostics.marketTriggers.trend > 0 ? 'green' : 
                                  diagnostics.marketTriggers.trend < 0 ? 'red' : 'default'}>
                        {diagnostics.marketTriggers.trend > 0 ? 'BULLISH' : 
                         diagnostics.marketTriggers.trend < 0 ? 'BEARISH' : 'NEUTRAL'}
                      </Tag>
                    </Descriptions.Item>
                  </Descriptions>
                </Card>
              )}

              {/* Trade Vibes */}
              {diagnostics.tradeVibes && (
                <Card size="small" title="Trading Environment">
                  <Descriptions size="small" column={2}>
                    <Descriptions.Item label="Overall">
                      <Tag color={diagnostics.tradeVibes.overall === 'good' ? 'green' : 
                                  diagnostics.tradeVibes.overall === 'poor' ? 'red' : 'orange'}>
                        {diagnostics.tradeVibes.overall?.toUpperCase()}
                      </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="Risk Level">
                      <Progress 
                        percent={Math.round((diagnostics.tradeVibes.riskLevel || 0) * 100)} 
                        size="small" 
                        status={diagnostics.tradeVibes.riskLevel > 0.7 ? 'exception' : 'normal'}
                      />
                    </Descriptions.Item>
                    {diagnostics.tradeVibes.confidence && (
                      <Descriptions.Item label="Confidence">
                        <Progress 
                          percent={Math.round(diagnostics.tradeVibes.confidence * 100)} 
                          size="small" 
                          strokeColor={diagnostics.tradeVibes.confidence > 0.7 ? '#52c41a' : '#faad14'}
                        />
                      </Descriptions.Item>
                    )}
                  </Descriptions>
                  {diagnostics.tradeVibes.reasoning && (
                    <div style={{ marginTop: '8px', fontSize: '12px', color: '#666' }}>
                      <strong>Reasoning:</strong> {diagnostics.tradeVibes.reasoning}
                    </div>
                  )}
                </Card>
              )}

              {/* Refresh Button */}
              <div style={{ textAlign: 'center' }}>
                <Button 
                  size="small" 
                  onClick={loadDiagnostics}
                  icon={<ReloadOutlined />}
                  loading={loading}
                >
                  Refresh Diagnostics
                </Button>
              </div>
            </Space>
          </div>
        )}
      </div>
    )
  }];

  return (
    <Collapse 
      items={items}
      size="small"
      onChange={handleExpand}
      style={{ marginTop: '8px' }}
    />
  );
}