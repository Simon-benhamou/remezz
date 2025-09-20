import React from 'react';
import { Card, Space, Typography, Row, Col, Select, Timeline, Tag, message } from 'antd';
import { InfoCircleOutlined, WarningOutlined, ExclamationCircleOutlined, BugOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';

const { Text, Title } = Typography;

const logColors: Record<string, string> = {
  info: 'blue',
  warn: 'orange', 
  error: 'red',
  debug: 'purple',
};

const logIcons: Record<string, React.ReactNode> = {
  info: <InfoCircleOutlined />,
  warn: <WarningOutlined />,
  error: <ExclamationCircleOutlined />,
  debug: <BugOutlined />,
};

export default function BacklogPage() {
  const [logs, setLogs] = React.useState<any[]>([]);
  const [sessions, setSessions] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [selectedSymbol, setSelectedSymbol] = React.useState<string>('all');
  const { mode } = useMode();

  React.useEffect(() => {
    const loadSessions = async () => {
      try {
        const sessionData = await api.listSessions(mode);
        setSessions(sessionData);
      } catch (error) {
        console.error('Failed to load sessions:', error);
      }
    };
    loadSessions();
  }, [mode]);

  const loadLogs = React.useCallback(async () => {
    if (selectedSymbol === 'all') return;
    
    setLoading(true);
    try {
      // Mock data
      const mockLogs = [
        {
          id: '1',
          timestamp: dayjs().subtract(2, 'minute').toISOString(),
          level: 'info',
          source: 'crypto_moonshot',
          message: 'MOONSHOT mode activated - ultra loose trailing',
          details: { profit: 12.5, mode: 'moonshot' }
        },
        {
          id: '2',
          timestamp: dayjs().subtract(8, 'minute').toISOString(),
          level: 'warn',
          source: 'profit_filter',
          message: 'Trade rejected - insufficient profit potential',
          details: { expected: 0.25, required: 0.3 }
        },
        {
          id: '3',
          timestamp: dayjs().subtract(15, 'minute').toISOString(),
          level: 'error',
          source: 'market_data',
          message: 'Data timeout detected - using fallback',
          details: { timeout: '30s' }
        }
      ];
      setLogs(mockLogs);
    } catch (error) {
      message.error('Failed to load logs');
    } finally {
      setLoading(false);
    }
  }, [selectedSymbol]);

  React.useEffect(() => {
    if (selectedSymbol !== 'all') {
      loadLogs();
    }
  }, [selectedSymbol, loadLogs]);

  const sessionOptions = sessions.map((s: any) => ({
    value: s.symbol,
    label: s.symbol + (s.stoppedAt ? ' (Stopped)' : ' (Active)'),
  }));

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <Card>
        <Title level={3}>📋 Agent Activity & Decision Logs</Title>
        <Text type="secondary">
          Real-time monitoring of agent decision-making and system events
        </Text>
      </Card>

      <Card title="Controls">
        <Row gutter={16}>
          <Col span={8}>
            <Text strong>Trading Session</Text>
            <Select
              value={selectedSymbol}
              onChange={setSelectedSymbol}
              style={{ width: '100%', marginTop: 8 }}
              placeholder="Select session"
              options={[
                { label: 'All Sessions', value: 'all' },
                ...sessionOptions
              ]}
            />
          </Col>
        </Row>
      </Card>

      <Card title="Live Agent Activity" loading={loading}>
        {selectedSymbol === 'all' ? (
          <div style={{ textAlign: 'center', padding: '40px' }}>
            <Text type="secondary">Please select a trading session to view logs</Text>
          </div>
        ) : logs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px' }}>
            <Text type="secondary">No logs found</Text>
          </div>
        ) : (
          <Timeline
            items={logs.map((log) => ({
              color: logColors[log.level] || 'blue',
              dot: logIcons[log.level],
              children: (
                <div key={log.id}>
                  <div style={{ marginBottom: '8px' }}>
                    <Tag color={logColors[log.level]}>
                      {log.level.toUpperCase()}
                    </Tag>
                    <Tag color="purple">{log.source}</Tag>
                    <Text type="secondary" style={{ fontSize: '12px', marginLeft: 8 }}>
                      {dayjs(log.timestamp).format('HH:mm:ss')}
                    </Text>
                  </div>
                  <Text strong>{log.message}</Text>
                  {log.details && (
                    <div style={{ 
                      background: '#f5f5f5', 
                      padding: '8px', 
                      borderRadius: '4px',
                      marginTop: '8px',
                      fontSize: '12px',
                      fontFamily: 'monospace'
                    }}>
                      {JSON.stringify(log.details, null, 2)}
                    </div>
                  )}
                </div>
              ),
            }))}
          />
        )}
      </Card>

      <Card title="Active Sessions" size="small">
        <Row gutter={16}>
          {sessions.filter((s: any) => !s.stoppedAt).map((session: any) => (
            <Col xs={24} sm={12} md={8} key={session.id}>
              <Card 
                size="small" 
                style={{ 
                  border: selectedSymbol === session.symbol ? '2px solid #1890ff' : undefined 
                }}
              >
                <div>
                  <Text strong>{session.symbol}</Text>
                  <Tag color="green" style={{ marginLeft: 8 }}>ACTIVE</Tag>
                </div>
                <Text type="secondary">
                  Started: {dayjs(session.startedAt).format('MM-DD HH:mm')}
                </Text>
                <br />
                <Text type="secondary">
                  Mode: {session.mode?.toUpperCase()}
                </Text>
              </Card>
            </Col>
          ))}
        </Row>
        
        {sessions.filter((s: any) => !s.stoppedAt).length === 0 && (
          <div style={{ textAlign: 'center', padding: '20px' }}>
            <Text type="secondary">No active trading sessions</Text>
          </div>
        )}
      </Card>
    </Space>
  );
}
