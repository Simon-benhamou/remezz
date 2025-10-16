import React from 'react';
import {
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Row,
  Space,
  Tag,
  Typography,
  theme,
} from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import RecentTradesTable from '../components/RecentTradesTable';
import AgentHealthTable from '../components/AgentHealthTable';
import PerformanceOverviewCard from '../components/PerformanceOverviewCard';
import { useDashboard } from '../hooks/useDashboard';

const { Title, Text } = Typography;

type GlobalHealth = {
  tone: 'success' | 'warning' | 'error' | 'info';
  icon: React.ReactNode;
  color: string;
  label: string;
  description: string;
};

type OpsEvent = {
  id: string;
  ts?: number;
  level?: 'info' | 'warn' | 'error';
  source?: string;
  message?: string;
  sessionId?: string;
  symbol?: string;
  details?: any;
};

function formatPercent(value?: number | null, digits = 1) {
  if (value == null || Number.isNaN(value)) return '0%';
  return `${Number(value).toFixed(digits)}%`;
}

function formatUsd(value?: number | null, digits = 2) {
  if (value == null || Number.isNaN(value)) return '$0.00';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(Number(value)).toFixed(digits)}`;
}

function formatRelative(ts?: number | null) {
  if (!ts) return '—';
  const delta = Date.now() - ts;
  if (delta < 60_000) return 'Just now';
  if (delta < 3_600_000) {
    const minutes = Math.round(delta / 60_000);
    return `${minutes} min ago`;
  }
  if (delta < 86_400_000) {
    const hours = Math.round(delta / 3_600_000);
    return `${hours}h ago`;
  }
  const days = Math.round(delta / 86_400_000);
  return `${days}d ago`;
}

function resolveGlobalHealth(metrics?: any): GlobalHealth {
  const alerts = metrics?.alerts?.lastHour ?? {};
  const protectiveIssues = Number(metrics?.positions?.protectiveIssues || 0);
  const halted = Number(metrics?.sessions?.halted || 0);
  const managing = Number(metrics?.sessions?.managing || 0);

  if ((alerts.high ?? 0) > 0 || protectiveIssues > 0) {
    return {
      tone: 'error',
      icon: <ExclamationCircleOutlined />,
      color: '#f87171',
      label: 'Critical risk',
      description: 'Resolve protective gaps and high-severity alerts immediately.',
    };
  }
  if (halted > 0 || (alerts.med ?? 0) > 2) {
    return {
      tone: 'warning',
      icon: <WarningOutlined />,
      color: '#fbbf24',
      label: 'Degraded',
      description: 'Some agents require attention before resuming normal ops.',
    };
  }
  if (managing > 0) {
    return {
      tone: 'success',
      icon: <CheckCircleOutlined />,
      color: '#34d399',
      label: 'Operational',
      description: 'Agents are trading and protective systems are green.',
    };
  }
  return {
    tone: 'info',
    icon: <ThunderboltOutlined />,
    color: '#60a5fa',
    label: 'Idle',
    description: 'No active agents detected in the current mode.',
  };
}

const severityMeta: Record<string, { color: string; label: string }> = {
  info: { color: '#38bdf8', label: 'Info' },
  warn: { color: '#fbbf24', label: 'Watch' },
  error: { color: '#f87171', label: 'Action' },
};

const OperationsDashboardPage: React.FC = () => {
  const navigate = useNavigate();
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
  const [recentTrades, setRecentTrades] = React.useState<any[]>([]);
  const [recentTradesLoading, setRecentTradesLoading] = React.useState(false);
  const [activityDrawerOpen, setActivityDrawerOpen] = React.useState(false);

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
        (async () => {
          setRecentTradesLoading(true);
          try {
            const trades = await api.getTrades(undefined, { limit: 120 });
            setRecentTrades(Array.isArray(trades) ? trades : []);
          } finally {
            setRecentTradesLoading(false);
          }
        })(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [loadOverview, loadOpsMetrics, loadOpsEvents]);

  React.useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const { token } = theme.useToken();
  const metricsTimestamp = opsMetrics?.timestamp
    ? new Date(opsMetrics.timestamp).toLocaleTimeString()
    : '—';

  const totalEquityUsd = Number(
    overview?.equityUsd ||
      overview?.paperBalance?.equityUsd ||
      overview?.exchangeBalance?.totalUsd ||
      0,
  );
  const pnlUsd = Number(overview?.pnlUsd || 0);
  const roiPct = Number(overview?.roiPct || 0);
  const activeAgents = Number(overview?.activeCount || 0);
  const marketsTracked = Array.isArray(overview?.symbols) ? overview?.symbols.length : 0;

  const totalTrades24h = React.useMemo(() => {
    if (!agentHealth?.agents) return 0;
    return agentHealth.agents.reduce((acc: number, row: any) => acc + Number(row.tradeCount24h || 0), 0);
  }, [agentHealth]);

  const tradesSummary = React.useMemo(() => {
    if (!recentTrades.length) {
      return { totalPnl: 0, winRate: 0, lastTradeAt: null as number | null };
    }
    let wins = 0;
    let losses = 0;
    let totalPnlAcc = 0;
    let lastTs = 0;
    for (const trade of recentTrades) {
      const pnl = Number(trade?.realizedPnlUsd || 0);
      totalPnlAcc += pnl;
      if (pnl > 0) wins += 1;
      else if (pnl < 0) losses += 1;
      const ts = trade?.createdAt ? new Date(trade.createdAt).getTime() : 0;
      if (ts > lastTs) lastTs = ts;
    }
    const total = wins + losses;
    return {
      totalPnl: totalPnlAcc,
      winRate: total > 0 ? (wins / total) * 100 : 0,
      lastTradeAt: lastTs || null,
    };
  }, [recentTrades]);

  const latestEvents = React.useMemo(
    () => (Array.isArray(opsEvents) ? opsEvents.slice(0, 6) : []),
    [opsEvents],
  );

  const globalHealth = resolveGlobalHealth(opsMetrics);

  const heroMetrics = [
    {
      key: 'balance',
      label: 'Equity',
      value: formatUsd(totalEquityUsd),
      helper: `PnL ${formatUsd(pnlUsd)}`,
      tone: '#38bdf8',
    },
    {
      key: 'roi',
      label: 'ROI',
      value: formatPercent(roiPct, 2),
      helper: roiPct >= 0 ? 'Above benchmark' : 'Drawdown',
      tone: roiPct >= 0 ? '#34d399' : '#f87171',
    },
    {
      key: 'agents',
      label: 'Active agents',
      value: activeAgents.toString(),
      helper: `${marketsTracked} markets`,
      tone: '#a855f7',
    },
    {
      key: 'activity',
      label: '24h executions',
      value: totalTrades24h.toString(),
      helper: tradesSummary.lastTradeAt ? `Last ${formatRelative(tradesSummary.lastTradeAt)}` : 'Waiting fill',
      tone: '#fbbf24',
    },
  ];

  const diagnosticsEntries = React.useMemo(() => {
    const diagnostics = (opsMetrics?.diagnostics ?? opsMetrics?.health) as Record<string, any> | undefined;
    if (!diagnostics || typeof diagnostics !== 'object') return [] as Array<[string, string]>;
    return Object.entries(diagnostics)
      .filter(([key]) => !['timestamp', 'ts'].includes(key))
      .slice(0, 6)
      .map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value || '—')]);
  }, [opsMetrics]);

  const strategyHighlights = React.useMemo(() => {
    const raw = opsMetrics?.strategy?.conditions
      || opsMetrics?.strategy?.signals
      || opsMetrics?.strategy?.highlights;
    if (Array.isArray(raw)) {
      return raw.slice(0, 6).map((item: any, idx: number) => ({
        key: String(item?.id ?? idx),
        label: typeof item === 'string' ? item : item?.label ?? item?.title ?? 'Signal',
        detail: typeof item === 'string' ? undefined : item?.detail ?? item?.value,
      }));
    }
    if (raw && typeof raw === 'object') {
      return Object.entries(raw).slice(0, 6).map(([key, value]) => ({
        key,
        label: key,
        detail: typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—'),
      }));
    }
    return [] as Array<{ key: string; label: string; detail?: string }>;
  }, [opsMetrics]);

  return (
    <Space direction='vertical' size={24} style={{ width: '100%' }}>
      <Card
        style={{
          borderRadius: 24,
          border: '1px solid rgba(96, 165, 250, 0.25)',
          background: 'radial-gradient(circle at top left, rgba(30, 64, 175, 0.75), rgba(8, 15, 35, 0.92))',
          overflow: 'hidden',
        }}
        bodyStyle={{ padding: 28 }}
      >
        <Row gutter={[32, 24]} align='middle' justify='space-between'>
          <Col xs={24} md={14}>
            <Space direction='vertical' size={12} style={{ width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Tag color='geekblue' style={{ borderRadius: 999, fontWeight: 600 }}>
                  Mission Control
                </Tag>
                <Tag color='blue' style={{ borderRadius: 999 }}>Snapshot {metricsTimestamp}</Tag>
              </div>
              <Title level={2} style={{ margin: 0, color: '#f8fafc' }}>
                Ops overview
              </Title>
              <Text style={{ color: 'rgba(226, 232, 240, 0.78)', maxWidth: 520 }}>
                A concise look at capital, performance and active automation across your agents.
              </Text>
              <Space size={16} wrap>
                {heroMetrics.map((metric) => (
                  <div
                    key={metric.key}
                    style={{
                      background: 'rgba(15, 23, 42, 0.6)',
                      borderRadius: 18,
                      padding: '12px 18px',
                      border: `1px solid ${metric.tone}33`,
                      minWidth: 140,
                    }}
                  >
                    <div style={{ fontSize: 12, color: 'rgba(148, 163, 184, 0.75)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
                      {metric.label}
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: metric.tone }}>{metric.value}</div>
                    <div style={{ fontSize: 12, color: 'rgba(226, 232, 240, 0.7)' }}>{metric.helper}</div>
                  </div>
                ))}
              </Space>
            </Space>
          </Col>
          <Col xs={24} md={10}>
            <Space direction='vertical' size={16} style={{ width: '100%' }}>
              <Card
                style={{
                  borderRadius: 18,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  background: 'rgba(15, 23, 42, 0.65)',
                }}
                bodyStyle={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}
              >
                <Space align='center' size={12}>
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 14,
                      background: `${globalHealth.color}22`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: globalHealth.color,
                      fontSize: 18,
                    }}
                  >
                    {globalHealth.icon}
                  </div>
                  <Space direction='vertical' size={2}>
                    <Text style={{ color: '#f8fafc', fontWeight: 600 }}>{globalHealth.label}</Text>
                    <Text style={{ color: 'rgba(226, 232, 240, 0.75)', fontSize: 12 }}>{globalHealth.description}</Text>
                  </Space>
                </Space>
                <Divider style={{ margin: '8px 0', borderColor: 'rgba(148, 163, 184, 0.25)' }} />
                <Space size={12} wrap>
                  <Button
                    type='primary'
                    icon={<ReloadOutlined />}
                    onClick={() => void refreshAll()}
                    loading={refreshing || recentTradesLoading || agentHealthLoading}
                    style={{ borderRadius: 12 }}
                  >
                    Refresh data
                  </Button>
                  <Button
                    type='default'
                    onClick={() => setActivityDrawerOpen(true)}
                    style={{ borderRadius: 12, color: '#60a5fa', borderColor: 'rgba(96, 165, 250, 0.4)', background: 'rgba(15, 23, 42, 0.6)' }}
                  >
                    Activity feed
                  </Button>
                </Space>
              </Card>
            </Space>
          </Col>
        </Row>
      </Card>

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={16}>
          <Space direction='vertical' size={24} style={{ width: '100%' }}>
            <PerformanceOverviewCard
              trades={recentTrades}
              loading={recentTradesLoading || refreshing}
              title='Portfolio performance'
              subtitle='Cumulative realised PnL across monitored sessions'
              tagLabel='Realtime'
            />
            <Row gutter={[24, 24]}>
              <Col xs={24} md={12}>
                <Card
                  title={<span style={{ color: '#e2e8f0' }}>Strategy signals</span>}
                  style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
                  bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 220 }}
                >
                  {strategyHighlights.length === 0 ? (
                    <Empty description='No active signals' style={{ margin: '24px 0', color: 'rgba(148, 163, 184, 0.75)' }} />
                  ) : (
                    strategyHighlights.map((item) => (
                      <div
                        key={item.key}
                        style={{
                          padding: '12px 14px',
                          borderRadius: 12,
                          background: 'rgba(15, 23, 42, 0.7)',
                          border: '1px solid rgba(96, 165, 250, 0.25)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                        }}
                      >
                        <Text style={{ color: '#f8fafc', fontWeight: 600 }}>{item.label}</Text>
                        {item.detail && <Text style={{ color: 'rgba(226, 232, 240, 0.72)' }}>{item.detail}</Text>}
                      </div>
                    ))
                  )}
                </Card>
              </Col>
              <Col xs={24} md={12}>
                <Card
                  title={<span style={{ color: '#e2e8f0' }}>Diagnostics</span>}
                  style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
                >
                  {diagnosticsEntries.length === 0 ? (
                    <Empty description='No diagnostics reported' style={{ margin: '24px 0', color: 'rgba(148, 163, 184, 0.75)' }} />
                  ) : (
                    <Descriptions column={1} colon={false} labelStyle={{ color: 'rgba(148, 163, 184, 0.78)' }} contentStyle={{ color: '#f8fafc' }}>
                      {diagnosticsEntries.map(([key, value]) => (
                        <Descriptions.Item key={key} label={key.replace(/([A-Z])/g, ' $1').trim()}>
                          {value}
                        </Descriptions.Item>
                      ))}
                    </Descriptions>
                  )}
                </Card>
              </Col>
            </Row>
            <RecentTradesTable
              trades={recentTrades}
              loading={recentTradesLoading || refreshing}
              onRefresh={() => void refreshAll()}
            />
          </Space>
        </Col>
        <Col xs={24} xl={8}>
          <Space direction='vertical' size={24} style={{ width: '100%' }}>
            <Card
              title={<span style={{ color: '#e2e8f0' }}>Agent status</span>}
              style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
              bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 16 }}
            >
              <Space direction='vertical' size={12}>
                <Space size={10} align='center'>
                  <Badge color={globalHealth.color} />
                  <Text style={{ color: 'rgba(226, 232, 240, 0.85)' }}>{globalHealth.description}</Text>
                </Space>
                <Space size={10} wrap>
                  <Tag color='geekblue'>AI calls {Number(opsMetrics?.ai?.totalCalls ?? overview?.aiCallsTotal ?? 0)}</Tag>
                  <Tag color='purple'>Markets {marketsTracked}</Tag>
                  <Tag color='success'>Win rate {formatPercent(tradesSummary.winRate, 1)}</Tag>
                </Space>
              </Space>
              <Divider style={{ margin: '4px 0 8px', borderColor: 'rgba(148, 163, 184, 0.2)' }} />
              <Space direction='vertical' size={12}>
                <Button block type='primary' style={{ borderRadius: 12 }} onClick={() => navigate('/agents')}>
                  Manage agents
                </Button>
                <Button
                  block
                  style={{
                    borderRadius: 12,
                    background: 'rgba(15, 23, 42, 0.65)',
                    borderColor: 'rgba(96, 165, 250, 0.4)',
                    color: '#60a5fa',
                  }}
                  onClick={() => navigate('/agents?view=table#aggressiveness')}
                >
                  Adjust aggressiveness
                </Button>
              </Space>
            </Card>
            <Card
              title={<span style={{ color: '#e2e8f0' }}>Agent health</span>}
              extra={
                <Button type='link' style={{ color: '#60a5fa', padding: 0 }} onClick={() => void refreshAll()}>
                  Refresh
                </Button>
              }
              style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
            >
              <AgentHealthTable
                data={agentHealth}
                loading={agentHealthLoading || refreshing}
                onRefresh={() => void refreshAll()}
              />
            </Card>
          </Space>
        </Col>
      </Row>

      <Drawer
        title='Operational activity'
        placement='right'
        width={420}
        open={activityDrawerOpen}
        onClose={() => setActivityDrawerOpen(false)}
        bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 16, background: 'rgba(15, 23, 42, 0.92)' }}
        styles={{ header: { background: 'rgba(8, 15, 35, 0.92)', color: '#f8fafc' } }}
      >
        {latestEvents.length === 0 ? (
          <Empty description='No alerts captured.' style={{ margin: '32px 0', color: 'rgba(148, 163, 184, 0.78)' }} />
        ) : (
          latestEvents.map((evt: OpsEvent) => {
            const meta = severityMeta[evt.level || 'info'] || severityMeta.info;
            return (
              <div
                key={evt.id}
                style={{
                  borderRadius: 16,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  padding: 16,
                  background: 'rgba(15, 23, 42, 0.75)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <Space align='center' size={8}>
                  <Badge color={meta.color} />
                  <Text style={{ color: meta.color, fontWeight: 600 }}>{meta.label}</Text>
                  <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 12 }}>{formatRelative(evt.ts)}</Text>
                </Space>
                <Text style={{ color: '#f8fafc', fontWeight: 600 }}>
                  {evt.message?.replace(/_/g, ' ') ?? 'Agent update'}
                </Text>
                <Space size={8} wrap style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>
                  {evt.symbol && <Tag color='geekblue'>{evt.symbol}</Tag>}
                  {evt.sessionId && <Tag color='purple'>{evt.sessionId}</Tag>}
                  {evt.source && <span>{evt.source}</span>}
                </Space>
              </div>
            );
          })
        )}
        <Button type='link' style={{ color: '#60a5fa', padding: 0 }} onClick={() => navigate('/backlog')}>
          Open full activity feed
        </Button>
      </Drawer>
    </Space>
  );
};

export default OperationsDashboardPage;
