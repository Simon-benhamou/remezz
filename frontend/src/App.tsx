import { ConfigProvider, Layout, Menu, Space, Tag, theme, ThemeConfig } from 'antd';
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
        
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          color: '#262626',
          padding: '16px 12px',
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          fontSize: 16
        }}>
          <span>QuantAI</span>
          <span style={{ fontSize: 11, color: '#22d3ee' }}>Alpha</span>
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
        }}>
          <Space style={{ color: '#262626', fontWeight:500 }}>
            <span style={{ color:'#262626' }}>Active:</span>
            <Tag color='blue'>{overview?.activeCount ?? 0}</Tag>
            {(overview?.symbols || []).slice(0,5).map((sym:string)=>(<Tag key={sym}>{sym}</Tag>))}
            {Array.isArray(overview?.symbols) && overview.symbols.length>5 && (<Tag>+{overview.symbols.length-5}</Tag>)}
          </Space>
          <Space style={{ color: '#262626', fontWeight:500 }}>
            <span style={{ color:'#262626' }}>ROI (agg):</span>
            <Tag color={(Number(overview?.roiPct||0) >= 0) ? 'green' : 'red'}>{Number(overview?.roiPct||0).toFixed(2)}%</Tag>
            <span style={{ color:'#262626' }}>PnL:</span>
            <Tag color={(Number(overview?.pnlUsd||0) >= 0) ? 'green' : 'red'}>${Number(overview?.pnlUsd||0).toFixed(2)}</Tag>
            <span style={{ color:'#262626' }}>AI:</span>
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
        <Footer style={{ textAlign:'center' }}>
          Realtime AI Trade Engine · Adaptive Risk Governance · Storyboarded Insights
        </Footer>
      </Layout>
    </Layout>
  );
}

export default function App(){
 const brandTheme: ThemeConfig = {
  algorithm: [theme.defaultAlgorithm, theme.compactAlgorithm],
  token: {
    // Core brand (light, frais)
    colorPrimary: "#1f2937", // teal/cyan
    colorInfo: "#2563eb",
    colorSuccess: "#16a34a",
    colorWarning: "#d97706",
    colorError: "#dc2626",

    // Surfaces & texte (LIGHT)
    colorBgBase: "#f8fafc",        // app background
    colorBgContainer: "#ffffff",   // cartes/composants
    colorBgElevated: "#ffffff",
    colorTextBase: "#0f172a",
    colorText: "#1f2937",
    colorTextSecondary: "#475569",
    colorBorder: "#e5e7eb",
    colorSplit: "#f1f5f9",

    // Contrôles & formes
    borderRadius: 10,
    borderRadiusLG: 14,
    borderRadiusSM: 8,
    controlHeight: 36,
    controlHeightLG: 44,
    controlHeightSM: 28,
    controlOutline: "rgba(6,182,212,0.30)", // focus glow
    controlItemBgActive: "rgba(6,182,212,0.08)",
    colorLink: "#2563eb",
    colorLinkHover: "#3b82f6",
    colorLinkActive: "#1d4ed8",

    // Aides discrètes (grilles/hover)
    colorFillSecondary: "rgba(2,6,23,0.03)",
    colorFillTertiary: "rgba(2,6,23,0.02)",
  },

  components: {
    Layout: {
      headerBg: "#ffffff",
      siderBg: "#f8fafc",
      bodyBg: "#f8fafc",
      headerPadding: "0 16px",
      triggerBg: "rgba(15,23,42,0.05)",
      triggerColor: "#334155",
    },

    Menu: {
      itemColor: "#475569",
      itemHoverColor: "#0f172a",
      itemBg: "transparent",
      itemHoverBg: "rgba(2,6,23,0.03)",
      itemSelectedBg: "rgba(6,182,212,0.12)",
      itemSelectedColor: "#0f172a",
      itemActiveBg: "rgba(6,182,212,0.08)",
      itemBorderRadius: 8,
      activeBarBorderWidth: 0,
      groupTitleColor: "#64748b",
    },

    Button: {
      controlHeight: 36,
      paddingInline: 10,
      borderRadius: 8,
      colorPrimary: "#1f2937",
      colorPrimaryHover: "#22d3ee",
      colorPrimaryActive: "#0891b2",
      defaultBg: "#f8fafc",
      defaultHoverBg: "#f1f5f9",
      defaultActiveBg: "#e5e7eb",
      defaultColor: "#0f172a",
      ghostBg: "transparent",
      primaryShadow: "0 0 0 3px rgba(6,182,212,0.20)",
    },

    Card: {
      borderRadiusLG: 14,
      paddingLG: 20,
      headerBg: "#ffffff",
      colorBgContainer: "#ffffff",
      boxShadowTertiary: "0 10px 30px rgba(2,6,23,0.06)",
    },

    Table: {
      headerBg: "#f8fafc",
      headerColor: "#334155",
      rowHoverBg: "rgba(2,6,23,0.03)",
      rowSelectedBg: "rgba(6,182,212,0.10)",
      borderColor: "#e5e7eb",
      stickyScrollBarBg: "rgba(2,6,23,0.25)",
      stickyScrollBarBorderRadius: 4,
    },

    Tabs: {
      itemColor: "#475569",
      itemSelectedColor: "#0f172a",
      itemHoverColor: "#0f172a",
      inkBarColor: "#1f2937",
      cardBg: "#ffffff",
      titleFontSize: 14,
    },

    Input: {
      borderRadius: 10,
      activeBorderColor: "#1f2937",
      hoverBorderColor: "#3b82f6",
      paddingBlock: 8,
      paddingInline: 12,
      colorBgContainer: "#ffffff",
      colorTextPlaceholder: "#94a3b8",
      addonBg: "#f8fafc",
    },

    Select: {
      optionSelectedBg: "rgba(6,182,212,0.12)",
      optionActiveBg: "rgba(2,6,23,0.03)",
      colorBgContainer: "#ffffff",
      borderRadius: 10,
      controlOutline: "rgba(6,182,212,0.30)",
    },

    Dropdown: {
      colorBgElevated: "#ffffff",
      controlItemBgActive: "rgba(6,182,212,0.08)",
    },

    Tooltip: {
      colorBgSpotlight: "#0f172a",
      colorTextLightSolid: "#e5e7eb",
      borderRadius: 8,
    },

    Modal: {
      colorBgElevated: "#ffffff",
      headerBg: "#ffffff",
      titleColor: "#0f172a",
      borderRadiusLG: 14,
    },

    Drawer: {
      colorBgElevated: "#ffffff",
      borderRadiusLG: 16,
    },

    Badge: {
      colorBgContainer: "#0f172a",
    },

    Progress: {
      remainingColor: "rgba(2,6,23,0.08)",
    },

    Segmented: {
      itemSelectedBg: "rgba(6,182,212,0.14)",
      itemHoverBg: "#f1f5f9",
      trackBg: "#f1f5f9",
      borderRadius: 12,
    },

    Switch: {
      colorPrimaryHover: "#22d3ee",
      colorPrimary: "#1f2937",
      handleBg: "#ffffff",
      trackHeight: 22,
    },

    Slider: {
      railBg: "#e5e7eb",
      trackBg: "#1f2937",
      handleSize: 12,
    },


    Steps: {
      colorTextDescription: "#64748b",
      colorText: "#334155",
      colorPrimary: "#1f2937",
    },
  },

};
  return (
    <BrowserRouter>
      <ConfigProvider theme={brandTheme}>
        <AppInner />
      </ConfigProvider>
    </BrowserRouter>
  );
}
