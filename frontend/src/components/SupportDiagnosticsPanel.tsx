import React from 'react';
import { Badge, Card, Divider, List, Space, Tag, Tooltip, Typography } from 'antd';
import { formatDisplaySymbol } from '../utils/symbols';

const { Text } = Typography;

type SnapshotSummary = {
  status: string;
  ageMs: number | null;
  staleAfterMs: number;
};

type SupportBlocker = {
  key: string;
  code?: string;
  message?: string;
  reason?: string;
  status?: string;
  sessionId?: string;
  symbol?: string | null;
};

type SupportSession = {
  sessionId: string;
  symbol: string | null;
  canTrade: boolean;
  reason: string;
  blockers: SupportBlocker[];
  perception: Record<string, SnapshotSummary>;
  decisions: {
    status: string;
    ageMs: number | null;
    summary: { intentCount: number; lastIntentType: string | null; lastReason: string | null };
  };
  actions: { status: string; ageMs: number | null };
  alerts: Array<{ reason?: string; timestamp?: number }>;
};

type Props = {
  data?: {
    sessions?: SupportSession[];
    blockers?: SupportBlocker[];
  } | null;
  loading?: boolean;
};

const statusColor = (status?: string) => {
  if (!status) return 'default';
  if (status === 'fresh') return 'green';
  if (status === 'stale') return 'orange';
  if (status === 'missing') return 'red';
  return 'default';
};

const formatAge = (ageMs: number | null) => {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs)) return '—';
  if (ageMs < 2_000) return `${Math.max(0, Math.round(ageMs))} ms`;
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
};

const MAX_SESSIONS = 6;
const MAX_BLOCKERS = 5;

export default function SupportDiagnosticsPanel({ data, loading }: Props) {
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const blockers = Array.isArray(data?.blockers) ? data.blockers : [];

  const ready = sessions.filter((session) => session.canTrade).length;
  const blocked = sessions.length - ready;

  return (
    <Card
      title='Support stack telemetry'
      loading={loading}
      style={{ borderRadius: 12 }}
      extra={
        <Space size={8}>
          <Tag color='green'>{ready} ready</Tag>
          <Tag color={blocked ? 'red' : 'blue'}>{blocked} blocked</Tag>
        </Space>
      }
    >
      {sessions.length === 0 ? (
        <Text type='secondary'>No active support sessions.</Text>
      ) : (
        <Space direction='vertical' size={16} style={{ width: '100%' }}>
          <List
            size='small'
            dataSource={sessions.slice(0, MAX_SESSIONS)}
            renderItem={(session) => (
              <List.Item>
                <Space direction='vertical' size={6} style={{ width: '100%' }}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
                    <Space size={8} wrap>
                      <Tag color='geekblue'>{formatDisplaySymbol(session.symbol)}</Tag>
                      <Badge status={session.canTrade ? 'success' : 'error'} text={session.canTrade ? 'Ready' : 'Blocked'} />
                    </Space>
                    <Text type={session.canTrade ? 'secondary' : 'danger'} style={{ maxWidth: 220 }} ellipsis>
                      {session.reason}
                    </Text>
                  </Space>
                  <Space wrap size={6}>
                    {Object.entries(session.perception || {}).map(([key, snapshot]) => (
                      <Tooltip
                        key={key}
                        title={`Updated ${formatAge(snapshot.ageMs)} ago · stale after ${formatAge(snapshot.staleAfterMs)}`}
                      >
                        <Tag color={statusColor(snapshot.status)}>{key}</Tag>
                      </Tooltip>
                    ))}
                    <Tooltip title={`Decisions ${session.decisions.status}`}> 
                      <Tag color={statusColor(session.decisions.status)}>decisions</Tag>
                    </Tooltip>
                    <Tooltip title={`Actions ${session.actions.status}`}>
                      <Tag color={statusColor(session.actions.status)}>actions</Tag>
                    </Tooltip>
                  </Space>
                  {!session.canTrade && session.blockers?.length > 0 && (
                    <Space wrap size={6}>
                      {session.blockers.slice(0, 3).map((blocker) => (
                        <Tag key={`${session.sessionId}-${blocker.key}-${blocker.code}`} color='red'>
                          {blocker.message || blocker.reason || blocker.code || blocker.key}
                        </Tag>
                      ))}
                    </Space>
                  )}
                </Space>
              </List.Item>
            )}
          />

          <Divider style={{ margin: '8px 0' }} />

          <Space direction='vertical' size={8} style={{ width: '100%' }}>
            <Text strong>Top blockers</Text>
            {blockers.length === 0 ? (
              <Text type='secondary'>No blockers detected.</Text>
            ) : (
              <Space wrap size={8}>
                {blockers.slice(0, MAX_BLOCKERS).map((blocker) => (
                  <Tag key={`${blocker.sessionId}-${blocker.key}-${blocker.code}`}
                    color={blocker.status === 'warning' ? 'orange' : 'red'}>
                    {formatDisplaySymbol(blocker.symbol)} · {blocker.message || blocker.reason || blocker.code || blocker.key}
                  </Tag>
                ))}
              </Space>
            )}
          </Space>
        </Space>
      )}
    </Card>
  );
}
