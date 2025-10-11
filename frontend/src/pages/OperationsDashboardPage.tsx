import React from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Divider,
  Empty,
  Row,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  StopOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useDashboard } from '../hooks/useDashboard';
import { useMode } from '../contexts/ModeContext';
import OpsMetricsPanel from '../components/OpsMetricsPanel';
import OpsEventsList from '../components/OpsEventsList';
import AgentHealthTable from '../components/AgentHealthTable';
import { useStopAllLock } from '../hooks/useStopAllLock';
import { useStopAllConfirmation } from '../hooks/useStopAllConfirmation';
import { api } from '../api';

const { Title, Text } = Typography;

type OverviewSession = {
  id: string;
  symbol?: string;
  mode?: string;
  state?: string;
  pnlUsd?: number;
  roiPct?: number;
  winRate?: number;
  trades?: number;
  aggressiveness?: string;
  lastExecutionTs?: number;
  lastTradeAt?: number;
};

type HealthSnapshot = {
  sessionId: string;
  hasPosition: boolean;
  tradeCount24h: number;
  lastExecutionTs: number | null;
  status: 'ok' | 'idle' | 'stale' | 'blocked';
};

type DecoratedSession = OverviewSession & {
  hasPosition: boolean;
  tradeCount24h: number | null;
  healthStatus: HealthSnapshot['status'] | null;
};

const stateTheme: Record<string, { bg: string; border: string; text: string }> = {
  MANAGE: { bg: '#ecfdf5', border: '#059669', text: '#065f46' },
  ARMED: { bg: '#eff6ff', border: '#2563eb', text: '#1d4ed8' },
  HALT: { bg: '#fef2f2', border: '#dc2626', text: '#991b1b' },
  UNKNOWN: { bg: '#f8fafc', border: '#cbd5f5', text: '#1f2937' },
};

const healthTone: Record<string, { color: string; label: string }> = {
  ok: { color: 'green', label: 'Nominal' },
  idle: { color: 'geekblue', label: 'Idle' },
  stale: { color: 'orange', label: 'Stale' },
  blocked: { color: 'red', label: 'Blocked' },
};

function formatRelative(ts?: number | null) {
  if (!ts) return '—';
  const delta = Date.now() - ts;
  if (delta < 60_000) return 'Just now';
  if (delta < 3_600_000) {
    const minutes = Math.round(delta / 60_000);
    return `${minutes} min ago`;
  }
  const hours = Math.round(delta / 3_600_000);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatPercent(value?: number | null, digits = 2) {
  if (value == null || Number.isNaN(value)) return '0.00%';
  return `${Number(value).toFixed(digits)}%`;
}

function formatUsd(value?: number | null, digits = 2) {
  if (value == null || Number.isNaN(value)) return '$0.00';
  return `$${Number(value).toFixed(digits)}`;
}

type GlobalHealth = {
  tone: 'success' | 'warning' | 'error' | 'info';
  icon: React.ReactNode;
  color: string;
  label: string;
  description: string;
};

function resolveGlobalHealth(metrics?: any): GlobalHealth {
  const alerts = metrics?.alerts?.lastHour ?? {};
  const protectiveIssues = Number(metrics?.positions?.protectiveIssues || 0);
  const halted = Number(metrics?.sessions?.halted || 0);
  const managing = Number(metrics?.sessions?.managing || 0);

  if ((alerts.high ?? 0) > 0 || protectiveIssues > 0) {
    return {
      tone: 'error',
      icon: <ExclamationCircleOutlined />,
      color: '#dc2626',
      label: 'Critical risk',
      description: 'Resolve protective issues and high-severity alerts immediately.',
    };
  }
  if (halted > 0 || (alerts.med ?? 0) > 2) {
    return {
      tone: 'warning',
      icon: <WarningOutlined />,
      color: '#f97316',
      label: 'Degraded',
      description: 'Some agents require attention before resuming normal operations.',
    };
  }
  if (managing > 0) {
    return {
      tone: 'success',
      icon: <CheckCircleOutlined />,
      color: '#16a34a',
      label: 'Nominal',
      description: 'Agents are trading and protective systems are green.',
    };
  }
  return {
    tone: 'info',
    icon: <StopOutlined />,
    color: '#64748b',
    label: 'Idle',
    description: 'No active agents detected in the current mode.',
  };
}

const OperationsDashboardPage: React.FC = () => {
  const navigate = useNavigate();
  const { mode } = useMode();
  const {
    overview,
    opsMetrics,
    opsEvents,
    loadOverview,
    loadOpsMetrics,
    loadOpsEvents,
  } = useDashboard();

  const [refreshing, setRefreshing] = React.useState(false);
  const [agentHealth, setAgentHealth] = React.useState<any>(null);
  const [agentHealthLoading, setAgentHealthLoading] = React.useState(false);
  const { locked, unlock, setLocked } = useStopAllLock();
  const confirmStopAll = useStopAllConfirmation({
    description: (
      <span>
        This will halt every agent, cancel open orders and flatten positions. Creation of new agents will remain disabled until the lock is reset.
      </span>
    ),
  });

  const refreshAll = React.useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        loadOverview(true),
        loadOpsMetrics(),
        loadOpsEvents(),
        (async () => {
          setAgentHealthLoading(true);
          try {
            const data = await api.getAgentHealth();
            setAgentHealth(data);
          } finally {
            setAgentHealthLoading(false);
          }
        })(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [loadOverview, loadOpsMetrics, loadOpsEvents]);

  React.useEffect(() => {
    void refreshAll();
  }, [refreshAll, mode]);

  const handleStopAll = React.useCallback(() => {
    confirmStopAll({
      onSuccess: () => {
        setLocked(true);
        void refreshAll();
      },
    });
  }, [confirmStopAll, refreshAll, setLocked]);

  const rawSessions: OverviewSession[] = React.useMemo(
    () => (Array.isArray(overview?.sessions) ? overview.sessions : []),
    [overview?.sessions],
  );

  const healthMap = React.useMemo(() => {
    const rows: HealthSnapshot[] = Array.isArray(opsMetrics?.agentHealth?.agents)
      ? opsMetrics.agentHealth.agents
      : [];
    return new Map(rows.map((row) => [row.sessionId, row]));
  }, [opsMetrics?.agentHealth?.agents]);

  const sessions: DecoratedSession[] = React.useMemo(() => {
    return rawSessions
      .map((session) => {
        const health = healthMap.get(session.id);
        return {
          ...session,
          hasPosition: Boolean(health?.hasPosition),
          tradeCount24h: health?.tradeCount24h ?? null,
          healthStatus: health?.status ?? null,
          lastExecutionTs: health?.lastExecutionTs ?? session.lastExecutionTs ?? session.lastTradeAt,
        };
      })
      .sort((a, b) => Number(b.hasPosition) - Number(a.hasPosition));
  }, [rawSessions, healthMap]);

  const latestEvents = React.useMemo(
    () => (Array.isArray(opsEvents) ? opsEvents.slice(0, 5) : []),
    [opsEvents],
  );

  const globalHealth = resolveGlobalHealth(opsMetrics);
  const marginSummary = opsMetrics?.margin ?? null;
  const metricsTimestamp = opsMetrics?.timestamp
    ? new Date(opsMetrics.timestamp).toLocaleTimeString()
    : '—';

  return (
    <Space direction='vertical' size={24} style={{ width: '100%' }}>
      <Card
        style={{ borderRadius: 16, border: '1px solid #e2e8f0' }}
        bodyStyle={{ padding: 24 }}
        title={
          <Space align='center' size={16}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: globalHealth.color,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: 20,
              }}
            >
              {globalHealth.icon}
            </div>
            <Space direction='vertical' size={0}>
              <Title level={4} style={{ margin: 0 }}>
                Operations Dashboard
              </Title>
              <Text type='secondary'>Realtime overview of every running agent, positions and governance signals.</Text>
            </Space>
          </Space>
        }
        extra={
          <Space size={12}>
            <Tag color='default'>Mode: {mode?.toUpperCase?.()}</Tag>
            <Tag color='default'>Last metrics: {metricsTimestamp}</Tag>
            {locked ? (
              <Button onClick={unlock}>Unlock creation</Button>
            ) : (
              <Button danger icon={<StopOutlined />} onClick={handleStopAll}>
                Emergency stop all
              </Button>
            )}
            <Button icon={<ReloadOutlined />} onClick={() => void refreshAll()} loading={refreshing}>
              Refresh
            </Button>
          </Space>
        }
      >
        <Alert
          type={globalHealth.tone}
          showIcon
          message={globalHealth.label}
          description={globalHealth.description}
          style={{ marginBottom: 24 }}
        />

        <Row gutter={[24, 16]}>
          <Col xs={12} md={6}>
            <Statistic title='Active agents' value={overview?.activeCount || 0} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title='Agents total' value={opsMetrics?.agents?.total || 0} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title='Open positions'
              value={opsMetrics?.positions?.open || 0}
              valueStyle={{ color: (opsMetrics?.positions?.open || 0) > 0 ? '#0f766e' : undefined }}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title='Protective issues'
              value={opsMetrics?.positions?.protectiveIssues || 0}
              valueStyle={{ color: (opsMetrics?.positions?.protectiveIssues || 0) > 0 ? '#b45309' : undefined }}
            />
          </Col>
        </Row>

        <Divider style={{ margin: '24px 0' }} />

        <Row gutter={[24, 16]}>
          <Col xs={12} md={6}>
            <Statistic
              title='Portfolio ROI'
              value={Number(overview?.roiPct || 0).toFixed(2)}
              suffix='%'
              valueStyle={{ color: Number(overview?.roiPct || 0) >= 0 ? '#16a34a' : '#dc2626' }}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title='Net PnL'
              value={formatUsd(overview?.pnlUsd)}
              valueStyle={{ color: Number(overview?.pnlUsd || 0) >= 0 ? '#16a34a' : '#dc2626' }}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title='Win rate'
              value={formatPercent(overview?.avgWinRate, 1)}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title='Alerts (1h)'
              value={opsMetrics?.alerts?.lastHour?.total || 0}
            />
          </Col>
        </Row>

        {marginSummary && (
          <div
            style={{
              marginTop: 24,
              padding: 16,
              border: '1px solid #e2e8f0',
              borderRadius: 12,
              background: '#f8fafc',
            }}
          >
            <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text strong>Margin utilisation</Text>
              <Tag color={marginSummary.critical ? 'red' : marginSummary.warn ? 'orange' : 'green'}>
                {marginSummary.critical ? `${marginSummary.critical} critical` : marginSummary.warn ? `${marginSummary.warn} elevated` : 'Healthy'}
              </Tag>
            </Space>
            <Text type='secondary'>Average utilisation: {Number(marginSummary.averageUtilisationPct || 0).toFixed(1)}%</Text>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', marginTop: 8, fontSize: 12 }}>
              <span>{marginSummary.tracked || 0} sessions tracked</span>
              <span>Updated {marginSummary.lastUpdated ? new Date(marginSummary.lastUpdated).toLocaleTimeString() : '—'}</span>
            </div>
          </div>
        )}
      </Card>

      <Row gutter={[24, 24]} align='stretch'>
        <Col xs={24} xl={14}>
          <Card title='Agent overview' bodyStyle={{ padding: 0, paddingBottom: 16 }} style={{ borderRadius: 12 }}>
            {sessions.length === 0 ? (
              <Empty description='No active agents in this mode.' style={{ margin: '32px 0' }} />
            ) : (
              <Space direction='vertical' size={16} style={{ width: '100%', padding: 16 }}>
                {sessions.map((session) => {
                  const palette = stateTheme[session.state || 'UNKNOWN'] || stateTheme.UNKNOWN;
                  const health = session.healthStatus ? healthTone[session.healthStatus] : null;

                  return (
                    <div
                      key={session.id}
                      style={{
                        borderRadius: 12,
                        border: `1px solid ${palette.border}`,
                        background: palette.bg,
                        padding: 16,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 12,
                      }}
                    >
                      <Space align='center' style={{ width: '100%', justifyContent: 'space-between' }} wrap>
                        <Space size={8} wrap>
                          <Badge color={session.mode === 'live' ? '#f59e0b' : '#3b82f6'} text={session.symbol || 'Unknown'} />
                          {session.aggressiveness && (
                            <Tag color={session.aggressiveness === 'aggressive' ? 'red' : session.aggressiveness === 'reactive' ? 'orange' : 'blue'}>
                              {session.aggressiveness.toUpperCase()}
                            </Tag>
                          )}
                          {session.state && <Tag color={palette.border}>{session.state}</Tag>}
                          {session.hasPosition && <Tag color='geekblue'>In position</Tag>}
                          {health && <Tag color={health.color}>{health.label}</Tag>}
                        </Space>
                        <Button type='link' onClick={() => navigate(`/agents/${session.id}`)}>
                          Open cockpit
                        </Button>
                      </Space>

                      <Row gutter={[16, 12]}>
                        <Col xs={12} md={6}>
                          <Text type='secondary' style={{ display: 'block', fontSize: 12 }}>ROI</Text>
                          <Text style={{ color: (session.roiPct || 0) >= 0 ? '#15803d' : '#dc2626', fontWeight: 600 }}>
                            {formatPercent(session.roiPct)}
                          </Text>
                        </Col>
                        <Col xs={12} md={6}>
                          <Text type='secondary' style={{ display: 'block', fontSize: 12 }}>PnL</Text>
                          <Text style={{ color: (session.pnlUsd || 0) >= 0 ? '#15803d' : '#dc2626', fontWeight: 600 }}>
                            {formatUsd(session.pnlUsd)}
                          </Text>
                        </Col>
                        <Col xs={12} md={6}>
                          <Text type='secondary' style={{ display: 'block', fontSize: 12 }}>Win rate</Text>
                          <Text style={{ fontWeight: 600 }}>{formatPercent(session.winRate, 1)}</Text>
                        </Col>
                        <Col xs={12} md={6}>
                          <Text type='secondary' style={{ display: 'block', fontSize: 12 }}>Trades (24h)</Text>
                          <Text style={{ fontWeight: 600 }}>{session.tradeCount24h ?? 0}</Text>
                        </Col>
                        <Col xs={12} md={6}>
                          <Text type='secondary' style={{ display: 'block', fontSize: 12 }}>Total trades</Text>
                          <Text style={{ fontWeight: 600 }}>{session.trades ?? 0}</Text>
                        </Col>
                        <Col xs={12} md={6}>
                          <Text type='secondary' style={{ display: 'block', fontSize: 12 }}>Last execution</Text>
                          <Tooltip title={session.lastExecutionTs ? new Date(session.lastExecutionTs).toLocaleString() : undefined}>
                            <Text style={{ fontWeight: 600 }}>{formatRelative(session.lastExecutionTs)}</Text>
                          </Tooltip>
                        </Col>
                      </Row>

                      <Text type='secondary' style={{ fontSize: 12 }}>{session.id}</Text>
                    </div>
                  );
                })}
              </Space>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <OpsMetricsPanel metrics={opsMetrics} loading={refreshing} />
        </Col>
      </Row>

      <Row gutter={[24, 24]} align='stretch'>
        <Col xs={24} xl={12}>
          <OpsEventsList events={latestEvents} loading={refreshing} onRefresh={() => void refreshAll()} />
        </Col>
        <Col xs={24} xl={12}>
          <AgentHealthTable data={agentHealth} loading={agentHealthLoading} onRefresh={() => void refreshAll()} />
        </Col>
      </Row>
    </Space>
  );
};

export default OperationsDashboardPage;
