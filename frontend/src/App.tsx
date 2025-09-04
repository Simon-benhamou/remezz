import React from 'react';
import { Layout, Typography, Space, Button, Select, message, Row, Col, Tabs } from 'antd';
import { api } from './api';
import { openWS, wsSend } from './ws';
import PriceChart from './charts/PriceChart';
import StrategyPanel from './components/StrategyPanel';
import IndicatorsPanel from './components/IndicatorsPanel';
import AgentControls from './components/AgentControls';
import OrdersTable from './components/OrdersTable';
import PerfPanel from './components/PerfPanel';
import TriggersPanel from './components/TriggersPanel';
import RankingPanel from './components/RankingPanel';
import AnalysisTabs from './components/AnalysisTabs';

const { Header, Content, Footer } = Layout; const { Title } = Typography;

export default function App(){
  const [symbol, setSymbol] = React.useState('BTC/USDT');
  const [status, setStatus] = React.useState<any>({ symbol });
  const [strategy, setStrategy] = React.useState<any>(null);
  const [orders, setOrders] = React.useState<any[]>([]);
  const [kpi, setKpi] = React.useState<any>(null);
  const [triggers, setTriggers] = React.useState<any[]>([]);
  const [ranking, setRanking] = React.useState<any[]>([]);
  const [analysis, setAnalysis] = React.useState<any>(null);
  const wsRef = React.useRef<WebSocket|null>(null);

  const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';
  const API_KEY = import.meta.env.VITE_APP_API_KEY || '';

  React.useEffect(()=> {
    const ws = openWS(API_BASE, API_KEY, symbol, async (msg) => {
      if (msg.type === 'hello_ok') return;
      if (msg.type === 'sub_ok') return;
      if (msg.type === 'tick') {
        setStatus((s:any)=>({ ...s, symbol: msg.data.symbol, price: msg.data.price, sr: { support: msg.data.support, resistance: msg.data.resistance } }));
      }
      if (msg.type === 'strategy') setStrategy(msg.data);
      if (msg.type === 'analysis') setAnalysis(msg.data);
      if (msg.type === 'session') setStatus((s:any)=>({ ...s, session: msg.data, symbol: msg.data.symbol || s.symbol }));
      if (msg.type === 'orders') setOrders(msg.data);
    });
    wsRef.current = ws;

    // bootstrap côté REST pour tables & perf
    (async ()=>{
      try {
        const s = await api.status(); setStatus((prev:any)=>({ ...prev, ...s }));
        setOrders(await api.getOrders());
        if (s.session?.id) setKpi(await api.getPerf(s.session.id));
        setTriggers(await api.getTriggers());
        setRanking(await api.rankPerps(['BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT','AVAX/USDT']));
      } catch {}
    })();

    return ()=> { ws.close(); wsRef.current = null; };
  }, []);

  // changement de symbole => sub WS + (optionnel) set-symbol si session active
  const changeSymbol = async (sym:string) => {
    setSymbol(sym);
    if (wsRef.current) wsSend(wsRef.current, { type: 'sub', symbol: sym });
    if (status?.session?.id) await api.client.post('/api/agent/set-symbol', { symbol: sym });
    message.success(`Symbole défini sur ${sym}`);
  };

  const genStrategy = () => {
    if (wsRef.current) wsSend(wsRef.current, { type: 'gen_strategy', symbol, trigger: 'manual' });
  };

  return (
    <Layout style={{ minHeight:'100vh' }}>
      <Header style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <Title level={4} style={{ color:'white', margin:0 }}>Agent IA v3 — {status?.symbol}</Title>
        <Space>
          <Select value={symbol} onChange={changeSymbol} style={{ width:180 }}
            options={[{value:'BTC/USDT'},{value:'ETH/USDT'},{value:'SOL/USDT'},{value:'XRP/USDT'},{value:'AVAX/USDT'}]} />
          <Button onClick={genStrategy}>Générer stratégie</Button>
        </Space>
      </Header>
      <Content style={{ padding: 12 }}>
        <Row gutter={[12,12]}>
          <Col xs={24} lg={16}>
            <PriceChart
              symbol={status?.symbol}
              price={status?.price}
              support={status?.sr?.support}
              resistance={status?.sr?.resistance}
              strategy={strategy}
            />
          </Col>
          <Col xs={24} lg={8}><StrategyPanel strategy={strategy} /></Col>

          <Col xs={24}><AnalysisTabs analysis={analysis} /></Col>

          <Col xs={24} lg={8}><AgentControls session={status?.session} symbol={status?.symbol} onChange={async ()=>{
            const s = await api.status(); setStatus((prev:any)=>({ ...prev, ...s }));
          }} /></Col>
          <Col xs={24} lg={8}><IndicatorsPanel indicators={analysis?.indicators || status?.indicators} /></Col>
          <Col xs={24} lg={8}><PerfPanel kpi={kpi} session={status?.session} /></Col>

          <Col xs={24}><RankingPanel rows={ranking} onPick={(sym:string)=> changeSymbol(sym)} /></Col>
          <Col xs={24}><TriggersPanel rows={triggers} /></Col>
          <Col xs={24}><OrdersTable rows={orders} /></Col>
        </Row>
      </Content>
      <Footer style={{ textAlign:'center' }}>WS temps réel • Stratégie continue • 4 analyses visibles • Objectifs (SL/TP) tracés</Footer>
    </Layout>
  );
}
