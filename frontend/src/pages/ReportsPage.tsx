import React from 'react';
import { Card, Table, Space, Button, DatePicker, Typography, Statistic, Row, Col, message } from 'antd';
import dayjs from 'dayjs';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

function pct(val?: number | null, digits = 2) {
  if (val == null || Number.isNaN(Number(val))) return '-';
  return `${(Number(val) * 100).toFixed(digits)}%`;
}

export default function ReportsPage() {
  const [sessions, setSessions] = React.useState<any[]>([]);
  const [reports, setReports] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const { mode } = useMode();

  React.useEffect(() => {
    loadSessions();
    loadReports();
  }, [mode]);

  const loadSessions = async () => {
    try {
      const data = await api.listSessions(mode);
      setSessions(data);
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  };

  const loadReports = async () => {
    setLoading(true);
    try {
      const mockReports = [
        {
          date: dayjs().subtract(1, 'day').format('YYYY-MM-DD'),
          totalTrades: 15,
          winRate: 0.67,
          totalPnl: 234.56,
          maxDrawdown: -45.23,
          profitFactor: 1.85,
        },
        {
          date: dayjs().subtract(2, 'day').format('YYYY-MM-DD'),
          totalTrades: 12,
          winRate: 0.58,
          totalPnl: 156.78,
          maxDrawdown: -32.10,
          profitFactor: 1.62,
        }
      ];
      setReports(mockReports);
    } catch (error) {
      message.error('Failed to load reports');
    } finally {
      setLoading(false);
    }
  };

  const globalStats = React.useMemo(() => {
    const totalTrades = reports.reduce((sum, r) => sum + r.totalTrades, 0);
    const avgWinRate = reports.length > 0 ? 
      reports.reduce((sum, r) => sum + r.winRate, 0) / reports.length : 0;
    const totalPnl = reports.reduce((sum, r) => sum + r.totalPnl, 0);
    const maxDrawdown = Math.min(...reports.map(r => r.maxDrawdown), 0);

    return { totalTrades, avgWinRate, totalPnl, maxDrawdown };
  }, [reports]);

  const columns = [
    {
      title: 'Date',
      dataIndex: 'date',
      key: 'date',
      render: (date: string) => dayjs(date).format('MMM DD, YYYY')
    },
    {
      title: 'Trades',
      dataIndex: 'totalTrades',
      key: 'totalTrades',
    },
    {
      title: 'Win Rate',
      dataIndex: 'winRate',
      key: 'winRate',
      render: (rate: number) => pct(rate),
    },
    {
      title: 'PnL',
      dataIndex: 'totalPnl',
      key: 'totalPnl',
      render: (pnl: number) => (
        <span style={{ color: pnl >= 0 ? '#52c41a' : '#ff4d4f' }}>
          ${pnl.toFixed(2)}
        </span>
      ),
    }
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <Card>
        <Title level={3}>📊 Global Trading Reports</Title>
        <Text type="secondary">
          Comprehensive dashboard with performance metrics across all agents
        </Text>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} md={6}>
          <Card>
            <Statistic
              title="Total Trades"
              value={globalStats.totalTrades}
              valueStyle={{ color: '#1890ff' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card>
            <Statistic
              title="Average Win Rate"
              value={globalStats.avgWinRate}
              formatter={(value) => pct(value as number)}
              valueStyle={{ color: globalStats.avgWinRate > 0.5 ? '#52c41a' : '#ff4d4f' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card>
            <Statistic
              title="Total P&L"
              value={globalStats.totalPnl}
              prefix="$"
              precision={2}
              valueStyle={{ color: globalStats.totalPnl >= 0 ? '#52c41a' : '#ff4d4f' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card>
            <Statistic
              title="Max Drawdown"
              value={globalStats.maxDrawdown}
              prefix="$"
              precision={2}
              valueStyle={{ color: '#ff4d4f' }}
            />
          </Card>
        </Col>
      </Row>

      <Card title="Daily Reports" loading={loading}>
        <Table
          dataSource={reports}
          columns={columns}
          rowKey="date"
          pagination={{ pageSize: 10 }}
        />
      </Card>

      <Card title="Active Sessions" size="small">
        <Row gutter={[16, 16]}>
          {sessions.filter((s: any) => !s.stoppedAt).map((session: any) => (
            <Col xs={24} sm={12} md={8} key={session.id}>
              <Card size="small">
                <Text strong>{session.symbol}</Text>
                <br />
                <Text type="secondary">
                  Mode: {session.mode?.toUpperCase()}
                </Text>
                <br />
                <Text type="secondary">
                  Started: {dayjs(session.startedAt).format('MM-DD HH:mm')}
                </Text>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>
    </Space>
  );
}
