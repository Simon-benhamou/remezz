import React from 'react';
import {
  Badge,
  Button,
  Card,
  Col,
  List,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import { BulbOutlined, ReloadOutlined, WarningOutlined } from '../icons';
import dayjs from 'dayjs';
import AdaptiveWeightsPanel from '../components/AdaptiveWeightsPanel';
import { api } from '../api';

const { Title, Text } = Typography;

type Decision = {
  id?: string;
  symbol?: string;
  sessionId?: string;
  family?: string;
  action?: string;
  confidence?: number;
  outcome?: string;
  createdAt?: number | string;
};

const outcomeMeta: Record<string, { color: string; label: string }> = {
  win: { color: 'green', label: 'Win' },
  loss: { color: 'red', label: 'Loss' },
  breakeven: { color: 'blue', label: 'Flat' },
};

const IntelligencePage: React.FC = () => {
  const [adaptiveData, setAdaptiveData] = React.useState<any>(null);
  const [adaptiveLoading, setAdaptiveLoading] = React.useState<boolean>(true);
  const [opsMetrics, setOpsMetrics] = React.useState<any>(null);
  const [opsLoading, setOpsLoading] = React.useState<boolean>(true);

  const loadIntelligence = React.useCallback(async () => {
    try {
      setAdaptiveLoading(true);
      setOpsLoading(true);
      const [adaptive, metrics] = await Promise.all([
        api.getAdaptiveWeights({ decisionsLimit: 50 }).catch(() => null),
        api.getOpsMetrics().catch(() => null),
      ]);
      if (adaptive) setAdaptiveData(adaptive);
      if (metrics) setOpsMetrics(metrics);
    } finally {
      setAdaptiveLoading(false);
      setOpsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadIntelligence();
    const timer = setInterval(() => {
      void loadIntelligence();
    }, 60_000);
    return () => clearInterval(timer);
  }, [loadIntelligence]);

  const decisions: Decision[] = React.useMemo(() => {
    if (!Array.isArray(adaptiveData?.recentDecisions)) return [];
    return adaptiveData.recentDecisions.map((item: any) => ({
      ...item,
      createdAt: item.createdAt || item.ts,
    }));
  }, [adaptiveData]);

  const families = Array.isArray(adaptiveData?.weights) ? adaptiveData.weights.length : 0;
  const avgConfidence = decisions.length
    ? decisions.reduce((sum: number, item: any) => sum + Number(item.confidence || 0), 0) / decisions.length
    : 0;
  const winRate = decisions.length
    ? decisions.reduce((sum: number, item: any) => sum + (item.outcome === 'win' ? 1 : 0), 0) / decisions.length
    : 0;

  const flaggedSessions = Array.isArray(opsMetrics?.ops?.flaggedSessions)
    ? opsMetrics.ops.flaggedSessions
    : [];
  const entryGateBlocks = opsMetrics?.ops?.entryGateBlocks;

  return (
    <Space direction='vertical' size={24} style={{ width: '100%' }}>
      <Card
        style={{ borderRadius: 16, border: '1px solid #e2e8f0' }}
        bodyStyle={{ padding: 24 }}
      >
        <Row gutter={[24, 24]} align='middle'>
          <Col xs={24} lg={16}>
            <Space align='center' size={16}>
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: '#f5f3ff',
                  color: '#7c3aed',
                  fontSize: 26,
                }}
              >
                <BulbOutlined />
              </div>
              <Space direction='vertical' size={4}>
                <Title level={3} style={{ margin: 0 }}>Intelligence & Learning</Title>
                <Text type='secondary'>Live view of adaptive weights, signal feed and policy interventions.</Text>
              </Space>
            </Space>
          </Col>
          <Col xs={24} lg={8}>
            <Space size={24} wrap style={{ width: '100%', justifyContent: 'flex-end' }}>
              <Statistic title='Families tracked' value={families} />
              <Statistic title='Avg confidence' value={avgConfidence} precision={1} suffix='%' valueStyle={{ color: '#4338ca' }} />
              <Statistic title='Decision win rate' value={winRate * 100} precision={1} suffix='%' valueStyle={{ color: '#0ea5e9' }} />
            </Space>
          </Col>
        </Row>
        <Button type='primary' icon={<ReloadOutlined />} onClick={() => void loadIntelligence()} loading={adaptiveLoading} style={{ marginTop: 24 }}>
          Refresh intelligence
        </Button>
      </Card>

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={16}>
          <AdaptiveWeightsPanel data={adaptiveData} loading={adaptiveLoading} onRefresh={() => void loadIntelligence()} />
        </Col>
        <Col xs={24} xl={8}>
          <Card
            title={<Space><WarningOutlined style={{ color: '#f97316' }} />Policy interventions</Space>}
            loading={opsLoading}
            style={{ borderRadius: 12 }}
          >
            <Space direction='vertical' size={12} style={{ width: '100%' }}>
              <div>
                <Text strong style={{ display: 'block' }}>Validator & entry gate</Text>
                {entryGateBlocks ? (
                  <Space size={8} wrap>
                    <Tag color='geekblue'>Total blocks {entryGateBlocks.total || 0}</Tag>
                    <Tag color='purple'>Sessions impacted {entryGateBlocks.sessions?.length || 0}</Tag>
                  </Space>
                ) : (
                  <Text type='secondary'>No entry gate anomalies reported.</Text>
                )}
              </div>
              <div>
                <Text strong style={{ display: 'block' }}>Sessions under review</Text>
                {flaggedSessions.length ? (
                  <List
                    size='small'
                    dataSource={flaggedSessions.slice(0, 5)}
                    renderItem={(item: any) => (
                      <List.Item>
                        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                          <Space size={8}>
                            <Badge status='error' />
                            <Text>{item.symbol || item.sessionId}</Text>
                          </Space>
                          <Space size={8}>
                            <Tag color='red'>{item.count} blocks</Tag>
                            {item.lastBlockedAt && (
                              <Text type='secondary' style={{ fontSize: 12 }}>
                                Last block {new Date(item.lastBlockedAt).toLocaleTimeString()}
                              </Text>
                            )}
                          </Space>
                        </Space>
                      </List.Item>
                    )}
                  />
                ) : (
                  <Text type='secondary'>No agents require manual intervention.</Text>
                )}
              </div>
            </Space>
          </Card>
        </Col>
      </Row>

      <Card title='Decision feed' style={{ borderRadius: 12 }} loading={adaptiveLoading}>
        <List
          dataSource={decisions.slice(0, 30)}
          locale={{ emptyText: 'No recorded decisions yet.' }}
          renderItem={(item) => {
            const meta = outcomeMeta[item.outcome || ''] || outcomeMeta.breakeven;
            return (
              <List.Item>
                <Space size={12} wrap style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Space size={12} wrap>
                    <Tag color='geekblue'>{item.symbol || item.family || 'Unknown'}</Tag>
                    {item.action && <Tag color='blue'>{item.action.toUpperCase()}</Tag>}
                    <Tag color={meta.color}>{meta.label}</Tag>
                  </Space>
                  <Space size={12} wrap>
                    <Tag color='purple'>Confidence {Number(item.confidence || 0).toFixed(1)}%</Tag>
                    {item.sessionId && <Tag>{item.sessionId.slice(0, 6)}…</Tag>}
                    <Text type='secondary'>
                      {item.createdAt ? dayjs(item.createdAt).format('MMM D · HH:mm:ss') : '—'}
                    </Text>
                  </Space>
                </Space>
              </List.Item>
            );
          }}
        />
      </Card>
    </Space>
  );
};

export default IntelligencePage;
