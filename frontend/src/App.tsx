import { AreaChartOutlined, BulbOutlined, ControlOutlined, ReadOutlined, WarningOutlined } from '@ant-design/icons';
import { ConfigProvider, Layout, Menu, Segmented, Space, Tag, theme, ThemeConfig } from 'antd';
import React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import UserDropdown from './components/UserDropdown';
import { useAuth } from './hooks/useAuth';
import { useDashboard } from './hooks/useDashboard';
import BacklogPage from './pages/BacklogPage';
import ExecutionLedgerPage from './pages/ExecutionLedgerPage';
import IntelligencePage from './pages/IntelligencePage';
import LoginPage from './pages/LoginPage';
import OperationsDashboardPage from './pages/OperationsDashboardPage';
import RegisterPage from './pages/RegisterPage';
import SessionCockpitPage from './pages/SessionCockpitPage';
import SessionsPage from './pages/SessionsPage';
import { useAppStore } from './store';

const resolveActiveMenuKey = (pathname: string) => {
  if (pathname.startsWith('/operations') || pathname.startsWith('/mission-control')) return '/operations';
  if (pathname.startsWith('/agents/')) return '/agents';
  if (pathname.startsWith('/agents')) return '/agents';
  if (pathname.startsWith('/ledger')) return '/ledger';
  if (pathname.startsWith('/intelligence')) return '/intelligence';
  if (pathname.startsWith('/backlog')) return '/backlog';
  return '/operations';
};

const { Header, Content, Footer } = Layout;

function AppInner() {
  const navigate = useNavigate();
  const location = useLocation();

  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { mode, setMode, setInitialized, isInitialized } = useAppStore();
  const { overview } = useDashboard();

  React.useEffect(() => {
    if (!isInitialized) {
      setInitialized(true);
    }
  }, [isInitialized, setInitialized]);

  if (authLoading || !isInitialized) {
    return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', color: '#60a5fa' }}>Loading…</div>;
  }

  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path='/login' element={<LoginPage />} />
        <Route path='/register' element={<RegisterPage />} />
        <Route path='*' element={<Navigate to='/login' replace />} />
      </Routes>
    );
  }

  const activeMenuKey = resolveActiveMenuKey(location.pathname);

  const menuItems = [
    { key: '/operations', label: 'Operations', icon: <AreaChartOutlined /> },
    { key: '/agents', label: 'Agents', icon: <ControlOutlined /> },
    { key: '/ledger', label: 'Execution Ledger', icon: <ReadOutlined /> },
    { key: '/intelligence', label: 'Intelligence', icon: <BulbOutlined /> },
    { key: '/backlog', label: 'Activity Feed', icon: <WarningOutlined /> },
  ];

  return (
    <Layout
      style={{
        minHeight: '100vh',
        background: 'radial-gradient(circle at top, #102045 0%, #050b1b 60%, #02050f 100%)',
      }}
    >
      <Layout.Sider
        breakpoint='lg'
        collapsedWidth={72}
        theme='dark'
        style={{
          background: 'linear-gradient(180deg, #111c44 0%, #0b1120 100%)',
          borderRight: '1px solid rgba(148, 163, 184, 0.18)',
          boxShadow: '0 12px 35px -18px rgba(2, 6, 23, 0.9)',
          zIndex: 100,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '24px 18px',
            borderBottom: '1px solid rgba(148, 163, 184, 0.12)',
            marginBottom: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 12,
                background: 'linear-gradient(135deg, #38bdf8 0%, #6366f1 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#0f172a',
                fontSize: 16,
                fontWeight: 700,
              }}
            >
              Q
            </div>
            <div>
              <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 16, lineHeight: 1.2 }}>QuantAI</div>
              <div style={{ color: '#60a5fa', fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.6 }}>Labs</div>
            </div>
          </div>
        </div>
        <Menu
          theme='dark'
          mode='inline'
          selectedKeys={[activeMenuKey]}
          items={menuItems}
          onClick={({ key }) => navigate(String(key))}
          style={{
            background: 'transparent',
            border: 'none',
            fontSize: 14,
            color: '#e2e8f0',
            padding: '12px 8px',
          }}
        />
        <div style={{ padding: '18px', borderTop: '1px solid rgba(148, 163, 184, 0.12)', marginTop: 'auto' }}>
          <div style={{ color: '#60a5fa', fontWeight: 600, fontSize: 12, marginBottom: 4 }}>Pulse Engine</div>
          <div style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 11, lineHeight: 1.4 }}>Live trade intelligence & AI risk governance</div>
        </div>
      </Layout.Sider>
      <Layout>
        <Header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'rgba(8, 15, 35, 0.92)',
            borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
            boxShadow: '0 12px 25px -18px rgba(2, 6, 23, 0.8)',
            padding: '0 28px',
            height: 72,
          }}
        >
          <Space size={20} style={{ color: '#cbd5f5', fontWeight: 500, fontSize: 14 }}>
            <span style={{ color: 'rgba(148, 163, 184, 0.72)' }}>Active agents</span>
            <Tag color='blue' style={{ borderRadius: 8, fontSize: 12 }}>
              {overview?.activeCount ?? 0}
            </Tag>
            {Array.isArray(overview?.symbols) && overview.symbols.length > 0 && (
              <span style={{ color: 'rgba(148, 163, 184, 0.72)', fontSize: 12 }}>
                {overview.symbols.length} markets monitored
              </span>
            )}
          </Space>
          <Space size={16} style={{ color: '#e2e8f0', fontWeight: 500, fontSize: 14 }}>
            <Segmented
              size='small'
              value={mode}
              options={[
                { label: 'Live', value: 'live' },
                { label: 'Paper', value: 'paper' },
              ]}
              onChange={(val) => setMode(val as 'live' | 'paper')}
              style={{ background: 'rgba(15, 23, 42, 0.88)', color: '#e2e8f0', borderRadius: 20 }}
            />
            <span style={{ color: 'rgba(148, 163, 184, 0.72)' }}>ROI</span>
            <Tag color={(Number(overview?.roiPct || 0) >= 0) ? 'success' : 'error'} style={{ borderRadius: 8, fontSize: 12 }}>
              {Number(overview?.roiPct || 0).toFixed(2)}%
            </Tag>
            <span style={{ color: 'rgba(148, 163, 184, 0.72)' }}>PnL</span>
            <Tag color={(Number(overview?.pnlUsd || 0) >= 0) ? 'success' : 'error'} style={{ borderRadius: 8, fontSize: 12 }}>
              ${Number(overview?.pnlUsd || 0).toFixed(2)}
            </Tag>
            <span style={{ color: 'rgba(148, 163, 184, 0.72)' }}>AI</span>
            <Tag color='cyan' style={{ borderRadius: 8, fontSize: 12 }}>
              {Number(overview?.aiCallsTotal || 0)}
            </Tag>
            {mode === 'live' && overview?.exchangeBalance && (
              <>
                <span style={{ color: '#60a5fa', fontWeight: 600 }}>Exchange</span>
                <Tag color='cyan' style={{ borderRadius: 8, fontSize: 12 }}>
                  Free ${Number(overview.exchangeBalance.freeUsd || 0).toFixed(2)}
                </Tag>
                <Tag color='geekblue' style={{ borderRadius: 8, fontSize: 12 }}>
                  Equity ${Number(overview.exchangeBalance.totalUsd || 0).toFixed(2)}
                </Tag>
              </>
            )}
            {mode === 'paper' && overview?.paperBalance && (
              <>
                <span style={{ color: '#60a5fa', fontWeight: 600 }}>Paper</span>
                <Tag color='cyan' style={{ borderRadius: 8, fontSize: 12 }}>
                  Free ${Number(overview.paperBalance.freeUsd || 0).toFixed(2)}
                </Tag>
                <Tag color='purple' style={{ borderRadius: 8, fontSize: 12 }}>
                  Equity ${Number(overview.paperBalance.equityUsd || 0).toFixed(2)}
                </Tag>
              </>
            )}
            <UserDropdown />
          </Space>
        </Header>
        <Content
          style={{
            padding: '32px',
            overflow: 'auto',
            maxHeight: 'calc(100vh - 144px)',
            background: 'transparent',
          }}
        >
          <Routes>
            <Route path='/' element={<Navigate to='/operations' replace />} />
            <Route path='/operations' element={<OperationsDashboardPage />} />
            <Route path='/mission-control' element={<Navigate to='/operations' replace />} />
            <Route path='/agents/:sessionId' element={<SessionCockpitPage />} />
            <Route path='/agents' element={<SessionsPage />} />
            <Route path='/ledger' element={<ExecutionLedgerPage />} />
            <Route path='/intelligence' element={<IntelligencePage />} />
            <Route path='/backlog' element={<BacklogPage />} />
            <Route path='*' element={<Navigate to='/operations' replace />} />
          </Routes>
        </Content>
        <Footer
          style={{
            textAlign: 'center',
            background: 'rgba(8, 15, 35, 0.92)',
            borderTop: '1px solid rgba(148, 163, 184, 0.14)',
            color: 'rgba(148, 163, 184, 0.72)',
            fontSize: 12,
            padding: '18px 24px',
          }}
        >
          Realtime AI Trade Engine · Adaptive Risk Governance · Storyboarded Insights
        </Footer>
      </Layout>
    </Layout>
  );
}

export default function App() {
  const neoDarkTheme: ThemeConfig = {
    algorithm: theme.darkAlgorithm,
    token: {
      colorPrimary: '#60a5fa',
      colorInfo: '#38bdf8',
      colorSuccess: '#34d399',
      colorWarning: '#fbbf24',
      colorError: '#f87171',
      colorBgLayout: '#050b1b',
      colorBgContainer: 'rgba(15, 23, 42, 0.92)',
      colorBgElevated: 'rgba(15, 23, 42, 0.92)',
      colorBorder: 'rgba(148, 163, 184, 0.22)',
      colorBorderSecondary: 'rgba(148, 163, 184, 0.14)',
      colorText: '#e2e8f0',
      colorTextSecondary: 'rgba(148, 163, 184, 0.78)',
      borderRadius: 12,
      wireframe: false,
    },
    components: {
      Layout: {
        headerBg: 'rgba(8, 15, 35, 0.92)',
        bodyBg: 'transparent',
      },
      Menu: {
        darkItemBg: 'transparent',
        darkItemSelectedBg: 'rgba(96, 165, 250, 0.2)',
        darkItemSelectedColor: '#60a5fa',
        darkItemColor: 'rgba(226, 232, 240, 0.85)',
      },
      Card: {
        colorBgContainer: 'rgba(15, 23, 42, 0.92)',
        colorBorderSecondary: 'rgba(148, 163, 184, 0.16)',
        headerBg: 'rgba(15, 23, 42, 0.92)',
        paddingLG: 24,
        borderRadiusLG: 18,
      },
      Table: {
        headerBg: 'rgba(15, 23, 42, 0.95)',
        colorBgContainer: 'rgba(15, 23, 42, 0.92)',
        borderColor: 'rgba(148, 163, 184, 0.14)',
      },
      Tag: {
        defaultBg: 'rgba(148, 163, 184, 0.14)',
        colorBorder: 'transparent',
      },
    },
  };

  return (
    <BrowserRouter>
      <ConfigProvider theme={neoDarkTheme}>
        <AppInner />
      </ConfigProvider>
    </BrowserRouter>
  );
}
