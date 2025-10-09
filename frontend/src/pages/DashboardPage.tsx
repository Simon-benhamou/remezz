import React from 'react';
import { Card, Row, Col, Statistic, Space, Button, Table, Tag, List, Progress, Badge, Avatar, Typography, Divider, Alert, Tooltip, Dropdown, MenuProps, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { openWS } from '../ws';
import OpsMetricsPanel from '../components/OpsMetricsPanel';
import AdaptiveWeightsPanel from '../components/AdaptiveWeightsPanel';
import SmartOpportunityScanner from '../components/SmartOpportunityScanner';
import { useMode } from '../contexts/ModeContext';
import { 
  ArrowUpOutlined, 
  ArrowDownOutlined, 
  RobotOutlined, 
  DollarOutlined, 
  ThunderboltOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  StopOutlined,
  PlusOutlined,
  EyeOutlined,
  SettingOutlined,
  BulbOutlined,
  FireOutlined,
  RocketOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useStopAllLock } from '../hooks/useStopAllLock';
import { useStopAllConfirmation } from '../hooks/useStopAllConfirmation';

const { Title, Text } = Typography;

export default function DashboardPage(){
  const [ov, setOv] = React.useState<any>({});
  const [loading, setLoading] = React.useState<boolean>(true);
  const [opsMetrics, setOpsMetrics] = React.useState<any>(null);
  const [opsLoading, setOpsLoading] = React.useState<boolean>(true);
  const [adaptiveData, setAdaptiveData] = React.useState<any>(null);
  const [adaptiveLoading, setAdaptiveLoading] = React.useState<boolean>(true);
  const [showSmartScanner, setShowSmartScanner] = React.useState(false);
  const loadedRef = React.useRef(false);
  const navigate = useNavigate();
  const { mode } = useMode();
  
  // Compute global health status
  const getGlobalHealth = () => {
    const alertCounts = ov?.alerts?.severityCounts || {};
    const highAlerts = alertCounts.high || 0;
    const medAlerts = alertCounts.med || 0;
    const activeCount = ov?.activeCount || 0;
    
    if (highAlerts > 0) return { status: 'critical', color: '#ff4d4f', icon: <ExclamationCircleOutlined /> };
    if (medAlerts > 2 || (medAlerts > 0 && activeCount > 3)) return { status: 'warning', color: '#faad14', icon: <WarningOutlined /> };
    if (activeCount > 0) return { status: 'healthy', color: '#52c41a', icon: <CheckCircleOutlined /> };
    return { status: 'idle', color: '#d9d9d9', icon: <StopOutlined /> };
  };
  
  // Compute trend for metrics
  const getTrend = (current: number, previous?: number) => {
    if (!previous || previous === 0) return null;
    const change = ((current - previous) / previous) * 100;
    if (Math.abs(change) < 1) return null;
    return {
      direction: change > 0 ? 'up' : 'down',
      percentage: Math.abs(change).toFixed(1),
      color: change > 0 ? '#52c41a' : '#ff4d4f',
      icon: change > 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />
    };
  };
  
  const load = React.useCallback(async ()=>{
    try {
      const data = await api.overview(mode);
      setOv(data);
    } finally {
      if (!loadedRef.current) { setLoading(false); loadedRef.current = true; }
    }
  }, [mode]);

  const { locked, unlock, setLocked } = useStopAllLock();
  const showStopAllConfirm = useStopAllConfirmation({
    description: (
      <span>
        This will immediately halt every active agent, cancel all outstanding orders, and flatten open positions. New agent
        creation stays disabled until you reset the lock.
      </span>
    ),
  });

  const quickActions = React.useMemo<MenuProps['items']>(() => {
    const items: NonNullable<MenuProps['items']> = [
      {
        key: 'smart-scanner',
        label: 'Smart Opportunity Scanner',
        icon: <RocketOutlined />,
        onClick: () => setShowSmartScanner((prev) => !prev),
      },
      {
        key: 'new-btc',
        label: 'New BTC Agent',
        icon: <PlusOutlined />,
        onClick: () => navigate('/sessions'),
        disabled: locked,
      },
      {
        key: 'new-eth',
        label: 'New ETH Agent',
        icon: <PlusOutlined />,
        onClick: () => navigate('/sessions'),
        disabled: locked,
      },
      {
        key: 'stop-all',
        label: 'Emergency Stop All',
        icon: <StopOutlined />,
        danger: true,
        onClick: () => showStopAllConfirm({ onSuccess: () => { load(); loadOps(); } }),
      },
    ];

    if (locked) {
      items.push({
        key: 'reset-lock',
        label: 'Reset Emergency Lock',
        icon: <ReloadOutlined />,
        onClick: () => {
          unlock();
          message.success('Agent creation re-enabled.');
        },
      });
    }

    return items;
  }, [locked, navigate, showStopAllConfirm, load, loadOps, unlock]);
  const loadOps = React.useCallback(async ()=>{
    try {
      setOpsLoading(true);
      setAdaptiveLoading(true);
      const [metrics, adaptive] = await Promise.all([
        api.getOpsMetrics().catch(()=>null),
        api.getAdaptiveWeights().catch(()=>null),
      ]);
      if (metrics) setOpsMetrics(metrics);
      if (adaptive) setAdaptiveData(adaptive);
    } finally {
      setOpsLoading(false);
      setAdaptiveLoading(false);
    }
  }, []);
  React.useEffect(()=>{
    void load();
    void loadOps();
    const t = setInterval(() => { void load(); }, 15000);
    const opsTimer = setInterval(() => { void loadOps(); }, 30000);
    // WS live updates for overview_session events
    const API_BASE = (import.meta as any).env.VITE_API_BASE || 'http://localhost:4000';
    const key = (localStorage.getItem('apiKey') || '');
    const ws = openWS(API_BASE, key, '', (msg:any)=>{
      if (msg?.type === 'overview_session') {
        setOv((prev:any)=>{
          const cur = prev || {};
          const sessions = Array.isArray(cur.sessions) ? cur.sessions.slice() : [];
          const idx = sessions.findIndex((s:any)=> s.id === msg.data.id);
          if (idx>=0) {
            sessions[idx] = { ...sessions[idx], pnlUsd: msg.data.pnlUsd, roiPct: msg.data.roiPct };
          }
          return { ...cur, sessions, updatedAt: new Date().toISOString() };
        });
      }
      if (msg?.type === 'agent_stop_all') {
        setLocked(true);
        void load();
        void loadOps();
      }
    });
    return ()=> { try { clearInterval(t); } catch {}; try { clearInterval(opsTimer); } catch {}; try { ws?.close?.(); } catch {} };
  }, [load, loadOps, setLocked]);
  
  const globalHealth = getGlobalHealth();
  const marginOverview = opsMetrics?.margin;
  const marginFlag = marginOverview
    ? marginOverview.critical
      ? { label: 'Critical', color: '#ff4d4f' }
      : marginOverview.warn
        ? { label: 'Elevated', color: '#faad14' }
        : { label: 'Healthy', color: '#52c41a' }
    : null;
  
  return (
    <div style={{ padding: '24px', background: '#f5f5f5', minHeight: '100vh' }}>
      {/* Hero Section */}
      <Card style={{ 
        marginBottom: 24, 
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        border: 'none',
        color: 'white'
      }}>
        <Row align="middle" justify="space-between">
          <Col xs={24} lg={12}>
            <Space direction="vertical" size="small">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Avatar 
                  size={48} 
                  style={{ backgroundColor: globalHealth.color }} 
                  icon={globalHealth.icon}
                />
                <div>
                  <Title level={2} style={{ color: 'white', margin: 0 }}>
                    Trading Command Center
                  </Title>
                  <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 16 }}>
                    System Status: <strong style={{ color: 'white' }}>{globalHealth.status.toUpperCase()}</strong>
                  </Text>
                </div>
              </div>
              <Text style={{ color: 'rgba(255,255,255,0.7)' }}>
                {ov?.activeCount || 0} active agents monitoring {(ov?.symbols || []).length} markets
              </Text>
            </Space>
          </Col>
          <Col xs={24} lg={12} style={{ textAlign: 'right' }}>
            <Space size="large">
              <Dropdown menu={{ items: quickActions }} placement="bottomRight">
                <Button size="large" type="primary" style={{ background: 'rgba(255,255,255,0.2)', border: 'none' }}>
                  <SettingOutlined /> Quick Actions
                </Button>
              </Dropdown>
              <Tooltip title={locked ? 'Emergency halt active. Reset to enable new agent creation.' : undefined}>
                <Button
                  size="large"
                  type="primary"
                  style={{ background: '#52c41a', border: 'none' }}
                  onClick={() => navigate('/sessions')}
                  disabled={locked}
                >
                  <PlusOutlined /> New Agent
                </Button>
              </Tooltip>
            </Space>
          </Col>
        </Row>
      </Card>

      {/* Smart Opportunity Scanner */}
      {showSmartScanner && (
        <div style={{ marginBottom: 24 }}>
          <SmartOpportunityScanner 
            onSymbolSelect={(symbol) => {
              console.log('Selected symbol:', symbol);
              // Navigate to create new session with selected symbol
              navigate(`/sessions?symbol=${symbol}`);
            }}
            onAutoTrade={(symbol) => {
              console.log('Auto trade selected for:', symbol);
              // Implement auto-trade logic - create session and start immediately
              navigate(`/sessions?symbol=${symbol}&autoStart=true`);
            }}
          />
        </div>
      )}

      {/* Main KPIs */}
      <Row gutter={[24, 24]} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12} lg={6}>
          <Card 
            style={{ 
              borderLeft: '4px solid #52c41a',
              transition: 'all 0.3s ease',
              cursor: 'pointer'
            }}
            hoverable
            onClick={() => navigate('/sessions')}
          >
            <Statistic
              title={
                <Space>
                  <RobotOutlined style={{ color: '#52c41a' }} />
                  Active Agents
                </Space>
              }
              value={ov?.activeCount || 0}
              suffix={
                <div style={{ fontSize: 12, color: '#666' }}>
                  / {ov?.sessionsCount || 0} total
                </div>
              }
              valueStyle={{ color: '#52c41a', fontSize: 28 }}
            />
          </Card>
        </Col>
        
        <Col xs={24} sm={12} lg={6}>
          <Card 
            style={{ 
              borderLeft: `4px solid ${(ov?.pnlUsd || 0) >= 0 ? '#52c41a' : '#ff4d4f'}`,
              transition: 'all 0.3s ease'
            }}
            hoverable
          >
            <Statistic
              title={
                <Space>
                  <DollarOutlined style={{ color: (ov?.pnlUsd || 0) >= 0 ? '#52c41a' : '#ff4d4f' }} />
                  Total PnL
                </Space>
              }
              value={Number(ov?.pnlUsd || 0)}
              precision={2}
              prefix="$"
              valueStyle={{ 
                color: (ov?.pnlUsd || 0) >= 0 ? '#52c41a' : '#ff4d4f',
                fontSize: 28
              }}
              suffix={
                <div style={{ fontSize: 12, color: '#666' }}>
                  ROI: {(ov?.roiPct || 0).toFixed(1)}%
                </div>
              }
            />
          </Card>
        </Col>
        
        <Col xs={24} sm={12} lg={6}>
          <Card 
            style={{ 
              borderLeft: '4px solid #1890ff',
              transition: 'all 0.3s ease'
            }}
            hoverable
          >
            <Statistic
              title={
                <Space>
                  <ThunderboltOutlined style={{ color: '#1890ff' }} />
                  Win Rate
                </Space>
              }
              value={Number(ov?.avgWinRate || 0)}
              precision={1}
              suffix="%"
              valueStyle={{ 
                color: (ov?.avgWinRate || 0) >= 60 ? '#52c41a' : (ov?.avgWinRate || 0) >= 50 ? '#faad14' : '#ff4d4f',
                fontSize: 28
              }}
            />
          </Card>
        </Col>
        
        <Col xs={24} sm={12} lg={6}>
          <Card 
            style={{ 
              borderLeft: '4px solid #722ed1',
              transition: 'all 0.3s ease'
            }}
            hoverable
          >
            <Statistic
              title={
                <Space>
                  <BulbOutlined style={{ color: '#722ed1' }} />
                  AI Calls
                </Space>
              }
              value={Number(ov?.aiCallsTotal || 0)}
              valueStyle={{ color: '#722ed1', fontSize: 28 }}
              suffix={
                <div style={{ fontSize: 12, color: '#666' }}>
                  Smart decisions
                </div>
              }
            />
          </Card>
        </Col>
      </Row>

      {marginOverview && (
        <Row gutter={[24, 24]} style={{ marginBottom: 24 }}>
          <Col xs={24} lg={12}>
            <Card
              title={
                <Space>
                  <WarningOutlined style={{ color: marginFlag?.color || '#0ea5e9' }} />
                  Margin health
                </Space>
              }
              extra={marginFlag ? <Tag color={marginFlag.color}>{marginFlag.label}</Tag> : null}
            >
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <div>
                  <Text type="secondary">Average utilisation</Text>
                  <Progress
                    percent={Number.isFinite(marginOverview.averageUtilisationPct)
                      ? Number(marginOverview.averageUtilisationPct.toFixed(1))
                      : 0}
                    strokeColor={marginFlag?.color || '#0ea5e9'}
                    showInfo
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#64748b', fontSize: 12 }}>
                  <span>{marginOverview.tracked || 0} sessions monitored</span>
                  <span>
                    {marginOverview.warn || 0} warn · {marginOverview.critical || 0} critical
                  </span>
                </div>
              </Space>
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card
              title={
                <Space>
                  <ExclamationCircleOutlined style={{ color: '#f97316' }} />
                  Sessions needing downsizing
                </Space>
              }
            >
              {Array.isArray(marginOverview.worstSessions) && marginOverview.worstSessions.length ? (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {marginOverview.worstSessions.map((row: any) => (
                    <Card key={`${row.sessionId}_${row.symbol}`} size="small" style={{ background: '#f8fafc' }}>
                      <Space direction="vertical" style={{ width: '100%' }}>
                        <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                          <Text strong>{row.symbol || row.sessionId}</Text>
                          <Tag color={row.status === 'critical' ? 'red' : 'orange'}>{row.status.toUpperCase()}</Tag>
                        </Space>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#475569' }}>
                          <span>Utilisation</span>
                          <span>{Number(row.utilisationPct || 0).toFixed(1)}%</span>
                        </div>
                        {Number.isFinite(row.worstLiquidationDistancePct) && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#475569' }}>
                            <span>Liquidation buffer</span>
                            <span>{Number(row.worstLiquidationDistancePct).toFixed(2)}%</span>
                          </div>
                        )}
                      </Space>
                    </Card>
                  ))}
                </Space>
              ) : (
                <div style={{ color: '#94a3b8' }}>All sessions within safe margins.</div>
              )}
            </Card>
          </Col>
        </Row>
      )}

      {/* Active Agents Grid */}
      <Row gutter={[24, 24]} style={{ marginBottom: 24 }}>
        <Col xs={24} lg={16}>
          <Card 
            title={
              <Space>
                <FireOutlined style={{ color: '#ff4d4f' }} />
                <span>Active Trading Agents</span>
                <Badge count={ov?.activeCount || 0} showZero color="#52c41a" />
              </Space>
            }
            extra={
              <Space>
                <Button 
                  type="text" 
                  size="small"
                  onClick={load}
                  loading={loading}
                >
                  Refresh
                </Button>
                <Button 
                  type="primary" 
                  size="small"
                  onClick={() => navigate('/sessions')}
                >
                  <EyeOutlined /> View All
                </Button>
              </Space>
            }
          >
            <Row gutter={[16, 16]}>
              {(ov?.sessions || []).slice(0, 6).map((session: any) => (
                <Col xs={24} sm={12} lg={8} key={session.id}>
                  <Card 
                    size="small"
                    style={{ 
                      borderLeft: `3px solid ${session.bias === 'long' ? '#52c41a' : session.bias === 'short' ? '#ff4d4f' : '#d9d9d9'}`,
                      cursor: 'pointer',
                      transition: 'all 0.2s ease'
                    }}
                    hoverable
                    onClick={() => navigate(`/monitor/${session.id}`)}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <Space>
                        <Avatar size="small" style={{ backgroundColor: session.mode === 'live' ? '#faad14' : '#1890ff' }}>
                          {session.symbol?.substring(0, 2)}
                        </Avatar>
                        <Text strong>{session.symbol}</Text>
                      </Space>
                      <Tag color={session.aggressiveness === 'aggressive' ? 'red' : session.aggressiveness === 'reactive' ? 'orange' : 'blue'}>
                        {session.aggressiveness || 'conservative'}
                      </Tag>
                    </div>
                    
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>PnL:</Text>
                      <Text style={{ 
                        color: (session.pnlUsd || 0) >= 0 ? '#52c41a' : '#ff4d4f',
                        fontWeight: 'bold',
                        fontSize: 12
                      }}>
                        ${(session.pnlUsd || 0).toFixed(2)}
                      </Text>
                    </div>
                    
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>Win Rate:</Text>
                      <Text style={{ fontSize: 12 }}>
                        {(session.winRate || 0).toFixed(1)}%
                      </Text>
                    </div>
                    
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>State:</Text>
                      <Tag color={session.state === 'ARMED' ? 'green' : session.state === 'MANAGE' ? 'blue' : 'default'}>
                        {session.state}
                      </Tag>
                    </div>
                  </Card>
                </Col>
              ))}
            </Row>
            
            {(ov?.sessions || []).length === 0 && (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
                <RobotOutlined style={{ fontSize: 48, marginBottom: 16 }} />
                <div>No active agents</div>
                <Button type="primary" style={{ marginTop: 16 }} onClick={() => navigate('/sessions')}>
                  Create Your First Agent
                </Button>
              </div>
            )}
          </Card>
        </Col>
        
        {/* Health & Alerts Panel */}
        <Col xs={24} lg={8}>
          <Card 
            title={
              <Space>
                <WarningOutlined style={{ color: globalHealth.color }} />
                System Health
              </Space>
            }
            style={{ marginBottom: 16 }}
          >
            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <Progress
                type="circle"
                percent={globalHealth.status === 'healthy' ? 100 : globalHealth.status === 'warning' ? 70 : globalHealth.status === 'critical' ? 30 : 0}
                strokeColor={globalHealth.color}
                format={() => globalHealth.icon}
                size={80}
              />
              <div style={{ marginTop: 8, fontSize: 16, fontWeight: 'bold', color: globalHealth.color }}>
                {globalHealth.status.toUpperCase()}
              </div>
            </div>
            
            <Space direction="vertical" style={{ width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Text>Critical Alerts:</Text>
                <Badge count={ov?.alerts?.severityCounts?.high || 0} style={{ backgroundColor: '#ff4d4f' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Text>Warning Alerts:</Text>
                <Badge count={ov?.alerts?.severityCounts?.med || 0} style={{ backgroundColor: '#faad14' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Text>Info Alerts:</Text>
                <Badge count={ov?.alerts?.severityCounts?.low || 0} style={{ backgroundColor: '#1890ff' }} />
              </div>
            </Space>
            
            {(ov?.alerts?.recent || []).length > 0 && (
              <>
                <Divider />
                <Text strong style={{ marginBottom: 8, display: 'block' }}>Recent Alerts:</Text>
                <List
                  size="small"
                  dataSource={(ov?.alerts?.recent || []).slice(0, 3)}
                  renderItem={(alert: any) => (
                    <List.Item style={{ padding: '4px 0' }}>
                      <Space size="small">
                        <Tag 
                          color={alert.severity === 'high' ? 'red' : alert.severity === 'med' ? 'orange' : 'blue'}
                        >
                          {alert.kind}
                        </Tag>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {alert.symbol}
                        </Text>
                      </Space>
                    </List.Item>
                  )}
                />
              </>
            )}
          </Card>
          
          {/* Budget & Balance */}
          <Card 
            title={
              <Space>
                <DollarOutlined style={{ color: '#1890ff' }} />
                {mode === 'live' ? 'Live Balance' : 'Paper Balance'}
              </Space>
            }
          >
            {mode === 'live' ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Statistic
                  title="Equity"
                  value={Number(ov?.exchangeBalance?.totalUsd || 0)}
                  precision={2}
                  prefix="$"
                  valueStyle={{ color: '#1890ff' }}
                />
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
              <Space direction="vertical" style={{ width: '100%' }}>
                <Statistic
                  title="Paper Equity"
                  value={Number(ov?.paperBalance?.equityUsd || 0)}
                  precision={2}
                  prefix="$"
                  valueStyle={{ color: '#52c41a' }}
                />
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
        </Col>
      </Row>

      {/* Operations Monitoring */}
      <Row gutter={[24, 24]} style={{ marginBottom: 24 }}>
        <Col xs={24}>
          <OpsMetricsPanel metrics={opsMetrics} loading={opsLoading} />
        </Col>
      </Row>

      <Row gutter={[24, 24]} style={{ marginBottom: 24 }}>
        <Col xs={24}>
          <AdaptiveWeightsPanel data={adaptiveData} loading={adaptiveLoading} onRefresh={loadOps} />
        </Col>
      </Row>

      {/* Footer Actions */}
      <Card style={{ textAlign: 'center' }}>
        <Space size="large">
          <Button type="primary" size="large" onClick={() => navigate('/sessions')}>
            <SettingOutlined /> Manage All Sessions
          </Button>
          <Button size="large" onClick={() => { 
            const firstSession = (ov?.sessions || [])[0]; 
            if (firstSession?.id) navigate(`/monitor/${firstSession.id}`); 
          }}>
            <EyeOutlined /> Monitor First Agent
          </Button>
        </Space>
      </Card>
    </div>
  );
}
