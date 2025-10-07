import React from 'react';
import { useParams, Navigate, useNavigate } from 'react-router-dom';
import { Row, Col, Space, Tag, Tabs, Card, Skeleton, Alert, Progress, Button, Typography, Tooltip, Select, message } from 'antd';
import { ReloadOutlined, ExpandOutlined, CompressOutlined, SyncOutlined, InfoCircleOutlined } from '@ant-design/icons';
import PriceChart from '../charts/PriceChart';
import LiveMetrics from '../components/LiveMetrics';
import StrategyPanel from '../components/StrategyPanel';
import AnalysisTabs from '../components/AnalysisTabs';
import AgentStatePanel from '../components/AgentStatePanel';
// Removed old PerfPanel/IndicatorsPanel row in favor of banners
import PerfBreakdownPanel from '../components/PerfBreakdownPanel';
import TriggersPanel from '../components/TriggersPanel';
import OrdersTable from '../components/OrdersTable';
import TradesTable from '../components/TradesTable';
import HelpPanel from '../components/HelpPanel';
import DailyReviewPanel from '../components/DailyReviewPanel';
import AlertPanel from '../components/AlertPanel';
import { api, getApiKey } from '../api';
import { openWS, wsSend } from '../ws';
import MonitorHealthBanner from '../components/MonitorHealthBanner';
import MonitorMiniPanels from '../components/MonitorMiniPanels';
import MarketTriggersCard from '../components/MarketTriggersCard';
import KeyMetricsCard from '../components/KeyMetricsCard';
import RangeProjectionCard from '../components/RangeProjectionCard';
import SRVisualizationCard from '../components/SRVisualizationCard';
import AIInsightsCard from '../components/AIInsightsCard';
import SmartAgentStatusPanel from '../components/SmartAgentStatusPanel';
import PerformanceBanner from '../components/PerformanceBanner';
import PositionBanner from '../components/PositionBanner';

const { Title, Text } = Typography;
// Memoized heavy components to avoid needless re-renders
// const MemoIndicatorsPanel = React.memo(IndicatorsPanel) as React.FC<any>;
// const MemoPerfPanel = React.memo(PerfPanel as any) as React.FC<any>;
const MemoOrdersTable = React.memo(OrdersTable as any) as React.FC<any>;
const MemoTradesTable = React.memo(TradesTable as any) as React.FC<any>;

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
  const [savingAgg, setSavingAgg] = React.useState(false);
  const [activeRightTab, setActiveRightTab] = React.useState<string>('agent');
  const rightTabsRef = React.useRef<HTMLDivElement|null>(null);

  // Core data states (Phase 1)
  const [symbol, setSymbol] = React.useState<string>("");
  const [status, setStatus] = React.useState<any>({});
  const [agent, setAgent] = React.useState<any>(null);
  const [ticker, setTicker] = React.useState<any>(null);
  const [tickerStatus, setTickerStatus] = React.useState<'loading'|'live'|'stale'|'error'>('loading');
  const [tickerError, setTickerError] = React.useState<string | null>(null);
  const lastTickerUpdateRef = React.useRef<number>(0);
  
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
  const currentAggressiveness = React.useMemo(() => {
    const runtime = (agent as any)?.profile?.aggressiveness;
    const persisted = (status?.session as any)?.profileJson?.aggressiveness;
    return (runtime || persisted || 'reactive') as 'conservative'|'reactive'|'aggressive';
  }, [agent, status]);

  const handleAggressivenessChange = async (val: 'conservative'|'reactive'|'aggressive') => {
    if (!status?.session?.id) return;
    try {
      setSavingAgg(true);
      await api.setAggressiveness(status.session.id, val);
      message.success(`Aggressiveness set to ${val}`);
    } catch (e) {
      console.error('Failed to set aggressiveness:', e);
      message.error('Failed to update aggressiveness');
    } finally {
      setSavingAgg(false);
    }
  };

  React.useEffect(() => {
    const interval = setInterval(() => {
      if (tickerStatus === 'live' && lastTickerUpdateRef.current) {
        const age = Date.now() - lastTickerUpdateRef.current;
        if (age > 15_000) {
          setTickerStatus('stale');
        }
      }
    }, 5_000);
    return () => clearInterval(interval);
  }, [tickerStatus]);

  // Scoreboard metrics (compact chips under hero)
  const metricPrice = Number(status?.price ?? analysis?.technical?.last ?? 0);
  const metricAtr = Number(analysis?.technical?.atrPct ?? status?.indicators?.atrPct ?? 0);
  const metricRsi = Number(analysis?.technical?.rsi14 ?? status?.indicators?.rsi14 ?? 0);
  const metricAdx = Number(analysis?.technical?.adx14 ?? status?.indicators?.adx14 ?? 0);
  const metricVol = Number(analysis?.technical?.volume24h ?? ticker?.quoteVolume ?? ticker?.baseVolume ?? 0);
  const spreadPct = React.useMemo(()=>{
    const bid = Number((ticker as any)?.bid ?? 0);
    const ask = Number((ticker as any)?.ask ?? 0);
    if (!bid || !ask) return 0;
    const mid = (bid + ask) / 2;
    return mid ? ((ask - bid) / mid) * 100 : 0;
  }, [ticker]);

  const openMarketTab = () => {
    setActiveRightTab('market');
    try { rightTabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch {}
  };

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
  const loadTicker = async (sym: string, opts: { silent?: boolean } = {}) => {
    if (!sym) return;
    if (!opts.silent) {
      setTickerStatus(prev => (prev === 'live' ? prev : 'loading'));
    }
    try {
      const tickerData = await api.getTicker(sym);
      setTicker(tickerData);
      setTickerError(null);
      setTickerStatus('live');
      lastTickerUpdateRef.current = Date.now();
      // Quick warm-up retry: if placeholder (last=0 and volumes=0), retry shortly
      const last = Number((tickerData as any)?.last || 0);
      const baseVol = Number((tickerData as any)?.baseVolume || 0);
      const quoteVol = Number((tickerData as any)?.quoteVolume || 0);
      if (last === 0 || (baseVol === 0 && quoteVol === 0)) {
        setTimeout(async () => {
          try { await loadTicker(sym, { silent: true }); } catch {}
        }, 1500);
      }
    } catch (err: any) {
      console.error('Failed to load ticker:', err);
      const detail = err?.response?.data?.details || err?.response?.data?.error || err?.message || String(err);
      setTickerError(detail);
      setTickerStatus('error');
    }
  };

  // Progressive loading system with timeout
  React.useEffect(() => {
    if (!sessionId) return;
    
    const loadData = async () => {
      // ✅ FIX: Augmenter timeout à 20 secondes pour données complètes
      const loadingTimeout = setTimeout(() => {
        updateProgress(LoadingPhase.COMPLETE, 100, 'Load timeout - continuing with available data', 'Loading timeout after 20 seconds');
      }, 20000);
      
      try {
        // Phase 1: Core data (session, symbol, basic status)
        updateProgress(LoadingPhase.CORE_DATA, 10, 'Loading session data...');
        
        const s = await Promise.race([
          api.status(sessionId, { includeBalance: false, includeTech: false }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Status timeout')), 15000)) // augmenté à 15s
        ]);
        
        if (!s?.session?.id) {
          navigate('/sessions');
          return;
        }
        
        setStatus(s);
        const sym = s?.session?.symbol || s?.symbol || symbol;
        if (sym) setSymbol(sym);
        
        updateProgress(LoadingPhase.CORE_DATA, 30, 'Loading agent state & diagnostics...');
        
        // ✅ FIX: Load core data + diagnostics (CRITIQUE) in parallel with timeout
        const [agentData, tickerData, diagnosticsData] = await Promise.allSettled([
          Promise.race([
            api.getAgentState(s.session.id),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Agent timeout')), 15000))
          ]),
          sym ? Promise.race([
            api.getTicker(sym),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Ticker timeout')), 15000))
          ]) : Promise.resolve(null),
          // ✅ NOUVEAU: Diagnostics en Phase 1 car CRITIQUE pour comprendre pourquoi agent ne trade pas
          Promise.race([
            api.getDiagnostics(s.session.id),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Diagnostics timeout')), 15000))
          ])
        ]);
        
        if (agentData.status === 'fulfilled') setAgent(agentData.value);
        if (tickerData.status === 'fulfilled' && tickerData.value) {
          setTicker(tickerData.value);
          setTickerStatus('live');
          setTickerError(null);
          lastTickerUpdateRef.current = Date.now();
        } else if (tickerData.status === 'rejected') {
          const detail = (tickerData.reason as any)?.response?.data?.details || (tickerData.reason as any)?.message || String(tickerData.reason);
          setTickerError(detail);
          setTickerStatus('error');
        }
        if (diagnosticsData.status === 'fulfilled' && diagnosticsData.value) {
          // Stocker diagnostics dans un state pour les utiliser dans AgentStatePanel
          setAgent((prev: any) => ({ ...prev, diagnostics: diagnosticsData.value }));
        }
        
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
    setTickerStatus(prev => prev === 'live' ? prev : 'loading');
    loadTicker(symbol);
    const tickerTimer = setInterval(() => { loadTicker(symbol, { silent: true }); }, 30000); // 30s refresh
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
        // ✅ FIX: Refresh diagnostics automatiquement quand agent state change
        try { 
          const diag = await api.getDiagnostics(sessionId);
          setAgent((prev: any) => ({ ...prev, diagnostics: diag }));
        } catch {}
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
                <Tag color={status?.session?.mode === 'live' ? 'gold' : 'blue'} style={{ borderRadius: 8, padding: '0 8px', fontWeight: 600 }}>
                  {(status?.session?.mode || 'paper').toUpperCase()}
                </Tag>
                <Tag color={wsConnected ? 'green' : 'red'} style={{ borderRadius: 8, padding: '0 8px', fontWeight: 600 }}>
                  {wsConnected ? 'LIVE' : 'DISCONNECTED'}
                </Tag>
                {agent?.state && (
                  <Tag color={agent.state === 'ARMED' ? 'green' : agent.state === 'MANAGE' ? 'blue' : 'default'} style={{ borderRadius: 8, padding: '0 8px', fontWeight: 600 }}>
                    {agent.state}
                  </Tag>
                )}
              </Space>
            </Space>
          </Col>
          <Col>
            <Space>
              <Select
                size="middle"
                value={currentAggressiveness}
                loading={savingAgg}
                onChange={(v)=> handleAggressivenessChange(v as any)}
                style={{ minWidth: 160 }}
                options={[
                  { value: 'conservative', label: 'Conservative' },
                  { value: 'reactive', label: 'Reactive' },
                  { value: 'aggressive', label: 'Aggressive' },
                ]}
              />
              {/* Moved actions here: Propose Plan + Rescan Smart Agent */}
              {status?.session?.id && (
                <>
                  <Button 
                    onClick={async()=>{
                      try {
                        await api.proposePlan(status?.symbol, { sessionId: status?.session?.id, fresh: true });
                        message.success('Plan proposed (LLM)');
                      } catch(e){ message.error('Failed to propose plan'); }
                    }}
                  >
                    Propose Plan (LLM)
                  </Button>
                  <Button 
                    onClick={async()=>{
                      try {
                        await api.client.post('/api/agent/reselect', { sessionId: status?.session?.id });
                        message.success('Smart Agent reselection requested');
                      } catch(e){ message.error('Reselect failed'); }
                    }}
                  >
                    Rescan Smart Agent
                  </Button>
                </>
              )}
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

      {/* Performance Banner */}
      {shouldShowContent(LoadingPhase.SECONDARY_DATA) && (
        <div style={{ marginTop: -8, marginBottom: 16 }}>
          <PerformanceBanner kpi={kpi} session={status?.session} />
        </div>
      )}

      {/* Compact Scoreboard */}
      <Row style={{ marginTop: -16, marginBottom: 16 }}>
        <Col xs={24}>
          <Space wrap size={[8,8]}>
            <Button size="small" onClick={openMarketTab}>Price: ${metricPrice ? metricPrice.toFixed(metricPrice >= 1 ? 4 : 6) : '—'}</Button>
            <Button size="small" onClick={openMarketTab}>ATR%: {metricAtr ? metricAtr.toFixed(2) : '—'}</Button>
            <Button size="small" onClick={openMarketTab}>RSI: {metricRsi ? metricRsi.toFixed(1) : '—'}</Button>
            <Button size="small" onClick={openMarketTab}>ADX: {metricAdx ? metricAdx.toFixed(1) : '—'}</Button>
            <Button size="small" onClick={openMarketTab}>Vol 24h: {metricVol ? (metricVol/1_000_000).toFixed(2)+'M' : '—'}</Button>
            <Button size="small" onClick={openMarketTab}>Spread: {spreadPct ? spreadPct.toFixed(2)+'%' : '—'}</Button>
          </Space>
        </Col>
      </Row>
      
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
                lastUpdate={ticker?.lastUpdate || (ticker?.timestamp ? new Date(ticker.timestamp).toISOString() : undefined)}
                status={tickerStatus}
                errorMessage={tickerError || undefined}
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
            
            {/* Position banner — only if position exists OR there is historical activity */}
            {shouldShowContent(LoadingPhase.CORE_DATA) && ((agent?.pos) || (orders?.length || 0) > 0 || (trades?.length || 0) > 0) && (
              <PositionBanner agent={agent} price={status?.price} orders={orders} trades={trades} />
            )}
            
            {/* Orders/Trades Full Width Tabs */}
            <Card size="small" style={{ marginTop: 8 }}>
              {shouldShowContent(LoadingPhase.SECONDARY_DATA) ? (
                <Tabs
                  defaultActiveKey="orders"
                  items={[
                    {
                      key: 'orders',
                      label: `Orders (${orders.length})`,
                      children: (
                        <div style={{ marginTop: 8 }}>
                          <MemoOrdersTable rows={orders} />
                        </div>
                      )
                    },
                    {
                      key: 'trades',
                      label: `Trades (${trades.length})`,
                      children: (
                        <div style={{ marginTop: 8 }}>
                          <MemoTradesTable rows={trades} />
                        </div>
                      )
                    }
                  ]}
                />
              ) : (
                <Skeleton active paragraph={{ rows: 6 }} />
              )}
            </Card>
          </Space>
        </Col>
        
        <Col xs={24} lg={8}>
          <div style={{ position: 'sticky', top: 76, alignSelf: 'flex-start' }}>
            <Card bodyStyle={{ padding: 4 }} style={{ borderRadius: 12 }} ref={rightTabsRef}>
              <Tabs
                activeKey={activeRightTab}
                onChange={key=> setActiveRightTab(key)}
                items={[
                  {
                    key: 'agent',
                    label: 'Agent',
                    children: (
                      <Space direction="vertical" style={{ width: '100%', padding: 12 }} size="middle">
                        {shouldShowContent(LoadingPhase.CORE_DATA) && status?.session?.id ? (
                          <SmartAgentStatusPanel sessionId={status.session.id} />
                        ) : (
                          <Card title="Smart Agent"><Skeleton active paragraph={{ rows: 3 }} /></Card>
                        )}
                        {shouldShowContent(LoadingPhase.CORE_DATA) && agent ? (
                          <AgentStatePanel 
                            agent={agent} 
                            symbol={status?.symbol} 
                            lastPrice={status?.price} 
                            sessionId={status?.session?.id} 
                            onPlan={() => {}} 
                          />
                        ) : (
                          <Card title="Agent State"><Skeleton active paragraph={{ rows: 4 }} /></Card>
                        )}
                      </Space>
                    )
                  },
                  {
                    key: 'market',
                    label: 'Market',
                    children: (
                      <Space direction="vertical" style={{ width: '100%', padding: 12 }} size="middle">
                        {shouldShowContent(LoadingPhase.SECONDARY_DATA) ? (
                          <MarketTriggersCard 
                            triggers={triggers.map(t => ({
                              id: t.id || String(Math.random()),
                              name: t.name || 'Unknown Trigger',
                              description: t.description || 'No description available',
                              active: Boolean(t.active),
                              strength: t.strength || 'weak',
                              confidence: t.confidence || 50,
                              timeframe: t.timeframe,
                              value: t.value,
                              threshold: t.threshold
                            }))}
                          />
                        ) : (
                          <Card title="Market Triggers"><Skeleton active paragraph={{ rows: 3 }} /></Card>
                        )}
                        {shouldShowContent(LoadingPhase.SECONDARY_DATA) ? (
                          <KeyMetricsCard 
                            indicators={{
                              atrPct: Number(analysis?.technical?.atrPct || status?.indicators?.atrPct || 0),
                              adx: Number(analysis?.technical?.adx14 || status?.indicators?.adx14 || 0),
                              rsi: Number(analysis?.technical?.rsi14 || status?.indicators?.rsi14 || 50),
                              ema20: Number(analysis?.technical?.ema20 || status?.indicators?.ema20 || 0),
                              ema50: Number(analysis?.technical?.ema50 || status?.indicators?.ema50 || 0),
                              ema20Slope: Number(analysis?.technical?.ema20Slope || 0),
                              volume: Number(analysis?.technical?.volume24h || 0),
                              price: Number(analysis?.technical?.last || status?.price || 0)
                            }}
                          />
                        ) : (
                          <Card title="Key Metrics"><Skeleton active paragraph={{ rows: 3 }} /></Card>
                        )}
                      </Space>
                    )
                  },
                  {
                    key: 'projections',
                    label: 'Projections',
                    children: (
                      <div style={{ padding: 12 }}>
                        {shouldShowContent(LoadingPhase.SECONDARY_DATA) ? (
                          <RangeProjectionCard
                            projection={analysis?.projection}
                            symbol={status?.symbol}
                            price={Number(status?.price ?? analysis?.technical?.last ?? 0)}
                          />
                        ) : (
                          <Card title="24h Range Forecast"><Skeleton active paragraph={{ rows: 4 }} /></Card>
                        )}
                      </div>
                    )
                  },
                  {
                    key: 'levels',
                    label: 'S/R Levels',
                    children: (
                      <div style={{ padding: 12 }}>
                        {shouldShowContent(LoadingPhase.SECONDARY_DATA) ? (
                          <SRVisualizationCard 
                            currentPrice={Number(status?.price || 0)}
                            support={status?.sr?.support ? { price: status.sr.support, strength: 75, touches: 3 } : undefined}
                            resistance={status?.sr?.resistance ? { price: status.sr.resistance, strength: 80, touches: 2 } : undefined}
                            pivots={status?.pivots}
                            symbol={status?.symbol}
                          />
                        ) : (
                          <Card title="Support/Resistance"><Skeleton active paragraph={{ rows: 3 }} /></Card>
                        )}
                      </div>
                    )
                  }
                ]}
              />
            </Card>
          </div>
        </Col>
      </Row>

      {/* Expandable Advanced Sections */}
      {expandedView && (
        <>
          {/* AI Insights Section */}
          <Row gutter={[24, 24]} style={{ marginTop: 24 }}>
            <Col xs={24} lg={16}>
              {loadingState.phase === LoadingPhase.COMPLETE ? (
                <AIInsightsCard 
                  sentiment={analysis?.sentiment ? {
                    score: analysis.sentiment.score || 0,
                    label: analysis.sentiment.label || 'neutral',
                    confidence: analysis.sentiment.confidence || 50,
                    factors: analysis.sentiment.factors || []
                  } : undefined}
                  news={analysis?.news || []}
                  dailyReview={analysis?.dailyReview}
                />
              ) : (
                <Card title="AI Insights">
                  <Skeleton active paragraph={{ rows: 6 }} />
                </Card>
              )}
            </Col>
            
            <Col xs={24} lg={8}>
              {loadingState.phase === LoadingPhase.COMPLETE ? (
                <StrategyPanel strategy={strategy} />
              ) : (
                <Card title="Strategy Details">
                  <Skeleton active paragraph={{ rows: 6 }} />
                </Card>
              )}
            </Col>
          </Row>
          
          <Row gutter={[24, 24]} style={{ marginTop: 24 }}>
            <Col xs={24}>
              {loadingState.phase === LoadingPhase.COMPLETE ? (
                <AnalysisTabs analysis={analysis} />
              ) : (
                <Card title="Technical Analysis">
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
