import React from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Modal,
  Segmented,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  Slider,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
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
import {
  STRATEGY_DESCRIPTIONS,
  STRATEGY_META,
  resolveSessionStrategyLabel,
  inferSessionStrategyEngine,
  type StrategyEngineOption,
} from '../utils/strategies';

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
};

const isSessionActive = (session: AgentSession) => !session.haltedAt && !session.stoppedAt;

const formatUsd = (value?: number | null) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '—';
  }
  const amount = Number(value);
  const prefix = amount >= 0 ? '$' : '-$';
  const absolute = Math.abs(amount);
  return `${prefix}${absolute.toLocaleString(undefined, { maximumFractionDigits: absolute < 1000 ? 2 : 0 })}`;
};

const formatPercent = (value?: number | null, fractionDigits = 1) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '—';
  }
  const percent = Number(value);
  const formatted = Math.abs(percent).toFixed(fractionDigits);
  const prefix = percent >= 0 ? '+' : '-';
  return `${prefix}${formatted}%`;
};

const resolveAgentLabel = (session: AgentSession) => {
  if (session.name) return session.name;
  if (session.symbol) return `${session.symbol} Agent`;
  return 'Trading Agent';
};

const statusMeta = (session: AgentSession) => {
  if (session.haltedAt) {
    return {
      label: 'Paused',
      tone: 'linear-gradient(135deg, rgba(251, 191, 36, 0.22), rgba(251, 146, 60, 0.32))',
      color: '#fbbf24',
    };
  }
  if (session.stoppedAt) {
    return {
      label: 'Stopped',
      tone: 'linear-gradient(135deg, rgba(148, 163, 184, 0.15), rgba(100, 116, 139, 0.28))',
      color: '#cbd5f5',
    };
  }
  return {
    label: 'Active',
    tone: 'linear-gradient(135deg, rgba(59, 130, 246, 0.22), rgba(99, 102, 241, 0.32))',
    color: '#60a5fa',
  };
};

const selectionBadgeMeta = (isSmart?: boolean) => {
  return {
    label: isSmart ? 'Smart Auto' : 'Manual',
    background: isSmart ? 'rgba(14, 165, 233, 0.18)' : 'rgba(148, 163, 184, 0.12)',
    color: isSmart ? '#38bdf8' : '#cbd5f5',
  };
};

const BIAS_META: Record<'long' | 'short' | 'both', { label: string; color: string; background: string }> = {
  long: { label: 'LONG', color: '#22c55e', background: 'rgba(34, 197, 94, 0.12)' },
  short: { label: 'SHORT', color: '#f97316', background: 'rgba(249, 115, 22, 0.15)' },
  both: { label: 'BI-DIRECTIONAL', color: '#38bdf8', background: 'rgba(14, 165, 233, 0.18)' },
};

const formatConfidenceTag = (value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}% confidence`;
};

async function enrichSession(session: AgentSession): Promise<AgentSession> {
  if (!session.id) return session;

  try {
    const [perf] = await Promise.all([
      api.getPerf(session.id).catch(() => null),
    ]);

    const realized = Number(perf?.realizedPnlUsd ?? 0);
    const unrealized = Number(perf?.unrealizedPnlUsd ?? 0);
    const statsMeta = (perf?.stats ?? {}) as Record<string, any>;
    const startBalance = Number(session.startBalanceUsd ?? 0);
    const roiPct = Number(perf?.roiPct ?? (startBalance > 0 ? (realized / startBalance) * 100 : 0));
    const netRoiPct = Number.isFinite(Number(statsMeta?.netRoiPct))
      ? Number(statsMeta.netRoiPct)
      : startBalance > 0
        ? ((realized + unrealized) / startBalance) * 100
        : roiPct;
    const rawWinRate = Number(perf?.winRate ?? 0);
    const normalizedWinRate = rawWinRate > 0 && rawWinRate <= 1 ? rawWinRate * 100 : rawWinRate;
    const resolvedEngine = ((session.profile as any)?.strategyEngine as StrategyEngineOption)
      || (session.strategyEngine as StrategyEngineOption)
      || null;

    return {
      ...session,
      pnlUsd: realized + unrealized,
      roiPct,
      netRoiPct,
      winRate: normalizedWinRate,
      totalTrades: perf?.totalTrades ?? 0,
      strategyEngine: resolvedEngine,
    };
  } catch (error) {
    console.warn('Failed to enrich session metrics', error);
    return session;
  }
}

const cardGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
  gap: 24,
  width: '100%',
};

const cardStyle: React.CSSProperties = {
  background: 'linear-gradient(145deg, rgba(30, 41, 59, 0.72) 0%, rgba(15, 23, 42, 0.85) 100%)',
  borderRadius: 18,
  border: '1px solid rgba(71, 107, 176, 0.32)',
  overflow: 'hidden',
  transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
  boxShadow: '0 24px 56px -32px rgba(0, 0, 0, 0.6), 0 0 1px rgba(71, 107, 176, 0.4)',
};

export default function SessionsPage() {
  const navigate = useNavigate();
  const { mode } = useMode();
  const currentMode = mode as AppMode;
  const { loadSessions, invalidateCache } = useSessionsCache();

  const [sessions, setSessions] = React.useState<AgentSession[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [viewMode, setViewMode] = React.useState<ViewMode>('cards');
  const [modalOpen, setModalOpen] = React.useState(false);

  const fetchSessions = React.useCallback(
    async (forceRefresh = false) => {
      setLoading(true);
      try {
        const raw = await loadSessions(currentMode, true, forceRefresh);
        const filtered = (raw || []).filter((session: any) => session.mode === currentMode);
        const enriched = await Promise.all(filtered.map((session: AgentSession) => enrichSession(session)));
        setSessions(enriched);
      } catch (error: any) {
        const messageText = error?.response?.data?.error || error?.message || 'Failed to load agents';
        message.error(messageText);
      } finally {
        setLoading(false);
      }
    },
    [currentMode, loadSessions]
  );

  React.useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const openCreateModal = React.useCallback(() => {
    setModalOpen(true);
  }, []);

  const closeModal = React.useCallback(() => {
    setModalOpen(false);
  }, []);

  const handleAgentCreated = React.useCallback(async () => {
    invalidateCache(currentMode);
    await fetchSessions(true);
  }, [currentMode, fetchSessions, invalidateCache]);

  const handleStopSession = React.useCallback(
    (session: AgentSession) => {
      Modal.confirm({
        title: `Pause ${resolveAgentLabel(session)}?`,
        content: 'The agent will stop trading immediately.',
        okText: 'Pause Agent',
        okButtonProps: { danger: true },
        onOk: async () => {
          try {
            await api.stopSession(session.id, true);
            message.success('Agent paused');
            invalidateCache(currentMode);
            await fetchSessions(true);
          } catch (error: any) {
            message.error(error?.response?.data?.message || 'Failed to pause agent');
          }
        },
      });
    },
    [currentMode, fetchSessions, invalidateCache]
  );

  const handleDeleteSession = React.useCallback(
    (session: AgentSession) => {
      Modal.confirm({
        title: `Delete ${resolveAgentLabel(session)}?`,
        content: 'This removes the agent configuration and history from the console.',
        okText: 'Delete',
        okButtonProps: { danger: true },
        onOk: async () => {
          try {
            await api.deleteSession(session.id);
            message.success('Agent removed');
            invalidateCache(currentMode);
            await fetchSessions(true);
          } catch (error: any) {
            message.error(error?.response?.data?.message || 'Failed to delete agent');
          }
        },
      });
    },
    [currentMode, fetchSessions, invalidateCache]
  );

  const handlePrimaryAction = React.useCallback(
    (session: AgentSession) => {
      if (isSessionActive(session)) {
        handleStopSession(session);
        return;
      }
      // For restarting paused agents, open a confirmation modal instead
      Modal.confirm({
        title: `Restart ${resolveAgentLabel(session)}?`,
        content: 'The agent will resume trading with its current configuration.',
        okText: 'Restart Agent',
        okButtonProps: { type: 'primary' },
        onOk: async () => {
          try {
            const payload = {
              mode: session.mode,
              maxLeverage: Number((session.profile as any)?.requestedMaxLeverage ?? (session.profile as any)?.maxLeverage ?? 4) || 4,
              strategyEngine: 'meta_adaptive',
            };
            await api.restartSession(session.id, payload);
            message.success('Agent restarted');
            invalidateCache(currentMode);
            await fetchSessions(true);
          } catch (error: any) {
            message.error(error?.response?.data?.message || 'Failed to restart agent');
          }
        },
      });
    },
    [handleStopSession, currentMode, fetchSessions, invalidateCache]
  );

  const handleRefresh = React.useCallback(() => {
    fetchSessions(true);
  }, [fetchSessions]);

  const columns = React.useMemo<ColumnsType<AgentSession>>(
    () => [
      {
        title: 'Agent',
        key: 'agent',
        render: (_, record) => {
          const strategyEngine = inferSessionStrategyEngine(record);
          const strategyColor = strategyEngine
            ? STRATEGY_META[strategyEngine].color
            : 'rgba(226, 232, 240, 0.85)';
          const strategyBackground = strategyEngine
            ? `${STRATEGY_META[strategyEngine].color}20`
            : 'rgba(148, 163, 184, 0.12)';
          const strategySnapshot =
            record.strategy && typeof record.strategy === 'object' && !Array.isArray(record.strategy)
              ? (record.strategy as StrategySnapshot)
              : null;
          const primary = strategySnapshot?.primary ?? null;
          const biasMeta = primary?.bias ? BIAS_META[primary.bias] : null;
          const confidenceText = formatConfidenceTag(primary?.confidence);
          const guardrail = primary?.guardrail;
          return (
            <Space direction="vertical" size={2}>
              <Space size={8}>
                <Text style={{ color: '#f8fafc', fontWeight: 600 }}>{resolveAgentLabel(record)}</Text>
                <Tag
                  style={{
                    borderRadius: 10,
                    border: 'none',
                    background: 'rgba(59, 130, 246, 0.12)',
                    color: '#93c5fd',
                  }}
                >
                  {record.mode?.toUpperCase?.()}
                </Tag>
                <Tag
                  style={{
                    borderRadius: 10,
                    border: 'none',
                    background: selectionBadgeMeta(record.isSmartAgent).background,
                    color: selectionBadgeMeta(record.isSmartAgent).color,
                  }}
                >
                  {selectionBadgeMeta(record.isSmartAgent).label}
                </Tag>
              </Space>
              <Space size={6} wrap>
                <Tag
                  style={{
                    borderRadius: 10,
                    border: 'none',
                    background: strategyBackground,
                    color: strategyColor,
                  }}
                >
                  {resolveSessionStrategyLabel(record)}
                </Tag>
                {biasMeta && (
                  <Tag
                    style={{
                      borderRadius: 10,
                      border: 'none',
                      background: biasMeta.background,
                      color: biasMeta.color,
                    }}
                  >
                    {biasMeta.label}
                  </Tag>
                )}
                {guardrail && (
                  <Tag
                    style={{
                      borderRadius: 10,
                      border: 'none',
                      background: 'rgba(251, 191, 36, 0.16)',
                      color: '#fbbf24',
                    }}
                  >
                    Guardrail active
                  </Tag>
                )}
              </Space>
              {confidenceText && (
                <Text style={{ color: '#94a3b8', fontSize: 12 }}>{confidenceText}</Text>
              )}
            </Space>
          );
        },
      },
      {
        title: 'Pair',
        dataIndex: 'symbol',
        key: 'symbol',
        render: (value: string) => <Text style={{ color: '#cbd5f5' }}>{value || '—'}</Text>,
      },
      {
        title: 'Selection',
        key: 'selectionMode',
        render: (_, record) => {
          const meta = selectionBadgeMeta(record.isSmartAgent);
          return (
            <Tag
              style={{
                borderRadius: 10,
                border: 'none',
                background: meta.background,
                color: meta.color,
              }}
            >
              {meta.label}
            </Tag>
          );
        },
      },
      {
        title: 'Status',
        key: 'status',
        render: (_, record) => {
          const meta = statusMeta(record);
          const hasPosition = (record as any).openPositions > 0;
          return (
            <Space direction="vertical" size={2}>
              <Tag
                style={{
                  borderRadius: 10,
                  border: 'none',
                  background: meta.tone,
                  color: meta.color,
                  fontWeight: 600,
                }}
              >
                {meta.label}
              </Tag>
              {isSessionActive(record) && (
                <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                  {hasPosition ? '📈 In position' : '🔍 Scanning'}
                </Text>
              )}
            </Space>
          );
        },
      },
      {
        title: 'Capital source',
        key: 'capitalSource',
        align: 'right',
        render: () => (
          <Tooltip title="Allocation dynamique depuis le pool de capital partagé">
            <Tag
              style={{
                borderRadius: 10,
                border: 'none',
                background: 'rgba(59, 130, 246, 0.12)',
                color: '#93c5fd',
                fontWeight: 600,
              }}
            >
              Shared pool
            </Tag>
          </Tooltip>
        ),
      },
      {
        title: 'PnL',
        key: 'pnl',
        align: 'right',
        render: (_, record) => {
          const pnl = Number(record.pnlUsd ?? 0);
          return (
            <Text style={{ color: pnl >= 0 ? '#4ade80' : '#f87171', fontWeight: 600 }}>
              {formatUsd(record.pnlUsd)}
            </Text>
          );
        },
      },
      {
        title: 'ROI',
        key: 'roi',
        align: 'right',
        render: (_, record) => {
          const realized = Number(record.roiPct ?? 0);
          const net = Number.isFinite(Number(record.netRoiPct)) ? Number(record.netRoiPct) : realized;
          const showNet = Math.abs(net - realized) > 0.05;
          return (
            <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: realized >= 0 ? '#38bdf8' : '#f87171', fontWeight: 600 }}>
                {formatPercent(realized)}
              </Text>
              {showNet && (
                <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                  Net {formatPercent(net)}
                </Text>
              )}
            </Space>
          );
        },
      },
      {
        title: 'Win Rate',
        key: 'winRate',
        align: 'right',
        render: (_, record) => <Text style={{ color: '#e2e8f0' }}>{formatPercent(record.winRate)}</Text>,
      },
      {
        title: 'Trades',
        dataIndex: 'totalTrades',
        align: 'center',
        render: (value?: number) => <Text style={{ color: '#cbd5f5' }}>{Number(value ?? 0)}</Text>,
      },
      {
        title: 'Actions',
        key: 'actions',
        align: 'right',
        render: (_, record) => (
          <Space>
            <Button
              type={isSessionActive(record) ? 'default' : 'primary'}
              danger={isSessionActive(record)}
              size="small"
              icon={isSessionActive(record) ? <PauseCircleFilled /> : <PlayCircleFilled />}
              onClick={(event) => {
                event.stopPropagation();
                handlePrimaryAction(record);
              }}
            >
              {isSessionActive(record) ? 'Pause' : 'Start'}
            </Button>
            <Tooltip title="View details">
              <Button
                size="small"
                icon={<EyeOutlined />}
                onClick={(event) => {
                  event.stopPropagation();
                  navigate(`/agents/${record.id}`);
                }}
              />
            </Tooltip>
            <Tooltip title="Delete agent">
              <Button
                danger
                size="small"
                icon={<DeleteOutlined />}
                onClick={(event) => {
                  event.stopPropagation();
                  handleDeleteSession(record);
                }}
              />
            </Tooltip>
          </Space>
        ),
      },
    ],
    [handleDeleteSession, handlePrimaryAction, navigate]
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        paddingBottom: 48,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 20,
          marginBottom: 8,
        }}
      >
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <Title level={2} style={{ color: '#f8fafc', marginBottom: 0, fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em' }}>
              AI Trading Agents
            </Title>
            <Tag
              style={{
                borderRadius: 12,
                border: 'none',
                background: currentMode === 'live' 
                  ? 'linear-gradient(135deg, rgba(34, 197, 94, 0.18), rgba(74, 222, 128, 0.24))' 
                  : 'linear-gradient(135deg, rgba(59, 130, 246, 0.18), rgba(147, 197, 253, 0.24))',
                color: currentMode === 'live' ? '#4ade80' : '#93c5fd',
                fontWeight: 600,
                padding: '4px 14px',
                fontSize: 13,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}
            >
              {currentMode === 'live' ? '🔴 LIVE' : '📊 PAPER'}
            </Tag>
          </div>
          <Text style={{ color: 'rgba(203, 213, 225, 0.82)', fontSize: 15, lineHeight: 1.5 }}>
            Autonomous multi-agent system with intelligent portfolio diversification
          </Text>
          <div style={{ marginTop: 12, display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#60a5fa' }} />
              <Text style={{ color: 'rgba(148, 163, 184, 0.88)', fontSize: 13 }}>
                {sessions.filter(s => isSessionActive(s)).length} Active
              </Text>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fbbf24' }} />
              <Text style={{ color: 'rgba(148, 163, 184, 0.88)', fontSize: 13 }}>
                {sessions.filter(s => s.haltedAt).length} Paused
              </Text>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#94a3b8' }} />
              <Text style={{ color: 'rgba(148, 163, 184, 0.88)', fontSize: 13 }}>
                {sessions.filter(s => s.stoppedAt).length} Stopped
              </Text>
            </div>
          </div>
        </div>
        <Space size={12} wrap style={{ alignItems: 'flex-start' }}>
          <Segmented
            value={viewMode}
            onChange={(value) => setViewMode(value as ViewMode)}
            style={{
              background: 'rgba(15, 23, 42, 0.85)',
              padding: 4,
              border: '1px solid rgba(71, 107, 176, 0.22)',
            }}
            options={[
              {
                label: (
                  <Space size={6}>
                    <AppstoreOutlined />
                    <span>Cards</span>
                  </Space>
                ),
                value: 'cards',
              },
              {
                label: (
                  <Space size={6}>
                    <BarsOutlined />
                    <span>Table</span>
                  </Space>
                ),
                value: 'table',
              },
            ]}
          />
          <Button 
            icon={<ReloadOutlined />} 
            onClick={handleRefresh} 
            disabled={loading}
            style={{
              height: 40,
              borderRadius: 10,
              border: '1px solid rgba(71, 107, 176, 0.28)',
              background: 'rgba(15, 23, 42, 0.65)',
              color: '#cbd5f5',
            }}
          >
            Refresh
          </Button>
          <Button 
            type="primary" 
            icon={<PlusOutlined />} 
            onClick={openCreateModal}
            style={{
              height: 40,
              borderRadius: 10,
              background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
              border: 'none',
              boxShadow: '0 4px 12px rgba(59, 130, 246, 0.35)',
              fontWeight: 600,
            }}
          >
            Create Agent
          </Button>
        </Space>
      </div>

      {viewMode === 'cards' ? (
        <div style={cardGridStyle}>
          {loading
            ? Array.from({ length: 3 }).map((_, index) => (
                <Card key={`skeleton-${index}`} style={cardStyle} bodyStyle={{ padding: 24 }}>
                  <Skeleton active paragraph={{ rows: 6 }} />
                </Card>
              ))
            : sessions.length === 0
            ? (
                <Card style={cardStyle} bodyStyle={{ padding: 48, textAlign: 'center' }}>
                  <Empty description="No agents yet" />
                </Card>
              )
            : sessions.map((session) => {
                const meta = statusMeta(session);
                const selectionMeta = selectionBadgeMeta(session.isSmartAgent);
                const strategySnapshot =
                  session.strategy && typeof session.strategy === 'object' && !Array.isArray(session.strategy)
                    ? (session.strategy as StrategySnapshot)
                    : null;
                const primary = strategySnapshot?.primary ?? null;
                const biasMeta = primary?.bias ? BIAS_META[primary.bias] : null;
                const confidenceText = formatConfidenceTag(primary?.confidence);
                const guardrail = primary?.guardrail;
                return (
                  <Card
                    key={session.id}
                    style={{
                      ...cardStyle,
                      cursor: 'pointer',
                    }}
                    bodyStyle={{ 
                      padding: 0,
                      display: 'flex', 
                      flexDirection: 'column',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = 'translateY(-6px)';
                      e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.55)';
                      e.currentTarget.style.boxShadow = '0 32px 64px -32px rgba(59, 130, 246, 0.35), 0 0 1px rgba(59, 130, 246, 0.6)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'translateY(0)';
                      e.currentTarget.style.borderColor = 'rgba(71, 107, 176, 0.32)';
                      e.currentTarget.style.boxShadow = '0 24px 56px -32px rgba(0, 0, 0, 0.6), 0 0 1px rgba(71, 107, 176, 0.4)';
                    }}
                    onClick={() => navigate(`/agents/${session.id}`)}
                  >
                    {/* Header with gradient accent */}
                    <div style={{
                      background: meta.tone,
                      padding: '20px 24px',
                      borderBottom: '1px solid rgba(71, 107, 176, 0.18)',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <Space direction="vertical" size={6} style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <Text style={{ color: '#f8fafc', fontSize: 19, fontWeight: 700, letterSpacing: '-0.01em' }}>
                              {resolveAgentLabel(session)}
                            </Text>
                            {session.symbol && (
                              <Text style={{ 
                                color: 'rgba(226, 232, 240, 0.72)', 
                                fontSize: 14,
                                fontWeight: 500,
                              }}>
                                {session.symbol}
                              </Text>
                            )}
                          </div>
                          <Space size={6} wrap>
                            <Tag
                              style={{
                                borderRadius: 8,
                                border: 'none',
                                background: strategySnapshot?.engine
                                  ? `${STRATEGY_META[strategySnapshot.engine].color}22`
                                  : 'rgba(148, 163, 184, 0.14)',
                                color: strategySnapshot?.engine
                                  ? STRATEGY_META[strategySnapshot.engine].color
                                  : '#cbd5f5',
                                fontSize: 11,
                                fontWeight: 600,
                                textTransform: 'uppercase',
                                letterSpacing: '0.3px',
                                padding: '2px 10px',
                              }}
                            >
                              {resolveSessionStrategyLabel(session)}
                            </Tag>
                            {biasMeta && (
                              <Tag
                                style={{
                                  borderRadius: 8,
                                  border: 'none',
                                  background: biasMeta.background,
                                  color: biasMeta.color,
                                  fontSize: 11,
                                  fontWeight: 600,
                                  padding: '2px 10px',
                                }}
                              >
                                {biasMeta.label}
                              </Tag>
                            )}
                            <Tag
                              style={{
                                borderRadius: 8,
                                border: 'none',
                                background: selectionMeta.background,
                                color: selectionMeta.color,
                                fontSize: 11,
                                fontWeight: 500,
                                padding: '2px 10px',
                              }}
                            >
                              {selectionMeta.label}
                            </Tag>
                          </Space>
                          {confidenceText && (
                            <Text style={{ color: 'rgba(148, 163, 184, 0.85)', fontSize: 12 }}>
                              {confidenceText}
                            </Text>
                          )}
                        </Space>
                        <Tag
                          style={{
                            borderRadius: 10,
                            border: 'none',
                            background: 'rgba(15, 23, 42, 0.45)',
                            color: meta.color,
                            fontWeight: 700,
                            padding: '8px 14px',
                            fontSize: 12,
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px',
                            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                          }}
                        >
                          {meta.label}
                        </Tag>
                      </div>
                    </div>

                    {/* Metrics Grid */}
                    <div style={{ padding: '24px' }}>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(2, 1fr)',
                          gap: 18,
                          marginBottom: 20,
                        }}
                      >
                        <div style={{
                          background: 'rgba(30, 41, 59, 0.55)',
                          borderRadius: 14,
                          padding: '16px 18px',
                          border: '1px solid rgba(71, 107, 176, 0.18)',
                        }}>
                          <Text style={{ color: 'rgba(148, 163, 184, 0.75)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>
                            P&L
                          </Text>
                          <div
                            style={{
                              color: Number(session.pnlUsd ?? 0) >= 0 ? '#4ade80' : '#f87171',
                              fontWeight: 700,
                              fontSize: 22,
                              marginTop: 8,
                              letterSpacing: '-0.02em',
                            }}
                          >
                            {formatUsd(session.pnlUsd)}
                          </div>
                        </div>
                        <div style={{
                          background: 'rgba(30, 41, 59, 0.55)',
                          borderRadius: 14,
                          padding: '16px 18px',
                          border: '1px solid rgba(71, 107, 176, 0.18)',
                        }}>
                          <Text style={{ color: 'rgba(148, 163, 184, 0.75)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>
                            ROI
                          </Text>
                          <div style={{ marginTop: 8 }}>
                            <div
                              style={{
                                color: Number(session.roiPct ?? 0) >= 0 ? '#38bdf8' : '#f87171',
                                fontWeight: 700,
                                fontSize: 22,
                                letterSpacing: '-0.02em',
                              }}
                            >
                              {formatPercent(session.roiPct)}
                            </div>
                            {Math.abs(Number(session.netRoiPct ?? session.roiPct) - Number(session.roiPct ?? 0)) > 0.05 && (
                              <Text style={{ color: 'rgba(148, 163, 184, 0.78)', fontSize: 11 }}>
                                Net {formatPercent(session.netRoiPct)}
                              </Text>
                            )}
                          </div>
                        </div>
                        <div style={{
                          background: 'rgba(30, 41, 59, 0.55)',
                          borderRadius: 14,
                          padding: '16px 18px',
                          border: '1px solid rgba(71, 107, 176, 0.18)',
                        }}>
                          <Text style={{ color: 'rgba(148, 163, 184, 0.75)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>
                            Win Rate
                          </Text>
                          <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 22, marginTop: 8, letterSpacing: '-0.02em' }}>
                            {formatPercent(session.winRate)}
                          </div>
                        </div>
                        <div style={{
                          background: 'rgba(30, 41, 59, 0.55)',
                          borderRadius: 14,
                          padding: '16px 18px',
                          border: '1px solid rgba(71, 107, 176, 0.18)',
                        }}>
                          <Text style={{ color: 'rgba(148, 163, 184, 0.75)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>
                            Trades
                          </Text>
                          <div style={{ color: '#cbd5f5', fontWeight: 700, fontSize: 22, marginTop: 8, letterSpacing: '-0.02em' }}>
                            {Number(session.totalTrades ?? 0)}
                          </div>
                        </div>
                      </div>

                      {/* Action Buttons */}
                      <Space size={10} wrap style={{ width: '100%' }}>
                        <Button
                          type={isSessionActive(session) ? 'default' : 'primary'}
                          danger={isSessionActive(session)}
                          icon={isSessionActive(session) ? <PauseCircleFilled /> : <PlayCircleFilled />}
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePrimaryAction(session);
                          }}
                          style={{
                            borderRadius: 10,
                            fontWeight: 600,
                            height: 38,
                            flex: 1,
                            minWidth: 110,
                          }}
                        >
                          {isSessionActive(session) ? 'Pause' : 'Start'}
                        </Button>
                        <Button 
                          icon={<EyeOutlined />} 
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/agents/${session.id}`);
                          }}
                          style={{
                            borderRadius: 10,
                            height: 38,
                            flex: 1,
                            minWidth: 90,
                          }}
                        >
                          Details
                        </Button>
                        <Button 
                          danger 
                          icon={<DeleteOutlined />} 
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteSession(session);
                          }}
                          style={{
                            borderRadius: 10,
                            height: 38,
                          }}
                        />
                      </Space>
                    </div>
                  </Card>
                );
              })}
        </div>
      ) : (
        <Card style={cardStyle} bodyStyle={{ padding: 0 }}>
          <Table
            rowKey="id"
            columns={columns}
            dataSource={sessions}
            pagination={false}
            loading={loading}
            onRow={(record) => ({
              onClick: () => navigate(`/agents/${record.id}`),
              style: { cursor: 'pointer' },
            })}
          />
          {sessions.length === 0 && !loading ? (
            <div style={{ padding: 32 }}>
              <Empty description="No agents yet" />
            </div>
          ) : null}
        </Card>
      )}

      <AgentCreationModal
        visible={modalOpen}
        mode={currentMode}
        onClose={closeModal}
        onSuccess={handleAgentCreated}
      />
    </div>
  );
}
