import React from 'react';
import { useParams, Navigate, useNavigate } from 'react-router-dom';
import { Row, Col, Space, Tag, Tabs, Card, Skeleton, Alert, Progress, Button, Typography, Tooltip } from 'antd';
import { ReloadOutlined, ExpandOutlined, CompressOutlined, SyncOutlined, InfoCircleOutlined } from '@ant-design/icons';
import PriceChart from '../charts/PriceChart';
import LiveMetrics from '../components/LiveMetrics';
import StrategyPanel from '../components/StrategyPanel';
import AnalysisTabs from '../components/AnalysisTabs';
import AgentStatePanel from '../components/AgentStatePanel';
import IndicatorsPanel from '../components/IndicatorsPanel';
import PerfPanel from '../components/PerfPanel';
import PerfBreakdownPanel from '../components/PerfBreakdownPanel';
import TriggersPanel from '../components/TriggersPanel';
import OrdersTable from '../components/OrdersTable';
import TradesTable from '../components/TradesTable';
import HelpPanel from '../components/HelpPanel';
import DailyReviewPanel from '../components/DailyReviewPanel';
import AlertPanel from '../components/AlertPanel';
import { api, getApiKey } from '../api';
import { openWS, wsSend } from '../ws';
import PositionStatsBlock from '../components/PositionStatsBlock';
import MonitorHealthBanner from '../components/MonitorHealthBanner';
import MonitorMiniPanels from '../components/MonitorMiniPanels';

const { Title, Text } = Typography;

// Loading phases for progressive loading
enum LoadingPhase {
  INITIALIZING = 'initializing',
  CORE_DATA = 'core_data', 
  SECONDARY_DATA = 'secondary_data',
  COMPLETE = 'complete'
}

type LoadingState = {
  phase: LoadingPhase;
  progress: number;
  message: string;
  errors: string[];
};

export default function MonitorPage(){
  const { sessionId } = useParams();
  const navigate = useNavigate();

  // Loading state management
  const [loadingState, setLoadingState] = React.useState<LoadingState>({
    phase: LoadingPhase.INITIALIZING,
    progress: 0,
    message: 'Initializing monitor...',
    errors: []
  });
  
  const [wsConnected, setWsConnected] = React.useState(false);
  const [expandedView, setExpandedView] = React.useState(false);
  const wsRef = React.useRef<WebSocket|null>(null);

  // Core data states (Phase 1)
  const [symbol, setSymbol] = React.useState<string>("");
  const [status, setStatus] = React.useState<any>({});
  const [agent, setAgent] = React.useState<any>(null);
  const [ticker, setTicker] = React.useState<any>(null);
  
  // Secondary data states (Phase 2)
  const [strategy, setStrategy] = React.useState<any>(null);
  const [analysis, setAnalysis] = React.useState<any>(null);
  const [kpi, setKpi] = React.useState<any>(null);
  const [orders, setOrders] = React.useState<any[]>([]);
  const [trades, setTrades] = React.useState<any[]>([]);
  
  // Tertiary data states (Phase 3)
  const [triggers, setTriggers] = React.useState<any[]>([]);
  const [alerts, setAlerts] = React.useState<any[]>([]);
  const [analytics, setAnalytics] = React.useState<any>(null);
  const [health, setHealth] = React.useState<any>(null);

  const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

  // Update loading progress
  const updateProgress = (phase: LoadingPhase, progress: number, message: string, error?: string) => {
    setLoadingState(prev => ({
      phase,
      progress,
      message,
      errors: error ? [...prev.errors, error] : prev.errors
    }));
  };

  // Load ticker data for the symbol
  const loadTicker = async (sym: string) => {
    if (!sym) return;
    try {
      const tickerData = await api.getTicker(sym);
      setTicker(tickerData);
    } catch (err) {
      console.error('Failed to load ticker:', err);
    }
  };

  // Progressive loading system with timeout
  React.useEffect(() => {
    if (!sessionId) return;
    
    const loadData = async () => {
      // Set a maximum loading timeout
      const loadingTimeout = setTimeout(() => {
        updateProgress(LoadingPhase.COMPLETE, 100, 'Load timeout - continuing with available data', 'Loading timeout after 8 seconds');
      }, 8000); // Reduced to 8 seconds from 15
      
      try {
        // Phase 1: Core data (session, symbol, basic status)
        updateProgress(LoadingPhase.CORE_DATA, 10, 'Loading session data...');
        
        const s = await Promise.race([
          api.status(sessionId),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Status timeout')), 5000))
        ]);
        
        if (!s?.session?.id) {
          navigate('/sessions');
          return;
        }
        
        setStatus(s);
        const sym = s?.session?.symbol || s?.symbol || symbol;
        if (sym) setSymbol(sym);
        
        updateProgress(LoadingPhase.CORE_DATA, 30, 'Loading agent state...');
        
        // Load core data in parallel with timeout
        const [agentData, tickerData] = await Promise.allSettled([
          Promise.race([
            api.getAgentState(s.session.id),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Agent timeout')), 3000))
          ]),
          sym ? Promise.race([
            api.getTicker(sym),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Ticker timeout')), 3000))
          ]) : Promise.resolve(null)
        ]);
        
        if (agentData.status === 'fulfilled') setAgent(agentData.value);
        if (tickerData.status === 'fulfilled' && tickerData.value) setTicker(tickerData.value);
        
        updateProgress(LoadingPhase.SECONDARY_DATA, 50, 'Loading trading data...');
        
        // Phase 2: Trading data (orders, trades, strategy, analysis)
        const [strategyData, analysisData, kpiData, ordersData, tradesData] = await Promise.allSettled([
          sym ? api.strategyToday(sym).catch(e => { console.warn('Strategy failed:', e); return null; }) : Promise.resolve(null),
          sym ? api.analysis(sym).catch(e => { console.warn('Analysis failed:', e); return null; }) : Promise.resolve(null),
          api.getPerf(s.session.id).catch(e => { console.warn('Perf failed:', e); return null; }),
          api.getOrders(s.session.id).catch(e => { console.warn('Orders failed:', e); return []; }),
          api.getTrades(s.session.id).catch(e => { console.warn('Trades failed:', e); return []; })
        ]);
        
        if (strategyData.status === 'fulfilled' && strategyData.value) setStrategy(strategyData.value);
        if (analysisData.status === 'fulfilled' && analysisData.value) setAnalysis(analysisData.value);
        if (kpiData.status === 'fulfilled') setKpi(kpiData.value);
        if (ordersData.status === 'fulfilled') setOrders(ordersData.value || []);
        if (tradesData.status === 'fulfilled') setTrades(tradesData.value || []);
        
        updateProgress(LoadingPhase.SECONDARY_DATA, 80, 'Loading monitoring data...');
        
        // Phase 3: Monitoring data (analytics, health, triggers) - non-critical
        const [analyticsData, healthData, triggersData] = await Promise.allSettled([
          api.getMonitorAnalytics(s.session.id).catch(e => { console.warn('Analytics failed:', e); return null; }),
          api.getHealth(s.session.id).catch(e => { console.warn('Health failed:', e); return null; }),
          api.getTriggers(s.session.id).catch(e => { console.warn('Triggers failed:', e); return []; })
        ]);
        
        if (analyticsData.status === 'fulfilled') setAnalytics(analyticsData.value);
        if (healthData.status === 'fulfilled') setHealth(healthData.value);
        if (triggersData.status === 'fulfilled') setTriggers(triggersData.value || []);
        
        clearTimeout(loadingTimeout);
        updateProgress(LoadingPhase.COMPLETE, 100, 'Monitor ready!');
        
        // Additional timeout to ensure skeleton disappears
        setTimeout(() => {
          updateProgress(LoadingPhase.COMPLETE, 100, 'Monitor ready!');
        }, 500);
        
      } catch (error) {
        clearTimeout(loadingTimeout);
        console.error('Loading error:', error);
        updateProgress(LoadingPhase.COMPLETE, 100, 'Load completed with errors', String(error));
      }
    };
    
    loadData();
  }, [sessionId]);

  const loadAnalytics = React.useCallback(async () => {
    if (!sessionId) return;
    try {
      setAnalytics(await api.getMonitorAnalytics(sessionId));
      setHealth(await api.getHealth(sessionId));
    } catch {}
  }, [sessionId]);

  React.useEffect(() => {
    if (!sessionId) return;
    loadAnalytics();
    const timer = setInterval(() => { loadAnalytics(); }, 20000);
    return () => { clearInterval(timer); };
  }, [sessionId, loadAnalytics]);

  // Periodic ticker refresh
  React.useEffect(() => {
    if (!symbol) return;
    loadTicker(symbol);
    const tickerTimer = setInterval(() => { loadTicker(symbol); }, 30000); // 30s refresh
    return () => { clearInterval(tickerTimer); };
  }, [symbol]);

  // WS subscription dedicated to this monitor
  React.useEffect(()=>{
    if (!sessionId || !symbol) return; // wait until symbol known to subscribe correctly
    const ws = openWS(API_BASE, getApiKey(), symbol, async (msg)=>{
      if (msg?.sessionId && msg.sessionId !== sessionId) return; // strict filter
      if (msg.type === 'hello_ok') return;
      if (msg.type === 'sub_ok') { try { wsSend(ws, { type:'fetch_now' }); } catch {} return; }
      if (msg.type === 'tick') {
        setStatus((s:any)=>({ ...s, symbol: msg.data.symbol, price: msg.data.price, sr: { support: msg.data.support, resistance: msg.data.resistance }, pivots: msg.data.pivots }));
      }
      if (msg.type === 'analysis') setAnalysis(msg.data);
      if (msg.type === 'strategy') setStrategy(msg.data);
      if (msg.type === 'agent_state') {
        setAgent((prev:any)=> ({ ...prev, ...msg.data }));
        // refresh balance snapshot
        try { setAgent(await api.getAgentState(sessionId)); } catch {}
        if (msg?.data?.exit) {
          try { setKpi(await api.getPerf(sessionId)); } catch {}
        }
        loadAnalytics();
      }
      if (msg.type === 'session') {
        setStatus((s:any)=> ({ ...s, session: msg.data, symbol: msg.data.symbol || s.symbol }));
        const sym = msg.data?.symbol || symbol;
        if (msg.data?.symbol) setSymbol(msg.data.symbol);
        try { wsSend(ws, { type:'sub', symbol: sym, sessionId }); } catch {}
        try { setStrategy(await api.strategyToday(sym)); } catch {}
        try { setAnalysis(await api.analysis(sym)); } catch {}
        try { setKpi(await api.getPerf(sessionId)); } catch {}
        try { setOrders(await api.getOrders(sessionId)); } catch {}
        loadAnalytics();
      }
      if (msg.type === 'orders') {
        setOrders(msg.data);
        try { if (sessionId) setTrades(await api.getTrades(sessionId)); } catch {}
        try { setAgent(await api.getAgentState(sessionId)); } catch {}
        loadAnalytics();
      }
      if (msg.type === 'trigger') setTriggers((prev:any[])=> [msg.data, ...prev].slice(0,100));
      if (msg.type === 'alert') {
        setAlerts((prev:any[])=> [msg.data, ...prev].slice(0,50));
        loadAnalytics();
      }
    }, (ok)=> setWsConnected(ok), (next)=> { wsRef.current = next; }, sessionId);
    wsRef.current = ws;
    return ()=> { try { wsRef.current?.close?.(); } catch {} };
  }, [API_BASE, sessionId, symbol, loadAnalytics]);

  if (!sessionId) return <Navigate to='/sessions' replace />;
  const hasSession = !!status?.session?.id;
  const isLoading = loadingState.phase !== LoadingPhase.COMPLETE;
  
  // Don't redirect while loading; only redirect if definitively no session
  if (!isLoading && !hasSession) return <Navigate to='/sessions' replace />;

  // Hide loading on user interaction
  React.useEffect(() => {
    if (!isLoading) return;
    
    const handleUserInteraction = () => {
      if (loadingState.progress > 50) { // Only if we're already past core loading
        setLoadingState(prev => ({ ...prev, phase: LoadingPhase.COMPLETE }));
      }
    };
    
    const events = ['click', 'keydown', 'scroll'];
    events.forEach(event => {
      document.addEventListener(event, handleUserInteraction, { once: true });
    });
    
    return () => {
      events.forEach(event => {
        document.removeEventListener(event, handleUserInteraction);
      });
    };
  }, [isLoading, loadingState.progress]);

  // Helper to check if we should show content vs skeleton
  const shouldShowContent = (requiredPhase: LoadingPhase) => {
    const phaseOrder = {
      [LoadingPhase.INITIALIZING]: 0,
      [LoadingPhase.CORE_DATA]: 1,
      [LoadingPhase.SECONDARY_DATA]: 2,
      [LoadingPhase.COMPLETE]: 3
    };
    
    const currentOrder = phaseOrder[loadingState.phase];
    const requiredOrder = phaseOrder[requiredPhase];
    
    return currentOrder >= requiredOrder;
  };

  // Modern Loading UI that respects sidebar on desktop, full screen on mobile
  const LoadingOverlay = () => {
    const [windowWidth, setWindowWidth] = React.useState(window.innerWidth);
    
    React.useEffect(() => {
      const handleResize = () => setWindowWidth(window.innerWidth);
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }, []);
    
    // On mobile (<768px), cover full screen. On desktop, leave space for sidebar.
    const isMobile = windowWidth < 768;
    const leftOffset = isMobile ? 0 : '200px';
    
    return (
      <div style={{ 
        position: 'fixed',
        top: 0,
        left: leftOffset,
        right: 0,
        bottom: 0,
        background: 'rgba(255,255,255,0.95)', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        zIndex: isMobile ? 1001 : 100, // Higher z-index on mobile to cover mobile menu
        backdropFilter: 'blur(4px)',
        pointerEvents: isLoading ? 'auto' : 'none'
      }}>
        <Card style={{ 
          minWidth: 350, 
          textAlign: 'center', 
          maxWidth: '90%',
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
          borderRadius: 12,
          border: '1px solid rgba(0,0,0,0.08)'
        }}>
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <div style={{
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #1890ff 0%, #36cfc9 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <span style={{ color: 'white', fontSize: 18 }}>📊</span>
              </div>
              <Title level={4} style={{ margin: 0 }}>Loading Trading Monitor</Title>
            </div>
            
            <Progress 
              percent={loadingState.progress} 
              strokeColor={{
                '0%': '#108ee9',
                '100%': '#87d068',
              }}
              trailColor="#f0f0f0"
              showInfo={true}
              strokeWidth={8}
            />
            
            <div style={{ color: '#666', fontSize: 14 }}>
              {loadingState.message}
            </div>
            
            {loadingState.errors.length > 0 && (
              <Alert
                type="warning" 
                message="Some data failed to load"
                description={`${loadingState.errors.length} errors occurred - continuing with available data`}
                showIcon
                style={{ textAlign: 'left' }}
                action={
                  <Button 
                    size="small" 
                    type="primary"
                    onClick={() => window.location.reload()}
                  >
                    Retry
                  </Button>
                }
              />
            )}
            
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Button 
                type="text" 
                onClick={() => {
                  setLoadingState(prev => ({ ...prev, phase: LoadingPhase.COMPLETE }));
                }}
              >
                Continue with available data
              </Button>
              <Button 
                type="default"
                onClick={() => navigate('/sessions')}
              >
                ← Back to Sessions
              </Button>
            </div>
          </Space>
        </Card>
      </div>
    );
  };

  return (
    <div style={{ position: 'relative', minHeight: '100vh' }}>
      {isLoading && <LoadingOverlay />}
      
      {/* Hero Section */}
      <Card style={{ 
        marginBottom: 24, 
        background: 'linear-gradient(135deg, #1890ff 0%, #36cfc9 100%)',
        color: 'white',
        border: 'none'
      }}>
        <Row justify="space-between" align="middle">
          <Col>
            <Space direction="vertical" size="small">
              <Title level={3} style={{ color: 'white', margin: 0 }}>
                {symbol || 'Trading Monitor'}
              </Title>
              <Space>
                <Tag color={status?.session?.mode === 'live' ? 'gold' : 'blue'}>
                  {(status?.session?.mode || 'paper').toUpperCase()}
                </Tag>
                <Tag color={wsConnected ? 'green' : 'red'}>
                  {wsConnected ? 'LIVE' : 'DISCONNECTED'}
                </Tag>
                {agent?.state && (
                  <Tag color={agent.state === 'ARMED' ? 'green' : agent.state === 'MANAGE' ? 'blue' : 'default'}>
                    {agent.state}
                  </Tag>
                )}
              </Space>
            </Space>
          </Col>
          <Col>
            <Space>
              <Button 
                type="primary" 
                style={{ background: 'rgba(255,255,255,0.2)', border: 'none' }}
                icon={<ReloadOutlined />}
                onClick={() => window.location.reload()}
              >
                Refresh
              </Button>
              <Button 
                type="primary"
                style={{ background: 'rgba(255,255,255,0.2)', border: 'none' }}
                icon={expandedView ? <CompressOutlined /> : <ExpandOutlined />}
                onClick={() => setExpandedView(!expandedView)}
              >
                {expandedView ? 'Compact' : 'Expand'}
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>
      
      {/* Health Banner */}
      <Row gutter={[24, 24]}>
        <Col xs={24}>
          {shouldShowContent(LoadingPhase.SECONDARY_DATA) && (analytics?.health || health) ? (
            <MonitorHealthBanner health={analytics?.health || health} updatedAt={analytics?.updatedAt || health?.ts} />
          ) : (
            <Skeleton.Button active style={{ width: '100%', height: 60 }} />
          )}
        </Col>
        
        <Col xs={24}>
          {shouldShowContent(LoadingPhase.SECONDARY_DATA) && analytics?.panels ? (
            <MonitorMiniPanels panels={analytics?.panels} />
          ) : (
            <Row gutter={16}>
              {[1,2,3,4].map(i => (
                <Col xs={6} key={i}>
                  <Skeleton.Button active style={{ width: '100%', height: 80 }} />
                </Col>
              ))}
            </Row>
          )}
        </Col>
      </Row>

      {/* Primary Section: Chart + Performance + Tables */}
      <Row gutter={[24, 24]} style={{ marginTop: 24 }}>
        <Col xs={24} lg={16}>
          <Space direction="vertical" style={{ width: '100%' }} size="large">
            {/* Live Metrics */}
            {shouldShowContent(LoadingPhase.CORE_DATA) ? (
              <LiveMetrics 
                symbol={status?.symbol} 
                price={status?.price} 
                ticker={ticker}
                lastUpdate={ticker?.lastUpdate}
              />
            ) : (
              <Skeleton active paragraph={{ rows: 2 }} />
            )}
            
            {/* Price Chart */}
            {shouldShowContent(LoadingPhase.CORE_DATA) ? (
              <PriceChart
                symbol={status?.symbol}
                price={status?.price}
                support={status?.sr?.support}
                resistance={status?.sr?.resistance}
                strategy={strategy}
                agentPlan={agent?.plan}
                agentPos={agent?.pos}
                pivots={status?.pivots}
                agentExit={agent?.exit}
              />
            ) : (
              <Card>
                <Skeleton active paragraph={{ rows: 8 }} />
              </Card>
            )}
            
            {/* Performance Metrics Row */}
            {shouldShowContent(LoadingPhase.CORE_DATA) && (
              <Row gutter={[16, 16]}>
                <Col xs={24} sm={8}>
                  {agent ? (
                    <PositionStatsBlock agent={agent} price={status?.price} />
                  ) : (
                    <Skeleton.Button active style={{ width: '100%', height: 120 }} />
                  )}
                </Col>
                <Col xs={24} sm={8}>
                  {shouldShowContent(LoadingPhase.SECONDARY_DATA) ? (
                    <PerfPanel kpi={kpi} session={status?.session} />
                  ) : (
                    <Card title="Performance">
                      <Skeleton active paragraph={{ rows: 4 }} />
                    </Card>
                  )}
                </Col>
                <Col xs={24} sm={8}>
                  {shouldShowContent(LoadingPhase.SECONDARY_DATA) ? (
                    <IndicatorsPanel indicators={analysis?.indicators || status?.indicators} />
                  ) : (
                    <Card title="Indicators">
                      <Skeleton active paragraph={{ rows: 4 }} />
                    </Card>
                  )}
                </Col>
              </Row>
            )}
            
            {/* Enhanced Orders & Trades Tables */}
            {shouldShowContent(LoadingPhase.SECONDARY_DATA) ? (
              <Row gutter={[16, 16]}>
                <Col xs={24} md={12}>
                  <Card 
                    title={`Orders (${orders.length})`}
                    size="small"
                    extra={
                      <Space>
                        <Button size="small" icon={<SyncOutlined />} onClick={() => window.location.reload()}>
                          Refresh
                        </Button>
                      </Space>
                    }
                  >
                    <OrdersTable rows={orders} />
                  </Card>
                </Col>
                <Col xs={24} md={12}>
                  <Card 
                    title={`Trades (${trades.length})`}
                    size="small"
                    extra={
                      <Space>
                        <Button size="small" icon={<SyncOutlined />} onClick={() => window.location.reload()}>
                          Refresh
                        </Button>
                      </Space>
                    }
                  >
                    <TradesTable rows={trades} />
                  </Card>
                </Col>
              </Row>
            ) : (
              <Row gutter={[16, 16]}>
                <Col xs={24} md={12}>
                  <Card title="Orders">
                    <Skeleton active paragraph={{ rows: 4 }} />
                  </Card>
                </Col>
                <Col xs={24} md={12}>
                  <Card title="Trades">
                    <Skeleton active paragraph={{ rows: 4 }} />
                  </Card>
                </Col>
              </Row>
            )}
          </Space>
        </Col>
        
        <Col xs={24} lg={8}>
          <Space direction="vertical" style={{ width: '100%' }} size="large">
            {/* Agent State */}
            {shouldShowContent(LoadingPhase.CORE_DATA) && agent ? (
              <AgentStatePanel 
                agent={agent} 
                symbol={status?.symbol} 
                lastPrice={status?.price} 
                sessionId={status?.session?.id} 
                onPlan={() => {}} 
              />
            ) : (
              <Card title="Agent State">
                <Skeleton active paragraph={{ rows: 4 }} />
              </Card>
            )}
            
            {/* Strategy Panel */}
            {shouldShowContent(LoadingPhase.SECONDARY_DATA) ? (
              <StrategyPanel strategy={strategy} />
            ) : (
              <Card title="Strategy">
                <Skeleton active paragraph={{ rows: 4 }} />
              </Card>
            )}
            
            {/* Momentum Gates Explanation */}
            {shouldShowContent(LoadingPhase.SECONDARY_DATA) && (
              <Card 
                title="Momentum Gates" 
                size="small"
                extra={
                  <Tooltip title="Technical filters that prevent trades in unfavorable conditions">
                    <InfoCircleOutlined style={{ color: '#2563eb' }} />
                  </Tooltip>
                }
              >
                <Space direction="vertical" size="small" style={{ width: '100%' }}>
                  <Text strong style={{ fontSize: 13, color: '#374151' }}>Entry Requirements:</Text>
                  <div style={{ padding: '8px 12px', background: '#f9fafb', borderRadius: 6, fontSize: 12 }}>
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      <div><span style={{ color: '#6b7280' }}>• ATR%:</span> <code style={{ background: '#f3f4f6', padding: '2px 4px', borderRadius: 4 }}>≥ 0.8%</code> <span style={{ color: '#6b7280' }}>(volatility)</span></div>
                      <div><span style={{ color: '#6b7280' }}>• EMA Slope:</span> <code style={{ background: '#f3f4f6', padding: '2px 4px', borderRadius: 4 }}>≥ 0.15%</code> <span style={{ color: '#6b7280' }}>(momentum)</span></div>
                      <div><span style={{ color: '#6b7280' }}>• Direction:</span> <span style={{ color: '#6b7280' }}>Aligned with bias</span></div>
                    </Space>
                  </div>
                  <Text strong style={{ fontSize: 13, color: '#374151' }}>Fail Conditions:</Text>
                  <div style={{ padding: '8px 12px', background: '#fef2f2', borderRadius: 6, fontSize: 12 }}>
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      <div>❌ <span style={{ color: '#6b7280' }}>Low volatility (ATR% &lt; 0.8%)</span></div>
                      <div>❌ <span style={{ color: '#6b7280' }}>Flat trend (Slope &lt; 0.15%)</span></div>
                      <div>❌ <span style={{ color: '#6b7280' }}>Wrong direction (against bias)</span></div>
                    </Space>
                  </div>
                  <Alert 
                    type="info" 
                    message="Override possible with strong ADX (≥24) + aligned slope"
                    showIcon
                  />
                </Space>
              </Card>
            )}
          </Space>
        </Col>
      </Row>

      {/* Expandable Advanced Sections */}
      {expandedView && (
        <>
          <Row gutter={[24, 24]} style={{ marginTop: 24 }}>
            <Col xs={24}>
              {loadingState.phase === LoadingPhase.COMPLETE ? (
                <AnalysisTabs analysis={analysis} />
              ) : (
                <Card title="Market Analysis">
                  <Skeleton active paragraph={{ rows: 6 }} />
                </Card>
              )}
            </Col>
          </Row>
          
          <Row gutter={[24, 24]} style={{ marginTop: 24 }}>
            <Col xs={24} lg={16}>
              {loadingState.phase === LoadingPhase.COMPLETE ? (
                <PerfBreakdownPanel sessionId={status?.session?.id} api={api} />
              ) : (
                <Card title="Performance Breakdown">
                  <Skeleton active paragraph={{ rows: 8 }} />
                </Card>
              )}
            </Col>
            
            <Col xs={24} lg={8}>
              {loadingState.phase === LoadingPhase.COMPLETE ? (
                <AlertPanel sessionId={status?.session?.id} />
              ) : (
                <Card title="Alerts">
                  <Skeleton active paragraph={{ rows: 6 }} />
                </Card>
              )}
            </Col>
          </Row>
          
          <Row gutter={[24, 24]} style={{ marginTop: 24 }}>
            <Col xs={24}>
              {loadingState.phase === LoadingPhase.COMPLETE ? (
                <TriggersPanel rows={triggers} />
              ) : (
                <Card title="Trading Triggers">
                  <Skeleton active paragraph={{ rows: 4 }} />
                </Card>
              )}
            </Col>
          </Row>
          
          <Row gutter={[24, 24]} style={{ marginTop: 24 }}>
            <Col xs={24} lg={12}>
              {loadingState.phase === LoadingPhase.COMPLETE ? (
                <DailyReviewPanel sessionId={status?.session?.id} />
              ) : (
                <Card title="Daily Review">
                  <Skeleton active paragraph={{ rows: 6 }} />
                </Card>
              )}
            </Col>
            
            <Col xs={24} lg={12}>
              <HelpPanel />
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}
