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
    <Card title={<Tooltip title="Santé opérationnelle : infrastructure & agents">Ops metrics</Tooltip>} loading={loading} style={{ borderRadius: 12 }}>
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}><Statistic title={<Tooltip title="Temps écoulé depuis le démarrage du backend">Uptime</Tooltip>} value={formatUptime(metrics.uptimeSec)} /></Col>
        <Col xs={12} md={6}><Statistic title={<Tooltip title="Charge CPU moyenne sur la dernière minute">Load (1m)</Tooltip>} value={Number(metrics.loadAvg || 0).toFixed(2)} /></Col>
        <Col xs={12} md={6}><Statistic title={<Tooltip title="Mémoire totale occupée par le processus Node.js">Memory RSS</Tooltip>} value={formatBytes(mem.rss)} /></Col>
        <Col xs={12} md={6}><Statistic title={<Tooltip title="Mémoire JavaScript active (heap)">Heap used</Tooltip>} value={formatBytes(mem.heapUsed)} /></Col>
      </Row>
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={12} md={6}><Statistic title={<Tooltip title="Nombre d'agents actifs (sessions en cours)">Active sessions</Tooltip>} value={sessions.active || 0} /></Col>
        <Col xs={12} md={6}><Statistic title={<Tooltip title="Agents actuellement en gestion de position">Managing agents</Tooltip>} value={sessions.managing || 0} /></Col>
        <Col xs={12} md={6}><Statistic title={<Tooltip title="Agents stoppés par un kill switch ou arrêt manuel">Halted agents</Tooltip>} value={sessions.halted || 0} valueStyle={{ color: sessions.halted ? '#b91c1c' : undefined }} /></Col>
        <Col xs={12} md={6}><Statistic title={<Tooltip title="Nombre total d'agents suivis">Agents total</Tooltip>} value={agents.total || 0} /></Col>
      </Row>
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={12} md={6}><Statistic title={<Tooltip title="Positions actuellement ouvertes">Open positions</Tooltip>} value={positions.open || 0} /></Col>
        <Col xs={12} md={6}>
          <Statistic
            title={<Tooltip title="Positions dont les ordres stop/TP sont en anomalie">Protective issues</Tooltip>}
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
