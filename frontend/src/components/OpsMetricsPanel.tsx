import React from 'react';
import {
  Badge,
  Card,
  Col,
  Divider,
  List,
  Progress,
  Row,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';

const { Text } = Typography;

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
  const { token } = theme.useToken();
  const base = token.colorBgBase.toLowerCase();
  const isDarkTheme = !['#ffffff', '#fff', '#fafafa'].includes(base);
  const cardBg = isDarkTheme ? '#0f172a' : token.colorBgContainer;
  const borderColor = isDarkTheme ? 'rgba(148, 163, 184, 0.2)' : token.colorBorderSecondary;
  const headingColor = isDarkTheme ? '#f8fafc' : token.colorTextHeading;
  const subtleText = isDarkTheme ? 'rgba(226, 232, 240, 0.72)' : token.colorTextSecondary;
  const chipBg = isDarkTheme ? 'rgba(30, 41, 59, 0.55)' : token.colorFillTertiary;
  const highlightBg = isDarkTheme ? 'rgba(15, 23, 42, 0.75)' : token.colorFillQuaternary;
  const dividerColor = isDarkTheme ? 'rgba(148, 163, 184, 0.25)' : token.colorBorderSecondary;

  if (!metrics) {
    return (
      <Card loading={loading} title='Ops metrics'>
        No snapshot yet.
      </Card>
    );
  }

  const mem = metrics.memory || {};
  const sessions = metrics.sessions || {};
  const positions = metrics.positions || {};
  const alerts = metrics.alerts || {};
  const agents = metrics.agents || {};
  const margin = metrics.margin || null;
  const avgUtil = margin ? Number(margin.averageUtilisationPct || 0) : 0;
  const entryGateBlocks = metrics.ops?.entryGateBlocks;
  const flaggedVos = Array.isArray(metrics.ops?.flaggedSessions) ? metrics.ops.flaggedSessions : [];
  const worstSessions = Array.isArray(margin?.worstSessions) ? margin.worstSessions.slice(0, 3) : [];

  const timestamp = metrics.timestamp ? new Date(metrics.timestamp).toLocaleTimeString() : '—';

  return (
    <Card
      loading={loading}
      style={{ borderRadius: 16, border: `1px solid ${borderColor}`, background: cardBg }}
      title={
        <Space size={10}>
          <span style={{ color: headingColor }}>Ops metrics</span>
          <Tag color='blue'>{timestamp}</Tag>
        </Space>
      }
    >
      <Space direction='vertical' size={20} style={{ width: '100%' }}>
        <div>
          <Text style={{ color: headingColor, fontWeight: 600 }}>Infrastructure</Text>
          <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
            <Col xs={12} md={6}>
              <Statistic title={<span style={{ color: subtleText }}>Uptime</span>} value={formatUptime(metrics.uptimeSec)} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title={<span style={{ color: subtleText }}>Load (1m)</span>} value={Number(metrics.loadAvg || 0).toFixed(2)} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title={<span style={{ color: subtleText }}>Memory RSS</span>} value={formatBytes(mem.rss)} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title={<span style={{ color: subtleText }}>Heap used</span>} value={formatBytes(mem.heapUsed)} />
            </Col>
          </Row>
        </div>

        <Divider style={{ margin: 0, borderColor: dividerColor }} />

        <div>
          <Text style={{ color: headingColor, fontWeight: 600 }}>Session posture</Text>
          <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
            <Col xs={12} md={6}>
              <Statistic title={<span style={{ color: subtleText }}>Active sessions</span>} value={sessions.active || 0} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title={<span style={{ color: subtleText }}>Managing</span>} value={sessions.managing || 0} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title={<span style={{ color: subtleText }}>Halted</span>}
                value={sessions.halted || 0}
                valueStyle={{ color: sessions.halted ? token.colorError : headingColor }}
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title={<span style={{ color: subtleText }}>Agents total</span>} value={agents.total || 0} />
            </Col>
          </Row>
        </div>

        <Divider style={{ margin: 0, borderColor: dividerColor }} />

        <div>
          <Text style={{ color: headingColor, fontWeight: 600 }}>Risk & alerts</Text>
          <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
            <Col xs={12} md={6}>
              <Statistic title={<span style={{ color: subtleText }}>Open positions</span>} value={positions.open || 0} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title={<Tooltip title='Positions with missing or delayed protective orders'>
                  <span style={{ color: subtleText }}>Protective issues</span>
                </Tooltip>}
                value={positions.protectiveIssues || 0}
                valueStyle={{ color: (positions.protectiveIssues || 0) > 0 ? token.colorWarning : headingColor }}
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title={<span style={{ color: subtleText }}>Alerts (1h)</span>}
                value={alerts.lastHour?.total || 0}
                valueStyle={{ color: (alerts.lastHour?.total || 0) > 0 ? token.colorWarning : headingColor }}
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title={<span style={{ color: subtleText }}>Alerts (24h)</span>} value={alerts.last24h?.total || 0} />
            </Col>
          </Row>
        </div>

        {margin && (
          <div
            style={{
              borderRadius: 14,
              padding: 16,
              background: highlightBg,
              border: `1px solid ${borderColor}`,
            }}
          >
            <Space direction='vertical' size={14} style={{ width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Tooltip title='Average margin utilisation across tracked sessions'>
                  <Text style={{ color: headingColor, fontWeight: 600 }}>Margin guard</Text>
                </Tooltip>
                <Tag color={margin.critical ? 'red' : margin.warn ? 'orange' : 'green'}>
                  {margin.critical ? `${margin.critical} critical` : margin.warn ? `${margin.warn} elevated` : 'Healthy'}
                </Tag>
              </div>
              <Progress
                percent={Number.isFinite(avgUtil) ? Number(avgUtil.toFixed(1)) : 0}
                strokeColor={margin.critical ? token.colorError : margin.warn ? token.colorWarning : token.colorPrimary}
                showInfo
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', color: subtleText, fontSize: 12 }}>
                <span>{margin.tracked || 0} sessions tracked</span>
                <span>Updated {margin.lastUpdated ? new Date(margin.lastUpdated).toLocaleTimeString() : '—'}</span>
              </div>
              {worstSessions.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <Text style={{ color: subtleText, fontSize: 12 }}>Top risk sessions</Text>
                  <List
                    size='small'
                    dataSource={worstSessions}
                    renderItem={(row: any) => (
                      <List.Item style={{ padding: '8px 0' }}>
                        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                          <Space size={8}>
                            <Badge status={row.status === 'critical' ? 'error' : 'warning'} />
                            <span style={{ color: headingColor, fontWeight: 500 }}>{row.symbol || row.sessionId}</span>
                          </Space>
                          <span style={{ color: headingColor, fontWeight: 600 }}>
                            {Number(row.utilisationPct || 0).toFixed(1)}%
                          </span>
                        </Space>
                      </List.Item>
                    )}
                  />
                </div>
              )}
            </Space>
          </div>
        )}

        {(entryGateBlocks || flaggedVos.length > 0) && (
          <Row gutter={[12, 12]}>
            {entryGateBlocks && (
              <Col xs={24} md={12}>
                <div
                  style={{
                    borderRadius: 14,
                    padding: 16,
                    background: chipBg,
                    border: `1px solid ${borderColor}`,
                    height: '100%',
                  }}
                >
                  <Space direction='vertical' size={12} style={{ width: '100%' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ color: headingColor, fontWeight: 600 }}>Signal gate blocks</Text>
                      <Tag color='geekblue'>{entryGateBlocks.total || 0}</Tag>
                    </div>
                    <div style={{ color: subtleText, fontSize: 12, display: 'flex', justifyContent: 'space-between' }}>
                      <span>Sessions impacted</span>
                      <span>{entryGateBlocks.sessions?.length || 0}</span>
                    </div>
                    {Array.isArray(entryGateBlocks.sessions) && entryGateBlocks.sessions.length > 0 ? (
                      <List
                        size='small'
                        dataSource={entryGateBlocks.sessions.slice(0, 4)}
                        renderItem={(row: any) => (
                          <List.Item style={{ padding: '6px 0' }}>
                            <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                              <span style={{ color: headingColor }}>{row.symbol || row.sessionId}</span>
                              <Tag color={row.flagged ? 'red' : 'blue'}>{row.count} blocks</Tag>
                            </Space>
                          </List.Item>
                        )}
                      />
                    ) : (
                      <Text style={{ color: subtleText, fontSize: 12 }}>No active blocks recorded.</Text>
                    )}
                  </Space>
                </div>
              </Col>
            )}
            {flaggedVos.length > 0 && (
              <Col xs={24} md={12}>
                <div
                  style={{
                    borderRadius: 14,
                    padding: 16,
                    background: chipBg,
                    border: `1px solid ${borderColor}`,
                    height: '100%',
                  }}
                >
                  <Space direction='vertical' size={12} style={{ width: '100%' }}>
                    <Text style={{ color: headingColor, fontWeight: 600 }}>Stalled agents</Text>
                    <List
                      size='small'
                      dataSource={flaggedVos.slice(0, 4)}
                      renderItem={(row: any) => (
                        <List.Item style={{ padding: '6px 0' }}>
                          <Space direction='vertical' size={2} style={{ width: '100%' }}>
                            <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                              <span style={{ color: headingColor, fontWeight: 500 }}>{row.symbol || row.sessionId}</span>
                              <Tag color='red'>{row.count} blocks</Tag>
                            </Space>
                            <div style={{ color: subtleText, fontSize: 12, display: 'flex', justifyContent: 'space-between' }}>
                              <span>Last block</span>
                              <span>{formatTime(row.lastBlockedAt)}</span>
                            </div>
                            <div style={{ color: subtleText, fontSize: 12, display: 'flex', justifyContent: 'space-between' }}>
                              <span>Last successful trade</span>
                              <span>{formatTime(row.lastSuccessfulTradeAt)}</span>
                            </div>
                          </Space>
                        </List.Item>
                      )}
                    />
                  </Space>
                </div>
              </Col>
            )}
          </Row>
        )}
      </Space>
    </Card>
  );
}
