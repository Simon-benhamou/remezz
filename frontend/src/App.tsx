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
          color: '#E0F2FE',
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
 const brandTheme: ThemeConfig = {
  algorithm: [theme.darkAlgorithm, theme.compactAlgorithm],
  token: {
    // Core brand
    colorPrimary: "#22d3ee", // electric cyan
    colorInfo: "#60a5fa",    // soft blue for info/links
    colorSuccess: "#22c55e", // profit/positive
    colorWarning: "#f59e0b",
    colorError: "#ef4444",   // loss/negative

    // Dark surfaces & text
    colorBgBase: "#0a0f1c",
    colorBgContainer: "#0f172a",
    colorBgElevated: "#111827",
    colorTextBase: "#e5e7eb",
    colorText: "#cbd5e1",
    colorTextSecondary: "#94a3b8",
    colorBorder: "#1f2937",
    colorSplit: "#182131",

    // Shape & controls
    borderRadius: 10,
    borderRadiusLG: 14,
    borderRadiusSM: 8,
    controlHeight: 36,
    controlHeightLG: 44,
    controlHeightSM: 28,
    controlOutline: "rgba(34, 211, 238, 0.25)", // focus glow
    controlItemBgActive: "rgba(34, 211, 238, 0.10)",
    colorLink: "#60a5fa",
    colorLinkHover: "#93c5fd",
    colorLinkActive: "#3b82f6",

    // Optional: subtle chart/grid helpers
    colorFillSecondary: "rgba(148,163,184,0.10)", // panel glows
    colorFillTertiary: "rgba(148,163,184,0.06)",
  },

  // Component-level refinements for a crisp trading UI
  components: {
    Layout: {
      headerBg: "#0e1526",
      siderBg: "#0b1220",
      bodyBg: "#0a0f1c",
      headerPadding: "0 16px",
      triggerBg: "rgba(255,255,255,0.06)",
      triggerColor: "#cbd5e1",
    },

    Menu: {
      itemColor: "#94a3b8",
      itemHoverColor: "#e5e7eb",
      itemBg: "transparent",
      itemHoverBg: "rgba(148,163,184,0.06)",
      itemSelectedBg: "rgba(34,211,238,0.18)",
      itemSelectedColor: "#f8fafc",
      itemActiveBg: "rgba(34,211,238,0.10)",
      itemBorderRadius: 8,
      activeBarBorderWidth: 0,
      groupTitleColor: "#64748b",
    },

    Button: {
      controlHeight: 36,
      paddingInline: 14,
      borderRadius: 10,
      colorPrimary: "#22d3ee",
      colorPrimaryHover: "#67e8f9",
      colorPrimaryActive: "#06b6d4",
      defaultBg: "rgba(148,163,184,0.08)",
      defaultHoverBg: "rgba(148,163,184,0.12)",
      defaultActiveBg: "rgba(148,163,184,0.18)",
      defaultColor: "#e5e7eb",
      ghostBg: "transparent",
      primaryShadow: "0 0 0 3px rgba(34,211,238,0.15)",
    },


    Card: {
      borderRadiusLG: 14,
      paddingLG: 20,
      headerBg: "#0f172a",
      colorBgContainer: "#0f172a",
      boxShadowTertiary: "0 6px 30px rgba(2,6,23,0.35)",
    },

    Table: {
      headerBg: "#0f172a",
      headerColor: "#cbd5e1",
      rowHoverBg: "rgba(148,163,184,0.06)",
      rowSelectedBg: "rgba(34,211,238,0.10)",
      borderColor: "#1f2937",
      stickyScrollBarBg: "rgba(148,163,184,0.35)",
      stickyScrollBarBorderRadius: 4,
    },

    Tabs: {
      itemColor: "#94a3b8",
      itemSelectedColor: "#e5e7eb",
      itemHoverColor: "#e5e7eb",
      inkBarColor: "#22d3ee",
      cardBg: "#0f172a",
      titleFontSize: 14,
    },

    Input: {
      borderRadius: 10,
      activeBorderColor: "#22d3ee",
      hoverBorderColor: "#60a5fa",
      paddingBlock: 8,
      paddingInline: 12,
      colorBgContainer: "#0f172a",
      colorTextPlaceholder: "#64748b",
      addonBg: "#0a0f1c",
    },

    Select: {
      optionSelectedBg: "rgba(34,211,238,0.14)",
      optionActiveBg: "rgba(148,163,184,0.10)",
      colorBgContainer: "#0f172a",
      borderRadius: 10,
      controlOutline: "rgba(34,211,238,0.25)",
    },

    Dropdown: {
      colorBgElevated: "#0f172a",
      controlItemBgActive: "rgba(34,211,238,0.10)",
    },

    Tooltip: {
      colorBgSpotlight: "#111827",
      colorTextLightSolid: "#e5e7eb",
      borderRadius: 8,
    },

    Modal: {
      colorBgElevated: "#0f172a",
      headerBg: "#0f172a",
      titleColor: "#e5e7eb",
      borderRadiusLG: 14,
    },

    Drawer: {
      colorBgElevated: "#0f172a",
      borderRadiusLG: 16,
    },

    Badge: {
      colorBgContainer: "#0b1220",
    },



    Progress: {
      remainingColor: "rgba(148,163,184,0.16)",
    },

    Segmented: {
      itemSelectedBg: "rgba(34,211,238,0.16)",
      itemHoverBg: "rgba(148,163,184,0.10)",
      trackBg: "rgba(148,163,184,0.08)",
      borderRadius: 12,
    },

    Switch: {
      colorPrimaryHover: "#67e8f9",
      colorPrimary: "#22d3ee",
      handleBg: "#0b1220",
      trackHeight: 22,
    },

    Slider: {
      railBg: "rgba(148,163,184,0.18)",
      trackBg: "#22d3ee",
      handleSize: 12,
    },



    Steps: {
      colorTextDescription: "#94a3b8",
      colorText: "#cbd5e1",
      colorPrimary: "#22d3ee",
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
