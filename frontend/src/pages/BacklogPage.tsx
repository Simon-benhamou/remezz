import React from 'react';
import { Card, Space, Typography, List, Tag, message, Button, Badge, Empty } from 'antd';
import { ThunderboltOutlined, ReloadOutlined } from '@ant-design/icons';
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

const levelColors: Record<string, { color: string; label: string }> = {
  info: { color: 'blue', label: 'Info' },
  warn: { color: 'orange', label: 'Warning' },
  error: { color: 'red', label: 'Issue' },
};

function formatTime(ts?: number) {
  if (!ts) return '—';
  return dayjs(ts).format('HH:mm:ss');
}

function renderDetails(details: any) {
  if (!details) return null;
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
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
                Live stream of operational signals for currently running agents.
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
              const meta = levelColors[evt.level || 'info'] || levelColors.info;
              const session = evt.sessionId
                ? activeSessions.find((s: any) => s.id === evt.sessionId)
                : null;
              return (
                <List.Item key={evt.id} style={{ paddingLeft: 0, paddingRight: 0 }}>
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Space size="small" wrap>
                      <Tag color={meta.color}>{meta.label}</Tag>
                      {evt.symbol && <Tag>{evt.symbol}</Tag>}
                      {session && (
                        <Tag color="geekblue">
                          {session.symbol} · {session.mode?.toUpperCase()}
                        </Tag>
                      )}
                      <Text type="secondary">{formatTime(evt.ts)}</Text>
                    </Space>
                    <Text strong>{evt.message || 'No message'}</Text>
                    {evt.details && (
                      <Text type="secondary" style={{ fontFamily: 'monospace', fontSize: 12 }}>
                        {renderDetails(evt.details)}
                      </Text>
                    )}
                  </Space>
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
                    const meta = levelColors[evt.level || 'info'] || levelColors.info;
                    return (
                      <List.Item key={evt.id} style={{ border: 'none', paddingLeft: 0, paddingRight: 0 }}>
                        <Space
                          size="middle"
                          style={{
                            width: '100%',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                          }}
                        >
                          <Space size="small" wrap>
                            <Tag color={meta.color}>{meta.label}</Tag>
                            <Text>{evt.source}</Text>
                          </Space>
                          <Text type="secondary">{formatTime(evt.ts)}</Text>
                        </Space>
                        <Text>{evt.message}</Text>
                        {evt.details && (
                          <Text type="secondary" style={{ fontFamily: 'monospace', fontSize: 12 }}>
                            {renderDetails(evt.details)}
                          </Text>
                        )}
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
