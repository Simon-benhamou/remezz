import React from 'react';
import { Badge, Card, Col, Progress, Row, Space, Statistic, Tag, Tooltip } from 'antd';

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

function formatTime(ts?: number | null) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  const date = new Date(ts);
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
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
  const margin = metrics.margin || null;
  const avgUtil = margin ? Number(margin.averageUtilisationPct || 0) : 0;
  const entryGateBlocks = metrics.ops?.entryGateBlocks;
  const flaggedVos = Array.isArray(metrics.ops?.flaggedSessions) ? metrics.ops.flaggedSessions : [];
  const highlightedVos = Array.isArray(entryGateBlocks?.sessions)
    ? entryGateBlocks.sessions.slice(0, 3)
    : [];
  const marginStatus = margin
    ? margin.critical
      ? { label: `${margin.critical} critical`, color: '#dc2626', progressStatus: 'exception' as const }
      : margin.warn
        ? { label: `${margin.warn} elevated`, color: '#f97316', progressStatus: 'active' as const }
        : { label: 'Healthy', color: '#16a34a', progressStatus: 'normal' as const }
    : null;
  const worstSessions = Array.isArray(margin?.worstSessions) ? margin.worstSessions.slice(0, 3) : [];
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
      {margin && (
        <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
          <Col xs={24} md={12}>
            <div style={{ padding: 12, border: '1px solid #e2e8f0', borderRadius: 12, background: '#f8fafc' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <Tooltip title="Utilisation moyenne de la marge sur les sessions actives">
                  <span style={{ fontWeight: 600, color: '#334155' }}>Margin utilisation</span>
                </Tooltip>
                {marginStatus && <Tag color={marginStatus.color}>{marginStatus.label}</Tag>}
              </div>
              <Progress
                percent={Number.isFinite(avgUtil) ? Number(avgUtil.toFixed(1)) : 0}
                strokeColor={marginStatus?.color || '#0ea5e9'}
                status={marginStatus?.progressStatus || 'normal'}
                showInfo
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, color: '#64748b', fontSize: 12 }}>
                <span>{margin.tracked || 0} sessions tracked</span>
                <span>Updated {margin.lastUpdated ? new Date(margin.lastUpdated).toLocaleTimeString() : '—'}</span>
              </div>
            </div>
          </Col>
          <Col xs={24} md={12}>
            <div style={{ padding: 12, border: '1px solid #e2e8f0', borderRadius: 12, background: '#f8fafc', minHeight: 94 }}>
              <Tooltip title="Sessions nécessitant une réduction de taille ou un hedging">
                <div style={{ fontWeight: 600, color: '#334155', marginBottom: 8 }}>Risky sessions</div>
              </Tooltip>
              {worstSessions.length === 0 ? (
                <div style={{ color: '#94a3b8', fontSize: 12 }}>No margin pressure detected.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {worstSessions.map((row: any) => (
                    <div key={`${row.sessionId}_${row.symbol}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                      <Badge status={row.status === 'critical' ? 'error' : 'warning'} text={`${row.symbol || row.sessionId}`} />
                      <span style={{ fontWeight: 600 }}>{Number(row.utilisationPct || 0).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Col>
        </Row>
      )}
      {entryGateBlocks && (
        <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
          <Col xs={24} md={12}>
            <div style={{ padding: 12, border: '1px solid #e2e8f0', borderRadius: 12, background: '#f8fafc', minHeight: 132 }}>
              <Tooltip title="Validator of signal blocks detected across agents">
                <div style={{ fontWeight: 600, color: '#334155', marginBottom: 8 }}>Signal gate blocks</div>
              </Tooltip>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ color: '#64748b' }}>Total events</span>
                <Tag color='geekblue'>{entryGateBlocks.total || 0}</Tag>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, color: '#64748b', fontSize: 12 }}>
                <span>Sessions impacted</span>
                <span>{entryGateBlocks.sessions?.length || 0}</span>
              </div>
              {highlightedVos.length === 0 ? (
                <div style={{ color: '#94a3b8', fontSize: 12 }}>No active blocks recorded.</div>
              ) : (
                <Space direction='vertical' size={6} style={{ width: '100%' }}>
                  {highlightedVos.map((row: any) => (
                    <div key={row.sessionId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#475569' }}>
                      <span style={{ fontWeight: 600 }}>{row.symbol || row.sessionId}</span>
                      <span>
                        <Tag color={row.flagged ? 'red' : 'blue'}>{row.count} blocks</Tag>
                      </span>
                    </div>
                  ))}
                </Space>
              )}
            </div>
          </Col>
          <Col xs={24} md={12}>
            <div style={{ padding: 12, border: '1px solid #e2e8f0', borderRadius: 12, background: '#fef2f2', minHeight: 132 }}>
              <Tooltip title="Agents repeatedly blocked without any closed trades">
                <div style={{ fontWeight: 600, color: '#b91c1c', marginBottom: 8 }}>Stalled agents</div>
              </Tooltip>
              {flaggedVos.length === 0 ? (
                <div style={{ color: '#9ca3af', fontSize: 12 }}>All agents have a recorded trade history.</div>
              ) : (
                <Space direction='vertical' size={8} style={{ width: '100%' }}>
                  {flaggedVos.slice(0, 4).map((row: any) => (
                    <div key={row.sessionId} style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12, color: '#7f1d1d', padding: 6, borderRadius: 8, background: '#fee2e2' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 600 }}>{row.symbol || row.sessionId}</span>
                        <Tag color='red'>{row.count} blocks</Tag>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>Last block</span>
                        <span>{formatTime(row.lastBlockedAt)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>Last successful trade</span>
                        <span>{formatTime(row.lastSuccessfulTradeAt)}</span>
                      </div>
                    </div>
                  ))}
                </Space>
              )}
            </div>
          </Col>
        </Row>
      )}
    </Card>
  );
}
