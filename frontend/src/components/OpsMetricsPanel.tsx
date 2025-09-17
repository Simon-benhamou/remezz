import React from 'react';
import { Card, Col, Row, Statistic, Tooltip } from 'antd';

function formatBytes(num?: number) {
  if (!num || !Number.isFinite(num)) return '0 MB';
  return `${(num / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUptime(sec?: number) {
  if (!sec || !Number.isFinite(sec)) return '—';
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = Math.floor(sec % 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

type Props = {
  metrics?: any;
  loading?: boolean;
};

export default function OpsMetricsPanel({ metrics, loading }: Props) {
  if (!metrics) return <Card loading={loading} title='Ops metrics'>No snapshot yet.</Card>;
  const mem = metrics.memory || {};
  const sessions = metrics.sessions || {};
  const positions = metrics.positions || {};
  const alerts = metrics.alerts || {};
  const agents = metrics.agents || {};
  return (
    <Card title='Ops metrics' loading={loading} style={{ borderRadius: 12 }}>
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}><Statistic title='Uptime' value={formatUptime(metrics.uptimeSec)} /></Col>
        <Col xs={12} md={6}><Statistic title='Load (1m)' value={Number(metrics.loadAvg || 0).toFixed(2)} /></Col>
        <Col xs={12} md={6}><Statistic title='Memory RSS' value={formatBytes(mem.rss)} /></Col>
        <Col xs={12} md={6}><Statistic title='Heap used' value={formatBytes(mem.heapUsed)} /></Col>
      </Row>
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={12} md={6}><Statistic title='Active sessions' value={sessions.active || 0} /></Col>
        <Col xs={12} md={6}><Statistic title='Managing agents' value={sessions.managing || 0} /></Col>
        <Col xs={12} md={6}><Statistic title='Halted agents' value={sessions.halted || 0} valueStyle={{ color: sessions.halted ? '#b91c1c' : undefined }} /></Col>
        <Col xs={12} md={6}><Statistic title='Agents total' value={agents.total || 0} /></Col>
      </Row>
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={12} md={6}><Statistic title='Open positions' value={positions.open || 0} /></Col>
        <Col xs={12} md={6}>
          <Statistic
            title='Protective issues'
            value={positions.protectiveIssues || 0}
            valueStyle={{ color: (positions.protectiveIssues || 0) > 0 ? '#d97706' : undefined }}
          />
        </Col>
        <Col xs={12} md={6}>
          <Tooltip title='Alerts raised in the last hour'>
            <Statistic title='Alerts (1h)' value={alerts.lastHour?.total || 0} />
          </Tooltip>
        </Col>
        <Col xs={12} md={6}>
          <Tooltip title='Alerts raised in the last 24 hours'>
            <Statistic title='Alerts (24h)' value={alerts.last24h?.total || 0} />
          </Tooltip>
        </Col>
      </Row>
    </Card>
  );
}
