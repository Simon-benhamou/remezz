import React from 'react';
import { Layout, Typography, Space, message, Row, Col, Tag } from 'antd';
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
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
import ActivationPanel from './components/ActivationPanel';

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
  const wsRef = React.useRef<WebSocket|null>(null);
  const navigate = useNavigate();

  const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';
  const API_KEY = import.meta.env.VITE_APP_API_KEY || '';

  React.useEffect(()=> {
    const ws = openWS(API_BASE, API_KEY, symbol, async (msg) => {
      if (msg.type === 'hello_ok') return;
      if (msg.type === 'sub_ok') return;
      if (msg.type === 'tick') {
        setStatus((s:any)=>({ ...s, symbol: msg.data.symbol, price: msg.data.price, sr: { support: msg.data.support, resistance: msg.data.resistance }, pivots: msg.data.pivots }));
      }
      if (msg.type === 'strategy') setStrategy(msg.data);
      if (msg.type === 'analysis') setAnalysis(msg.data);
      if (msg.type === 'agent_state') setAgent((prev:any)=> ({ ...prev, ...msg.data }));
      if (msg.type === 'session') setStatus((s:any)=>({ ...s, session: msg.data, symbol: msg.data.symbol || s.symbol }));
      if (msg.type === 'orders') setOrders(msg.data);
      if (msg.type === 'trigger') setTriggers((prev:any[])=> [msg.data, ...prev].slice(0,100));
    });
    wsRef.current = ws;

    // Bootstrap via REST for tables, perf and analysis
    (async ()=>{
      try {
        const s = await api.status(); setStatus((prev:any)=>({ ...prev, ...s }));
        if (s?.session?.symbol) setSymbol(s.session.symbol);
        navigate(s?.session ? '/monitor' : '/start', { replace: true });
        setOrders(await api.getOrders());
        if (s.session?.id) setKpi(await api.getPerf(s.session.id));
        setTriggers(await api.getTriggers());
        try { setAgent(await api.getAgentState()); } catch {}
        try { setAnalysis(await api.analysis(s?.symbol || symbol)); } catch {}
      } catch {}
    })();

    return ()=> { ws.close(); wsRef.current = null; };
  }, []);

  // Re-subscribe WS when symbol changes or once session available
  React.useEffect(()=>{
    if (wsRef.current && symbol) {
      wsSend(wsRef.current, { type: 'sub', symbol });
    }
  }, [symbol]);


  const hasSession = !!status?.session;

  return (
    <Layout style={{ minHeight:'100vh' }}>
      <Header style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <Space style={{ color: 'white' }}>
          <Link to='/start' style={{ color:'white' }}>Start</Link>
          <Link to='/monitor' style={{ color:'white', pointerEvents: hasSession? 'auto':'none', opacity: hasSession? 1: 0.5 }}>Monitor</Link>
          <Link to='/test' style={{ color:'white' }}>Test</Link>
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
      </Header>
      <Content style={{ padding: 12 }}>
        <Routes>
          <Route path='/' element={<ActivationPanel defaultSymbol={symbol} onStarted={async ()=>{
            const s = await api.status(); setStatus((prev:any)=>({ ...prev, ...s })); if (s?.session?.symbol) { setSymbol(s.session.symbol); try { setAnalysis(await api.analysis(s.session.symbol)); } catch {} } navigate('/monitor');
          }} />} />
          <Route path='/start' element={<ActivationPanel defaultSymbol={symbol} onStarted={async ()=>{
            const s = await api.status(); setStatus((prev:any)=>({ ...prev, ...s })); if (s?.session?.symbol) { setSymbol(s.session.symbol); try { setAnalysis(await api.analysis(s.session.symbol)); } catch {} } navigate('/monitor');
          }} />} />
          <Route path='/monitor' element={hasSession ? (
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

              <Col xs={24} lg={8}><AgentControls session={status?.session} symbol={status?.symbol} onChange={async ()=>{
              const s = await api.status(); setStatus((prev:any)=>({ ...prev, ...s })); if (!s?.session) navigate('/start'); else { if (s.session.symbol) setSymbol(s.session.symbol); }
              }} /></Col>
              <Col xs={24} lg={8}><AgentStatePanel agent={agent} symbol={status?.symbol} lastPrice={status?.price} onPlan={()=>{}} /></Col>
              <Col xs={24} lg={8}><IndicatorsPanel indicators={analysis?.indicators || status?.indicators} /></Col>
              <Col xs={24} lg={8}><PerfPanel kpi={kpi} session={status?.session} /></Col>

              <Col xs={24}><TriggersPanel rows={triggers} /></Col>
              <Col xs={24}><OrdersTable rows={orders} /></Col>
          </Row>
          ) : <ActivationPanel defaultSymbol={symbol} onStarted={async ()=>{ const s = await api.status(); setStatus((p:any)=>({...p,...s})); navigate('/monitor'); }} /> } />
          <Route path='/test' element={<Row gutter={[12,12]}><Col xs={24}><SimulatorPanel symbol={status?.symbol} /></Col></Row>} />
        </Routes>
      </Content>
      <Footer style={{ textAlign:'center' }}>Realtime WS • Continuous strategy • Multiple analyses • SL/TP overlays</Footer>
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
