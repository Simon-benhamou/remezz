import { Layout, Menu, Space, Tag, Typography } from 'antd';
import React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, clearApiKey, getApiKey } from './api';
import DashboardPage from './pages/DashboardPage';
import LoginPage from './pages/LoginPage';
import MonitorPage from './pages/MonitorPage';
import SessionsPage from './pages/SessionsPage';
import TestingPage from './pages/TestingPage';
import { openWS, wsSend } from './ws';

  const { Header, Content, Footer } = Layout; const { Title } = Typography;

function AppInner(){
  const [overview, setOverview] = React.useState<any>(null);
  const navigate = useNavigate();
  const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';
  const location = useLocation();

  // Note: global WS removed; MonitorPage owns its own session-scoped WS now.


  // Lightweight polling for multi-agent overview (no WS in App anymore)
  React.useEffect(()=>{
    let timer: any;
    const load = async ()=>{
      try { setOverview(await api.overview()); } catch {}
    };
    load();
    timer = setInterval(load, 15000);
    return ()=> { clearInterval(timer); };
  }, []);

  const hasSession = true; // routing no longer depends on a single active session

  const authed = !!getApiKey();
  if (!authed) {
    return (
      <Routes>
        <Route path='/login' element={<LoginPage />} />
        <Route path='*' element={<Navigate to='/login' replace />} />
      </Routes>
    );
  }

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
            <span style={{ color:'#ddd' }}>Active:</span>
            <Tag color='blue'>{overview?.activeCount ?? 0}</Tag>
            {(overview?.symbols || []).slice(0,5).map((sym:string)=>(<Tag key={sym}>{sym}</Tag>))}
            {Array.isArray(overview?.symbols) && overview.symbols.length>5 && (<Tag>+{overview.symbols.length-5}</Tag>)}
          </Space>
          <Space style={{ color: 'white' }}>
            <span style={{ color:'#ccc' }}>ROI (agg):</span>
            <Tag color={(Number(overview?.roiPct||0) >= 0) ? 'green' : 'red'}>{Number(overview?.roiPct||0).toFixed(2)}%</Tag>
            <span style={{ color:'#ccc' }}>PnL:</span>
            <Tag color={(Number(overview?.pnlUsd||0) >= 0) ? 'green' : 'red'}>${Number(overview?.pnlUsd||0).toFixed(2)}</Tag>
            <span style={{ color:'#ccc' }}>AI:</span>
            <Tag>{Number(overview?.aiCallsTotal||0)}</Tag>
            <a onClick={()=> { clearApiKey(); navigate('/login'); }} style={{ color:'#ddd', textDecoration:'underline' }}>Logout</a>
          </Space>
        </Header>
        <Content style={{ padding: 12 , overflow:'auto', background:'#fff' }}>
          <Routes>
            <Route path='/' element={<Navigate to='/dashboard' replace />} />
            <Route path='/dashboard' element={<DashboardPage />} />
            {/* Dedicated monitor page fully driven by :sessionId */}
            <Route path='/monitor/:sessionId' element={<MonitorPage />} />
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
