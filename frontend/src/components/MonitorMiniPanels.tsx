import React from 'react';
import { Card, Col, Row, Space, Tag, Tooltip, Typography } from 'antd';

const statusColor: Record<string, string> = {
  ok: '#16a34a',
  warn: '#d97706',
  alert: '#dc2626',
  idle: '#64748b',
};

export type MiniPanel = {
  key: string;
  title: string;
  status: 'ok' | 'warn' | 'alert' | 'idle';
  value: string;
  hint?: string;
};

type Props = {
  panels?: MiniPanel[] | null;
};

export default function MonitorMiniPanels({ panels }: Props) {
  if (!panels || !panels.length) return null;
  return (
    <Row gutter={[12, 12]}>
      {panels.map((panel) => {
        const color = statusColor[panel.status] || '#0ea5e9';
        return (
          <Col xs={24} md={8} key={panel.key}>
            <Card
              bordered
              size='small'
              style={{ borderRadius: 12, borderColor: `${color}33` }}
            >
              <Space direction='vertical' size={4} style={{ width: '100%' }}>
                <Space align='center' style={{ justifyContent: 'space-between', width: '100%' }}>
                  <Typography.Text style={{ fontWeight: 600 }}>{panel.title}</Typography.Text>
                  <Tag color={color} style={{ borderRadius: 999 }}>{panel.status.toUpperCase()}</Tag>
                </Space>
                <Typography.Title level={4} style={{ margin: 0 }}>{panel.value}</Typography.Title>
                {panel.hint && (
                  <Tooltip title={panel.hint}>
                    <Typography.Text type='secondary' style={{ fontSize: 12 }}>{panel.hint}</Typography.Text>
                  </Tooltip>
                )}
              </Space>
            </Card>
          </Col>
        );
      })}
    </Row>
  );
}
