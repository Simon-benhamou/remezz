import React from 'react';
import {
  Alert,
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
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  CheckCircleOutlined,
  CloudOutlined,
  DatabaseOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '../icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import RecentTradesTable from '../components/RecentTradesTable';
import AgentHealthTable from '../components/AgentHealthTable';
import PerformanceOverviewCard from '../components/PerformanceOverviewCard';
import { useDashboard } from '../hooks/useDashboard';

const { Title, Text } = Typography;

type ActivityPoint = {
  timestamp: number;
  label: string;
  trades: number;
};

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

function buildActivitySeries(trades: any[]): ActivityPoint[] {
  if (!Array.isArray(trades) || trades.length === 0) return [];
  const buckets = new Map<number, ActivityPoint>();
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  for (const trade of trades) {
    if (!trade?.createdAt) continue;
    const ts = new Date(trade.createdAt).getTime();
    if (!Number.isFinite(ts)) continue;
    const bucketTs = Math.floor(ts / (60 * 60 * 1000)) * 60 * 60 * 1000;
    const existing = buckets.get(bucketTs);
    if (existing) {
      existing.trades += 1;
    } else {
      buckets.set(bucketTs, {
        timestamp: bucketTs,
        label: formatter.format(new Date(bucketTs)),
        trades: 1,
      });
    }
  }
  const sorted = Array.from(buckets.values()).sort((a, b) => a.timestamp - b.timestamp);
  return sorted.slice(-12);
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

  const activitySeries = React.useMemo(() => buildActivitySeries(recentTrades), [recentTrades]);
  const latestEvents = React.useMemo(
    () => (Array.isArray(opsEvents) ? opsEvents.slice(0, 6) : []),
    [opsEvents],
  );

  const globalHealth = resolveGlobalHealth(opsMetrics);

  const summaryCards = [
    {
      key: 'balance',
      title: 'Balance',
      value: formatUsd(totalEquityUsd),
      helper: `PnL ${formatUsd(pnlUsd)}`,
      accent: '#38bdf8',
    },
    {
      key: 'roi',
      title: 'ROI',
      value: formatPercent(roiPct, 2),
      helper: roiPct >= 0 ? 'Above benchmark' : 'Underwater',
      accent: roiPct >= 0 ? '#34d399' : '#f87171',
    },
    {
      key: 'agents',
      title: 'Active agents',
      value: activeAgents.toString(),
      helper: `${marketsTracked} markets tracked`,
      accent: '#a855f7',
    },
    {
      key: 'exec',
      title: '24h executions',
      value: totalTrades24h.toString(),
      helper: tradesSummary.lastTradeAt ? `Last trade ${formatRelative(tradesSummary.lastTradeAt)}` : 'No fills yet',
      accent: '#fbbf24',
    },
    {
      key: 'winRate',
      title: 'Win rate',
      value: formatPercent(tradesSummary.winRate, 1),
      helper: `Realised PnL ${formatUsd(tradesSummary.totalPnl)}`,
      accent: '#34d399',
    },
    {
      key: 'ai',
      title: 'AI calls',
      value: Number(opsMetrics?.ai?.totalCalls ?? overview?.aiCallsTotal ?? 0).toString(),
      helper: 'Model utilisation',
      accent: '#60a5fa',
    },
  ];

  const systemStatus = [
    {
      key: 'api',
      label: 'API Connection',
      icon: <DatabaseOutlined />,
      status: activeAgents > 0 ? 'Operational' : 'Idle',
      tone: activeAgents > 0 ? '#34d399' : '#fbbf24',
      helper: `${activeAgents} sessions connected`,
    },
    {
      key: 'market',
      label: 'Market Stream',
      icon: <CloudOutlined />,
      status: Number(opsMetrics?.alerts?.lastHour?.total || 0) > 0 ? 'Degraded' : 'Stable',
      tone: Number(opsMetrics?.alerts?.lastHour?.total || 0) > 0 ? '#fbbf24' : '#38bdf8',
      helper: `${Number(opsMetrics?.alerts?.lastHour?.total || 0)} alerts / 1h`,
    },
    {
      key: 'risk',
      label: 'Risk Monitor',
      icon: <WarningOutlined />,
      status: Number(opsMetrics?.positions?.protectiveIssues || 0) > 0
        ? `${opsMetrics?.positions?.protectiveIssues} issues`
        : 'Protected',
      tone: Number(opsMetrics?.positions?.protectiveIssues || 0) > 0 ? '#f87171' : '#34d399',
      helper: 'Protective coverage',
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
          borderRadius: 20,
          border: `1px solid ${token.colorBorderSecondary}`,
          background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.92), rgba(30, 64, 175, 0.6))',
          overflow: 'hidden',
        }}
        bodyStyle={{ padding: 28 }}
      >
        <Row gutter={[24, 24]} align='middle'>
          <Col xs={24} md={16}>
            <Space direction='vertical' size={8}>
              <Tag color='blue' style={{ alignSelf: 'flex-start', borderRadius: 999 }}>
                Control Center
              </Tag>
              <Title level={2} style={{ margin: 0, color: '#e2e8f0' }}>
                Monitoring & automated execution overview
              </Title>
              <Text style={{ color: 'rgba(226, 232, 240, 0.72)', maxWidth: 520 }}>
                Track live performance, execution cadence and platform health across every autonomous agent.
              </Text>
            </Space>
          </Col>
          <Col xs={24} md={8}>
            <Space direction='vertical' size={12} style={{ width: '100%' }}>
              <Button
                type='primary'
                icon={<ReloadOutlined />}
                onClick={() => void refreshAll()}
                loading={refreshing || recentTradesLoading || agentHealthLoading}
                style={{ width: '100%', borderRadius: 12 }}
              >
                Refresh data
              </Button>
              <Alert
                message={
                  <Space align='center' size={8}>
                    <span style={{ color: globalHealth.color, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {globalHealth.icon}
                      {globalHealth.label}
                    </span>
                    <Tag color='geekblue' style={{ borderRadius: 8 }}>Snapshot {metricsTimestamp}</Tag>
                  </Space>
                }
                description={<span style={{ color: 'rgba(226, 232, 240, 0.78)' }}>{globalHealth.description}</span>}
                type={globalHealth.tone}
                showIcon={false}
                style={{
                  background: 'rgba(15, 23, 42, 0.85)',
                  borderRadius: 14,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  color: '#e2e8f0',
                }}
              />
            </Space>
          </Col>
        </Row>
      </Card>

      <Row gutter={[24, 24]}>
        {summaryCards.map((card) => (
          <Col xs={24} sm={12} xl={8} xxl={4} key={card.key}>
            <Card
              style={{
                borderRadius: 18,
                border: `1px solid ${token.colorBorderSecondary}`,
                background: 'rgba(15, 23, 42, 0.92)',
                height: '100%',
              }}
              bodyStyle={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              <Text style={{ color: 'rgba(148, 163, 184, 0.78)', fontSize: 12 }}>{card.title}</Text>
              <Title level={3} style={{ margin: 0, color: card.accent }}>{card.value}</Title>
              <Text style={{ color: 'rgba(148, 163, 184, 0.78)', fontSize: 12 }}>{card.helper}</Text>
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={14}>
          <PerformanceOverviewCard
            trades={recentTrades}
            loading={recentTradesLoading || refreshing}
            title='Portfolio performance'
            subtitle='Cumulative realised PnL across the monitored sessions'
          />
        </Col>
        <Col xs={24} xl={10}>
          <Card
            title={<span style={{ color: '#e2e8f0' }}>Agent activity</span>}
            extra={<Tag color='geekblue'>Last 12 hours</Tag>}
            style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
            bodyStyle={{ height: 280, padding: 20 }}
          >
            {activitySeries.length === 0 ? (
              <Empty description='No executions yet.' style={{ marginTop: 40, color: 'rgba(148, 163, 184, 0.78)' }} />
            ) : (
              <ResponsiveContainer width='100%' height='100%'>
                <AreaChart data={activitySeries}>
                  <defs>
                    <linearGradient id='agentActivityGradient' x1='0' y1='0' x2='0' y2='1'>
                      <stop offset='0%' stopColor='#60a5fa' stopOpacity={0.8} />
                      <stop offset='100%' stopColor='#60a5fa' stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey='label' stroke='rgba(148, 163, 184, 0.7)' tickLine={false} axisLine={false} />
                  <YAxis stroke='rgba(148, 163, 184, 0.7)' tickLine={false} axisLine={false} allowDecimals={false} />
                  <RechartsTooltip
                    contentStyle={{
                      background: 'rgba(15, 23, 42, 0.92)',
                      borderRadius: 12,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      color: '#e2e8f0',
                    }}
                    formatter={(value: number) => [`${value} trades`, 'Executions']}
                  />
                  <Area type='monotone' dataKey='trades' stroke='#60a5fa' fill='url(#agentActivityGradient)' strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={10}>
          <Card
            title={<span style={{ color: '#e2e8f0' }}>System status</span>}
            style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
            bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 16 }}
          >
            {systemStatus.map((item) => (
              <div
                key={item.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: 'rgba(15, 23, 42, 0.7)',
                  padding: '14px 16px',
                  borderRadius: 14,
                  border: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <Space size={14}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 12,
                      background: 'rgba(96, 165, 250, 0.2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#60a5fa',
                      fontSize: 16,
                    }}
                  >
                    {item.icon}
                  </div>
                  <Space direction='vertical' size={2}>
                    <Text style={{ color: '#e2e8f0', fontWeight: 600 }}>{item.label}</Text>
                    <Text style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>{item.helper}</Text>
                  </Space>
                </Space>
                <Badge color={item.tone} text={<span style={{ color: item.tone }}>{item.status}</span>} />
              </div>
            ))}
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <AgentHealthTable
            data={agentHealth}
            loading={agentHealthLoading || refreshing}
            onRefresh={() => void refreshAll()}
          />
        </Col>
      </Row>

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={14}>
          <RecentTradesTable
            trades={recentTrades}
            loading={recentTradesLoading || refreshing}
            onRefresh={() => void refreshAll()}
          />
        </Col>
        <Col xs={24} xl={10}>
          <Card
            title={<span style={{ color: '#e2e8f0' }}>Latest alerts</span>}
            extra={<Button type='link' style={{ color: '#60a5fa', padding: 0 }} onClick={() => navigate('/backlog')}>Open feed</Button>}
            style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
            bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 16 }}
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
                      borderRadius: 14,
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
                      <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 12 }}>
                        {formatRelative(evt.ts)}
                      </Text>
                    </Space>
                    <Text style={{ color: '#e2e8f0', fontWeight: 600 }}>
                      {evt.message?.replace(/_/g, ' ') ?? 'Agent update'}
                    </Text>
                    <Space size={8} wrap style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>
                      {evt.symbol && <Tag color='geekblue'>{evt.symbol}</Tag>}
                      {evt.sessionId && <Tag color='purple'>{evt.sessionId}</Tag>}
                      <span>{evt.source}</span>
                    </Space>
                  </div>
                );
              })
            )}
          </Card>
        </Col>
      </Row>
    </Space>
  );
};

export default OperationsDashboardPage;
