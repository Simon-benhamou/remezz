import React from 'react';
import { Card, Tag, Progress, Space, Typography, Divider, Timeline, Button, Tooltip, Badge, message } from 'antd';
import { RocketOutlined, ClockCircleOutlined, ThunderboltOutlined, HistoryOutlined, ReloadOutlined, SwapOutlined } from '@ant-design/icons';
import { api } from '../api';

const { Text, Title } = Typography;

interface SmartAgentStatusProps {
  sessionId: string;
}

interface SmartAgentStatus {
  isSmartAgent: boolean;
  isIntelligent: boolean;
  currentSymbol: string;
  status?: 'active' | 'waiting';
  waitingReason?: string;
  nextRetryAt?: string;
  analysis: {
    symbol: string;
    score: number;
    confidence: number;
    reasoning: {
      summary: string;
      technical: string[];
      sentiment: string[];
      risk: string[];
    };
    opportunity: {
      type: string;
      direction: string;
      timeframe: string;
      expectedReturn: number;
      riskLevel: string;
    };
  } | null;
  conclusion?: {
    summary: string;
    recommendation: string;
    confidence: number;
    expectedReturn: number;
    riskLevel: string;
    technicalFactors: string[];
    riskFactors: string[];
  } | null;
  selectedAt: string | null;
  lastScan: string | null;
  nextScanDue: string | null;
  history: Array<{
    timestamp: string;
    action: string;
    symbol?: string;
    fromSymbol?: string;
    toSymbol?: string;
    score?: number;
    confidence?: number;
    reasoning?: string;
    hoursHeld?: string;
    trades?: number;
  }>;
}

export default function SmartAgentStatusPanel({ sessionId }: SmartAgentStatusProps) {
  const [status, setStatus] = React.useState<SmartAgentStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [lastUpdate, setLastUpdate] = React.useState<Date | null>(null);

  const loadStatus = React.useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.client.get(`/api/agent/sessions/${sessionId}/smart-status`);
      
      if (response.data && response.data.isSmartAgent !== false) {
        setStatus(response.data);
        setLastUpdate(new Date());
      } else {
        setStatus(null); // Not a smart agent
      }
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

  const formatTimeAgo = (dateString: string | null): string => {
    if (!dateString) return 'Unknown';
    
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    
    if (diffHours > 0) {
      return `${diffHours}h ${diffMinutes}m ago`;
    }
    return `${diffMinutes}m ago`;
  };

  const getTimeUntilNextScan = (): string => {
    if (!status?.nextScanDue) return 'Unknown';
    
    const nextScan = new Date(status.nextScanDue);
    const now = new Date();
    const diffMs = nextScan.getTime() - now.getTime();
    
    if (diffMs <= 0) return 'Now';
    
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    
    if (diffHours > 0) {
      return `${diffHours}h ${diffMinutes}m`;
    }
    return `${diffMinutes}m`;
  };

  const getSwitchCount = (): number => {
    if (!status?.history) return 0;
    return status.history.filter(h => h.action?.includes('switch')).length;
  };

  if (loading) {
    return (
      <Card loading title="Intelligent Agent Status" />
    );
  }

  if (!status || !status.isSmartAgent) {
    return null; // Don't show panel for non-smart agents
  }

  return (
    <Card
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            <RocketOutlined style={{ color: '#722ed1', fontSize: '18px' }} />
            <span style={{ fontWeight: '700' }}>Intelligent Agent</span>
            <Tag color="purple">OPTIMIZED</Tag>
            {status.isIntelligent && <Tag color="green">AI</Tag>}
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
      {/* Current Symbol & Analysis */}
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
              {status.analysis && (
                <Space>
                  <Tag color="blue">Score: {status.analysis.score.toFixed(1)}</Tag>
                  <Tag color="green">Confidence: {(status.analysis.confidence * 100).toFixed(0)}%</Tag>
                </Space>
              )}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <Text type="secondary" style={{ fontSize: '12px' }}>Total Switches</Text>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#0369a1' }}>
              {getSwitchCount()}
            </div>
          </div>
        </div>

        {status.analysis && (
          <div style={{ marginTop: '12px' }}>
            <Text type="secondary" style={{ fontSize: '12px' }}>Analysis Summary</Text>
            <div style={{ marginTop: '4px', fontSize: '13px', color: '#4b5563' }}>
              {status.analysis.reasoning.summary}
            </div>
            <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <Tag color="cyan">{status.analysis.opportunity.type}</Tag>
              <Tag color={status.analysis.opportunity.direction === 'bullish' ? 'green' : 
                            status.analysis.opportunity.direction === 'bearish' ? 'red' : 'blue'}>
                {status.analysis.opportunity.direction}
              </Tag>
              <Tag color="orange">{status.analysis.opportunity.riskLevel} risk</Tag>
              <Tag color="purple">+{status.analysis.opportunity.expectedReturn.toFixed(1)}% target</Tag>
            </div>
          </div>
        )}

        {/* Smart Agent Conclusion */}
        {status.conclusion && (
          <div style={{ 
            marginTop: '16px', 
            padding: '12px', 
            background: 'linear-gradient(135deg, #fff7ed 0%, #fed7aa 20%)',
            borderRadius: '8px',
            border: '1px solid #fdba74'
          }}>
            <Text strong style={{ color: '#ea580c', fontSize: '13px' }}>🎯 Smart Agent Conclusion</Text>
            <div style={{ marginTop: '8px', fontSize: '12px', color: '#9a3412' }}>
              <strong>Recommendation:</strong> {status.conclusion.recommendation.toUpperCase()} bias 
              ({status.conclusion.confidence.toFixed(0)}% confidence)
            </div>
            <div style={{ marginTop: '4px', fontSize: '12px', color: '#9a3412' }}>
              <strong>Expected Return:</strong> {status.conclusion.expectedReturn.toFixed(1)}% 
              ({status.conclusion.riskLevel} risk)
            </div>
            {status.conclusion.technicalFactors.length > 0 && (
              <div style={{ marginTop: '8px' }}>
                <Text style={{ fontSize: '11px', color: '#7c2d12' }}>Key Factors:</Text>
                <div style={{ marginLeft: '8px', fontSize: '11px', color: '#a16207' }}>
                  {status.conclusion.technicalFactors.slice(0, 2).map((factor, i) => (
                    <div key={i}>• {factor}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Waiting State */}
        {status.status === 'waiting' && (
          <div style={{ 
            marginTop: '16px', 
            padding: '12px', 
            background: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 20%)',
            borderRadius: '8px',
            border: '1px solid #f59e0b'
          }}>
            <Text strong style={{ color: '#d97706', fontSize: '13px' }}>⏳ Waiting for Opportunities</Text>
            <div style={{ marginTop: '8px', fontSize: '12px', color: '#92400e' }}>
              {status.waitingReason || 'Scanning for new opportunities...'}
            </div>
            {status.nextRetryAt && (
              <div style={{ marginTop: '4px', fontSize: '11px', color: '#78350f' }}>
                Next scan: {new Date(status.nextRetryAt).toLocaleString()}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: '16px', marginTop: '12px' }}>
          <div style={{ flex: 1 }}>
            <Text type="secondary" style={{ fontSize: '11px' }}>Selected</Text>
            <div>
              <Text style={{ fontSize: '12px', fontWeight: 600 }}>
                {formatTimeAgo(status.selectedAt)}
              </Text>
            </div>
          </div>
          
          <div style={{ flex: 1 }}>
            <Text type="secondary" style={{ fontSize: '11px' }}>Next Scan</Text>
            <div>
              <Text style={{ fontSize: '12px', fontWeight: 600 }}>
                {getTimeUntilNextScan()}
              </Text>
            </div>
          </div>

          {/* Manual Re-selection Button */}
          <div style={{ flex: 1 }}>
            <Button 
              type="primary" 
              size="small"
              icon={<ReloadOutlined />}
              style={{
                background: 'linear-gradient(135deg, #722ed1, #9254de)',
                border: 'none',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: '600',
                width: '100%'
              }}
              onClick={async () => {
                try {
                  // Forcer une nouvelle sélection immédiate
                  await api.client.post('/api/agent/reselect', { sessionId });
                  message.success('🎯 Re-sélection lancée! Analyse en cours...');
                  // Recharger le status après 2 secondes
                  setTimeout(() => {
                    loadStatus();
                  }, 2000);
                } catch (error) {
                  console.error('Smart re-selection trigger error:', error);
                  message.error('Impossible de relancer la sélection');
                }
              }}
            >
              🔄 Rechercher
            </Button>
          </div>
        </div>
      </div>

      {/* Optimized Strategy Info */}
      <div style={{ marginBottom: '16px' }}>
        <Title level={5} style={{ margin: 0, marginBottom: '8px', fontSize: '14px' }}>
          Optimization Strategy
        </Title>
        <div style={{
          background: '#f8fafc',
          borderRadius: '8px',
          padding: '12px',
          fontSize: '12px'
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <Text type="secondary">Min Hold Period:</Text>
              <div style={{ fontWeight: 600, color: '#059669' }}>12 hours</div>
            </div>
            <div>
              <Text type="secondary">Scope:</Text>
              <div style={{ fontWeight: 600, color: '#0369a1' }}>Top 10-20 cryptos</div>
            </div>
            <div>
              <Text type="secondary">AI Usage:</Text>
              <div style={{ fontWeight: 600, color: '#7c3aed' }}>Conditional only</div>
            </div>
            <div>
              <Text type="secondary">Cost Savings:</Text>
              <div style={{ fontWeight: 600, color: '#dc2626' }}>-99% vs original</div>
            </div>
          </div>
        </div>
      </div>

      {/* Selection History (Recent Activity) */}
      {status.history && status.history.length > 0 && (() => {
        // Always newest first
        const sorted = [...status.history].sort((a:any,b:any)=>{
          const ta = new Date(a.timestamp || a.ts || 0).getTime();
          const tb = new Date(b.timestamp || b.ts || 0).getTime();
          return tb - ta;
        });
        const items = sorted.map((item:any)=>({
          color: item.action === 'intelligent_init' ? '#52c41a' : item.action?.includes('switch') ? '#1890ff' : '#faad14',
          children: (
            <div style={{ fontSize: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text strong style={{ fontSize: '13px' }}>
                  {item.action === 'intelligent_init' ? (
                    <span><strong style={{ color: '#52c41a' }}>{item.symbol}</strong> (Initial)</span>
                  ) : item.fromSymbol && item.toSymbol ? (
                    <span>{item.fromSymbol} → <strong style={{ color: '#1890ff' }}>{item.toSymbol}</strong></span>
                  ) : (
                    <span><strong>{item.symbol || 'Unknown'}</strong></span>
                  )}
                </Text>
                <Space>
                  {item.score != null && <Tag color="blue">{Number(item.score).toFixed(1)}</Tag>}
                  {item.confidence != null && <Tag color="green">{(Number(item.confidence) * 100).toFixed(0)}%</Tag>}
                  {item.hoursHeld && <Tag color="orange">{item.hoursHeld}h held</Tag>}
                </Space>
              </div>
              {item.reasoning && (
                <div style={{ marginTop: '4px', color: '#666' }}>
                  {item.reasoning}
                </div>
              )}
              <div style={{ marginTop: '2px', fontSize: '11px', color: '#999' }}>
                {new Date(item.timestamp || item.ts).toLocaleString()}
              </div>
            </div>
          )
        }));
        const needsScroll = sorted.length > 5;
        return (
        <>
          <Divider />
          <div>
            <Title level={5} style={{ margin: 0, marginBottom: '12px', fontSize: '14px' }}>
              <HistoryOutlined style={{ marginRight: '6px', color: '#722ed1' }} />
              Recent Activity ({sorted.length})
            </Title>
            <div style={{ maxHeight: needsScroll ? 240 : 'auto', overflowY: needsScroll ? 'auto' : 'visible', paddingRight: needsScroll ? 6 : 0 }}>
              <Timeline items={items} />
            </div>
          </div>
        </>
        );
      })()}

      {/* Footer */}
      <div style={{
        marginTop: '16px',
        padding: '12px',
        background: 'linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%)',
        borderRadius: '8px',
        fontSize: '11px',
        color: '#166534',
        textAlign: 'center',
        border: '1px solid #bbf7d0'
      }}>
        🧠 <strong>Cost-Optimized Intelligent Agent</strong>
        <br/>
        🎯 Analyzes top cryptos with 95% technical analysis + conditional AI
        <br/>
        ⏰ 12h minimum hold strategy for better trading performance
        <br/>
        💰 99% cost reduction while maintaining analysis quality
      </div>
    </Card>
  );
}
