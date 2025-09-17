import React from 'react';
import { Card, List, Space, Tag, Tooltip } from 'antd';
import dayjs from 'dayjs';

const levelColor: Record<string, string> = {
  info: 'blue',
  warn: 'orange',
  error: 'red',
};

type Props = {
  events?: any[];
  loading?: boolean;
  onRefresh?: ()=>void;
};

export default function OpsEventsList({ events = [], loading, onRefresh }: Props) {
  return (
    <Card
      title={<Tooltip title="Événements opérationnels générés par l'agent (kill switch, erreurs, etc.)">Ops events</Tooltip>}
      loading={loading}
      style={{ borderRadius: 12 }}
      extra={onRefresh ? <a onClick={onRefresh}>Refresh</a> : null}
    >
      <List
        size='small'
        dataSource={events}
        renderItem={(item) => (
          <List.Item>
            <Space size='small' wrap>
              <Tag color={levelColor[item.level] || 'blue'}>{item.level?.toUpperCase?.()}</Tag>
              <Tooltip title={item.source}>
                <Tag color='geekblue'>{item.source}</Tag>
              </Tooltip>
              <span>{item.message}</span>
              {item.symbol && <Tag>{item.symbol}</Tag>}
              <span style={{ color: '#94a3b8' }}>{dayjs(item.ts).format('HH:mm:ss')}</span>
            </Space>
          </List.Item>
        )}
      />
      {!events.length && !loading && <p style={{ color: '#94a3b8', margin: 0 }}>No recent ops events.</p>}
    </Card>
  );
}
