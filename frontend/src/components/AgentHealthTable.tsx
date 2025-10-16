import React from 'react';
import { Badge, Button, Card, Col, Row, Space, Statistic, Table, Tag, Tooltip, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { SyncOutlined } from '@ant-design/icons';
type AgentHealthStatus = 'ok' | 'idle' | 'stale' | 'blocked';
type AgentHealthFlag = 'no_trades' | 'vos_block' | 'stale';

export type AgentHealthRow = {
  sessionId: string;
  symbol: string | null;
  mode: string | null;
  state: string | null;
  hasPosition: boolean;
  tradeCount24h: number;
  lastExecutionTs: number | null;
  blockedByVos: boolean;
  lastBlockedAt: number | null;
  status: AgentHealthStatus;
  flags: AgentHealthFlag[];
};

export type AgentHealthSnapshot = {
  timestamp: number;
  windowMs: number;
  staleThresholdMs: number;
  agents: AgentHealthRow[];
};

const { Text } = Typography;

export type AgentHealthTableProps = {
  data?: AgentHealthSnapshot | null;
  loading?: boolean;
  onRefresh?: () => void;
};

const STATUS_META: Record<AgentHealthStatus, { color: string; label: string }> = {
  ok: { color: 'green', label: 'Nominal' },
  idle: { color: 'gold', label: 'Idle' },
  stale: { color: 'orange', label: 'Stale' },
  blocked: { color: 'magenta', label: 'Blocked' },
};

const FLAG_META: Record<AgentHealthRow['flags'][number], { color: string; label: string }> = {
  vos_block: { color: 'magenta', label: 'VOS Block' },
  no_trades: { color: 'volcano', label: 'No Trades' },
  stale: { color: 'geekblue', label: 'Stale' },
};

function formatRelative(ts: number | null, reference: number): string {
  if (!ts) return 'Never';
  const deltaMs = reference - ts;
  if (deltaMs < 0) return 'Just now';
  const minutes = Math.round(deltaMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export default function AgentHealthTable({ data, loading, onRefresh }: AgentHealthTableProps) {
  const referenceTs = data?.timestamp ?? Date.now();
  const agents = data?.agents ?? [];
  const { token } = theme.useToken();
  const base = token.colorBgBase.toLowerCase();
  const isDarkTheme = !['#ffffff', '#fff', '#fafafa'].includes(base);
  const cardBg = isDarkTheme ? '#0f172a' : token.colorBgContainer;
  const borderColor = isDarkTheme ? 'rgba(148, 163, 184, 0.2)' : token.colorBorderSecondary;
  const headingColor = isDarkTheme ? '#f8fafc' : token.colorTextHeading;
  const mutedText = isDarkTheme ? 'rgba(226, 232, 240, 0.65)' : token.colorTextSecondary;
  const statusCounts = agents.reduce<Record<AgentHealthStatus, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, { ok: 0, idle: 0, stale: 0, blocked: 0 });
  const summaryItems = (Object.keys(STATUS_META) as AgentHealthStatus[]).map((statusKey) => ({
    ...STATUS_META[statusKey],
    status: statusKey,
    count: statusCounts[statusKey] || 0,
  }));

  const columns = React.useMemo<ColumnsType<AgentHealthRow>>(() => [
    {
      title: 'Agent',
      key: 'agent',
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <Text strong style={{ color: headingColor }}>{record.symbol || 'Unknown'}</Text>
          <Text style={{ fontSize: 12, color: mutedText }}>{record.sessionId}</Text>
        </Space>
      ),
    },
    {
      title: 'Mode',
      dataIndex: 'mode',
      key: 'mode',
      render: (value: string | null) => value?.toUpperCase() || '—',
    },
    {
      title: 'State',
      dataIndex: 'state',
      key: 'state',
      render: (value: string | null) => value || 'Unknown',
    },
    {
      title: 'Trades (24h)',
      dataIndex: 'tradeCount24h',
      key: 'tradeCount24h',
      render: (value: number) => value ?? 0,
    },
    {
      title: 'Last Execution',
      dataIndex: 'lastExecutionTs',
      key: 'lastExecutionTs',
      render: (value: number | null) => (
        <Tooltip title={value ? new Date(value).toLocaleString() : 'No recorded executions'}>
          <span>{formatRelative(value, referenceTs)}</span>
        </Tooltip>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (value: AgentHealthStatus) => {
        const meta = STATUS_META[value] ?? STATUS_META.ok;
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: 'Signals',
      key: 'signals',
      render: (_value, record) => {
        if (!record.flags.length) {
          return <Text style={{ color: mutedText }}>Nominal</Text>;
        }
        return (
          <Space size={[4, 4]} wrap>
            {record.flags.map((flag) => {
              const meta = FLAG_META[flag];
              if (!meta) return null;
              return <Tag key={`${record.sessionId}-${flag}`} color={meta.color}>{meta.label}</Tag>;
            })}
          </Space>
        );
      },
    },
  ], [headingColor, mutedText, referenceTs]);

  return (
    <Card
      title={<span style={{ color: headingColor }}>Agent health</span>}
      style={{ borderRadius: 16, border: `1px solid ${borderColor}`, background: cardBg }}
      extra={
        <Button icon={<SyncOutlined />} onClick={onRefresh} disabled={loading}>
          Refresh
        </Button>
      }
    >
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        {summaryItems.map((item) => (
          <Col xs={12} md={6} key={item.status}>
            <div
              style={{
                borderRadius: 12,
                border: `1px solid ${borderColor}`,
                padding: 12,
                background: isDarkTheme ? 'rgba(15, 23, 42, 0.65)' : token.colorFillTertiary,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <Space size={6}>
                <Badge color={item.color} />
                <Text style={{ color: headingColor, fontWeight: 600 }}>{item.label}</Text>
              </Space>
              <Text style={{ fontSize: 12, color: mutedText }}>Agents</Text>
              <Statistic value={item.count} valueStyle={{ fontSize: 22, color: headingColor }} />
            </div>
          </Col>
        ))}
      </Row>
      <Table
        rowKey="sessionId"
        columns={columns}
        dataSource={agents}
        loading={loading}
        pagination={false}
        size="small"
        style={{ color: headingColor }}
        locale={{ emptyText: loading ? 'Loading agents…' : 'No active agents' }}
      />
    </Card>
  );
}
