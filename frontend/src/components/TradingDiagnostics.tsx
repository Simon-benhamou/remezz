import React from 'react';
import { Card, Space, Tag, Tooltip, Progress, Collapse, Typography } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { api } from '../api';

const { Text } = Typography;

type Props = {
  sessionId?: string;
  refreshTrigger?: any; // to force refresh when agent state changes
};

export default function TradingDiagnostics({ sessionId, refreshTrigger }: Props) {
  const [diagnostics, setDiagnostics] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);

  const loadDiagnostics = async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const result = await fetch(`/api/agent/sessions/${sessionId}/diagnostics`).then(r => r.json());
      setDiagnostics(result);
    } catch (err) {
      console.error('Failed to load diagnostics:', err);
      setDiagnostics({ error: 'Failed to load diagnostics' });
    }
    setLoading(false);
  };

  React.useEffect(() => {
    loadDiagnostics();
  }, [sessionId, refreshTrigger]);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'PASS': return <CheckCircleOutlined style={{ color: '#52c41a' }} />;
      case 'FAIL': return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />;
      case 'REJECT': return <ExclamationCircleOutlined style={{ color: '#ff7a00' }} />;
      case 'PARTIAL': return <InfoCircleOutlined style={{ color: '#1890ff' }} />;
      default: return <InfoCircleOutlined style={{ color: '#d9d9d9' }} />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'PASS': return 'success';
      case 'FAIL': return 'error';
      case 'REJECT': return 'warning';
      case 'PARTIAL': return 'processing';
      default: return 'default';
    }
  };

  if (!sessionId) {
    return (
      <Card size="small" title="Trading Diagnostics">
        <Text type="secondary">No active session</Text>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card size="small" title="Trading Diagnostics" loading>
        <Text type="secondary">Loading diagnostics...</Text>
      </Card>
    );
  }

  if (!diagnostics || diagnostics.error) {
    return (
      <Card size="small" title="Trading Diagnostics">
        <Text type="danger">{diagnostics?.error || 'No diagnostics available'}</Text>
      </Card>
    );
  }

  const { canTrade, reason, checks, summary } = diagnostics;

  const basicChecks = [
    { key: 'hasPosition', label: 'No Position', check: checks.hasPosition },
    { key: 'isArmed', label: 'Agent Armed', check: checks.isArmed },
    { key: 'isEntering', label: 'Not Entering', check: checks.isEntering },
    { key: 'dailyTradeLimit', label: 'Daily Trade Limit', check: checks.dailyTradeLimit },
    { key: 'consecutiveStopsLimit', label: 'Consecutive Stops', check: checks.consecutiveStopsLimit },
    { key: 'inEntryZone', label: 'In Entry Zone', check: checks.inEntryZone },
    { key: 'momentumGates', label: 'Momentum Gates', check: checks.momentumGates },
  ];

  const qualityFilters = checks.qualityFilters ? [
    { key: 'trendAlignment', label: 'Trend Alignment', check: checks.qualityFilters.trendAlignment },
    { key: 'momentum', label: 'ADX Momentum', check: checks.qualityFilters.momentum },
    { key: 'rsiPosition', label: 'RSI Position', check: checks.qualityFilters.rsiPosition },
    { key: 'volatility', label: 'Volatility (ATR)', check: checks.qualityFilters.volatility },
    { key: 'volume', label: 'Volume Confirmation', check: checks.qualityFilters.volume },
  ] : [];

  const totalQualityPoints = qualityFilters.reduce((sum, f) => sum + (f.check?.points || 0), 0);

  return (
    <Card 
      size="small" 
      title={
        <Space>
          <span>Trading Diagnostics</span>
          {getStatusIcon(canTrade ? 'PASS' : 'FAIL')}
          <Tag color={canTrade ? 'success' : 'error'}>
            {canTrade ? 'READY TO TRADE' : 'BLOCKED'}
          </Tag>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {/* Summary */}
        <div>
          <Text strong>{reason}</Text>
          {summary && (
            <div style={{ marginTop: 4, fontSize: 12, color: '#666' }}>
              {summary.passed}/{summary.totalChecks} checks passed
              {summary.rejected > 0 && <span style={{ color: '#ff7a00' }}>, {summary.rejected} rejected</span>}
            </div>
          )}
        </div>

        {/* Basic Checks */}
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {basicChecks.map(({ key, label, check }) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Space size="small">
                {getStatusIcon(check?.status)}
                <span style={{ fontSize: 13 }}>{label}</span>
              </Space>
              <Tooltip title={check?.reason}>
                <Tag color={getStatusColor(check?.status)}>
                  {check?.status}
                </Tag>
              </Tooltip>
            </div>
          ))}
        </Space>

        {/* Quality Score */}
        {checks.qualityScore && (
          <Card size="small" style={{ backgroundColor: '#fafafa' }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Space size="small">
                  {getStatusIcon(checks.qualityScore.status)}
                  <Text strong>Quality Score</Text>
                </Space>
                <Tag color={getStatusColor(checks.qualityScore.status)}>
                  {checks.qualityScore.current}/{checks.qualityScore.required}
                </Tag>
              </div>
              
              <Progress 
                percent={Math.min(100, (checks.qualityScore.current / checks.qualityScore.required) * 100)}
                size="small"
                status={checks.qualityScore.status === 'PASS' ? 'success' : 'exception'}
                showInfo={false}
              />
              
              <Text type="secondary" style={{ fontSize: 11 }}>
                {checks.qualityScore.reason}
              </Text>

              {/* Quality Breakdown */}
              <Collapse size="small">
                <Collapse.Panel header="Quality Breakdown" key="breakdown">
                  <Space direction="vertical" size="small" style={{ width: '100%' }}>
                    {qualityFilters.map(({ key, label, check }) => (
                      <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Space size="small">
                          {getStatusIcon(check?.status)}
                          <span style={{ fontSize: 12 }}>{label}</span>
                        </Space>
                        <Space size="small">
                          <Text style={{ fontSize: 11 }}>+{check?.points || 0}</Text>
                          <Tooltip title={check?.reason}>
                            <Tag color={getStatusColor(check?.status)}>
                              {check?.status}
                            </Tag>
                          </Tooltip>
                        </Space>
                      </div>
                    ))}
                    
                    {checks.qualityScore.breakdown && (
                      <div style={{ marginTop: 8, padding: 8, backgroundColor: '#f0f0f0', borderRadius: 4 }}>
                        <Text style={{ fontSize: 11, color: '#666' }}>
                          Base: {checks.qualityScore.breakdown.baseRequired}
                          {checks.qualityScore.breakdown.learningAdjustment !== 0 && (
                            <> | Learning: {checks.qualityScore.breakdown.learningAdjustment > 0 ? '+' : ''}{checks.qualityScore.breakdown.learningAdjustment}</>
                          )}
                          {checks.qualityScore.breakdown.performanceAdjustment !== 0 && (
                            <> | Performance: {checks.qualityScore.breakdown.performanceAdjustment > 0 ? '+' : ''}{checks.qualityScore.breakdown.performanceAdjustment}</>
                          )}
                          {' '}= {checks.qualityScore.breakdown.final}
                        </Text>
                      </div>
                    )}
                  </Space>
                </Collapse.Panel>
              </Collapse>
            </Space>
          </Card>
        )}
      </Space>
    </Card>
  );
}