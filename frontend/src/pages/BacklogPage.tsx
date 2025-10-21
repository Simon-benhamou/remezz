import React from 'react';
import {
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Segmented,
  Space,
  Tag,
  Tooltip,
  Typography,
  message,
  theme,
} from 'antd';
import { ReloadOutlined, BellOutlined, ThunderboltOutlined } from '../icons';
import dayjs from 'dayjs';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import { formatDisplaySymbol } from '../utils/symbols';

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

type SeverityFilter = 'all' | 'info' | 'warn' | 'error';

const severityMeta: Record<string, { color: string; label: string }> = {
  info: { color: '#38bdf8', label: 'Informational' },
  warn: { color: '#fbbf24', label: 'Watch' },
  error: { color: '#f87171', label: 'Action' },
};

const messageCatalog: Record<string, { title: string; description?: string }> = {
  volume_too_low: {
    title: 'Volume unchanged – skipping entry',
    description: 'Spot + derivatives volume is under the requirement, the strategy waits for healthier liquidity.',
  },
  atr_too_low: {
    title: 'Volatility filter blocked the trade',
    description: 'ATR is below the minimum threshold — momentum is too muted for execution.',
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

const BacklogPage: React.FC = () => {
  const { mode } = useMode();
  const { token } = theme.useToken();
  const [loading, setLoading] = React.useState(false);
  const [events, setEvents] = React.useState<OpsEvent[]>([]);
  const [activeSessions, setActiveSessions] = React.useState<any[]>([]);
  const [severity, setSeverity] = React.useState<SeverityFilter>('all');

  const loadActivity = React.useCallback(async () => {
    setLoading(true);
    try {
      const [sessionsResponse, opsResponse] = await Promise.all([
        api.listSessions(mode).catch(() => []),
        api.getOpsEvents(160).catch(() => []),
      ]);
      const activeOnly = Array.isArray(sessionsResponse)
        ? sessionsResponse.filter((session: any) => !session.stoppedAt)
        : [];
      setActiveSessions(activeOnly);

      const activeSet = new Set(activeOnly.map((session: any) => session.id));
      const filtered = Array.isArray(opsResponse)
        ? opsResponse.filter((evt: OpsEvent) => !evt.sessionId || activeSet.has(evt.sessionId))
        : [];
      const sorted = filtered.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 100);
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

  const counts = React.useMemo(() => {
    return events.reduce(
      (acc, evt) => {
        const level = evt.level || 'info';
        acc[level] = (acc[level] || 0) + 1;
        return acc;
      },
      { info: 0, warn: 0, error: 0 } as Record<'info' | 'warn' | 'error', number>,
    );
  }, [events]);

  const filteredEvents = React.useMemo(() => {
    if (severity === 'all') return events;
    return events.filter((evt) => (evt.level || 'info') === severity);
  }, [events, severity]);

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

  const renderEventCard = (evt: OpsEvent) => {
    const level = evt.level || 'info';
    const meta = severityMeta[level] || severityMeta.info;
    const catalog = messageCatalog[evt.message || ''] || null;
    const title = catalog?.title || formatMessage(evt.message);
    const description = catalog?.description;
    const detailsObject = normalizeDetails(evt.details);
    const detailEntries = Object.entries(detailsObject)
      .map(([key, value]) => ({
        key,
        label: fieldLabels[key] || formatMessage(key),
        value: formatDetailValue(key, value),
      }))
      .filter((entry) => entry.value !== undefined && entry.value !== null && entry.value !== '');

    return (
      <Card
        key={evt.id}
        style={{
          borderRadius: 18,
          border: `1px solid ${token.colorBorderSecondary}`,
          background: 'rgba(15, 23, 42, 0.88)',
          height: '100%',
        }}
        bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <Space align='center' size={10}>
          <Badge color={meta.color} />
          <Text style={{ color: meta.color, fontWeight: 600 }}>{meta.label}</Text>
          <Text style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>
            {evt.ts ? dayjs(evt.ts).format('HH:mm:ss') : '—'}
          </Text>
          {evt.source && (
            <Tag color='geekblue' style={{ borderRadius: 8 }}>{evt.source}</Tag>
          )}
        </Space>
        <Text style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 16 }}>{title}</Text>
        {description && <Text style={{ color: 'rgba(148, 163, 184, 0.78)' }}>{description}</Text>}
        <Space size={8} wrap>
          {evt.symbol && <Tag color='cyan'>{formatDisplaySymbol(evt.symbol)}</Tag>}
        </Space>
        {detailEntries.length > 0 && (
          <Space wrap size={8}>
            {detailEntries.slice(0, 4).map((entry) => (
              <Tooltip key={`${evt.id}-${entry.key}`} title={entry.label}>
                <Tag
                  bordered={false}
                  style={{
                    background: 'rgba(96, 165, 250, 0.16)',
                    color: '#e2e8f0',
                    borderRadius: 12,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{entry.value}</span>
                  <span style={{ marginLeft: 6, color: 'rgba(148, 163, 184, 0.78)' }}>{entry.label}</span>
                </Tag>
              </Tooltip>
            ))}
            {detailEntries.length > 4 && (
              <Tag bordered={false} style={{ background: 'rgba(148, 163, 184, 0.18)', color: '#e2e8f0', borderRadius: 12 }}>
                +{detailEntries.length - 4} more
              </Tag>
            )}
          </Space>
        )}
      </Card>
    );
  };

  return (
    <Space direction='vertical' size={24} style={{ width: '100%' }}>
      <Card
        style={{
          borderRadius: 20,
          border: `1px solid ${token.colorBorderSecondary}`,
          background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.92), rgba(30, 64, 175, 0.6))',
        }}
        bodyStyle={{ padding: 28 }}
      >
        <Space direction='vertical' size={12} style={{ width: '100%' }}>
          <Tag color='geekblue' style={{ alignSelf: 'flex-start', borderRadius: 999 }}>
            Market feed
          </Tag>
          <Title level={2} style={{ margin: 0, color: '#e2e8f0' }}>
            Operational telemetry & AI signal feed
          </Title>
          <Text style={{ color: 'rgba(226, 232, 240, 0.72)', maxWidth: 600 }}>
            Review live agent alerts, validator outcomes and market health signals across the trading stack.
          </Text>
          <Space wrap size={12}>
            <Tag color='cyan'>Mode {mode.toUpperCase()}</Tag>
            <Tag color='blue'>{activeSessions.length} active agents</Tag>
            <Tag color='purple'>{events.length} events tracked</Tag>
            <Button icon={<ReloadOutlined />} onClick={loadActivity} loading={loading}>
              Refresh
            </Button>
          </Space>
        </Space>
      </Card>

      <Row gutter={[24, 24]}>
        <Col xs={24} sm={12} xl={6}>
          <SummaryTile
            icon={<ThunderboltOutlined />}
            label='Active agents'
            value={activeSessions.length.toString()}
            hint='Currently trading'
            tone='#60a5fa'
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <SummaryTile
            icon={<BellOutlined />}
            label='Actions'
            value={counts.error.toString()}
            hint='High severity'
            tone='#f87171'
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <SummaryTile
            icon={<BellOutlined />}
            label='Watch'
            value={counts.warn.toString()}
            hint='Medium severity'
            tone='#fbbf24'
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <SummaryTile
            icon={<BellOutlined />}
            label='Info'
            value={counts.info.toString()}
            hint='Advisory'
            tone='#38bdf8'
          />
        </Col>
      </Row>

      <Card
        title={<span style={{ color: '#e2e8f0' }}>Live activity</span>}
        extra={
          <Segmented
            options={[
              { label: 'All', value: 'all' },
              { label: 'Actions', value: 'error' },
              { label: 'Watch', value: 'warn' },
              { label: 'Info', value: 'info' },
            ]}
            value={severity}
            onChange={(val) => setSeverity(val as SeverityFilter)}
            size='small'
          />
        }
        style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
        bodyStyle={{ padding: 24 }}
        loading={loading}
      >
        {filteredEvents.length === 0 ? (
          <Empty description='No recent events in this category.' style={{ margin: '40px 0' }} />
        ) : (
          <Row gutter={[20, 20]}>
            {filteredEvents.slice(0, 12).map((evt) => (
              <Col xs={24} md={12} key={evt.id}>
                {renderEventCard(evt)}
              </Col>
            ))}
          </Row>
        )}
      </Card>

      <Card
        title={<span style={{ color: '#e2e8f0' }}>Active agents</span>}
        style={{ borderRadius: 18, border: `1px solid ${token.colorBorderSecondary}` }}
        bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        {activeSessions.length === 0 ? (
          <Empty description='No active sessions in this mode.' style={{ margin: '40px 0' }} />
        ) : (
          activeSessions.map((session: any) => {
            const sessionEvents = eventsBySession.get(session.id) || [];
            return (
              <Card
                key={session.id}
                style={{
                  borderRadius: 16,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  background: 'rgba(15, 23, 42, 0.88)',
                }}
                bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                <Space align='center' size={10}>
                  <Tag color='cyan'>{formatDisplaySymbol(session.symbol)}</Tag>
                  <Tag color='blue'>{session.mode?.toUpperCase()}</Tag>
                  <Text style={{ color: 'rgba(148, 163, 184, 0.78)' }}>{sessionEvents.length} events</Text>
                </Space>
                {sessionEvents.length === 0 ? (
                  <Text style={{ color: 'rgba(148, 163, 184, 0.78)' }}>No alerts recorded for this agent.</Text>
                ) : (
                  <Space direction='vertical' size={8}>
                    {sessionEvents.slice(0, 3).map((evt) => {
                      const meta = severityMeta[evt.level || 'info'] || severityMeta.info;
                      return (
                        <Space key={evt.id} size={10} wrap>
                          <Badge color={meta.color} />
                          <Text style={{ color: '#e2e8f0', fontWeight: 600 }}>
                            {formatMessage(evt.message)}
                          </Text>
                          <Text style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>
                            {evt.ts ? dayjs(evt.ts).format('HH:mm:ss') : '—'}
                          </Text>
                        </Space>
                      );
                    })}
                  </Space>
                )}
              </Card>
            );
          })
        )}
      </Card>
    </Space>
  );
};

function SummaryTile({ icon, label, value, hint, tone }: { icon: React.ReactNode; label: string; value: string; hint: string; tone: string; }) {
  return (
    <Card
      style={{ borderRadius: 18, border: '1px solid rgba(148, 163, 184, 0.2)', background: 'rgba(15, 23, 42, 0.88)' }}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 20 }}
    >
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: 14,
          background: `${tone}22`,
          color: tone,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 18,
        }}
      >
        {icon}
      </div>
      <Text style={{ color: 'rgba(148, 163, 184, 0.78)', fontSize: 12 }}>{label}</Text>
      <Title level={3} style={{ margin: 0, color: tone }}>
        {value}
      </Title>
      <Text style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>{hint}</Text>
    </Card>
  );
}

function formatMessage(message?: string) {
  if (!message) return 'Agent update';
  return message.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
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

function formatDetailValue(key: string, value: any, depth = 0): string {
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
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  if (typeof value === 'string') {
    const normalized = value.replace(/_/g, ' ');
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => formatDetailValue(key, item, depth + 1))
      .filter((item) => item)
      .join(', ');
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([childKey, childValue]) => {
        const label = formatMessage(childKey);
        const formatted = formatDetailValue(childKey, childValue, depth + 1) || '—';
        return `${label}: ${formatted}`;
      })
      .join(depth === 0 ? ' • ' : ', ');
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

export default BacklogPage;
