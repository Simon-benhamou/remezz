import React from 'react';
import {
  Button,
  Empty,
  Modal,
  Segmented,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  AppstoreOutlined,
  BarsOutlined,
  DeleteOutlined,
  EyeOutlined,
  PauseCircleFilled,
  PlayCircleFilled,
  PlusOutlined,
  ReloadOutlined,
} from '../icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import { useSessionsCache } from '../hooks/useSessionsCache';
import AgentCreationModal from '../components/AgentCreationModal';
import type { AppMode } from '../store';
import type { StrategySnapshot } from '../types/strategies';
import { type StrategyEngineOption } from '../utils/strategies';

const { Text, Title } = Typography;

type ViewMode = 'cards' | 'table';

type AgentSession = {
  id: string;
  name?: string;
  symbol?: string;
  mode: AppMode;
  startBalanceUsd?: number;
  pnlUsd?: number;
  roiPct?: number;
  netRoiPct?: number;
  winRate?: number;
  totalTrades?: number;
  haltedAt?: string | null;
  stoppedAt?: string | null;
  startedAt?: string | null;
  profile?: Record<string, any> | null;
  runtimeBalance?: { allocatedUsd?: number } | null;
  strategyFamily?: string | null;
  isSmartAgent?: boolean;
  strategyEngine?: StrategyEngineOption | null;
  strategy?: StrategySnapshot | string | null;
  openPositions?: number;
};

const isSessionActive = (session: AgentSession) => !session.haltedAt && !session.stoppedAt;

const formatUsd = (value?: number | null) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const amount = Number(value);
  const prefix = amount >= 0 ? '$' : '-$';
  return `${prefix}${Math.abs(amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
};

const formatPercent = (value?: number | null) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const percent = Number(value);
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
};

const resolveAgentLabel = (session: AgentSession) => {
  if (session.name) return session.name;
  if (session.symbol) return `${session.symbol.replace('/USDT:USDT', '').replace('/USDT', '')}/USDT-USDT Agent`;
  return 'Trading Agent';
};

async function enrichSession(session: AgentSession): Promise<AgentSession> {
  if (!session.id) return session;
  try {
    const perf = await api.getPerf(session.id).catch(() => null);
    const realized = Number(perf?.realizedPnlUsd ?? 0);
    const unrealized = Number(perf?.unrealizedPnlUsd ?? 0);
    const startBalance = Number(session.startBalanceUsd ?? 0);
    const roiPct = Number(perf?.roiPct ?? (startBalance > 0 ? (realized / startBalance) * 100 : 0));
    return {
      ...session,
      pnlUsd: realized + unrealized,
      roiPct,
      winRate: perf?.winRate ?? session.winRate,
      totalTrades: perf?.totalTrades ?? session.totalTrades ?? 0,
    };
  } catch {
    return session;
  }
}

export default function SessionsPage() {
  const navigate = useNavigate();
  const { mode: currentMode } = useMode();
  const { loading, loadSessions, invalidateCache } = useSessionsCache();
  const [sessions, setSessions] = React.useState<AgentSession[]>([]);
  const [viewMode, setViewMode] = React.useState<ViewMode>('table');
  const [enrichedSessions, setEnrichedSessions] = React.useState<AgentSession[]>([]);
  const [createModalOpen, setCreateModalOpen] = React.useState(false);

  const fetchSessions = React.useCallback(async (forceRefresh = false) => {
    try {
      const data = await loadSessions(currentMode as AppMode, true, forceRefresh);
      setSessions(data || []);
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
  }, [currentMode, loadSessions]);

  React.useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  React.useEffect(() => {
    if (sessions?.length) {
      Promise.all(sessions.map(enrichSession)).then(setEnrichedSessions);
    } else {
      setEnrichedSessions([]);
    }
  }, [sessions]);

  const activeSessions = enrichedSessions.filter(isSessionActive);
  const pausedSessions = enrichedSessions.filter((s) => s.haltedAt && !s.stoppedAt);
  const stoppedSessions = enrichedSessions.filter((s) => s.stoppedAt);

  const handleAction = React.useCallback(
    async (action: 'stop' | 'start' | 'delete', session: AgentSession) => {
      const label = resolveAgentLabel(session);
      const config = {
        stop: { title: 'Stop Agent', content: `Stop ${label}?`, okText: 'Stop', danger: true },
        start: { title: 'Restart Agent', content: `Restart ${label}?`, okText: 'Restart', danger: false },
        delete: { title: 'Delete Agent', content: `Permanently delete ${label}?`, okText: 'Delete', danger: true },
      }[action];

      Modal.confirm({
        ...config,
        okButtonProps: { danger: config.danger },
        onOk: async () => {
          try {
            if (action === 'stop') await api.stopSession(session.id);
            else if (action === 'delete') await api.deleteSession(session.id);
            else await api.restartSession(session.id, { mode: session.mode, maxLeverage: 4, strategyEngine: 'meta_adaptive' });
            message.success(`Agent ${action === 'delete' ? 'deleted' : action === 'stop' ? 'stopped' : 'restarted'}`);
            invalidateCache(currentMode as AppMode);
            await fetchSessions(true);
          } catch (e: any) {
            message.error(e?.response?.data?.message || `Failed to ${action} agent`);
          }
        },
      });
    },
    [currentMode, fetchSessions, invalidateCache]
  );

  // Styles
  const cardStyle: React.CSSProperties = {
    background: 'rgba(15, 23, 42, 0.6)',
    borderRadius: 16,
    border: '1px solid rgba(148, 163, 184, 0.1)',
    overflow: 'hidden',
  };

  const headerCellStyle: React.CSSProperties = {
    color: 'rgba(148, 163, 184, 0.7)',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: 500,
  };

  if (loading && !enrichedSessions.length) {
    return <div style={{ padding: 24 }}><Skeleton active paragraph={{ rows: 8 }} /></div>;
  }

  return (
    <div style={{ padding: '0 24px 24px', maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <Title level={3} style={{ margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 12 }}>
              AI Trading Agents
              <Tag color={currentMode === 'live' ? 'error' : 'blue'}>{currentMode?.toUpperCase()}</Tag>
            </Title>
            <Text style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 13 }}>
              Autonomous multi-agent system with intelligent portfolio diversification
            </Text>
          </div>
          <Space size={12}>
            <Segmented
              value={viewMode}
              onChange={(v) => setViewMode(v as ViewMode)}
              options={[
                { value: 'cards', icon: <AppstoreOutlined /> },
                { value: 'table', icon: <BarsOutlined /> },
              ]}
              style={{ background: 'rgba(15, 23, 42, 0.8)' }}
            />
            <Button icon={<ReloadOutlined />} onClick={() => fetchSessions(true)} loading={loading} />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
              Create Agent
            </Button>
          </Space>
        </div>
        <Space size={16}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#4ade80' }} />
            <Text style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{activeSessions.length} Active</Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fbbf24' }} />
            <Text style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{pausedSessions.length} Paused</Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--text-secondary)' }} />
            <Text style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{stoppedSessions.length} Stopped</Text>
          </div>
        </Space>
      </div>

      {/* Table View */}
      {viewMode === 'table' && (
        <div style={cardStyle}>
          {/* Header Row */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '2fr 100px 100px 120px 120px 100px 100px 80px 140px',
            padding: '14px 20px',
            borderBottom: '1px solid rgba(148, 163, 184, 0.12)',
            background: 'rgba(15, 23, 42, 0.8)',
          }}>
            <span style={headerCellStyle}>Agent</span>
            <span style={headerCellStyle}>Selection</span>
            <span style={headerCellStyle}>Status</span>
            <span style={headerCellStyle}>Capital Source</span>
            <span style={{ ...headerCellStyle, textAlign: 'right' }}>PnL</span>
            <span style={{ ...headerCellStyle, textAlign: 'right' }}>ROI</span>
            <span style={{ ...headerCellStyle, textAlign: 'right' }}>Win Rate</span>
            <span style={{ ...headerCellStyle, textAlign: 'center' }}>Trades</span>
            <span style={{ ...headerCellStyle, textAlign: 'right' }}>Actions</span>
          </div>

          {enrichedSessions.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center' }}>
              <Empty description={<Text style={{ color: 'var(--text-secondary)' }}>No agents yet</Text>}>
                <Button type="primary" onClick={() => setCreateModalOpen(true)}>Create Your First Agent</Button>
              </Empty>
            </div>
          ) : (
            enrichedSessions.map((session) => {
              const pnl = Number(session.pnlUsd ?? 0);
              const roi = Number(session.roiPct ?? 0);
              const winRate = Number(session.winRate ?? 0);
              const isActive = isSessionActive(session);
              const hasPosition = (session.openPositions ?? 0) > 0;

              return (
                <div
                  key={session.id}
                  onClick={() => navigate(`/agents/${session.id}`)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr 100px 100px 120px 120px 100px 100px 80px 140px',
                    padding: '16px 20px',
                    borderBottom: '1px solid rgba(148, 163, 184, 0.06)',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                    alignItems: 'center',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(148, 163, 184, 0.04)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {/* Agent */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Text style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 14 }}>{resolveAgentLabel(session)}</Text>
                    <Tag style={{
                      borderRadius: 4,
                      border: 'none',
                      background: session.mode === 'live' ? 'rgba(239, 68, 68, 0.12)' : 'rgba(59, 130, 246, 0.12)',
                      color: session.mode === 'live' ? '#f87171' : '#06b6d4',
                      fontSize: 10,
                      padding: '2px 6px',
                      lineHeight: 1.4,
                    }}>
                      {session.mode?.toUpperCase()}
                    </Tag>
                  </div>

                  {/* Selection */}
                  <Text style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{session.isSmartAgent ? 'Smart Auto' : 'Manual'}</Text>

                  {/* Status */}
                  <Tag style={{
                    borderRadius: 4,
                    border: 'none',
                    background: isActive ? (hasPosition ? 'rgba(34, 197, 94, 0.12)' : 'rgba(251, 191, 36, 0.12)') : 'rgba(148, 163, 184, 0.1)',
                    color: isActive ? (hasPosition ? '#4ade80' : '#fbbf24') : 'var(--text-secondary)',
                    fontSize: 11,
                    padding: '3px 8px',
                  }}>
                    {isActive ? (hasPosition ? 'Trading' : 'Watching') : session.haltedAt ? 'Paused' : 'Stopped'}
                  </Tag>

                  {/* Capital Source */}
                  <Tag style={{ borderRadius: 4, border: 'none', background: 'rgba(59, 130, 246, 0.1)', color: '#06b6d4', fontSize: 11 }}>
                    Shared pool
                  </Tag>

                  {/* PnL */}
                  <div style={{ textAlign: 'right' }}>
                    <Text style={{ color: pnl >= 0 ? '#4ade80' : '#f87171', fontWeight: 600, fontSize: 14, display: 'block' }}>
                      {formatUsd(pnl)}
                    </Text>
                    <Text style={{ color: roi >= 0 ? 'rgba(74, 222, 128, 0.7)' : 'rgba(248, 113, 113, 0.7)', fontSize: 11 }}>
                      {formatPercent(roi)}
                    </Text>
                  </div>

                  {/* ROI */}
                  <Text style={{ color: roi >= 0 ? '#4ade80' : '#f87171', fontWeight: 500, fontSize: 13, textAlign: 'right', display: 'block' }}>
                    {formatPercent(roi)}
                  </Text>

                  {/* Win Rate */}
                  <Text style={{ color: winRate >= 50 ? '#4ade80' : '#f87171', fontWeight: 500, fontSize: 13, textAlign: 'right', display: 'block' }}>
                    {formatPercent(winRate)}
                  </Text>

                  {/* Trades */}
                  <Text style={{ color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center', display: 'block' }}>
                    {session.totalTrades ?? 0}
                  </Text>

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
                    <Tooltip title={isActive ? 'Pause' : 'Start'}>
                      <Button
                        type="text"
                        size="small"
                        icon={isActive ? <PauseCircleFilled /> : <PlayCircleFilled />}
                        onClick={() => handleAction(isActive ? 'stop' : 'start', session)}
                        style={{
                          background: isActive ? 'rgba(239, 68, 68, 0.08)' : 'rgba(34, 197, 94, 0.08)',
                          color: isActive ? '#f87171' : '#4ade80',
                          borderRadius: 6,
                          width: 32,
                          height: 32,
                        }}
                      />
                    </Tooltip>
                    <Tooltip title="View">
                      <Button
                        type="text"
                        size="small"
                        icon={<EyeOutlined />}
                        onClick={() => navigate(`/agents/${session.id}`)}
                        style={{ background: 'rgba(148, 163, 184, 0.08)', borderRadius: 6, width: 32, height: 32 }}
                      />
                    </Tooltip>
                    <Tooltip title="Delete">
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => handleAction('delete', session)}
                        style={{ background: 'rgba(239, 68, 68, 0.08)', borderRadius: 6, width: 32, height: 32 }}
                      />
                    </Tooltip>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Cards View */}
      {viewMode === 'cards' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {enrichedSessions.length === 0 ? (
            <div style={{ gridColumn: '1 / -1', padding: 48, textAlign: 'center' }}>
              <Empty description={<Text style={{ color: 'var(--text-secondary)' }}>No agents yet</Text>}>
                <Button type="primary" onClick={() => setCreateModalOpen(true)}>Create Your First Agent</Button>
              </Empty>
            </div>
          ) : (
            enrichedSessions.map((session) => {
              const pnl = Number(session.pnlUsd ?? 0);
              const isActive = isSessionActive(session);
              const hasPosition = (session.openPositions ?? 0) > 0;

              return (
                <div
                  key={session.id}
                  onClick={() => navigate(`/agents/${session.id}`)}
                  style={{
                    background: 'rgba(15, 23, 42, 0.7)',
                    borderRadius: 16,
                    border: '1px solid rgba(148, 163, 184, 0.1)',
                    padding: 20,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.3)';
                    e.currentTarget.style.transform = 'translateY(-2px)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'rgba(148, 163, 184, 0.1)';
                    e.currentTarget.style.transform = 'translateY(0)';
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                    <div>
                      <Text style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 16, display: 'block' }}>{resolveAgentLabel(session)}</Text>
                      <Tag style={{ marginTop: 6, borderRadius: 4, border: 'none', background: session.mode === 'live' ? 'rgba(239, 68, 68, 0.12)' : 'rgba(59, 130, 246, 0.12)', color: session.mode === 'live' ? '#f87171' : '#06b6d4', fontSize: 10 }}>
                        {session.mode?.toUpperCase()}
                      </Tag>
                    </div>
                    <Tag style={{ borderRadius: 4, border: 'none', background: isActive ? (hasPosition ? 'rgba(34, 197, 94, 0.12)' : 'rgba(251, 191, 36, 0.12)') : 'rgba(148, 163, 184, 0.1)', color: isActive ? (hasPosition ? '#4ade80' : '#fbbf24') : 'var(--text-secondary)', height: 'fit-content' }}>
                      {isActive ? (hasPosition ? 'Trading' : 'Watching') : session.haltedAt ? 'Paused' : 'Stopped'}
                    </Tag>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                    <div>
                      <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 11, display: 'block' }}>PnL</Text>
                      <Text style={{ color: pnl >= 0 ? '#4ade80' : '#f87171', fontWeight: 700, fontSize: 20 }}>{formatUsd(pnl)}</Text>
                    </div>
                    <div>
                      <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 11, display: 'block' }}>Win Rate</Text>
                      <Text style={{ color: (session.winRate ?? 0) >= 50 ? '#4ade80' : '#f87171', fontWeight: 600, fontSize: 16 }}>{formatPercent(session.winRate)}</Text>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                    <Button size="small" danger={isActive} type={isActive ? 'default' : 'primary'} icon={isActive ? <PauseCircleFilled /> : <PlayCircleFilled />} onClick={() => handleAction(isActive ? 'stop' : 'start', session)} style={{ flex: 1 }}>
                      {isActive ? 'Pause' : 'Start'}
                    </Button>
                    <Button size="small" icon={<EyeOutlined />} onClick={() => navigate(`/agents/${session.id}`)} />
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleAction('delete', session)} />
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      <AgentCreationModal
        visible={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onSuccess={() => { setCreateModalOpen(false); invalidateCache(currentMode as AppMode); fetchSessions(true); }}
        mode={currentMode as AppMode}
      />
    </div>
  );
}
