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

type AggressivenessLevel = 'conservative' | 'reactive' | 'aggressive';

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

type CreationFormShape = {
  smartAutoMode: boolean;
  symbol?: string;
  maxLeverage: number;
  aggressiveness: AggressivenessLevel;
  mode: AppMode;
  strategyEngine: StrategyEngineOption;
};

const AGGRESSIVENESS_PRESETS: Record<AggressivenessLevel, { risk: number; dailyLoss: number; note: string }> = {
  conservative: {
    risk: 1.0,
    dailyLoss: 3.0,
    note: 'Tight exposure for steadier growth.',
  },
  reactive: {
    risk: 1.5,
    dailyLoss: 3.5,
    note: 'Balanced risk profile for most agents.',
  },
  aggressive: {
    risk: 2.2,
    dailyLoss: 3.8,
    note: 'Higher swings allowed for faster compounding.',
  },
};

const commonSymbols = [
  'BTC/USDT',
  'ETH/USDT',
  'SOL/USDT',
  'XRP/USDT',
  'BNB/USDT',
  'ADA/USDT',
  'AVAX/USDT',
  'DOGE/USDT',
  'TON/USDT',
  'LINK/USDT',
  'MATIC/USDT',
  'DOT/USDT',
];

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
      tone: 'linear-gradient(135deg, rgba(251, 191, 36, 0.25), rgba(251, 146, 60, 0.35))',
      color: '#fbbf24',
    };
  }
  if (session.stoppedAt) {
    return {
      label: 'Stopped',
      tone: 'linear-gradient(135deg, rgba(148, 163, 184, 0.18), rgba(100, 116, 139, 0.32))',
      color: '#cbd5f5',
    };
  }
  return {
    label: 'Active',
    tone: 'linear-gradient(135deg, rgba(34, 197, 94, 0.25), rgba(74, 222, 128, 0.35))',
    color: '#4ade80',
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
  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
  gap: 20,
  width: '100%',
};

const cardStyle: React.CSSProperties = {
  background: 'linear-gradient(155deg, rgba(16, 27, 57, 0.95) 0%, rgba(16, 26, 49, 0.75) 100%)',
  border: '1px solid rgba(56, 90, 150, 0.35)',
  borderRadius: 18,
  boxShadow: '0 18px 40px -24px rgba(15, 23, 42, 0.75)',
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
  const [editingSession, setEditingSession] = React.useState<AgentSession | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [form] = Form.useForm<CreationFormShape>();

  const smartAutoMode = Form.useWatch('smartAutoMode', form);
  const aggressiveness = (Form.useWatch('aggressiveness', form) as AggressivenessLevel) ?? 'conservative';
  const strategyEngine = (Form.useWatch('strategyEngine', form) as StrategyEngineOption) ?? 'meta_adaptive';
  const riskPreset = AGGRESSIVENESS_PRESETS[aggressiveness];

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
    setEditingSession(null);
    form.resetFields();
    form.setFieldsValue({
      smartAutoMode: true,
      maxLeverage: 4,
      aggressiveness: 'conservative',
      mode: currentMode,
    });
    setModalOpen(true);
  }, [currentMode, form]);

  const openEditModal = React.useCallback(
    (session: AgentSession) => {
      setEditingSession(session);
      form.resetFields();
      form.setFieldsValue({
        smartAutoMode: Boolean(session.isSmartAgent),
        symbol: session.symbol,
        maxLeverage:
          Number((session.profile as any)?.requestedMaxLeverage ?? (session.profile as any)?.maxLeverage ?? 4) || 4,
        aggressiveness: ((session.profile as any)?.aggressiveness as AggressivenessLevel) ?? 'conservative',
        mode: session.mode,
        strategyEngine:
          ((session.profile as any)?.strategyEngine as StrategyEngineOption)
            || (session.strategyEngine as StrategyEngineOption)
            || 'meta_adaptive',
      });
      setModalOpen(true);
    },
    [form]
  );

  const closeModal = React.useCallback(() => {
    setModalOpen(false);
    setEditingSession(null);
    form.resetFields();
  }, [form]);

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

  const handleModalSubmit = React.useCallback(async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload = {
        mode: values.mode ?? currentMode,
        smartAutoMode: values.smartAutoMode,
        maxLeverage: values.maxLeverage,
        aggressiveness: values.aggressiveness,
        strategyEngine: values.strategyEngine,
      } as Record<string, any>;

      if (!values.smartAutoMode) {
        payload.symbol = values.symbol;
      }

      if (editingSession) {
        await api.restartSession(editingSession.id, payload);
        message.success('Agent settings updated');
      } else {
        const prepare = await api.prepareAgentCreation(payload);
        const creationId: string | undefined = prepare?.creationId;
        const selectedSymbol = values.smartAutoMode ? prepare?.selection?.symbol : values.symbol;

        if (!creationId) {
          throw new Error('Missing creation identifier');
        }

        await api.createAgentSession(creationId, selectedSymbol);
        const activation = await api.activateAgentCreation(creationId);
        message.success(
          activation?.symbol
            ? `Agent ready on ${activation.symbol}`
            : 'Agent created successfully'
        );
      }

      invalidateCache(currentMode);
      await fetchSessions(true);
      closeModal();
    } catch (error: any) {
      const detail = error?.response?.data?.message || error?.message || error;
      message.error(typeof detail === 'string' ? detail : 'Unable to save agent');
    } finally {
      setSubmitting(false);
      setEditingSession(null);
    }
  }, [closeModal, currentMode, editingSession, fetchSessions, form, invalidateCache]);

  const handlePrimaryAction = React.useCallback(
    (session: AgentSession) => {
      if (isSessionActive(session)) {
        handleStopSession(session);
        return;
      }
      openEditModal(session);
    },
    [handleStopSession, openEditModal]
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
          return (
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
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 16,
        }}
      >
        <div>
          <Title level={3} style={{ color: '#f8fafc', marginBottom: 4 }}>
            AI Trading Agents
          </Title>
          <Text style={{ color: 'rgba(148, 163, 184, 0.78)' }}>
            Manage automated strategies in {currentMode === 'live' ? 'live' : 'paper'} mode.
          </Text>
        </div>
        <Space size={12} wrap>
          <Segmented
            value={viewMode}
            onChange={(value) => setViewMode(value as ViewMode)}
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
          <Button icon={<ReloadOutlined />} onClick={handleRefresh} disabled={loading}>
            Refresh
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
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
                    style={cardStyle}
                    bodyStyle={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <Space direction="vertical" size={4}>
                        <Text style={{ color: '#f8fafc', fontSize: 18, fontWeight: 600 }}>
                          {resolveAgentLabel(session)}
                        </Text>
                        <Space size={6} wrap>
                          <Tag
                            style={{
                              borderRadius: 10,
                              border: 'none',
                              background: strategySnapshot?.engine
                                ? `${STRATEGY_META[strategySnapshot.engine].color}20`
                                : 'rgba(148, 163, 184, 0.12)',
                              color: strategySnapshot?.engine
                                ? STRATEGY_META[strategySnapshot.engine].color
                                : '#cbd5f5',
                            }}
                          >
                            {resolveSessionStrategyLabel(session)}
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
                          <Text style={{ color: 'rgba(148, 163, 184, 0.78)', fontSize: 12 }}>{confidenceText}</Text>
                        )}
                        <Space size={6}>
                          <Tag
                            style={{
                              borderRadius: 10,
                              border: 'none',
                              background: 'rgba(59, 130, 246, 0.12)',
                              color: '#93c5fd',
                            }}
                          >
                            {session.mode?.toUpperCase?.()}
                          </Tag>
                          <Tag
                            style={{
                              borderRadius: 10,
                              border: 'none',
                              background: selectionMeta.background,
                              color: selectionMeta.color,
                            }}
                          >
                            {selectionMeta.label}
                          </Tag>
                        </Space>
                      </Space>
                      <Tag
                        style={{
                          borderRadius: 12,
                          border: 'none',
                          background: meta.tone,
                          color: meta.color,
                          fontWeight: 600,
                          padding: '6px 12px',
                        }}
                      >
                        {meta.label}
                      </Tag>
                    </div>

                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                        gap: 16,
                      }}
                    >
                      <div>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 12 }}>Pair</Text>
                        <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 16 }}>{session.symbol || '—'}</div>
                      </div>
                      <div>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 12 }}>Capital source</Text>
                        <Tooltip title="Allocation dynamique depuis le pool de capital partagé">
                          <div style={{ color: '#93c5fd', fontWeight: 600, fontSize: 16 }}>Shared pool</div>
                        </Tooltip>
                      </div>
                      <div>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 12 }}>PnL</Text>
                        <div
                          style={{
                            color: Number(session.pnlUsd ?? 0) >= 0 ? '#4ade80' : '#f87171',
                            fontWeight: 600,
                            fontSize: 16,
                          }}
                        >
                          {formatUsd(session.pnlUsd)}
                        </div>
                      </div>
                      <div>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 12 }}>ROI</Text>
                        <div
                          style={{
                            color: Number(session.roiPct ?? 0) >= 0 ? '#38bdf8' : '#f87171',
                            fontWeight: 600,
                            fontSize: 16,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'flex-start',
                            gap: 2,
                          }}
                        >
                          <span>{formatPercent(session.roiPct)}</span>
                          {Math.abs(Number(session.netRoiPct ?? session.roiPct) - Number(session.roiPct ?? 0)) > 0.05 && (
                            <span style={{ color: '#94a3b8', fontSize: 12, fontWeight: 500 }}>
                              Net {formatPercent(session.netRoiPct)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 12 }}>Win Rate</Text>
                        <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 16 }}>
                          {formatPercent(session.winRate)}
                        </div>
                      </div>
                      <div>
                        <Text style={{ color: 'rgba(148, 163, 184, 0.6)', fontSize: 12 }}>Trades</Text>
                        <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 16 }}>
                          {Number(session.totalTrades ?? 0)}
                        </div>
                      </div>
                    </div>

                    <Space size={12} wrap>
                      <Button
                        type={isSessionActive(session) ? 'default' : 'primary'}
                        danger={isSessionActive(session)}
                        icon={isSessionActive(session) ? <PauseCircleFilled /> : <PlayCircleFilled />}
                        onClick={() => handlePrimaryAction(session)}
                      >
                        {isSessionActive(session) ? 'Pause' : 'Start'}
                      </Button>
                      <Button icon={<EyeOutlined />} onClick={() => navigate(`/agents/${session.id}`)}>
                        View
                      </Button>
                      <Button danger icon={<DeleteOutlined />} onClick={() => handleDeleteSession(session)}>
                        Remove
                      </Button>
                    </Space>
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

      <Modal
        open={modalOpen}
        onCancel={closeModal}
        onOk={handleModalSubmit}
        okText={editingSession ? 'Save' : 'Create agent'}
        confirmLoading={submitting}
        title={editingSession ? 'Adjust agent settings' : 'Create new agent'}
        destroyOnClose
        maskClosable={false}
        styles={{
          body: {
            background: 'linear-gradient(155deg, rgba(15, 23, 42, 0.95) 0%, rgba(15, 23, 42, 0.85) 100%)',
            padding: 24,
            borderRadius: 16,
          },
          header: {
            background: 'rgba(15, 23, 42, 0.92)',
            borderBottom: '1px solid rgba(148, 163, 184, 0.18)',
          },
          footer: {
            background: 'rgba(15, 23, 42, 0.92)',
            borderTop: '1px solid rgba(148, 163, 184, 0.18)',
          },
        }}
      >
        <Form<CreationFormShape>
          layout="vertical"
          form={form}
          initialValues={{
            smartAutoMode: true,
            maxLeverage: 4,
            aggressiveness: 'conservative',
            mode: currentMode,
            strategyEngine: 'meta_adaptive',
          }}
        >
          <Form.Item
            label={<Text style={{ color: '#e2e8f0' }}>Auto-select best market</Text>}
            name="smartAutoMode"
            valuePropName="checked"
          >
            <Switch
              checkedChildren="Auto"
              unCheckedChildren="Manual"
              style={{ background: smartAutoMode ? '#6366f1' : undefined }}
            />
          </Form.Item>

          {!smartAutoMode && (
            <Form.Item
              label={<Text style={{ color: '#e2e8f0' }}>Trading pair</Text>}
              name="symbol"
              rules={[{ required: true, message: 'Select a trading pair' }]}
            >
              <Select
                showSearch
                placeholder="Select pair"
                options={commonSymbols.map((symbol) => ({ label: symbol, value: symbol }))}
                filterOption={(input, option) =>
                  (option?.label as string).toLowerCase().includes(input.toLowerCase())
                }
              />
            </Form.Item>
          )}

          {currentMode !== 'live' && (
            <Alert
              type="info"
              showIcon
              message="Shared capital pool"
              description="Allocation dynamique depuis le pool : chaque agent réserve le capital dont il a besoin en fonction du solde disponible."
              style={{
                background: 'rgba(59, 130, 246, 0.08)',
                border: '1px solid rgba(59, 130, 246, 0.24)',
                borderRadius: 12,
                color: '#e2e8f0',
              }}
            />
          )}

          <Form.Item label={<Text style={{ color: '#e2e8f0' }}>Max leverage</Text>} name="maxLeverage">
            <Slider min={1} max={10} tooltip={{ formatter: (value) => `${value}x` }} />
          </Form.Item>

          <Form.Item
            label={<Text style={{ color: '#e2e8f0' }}>Aggressiveness</Text>}
            name="aggressiveness"
            rules={[{ required: true }]}
          >
            <Select
              options={[
                { value: 'conservative', label: 'Conservative' },
                { value: 'reactive', label: 'Reactive' },
                { value: 'aggressive', label: 'Aggressive' },
              ]}
            />
          </Form.Item>

          <Form.Item
            label={<Text style={{ color: '#e2e8f0' }}>Strategy engine</Text>}
            name="strategyEngine"
            rules={[{ required: true, message: 'Select a strategy engine' }]}
          >
            <Select
              options={Object.entries(STRATEGY_META).map(([value, meta]) => ({ value, label: meta.label }))}
            />
          </Form.Item>

          <div
            style={{
              background: 'rgba(30, 41, 59, 0.65)',
              border: '1px solid rgba(148, 163, 184, 0.22)',
              borderRadius: 12,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              marginBottom: 16,
            }}
          >
            <Text style={{ color: '#f8fafc', fontWeight: 600 }}>Selected engine</Text>
            <Text style={{ color: 'rgba(148, 163, 184, 0.78)' }}>{STRATEGY_META[strategyEngine].label}</Text>
            <Text style={{ color: 'rgba(148, 163, 184, 0.65)', fontSize: 12 }}>
              {STRATEGY_DESCRIPTIONS[strategyEngine]}
            </Text>
          </div>

          <div
            style={{
              background: 'rgba(30, 41, 59, 0.65)',
              border: '1px solid rgba(148, 163, 184, 0.22)',
              borderRadius: 12,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <Text style={{ color: '#f8fafc', fontWeight: 600 }}>Risk profile</Text>
            <Text style={{ color: 'rgba(148, 163, 184, 0.78)' }}>
              Risk per trade: <strong>{riskPreset.risk.toFixed(1)}%</strong>
            </Text>
            <Text style={{ color: 'rgba(148, 163, 184, 0.78)' }}>
              Daily loss cap: <strong>{riskPreset.dailyLoss.toFixed(1)}%</strong>
            </Text>
            <Text style={{ color: 'rgba(148, 163, 184, 0.65)', fontSize: 12 }}>{riskPreset.note}</Text>
          </div>

          <Form.Item name="mode" hidden initialValue={currentMode}>
            <input type="hidden" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
