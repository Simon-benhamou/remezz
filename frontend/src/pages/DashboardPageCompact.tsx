import React from 'react';
import { Card, Row, Col, Statistic, Space, Button, Tag, List, Badge, Typography, Alert, Table, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useMode } from '../contexts/ModeContext';
import RecentTradesTable from '../components/RecentTradesTable';
import PerformanceOverviewCard from '../components/PerformanceOverviewCard';
import { 
  RobotOutlined, 
  DollarOutlined, 
  ThunderboltOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  PlusOutlined,
  EyeOutlined,
  FireOutlined,
  BulbOutlined,
  LineChartOutlined,
  ThunderboltFilled
} from '@ant-design/icons';

const { Title, Text } = Typography;

export default function DashboardPageCompact(){
  const [ov, setOv] = React.useState<any>({});
  const [loading, setLoading] = React.useState<boolean>(true);
  const [trades, setTrades] = React.useState<any[]>([]);
  const [tradesLoading, setTradesLoading] = React.useState<boolean>(false);
  const [optimizing, setOptimizing] = React.useState<boolean>(false);
  const navigate = useNavigate();
  const { mode } = useMode();
  
  async function loadTrades(){
    setTradesLoading(true);
    try {
      // Fetch only CLOSED trades across all sessions for accurate display
      const result = await api.getTrades(undefined, { limit: 50 });
      // Filter to only show closed trades with valid data
      const closedTrades = Array.isArray(result) 
        ? result.filter((t: any) => 
            t.status === 'closed' && 
            t.exitPrice != null && 
            t.entryPrice != null &&
            t.realizedPnlUsd != null
          )
        : [];
      setTrades(closedTrades);
    } catch(err){
      console.error('Failed to load trades:', err);
      setTrades([]);
    } finally {
      setTradesLoading(false);
    }
  }

  async function load(){
    setLoading(true);
    try {
      const overviewRes = await api.overview(mode);
      setOv(overviewRes || {});
    } catch(err){
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function runOptimizer(){
    setOptimizing(true);
    try {
      await api.optimizeAllSymbols();
      message.success('Optimizer launched for all symbols!');
    } catch(err: any){
      message.error(err?.response?.data?.error || 'Failed to run optimizer');
    } finally {
      setOptimizing(false);
    }
  }

  React.useEffect(() => {
    load();
    loadTrades();
    const iv = setInterval(() => {
      load();
      loadTrades();
    }, 30000); // Auto-refresh every 30s
    return () => clearInterval(iv);
  }, [mode]);

  const globalHealth = React.useMemo(() => {
    const alertCounts = ov?.alerts?.severityCounts || {};
    const highAlerts = alertCounts.high || 0;
    const medAlerts = alertCounts.med || 0;
    const activeCount = ov?.activeCount || 0;
    
    if (highAlerts > 0) return { status: 'critical', color: '#ff4d4f', icon: <ExclamationCircleOutlined /> };
    if (medAlerts > 2) return { status: 'warning', color: '#faad14', icon: <WarningOutlined /> };
    if (activeCount > 0) return { status: 'healthy', color: '#52c41a', icon: <CheckCircleOutlined /> };
    return { status: 'idle', color: '#d9d9d9', icon: <RobotOutlined /> };
  }, [ov]);

  return (
    <div style={{ padding: '20px', maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <Title level={3} style={{ margin: 0 }}>
          Dashboard Overview
          <Tag color={mode === 'live' ? 'gold' : 'blue'} style={{ marginLeft: 12 }}>
            {mode.toUpperCase()}
          </Tag>
        </Title>
        <Space>
          <Button 
            icon={<ThunderboltFilled />} 
            onClick={runOptimizer} 
            loading={optimizing}
            type="default"
          >
            Run Optimizer (All Symbols)
          </Button>
          <Button onClick={load} loading={loading}>Refresh</Button>
          <Button type="primary" onClick={() => navigate('/sessions')}>
            <PlusOutlined /> New Agent
          </Button>
        </Space>
      </div>

      {/* KPIs Row - Compact */}
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}>
          <Card size="small" style={{ borderLeft: '3px solid #52c41a' }} hoverable onClick={() => navigate('/sessions')}>
            <Statistic
              title={<Text type="secondary" style={{ fontSize: 11 }}><RobotOutlined /> Active Agents</Text>}
              value={ov?.activeCount || 0}
              suffix={<Text type="secondary" style={{ fontSize: 11 }}>active</Text>}
              valueStyle={{ fontSize: 22, color: '#52c41a' }}
            />
          </Card>
        </Col>
        
        <Col xs={12} sm={6}>
          <Card size="small" style={{ borderLeft: `3px solid ${(ov?.pnlUsd || 0) >= 0 ? '#52c41a' : '#ff4d4f'}` }} hoverable>
            <Statistic
              title={<Text type="secondary" style={{ fontSize: 11 }}><DollarOutlined /> PnL</Text>}
              value={Number(ov?.pnlUsd || 0)}
              precision={2}
              prefix="$"
              valueStyle={{ fontSize: 22, color: (ov?.pnlUsd || 0) >= 0 ? '#52c41a' : '#ff4d4f' }}
            />
          </Card>
        </Col>
        
        <Col xs={12} sm={6}>
          <Card size="small" style={{ borderLeft: '3px solid #1890ff' }} hoverable>
            <Statistic
              title={<Text type="secondary" style={{ fontSize: 11 }}><ThunderboltOutlined /> Win Rate</Text>}
              value={Number(ov?.avgWinRate || 0)}
              precision={1}
              suffix="%"
              valueStyle={{ fontSize: 22, color: (ov?.avgWinRate || 0) >= 60 ? '#52c41a' : (ov?.avgWinRate || 0) >= 50 ? '#faad14' : '#ff4d4f' }}
            />
          </Card>
        </Col>
        
        <Col xs={12} sm={6}>
          <Card size="small" style={{ borderLeft: '3px solid #722ed1' }} hoverable>
            <Statistic
              title={<Text type="secondary" style={{ fontSize: 11 }}><BulbOutlined /> AI Calls</Text>}
              value={Number(ov?.aiCallsTotal || 0)}
              valueStyle={{ fontSize: 22, color: '#722ed1' }}
            />
          </Card>
        </Col>
      </Row>

      {/* Performance Chart & Recent Trades */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={12}>
          <PerformanceOverviewCard
            trades={trades}
            loading={tradesLoading}
            title="Performance Overview"
            subtitle="Cumulative PnL across all sessions"
            tagLabel={mode.toUpperCase()}
          />
        </Col>
        <Col xs={24} lg={12}>
          <RecentTradesTable
            trades={trades}
            loading={tradesLoading}
            onRefresh={loadTrades}
          />
        </Col>
      </Row>

      {/* Main Content: 2 Columns */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        {/* LEFT: Active Agents */}
        <Col xs={24} lg={14}>
          <Card 
            size="small"
            title={<Space><FireOutlined style={{ color: '#ff4d4f' }} /> Active Agents ({ov?.activeCount || 0})</Space>}
            style={{ height: '100%' }}
          >
            {(ov?.sessions || []).length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
                <RobotOutlined style={{ fontSize: 48, marginBottom: 16 }} />
                <div>No active agents</div>
                <Button type="primary" style={{ marginTop: 16 }} onClick={() => navigate('/agents')}>
                  Create Agent
                </Button>
              </div>
            ) : (
              <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                <Row gutter={[12, 12]}>
                  {(ov?.sessions || []).map((session: any) => (
                    <Col xs={24} sm={12} key={session.id}>
                      <div 
                        style={{ 
                          padding: 12,
                          borderLeft: `3px solid ${session.bias === 'long' ? '#52c41a' : session.bias === 'short' ? '#ff4d4f' : '#d9d9d9'}`,
                          backgroundColor: 'rgba(255, 255, 255, 0.04)',
                          borderRadius: 4,
                          cursor: 'pointer',
                          transition: 'background 0.2s',
                          border: '1px solid rgba(255, 255, 255, 0.08)'
                        }}
                        onClick={() => navigate(`/agents/${session.id}`)}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.08)'}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.04)'}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <Text strong>{session.symbol}</Text>
                          <Tag color={session.state === 'ARMED' ? 'green' : session.state === 'MANAGE' ? 'blue' : 'default'}>
                            {session.state}
                          </Tag>
                        </div>
                        <Space style={{ width: '100%', justifyContent: 'space-between', fontSize: 12 }}>
                          <Text type="secondary">PnL</Text>
                          <Text style={{ color: (session.pnlUsd || 0) >= 0 ? '#52c41a' : '#ff4d4f', fontWeight: 'bold' }}>
                            ${(session.pnlUsd || 0).toFixed(2)} ({(session.winRate || 0).toFixed(0)}%)
                          </Text>
                        </Space>
                      </div>
                    </Col>
                  ))}
                </Row>
              </div>
            )}
          </Card>
        </Col>
        
        {/* RIGHT: Health + Balance */}
        <Col xs={24} lg={10}>
          <Space direction="vertical" style={{ width: '100%' }} size={16}>
            {/* Health */}
            <Card 
              size="small"
              title={<Space>{globalHealth.icon} System Health</Space>}
            >
              <div style={{ textAlign: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: 18, fontWeight: 'bold', color: globalHealth.color }}>
                  {globalHealth.status.toUpperCase()}
                </div>
              </div>
              
              <Space direction="vertical" style={{ width: '100%', fontSize: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Text>Critical:</Text>
                  <Badge count={ov?.alerts?.severityCounts?.high || 0} style={{ backgroundColor: '#ff4d4f' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Text>Warning:</Text>
                  <Badge count={ov?.alerts?.severityCounts?.med || 0} style={{ backgroundColor: '#faad14' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Text>Info:</Text>
                  <Badge count={ov?.alerts?.severityCounts?.low || 0} style={{ backgroundColor: '#1890ff' }} />
                </div>
              </Space>

              {(ov?.alerts?.recent || []).length > 0 && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f0f0f0' }}>
                  <Text type="secondary" style={{ fontSize: 11 }}>Recent Alerts:</Text>
                  <List
                    size="small"
                    dataSource={(ov?.alerts?.recent || []).slice(0, 3)}
                    renderItem={(alert: any) => (
                      <List.Item style={{ padding: '4px 0', fontSize: 11 }}>
                        <Tag color={alert.severity === 'high' ? 'red' : alert.severity === 'med' ? 'orange' : 'blue'}>
                          {alert.kind}
                        </Tag>
                        <Text type="secondary">{alert.symbol}</Text>
                      </List.Item>
                    )}
                  />
                </div>
              )}
            </Card>

            {/* Balance */}
            <Card 
              size="small"
              title={<Space><DollarOutlined /> {mode === 'live' ? 'Live Balance' : 'Paper Balance'}</Space>}
            >
              {mode === 'live' ? (
                <Space direction="vertical" style={{ width: '100%', fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Text strong>Equity:</Text>
                    <Text strong style={{ color: '#1890ff' }}>${(ov?.exchangeBalance?.totalUsd || 0).toFixed(2)}</Text>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Text type="secondary">Free:</Text>
                    <Text>${(ov?.exchangeBalance?.freeUsd || 0).toFixed(2)}</Text>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Text type="secondary">Used:</Text>
                    <Text>${(ov?.exchangeBalance?.usedUsd || 0).toFixed(2)}</Text>
                  </div>
                </Space>
              ) : (
                <Space direction="vertical" style={{ width: '100%', fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Text strong>Equity:</Text>
                    <Text strong style={{ color: '#52c41a' }}>${(ov?.paperBalance?.equityUsd || 0).toFixed(2)}</Text>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Text type="secondary">Free:</Text>
                    <Text>${(ov?.paperBalance?.freeUsd || 0).toFixed(2)}</Text>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Text type="secondary">Committed:</Text>
                    <Text>${(ov?.paperBalance?.committedUsd || 0).toFixed(2)}</Text>
                  </div>
                </Space>
              )}
            </Card>
          </Space>
        </Col>
      </Row>

      {/* Quick Actions Footer */}
      <Card size="small" style={{ marginTop: 16, textAlign: 'center' }}>
        <Space>
          <Button onClick={() => navigate('/sessions')}>
            <EyeOutlined /> All Sessions
          </Button>
          <Button type="primary" onClick={() => navigate('/sessions')}>
            <PlusOutlined /> New Agent
          </Button>
        </Space>
      </Card>
    </div>
  );
}
