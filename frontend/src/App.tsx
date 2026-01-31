import { ConfigProvider, Drawer, Grid, Layout, Menu, Segmented, Space, Tag, theme, ThemeConfig } from 'antd';
import React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import UserDropdown from './components/UserDropdown';
import PortfolioBalanceModal from './components/PortfolioBalanceModal';
import { useAuth } from './hooks/useAuth';
import { useDashboard } from './hooks/useDashboard';
import ExecutionLedgerPageNew from './pages/ExecutionLedgerPageNew';
import LoginPage from './pages/LoginPage';
import OperationsDashboardPage from './pages/DashboardPageCompact';
import RegisterPage from './pages/RegisterPage';
import SessionsPage from './pages/SessionsPage';
import ReportsPage from './pages/ReportsPage';
import SessionCockpitPage from './pages/SessionCockpitPageNew';
import FeedPage from './pages/FeedPage';
import BacktestPage from './pages/BacktestPage';
import { useAppStore } from './store';
import { Activity, BarChart, Bot, ChevronLeft, ChevronRight, ListChecks, Radio, LineChart, Menu as MenuIcon, Sun, Moon } from 'lucide-react';
import { api } from './api';
import { TradeNotificationProvider } from './providers/TradeNotificationProvider';
import NotificationBell from './components/NotificationBell';

const resolveActiveMenuKey = (pathname: string) => {
  if (pathname.startsWith('/operations') || pathname.startsWith('/mission-control')) return '/operations';
  if (pathname.startsWith('/agents/')) return '/agents';
  if (pathname.startsWith('/agents')) return '/agents';
  if (pathname.startsWith('/ledger')) return '/ledger';
  if (pathname.startsWith('/reports')) return '/reports';
  if (pathname.startsWith('/feed')) return '/feed';
  if (pathname.startsWith('/backtest')) return '/backtest';
  return '/operations';
};

const { Header, Content, Footer } = Layout;

function AuthenticatedApp() {
  const navigate = useNavigate();
  const location = useLocation();
  const { mode, setMode, themeMode, toggleTheme } = useAppStore();
  const { overview, loadOverview } = useDashboard();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md; // md = 768px
  const [siderCollapsed, setSiderCollapsed] = React.useState(() => {
    try { return localStorage.getItem('siderCollapsed') === 'true'; } catch { return false; }
  });
  const [mobileDrawerOpen, setMobileDrawerOpen] = React.useState(false);
  const [balanceModalOpen, setBalanceModalOpen] = React.useState(false);
  const [paperCapital, setPaperCapital] = React.useState<{ totalUSD: number; freeUSD: number; reservedUSD: number; inPositionsUSD: number } | null>(null);
  const [liveCapital, setLiveCapital] = React.useState<{ totalUSD: number; freeUSD: number; reservedUSD: number; inPositionsUSD: number } | null>(null);

  const loadCapital = React.useCallback(async () => {
    try {
      const [paper, live] = await Promise.all([
        api.getCapitalSnapshot('paper').catch(() => null),
        api.getCapitalSnapshot('live').catch(() => null),
      ]);
      setPaperCapital(paper ?? null);
      setLiveCapital(live ?? null);
    } catch (error) {
      console.error('Unable to load capital snapshots', error);
    }
  }, []);

  const activeMenuKey = resolveActiveMenuKey(location.pathname);

  // Persist collapsed state
  React.useEffect(() => {
    try { localStorage.setItem('siderCollapsed', String(siderCollapsed)); } catch {}
  }, [siderCollapsed]);

  // Auto-close mobile drawer on route change
  React.useEffect(() => {
    setMobileDrawerOpen(false);
  }, [location.pathname]);

  React.useEffect(() => {
    void loadCapital();
  }, [mode, overview?.updatedAt, loadCapital]);

  const balanceValue = mode === 'live'
    ? Number(liveCapital?.totalUSD ?? 0)
    : Number(paperCapital?.totalUSD ?? 0);
  const freeValue = mode === 'live'
    ? Number(liveCapital?.freeUSD ?? 0)
    : Number(paperCapital?.freeUSD ?? 0);
  const formattedBalance = `$${balanceValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const formattedFree = `$${freeValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const balanceSubtitle = mode === 'live' ? 'Live exchange equity' : 'Paper equity';
  const freeSubtitle = mode === 'live' ? 'Free balance' : 'Available';
  const roiValue = Number(overview?.roiPct ?? 0);
  const netRoiCandidate = Number(overview?.netRoiPct);
  const netRoiValue = Number.isFinite(netRoiCandidate) ? netRoiCandidate : roiValue;
  const showNetRoi = Math.abs(netRoiValue - roiValue) > 0.05;
  
  // 📊 Use today's PnL for header display (matches Binance's daily view)
  const todayPnlValue = Number(overview?.todayPnlUsd ?? 0);
  const todayTrades = Number(overview?.todayTrades ?? 0);
  // Calculate today's ROI based on initial capital
  const initialCapital = Number(overview?.initialCapitalUsd ?? 0);
  const todayRoiValue = initialCapital > 0 ? (todayPnlValue / initialCapital) * 100 : 0;
  // Keep total PnL for tooltip/reference
  const totalPnlValue = Number(overview?.pnlUsd ?? 0);
  
  const activeAgents = overview?.activeCount ?? 0;
  const marketCoverage = Array.isArray(overview?.symbols) ? overview.symbols.length : 0;

  const handleBalanceUpdated = React.useCallback(() => {
    void loadOverview(true);
    void loadCapital();
  }, [loadOverview, loadCapital]);

  const handleBalanceClick = React.useCallback(() => {
    setBalanceModalOpen(true);
  }, []);


  const menuItems = [
    { key: '/operations', label: 'Control', icon: <Activity /> },
    { key: '/agents', label: 'Agents', icon: <Bot /> },
    { key: '/ledger', label: 'Execution', icon: <ListChecks /> },
    { key: '/reports', label: 'Reports', icon: <BarChart /> },
    { key: '/feed', label: 'Feed', icon: <Radio /> },
    { key: '/backtest', label: 'Backtest', icon: <LineChart /> },
  ];

  return (
    
    <Layout
      style={{
        minHeight: '100vh',
        background: 'var(--bg-primary)',
      }}
    >
      {/* Desktop sidebar */}
      {!isMobile && (
        <Layout.Sider
          collapsed={siderCollapsed}
          onCollapse={setSiderCollapsed}
          collapsedWidth={72}
          width={220}
          theme={themeMode}
          style={{
            background: 'var(--card-gradient)',
            borderRight: '1px solid var(--border-color)',
            boxShadow: 'var(--card-shadow)',
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: siderCollapsed ? 'center' : 'flex-start',
              padding: siderCollapsed ? '20px 0' : '20px 16px',
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            {siderCollapsed
              ? <img src="/favicon.svg" alt="Remezz" style={{ height: 28, width: 28 }} />
              : <img src="/remezz-logo.svg" alt="Remezz" style={{ height: 32 }} />
            }
          </div>
          <Menu
            theme={themeMode}
            mode='inline'
            inlineCollapsed={siderCollapsed}
            selectedKeys={[activeMenuKey]}
            items={menuItems}
            onClick={({ key }) => navigate(String(key))}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: 14,
              color: 'var(--text-primary)',
              padding: '12px 8px',
              flex: 1,
            }}
          />
          {!siderCollapsed && (
            <div style={{ padding: '18px', borderTop: '1px solid var(--border-subtle)' }}>
              <div style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 12, marginBottom: 4 }}>Signal Engine</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.4 }}>Detect the signal. Trade the momentum.</div>
            </div>
          )}
          <div
            role='button'
            tabIndex={0}
            onClick={() => setSiderCollapsed((c) => !c)}
            onKeyDown={(e) => { if (e.key === 'Enter') setSiderCollapsed((c) => !c); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '12px 0',
              cursor: 'pointer',
              borderTop: '1px solid var(--border-subtle)',
              color: 'var(--text-muted)',
            }}
            title={siderCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {siderCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </div>
        </Layout.Sider>
      )}

      {/* Mobile drawer */}
      <Drawer
        placement='left'
        open={mobileDrawerOpen}
        onClose={() => setMobileDrawerOpen(false)}
        width={260}
        styles={{
          body: {
            padding: 0,
            background: 'var(--card-gradient)',
          },
          header: {
            background: 'var(--bg-card)',
            borderBottom: '1px solid var(--border-subtle)',
          },
        }}
        title={<img src="/remezz-logo.svg" alt="Remezz" style={{ height: 28 }} />}
      >
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
            color: 'var(--text-primary)',
            padding: '12px 8px',
          }}
        />
        <div style={{ padding: '18px', borderTop: '1px solid var(--border-subtle)', marginTop: 'auto' }}>
          <div style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 12, marginBottom: 4 }}>Signal Engine</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.4 }}>Detect the signal. Trade the momentum.</div>
        </div>
      </Drawer>
      <Layout>
        <Header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 20,
            background: 'var(--bg-card)',
            borderBottom: '1px solid var(--border-color)',
            boxShadow: 'var(--card-shadow)',
            padding: '0 28px',
            height: 72,
            minHeight: 72,
            lineHeight: 'normal',
            flexWrap: 'nowrap',
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, height: '100%' }}>
            {isMobile && (
              <div
                role='button'
                tabIndex={0}
                onClick={() => setMobileDrawerOpen(true)}
                onKeyDown={(e) => { if (e.key === 'Enter') setMobileDrawerOpen(true); }}
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 4 }}
                title='Open menu'
              >
                <MenuIcon size={22} />
              </div>
            )}
            {/* Equity compact chip */}
            <div
              role='button'
              tabIndex={0}
              onClick={handleBalanceClick}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleBalanceClick();
                }
              }}
              style={{
                cursor: 'pointer',
                padding: '6px 14px',
                borderRadius: 10,
                border: '1px solid var(--border-color)',
                background: 'linear-gradient(135deg, rgba(6, 182, 212, 0.12), rgba(59, 130, 246, 0.12))',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                {mode === 'live' ? 'LIVE' : 'PAPER'}
              </span>
              <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>{formattedBalance}</span>
            </div>
            {/* Today's PnL - matches Binance daily view */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }} title={`Total: ${totalPnlValue >= 0 ? '+' : ''}$${totalPnlValue.toFixed(2)}`}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginRight: 4 }}>TODAY</span>
                <span style={{ color: todayPnlValue >= 0 ? 'var(--success)' : 'var(--error)', fontWeight: 600, fontSize: 15, fontFamily: "'JetBrains Mono', monospace" }}>
                  {todayPnlValue >= 0 ? '+' : ''}{todayPnlValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}$
                </span>
                <span style={{ color: todayRoiValue >= 0 ? 'var(--success)' : 'var(--error)', fontSize: 13, fontWeight: 500 }}>
                  ({todayRoiValue >= 0 ? '+' : ''}{todayRoiValue.toFixed(1)}%)
                </span>
              </div>
            </div>
          </div>
          <Space size={18} align='center'>
            <div
              role='button'
              tabIndex={0}
              onClick={toggleTheme}
              onKeyDown={(e) => { if (e.key === 'Enter') toggleTheme(); }}
              style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 6, borderRadius: 8, opacity: 0.7 }}
              title={themeMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {themeMode === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </div>
            <NotificationBell />
            <Segmented
              size='small'
              value={mode}
              options={[
                { label: <span style={{ fontWeight: 600, color: mode === 'paper' ? 'var(--accent)' : undefined }}>Paper</span>, value: 'paper' },
                { label: <span style={{ fontWeight: 600, color: mode === 'live' ? 'var(--error)' : undefined }}>Live</span>, value: 'live' },
              ]}
              onChange={(val) => setMode(val as 'live' | 'paper')}
              style={{ background: 'var(--bg-elevated)', borderRadius: 999, padding: 2 }}
            />
            {mode === 'live' && (
              <Tag color='error' style={{ borderRadius: 12, padding: '4px 10px', fontWeight: 600 }}>
                LIVE
              </Tag>
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
            <Route path='/ledger' element={<ExecutionLedgerPageNew />} />
            <Route path='/reports' element={<ReportsPage />} />
            <Route path='/feed' element={<FeedPage />} />
            <Route path='/backtest' element={<BacktestPage />} />
            <Route path='*' element={<Navigate to='/operations' replace />} />
          </Routes>
        </Content>
        <Footer
          style={{
            textAlign: 'center',
            background: 'var(--bg-card)',
            borderTop: '1px solid var(--border-color)',
            color: 'var(--text-secondary)',
            fontSize: 12,
            padding: '18px 24px',
          }}
        >
          Remezz · Signal Detection · Momentum Trading · AI Risk Governance
        </Footer>
        <PortfolioBalanceModal
          open={balanceModalOpen}
          mode={mode as 'live' | 'paper'}
          onClose={() => setBalanceModalOpen(false)}
          onUpdated={handleBalanceUpdated}
        />
      </Layout>
    </Layout>
  );
}

function AppInner() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { setInitialized, isInitialized } = useAppStore();

  React.useEffect(() => {
    if (!isInitialized) {
      setInitialized(true);
    }
  }, [isInitialized, setInitialized]);

  if (authLoading || !isInitialized) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        height: '100vh', 
        color: 'var(--accent)'
      }}>
        Loading…
      </div>
    );
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

  return (
    <TradeNotificationProvider>
      <AuthenticatedApp />
    </TradeNotificationProvider>
  );
}

const remezzDarkTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#06b6d4',
    colorInfo: '#3b82f6',
    colorSuccess: '#10b981',
    colorWarning: '#f59e0b',
    colorError: '#ef4444',
    colorBgLayout: '#0a0e1a',
    colorBgContainer: 'rgba(17, 24, 39, 0.92)',
    colorBgElevated: 'rgba(17, 24, 39, 0.95)',
    colorBorder: 'rgba(30, 58, 95, 0.6)',
    colorBorderSecondary: 'rgba(30, 58, 95, 0.35)',
    colorText: '#f1f5f9',
    colorTextSecondary: '#94a3b8',
    borderRadius: 12,
    wireframe: false,
  },
  components: {
    Layout: {
      headerBg: 'rgba(10, 14, 26, 0.92)',
      bodyBg: 'transparent',
    },
    Menu: {
      darkItemBg: 'transparent',
      darkItemSelectedBg: 'rgba(6, 182, 212, 0.15)',
      darkItemSelectedColor: '#06b6d4',
      darkItemColor: 'rgba(241, 245, 249, 0.85)',
    },
    Card: {
      colorBgContainer: 'rgba(17, 24, 39, 0.92)',
      colorBorderSecondary: 'rgba(30, 58, 95, 0.4)',
      headerBg: 'rgba(17, 24, 39, 0.92)',
      paddingLG: 24,
      borderRadiusLG: 18,
    },
    Table: {
      headerBg: 'rgba(17, 24, 39, 0.95)',
      colorBgContainer: 'rgba(17, 24, 39, 0.92)',
      borderColor: 'rgba(30, 58, 95, 0.35)',
    },
    Tag: {
      defaultBg: 'rgba(6, 182, 212, 0.12)',
      colorBorder: 'transparent',
    },
  },
};

const remezzLightTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: '#0891b2',
    colorInfo: '#2563eb',
    colorSuccess: '#059669',
    colorWarning: '#d97706',
    colorError: '#dc2626',
    colorBgLayout: '#f8fafc',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorBorder: '#e2e8f0',
    colorBorderSecondary: '#f1f5f9',
    colorText: '#0f172a',
    colorTextSecondary: '#64748b',
    borderRadius: 12,
    wireframe: false,
  },
  components: {
    Layout: {
      headerBg: '#ffffff',
      bodyBg: '#f8fafc',
    },
    Card: {
      colorBgContainer: '#ffffff',
      colorBorderSecondary: '#e2e8f0',
      headerBg: '#ffffff',
      paddingLG: 24,
      borderRadiusLG: 18,
    },
    Table: {
      headerBg: '#f8fafc',
      colorBgContainer: '#ffffff',
      borderColor: '#e2e8f0',
    },
    Tag: {
      defaultBg: 'rgba(6, 182, 212, 0.08)',
      colorBorder: 'transparent',
    },
  },
};

export default function App() {
  const themeMode = useAppStore((s) => s.themeMode);
  const activeTheme = themeMode === 'dark' ? remezzDarkTheme : remezzLightTheme;

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeMode);
  }, [themeMode]);

  return (
    <BrowserRouter>
      <ConfigProvider theme={activeTheme}>
        <AppInner />
      </ConfigProvider>
    </BrowserRouter>
  );
}
