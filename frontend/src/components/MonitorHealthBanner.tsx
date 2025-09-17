import React from 'react';
import { Alert, List, Space, Tag, Tooltip } from 'antd';

type Health = {
  level: 'ok' | 'warn' | 'alert';
  headline: string;
  bullets: string[];
};

type Props = {
  health?: Health | null;
  updatedAt?: number | null;
};

const alertType: Record<Health['level'], 'success' | 'warning' | 'error'> = {
  ok: 'success',
  warn: 'warning',
  alert: 'error',
};

function formatAgo(ts?: number | null) {
  if (!ts) return '—';
  const delta = Date.now() - ts;
  if (delta < 0) return 'just now';
  const mins = Math.floor(delta / 60000);
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;
    return rest ? `${hours}h ${rest}m ago` : `${hours}h ago`;
  }
  if (mins >= 1) return `${mins}m ago`;
  const secs = Math.max(1, Math.floor(delta / 1000));
  return `${secs}s ago`;
}

export default function MonitorHealthBanner({ health, updatedAt }: Props) {
  if (!health) return null;
  const list = Array.isArray(health.bullets) && health.bullets.length ? health.bullets : ['—'];
  return (
    <Alert
      type={alertType[health.level]}
      showIcon
      message={<Tooltip title="Synthèse de l'état du bot (risques, anomalies, santé des positions)"><Space size='small'><span style={{ fontWeight: 600 }}>{health.headline}</span><Tag color='blue' style={{ marginLeft: 8 }}>Updated {formatAgo(updatedAt)}</Tag></Space></Tooltip>}
      description={(
        <List
          size='small'
          dataSource={list}
          renderItem={(item) => (
            <List.Item style={{ padding: '2px 0', border: 'none', color: '#334155' }}>{item}</List.Item>
          )}
        />
      )}
      style={{ borderRadius: 12 }}
    />
  );
}
