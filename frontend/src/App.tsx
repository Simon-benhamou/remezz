import React from 'react';
import { Layout, Typography, Space, Button, Select, message, Row, Col } from 'antd';
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
  const [ranking, setRanking] = React.useState<any[]>([]);
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
      if (msg.type === 'agent_state') setAgent(msg.data);
      if (msg.type === 'session') setStatus((s:any)=>({ ...s, session: msg.data, symbol: msg.data.symbol || s.symbol }));
      if (msg.type === 'orders') setOrders(msg.data);
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
        setRanking(await api.rankPerps(['BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT','AVAX/USDT']));
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

  // On symbol change => WS sub + optionally set-symbol if session active
  const changeSymbol = async (sym:string) => {
    setSymbol(sym);
    if (wsRef.current) wsSend(wsRef.current, { type: 'sub', symbol: sym });
    if (status?.session?.id) await api.client.post('/api/agent/set-symbol', { symbol: sym });
    try { setAnalysis(await api.analysis(sym)); } catch {}
    message.success(`Symbol set to ${sym}`);
  };

  const genStrategy = () => {
    if (wsRef.current) wsSend(wsRef.current, { type: 'gen_strategy', symbol, trigger: 'manual' });
  };

  const hasSession = !!status?.session;

  return (
    <Layout style={{ minHeight:'100vh' }}>
      <Header style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <Title level={4} style={{ color:'white', margin:0 }}><Link to='/' style={{ color:'inherit' }}>Trading Agent v3</Link></Title>
        <Space>
          <Link to='/start'>Start</Link>
          <Link to='/monitor' style={{ pointerEvents: hasSession? 'auto':'none', opacity: hasSession? 1: 0.5 }}>Monitor</Link>
          <Link to='/test'>Test</Link>
          {hasSession && (
            <>
              <Select value={symbol} onChange={changeSymbol} style={{ width:180 }}
                options={[{value:'BTC/USDT'},{value:'ETH/USDT'},{value:'SOL/USDT'},{value:'XRP/USDT'},{value:'AVAX/USDT'}]} />
              <Button onClick={genStrategy}>Generate strategy</Button>
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
