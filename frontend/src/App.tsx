import { ConfigProvider, Layout, Menu, Space, Tag } from 'antd';
import React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, clearApiKey, getApiKey } from './api';
import DashboardPage from './pages/DashboardPage';
import LoginPage from './pages/LoginPage';
import MonitorPage from './pages/MonitorPage';
import SessionsPage from './pages/SessionsPage';
import TestingPage from './pages/TestingPage';
import { AreaChartOutlined, ControlOutlined, BulbOutlined } from '@ant-design/icons';
  const { Header, Content, Footer } = Layout;

function AppInner(){
  const [overview, setOverview] = React.useState<any>(null);
  const navigate = useNavigate();
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
    { key: '/dashboard', label: 'Dashboard', icon: <AreaChartOutlined /> },
    { key: '/sessions', label: 'Sessions', icon: <ControlOutlined /> },
    { key: '/testing', label: 'Testing', icon: <BulbOutlined /> },
  ];

  return (
    <Layout style={{ minHeight:'100vh', background: '#020817' }}>
      <Layout.Sider
        breakpoint='lg'
        collapsedWidth={60}
        theme='dark'
        style={{
          background: 'linear-gradient(180deg, rgba(4,18,36,0.98) 0%, rgba(12,30,55,0.95) 60%, rgba(15,23,42,0.95) 100%)',
          borderRight: '1px solid rgba(94,234,212,0.15)'
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          color: '#E0F2FE',
          padding: '16px 12px',
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          fontSize: 16
        }}>
          <span>QuantAI</span>
          <span style={{ fontSize: 11, color: '#38bdf8' }}>Alpha</span>
        </div>
        <Menu
          theme='dark'
          mode='inline'
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key })=> navigate(String(key))}
          style={{ background:'transparent', marginTop: 12 }}
        />
        <div style={{
          padding: 16,
          color: '#94a3b8',
          fontSize: 12,
          borderTop: '1px solid rgba(56,189,248,0.2)',
          marginTop: 'auto'
        }}>
          <div style={{ color:'#bae6fd', fontWeight:600 }}>Pulse Engine</div>
          <div>Live trade intelligence &amp; AI risk governance.</div>
        </div>
      </Layout.Sider>
      <Layout>
        <Header style={{
          display:'flex',
          justifyContent:'space-between',
          alignItems:'center',
          background: 'linear-gradient(90deg, rgba(15,23,42,1) 0%, rgba(30,64,175,0.95) 50%, rgba(14,116,144,0.9) 100%)',
          borderBottom: '1px solid rgba(56,189,248,0.25)'
        }}>
          <Space style={{ color: '#e2e8f0', fontWeight:500 }}>
            <span style={{ color:'#ddd' }}>Active:</span>
            <Tag color='blue'>{overview?.activeCount ?? 0}</Tag>
            {(overview?.symbols || []).slice(0,5).map((sym:string)=>(<Tag key={sym}>{sym}</Tag>))}
            {Array.isArray(overview?.symbols) && overview.symbols.length>5 && (<Tag>+{overview.symbols.length-5}</Tag>)}
          </Space>
          <Space style={{ color: '#e2e8f0', fontWeight:500 }}>
            <span style={{ color:'#bfdbfe' }}>ROI (agg):</span>
            <Tag color={(Number(overview?.roiPct||0) >= 0) ? 'green' : 'red'}>{Number(overview?.roiPct||0).toFixed(2)}%</Tag>
            <span style={{ color:'#bfdbfe' }}>PnL:</span>
            <Tag color={(Number(overview?.pnlUsd||0) >= 0) ? 'green' : 'red'}>${Number(overview?.pnlUsd||0).toFixed(2)}</Tag>
            <span style={{ color:'#bfdbfe' }}>AI:</span>
            <Tag color='cyan'>{Number(overview?.aiCallsTotal||0)}</Tag>
            {overview?.exchangeBalance && (
              <>
                <span style={{ color:'#bae6fd' }}>Exchange</span>
                <Tag color='cyan'>Free ${Number(overview.exchangeBalance.freeUsd||0).toFixed(2)}</Tag>
                <Tag color='geekblue'>Equity ${Number(overview.exchangeBalance.totalUsd||0).toFixed(2)}</Tag>
              </>
            )}
            {(overview?.paperBalance && (Number(overview.paperBalance.equityUsd||0) > 0)) && (
              <>
                <span style={{ color:'#bae6fd' }}>Paper</span>
                <Tag color='cyan'>Free ${Number(overview.paperBalance.freeUsd||0).toFixed(2)}</Tag>
                <Tag color='purple'>Equity ${Number(overview.paperBalance.equityUsd||0).toFixed(2)}</Tag>
              </>
            )}
            <a onClick={()=> { clearApiKey(); navigate('/login'); }} style={{ color:'#f8fafc', textDecoration:'underline' }}>Logout</a>
          </Space>
        </Header>
        <Content style={{
          padding: 18,
          overflow:'auto',
          background: 'radial-gradient(circle at top, rgba(14,116,144,0.15), transparent 55%), #020817',
          maxHeight:"calc(100vh - 64px - 48px - 24px)"
        }}>
          <Routes>
            <Route path='/' element={<Navigate to='/dashboard' replace />} />
            <Route path='/dashboard' element={<DashboardPage />} />
            <Route path='/monitor/:sessionId' element={<MonitorPage />} />
            <Route path='/sessions' element={<SessionsPage />} />
            <Route path='/testing' element={<TestingPage />} />
            <Route path='*' element={<Navigate to='/dashboard' replace />} />
          </Routes>
        </Content>
        <Footer style={{ textAlign:'center', background:'#020617', color:'#64748b' }}>
          Realtime AI Trade Engine · Adaptive Risk Governance · Storyboarded Insights
        </Footer>
      </Layout>
    </Layout>
  );
}

export default function App(){
  const brandTheme = {
    token: {
      colorPrimary: '#38bdf8',
      colorBgBase: '#020817',
      colorTextBase: '#e2e8f0',
      fontFamily: '"Inter", "Helvetica Neue", Arial, sans-serif',
      borderRadius: 8,
    },
    components: {
      Menu: {
        itemSelectedBg: 'rgba(56,189,248,0.25)',
        itemSelectedColor: '#f8fafc',
        itemColor: '#94a3b8',
      },
      Tag: {
        lineHeight: 20,
        borderRadiusSM: 6,
      },
      Layout: {
        headerBg: '#0f172a',
        siderBg: '#0b1120',
      },
    },
  } as const;
  return (
    <BrowserRouter>
      <ConfigProvider theme={brandTheme}>
        <AppInner />
      </ConfigProvider>
    </BrowserRouter>
  );
}
