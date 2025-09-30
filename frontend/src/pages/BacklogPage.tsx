import React from 'react';
import { Card, Space, Typography, List, Tag, message, Button, Badge, Empty, Tooltip } from 'antd';
import { ThunderboltOutlined, ReloadOutlined, InfoCircleOutlined, WarningOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';

const { Title, Text } = Typography;

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

const levelMeta: Record<string, { color: string; label: string; icon: React.ReactNode }> = {
  info: { color: 'blue', label: 'Info', icon: <InfoCircleOutlined /> },
  warn: { color: 'gold', label: 'Watch', icon: <WarningOutlined /> },
  error: { color: 'red', label: 'Action', icon: <ExclamationCircleOutlined /> },
};

const messageCatalog: Record<string, { title: string; description?: string }> = {
  volume_too_low: {
    title: 'Volume unchanged – skipping entry',
    description: 'Spot + derivatives volume is under the 0.60× requirement, so the strategy waits for healthier liquidity.',
  },
  atr_too_low: {
    title: 'Volatility filter blocked the trade',
    description: 'ATR is below the minimum threshold for crypto entries; momentum is too muted right now.',
  },
  adx_not_ready: {
    title: 'Trend strength too weak',
    description: 'ADX needs to firm up before we engage. The agent will keep scanning.',
  },
  quality_filter_passed: {
    title: 'Setup cleared all quality gates',
    description: 'All momentum, volume and volatility checks passed — waiting on execution signals.',
  },
  bias_conflict: {
    title: 'Signal rejected due to conflicting bias',
    description: 'Directional consensus isn’t aligned across timeframes, so the agent stands down.',
  },
};

const fieldLabels: Record<string, string> = {
  bias: 'Bias',
  atrPct: 'ATR %',
  volumeRatio: 'Volume vs MA',
  requiredVolumeRatio: 'Min Volume Ratio',
  adx: 'ADX',
  emaSpread: 'EMA Spread',
  liquidityScore: 'Liquidity',
  fundingRate: 'Funding Rate',
  winRate: 'Win Rate',
  usdVolumeMA: 'Avg USD Volume',
  level: 'Aggressiveness',
  volumeBaseline: 'Symbol Volume Avg',
  volumePressure: 'Volume Pressure',
};

function formatTime(ts?: number) {
  if (!ts) return '—';
  return dayjs(ts).format('HH:mm:ss');
}

export default function BacklogPage() {
  const { mode } = useMode();
  const [loading, setLoading] = React.useState(false);
  const [events, setEvents] = React.useState<OpsEvent[]>([]);
  const [activeSessions, setActiveSessions] = React.useState<any[]>([]);

  const loadActivity = React.useCallback(async () => {
    setLoading(true);
    try {
      const [sessionsResponse, opsResponse] = await Promise.all([
        api.listSessions(mode).catch(() => []),
        api.getOpsEvents(120).catch(() => []),
      ]);
      const activeOnly = Array.isArray(sessionsResponse)
        ? sessionsResponse.filter((session: any) => !session.stoppedAt)
        : [];
      setActiveSessions(activeOnly);

      const activeSet = new Set(activeOnly.map((session: any) => session.id));
      const filtered = Array.isArray(opsResponse)
        ? opsResponse.filter((evt: OpsEvent) => !evt.sessionId || activeSet.has(evt.sessionId))
        : [];
      const sorted = filtered.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 80);
      setEvents(sorted);
    } catch (err) {
      console.error('Failed to load backlog activity', err);
      message.error('Unable to refresh agent activity right now.');
    } finally {
      setLoading(false);
    }
  }, [mode]);

  React.useEffect(() => {
    loadActivity();
    const timer = setInterval(loadActivity, 30000);
    return () => clearInterval(timer);
  }, [loadActivity]);

  const eventsBySession = React.useMemo(() => {
    const map = new Map<string, OpsEvent[]>();
    activeSessions.forEach((session: any) => {
      map.set(session.id, []);
    });
    events.forEach((evt) => {
      if (!evt.sessionId) return;
      const bucket = map.get(evt.sessionId);
      if (bucket) bucket.push(evt);
    });
    return map;
  }, [events, activeSessions]);

  const decorateEvent = (evt: OpsEvent) => {
    const meta = levelMeta[evt.level || 'info'] || levelMeta.info;
    const catalog = messageCatalog[evt.message || ''] || null;
    const title = catalog?.title || (evt.message ? evt.message.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()) : 'Agent update');
    const description = catalog?.description;
    const detailsObject = normalizeDetails(evt.details);
    const detailEntries = Object.entries(detailsObject).map(([key, value]) => ({
      key,
      label: fieldLabels[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()),
      value: formatDetailValue(key, value),
    })).filter((entry) => entry.value !== undefined && entry.value !== null && entry.value !== '');
    return { meta, title, description, detailEntries };
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Space align="center" size="middle">
            <Badge count={activeSessions.length} size="small" color="#2563eb">
              <AvatarIcon />
            </Badge>
            <div>
              <Title level={3} style={{ margin: 0 }}>Agent Activity Feed</Title>
              <Text type="secondary">
                Live operational timeline for the active crypto agents.
              </Text>
            </div>
          </Space>
          <Space wrap size="small">
            <Tag color="blue">{activeSessions.length} active agents</Tag>
            <Tag color="cyan">{events.length} recent events</Tag>
            <Button size="small" icon={<ReloadOutlined />} onClick={loadActivity} loading={loading}>
              Refresh
            </Button>
          </Space>
        </Space>
      </Card>

      <Card
        title="Latest Activity"
        loading={loading}
        extra={
          <Button type="link" icon={<ReloadOutlined />} onClick={loadActivity} disabled={loading}>
            Refresh
          </Button>
        }
      >
        {events.length === 0 ? (
          <Empty description="No recent activity for active agents" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <List
            itemLayout="vertical"
            dataSource={events.slice(0, 30)}
            renderItem={(evt) => {
              const decorated = decorateEvent(evt);
              const meta = decorated.meta;
              const session = evt.sessionId
                ? activeSessions.find((s: any) => s.id === evt.sessionId)
                : null;
              return (
                <List.Item key={evt.id} style={{ padding: '12px 8px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                      <Tag color={meta.color} icon={meta.icon}>{meta.label}</Tag>
                      {evt.symbol && (
                        <Tag bordered={false} style={{ background: '#eef2ff', color: '#312e81' }}>{evt.symbol}</Tag>
                      )}
                      {session && (
                        <Text type="secondary">{session.mode?.toUpperCase()}</Text>
                      )}
                      <Text type="secondary">{formatTime(evt.ts)}</Text>
                    </div>
                    <Text strong style={{ fontSize: 14 }}>{decorated.title}</Text>
                    {decorated.description && (
                      <Text type="secondary" style={{ fontSize: 13 }}>{decorated.description}</Text>
                    )}
                    {decorated.detailEntries.length > 0 && (
                      <Space wrap size={8} style={{ marginTop: 4 }}>
                        {decorated.detailEntries.map((entry) => (
                          <Tooltip key={entry.key} title={entry.label}>
                            <Tag bordered={false} style={{ background: '#f4f4f5', color: '#111827', borderRadius: 12 }}>
                              <span style={{ fontWeight: 600 }}>{entry.value}</span>
                              {entry.label ? <span style={{ marginLeft: 6, color: '#6b7280', fontWeight: 500 }}>{entry.label}</span> : null}
                            </Tag>
                          </Tooltip>
                        ))}
                      </Space>
                    )}
                  </div>
                </List.Item>
              );
            }}
          />
        )}
      </Card>

      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {activeSessions.length === 0 && (
          <Card>
            <Empty description="No active agents" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          </Card>
        )}
        {activeSessions.map((session: any) => {
          const sessionEvents = eventsBySession.get(session.id) || [];
          return (
            <Card
              key={session.id}
              title={
                <Space>
                  <Tag color="blue">{session.symbol}</Tag>
                  <Text>{session.mode?.toUpperCase()}</Text>
                </Space>
              }
              extra={<Text type="secondary">{sessionEvents.length} events today</Text>}
            >
              {sessionEvents.length === 0 ? (
                <Empty
                  description="No recent logs for this agent"
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                />
              ) : (
                <List
                  dataSource={sessionEvents.slice(0, 10)}
                  renderItem={(evt) => {
                    const decorated = decorateEvent(evt);
                    const meta = decorated.meta;
                    return (
                      <List.Item key={evt.id} style={{ padding: '10px 6px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                            <Tag color={meta.color} icon={meta.icon}>{meta.label}</Tag>
                            <Text>{evt.source}</Text>
                            <Text type="secondary">{formatTime(evt.ts)}</Text>
                          </div>
                          <Text strong style={{ fontSize: 13 }}>{decorated.title}</Text>
                          {decorated.description && (
                            <Text type="secondary" style={{ fontSize: 12 }}>{decorated.description}</Text>
                          )}
                          {decorated.detailEntries.length > 0 && (
                            <Space wrap size={8}>
                              {decorated.detailEntries.map((entry) => (
                                <Tag key={entry.key} bordered={false} style={{ background: '#eef2ff', color: '#1e293b', borderRadius: 12 }}>
                                  <span style={{ fontWeight: 600 }}>{entry.value}</span>
                                  {entry.label ? <span style={{ marginLeft: 6, color: '#475569', fontWeight: 500 }}>{entry.label}</span> : null}
                                </Tag>
                              ))}
                            </Space>
                          )}
                        </div>
                      </List.Item>
                    );
                  }}
                />
              )}
            </Card>
          );
        })}
      </Space>
    </Space>
  );
}

function AvatarIcon() {
  return (
    <div
      style={{
        width: 48,
        height: 48,
        borderRadius: 12,
        background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontSize: 22,
      }}
    >
      <ThunderboltOutlined />
    </div>
  );
}

function normalizeDetails(details: any): Record<string, any> {
  if (!details) return {};
  if (typeof details === 'string') {
    try {
      return JSON.parse(details);
    } catch {
      return { note: details };
    }
  }
  if (typeof details === 'object') return details as Record<string, any>;
  return { value: details };
}

function formatDetailValue(key: string, value: any): string {
  if (value == null) return '';
  if (typeof value === 'number') {
    if (key === 'usdVolumeMA') return formatUsdVolume(value);
    if (key === 'volumeBaseline') return `${(value * 100).toFixed(1)}%`;
    if (key === 'volumePressure') return `${(value * 100).toFixed(0)}%`;
    if (/ratio/i.test(key)) return `${(value * 100).toFixed(1)}%`;
    if (/pct|percentage/i.test(key)) return `${value.toFixed(2)}%`;
    if (/adx/i.test(key)) return value.toFixed(1);
    if (/score/i.test(key)) return value.toFixed(2);
    return Number.isInteger(value) ? String(value) : value.toFixed(3);
  }
  if (typeof value === 'string') {
    const normalized = value.replace(/_/g, ' ');
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatUsdVolume(raw: number): string {
  if (!Number.isFinite(raw) || raw <= 0) return '—';
  const units = [
    { limit: 1_000_000_000, suffix: 'B' },
    { limit: 1_000_000, suffix: 'M' },
    { limit: 1_000, suffix: 'K' },
  ];
  for (const unit of units) {
    if (raw >= unit.limit) {
      return `$${(raw / unit.limit).toFixed(1)}${unit.suffix}`;
    }
  }
  return `$${raw.toFixed(0)}`;
}
