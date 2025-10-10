import React from 'react';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Col,
  Divider,
  List,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  FireOutlined,
  PlusOutlined,
  ReloadOutlined,
  RocketOutlined,
  StopOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { openWS } from '../ws';
import AgentHealthTable from '../components/AgentHealthTable';
import OpsMetricsPanel from '../components/OpsMetricsPanel';
import OpsEventsList from '../components/OpsEventsList';
import SmartOpportunityScanner from '../components/SmartOpportunityScanner';
import { useMode } from '../contexts/ModeContext';
import { useStopAllLock } from '../hooks/useStopAllLock';
import { useStopAllConfirmation } from '../hooks/useStopAllConfirmation';

const { Title, Text } = Typography;

type OverviewSession = {
  id: string;
  symbol?: string;
  mode?: string;
  state?: string;
  pnlUsd?: number;
  roiPct?: number;
  bias?: string;
  aggressiveness?: string;
  lastExecutionTs?: number;
  lastTradeAt?: number;
};

type GlobalHealthMeta = {
  status: 'critical' | 'warning' | 'healthy' | 'idle';
  color: string;
  icon: React.ReactNode;
  label: string;
};

const healthMeta: Record<GlobalHealthMeta['status'], { color: string; icon: React.ReactNode; label: string }> = {
  critical: { color: '#dc2626', icon: <ExclamationCircleOutlined />, label: 'Critical' },
  warning: { color: '#f97316', icon: <WarningOutlined />, label: 'Warning' },
  healthy: { color: '#16a34a', icon: <CheckCircleOutlined />, label: 'Healthy' },
  idle: { color: '#94a3b8', icon: <StopOutlined />, label: 'Idle' },
};

function resolveHealth(overview: any): GlobalHealthMeta {
  const alertCounts = overview?.alerts?.severityCounts || {};
  const high = alertCounts.high || 0;
  const med = alertCounts.med || 0;
  const active = overview?.activeCount || 0;

  if (high > 0) return { status: 'critical', ...healthMeta.critical };
  if (med > 2 || (med > 0 && active > 3)) return { status: 'warning', ...healthMeta.warning };
  if (active > 0) return { status: 'healthy', ...healthMeta.healthy };
  return { status: 'idle', ...healthMeta.idle };
}

function formatRelative(ts?: number | null) {
  if (!ts) return '—';
  const deltaMs = Date.now() - ts;
  if (deltaMs < 60_000) return 'Just now';
  if (deltaMs < 3_600_000) {
    const minutes = Math.round(deltaMs / 60_000);
    return `${minutes} min ago`;
  }
  const hours = Math.round(deltaMs / 3_600_000);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

const statusColor: Record<string, string> = {
  MANAGE: 'blue',
  ARMED: 'green',
  HALTED: 'red',
};

const biasColor: Record<string, string> = {
  long: 'green',
  short: 'red',
  neutral: 'default',
};

const MissionControlPage: React.FC = () => {
  const navigate = useNavigate();
  const { mode } = useMode();

  const [overview, setOverview] = React.useState<any>(null);
  const [overviewLoading, setOverviewLoading] = React.useState<boolean>(true);
  const [opsMetrics, setOpsMetrics] = React.useState<any>(null);
  const [opsMetricsLoading, setOpsMetricsLoading] = React.useState<boolean>(true);
  const [opsEvents, setOpsEvents] = React.useState<any[]>([]);
  const [opsEventsLoading, setOpsEventsLoading] = React.useState<boolean>(true);
  const [agentHealth, setAgentHealth] = React.useState<any>(null);
  const [agentHealthLoading, setAgentHealthLoading] = React.useState<boolean>(true);
  const [showScanner, setShowScanner] = React.useState<boolean>(false);

  const { locked, unlock, setLocked } = useStopAllLock();
  const confirmStopAll = useStopAllConfirmation({
    description: (
      <span>
        This will immediately halt every agent, cancel outstanding orders and flatten open positions. Creation of new agents
        remains blocked until you reset the safety lock.
      </span>
    ),
  });

  const loadOverview = React.useCallback(async () => {
    try {
      setOverviewLoading(true);
      const data = await api.overview(mode);
      setOverview(data);
    } finally {
      setOverviewLoading(false);
    }
  }, [mode]);

  const loadOpsArtifacts = React.useCallback(async () => {
    try {
      setOpsMetricsLoading(true);
      setOpsEventsLoading(true);
      setAgentHealthLoading(true);
      const [metrics, events, health] = await Promise.all([
        api.getOpsMetrics().catch(() => null),
        api.getOpsEvents().catch(() => []),
        api.getAgentHealth().catch(() => null),
      ]);
      if (metrics) setOpsMetrics(metrics);
      if (Array.isArray(events)) setOpsEvents(events);
      if (health) setAgentHealth(health);
    } finally {
      setOpsMetricsLoading(false);
      setOpsEventsLoading(false);
      setAgentHealthLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  React.useEffect(() => {
    void loadOpsArtifacts();
    const opsTimer = setInterval(() => {
      void loadOpsArtifacts();
    }, 30_000);
    return () => clearInterval(opsTimer);
  }, [loadOpsArtifacts]);

  React.useEffect(() => {
    const refreshTimer = setInterval(() => {
      void loadOverview();
    }, 15_000);
    return () => clearInterval(refreshTimer);
  }, [loadOverview]);

  React.useEffect(() => {
    const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';
    const key = localStorage.getItem('apiKey') || '';
    const ws = openWS(API_BASE, key, undefined, (msg: any) => {
      if (msg?.type === 'overview_session') {
        setOverview((prev: any) => {
          if (!prev) return prev;
          const sessions = Array.isArray(prev.sessions) ? [...prev.sessions] : [];
          const idx = sessions.findIndex((s: any) => s.id === msg.data.id);
          if (idx >= 0) {
            sessions[idx] = { ...sessions[idx], ...msg.data };
          } else {
            sessions.unshift(msg.data);
          }
          return { ...prev, sessions };
        });
      }
      if (msg?.type === 'agent_stop_all') {
        setLocked(true);
        void loadOverview();
        void loadOpsArtifacts();
      }
    });
    return () => {
      try {
        ws?.close?.();
      } catch (err) {
        console.error('Failed to close Mission Control websocket', err);
      }
    };
  }, [loadOpsArtifacts, loadOverview, setLocked]);

  const margin = opsMetrics?.margin;
  const globalHealth = resolveHealth(overview);
  const sessions: OverviewSession[] = Array.isArray(overview?.sessions) ? overview.sessions : [];

  const sessionColumns = React.useMemo<ColumnsType<OverviewSession>>(
    () => [
      {
        title: 'Agent',
        key: 'agent',
        render: (_value, record) => (
          <Space direction='vertical' size={0}>
            <Space size={6}>
              <Avatar size={28} style={{ background: record.mode === 'live' ? '#f59e0b' : '#3b82f6' }}>
                {(record.symbol || 'AG')[0]}
              </Avatar>
              <Text strong>{record.symbol || 'Unknown'}</Text>
              {record.aggressiveness && (
                <Tag color={record.aggressiveness === 'aggressive' ? 'red' : record.aggressiveness === 'reactive' ? 'orange' : 'blue'}>
                  {record.aggressiveness.toUpperCase()}
                </Tag>
              )}
            </Space>
            <Text type='secondary' style={{ fontSize: 12 }}>{record.id}</Text>
          </Space>
        ),
      },
      {
        title: 'State',
        dataIndex: 'state',
        key: 'state',
        render: (value: string | undefined) =>
          value ? <Tag color={statusColor[value] || 'default'}>{value}</Tag> : <Text type='secondary'>—</Text>,
        width: 120,
      },
      {
        title: 'Bias',
        dataIndex: 'bias',
        key: 'bias',
        render: (value: string | undefined) =>
          value ? <Tag color={biasColor[value] || 'default'}>{value.toUpperCase()}</Tag> : <Text type='secondary'>—</Text>,
        width: 100,
      },
      {
        title: 'ROI',
        dataIndex: 'roiPct',
        key: 'roiPct',
        align: 'right',
        render: (value: number | undefined) => (
          <Text style={{ color: (value || 0) >= 0 ? '#16a34a' : '#dc2626' }}>{Number(value || 0).toFixed(2)}%</Text>
        ),
        width: 120,
      },
      {
        title: 'PnL',
        dataIndex: 'pnlUsd',
        key: 'pnlUsd',
        align: 'right',
        render: (value: number | undefined) => (
          <Text style={{ color: (value || 0) >= 0 ? '#16a34a' : '#dc2626' }}>${Number(value || 0).toFixed(2)}</Text>
        ),
        width: 120,
      },
      {
        title: 'Last execution',
        key: 'lastExecutionTs',
        render: (_value, record) => (
          <Tooltip title={record.lastExecutionTs ? new Date(record.lastExecutionTs).toLocaleString() : undefined}>
            <Text type='secondary'>{formatRelative(record.lastExecutionTs || record.lastTradeAt)}</Text>
          </Tooltip>
        ),
        width: 160,
      },
      {
        key: 'action',
        render: (_value, record) => (
          <Button type='link' onClick={() => navigate(`/agents/${record.id}`)}>Open cockpit</Button>
        ),
        width: 140,
      },
    ],
    [navigate],
  );

  const handleStopAll = React.useCallback(() => {
    confirmStopAll({
      onSuccess: () => {
        setLocked(true);
        void loadOverview();
        void loadOpsArtifacts();
      },
    });
  }, [confirmStopAll, loadOpsArtifacts, loadOverview, setLocked]);

  const marginFlag = margin
    ? margin.critical
      ? { label: `${margin.critical} critical`, color: '#dc2626' }
      : margin.warn
        ? { label: `${margin.warn} elevated`, color: '#f97316' }
        : { label: 'Healthy', color: '#16a34a' }
    : null;

  return (
    <Space direction='vertical' size={24} style={{ width: '100%' }}>
      <Card
        style={{ borderRadius: 16, border: '1px solid #e2e8f0' }}
        bodyStyle={{ padding: 24 }}
      >
        <Row gutter={[24, 24]} align='middle'>
          <Col xs={24} lg={16}>
            <Space direction='vertical' size={12} style={{ width: '100%' }}>
              <Space align='center' size={16}>
                <Avatar size={54} style={{ background: `${globalHealth.color}1a`, color: globalHealth.color }}>
                  {globalHealth.icon}
                </Avatar>
                <div>
                  <Title level={3} style={{ margin: 0 }}>Mission Control</Title>
                  <Text type='secondary'>
                    {overview?.activeCount || 0} active agents across {(overview?.symbols || []).length} markets ·
                    <span style={{ marginLeft: 8, color: globalHealth.color }}>Status: {globalHealth.label}</span>
                  </Text>
                </div>
              </Space>
              <Space size={24} wrap>
                <Statistic title='Total ROI' value={Number(overview?.roiPct || 0)} precision={2} suffix='%' valueStyle={{ color: (Number(overview?.roiPct || 0) >= 0) ? '#16a34a' : '#dc2626' }} />
                <Statistic title='Total PnL' prefix='$' value={Number(overview?.pnlUsd || 0)} precision={2} valueStyle={{ color: (Number(overview?.pnlUsd || 0) >= 0) ? '#16a34a' : '#dc2626' }} />
                <Statistic title='AI decisions' value={Number(overview?.aiCallsTotal || 0)} valueStyle={{ color: '#6366f1' }} />
                <Statistic title='Critical alerts' value={overview?.alerts?.severityCounts?.high || 0} valueStyle={{ color: '#dc2626' }} />
              </Space>
            </Space>
          </Col>
          <Col xs={24} lg={8}>
            <Space direction='vertical' size={12} style={{ width: '100%' }}>
              {locked && (
                <Alert
                  type='warning'
                  showIcon
                  message='Emergency lock active'
                  description='Agent creation is disabled until the lock is reset. Stop-all was triggered previously.'
                  action={
                    <Button size='small' onClick={unlock} icon={<ReloadOutlined />}>Reset lock</Button>
                  }
                />
              )}
              <Space size={12} wrap style={{ justifyContent: 'flex-end' }}>
                <Button icon={<RocketOutlined />} onClick={() => setShowScanner((prev) => !prev)}>
                  {showScanner ? 'Hide Opportunity Scanner' : 'Open Opportunity Scanner'}
                </Button>
                <Button type='primary' icon={<PlusOutlined />} onClick={() => navigate('/agents')} disabled={locked}>
                  New agent
                </Button>
                <Button danger icon={<StopOutlined />} onClick={handleStopAll}>
                  Stop all
                </Button>
              </Space>
            </Space>
          </Col>
        </Row>
      </Card>

      {showScanner && (
        <SmartOpportunityScanner
          onSymbolSelect={(symbol) => navigate(`/agents?symbol=${symbol}`)}
          onAutoTrade={(symbol) => navigate(`/agents?symbol=${symbol}&autoStart=true`)}
        />
      )}

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={16}>
          <Card
            title={<Space><FireOutlined style={{ color: '#f97316' }} />Active sessions</Space>}
            extra={
              <Space>
                <Button size='small' onClick={() => void loadOverview()} loading={overviewLoading}>
                  Refresh
                </Button>
                <Button size='small' type='link' onClick={() => navigate('/agents')}>
                  Manage agents
                </Button>
              </Space>
            }
          >
            <Table
              size='small'
              rowKey='id'
              columns={sessionColumns}
              dataSource={sessions}
              loading={overviewLoading}
              pagination={false}
              locale={{ emptyText: overviewLoading ? 'Loading agents…' : 'No active agents' }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card
            title={<Space><WarningOutlined style={{ color: marginFlag?.color || '#0ea5e9' }} />Risk posture</Space>}
            extra={marginFlag ? <Tag color={marginFlag.color}>{marginFlag.label}</Tag> : null}
            loading={opsMetricsLoading}
          >
            {margin ? (
              <Space direction='vertical' size={16} style={{ width: '100%' }}>
                <div>
                  <Text type='secondary'>Average utilisation</Text>
                  <Progress
                    percent={Number.isFinite(margin.averageUtilisationPct) ? Number(margin.averageUtilisationPct.toFixed(1)) : 0}
                    strokeColor={marginFlag?.color || '#0ea5e9'}
                    showInfo
                  />
                  <Space style={{ width: '100%', justifyContent: 'space-between', fontSize: 12, color: '#64748b' }}>
                    <span>{margin.tracked || 0} sessions monitored</span>
                    <span>Updated {margin.lastUpdated ? new Date(margin.lastUpdated).toLocaleTimeString() : '—'}</span>
                  </Space>
                </div>
                <Divider style={{ margin: '8px 0' }} />
                <div>
                  <Text strong style={{ display: 'block', marginBottom: 8 }}>Most exposed</Text>
                  {Array.isArray(margin.worstSessions) && margin.worstSessions.length ? (
                    <List
                      size='small'
                      dataSource={margin.worstSessions.slice(0, 4)}
                      renderItem={(row: any) => (
                        <List.Item>
                          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                            <Space size={8}>
                              <Badge status={row.status === 'critical' ? 'error' : 'warning'} />
                              <Text>{row.symbol || row.sessionId}</Text>
                            </Space>
                            <Text strong>{Number(row.utilisationPct || 0).toFixed(1)}%</Text>
                          </Space>
                        </List.Item>
                      )}
                    />
                  ) : (
                    <Text type='secondary'>All sessions are within safe thresholds.</Text>
                  )}
                </div>
              </Space>
            ) : (
              <Text type='secondary'>No margin data available.</Text>
            )}
          </Card>

          <OpsEventsList events={opsEvents} loading={opsEventsLoading} onRefresh={() => void loadOpsArtifacts()} />
        </Col>
      </Row>

      <AgentHealthTable data={agentHealth} loading={agentHealthLoading} onRefresh={() => void loadOpsArtifacts()} />

      <OpsMetricsPanel metrics={opsMetrics} loading={opsMetricsLoading} />
    </Space>
  );
};

export default MissionControlPage;
