import React from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
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
  ExclamationCircleOutlined,
  ReloadOutlined,
  StopOutlined,
  WarningOutlined,
  CheckCircleOutlined,
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
  bias?: string;
  aggressiveness?: string;
  lastExecutionTs?: number;
  lastTradeAt?: number;
};

const statusColor: Record<string, string> = {
  MANAGE: 'blue',
  ARMED: 'green',
  HALTED: 'red',
};

const biasColor: Record<string, string> = {
  long: 'green',
  short: 'volcano',
  neutral: 'default',
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

function resolveGlobalHealth(overview: any) {
  const alertCounts = overview?.alerts?.severityCounts || {};
  const high = alertCounts.high || 0;
  const med = alertCounts.med || 0;
  const active = overview?.activeCount || 0;

  if (high > 0) {
    return {
      tone: 'error' as const,
      icon: <ExclamationCircleOutlined />,
      color: '#dc2626',
      label: 'Critical risk',
      description: 'Immediate action required on highlighted agents.'
    };
  }
  if (med > 2 || (med > 0 && active > 3)) {
    return {
      tone: 'warning' as const,
      icon: <WarningOutlined />,
      color: '#f97316',
      label: 'Degraded',
      description: 'Monitor protective sync and ops alerts closely.'
    };
  }
  if (active > 0) {
    return {
      tone: 'success' as const,
      icon: <CheckCircleOutlined />,
      color: '#16a34a',
      label: 'Nominal',
      description: 'Agents running with no major incident.'
    };
  }
  return {
    tone: 'info' as const,
    icon: <StopOutlined />,
    color: '#94a3b8',
    label: 'Idle',
    description: 'No active agents detected.'
  };
}

const MissionControlPage: React.FC = () => {
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
        This will halt every agent, cancel open orders and flatten positions. Creation of new agents will remain disabled until
        the lock is reset.
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

  const sessions: OverviewSession[] = React.useMemo(
    () => (Array.isArray(overview?.sessions) ? overview.sessions : []),
    [overview?.sessions],
  );

  const margin = opsMetrics?.margin;
  const opsAlerts = Array.isArray(overview?.alerts?.items) ? overview.alerts.items.slice(0, 4) : [];
  const globalHealth = resolveGlobalHealth(overview);

  const columns = React.useMemo<ColumnsType<OverviewSession>>(
    () => [
      {
        title: 'Agent',
        key: 'agent',
        render: (_value, record) => (
          <Space direction='vertical' size={0}>
            <Space size={6}>
              <Badge color={record.mode === 'live' ? '#f59e0b' : '#3b82f6'} text={record.symbol || 'Unknown'} />
              {record.aggressiveness && (
                <Tag
                  color={
                    record.aggressiveness === 'aggressive'
                      ? 'red'
                      : record.aggressiveness === 'reactive'
                        ? 'orange'
                        : 'blue'
                  }
                >
                  {record.aggressiveness.toUpperCase()}
                </Tag>
              )}
            </Space>
            <Text type='secondary' style={{ fontSize: 12 }}>
              {record.id}
            </Text>
          </Space>
        ),
      },
      {
        title: 'State',
        dataIndex: 'state',
        key: 'state',
        width: 120,
        render: (value: string | undefined) =>
          value ? <Tag color={statusColor[value] || 'default'}>{value}</Tag> : <Text type='secondary'>—</Text>,
      },
      {
        title: 'Bias',
        dataIndex: 'bias',
        key: 'bias',
        width: 120,
        render: (value: string | undefined) =>
          value ? <Tag color={biasColor[value] || 'default'}>{value.toUpperCase()}</Tag> : <Text type='secondary'>—</Text>,
      },
      {
        title: 'ROI',
        dataIndex: 'roiPct',
        key: 'roiPct',
        width: 120,
        align: 'right',
        render: (value: number | undefined) => (
          <Text style={{ color: (value || 0) >= 0 ? '#16a34a' : '#dc2626' }}>{Number(value || 0).toFixed(2)}%</Text>
        ),
      },
      {
        title: 'PnL',
        dataIndex: 'pnlUsd',
        key: 'pnlUsd',
        width: 120,
        align: 'right',
        render: (value: number | undefined) => (
          <Text style={{ color: (value || 0) >= 0 ? '#16a34a' : '#dc2626' }}>${Number(value || 0).toFixed(2)}</Text>
        ),
      },
      {
        title: 'Last execution',
        key: 'lastExecutionTs',
        width: 160,
        render: (_value, record) => (
          <Tooltip
            title={record.lastExecutionTs ? new Date(record.lastExecutionTs).toLocaleString() : undefined}
          >
            <Text type='secondary'>{formatRelative(record.lastExecutionTs || record.lastTradeAt)}</Text>
          </Tooltip>
        ),
      },
      {
        key: 'action',
        width: 140,
        render: (_value, record) => (
          <Button type='link' onClick={() => navigate(`/agents/${record.id}`)}>
            Open cockpit
          </Button>
        ),
      },
    ],
    [navigate],
  );

  const marginStatus = margin
    ? margin.critical
      ? { label: `${margin.critical} critical`, color: '#dc2626', percent: Math.min(100, Number(margin.averageUtilisationPct || 0)) }
      : margin.warn
        ? { label: `${margin.warn} elevated`, color: '#f97316', percent: Math.min(100, Number(margin.averageUtilisationPct || 0)) }
        : { label: 'Healthy', color: '#16a34a', percent: Math.min(100, Number(margin.averageUtilisationPct || 0)) }
    : null;

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
                Mission Control
              </Title>
              <Text type='secondary'>Unified status of every running agent and operational signal.</Text>
            </Space>
          </Space>
        }
        extra={
          <Space size={12}>
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
        <Row gutter={[24, 16]}>
          <Col xs={12} md={6}>
            <Statistic title='Active agents' value={overview?.activeCount || 0} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title='Markets tracked' value={Array.isArray(overview?.symbols) ? overview.symbols.length : 0} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title='ROI'
              value={Number(overview?.roiPct || 0).toFixed(2)}
              suffix='%'
              valueStyle={{ color: Number(overview?.roiPct || 0) >= 0 ? '#16a34a' : '#dc2626' }}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title='Net PnL'
              value={`$${Number(overview?.pnlUsd || 0).toFixed(2)}`}
              valueStyle={{ color: Number(overview?.pnlUsd || 0) >= 0 ? '#16a34a' : '#dc2626' }}
            />
          </Col>
        </Row>
        {marginStatus && (
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
              <Tag color={marginStatus.color}>{marginStatus.label}</Tag>
            </Space>
            <Progress percent={Number(marginStatus.percent.toFixed(1))} strokeColor={marginStatus.color} />
            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', marginTop: 8, fontSize: 12 }}>
              <span>{margin?.tracked || 0} sessions tracked</span>
              <span>
                Updated {margin?.lastUpdated ? new Date(margin.lastUpdated).toLocaleTimeString() : '—'}
              </span>
            </div>
          </div>
        )}
      </Card>

      {opsAlerts.length > 0 && (
        <Alert
          type={globalHealth.tone}
          showIcon
          message={`${opsAlerts.length} open alert${opsAlerts.length > 1 ? 's' : ''}`}
          description={
            <List
              size='small'
              dataSource={opsAlerts}
              renderItem={(item: any) => (
                <List.Item>
                  <Space size={8}>
                    <Tag color={item.severity === 'high' ? 'red' : 'orange'}>{item.severity?.toUpperCase()}</Tag>
                    <span>{item.message}</span>
                    {item.sessionId && (
                      <Button type='link' size='small' onClick={() => navigate(`/agents/${item.sessionId}`)}>
                        View agent
                      </Button>
                    )}
                  </Space>
                </List.Item>
              )}
            />
          }
        />
      )}

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={14}>
          <Card title='Active agents' bodyStyle={{ padding: 0 }} style={{ borderRadius: 12 }}>
            <Table
              rowKey='id'
              columns={columns}
              dataSource={sessions}
              pagination={false}
              size='small'
              locale={{ emptyText: 'No agents running yet.' }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <OpsMetricsPanel metrics={opsMetrics} loading={refreshing} />
        </Col>
      </Row>

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={12}>
          <AgentHealthTable data={agentHealth} loading={agentHealthLoading} onRefresh={() => void refreshAll()} />
        </Col>
        <Col xs={24} xl={12}>
          <OpsEventsList events={opsEvents} loading={refreshing} onRefresh={() => void refreshAll()} />
        </Col>
      </Row>
    </Space>
  );
};

export default MissionControlPage;
