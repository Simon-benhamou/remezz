import React from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import {
  AreaChartOutlined,
  CheckCircleOutlined,
  DatabaseOutlined,
  ExclamationCircleOutlined,
  FundOutlined,
  ReloadOutlined,
  StopOutlined,
  ThunderboltOutlined,
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
import DashboardKpiCard from '../components/DashboardKpiCard';
import PerformanceOverviewCard from '../components/PerformanceOverviewCard';
import RecentTradesTable from '../components/RecentTradesTable';

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
  const [recentTrades, setRecentTrades] = React.useState<any[]>([]);
  const [recentTradesLoading, setRecentTradesLoading] = React.useState(false);
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
        (async () => {
          setRecentTradesLoading(true);
          try {
            const trades = await api.getTrades(undefined, { limit: 50 });
            setRecentTrades(Array.isArray(trades) ? trades : []);
          } catch (error) {
            console.error('Failed to load trades:', error);
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

  const { token } = theme.useToken();
  const base = token.colorBgBase.toLowerCase();
  const isDarkTheme = !['#ffffff', '#fff', '#fafafa'].includes(base);
  const surfaceColor = isDarkTheme ? '#0f172a' : token.colorBgContainer;
  const borderColor = isDarkTheme ? 'rgba(148, 163, 184, 0.2)' : token.colorBorderSecondary;
  const textPrimary = isDarkTheme ? '#f8fafc' : token.colorText;
  const mutedText = isDarkTheme ? 'rgba(226, 232, 240, 0.7)' : token.colorTextSecondary;
  const secondarySurface = isDarkTheme ? 'rgba(15, 23, 42, 0.78)' : token.colorFillTertiary;
  const heroBackground = isDarkTheme
    ? 'linear-gradient(135deg, #0f172a 0%, #020617 60%, #1e293b 100%)'
    : '#ffffff';
  const heroOverlay = isDarkTheme
    ? 'radial-gradient(circle at top right, rgba(59, 130, 246, 0.35), transparent 45%)'
    : 'radial-gradient(circle at top right, rgba(37, 99, 235, 0.12), transparent 45%)';
  const heroBorder = isDarkTheme ? '1px solid rgba(148, 163, 184, 0.2)' : `1px solid ${token.colorBorderSecondary}`;

  const globalHealth = resolveGlobalHealth(opsMetrics);
  const metricsTimestamp = opsMetrics?.timestamp
    ? new Date(opsMetrics.timestamp).toLocaleTimeString()
    : '—';
  const totalEquityUsd = Number(overview?.equityUsd || overview?.paperBalance?.equityUsd || overview?.exchangeBalance?.totalUsd || 0);
  const pnlUsd = Number(overview?.pnlUsd || 0);
  const alertsLastHour = Number(opsMetrics?.alerts?.lastHour?.total || 0);
  const aiCalls = Number(opsMetrics?.ai?.totalCalls ?? overview?.aiCallsTotal ?? 0);
  const sessionsTotal = Number(overview?.sessionsCount || opsMetrics?.agents?.total || sessions.length);
  const sessionsInPosition = sessions.filter((session) => session.hasPosition).length;
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
  const latestTrade = React.useMemo(() => {
    if (!recentTrades.length) {
      return null;
    }
    return recentTrades.reduce<null | { ts: number; trade: any }>((latest, trade) => {
      const ts = trade?.createdAt ? new Date(trade.createdAt).getTime() : 0;
      if (!latest || ts > latest.ts) {
        return { ts, trade };
      }
      return latest;
    }, null)?.trade ?? null;
  }, [recentTrades]);
  const lastTradeRelative = tradesSummary.lastTradeAt ? formatRelative(tradesSummary.lastTradeAt) : 'No trades yet';
  const latestTradeSymbol = latestTrade?.symbol || latestTrade?.instrument || '—';
  const latestTradePnL = Number(latestTrade?.realizedPnlUsd || 0);
  const latestEvent = latestEvents[0];
  const latestEventRelative = latestEvent?.ts ? formatRelative(latestEvent.ts) : 'No events yet';
  const latestEventMessage = latestEvent?.message || 'No ops events logged';
  const agentsFlat = Math.max(sessionsTotal - sessionsInPosition, 0);
  const heroHighlights = [
    {
      label: 'Ops lock',
      value: locked ? 'Engaged' : 'Open',
      helper: locked ? 'Agent creation disabled' : 'Normal operations',
      tone: locked ? token.colorError : token.colorSuccess,
    },
    {
      label: 'Agents flat',
      value: String(agentsFlat),
      helper: 'awaiting entries',
      tone: token.colorInfo,
    },
    {
      label: 'Last trade',
      value: tradesSummary.lastTradeAt ? `${latestTradeSymbol} ${latestTrade?.positionSide?.toUpperCase?.() || ''}`.trim() : 'No trades',
      helper: tradesSummary.lastTradeAt ? lastTradeRelative : 'Awaiting execution',
      tone: tradesSummary.lastTradeAt ? (latestTradePnL >= 0 ? token.colorSuccess : token.colorError) : mutedText,
    },
    {
      label: 'Ops feed',
      value: latestEventMessage,
      helper: latestEvent?.ts ? latestEventRelative : 'All clear',
      tone: latestEvent ? token.colorWarning : mutedText,
    },
  ];

  return (
    <Space direction='vertical' size={24} style={{ width: '100%' }}>
      <Row gutter={[24, 24]}>
        <Col xs={24} md={12} xl={6}>
          <DashboardKpiCard
            title='Portfolio equity'
            icon={<FundOutlined />}
            value={formatUsd(totalEquityUsd)}
            hint={`Aggregated capital (${mode || 'n/a'} mode)`}
            delta={{ value: formatUsd(pnlUsd), positive: pnlUsd >= 0 }}
            accent='purple'
          />
        </Col>
        <Col xs={24} md={12} xl={6}>
          <DashboardKpiCard
            title='Recent trade PnL'
            icon={<AreaChartOutlined />}
            value={formatUsd(tradesSummary.totalPnl)}
            hint='Last 50 exits'
            delta={{ value: `${formatPercent(tradesSummary.winRate, 1)} win rate`, positive: tradesSummary.winRate >= 50 }}
            accent='emerald'
          />
        </Col>
        <Col xs={24} md={12} xl={6}>
          <DashboardKpiCard
            title='Active coverage'
            icon={<ThunderboltOutlined />}
            value={String(overview?.activeCount || 0)}
            hint={`Tracking ${sessionsTotal} agents`}
            delta={{ value: `${sessionsInPosition} in position`, positive: sessionsInPosition > 0 }}
            accent='blue'
          />
        </Col>
        <Col xs={24} md={12} xl={6}>
          <DashboardKpiCard
            title='AI throughput'
            icon={<DatabaseOutlined />}
            value={new Intl.NumberFormat().format(aiCalls)}
            hint='LLM + signal evaluations'
            delta={{ value: `${alertsLastHour} alerts / 1h`, positive: alertsLastHour < 1 }}
            accent='amber'
          />
        </Col>
      </Row>

      <div
        style={{
          position: 'relative',
          borderRadius: 28,
          padding: 32,
          background: heroBackground,
          color: textPrimary,
          overflow: 'hidden',
          border: heroBorder,
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: heroOverlay,
            pointerEvents: 'none',
          }}
        />
        <Row gutter={[24, 24]} align='middle'>
          <Col xs={24} lg={15}>
            <Space direction='vertical' size={20} style={{ position: 'relative', zIndex: 1, width: '100%' }}>
              <Space size={12} wrap>
                <Tag color='geekblue' style={{ borderRadius: 8 }}>Mode {mode?.toUpperCase?.() || '—'}</Tag>
                <Tag color='purple' style={{ borderRadius: 8 }}>Snapshot {metricsTimestamp}</Tag>
              </Space>
              <Space align='start' size={16}>
                <div
                  style={{
                    width: 60,
                    height: 60,
                    borderRadius: '50%',
                    background: isDarkTheme ? 'rgba(148, 163, 184, 0.2)' : token.colorFillQuaternary,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 28,
                    color: globalHealth.color,
                  }}
                >
                  {globalHealth.icon}
                </div>
                <Space direction='vertical' size={8} style={{ maxWidth: 520 }}>
                  <Title level={3} style={{ color: textPrimary, margin: 0 }}>
                    Operations mission control
                  </Title>
                  <Text style={{ color: mutedText, fontSize: 15 }}>
                    {globalHealth.description}
                  </Text>
                </Space>
              </Space>
              <Space size={12} wrap>
                {locked ? (
                  <Button onClick={unlock} icon={<CheckCircleOutlined />}>Unlock creation</Button>
                ) : (
                  <Button danger icon={<StopOutlined />} onClick={handleStopAll}>
                    Emergency stop all
                  </Button>
                )}
                <Button icon={<ReloadOutlined />} onClick={() => void refreshAll()} loading={refreshing}>
                  Refresh snapshot
                </Button>
              </Space>
              <Alert
                type={globalHealth.tone}
                message={globalHealth.label}
                description={globalHealth.description}
                showIcon
                style={{
                  background: isDarkTheme ? 'rgba(15, 23, 42, 0.6)' : token.colorFillTertiary,
                  border: heroBorder,
                  color: textPrimary,
                }}
              />
            </Space>
          </Col>
          <Col xs={24} lg={9}>
            <div
              style={{
                position: 'relative',
                zIndex: 1,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                gap: 16,
              }}
            >
              {heroHighlights.map((item) => (
                <div
                  key={item.label}
                  style={{
                    borderRadius: 16,
                    border: `1px solid ${borderColor}`,
                    background: secondarySurface,
                    padding: 16,
                    minHeight: 120,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <Text style={{ color: mutedText, fontSize: 12 }}>{item.label}</Text>
                  <div
                    style={{
                      fontSize: item.value.length > 12 ? 18 : 22,
                      fontWeight: 600,
                      color: item.tone || textPrimary,
                      lineHeight: 1.2,
                    }}
                  >
                    {item.value}
                  </div>
                  {item.helper && (
                    <Text style={{ color: mutedText, fontSize: 12 }}>{item.helper}</Text>
                  )}
                </div>
              ))}
            </div>
          </Col>
        </Row>
      </div>

      <Row gutter={[24, 24]} align='stretch'>
        <Col xs={24} xl={14}>
          <PerformanceOverviewCard trades={recentTrades} loading={recentTradesLoading || refreshing} />
        </Col>
        <Col xs={24} xl={10}>
          <OpsMetricsPanel metrics={opsMetrics} loading={refreshing} />
        </Col>
      </Row>

      <Row gutter={[24, 24]} align='stretch'>
        <Col xs={24} xl={14}>
          <Card
            title='Agent overview'
            bodyStyle={{ padding: 0, paddingBottom: 16 }}
            style={{ borderRadius: 16, border: `1px solid ${borderColor}`, background: surfaceColor, color: textPrimary }}
          >
            {sessions.length === 0 ? (
              <Empty description='No active agents in this mode.' style={{ margin: '32px 0', color: mutedText }} />
            ) : (
              <Space direction='vertical' size={16} style={{ width: '100%', padding: 20 }}>
                {sessions.map((session) => {
                  const palette = stateTheme[session.state || 'UNKNOWN'] || stateTheme.UNKNOWN;
                  const health = session.healthStatus ? healthTone[session.healthStatus] : null;
                  const tileBackground = isDarkTheme
                    ? `linear-gradient(135deg, ${palette.border}33, rgba(15, 23, 42, 0.9))`
                    : palette.bg;
                  const labelColor = isDarkTheme ? textPrimary : palette.text;

                  return (
                    <div
                      key={session.id}
                      style={{
                        borderRadius: 16,
                        border: `1px solid ${palette.border}`,
                        background: tileBackground,
                        padding: 18,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 14,
                        boxShadow: isDarkTheme
                          ? '0 12px 35px -20px rgba(15, 23, 42, 0.6)'
                          : '0 8px 24px -16px rgba(15, 23, 42, 0.2)',
                      }}
                    >
                      <Space align='center' style={{ width: '100%', justifyContent: 'space-between' }} wrap>
                        <Space size={10} wrap>
                          <Badge color={session.mode === 'live' ? '#fbbf24' : '#3b82f6'} text={session.symbol || 'Unknown'} />
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
                          <Text style={{ display: 'block', fontSize: 12, color: mutedText }}>ROI</Text>
                          <Text style={{ color: (session.roiPct || 0) >= 0 ? token.colorSuccess : token.colorError, fontWeight: 600 }}>
                            {formatPercent(session.roiPct)}
                          </Text>
                        </Col>
                        <Col xs={12} md={6}>
                          <Text style={{ display: 'block', fontSize: 12, color: mutedText }}>PnL</Text>
                          <Text style={{ color: (session.pnlUsd || 0) >= 0 ? token.colorSuccess : token.colorError, fontWeight: 600 }}>
                            {formatUsd(session.pnlUsd)}
                          </Text>
                        </Col>
                        <Col xs={12} md={6}>
                          <Text style={{ display: 'block', fontSize: 12, color: mutedText }}>Win rate</Text>
                          <Text style={{ fontWeight: 600, color: labelColor }}>{formatPercent(session.winRate, 1)}</Text>
                        </Col>
                        <Col xs={12} md={6}>
                          <Text style={{ display: 'block', fontSize: 12, color: mutedText }}>Trades (24h)</Text>
                          <Text style={{ fontWeight: 600, color: labelColor }}>{session.tradeCount24h ?? 0}</Text>
                        </Col>
                        <Col xs={12} md={6}>
                          <Text style={{ display: 'block', fontSize: 12, color: mutedText }}>Total trades</Text>
                          <Text style={{ fontWeight: 600, color: labelColor }}>{session.trades ?? 0}</Text>
                        </Col>
                        <Col xs={12} md={6}>
                          <Text style={{ display: 'block', fontSize: 12, color: mutedText }}>Last execution</Text>
                          <Tooltip title={session.lastExecutionTs ? new Date(session.lastExecutionTs).toLocaleString() : undefined}>
                            <Text style={{ fontWeight: 600, color: labelColor }}>{formatRelative(session.lastExecutionTs)}</Text>
                          </Tooltip>
                        </Col>
                      </Row>

                      <Text style={{ fontSize: 12, color: mutedText }}>{session.id}</Text>
                    </div>
                  );
                })}
              </Space>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <RecentTradesTable
            trades={recentTrades}
            loading={recentTradesLoading}
            onRefresh={() => void refreshAll()}
          />
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
