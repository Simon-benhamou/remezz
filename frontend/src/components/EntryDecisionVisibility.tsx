/**
 * Entry Decision Visibility Component
 * 
 * Displays why trades are being blocked or allowed, showing threshold
 * configurations and regime-aware adjustments in real-time.
 */

import React, { useEffect, useState } from 'react';
import { Card, Table, Tag, Progress, Tooltip, Alert, Statistic, Row, Col } from 'antd';
import { 
  CheckCircleOutlined, 
  CloseCircleOutlined, 
  ExclamationCircleOutlined,
  TrophyOutlined,
  FireOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import api from '../api';

type EntryCheckStatus = 'pass' | 'fail' | 'n/a' | 'warning';

interface EntryComponent {
  key: string;
  label: string;
  status: EntryCheckStatus;
  detail: string;
  score: number | null;
  threshold?: number;
  actual?: number;
  impact: 'blocker' | 'moderate' | 'minor';
}

interface EntryStats {
  total: number;
  allowed: number;
  blocked: number;
  blockRate: number;
  topBlockingReasons: Array<{ reason: string; count: number }>;
  avgConfidenceAllowed: number;
  avgConfidenceBlocked: number;
  recommendation?: string;
}

interface Props {
  sessionId: string;
}

export const EntryDecisionVisibility: React.FC<Props> = ({ sessionId }) => {
  const [stats, setStats] = useState<EntryStats | null>(null);
  const [recentDecisions, setRecentDecisions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [sessionId]);

  const loadData = async () => {
    try {
      const response = await api.get(`/entry-analytics/entry-decisions/${sessionId}`);
      if (response.data.ok) {
        setStats(response.data.stats);
        setRecentDecisions(response.data.decisions || []);
      }
    } catch (error) {
      console.error('Failed to load entry decisions:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusIcon = (status: EntryCheckStatus) => {
    switch (status) {
      case 'pass':
        return <CheckCircleOutlined style={{ color: '#52c41a' }} />;
      case 'fail':
        return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />;
      case 'warning':
        return <ExclamationCircleOutlined style={{ color: '#faad14' }} />;
      default:
        return <span style={{ color: '#999' }}>-</span>;
    }
  };

  const getStatusColor = (status: EntryCheckStatus): string => {
    switch (status) {
      case 'pass': return 'success';
      case 'fail': return 'error';
      case 'warning': return 'warning';
      default: return 'default';
    }
  };

  const getRecommendationType = (recommendation?: string): 'success' | 'info' | 'warning' | 'error' => {
    if (!recommendation) return 'info';
    if (recommendation.includes('✅')) return 'success';
    if (recommendation.includes('🟢')) return 'success';
    if (recommendation.includes('🟡')) return 'warning';
    if (recommendation.includes('⚠️')) return 'error';
    return 'info';
  };

  if (loading && !stats) {
    return <Card loading />;
  }

  return (
    <div style={{ marginTop: 16 }}>
      {/* Statistics Overview */}
      {stats && (
        <Card 
          title={
            <span>
              <ThunderboltOutlined style={{ marginRight: 8 }} />
              Entry Decision Analytics
            </span>
          }
          style={{ marginBottom: 16 }}
        >
          <Row gutter={[16, 16]}>
            <Col span={6}>
              <Statistic
                title="Total Evaluations"
                value={stats.total}
                prefix={<FireOutlined />}
              />
            </Col>
            <Col span={6}>
              <Statistic
                title="Allowed"
                value={stats.allowed}
                valueStyle={{ color: '#3f8600' }}
                prefix={<CheckCircleOutlined />}
              />
            </Col>
            <Col span={6}>
              <Statistic
                title="Blocked"
                value={stats.blocked}
                valueStyle={{ color: '#cf1322' }}
                prefix={<CloseCircleOutlined />}
              />
            </Col>
            <Col span={6}>
              <Statistic
                title="Block Rate"
                value={stats.blockRate.toFixed(1)}
                suffix="%"
                valueStyle={{ 
                  color: stats.blockRate > 70 ? '#cf1322' : stats.blockRate > 40 ? '#faad14' : '#3f8600' 
                }}
              />
            </Col>
          </Row>

          <div style={{ marginTop: 16 }}>
            <div style={{ marginBottom: 8 }}>
              <strong>Confidence Levels:</strong>
            </div>
            <Row gutter={16}>
              <Col span={12}>
                <div>
                  Allowed Trades: 
                  <Progress 
                    percent={Math.round(stats.avgConfidenceAllowed * 100)} 
                    size="small"
                    status="success"
                    style={{ marginLeft: 8, display: 'inline-block', width: 200 }}
                  />
                </div>
              </Col>
              <Col span={12}>
                <div>
                  Blocked Trades: 
                  <Progress 
                    percent={Math.round(stats.avgConfidenceBlocked * 100)} 
                    size="small"
                    status="exception"
                    style={{ marginLeft: 8, display: 'inline-block', width: 200 }}
                  />
                </div>
              </Col>
            </Row>
          </div>

          {stats.recommendation && (
            <Alert
              message="Recommendation"
              description={stats.recommendation}
              type={getRecommendationType(stats.recommendation)}
              showIcon
              style={{ marginTop: 16 }}
            />
          )}

          {stats.topBlockingReasons.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ marginBottom: 8 }}>
                <strong>Top Blocking Reasons:</strong>
              </div>
              <div>
                {stats.topBlockingReasons.slice(0, 5).map((reason) => (
                  <Tag 
                    key={reason.reason} 
                    color="red" 
                    style={{ marginBottom: 4 }}
                  >
                    {reason.reason.replace(/_/g, ' ')} ({reason.count})
                  </Tag>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Recent Decisions */}
      {recentDecisions.length > 0 && (
        <Card 
          title="Recent Entry Evaluations"
          size="small"
        >
          <Table
            dataSource={recentDecisions}
            rowKey="timestamp"
            size="small"
            pagination={{ pageSize: 10 }}
            columns={[
              {
                title: 'Time',
                dataIndex: 'timestamp',
                key: 'timestamp',
                width: 150,
                render: (ts: number) => new Date(ts).toLocaleTimeString(),
              },
              {
                title: 'Symbol',
                dataIndex: 'symbol',
                key: 'symbol',
                width: 120,
              },
              {
                title: 'Decision',
                dataIndex: 'decision',
                key: 'decision',
                width: 100,
                render: (decision: string) => (
                  <Tag color={decision === 'allowed' ? 'green' : 'red'}>
                    {decision.toUpperCase()}
                  </Tag>
                ),
              },
              {
                title: 'Confidence',
                dataIndex: 'confidence',
                key: 'confidence',
                width: 150,
                render: (conf: number) => (
                  <Progress 
                    percent={Math.round(conf * 100)} 
                    size="small"
                    status={conf >= 0.7 ? 'success' : conf >= 0.5 ? 'normal' : 'exception'}
                  />
                ),
              },
              {
                title: 'Eligibility',
                dataIndex: 'eligibilityScore',
                key: 'eligibilityScore',
                width: 120,
                render: (score: number) => `${(score * 100).toFixed(0)}%`,
              },
              {
                title: 'Primary Reason',
                dataIndex: 'primaryReason',
                key: 'primaryReason',
                render: (reason?: string) => reason ? (
                  <Tag color="orange">{reason.replace(/_/g, ' ')}</Tag>
                ) : '-',
              },
            ]}
          />
        </Card>
      )}
    </div>
  );
};

export default EntryDecisionVisibility;
