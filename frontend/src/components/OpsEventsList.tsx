import React from 'react';
import { Card, Empty, List, Space, Tag, Tooltip, Typography } from 'antd';
import dayjs from 'dayjs';

const { Text } = Typography;

const levelColor: Record<string, string> = {
  info: 'blue',
  warn: 'orange',
  error: 'red',
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

  return (
    <Card
      title={<Tooltip title="Événements opérationnels générés par l'agent (kill switch, erreurs, etc.)">Ops events</Tooltip>}
      loading={loading}
      style={{ borderRadius: 12 }}
      extra={onRefresh ? <a onClick={onRefresh}>Refresh</a> : null}
    >
      {latestEvents.length === 0 && !loading ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description='No recent ops events.' style={{ margin: '24px 0' }} />
      ) : (
        <List
          size='small'
          dataSource={latestEvents}
          renderItem={(item) => (
            <List.Item>
              <Space direction='vertical' size={4} style={{ width: '100%' }}>
                <Space size='small' wrap>
                  <Tag color={levelColor[item.level] || 'blue'}>{item.level?.toUpperCase?.()}</Tag>
                  <Tooltip title={item.source}>
                    <Tag color='geekblue'>{item.source}</Tag>
                  </Tooltip>
                  {item.symbol && <Tag>{item.symbol}</Tag>}
                  {item.sessionId && <Tag color='default'>{item.sessionId.slice(0, 8)}…</Tag>}
                </Space>
                <Text style={{ color: '#1f2937', fontWeight: 500 }}>{item.message}</Text>
                <Text type='secondary' style={{ fontSize: 12 }}>{formatTimestamp(item.ts)}</Text>
              </Space>
            </List.Item>
          )}
        />
      )}
    </Card>
  );
}
