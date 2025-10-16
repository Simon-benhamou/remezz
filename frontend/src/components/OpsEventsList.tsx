import React from 'react';
import { Card, Empty, List, Space, Tag, Tooltip, Typography, theme } from 'antd';
import dayjs from 'dayjs';

const { Text } = Typography;

const levelColor: Record<string, string> = {
  info: 'blue',
  warn: 'orange',
  error: 'red',
  watch: 'geekblue',
  debug: 'default',
};

type Props = {
  events?: any[];
  loading?: boolean;
  onRefresh?: () => void;
};

function formatTimestamp(ts?: number) {
  if (!ts) return '—';
  return dayjs(ts).format('MMM D • HH:mm:ss');
}

export default function OpsEventsList({ events = [], loading, onRefresh }: Props) {
  const latestEvents = Array.isArray(events) ? events.slice(0, 5) : [];
  const { token } = theme.useToken();
  const base = token.colorBgBase.toLowerCase();
  const isDarkTheme = !['#ffffff', '#fff', '#fafafa'].includes(base);
  const cardBg = isDarkTheme ? '#0f172a' : token.colorBgContainer;
  const borderColor = isDarkTheme ? 'rgba(148, 163, 184, 0.2)' : token.colorBorderSecondary;
  const headingColor = isDarkTheme ? '#f8fafc' : token.colorText;
  const mutedText = isDarkTheme ? 'rgba(226, 232, 240, 0.65)' : token.colorTextSecondary;
  const itemBg = isDarkTheme ? 'rgba(15, 23, 42, 0.65)' : token.colorFillTertiary;
  const levelSummary = latestEvents.reduce<Record<string, number>>((acc, item) => {
    const level = item.level || 'info';
    acc[level] = (acc[level] || 0) + 1;
    return acc;
  }, {});

  return (
    <Card
      title={<Tooltip title="Événements opérationnels générés par l'agent (kill switch, erreurs, etc.)">Ops events</Tooltip>}
      loading={loading}
      style={{ borderRadius: 16, border: `1px solid ${borderColor}`, background: cardBg }}
      extra={onRefresh ? <a onClick={onRefresh}>Refresh</a> : null}
    >
      {latestEvents.length > 0 && (
        <Space size={[8, 8]} wrap style={{ marginBottom: 12 }}>
          {Object.entries(levelSummary).map(([level, count]) => (
            <Tag key={level} color={levelColor[level] || 'blue'}>
              {level.toUpperCase()} · {count}
            </Tag>
          ))}
        </Space>
      )}
      {latestEvents.length === 0 && !loading ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description='No recent ops events.'
          style={{ margin: '24px 0', color: mutedText }}
        />
      ) : (
        <List
          size='small'
          dataSource={latestEvents}
          renderItem={(item) => (
            <List.Item style={{ background: itemBg, borderRadius: 12, padding: '12px 14px', marginBottom: 8 }}>
              <Space direction='vertical' size={4} style={{ width: '100%' }}>
                <Space size='small' wrap>
                  <Tag color={levelColor[item.level] || 'blue'}>{item.level?.toUpperCase?.()}</Tag>
                  <Tooltip title={item.source}>
                    <Tag color='geekblue'>{item.source}</Tag>
                  </Tooltip>
                  {item.symbol && <Tag>{item.symbol}</Tag>}
                  {item.sessionId && <Tag color='default'>{item.sessionId.slice(0, 8)}…</Tag>}
                </Space>
                <Text style={{ color: headingColor, fontWeight: 500 }}>{item.message}</Text>
                <Text style={{ fontSize: 12, color: mutedText }}>{formatTimestamp(item.ts)}</Text>
              </Space>
            </List.Item>
          )}
        />
      )}
    </Card>
  );
}
