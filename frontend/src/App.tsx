import React from 'react';
import { Layout, Typography, Space, message, Row, Col, Tag, Menu } from 'antd';
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { api, getApiKey, clearApiKey } from './api';
import { openWS, wsSend } from './ws';
import PriceChart from './charts/PriceChart';
import StrategyPanel from './components/StrategyPanel';
import AgentStatePanel from './components/AgentStatePanel';
import IndicatorsPanel from './components/IndicatorsPanel';
import AgentControls from './components/AgentControls';
import OrdersTable from './components/OrdersTable';
import PerfPanel from './components/PerfPanel';
import TriggersPanel from './components/TriggersPanel';
import AnalysisTabs from './components/AnalysisTabs';
import SimulatorPanel from './components/SimulatorPanel';
import HelpPanel from './components/HelpPanel';
import LoginPage from './pages/LoginPage';
import SessionsPage from './pages/SessionsPage';
import DashboardPage from './pages/DashboardPage';
import TestingPage from './pages/TestingPage';

  const { Header, Content, Footer } = Layout; const { Title } = Typography;

function AppInner(){
  const [symbol, setSymbol] = React.useState('BTC/USDT');
  const [status, setStatus] = React.useState<any>({ symbol });
  const [strategy, setStrategy] = React.useState<any>(null);
  const [orders, setOrders] = React.useState<any[]>([]);
  const [kpi, setKpi] = React.useState<any>(null);
  const [triggers, setTriggers] = React.useState<any[]>([]);
  const [analysis, setAnalysis] = React.useState<any>(null);
  const [agent, setAgent] = React.useState<any>(null);
  const [loadingMonitor, setLoadingMonitor] = React.useState<boolean>(false);
  const wsRef = React.useRef<WebSocket|null>(null);
  const [wsConnected, setWsConnected] = React.useState<boolean>(false);
  const navigate = useNavigate();

  const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

  React.useEffect(()=> {
    // Require login (API key) before bootstrapping app
    if (!getApiKey()) { navigate('/login', { replace: true }); return; }
    const ws = openWS(API_BASE, getApiKey(), symbol, async (msg) => {
      if (msg.type === 'hello_ok') return;
      if (msg.type === 'sub_ok') { try { wsSend(ws, { type: 'fetch_now' }); } catch {} return; }
      if (msg.type === 'tick') {
        setStatus((s:any)=>({ ...s, symbol: msg.data.symbol, price: msg.data.price, sr: { support: msg.data.support, resistance: msg.data.resistance }, pivots: msg.data.pivots }));
      }
      if (msg.type === 'strategy') setStrategy(msg.data);
      if (msg.type === 'analysis') setAnalysis(msg.data);
      if (msg.type === 'agent_state') {
        setAgent((prev:any)=> ({ ...prev, ...msg.data }));
        // Refresh balance snapshot
        try { setAgent(await api.getAgentState()); } catch {}
        // If exit happened, refresh KPI
        if (msg?.data?.exit) {
          try { const s = await api.getSession(); if (s?.id) setKpi(await api.getPerf(s.id)); } catch {}
        }
      }
      if (msg.type === 'session') {
        setStatus((s:any)=>({ ...s, session: msg.data, symbol: msg.data.symbol || s.symbol }));
        const sym = msg.data?.symbol || symbol;
        if (msg.data?.symbol) setSymbol(msg.data.symbol);
        try { setStrategy(await api.strategyToday(sym)); } catch {}
        try { setAnalysis(await api.analysis(sym)); } catch {}
        try { setKpi(await api.getPerf(msg.data.id)); } catch {}
        try { setOrders(await api.getOrders(msg.data.id)); } catch {}
      }
      if (msg.type === 'orders') {
        setOrders(msg.data);
        // Refresh balance after order book change
        try { setAgent(await api.getAgentState()); } catch {}
      }
      if (msg.type === 'trigger') setTriggers((prev:any[])=> [msg.data, ...prev].slice(0,100));
    }, (ok)=> setWsConnected(ok), (next)=> { wsRef.current = next; });
    wsRef.current = ws;

    // Bootstrap via REST for tables, perf and analysis
    (async ()=>{
      try {
        setLoadingMonitor(true);
        const s = await api.status(); setStatus((prev:any)=>({ ...prev, ...s }));
        const sym = s?.session?.symbol || s?.symbol || symbol;
        if (s?.session?.symbol) setSymbol(s.session.symbol);
        navigate(s?.session ? '/monitor' : '/dashboard', { replace: true });
        if (s.session?.id) setOrders(await api.getOrders(s.session.id)); else setOrders([]);
        if (s.session?.id) setKpi(await api.getPerf(s.session.id));
        setTriggers(await api.getTriggers());
        try { setAgent(await api.getAgentState()); } catch {}
        try { setAnalysis(await api.analysis(sym)); } catch {}
        try { setStrategy(await api.strategyToday(sym)); } catch {}
      } catch {}
      finally { setLoadingMonitor(false); }
    })();

    return ()=> { ws.close(); wsRef.current = null; };
  }, []);

  // Re-subscribe WS when symbol changes or once session available
  React.useEffect(()=>{
    if (wsRef.current && symbol) {
      wsSend(wsRef.current, { type: 'sub', symbol });
      // Bootstrap symbol-specific data
      (async ()=>{
        try { setStrategy(await api.strategyToday(symbol)); } catch {}
        try { setAnalysis(await api.analysis(symbol)); } catch {}
      })();
    }
  }, [symbol]);


  const hasSession = !!status?.session;

  const authed = !!getApiKey();
  if (!authed) {
    return (
      <Routes>
        <Route path='/login' element={<LoginPage />} />
        <Route path='*' element={<Navigate to='/login' replace />} />
      </Routes>
    );
  }

  const location = useLocation();
  const menuItems = [
    { key: '/dashboard', label: 'Dashboard' },
    { key: '/sessions', label: 'Sessions' },
    { key: '/testing', label: 'Testing' },
  ];

  return (
    <Layout style={{ minHeight:'100vh' }}>
      <Layout.Sider breakpoint='lg' collapsedWidth={60} theme='dark'>
        <div style={{ color:'#fff', padding:12, fontWeight:600 }}>Agent</div>
        <Menu theme='dark' mode='inline' selectedKeys={[location.pathname]} items={menuItems}
          onClick={({ key })=> navigate(String(key))} />
      </Layout.Sider>
      <Layout>
        <Header style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <Space style={{ color: 'white' }}>
            {analysis?.ticker && (
              <>
                <span style={{ color:'#ddd' }}>{status?.symbol}</span>
                <Tag color={(analysis?.ticker?.percentage ?? 0) >= 0 ? 'green' : 'red'}>24h {(analysis?.ticker?.percentage ?? 0).toFixed(2)}%</Tag>
                {((agent?.plan?.bias) || (strategy?.bias)) && (
                  <Tag color={(agent?.plan?.bias || strategy?.bias)==='long' ? 'green' : ((agent?.plan?.bias || strategy?.bias)==='short' ? 'red' : 'default')}>
                    {(agent?.plan?.bias || strategy?.bias || '').toUpperCase()}
                  </Tag>
                )}
              </>
            )}
          </Space>
          <Space style={{ color: 'white' }}>
            <Tag color={wsConnected ? 'green' : 'red'}>{wsConnected ? 'WS:ON' : 'WS:OFF'}</Tag>
            {agent?.profile?.mode && (
              <Tag color={agent.profile.mode==='live' ? 'gold' : 'blue'}>{agent.profile.mode.toUpperCase()}</Tag>
            )}
            <span style={{ color:'#ccc' }}>Free USD:</span>
            <Tag color='cyan'>{Number(agent?.balance?.freeUsd ?? status?.balance?.free?.USDT ?? 0).toFixed(2)}</Tag>
            {kpi && (
              <>
                <span style={{ color:'#ccc' }}>ROI:</span>
                <Tag color={(Number(kpi?.roiPct||0) >= 0) ? 'green' : 'red'}>{Number(kpi?.roiPct||0).toFixed(2)}%</Tag>
              </>
            )}
            {/* Navigation via left menu */}
            <a onClick={()=> wsRef.current && wsSend(wsRef.current, { type:'fetch_now' })} style={{ color:'#ddd', textDecoration:'underline' }}>Refresh now</a>
            <a onClick={()=> { clearApiKey(); navigate('/login'); }} style={{ color:'#ddd', textDecoration:'underline' }}>Logout</a>
          </Space>
        </Header>
        <Content style={{ padding: 12 , overflow:'auto', background:'#fff' }}>
          <Routes>
            <Route path='/' element={<Navigate to='/dashboard' replace />} />
            <Route path='/dashboard' element={<DashboardPage />} />
            {/* Start route removed; starting is done from Sessions modal */}
            <Route path='/monitor' element={hasSession ? (
              <>
              {loadingMonitor && (<div style={{ position:'fixed', inset:0, background:'rgba(255,255,255,0.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
                <div style={{ padding:12, background:'#fff', border:'1px solid #eee', borderRadius:8 }}>Loading monitor…</div>
              </div>)}
              <Row gutter={[12,12]}>
                <Col xs={24} lg={16}>
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
                </Col>
                <Col xs={24} lg={8}><StrategyPanel strategy={strategy} /></Col>
                <Col xs={24}><AnalysisTabs analysis={analysis} /></Col>
                <Col xs={24} lg={8}><AgentControls session={status?.session} symbol={status?.symbol} showStart={false} onChange={async ()=>{
                const s = await api.status(); setStatus((prev:any)=>({ ...prev, ...s })); if (!s?.session) navigate('/sessions'); else { if (s.session.symbol) setSymbol(s.session.symbol); }
                }} /></Col>
                <Col xs={24} lg={8}><AgentStatePanel agent={agent} symbol={status?.symbol} lastPrice={status?.price} onPlan={()=>{}} /></Col>
                <Col xs={24} lg={8}><IndicatorsPanel indicators={analysis?.indicators || status?.indicators} /></Col>
                <Col xs={24} lg={8}><PerfPanel kpi={kpi} session={status?.session} /></Col>
                <Col xs={24}><TriggersPanel rows={triggers} /></Col>
                <Col xs={24}><OrdersTable rows={orders} /></Col>
                <Col xs={24}><HelpPanel /></Col>
              </Row>
              </>
            ) : <Navigate to='/sessions' replace /> } />
            <Route path='/sessions' element={<SessionsPage />} />
            <Route path='/testing' element={<TestingPage />} />
            <Route path='*' element={<Navigate to='/dashboard' replace />} />
          </Routes>
        </Content>
        <Footer style={{ textAlign:'center' }}>Realtime WS • Continuous strategy • Multiple analyses • SL/TP overlays</Footer>
      </Layout>
    </Layout>
  );
}

export default function App(){
  return (
    <BrowserRouter>
      <AppInner />
    </BrowserRouter>
  );
}
