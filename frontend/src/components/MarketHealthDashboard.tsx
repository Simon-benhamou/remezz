/**
 * Market Health Dashboard
 * 
 * Affiche en temps réel:
 * - Si les conditions sont favorables pour trader
 * - Pourquoi il n'y a pas de trades
 * - Tous les signaux analysés (accepted/rejected)
 * - Activité des agents
 */

import React, { useEffect, useState } from 'react';
import { Card, Tag, Progress, Timeline, Statistic, Row, Col, Table, Badge, Tooltip, Alert, Button } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  SyncOutlined,
  FireOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { api } from '../api';

type MarketHealth = {
  symbol: string;
  timestamp: number;
  isFavorable: boolean;
  healthScore: number;
  unfavorableReasons: string[];
  strategyCompatibility: {
    score: number;
    tier: string;
    volatilityFit: string;
    liquidityFit: string;
    trendQuality: string;
    accumulationDetectable: boolean;
    estimatedWinRate: number;
    reasons: string[];
    warnings: string[];
  };
  marketRegime: {
    dominant: string;
    confidence: number;
    notes: string[]; // Array of notes instead of single reason
  };
  recentActivity: {
    lastHour: {
      totalAttempts: number;
      accepted: number;
      rejected: number;
      rejectionRate: string;
    };
    predictorBlocks: number;
  };
  technicals: {
    price: number;
    atr14: number;
    atrPct: string;
    adx14: number;
    rsi14: number;
    volumeRatio: string;
  };
};

type Decision = {
  timestamp: string;
  decision: string;
  strategy: string;
  strategyLabel: string;
  confidenceScore: number;
  qualityScore: number;
  entryEligibilityScore: number;
  confidencePassed: boolean | null;
  eligibilityPassed: boolean | null;
  blockedReason: string | null;
  entryReasons: string[];
  predictorDecision: string;
  predictorConfidence: number;
  inputMetrics: Record<string, any>;
};

type DecisionsResponse = {
  symbol: string;
  stats: {
    total: number;
    accepted: number;
    rejected: number;
    acceptanceRate: string;
    rejectionReasons: {
      lowConfidence: number;
      weakContext: number;
      predictorBlocked: number;
      other: number;
    };
  };
  decisions: Decision[];
};

interface Props {
  symbol: string;
}

function MarketHealthDashboard({ symbol }: Props) {
  const [health, setHealth] = useState<MarketHealth | null>(null);
  const [decisions, setDecisions] = useState<DecisionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [healthRes, decisionsRes] = await Promise.all([
          api.getMarketHealth(symbol),
          api.getMarketHealthDecisions(symbol, 30),
        ]);
        
        console.log('Market Health Response:', healthRes);
        console.log('Decisions Response:', decisionsRes);
        
        setHealth(healthRes);
        setDecisions(decisionsRes);
        setError(null);
      } catch (error: any) {
        console.error('Error fetching market health:', error);
        const errorMsg = error.response?.data?.error || error.message || 'Failed to fetch market health';
        setError(errorMsg);
        // Set null to trigger error state
        setHealth(null);
        setDecisions(null);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 10000); // Update every 10s
    return () => clearInterval(interval);
  }, [symbol]);

  if (loading) {
    return (
      <Card loading={loading}>
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <SyncOutlined spin style={{ fontSize: 32 }} />
          <p style={{ marginTop: 16 }}>Loading market health...</p>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <Alert
          message="Error Loading Market Health"
          description={error}
          type="error"
          showIcon
          action={
            <Button size="small" onClick={() => setLoading(true)}>
              Retry
            </Button>
          }
        />
      </Card>
    );
  }

  if (!health || !decisions) {
    return (
      <Card>
        <Alert
          message="No Data Available"
          description="Market health data could not be loaded. The backend may not be running or the symbol format may be incorrect."
          type="warning"
          showIcon
        />
      </Card>
    );
  }

  // Safety checks for data structure
  if (!health.strategyCompatibility || !health.marketRegime || !health.recentActivity || !health.technicals) {
    return (
      <Card>
        <Alert
          message="Incomplete Data"
          description="Market health data is incomplete. The API may not be returning all required fields."
          type="warning"
          showIcon
        />
      </Card>
    );
  }

  const getFitColor = (fit: string) => {
    if (fit === 'excellent') return '#52c41a';
    if (fit === 'good') return '#1890ff';
    if (fit === 'acceptable') return '#faad14';
    return '#f5222d';
  };

  const getRegimeColor = (regime: string) => {
    if (regime === 'trending') return 'green';
    if (regime === 'consolidating') return 'blue';
    if (regime === 'choppy') return 'red';
    return 'default';
  };

  const decisionColumns = [
    {
      title: 'Time',
      dataIndex: 'timestamp',
      key: 'timestamp',
      width: 80,
      render: (ts: string) => {
        const date = new Date(ts);
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      },
    },
    {
      title: 'Decision',
      dataIndex: 'decision',
      key: 'decision',
      width: 120,
      render: (decision: string) => {
        const isAccepted = decision === 'order_placed';
        return (
          <Tag
            icon={isAccepted ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
            color={isAccepted ? 'success' : 'error'}
          >
            {isAccepted ? 'ACCEPTED' : 'REJECTED'}
          </Tag>
        );
      },
    },
    {
      title: 'Strategy',
      dataIndex: 'strategyLabel',
      key: 'strategy',
      width: 150,
    },
    {
      title: 'Confidence',
      dataIndex: 'confidenceScore',
      key: 'confidence',
      width: 100,
      render: (score: number, record: Decision) => (
        <div>
          <span style={{ fontWeight: record.confidencePassed ? 600 : 400 }}>
            {(score * 100).toFixed(1)}%
          </span>
          {!record.confidencePassed && <Tag color="orange" style={{ marginLeft: 4 }}>LOW</Tag>}
        </div>
      ),
    },
    {
      title: 'Eligibility',
      dataIndex: 'entryEligibilityScore',
      key: 'eligibility',
      width: 100,
      render: (score: number, record: Decision) => (
        <div>
          <span style={{ fontWeight: record.eligibilityPassed ? 600 : 400 }}>
            {(score * 100).toFixed(1)}%
          </span>
          {!record.eligibilityPassed && <Tag color="orange" style={{ marginLeft: 4 }}>WEAK</Tag>}
        </div>
      ),
    },
    {
      title: 'Blocked Reason',
      dataIndex: 'blockedReason',
      key: 'blockedReason',
      render: (reason: string | null) => {
        if (!reason) return <span style={{ color: '#52c41a' }}>✓ Passed</span>;
        
        let color = 'orange';
        let text = reason;
        
        if (reason.includes('confidence')) {
          color = 'volcano';
          text = 'Low Confidence';
        } else if (reason.includes('context')) {
          color = 'orange';
          text = 'Weak Context';
        } else if (reason.includes('predictor')) {
          color = 'purple';
          text = 'Predictor Blocked';
        }
        
        return <Tag color={color}>{text}</Tag>;
      },
    },
  ];

  return (
    <div style={{ padding: '16px' }}>
      {/* Header */}
      <Card style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle">
          <Col flex="auto">
            <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              {health.isFavorable ? (
                <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 24 }} />
              ) : (
                <ExclamationCircleOutlined style={{ color: '#faad14', fontSize: 24 }} />
              )}
              Market Health: {symbol}
            </h2>
            <p style={{ margin: '4px 0 0 32px', color: '#666' }}>
              {health.isFavorable
                ? 'Conditions are favorable for trading'
                : 'Unfavorable conditions - trades may be rejected'}
            </p>
          </Col>
          <Col>
            <Statistic
              title="Health Score"
              value={health.healthScore}
              precision={2}
              valueStyle={{ color: health.healthScore >= 0.60 ? '#52c41a' : '#faad14' }}
              suffix="/ 1.0"
            />
          </Col>
        </Row>
      </Card>

      {/* Strategy Compatibility */}
      <Card title="🎯 Strategy Compatibility" style={{ marginBottom: 16 }}>
        <Row gutter={16}>
          <Col span={8}>
            <div style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: '#666' }}>Tier</span>
              <div>
                <Tag color={health.strategyCompatibility.tier === 'tier1' ? 'gold' : 'blue'}>
                  {health.strategyCompatibility.tier.toUpperCase()}
                </Tag>
                <span style={{ fontSize: 12, color: '#999', marginLeft: 8 }}>
                  Est. WR: {(health.strategyCompatibility.estimatedWinRate * 100).toFixed(0)}%
                </span>
              </div>
            </div>
            
            <div style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: '#666' }}>Volatility Fit</span>
              <Progress
                percent={100}
                strokeColor={getFitColor(health.strategyCompatibility.volatilityFit)}
                format={() => health.strategyCompatibility.volatilityFit.toUpperCase()}
                size="small"
              />
            </div>
            
            <div style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: '#666' }}>Liquidity Fit</span>
              <Progress
                percent={100}
                strokeColor={getFitColor(health.strategyCompatibility.liquidityFit)}
                format={() => health.strategyCompatibility.liquidityFit.toUpperCase()}
                size="small"
              />
            </div>
            
            <div>
              <span style={{ fontSize: 12, color: '#666' }}>Trend Quality</span>
              <Progress
                percent={100}
                strokeColor={getFitColor(health.strategyCompatibility.trendQuality)}
                format={() => health.strategyCompatibility.trendQuality.toUpperCase()}
                size="small"
              />
            </div>
          </Col>
          
          <Col span={8}>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>Strengths</div>
            {health.strategyCompatibility.reasons.slice(0, 4).map((reason, i) => (
              <Tag key={i} color="green" style={{ marginBottom: 4 }}>
                {reason}
              </Tag>
            ))}
          </Col>
          
          <Col span={8}>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>Warnings</div>
            {health.strategyCompatibility.warnings.length > 0 ? (
              health.strategyCompatibility.warnings.map((warning, i) => (
                <Tag key={i} color="orange" style={{ marginBottom: 4 }}>
                  {warning}
                </Tag>
              ))
            ) : (
              <span style={{ color: '#52c41a', fontSize: 12 }}>✓ No warnings</span>
            )}
            
            {!health.isFavorable && (
              <>
                <div style={{ fontSize: 12, color: '#666', marginTop: 12, marginBottom: 8 }}>
                  Why No Trades?
                </div>
                {health.unfavorableReasons.map((reason, i) => (
                  <Tag key={i} color="red" style={{ marginBottom: 4 }}>
                    {reason}
                  </Tag>
                ))}
              </>
            )}
          </Col>
        </Row>
      </Card>

      {/* Market Regime & Activity */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={12}>
          <Card title="📊 Market Regime">
            <div style={{ marginBottom: 16 }}>
              <Tag color={getRegimeColor(health.marketRegime.dominant)} style={{ fontSize: 14, padding: '4px 12px' }}>
                {health.marketRegime.dominant.toUpperCase()}
              </Tag>
              <span style={{ marginLeft: 8, color: '#666', fontSize: 12 }}>
                Confidence: {(health.marketRegime.confidence * 100).toFixed(0)}%
              </span>
            </div>
            {health.marketRegime.notes && health.marketRegime.notes.length > 0 && (
              <div style={{ fontSize: 12, color: '#666', marginTop: 8 }}>
                {health.marketRegime.notes.map((note, i) => (
                  <div key={i} style={{ marginBottom: 4 }}>• {note}</div>
                ))}
              </div>
            )}
            
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #f0f0f0' }}>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>Technical Snapshot</div>
              <Row gutter={8}>
                <Col span={12}>
                  <div style={{ fontSize: 11 }}>
                    <span style={{ color: '#999' }}>ADX:</span> <strong>{health.technicals.adx14.toFixed(1)}</strong>
                  </div>
                  <div style={{ fontSize: 11 }}>
                    <span style={{ color: '#999' }}>RSI:</span> <strong>{health.technicals.rsi14.toFixed(1)}</strong>
                  </div>
                </Col>
                <Col span={12}>
                  <div style={{ fontSize: 11 }}>
                    <span style={{ color: '#999' }}>ATR:</span> <strong>{health.technicals.atrPct}</strong>
                  </div>
                  <div style={{ fontSize: 11 }}>
                    <span style={{ color: '#999' }}>Volume:</span> <strong>{health.technicals.volumeRatio}x</strong>
                  </div>
                </Col>
              </Row>
            </div>
          </Card>
        </Col>
        
        <Col span={12}>
          <Card title="⚡ Recent Activity (Last Hour)">
            <Row gutter={16}>
              <Col span={8}>
                <Statistic
                  title="Total Attempts"
                  value={health.recentActivity.lastHour.totalAttempts}
                  prefix={<SyncOutlined />}
                />
              </Col>
              <Col span={8}>
                <Statistic
                  title="Accepted"
                  value={health.recentActivity.lastHour.accepted}
                  valueStyle={{ color: '#52c41a' }}
                  prefix={<CheckCircleOutlined />}
                />
              </Col>
              <Col span={8}>
                <Statistic
                  title="Rejected"
                  value={health.recentActivity.lastHour.rejected}
                  valueStyle={{ color: '#f5222d' }}
                  prefix={<CloseCircleOutlined />}
                />
              </Col>
            </Row>
            
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #f0f0f0' }}>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>Rejection Rate</div>
              <Progress
                percent={parseFloat(health.recentActivity.lastHour.rejectionRate) || 0}
                strokeColor="#f5222d"
                format={(percent) => `${percent}%`}
              />
              
              {health.recentActivity.predictorBlocks > 0 && (
                <Tag color="purple" style={{ marginTop: 8 }}>
                  {health.recentActivity.predictorBlocks} predictor blocks
                </Tag>
              )}
            </div>
          </Card>
        </Col>
      </Row>

      {/* Decision History */}
      <Card
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FireOutlined />
            Strategy Decisions (Last 30)
            <Badge
              count={decisions.stats.accepted}
              style={{ backgroundColor: '#52c41a', marginLeft: 8 }}
              title="Accepted"
            />
            <Badge
              count={decisions.stats.rejected}
              style={{ backgroundColor: '#f5222d' }}
              title="Rejected"
            />
          </div>
        }
        extra={
          <span style={{ fontSize: 12 }}>
            Acceptance Rate: <strong>{decisions.stats.acceptanceRate}</strong>
          </span>
        }
      >
        <Table
          dataSource={decisions.decisions}
          columns={decisionColumns}
          pagination={false}
          size="small"
          scroll={{ y: 400 }}
          rowKey={(record) => record.timestamp}
        />
        
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #f0f0f0' }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>Rejection Breakdown</div>
          <Row gutter={8}>
            <Col span={6}>
              <Tag color="volcano">Low Confidence: {decisions.stats.rejectionReasons.lowConfidence}</Tag>
            </Col>
            <Col span={6}>
              <Tag color="orange">Weak Context: {decisions.stats.rejectionReasons.weakContext}</Tag>
            </Col>
            <Col span={6}>
              <Tag color="purple">Predictor Blocked: {decisions.stats.rejectionReasons.predictorBlocked}</Tag>
            </Col>
            <Col span={6}>
              <Tag color="default">Other: {decisions.stats.rejectionReasons.other}</Tag>
            </Col>
          </Row>
        </div>
      </Card>
    </div>
  );
}

export default MarketHealthDashboard;
