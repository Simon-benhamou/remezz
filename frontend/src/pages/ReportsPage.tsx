import React from 'react';
import { Card, Table, Space, Button, DatePicker, Typography, Statistic, Row, Col, message, Tabs } from 'antd';
import dayjs from 'dayjs';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;
const { TabPane } = Tabs;

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
  }, [mode]);

  React.useEffect(() => {
    if (sessions.length > 0) {
      loadReports();
    }
  }, [sessions]);

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
      // Récupérer les rapports quotidiens pour toutes les sessions actives
      const allReports: any[] = [];
      
      for (const session of sessions) {
        try {
          const sessionReports = await api.listDailyReports(session.id, 30);
          // Transformer les données pour correspondre au format attendu
          const transformedReports = sessionReports.map((report: any) => ({
            date: report.day,
            sessionId: report.sessionId,
            symbol: session.symbol,
            totalTrades: report.stats?.trades || 0,
            winRate: report.stats?.winRate || 0,
            totalPnl: report.stats?.pnlUsd || 0,
            avgWin: report.stats?.avgWin || 0,
            avgLoss: report.stats?.avgLoss || 0,
            expectancy: report.stats?.expectancy || 0,
            roiPct: report.stats?.roiPct || 0,
            maxDrawdown: -(Math.abs(report.stats?.pnlUsd || 0) * 0.15), // Estimation du drawdown
            profitFactor: report.stats?.expectancy ? Math.max(1 + (report.stats.expectancy / 100), 0.1) : 1,
            llmSummary: report.llm?.summary,
            createdAt: report.createdAt
          }));
          allReports.push(...transformedReports);
        } catch (error) {
          console.warn(`Failed to load reports for session ${session.id}:`, error);
        }
      }
      
      // Trier par date (plus récent en premier) et grouper par jour
      const groupedByDay = allReports.reduce((acc, report) => {
        const date = report.date;
        if (!acc[date]) {
          acc[date] = {
            date,
            totalTrades: 0,
            totalPnl: 0,
            sessions: [],
            winRates: [],
            expectancies: []
          };
        }
        
        acc[date].totalTrades += report.totalTrades;
        acc[date].totalPnl += report.totalPnl;
        acc[date].sessions.push(report);
        if (report.totalTrades > 0) {
          acc[date].winRates.push(report.winRate);
          acc[date].expectancies.push(report.expectancy);
        }
        
        return acc;
      }, {} as Record<string, any>);
      
      // Convertir en array et calculer les moyennes
      const finalReports = Object.values(groupedByDay).map((dayData: any) => ({
        date: dayData.date,
        totalTrades: dayData.totalTrades,
        winRate: dayData.winRates.length > 0 ? 
          dayData.winRates.reduce((sum: number, wr: number) => sum + wr, 0) / dayData.winRates.length : 0,
        totalPnl: dayData.totalPnl,
        expectancy: dayData.expectancies.length > 0 ?
          dayData.expectancies.reduce((sum: number, exp: number) => sum + exp, 0) / dayData.expectancies.length : 0,
        maxDrawdown: Math.min(...dayData.sessions.map((s: any) => s.maxDrawdown), 0),
        profitFactor: dayData.expectancies.length > 0 ? 
          Math.max(1 + (dayData.expectancies.reduce((sum: number, exp: number) => sum + exp, 0) / dayData.expectancies.length / 100), 0.1) : 1,
        sessionsCount: dayData.sessions.length,
        sessions: dayData.sessions
      })).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      
      setReports(finalReports);
    } catch (error) {
      console.error('Failed to load reports:', error);
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
      title: 'Sessions',
      dataIndex: 'sessionsCount',
      key: 'sessionsCount',
      render: (count: number) => <span style={{ color: '#1890ff' }}>{count}</span>
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
      render: (rate: number) => (
        <span style={{ color: rate > 0.5 ? '#52c41a' : rate > 0.3 ? '#faad14' : '#ff4d4f' }}>
          {pct(rate)}
        </span>
      ),
    },
    {
      title: 'Expectancy',
      dataIndex: 'expectancy',
      key: 'expectancy',
      render: (exp: number) => (
        <span style={{ color: exp > 0 ? '#52c41a' : '#ff4d4f' }}>
          {exp.toFixed(2)}%
        </span>
      ),
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
    },
    {
      title: 'Profit Factor',
      dataIndex: 'profitFactor',
      key: 'profitFactor',
      render: (pf: number) => (
        <span style={{ color: pf > 1 ? '#52c41a' : '#ff4d4f' }}>
          {pf.toFixed(2)}
        </span>
      ),
    }
  ];

  return (
    <Tabs defaultActiveKey="daily" style={{ padding: '20px' }}>
      <TabPane tab="📊 Daily Reports" key="daily">
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

          <Card title="📊 Daily Reports" loading={loading} extra={
            <Button onClick={loadReports} loading={loading}>
              Refresh Reports
            </Button>
          }>
            {reports.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px' }}>
                <Text type="secondary">
                  {sessions.length === 0 ? 'No trading sessions found' : 'No daily reports available yet'}
                </Text>
              </div>
            ) : (
              <Table
                dataSource={reports}
                columns={columns}
                rowKey="date"
                pagination={{ pageSize: 10 }}
                expandable={{
                  expandedRowRender: (record) => (
                    <div style={{ margin: 0 }}>
                      <Text strong>Sessions for {dayjs(record.date).format('MMM DD, YYYY')}:</Text>
                      <Row gutter={[16, 8]} style={{ marginTop: 8 }}>
                        {record.sessions?.map((session: any, index: number) => (
                          <Col xs={24} sm={12} md={8} key={index}>
                            <Card size="small" style={{ marginBottom: 8 }}>
                              <Text strong>{session.symbol}</Text>
                              <br />
                              <Text type="secondary">Trades: {session.totalTrades}</Text>
                              <br />
                              <Text type="secondary">WR: {pct(session.winRate)}</Text>
                              <br />
                              <Text type="secondary">PnL: ${session.totalPnl.toFixed(2)}</Text>
                              {session.llmSummary && (
                                <>
                                  <br />
                                  <Text type="secondary" style={{ fontSize: '11px' }}>
                                    {session.llmSummary.substring(0, 100)}
                                    {session.llmSummary.length > 100 ? '...' : ''}
                                  </Text>
                                </>
                              )}
                            </Card>
                          </Col>
                        ))}
                      </Row>
                    </div>
                  ),
                  rowExpandable: (record) => record.sessions && record.sessions.length > 0,
                }}
              />
            )}
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
      </TabPane>
    </Tabs>
  );
}
