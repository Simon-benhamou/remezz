import React from 'react';
import { useParams, Navigate, useNavigate } from 'react-router-dom';
import { Row, Col, Space, Tag } from 'antd';
import PriceChart from '../charts/PriceChart';
import StrategyPanel from '../components/StrategyPanel';
import AnalysisTabs from '../components/AnalysisTabs';
import AgentControls from '../components/AgentControls';
import AgentStatePanel from '../components/AgentStatePanel';
import IndicatorsPanel from '../components/IndicatorsPanel';
import PerfPanel from '../components/PerfPanel';
import TriggersPanel from '../components/TriggersPanel';
import OrdersTable from '../components/OrdersTable';
import HelpPanel from '../components/HelpPanel';
import { api, getApiKey } from '../api';
import { openWS, wsSend } from '../ws';

export default function MonitorPage(){
  const { sessionId } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = React.useState(false);
  const [wsConnected, setWsConnected] = React.useState(false);
  const wsRef = React.useRef<WebSocket|null>(null);

  // Local data strictly scoped to this sessionId
  const [symbol, setSymbol] = React.useState<string>("");
  const [status, setStatus] = React.useState<any>({});
  const [strategy, setStrategy] = React.useState<any>(null);
  const [analysis, setAnalysis] = React.useState<any>(null);
  const [agent, setAgent] = React.useState<any>(null);
  const [kpi, setKpi] = React.useState<any>(null);
  const [orders, setOrders] = React.useState<any[]>([]);
  const [triggers, setTriggers] = React.useState<any[]>([]);

  const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

  // Bootstrap strictly from sessionId
  React.useEffect(()=>{
    if (!sessionId) return;
    (async ()=>{
      setLoading(true);
      try {
        const s = await api.status(sessionId);
        if (!sessionId) { navigate('/sessions'); return; }
        setStatus(s);
        const sym = s?.session?.symbol || s?.symbol || symbol;
        if (sym) setSymbol(sym);
        try { setStrategy(await api.strategyToday(sym)); } catch {}
        try { setAnalysis(await api.analysis(sym)); } catch {}
        try { if (s.session?.id) setKpi(await api.getPerf(s.session.id)); } catch {}
        try { if (s.session?.id) setOrders(await api.getOrders(s.session.id)); } catch {}
        try { if (s.session?.id) setTriggers(await api.getTriggers(s.session.id)); } catch {}
        try { if (s.session?.id) setAgent(await api.getAgentState(s.session.id)); } catch {}
      } finally { setLoading(false); }
    })();
  }, [sessionId]);

  // WS subscription dedicated to this monitor
  React.useEffect(()=>{
    if (!sessionId) return;
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
      }
      if (msg.type === 'orders') {
        setOrders(msg.data);
        try { setAgent(await api.getAgentState(sessionId)); } catch {}
      }
      if (msg.type === 'trigger') setTriggers((prev:any[])=> [msg.data, ...prev].slice(0,100));
    }, (ok)=> setWsConnected(ok), (next)=> { wsRef.current = next; }, sessionId);
    wsRef.current = ws;
    return ()=> { try { wsRef.current?.close?.(); } catch {} };
  }, [API_BASE, sessionId, symbol]);

  if (!sessionId) return <Navigate to='/sessions' replace />;
  const hasSession = !!status?.session?.id;
  // Do not redirect while loading bootstrap; only redirect if definitively no session
  if (!loading && !hasSession) return <Navigate to='/sessions' replace />;

  return (
    <>
      {loading && (
        <div style={{ position:'fixed', inset:0, background:'rgba(255,255,255,0.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
          <div style={{ padding:12, background:'#fff', border:'1px solid #eee', borderRadius:8 }}>Loading monitor…</div>
        </div>
      )}
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
          const s = await api.status(sessionId!);
          setStatus((prev:any)=>({ ...prev, ...s }));
          if (!s?.session) navigate('/sessions'); else { if (s.session.symbol) setSymbol(s.session.symbol); }
        }} /></Col>
        <Col xs={24} lg={8}><AgentStatePanel agent={agent} symbol={status?.symbol} lastPrice={status?.price} sessionId={status?.session?.id} onPlan={()=>{}} /></Col>
        <Col xs={24} lg={8}><IndicatorsPanel indicators={analysis?.indicators || status?.indicators} /></Col>
        <Col xs={24} lg={8}><PerfPanel kpi={kpi} session={status?.session} /></Col>
        <Col xs={24}><TriggersPanel rows={triggers} /></Col>
        <Col xs={24}><OrdersTable rows={orders} /></Col>
        <Col xs={24}><HelpPanel /></Col>
      </Row>
    </>
  );
}
