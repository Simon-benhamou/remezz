import React from 'react';
import { Card, Space, Tag, Typography, Button, Tooltip, Empty, Progress } from 'antd';
import {
  ClockCircleOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  CloseCircleOutlined,
  PauseCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { OpsJobStatus } from '../types/ops';

const { Text } = Typography;

type Props = {
  jobs?: OpsJobStatus[];
  loading?: boolean;
  onRefresh?: () => void;
  condensed?: boolean;
  title?: string;
  updatedAt?: number | null;
};

type StatusKey = NonNullable<OpsJobStatus['status']>;

const statusMeta: Record<StatusKey, { color: string; label: string; icon: React.ReactNode }> = {
  running: { color: 'processing', label: 'Running', icon: <ThunderboltOutlined /> },
  success: { color: 'success', label: 'Healthy', icon: <CheckCircleOutlined /> },
  warning: { color: 'warning', label: 'Warning', icon: <WarningOutlined /> },
  error: { color: 'error', label: 'Failed', icon: <CloseCircleOutlined /> },
  paused: { color: 'default', label: 'Paused', icon: <PauseCircleOutlined /> },
  disabled: { color: 'default', label: 'Disabled', icon: <PauseCircleOutlined /> },
  idle: { color: 'default', label: 'Idle', icon: <ClockCircleOutlined /> },
  scheduled: { color: 'default', label: 'Scheduled', icon: <ClockCircleOutlined /> },
};

function toTimestamp(value?: number | string | null) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function formatRelative(ts?: number | string | null) {
  const value = toTimestamp(ts);
  if (!value) return '—';
  const delta = Date.now() - value;
  if (delta < 60_000) return 'Just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

function formatDuration(ms?: number | null) {
  if (!ms || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}

function formatNextRun(next?: number | string | null) {
  const ts = toTimestamp(next);
  if (!ts) return '—';
  const delta = ts - Date.now();
  if (delta <= 0) return 'Due now';
  if (delta < 60_000) return 'In <1m';
  if (delta < 3_600_000) return `In ${Math.round(delta / 60_000)}m`;
  return `In ${Math.round(delta / 3_600_000)}h`;
}

const EMPTY_STATE = <Empty description='No jobs registered yet.' image={Empty.PRESENTED_IMAGE_SIMPLE} />;

export default function JobsStatusPanel({ jobs = [], loading, onRefresh, condensed, title, updatedAt }: Props) {
  const items = React.useMemo(() => {
    const sorted = [...jobs].sort((a, b) => {
      const statusScore = (status: StatusKey) => {
        switch (status) {
          case 'error': return 5;
          case 'warning': return 4;
          case 'running': return 3;
          case 'idle': return 2;
          case 'scheduled': return 2;
          default: return 1;
        }
      };
      const diff = statusScore((b.status || 'idle') as StatusKey) - statusScore((a.status || 'idle') as StatusKey);
      if (diff !== 0) return diff;
      const aTs = toTimestamp(a.lastRunAt) ?? 0;
      const bTs = toTimestamp(b.lastRunAt) ?? 0;
      return bTs - aTs;
    });
    return condensed ? sorted.slice(0, 4) : sorted;
  }, [jobs, condensed]);

  return (
    <Card
      loading={loading}
      title={title ?? 'Automation jobs'}
      extra={(
        <Space size={12} align='center'>
          <Tooltip title='Last refresh'>
            <Space size={4} style={{ color: 'rgba(0,0,0,0.45)' }}>
              <ClockCircleOutlined />
              <Text type='secondary'>{formatRelative(updatedAt)}</Text>
            </Space>
          </Tooltip>
          {onRefresh && (
            <Button size='small' icon={<ReloadOutlined />} onClick={onRefresh} disabled={loading}
            >Refresh</Button>
          )}
        </Space>
      )}
      style={{ borderRadius: 18 }}
      bodyStyle={{ padding: 0 }}
    >
      {items.length === 0 ? (
        <div style={{ padding: 24 }}>{EMPTY_STATE}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {items.map((job, idx) => {
            const meta = statusMeta[(job.status || 'idle') as StatusKey] ?? statusMeta.idle;
            const showDivider = idx !== items.length - 1;
            const duration = job.durationMs ?? job.avgDurationMs;
            return (
              <div
                key={job.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  padding: '16px 24px',
                  borderBottom: showDivider ? '1px solid rgba(0,0,0,0.06)' : 'none',
                }}
              >
                <Space align='baseline' size={12} style={{ justifyContent: 'space-between' }}>
                  <div style={{ flex: 1 }}>
                    <Space size={8} wrap>
                      <Text strong>{job.label}</Text>
                      {Array.isArray(job.tags) && job.tags.length > 0 && (
                        <Space size={4} wrap>
                          {job.tags.slice(0, 3).map((tag) => (
                            <Tag key={tag} color='geekblue'>{tag}</Tag>
                          ))}
                          {job.tags.length > 3 ? <Tag>+{job.tags.length - 3}</Tag> : null}
                        </Space>
                      )}
                    </Space>
                    {job.lastError && meta.color === 'error' && (
                      <Text type='danger' style={{ display: 'block', marginTop: 8 }}>
                        {job.lastError}
                      </Text>
                    )}
                  </div>
                  <Tag icon={meta.icon} color={meta.color}>{meta.label}</Tag>
                </Space>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                  gap: 12,
                  marginTop: 12,
                }}>
                  <InfoItem label='Last run' value={formatRelative(job.lastRunAt)} />
                  <InfoItem label='Duration' value={formatDuration(duration)} />
                  <InfoItem label='Next run' value={formatNextRun(job.nextRunEta)} />
                  {typeof job.runsToday === 'number' && (
                    <InfoItem label='Runs today' value={String(job.runsToday)} />
                  )}
                </div>
                {job.healthy === false && meta.color !== 'error' && (
                  <div style={{ marginTop: 12 }}>
                    <Progress percent={0} status='exception' showInfo={false} strokeColor='var(--error)' trailColor='#ffe7e6' />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

type InfoItemProps = {
  label: string;
  value: React.ReactNode;
};

function InfoItem({ label, value }: InfoItemProps) {
  return (
    <div>
      <Text type='secondary' style={{ fontSize: 12 }}>{label}</Text>
      <div style={{ fontWeight: 500 }}>{value}</div>
    </div>
  );
}
