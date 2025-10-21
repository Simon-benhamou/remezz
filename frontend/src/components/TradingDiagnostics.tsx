import React from 'react';
import { Card, Space, Tag, Tooltip, Progress, Collapse, Typography } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined, InfoCircleOutlined } from '../icons';
import { api } from '../api';
import { formatDiagnosticReason } from '../utils/diagnostics';

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
      const result = await api.getDiagnostics(sessionId);
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

  const renderReason = (reason?: string) => {
    const formatted = formatDiagnosticReason(reason);
    if (!formatted) {
      return <Text type="secondary">No reason provided</Text>;
    }

    return (
      <pre
        style={{
          margin: 0,
          whiteSpace: 'pre-wrap',
          fontFamily: 'inherit',
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        {formatted}
      </pre>
    );
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

  // Safe access to diagnostics properties with fallbacks
  const canTrade = diagnostics.canTrade || false;
  const reason = diagnostics.reason || 'Unknown reason';
  const checks = diagnostics.checks || {};
  const summary = diagnostics.summary || {};

  const basicChecks = [
    { key: 'hasPosition', label: 'No Position', check: checks.hasPosition || { status: 'UNKNOWN', message: 'No data' } },
    { key: 'isArmed', label: 'Agent Armed', check: checks.isArmed || { status: 'UNKNOWN', message: 'No data' } },
    { key: 'isEntering', label: 'Not Entering', check: checks.isEntering || { status: 'UNKNOWN', message: 'No data' } },
    { key: 'dailyTradeLimit', label: 'Daily Trade Limit', check: checks.dailyTradeLimit || { status: 'UNKNOWN', message: 'No data' } },
    { key: 'consecutiveStopsLimit', label: 'Consecutive Stops', check: checks.consecutiveStopsLimit || { status: 'UNKNOWN', message: 'No data' } },
    { key: 'inEntryZone', label: 'In Entry Zone', check: checks.inEntryZone || { status: 'UNKNOWN', message: 'No data' } },
    { key: 'momentumGates', label: 'Momentum Gates', check: checks.momentumGates || { status: 'UNKNOWN', message: 'No data' } },
  ];

  const qualityFilters = checks.qualityFilters ? [
    { key: 'trendAlignment', label: 'Trend Alignment', check: checks.qualityFilters.trendAlignment || { status: 'UNKNOWN', message: 'No data' } },
    { key: 'momentum', label: 'ADX Momentum', check: checks.qualityFilters.momentum || { status: 'UNKNOWN', message: 'No data' } },
    { key: 'rsiPosition', label: 'RSI Position', check: checks.qualityFilters.rsiPosition || { status: 'UNKNOWN', message: 'No data' } },
    { key: 'volatility', label: 'Volatility (ATR)', check: checks.qualityFilters.volatility || { status: 'UNKNOWN', message: 'No data' } },
    { key: 'volume', label: 'Volume Confirmation', check: checks.qualityFilters.volume },
  ] : [];

  // Guard against server/client mismatch: if current>=required, treat as PASS
  const qs = checks.qualityScore || { current: 0, required: 999, status: 'UNKNOWN', reason: '' };
  const derivedQualityPass = Number(qs.current || 0) >= Number(qs.required || 0);
  const qualityStatus = derivedQualityPass ? 'PASS' : (qs.status || 'FAIL');
  const qualityProgress = Math.min(100, (Number(qs.current || 0) / Math.max(1, Number(qs.required || 1))) * 100);

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
              {(summary.failed ?? 0) > 0 && <span style={{ color: '#dc2626' }}> • {summary.failed} failed</span>}
              {(summary.partial ?? 0) > 0 && <span style={{ color: '#0ea5e9' }}> • {summary.partial} near</span>}
              {(summary.rejected ?? 0) > 0 && <span style={{ color: '#ff7a00' }}> • {summary.rejected} rejected</span>}
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
              <Space size="small">
                <Tooltip
                  title={
                    <Space direction="vertical" size={6}>
                      {renderReason(check?.reason)}
                      {check?.details && (
                        <pre
                          style={{
                            margin: 0,
                            padding: 0,
                            fontSize: 11,
                            opacity: 0.8,
                            whiteSpace: 'pre-wrap',
                            fontFamily: 'monospace',
                          }}
                        >
                          {JSON.stringify(check.details, null, 2)}
                        </pre>
                      )}
                    </Space>
                  }
                >
                  <Tag color={getStatusColor(check?.status)}>
                    {check?.status}
                  </Tag>
                </Tooltip>
              </Space>
            </div>
          ))}
        </Space>

        {/* Quality Score */}
        {checks.qualityScore && (
          <Card size="small" style={{ backgroundColor: '#fafafa' }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Space size="small">
                  {getStatusIcon(qualityStatus)}
                  <Text strong>Quality Score</Text>
                </Space>
                <Tag color={getStatusColor(qualityStatus)}>
                  {qs.current}/{qs.required}
                </Tag>
              </div>
              
              <Progress 
                percent={qualityProgress}
                size="small"
                status={qualityStatus === 'PASS' ? 'success' : 'exception'}
                showInfo={false}
              />
              
              <Text type="secondary" style={{ fontSize: 11 }}>
                {qs.reason}
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
                          <Tooltip
                            title={
                              <Space direction="vertical" size={6}>
                                {renderReason(check?.reason)}
                                {check?.details && (
                                  <div style={{ marginTop: 8, fontSize: 11 }}>
                                    <div>
                                      <strong>Current:</strong>{' '}
                                      {check.details.currentVolume !== undefined ?
                                        `${(check.details.currentVolume / 1000).toFixed(0)}K` :
                                        check.details.currentATR !== undefined ?
                                        `${check.details.currentATR}%` :
                                        check.details.currentADX !== undefined ?
                                        check.details.currentADX :
                                        check.value}
                                    </div>
                                    {check.details.thresholds && (
                                      <div style={{ marginTop: 4 }}>
                                        <strong>Thresholds:</strong>
                                        <div>• Min: {check.details.thresholds.minimum}</div>
                                        {check.details.thresholds.good && <div>• Good: {check.details.thresholds.good}</div>}
                                        {check.details.thresholds.excellent && <div>• Excellent: {check.details.thresholds.excellent}</div>}
                                        {check.details.thresholds.moderate && <div>• Moderate: {check.details.thresholds.moderate}</div>}
                                        {check.details.thresholds.strong && <div>• Strong: {check.details.thresholds.strong}</div>}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </Space>
                            }
                          >
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
