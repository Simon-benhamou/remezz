import { ConfigProvider, Layout, Menu, Space, Tag, theme, ThemeConfig, Segmented } from 'antd';
import React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, clearApiKey, getApiKey } from './api';
import DashboardPage from './pages/DashboardPage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import MonitorPage from './pages/MonitorPage';
import SessionsPage from './pages/SessionsPage';
import TestingPage from './pages/TestingPage';
import ReportsPage from './pages/ReportsPage';
import TradesJournalPage from './pages/TradesJournalPage';
import BacklogPage from './pages/BacklogPage';
import { AreaChartOutlined, ControlOutlined, BulbOutlined, FileTextOutlined, ReadOutlined, WarningOutlined } from '@ant-design/icons';
import { useAuth } from './hooks/useAuth';
import { useDashboard } from './hooks/useDashboard';
import { useAppStore } from './store';
import UserDropdown from './components/UserDropdown';
  const { Header, Content, Footer } = Layout;

function AppInner(){
  const navigate = useNavigate();
  const location = useLocation();

  // Use Zustand stores
  const { isAuthenticated, isLoading: authLoading, signOut } = useAuth();
  const { mode, setMode, setInitialized, isInitialized } = useAppStore();
  const { overview } = useDashboard();

  // Initialize app
  React.useEffect(() => {
    if (!isInitialized) {
      setInitialized(true);
    }
  }, [isInitialized, setInitialized]);

  // Logout handler
  const handleLogout = () => {
    signOut();
    clearApiKey();
    window.location.href = '/login';
  };

  // Attendre l'initialisation
  if (authLoading || !isInitialized) {
    return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>Loading...</div>;
  }

  const authed = isAuthenticated;
  if (!authed) {
    return (
      <Routes>
        <Route path='/login' element={<LoginPage />} />
        <Route path='/register' element={<RegisterPage />} />
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
            <UserDropdown />
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
 const minimalistTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: {
    // Couleurs principales ultra-réduites
    colorPrimary: '#2563eb',      // Bleu principal uniquement
    colorSuccess: '#059669',      // Vert très discret
    colorError: '#dc2626',        // Rouge minimal
    
    // Tout le reste en gris neutres
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorBgLayout: '#fafafa',
    colorBorder: '#e5e7eb',
    colorBorderSecondary: '#f3f4f6',
    
    // Textes en niveaux de gris
    colorText: '#111827',
    colorTextSecondary: '#6b7280',
    colorTextTertiary: '#9ca3af',
    colorTextQuaternary: '#d1d5db',
    
    // Suppression des couleurs secondaires
    colorInfo: '#6b7280',         // Gris au lieu de bleu
    colorWarning: '#9ca3af',      // Gris au lieu d'orange
    
    // Espacement et bordures plus généreux
    borderRadius: 8,
    lineWidth: 1,
    wireframe: false,
  },
  components: {
    // Tags ultra-neutres
    Tag: {
      defaultBg: '#f9fafb',
      defaultColor: '#6b7280',
      colorBorder: '#e5e7eb',
    },
    // Tables épurées
    Table: {
      headerBg: '#f9fafb',
      headerColor: '#374151',
      borderColor: '#f3f4f6',
      rowHoverBg: '#f9fafb',
    },
    // Cards minimalistes
    Card: {
      headerBg: '#ffffff',
      bodyPadding: 20,
      actionsBg: '#fafafa',
    },
    // Menu sidebar épuré
    Menu: {
      itemSelectedBg: '#f1f5f9',
      itemSelectedColor: '#2563eb',
      itemHoverBg: '#f8fafc',
      itemColor: '#64748b',
    }
  }
};
  return (
    <BrowserRouter>
      <ConfigProvider theme={minimalistTheme}>
        <AppInner />
      </ConfigProvider>
    </BrowserRouter>
  );
}
