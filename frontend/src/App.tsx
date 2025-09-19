import { ConfigProvider, Layout, Menu, Space, Tag, theme, ThemeConfig, Segmented } from 'antd';
import React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, clearApiKey, getApiKey } from './api';
import DashboardPage from './pages/DashboardPage';
import LoginPage from './pages/LoginPage';
import MonitorPage from './pages/MonitorPage';
import SessionsPage from './pages/SessionsPage';
import TestingPage from './pages/TestingPage';
import ReportsPage from './pages/ReportsPage';
import TradesJournalPage from './pages/TradesJournalPage';
import BacklogPage from './pages/BacklogPage';
import { AreaChartOutlined, ControlOutlined, BulbOutlined, FileTextOutlined, ReadOutlined, WarningOutlined } from '@ant-design/icons';
import { useMode } from './contexts/ModeContext';
  const { Header, Content, Footer } = Layout;

function AppInner(){
  const [overview, setOverview] = React.useState<any>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const { mode, setMode } = useMode();

  // Note: global WS removed; MonitorPage owns its own session-scoped WS now.


  // Lightweight polling for multi-agent overview (no WS in App anymore)
  React.useEffect(()=>{
    let timer: any;
    const load = async ()=>{
      try { setOverview(await api.overview(mode)); } catch {}
    };
    load();
    timer = setInterval(load, 15000);
    return ()=> { if (timer) clearInterval(timer); };
  }, [mode]);

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
    { key: '/reports', label: 'Reports', icon: <FileTextOutlined /> },
    { key: '/journal', label: 'Journal', icon: <ReadOutlined /> },
    { key: '/testing', label: 'Testing', icon: <BulbOutlined /> },
    { key: '/backlog', label: 'Backlog', icon: <WarningOutlined /> },
  ];

  return (
    <Layout style={{ minHeight:'100vh', background: '#fafafa' }}>
      <Layout.Sider
        breakpoint='lg'
        collapsedWidth={60}
        theme='light'
        style={{
          background: '#ffffff',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.06)',
          borderRight: '1px solid #f3f4f6',
          zIndex: 100
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '20px 16px',
          borderBottom: '1px solid #f3f4f6',
          marginBottom: 8
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8
          }}>
            <div style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#ffffff',
              fontSize: 14,
              fontWeight: 600
            }}>
              Q
            </div>
            <div>
              <div style={{
                color: '#111827',
                fontWeight: 600,
                fontSize: 16,
                lineHeight: 1.2
              }}>QuantAI</div>
              <div style={{
                color: '#2563eb',
                fontSize: 10,
                fontWeight: 500,
                textTransform: 'uppercase',
                letterSpacing: 0.5
              }}>Alpha</div>
            </div>
          </div>
        </div>
        <Menu
          theme='light'
          mode='inline'
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key })=> navigate(String(key))}
          style={{ 
            background:'transparent', 
            border: 'none',
            fontSize: 14
          }}
        />
        <div style={{
          padding: '16px',
          borderTop: '1px solid #f3f4f6',
          marginTop: 'auto'
        }}>
          <div style={{
            color: '#2563eb',
            fontWeight: 600,
            fontSize: 12,
            marginBottom: 4
          }}>Pulse Engine</div>
          <div style={{
            color: '#6b7280',
            fontSize: 11,
            lineHeight: 1.4
          }}>Live trade intelligence & AI risk governance</div>
        </div>
      </Layout.Sider>
      <Layout>
        <Header style={{
          display:'flex',
          justifyContent:'space-between',
          alignItems:'center',
          background: '#ffffff',
          borderBottom: '1px solid #f3f4f6',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04)',
          padding: '0 24px',
          height: 64
        }}>
          <Space style={{ color: '#374151', fontWeight:500, fontSize: 14 }}>
            <span style={{ color:'#6b7280' }}>Active:</span>
            <Tag color='blue' style={{ borderRadius: 6, fontSize: 12 }}>{overview?.activeCount ?? 0}</Tag>
            {(overview?.symbols || []).slice(0,5).map((sym:string)=>(
              <Tag key={sym} style={{ borderRadius: 6, fontSize: 11, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb' }}>{sym}</Tag>
            ))}
            {Array.isArray(overview?.symbols) && overview.symbols.length>5 && (
              <Tag style={{ borderRadius: 6, fontSize: 11, background: '#f3f4f6', color: '#6b7280', border: '1px solid #e5e7eb' }}>+{overview.symbols.length-5}</Tag>
            )}
          </Space>
          <Space style={{ color: '#374151', fontWeight:500, fontSize: 14 }}>
            <Segmented 
              size='small' 
              value={mode} 
              options={[
                { label: 'Live', value: 'live' },
                { label: 'Paper', value: 'paper' },
              ]} 
              onChange={(val)=> setMode((val as 'live'|'paper'))}
              style={{ background: '#f9fafb' }}
            />
            <span style={{ color:'#6b7280' }}>ROI:</span>
            <Tag 
              color={(Number(overview?.roiPct||0) >= 0) ? 'success' : 'error'}
              style={{ borderRadius: 6, fontSize: 12 }}
            >
              {Number(overview?.roiPct||0).toFixed(2)}%
            </Tag>
            <span style={{ color:'#6b7280' }}>PnL:</span>
            <Tag 
              color={(Number(overview?.pnlUsd||0) >= 0) ? 'success' : 'error'}
              style={{ borderRadius: 6, fontSize: 12 }}
            >
              ${Number(overview?.pnlUsd||0).toFixed(2)}
            </Tag>
            <span style={{ color:'#6b7280' }}>AI:</span>
            <Tag color='cyan' style={{ borderRadius: 6, fontSize: 12 }}>{Number(overview?.aiCallsTotal||0)}</Tag>
            {mode === 'live' && overview?.exchangeBalance && (
              <>
                <span style={{ color:'#2563eb', fontWeight: 600 }}>Exchange</span>
                <Tag color='cyan' style={{ borderRadius: 6, fontSize: 12 }}>Free ${Number(overview.exchangeBalance.freeUsd||0).toFixed(2)}</Tag>
                <Tag color='geekblue' style={{ borderRadius: 6, fontSize: 12 }}>Equity ${Number(overview.exchangeBalance.totalUsd||0).toFixed(2)}</Tag>
              </>
            )}
            {mode === 'paper' && overview?.paperBalance && (
              <>
                <span style={{ color:'#2563eb', fontWeight: 600 }}>Paper</span>
                <Tag color='cyan' style={{ borderRadius: 6, fontSize: 12 }}>Free ${Number(overview.paperBalance.freeUsd||0).toFixed(2)}</Tag>
                <Tag color='purple' style={{ borderRadius: 6, fontSize: 12 }}>Equity ${Number(overview.paperBalance.equityUsd||0).toFixed(2)}</Tag>
              </>
            )}
            <a 
              onClick={()=> { clearApiKey(); navigate('/login'); }} 
              style={{ 
                color:'#ef4444', 
                textDecoration:'none',
                fontWeight: 500,
                fontSize: 13,
                padding: '4px 8px',
                borderRadius: 6,
                border: '1px solid #fca5a5',
                background: '#fef2f2',
                transition: 'all 0.2s ease'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#fee2e2';
                e.currentTarget.style.borderColor = '#f87171';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = '#fef2f2';
                e.currentTarget.style.borderColor = '#fca5a5';
              }}
            >
              Logout
            </a>
          </Space>
        </Header>
        <Content style={{
          padding: '24px',
          overflow:'auto',
          maxHeight:"calc(100vh - 128px)",
          background: '#fafafa'
        }}>
          <Routes>
            <Route path='/' element={<Navigate to='/dashboard' replace />} />
            <Route path='/dashboard' element={<DashboardPage />} />
            <Route path='/monitor/:sessionId' element={<MonitorPage />} />
            <Route path='/sessions' element={<SessionsPage />} />
            <Route path='/reports' element={<ReportsPage />} />
            <Route path='/journal' element={<TradesJournalPage />} />
            <Route path='/testing' element={<TestingPage />} />
            <Route path='/backlog' element={<BacklogPage />} />
            <Route path='*' element={<Navigate to='/dashboard' replace />} />
          </Routes>
        </Content>
        <Footer style={{ 
          textAlign:'center',
          background: '#ffffff',
          borderTop: '1px solid #f3f4f6',
          color: '#6b7280',
          fontSize: 12,
          padding: '16px 24px'
        }}>
          Realtime AI Trade Engine · Adaptive Risk Governance · Storyboarded Insights
        </Footer>
      </Layout>
    </Layout>
  );
}

export default function App(){
 const brandTheme: ThemeConfig = {
  algorithm: [theme.defaultAlgorithm],
  token: {
    // Modern Color Palette - Light & Fresh
    colorPrimary: "#2563eb", // Clean blue primary
    colorInfo: "#06b6d4", // Cyan for information
    colorSuccess: "#10b981", // Fresh green
    colorWarning: "#f59e0b", // Warm amber
    colorError: "#ef4444", // Clean red

    // Clean Background System
    colorBgBase: "#ffffff",        // Pure white background
    colorBgContainer: "#ffffff",   // Cards and containers
    colorBgElevated: "#ffffff",    // Elevated surfaces
    colorBgLayout: "#fafafa",      // Layout background
    
    // Typography - Refined Hierarchy
    colorTextBase: "#111827",      // Primary text
    colorText: "#374151",          // Secondary text
    colorTextSecondary: "#6b7280", // Muted text
    colorTextTertiary: "#9ca3af",  // Subtle text
    colorTextQuaternary: "#d1d5db", // Very subtle
    
    // Clean Borders & Dividers
    colorBorder: "#e5e7eb",        // Standard borders
    colorBorderSecondary: "#f3f4f6", // Subtle borders
    colorSplit: "#f9fafb",         // Section dividers
    
    // Modern Shape Language
    borderRadius: 8,               // Standard radius
    borderRadiusLG: 12,            // Large radius
    borderRadiusSM: 6,             // Small radius
    borderRadiusXS: 4,             // Extra small
    // Modern Control Sizes
    controlHeight: 40,              // Standard height
    controlHeightLG: 48,            // Large controls
    controlHeightSM: 32,            // Small controls
    controlHeightXS: 24,            // Extra small
    
    // Enhanced Focus & Interaction
    controlOutline: "rgba(37, 99, 235, 0.2)", // Blue focus ring
    controlItemBgActive: "rgba(37, 99, 235, 0.06)",
    controlItemBgHover: "rgba(17, 24, 39, 0.04)",
    
    // Modern Link Styles
    colorLink: "#2563eb",
    colorLinkHover: "#1d4ed8",
    colorLinkActive: "#1e40af",
    
    // Subtle Fill Colors
    colorFillSecondary: "rgba(17, 24, 39, 0.02)",
    colorFillTertiary: "rgba(17, 24, 39, 0.01)",
    colorFillQuaternary: "rgba(17, 24, 39, 0.005)",
    
    // Refined Spacing
    padding: 16,
    paddingLG: 24,
    paddingSM: 12,
    paddingXS: 8,
    margin: 16,
    marginLG: 24,
    marginSM: 12,
    marginXS: 8,
    
    // Typography Scale
    fontSize: 14,
    fontSizeLG: 16,
    fontSizeSM: 12,
    fontSizeXL: 20,
    lineHeight: 1.6,
    lineHeightLG: 1.5,
  },

  components: {
    Layout: {
      headerBg: "#ffffff",
      siderBg: "#ffffff",
      bodyBg: "#fafafa",
      footerBg: "#ffffff",
      headerPadding: "0 24px",
      footerPadding: "24px",
      triggerBg: "rgba(17, 24, 39, 0.05)",
      triggerColor: "#6b7280",
    },

    Menu: {
      itemColor: "#6b7280",
      itemHoverColor: "#111827",
      itemSelectedColor: "#2563eb",
      itemActiveBg: "rgba(37, 99, 235, 0.08)",
      itemSelectedBg: "rgba(37, 99, 235, 0.1)",
      itemHoverBg: "rgba(17, 24, 39, 0.04)",
      itemBg: "transparent",
      itemBorderRadius: 8,
      itemMarginBlock: 4,
      itemMarginInline: 8,
      subMenuItemBg: "transparent",
      activeBarBorderWidth: 0,
      activeBarHeight: 0,
      groupTitleColor: "#9ca3af",
      groupTitleFontSize: 12,
      iconSize: 16,
      collapsedIconSize: 16,
    },

    Button: {
      controlHeight: 40,
      controlHeightLG: 48,
      controlHeightSM: 32,
      fontSize: 14,
      borderRadius: 8,
      borderRadiusLG: 10,
      borderRadiusSM: 6,
      paddingInline: 16,
      paddingInlineLG: 20,
      paddingInlineSM: 12,
      
      // Primary Button
      colorPrimary: "#2563eb",
      colorPrimaryHover: "#1d4ed8",
      colorPrimaryActive: "#1e40af",
      colorPrimaryTextHover: "#ffffff",
      colorPrimaryBg: "#2563eb",
      colorPrimaryBgHover: "#1d4ed8",
      primaryShadow: "0 0 0 2px rgba(37, 99, 235, 0.2)",
      
      // Default Button
      defaultBg: "#ffffff",
      defaultColor: "#374151",
      defaultBorderColor: "#d1d5db",
      defaultHoverBg: "#f9fafb",
      defaultHoverColor: "#111827",
      defaultHoverBorderColor: "#9ca3af",
      defaultActiveBg: "#f3f4f6",
      defaultActiveBorderColor: "#6b7280",
      
      // Ghost Button
      ghostBg: "transparent",
      colorBgTextHover: "rgba(17, 24, 39, 0.04)",
      colorBgTextActive: "rgba(17, 24, 39, 0.08)",
    },

    Card: {
      borderRadiusLG: 12,
      borderRadius: 8,
      paddingLG: 24,
      padding: 20,
      paddingSM: 16,
      headerBg: "#ffffff",
      headerHeight: 56,
      headerHeightSM: 48,
      actionsBg: "#fafafa",
      tabsMarginBottom: 16,
      colorBgContainer: "#ffffff",
      colorBorderSecondary: "#f3f4f6",
      boxShadowTertiary: "0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.06)",
      boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.06)",
    },

    Table: {
      headerBg: "#fafafa",
      headerColor: "#374151",
      headerSortActiveBg: "#f3f4f6",
      headerSortHoverBg: "#f9fafb",
      bodySortBg: "rgba(37, 99, 235, 0.02)",
      rowHoverBg: "#fafafa",
      rowSelectedBg: "rgba(37, 99, 235, 0.06)",
      rowSelectedHoverBg: "rgba(37, 99, 235, 0.08)",
      rowExpandedBg: "#fafafa",
      borderColor: "#f3f4f6",
      headerBorderRadius: 8,
      headerSplitColor: "#e5e7eb",
      fixedHeaderSortActiveBg: "#f3f4f6",
      headerFilterHoverBg: "#f9fafb",
      filterDropdownBg: "#ffffff",
      expandIconBg: "#ffffff",
      selectionColumnWidth: 60,
      stickyScrollBarBg: "rgba(0, 0, 0, 0.15)",
    },

    Tabs: {
      itemColor: "#6b7280",
      itemSelectedColor: "#2563eb",
      itemHoverColor: "#374151",
      itemActiveColor: "#2563eb",
      inkBarColor: "#2563eb",
      titleFontSize: 14,
      titleFontSizeLG: 16,
      titleFontSizeSM: 12,
      cardBg: "#ffffff",
      cardHeight: 48,
      cardPadding: "8px 16px",
      cardPaddingSM: "6px 12px",
      cardPaddingLG: "10px 20px",
      horizontalMargin: "0 0 0 32px",
      horizontalItemGutter: 32,
      verticalItemMargin: "8px 0",
      verticalItemPadding: "8px 16px",
    },

    Input: {
      borderRadius: 8,
      controlHeight: 40,
      controlHeightLG: 48,
      controlHeightSM: 32,
      fontSize: 14,
      paddingBlock: 10,
      paddingInline: 12,
      paddingBlockLG: 12,
      paddingInlineLG: 16,
      paddingBlockSM: 6,
      paddingInlineSM: 8,
      colorBgContainer: "#ffffff",
      colorBorder: "#d1d5db",
      hoverBorderColor: "#9ca3af",
      activeBorderColor: "#2563eb",
      activeBg: "#ffffff",
      hoverBg: "#ffffff",
      colorTextPlaceholder: "#9ca3af",
      addonBg: "#f9fafb",
      activeShadow: "0 0 0 2px rgba(37, 99, 235, 0.2)",
    },

    Select: {
      borderRadius: 8,
      controlHeight: 40,
      controlHeightLG: 48,
      controlHeightSM: 32,
      fontSize: 14,
      optionSelectedBg: "rgba(37, 99, 235, 0.1)",
      optionActiveBg: "rgba(17, 24, 39, 0.04)",
      optionSelectedColor: "#2563eb",
      optionSelectedFontWeight: 500,
      selectorBg: "#ffffff",
      clearBg: "#ffffff",
      multipleItemBg: "#f3f4f6",
      multipleItemBorderColor: "#e5e7eb",
      multipleItemHeight: 24,
      optionHeight: 32,
      optionPadding: "6px 12px",
      showArrowPaddingInlineEnd: 24,
      controlOutline: "rgba(37, 99, 235, 0.2)",
    },

    Dropdown: {
      colorBgElevated: "#ffffff",
      controlItemBgActive: "rgba(37, 99, 235, 0.08)",
      controlItemBgHover: "rgba(17, 24, 39, 0.04)",
      borderRadiusOuter: 8,
      borderRadiusLG: 10,
      paddingBlock: 8,
      fontSize: 14,
      lineHeight: 1.5,
    },

    Tooltip: {
      colorBgSpotlight: "#374151",
      colorTextLightSolid: "#ffffff",
      borderRadius: 6,
      borderRadiusOuter: 6,
    },

    Modal: {
      colorBgElevated: "#ffffff",
      headerBg: "#ffffff",
      titleColor: "#111827",
      titleFontSize: 18,
      borderRadiusLG: 12,
      borderRadius: 8,
      paddingMD: 24,
      paddingLG: 32,
      marginLG: 24,
      marginMD: 16,
    },

    Drawer: {
      colorBgElevated: "#ffffff",
      borderRadiusLG: 0,
      paddingLG: 24,
      colorIcon: "#6b7280",
      colorIconHover: "#374151",
    },

    Badge: {
      colorBgContainer: "#2563eb",
      colorError: "#ef4444",
      textFontSize: 12,
      textFontSizeSM: 10,
      indicatorHeight: 6,
      indicatorHeightSM: 4,
      dotSize: 6,
    },

    Progress: {
      remainingColor: "rgba(17, 24, 39, 0.06)",
      defaultColor: "#2563eb",
      circleTextColor: "#111827",
      lineBorderRadius: 100,
    },

    Segmented: {
      borderRadius: 8,
      borderRadiusLG: 10,
      borderRadiusSM: 6,
      trackBg: "#f3f4f6",
      trackPadding: 2,
      itemColor: "#6b7280",
      itemHoverColor: "#374151",
      itemHoverBg: "rgba(17, 24, 39, 0.04)",
      itemSelectedBg: "#ffffff",
      itemSelectedColor: "#2563eb",
      itemActiveBg: "#ffffff",
    },

    Switch: {
      colorPrimary: "#2563eb",
      colorPrimaryHover: "#1d4ed8",
      colorPrimaryBorder: "#2563eb",
      handleBg: "#ffffff",
      handleShadow: "0 2px 4px rgba(0, 0, 0, 0.18)",
      trackHeight: 22,
      trackMinWidth: 44,
      trackPadding: 2,
      handleSize: 18,
      handleSizeSM: 14,
      innerMinMargin: 3,
      innerMaxMargin: 24,
    },

    Slider: {
      railBg: "#f1f5f9",
      railHoverBg: "#e2e8f0",
      trackBg: "#2563eb",
      trackHoverBg: "#1d4ed8",
      handleColor: "#2563eb",
      handleSize: 14,
      handleSizeHover: 16,
      handleLineWidth: 2,
      handleLineWidthHover: 4,
      dotBorderColor: "#ffffff",
      dotActiveBorderColor: "#2563eb",
      trackBgDisabled: "#f1f5f9",
    },

    Steps: {
      borderRadius: 6,
      colorText: "#374151",
      colorTextDescription: "#6b7280",
      colorTextDisabled: "#d1d5db",
      colorPrimary: "#2563eb",
      colorSuccess: "#10b981",
      colorError: "#ef4444",
      iconTop: 0,
      iconSize: 32,
      iconSizeSM: 24,
      dotSize: 8,
      dotCurrentSize: 10,
      navArrowColor: "#9ca3af",
      titleLineHeight: 1.5,
      customIconTop: 0,
      customIconSize: 24,
      descriptionMaxWidth: 140,
    },

    Alert: {
      borderRadiusLG: 8,
      borderRadius: 6,
      paddingContentHorizontalLG: 24,
      withDescriptionIconSize: 24,
      withDescriptionPadding: "12px 16px",
      defaultPadding: "8px 12px",
    },

    Notification: {
      borderRadiusLG: 8,
      borderRadius: 6,
      fontSizeLG: 16,
      lineHeight: 1.5,
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
