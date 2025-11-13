import { ConfigProvider, Layout, Menu, Segmented, Space, Tag, theme, ThemeConfig } from 'antd';
import React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import UserDropdown from './components/UserDropdown';
import PortfolioBalanceModal from './components/PortfolioBalanceModal';
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
// import MonitorPageRefactored from './pages/MonitorPageRefactored';
import MonitorPageNew from './pages/MonitorPageNew';
import { useAppStore } from './store';
import { Activity, Bot, Lightbulb, ListChecks, Radio, Zap } from 'lucide-react';
import { api } from './api';

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

function AuthenticatedApp() {
  const navigate = useNavigate();
  const location = useLocation();
  const { mode, setMode } = useAppStore();
  const { overview, loadOverview } = useDashboard();
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
  const pnlValue = Number(overview?.pnlUsd ?? 0);
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
    { key: '/intelligence', label: 'Intelligence', icon: <Lightbulb /> },
    { key: '/backlog', label: 'Feed Info', icon: <Radio /> },
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
            gap: 8,
            padding: '24px 20px',
            borderBottom: '1px solid rgba(148, 163, 184, 0.12)'
          }}
        >
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
           <Zap className='w-5 h-5' />
          </div>
          <div>
            <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 16, lineHeight: 1.2 }}>QuantAI</div>
            <div style={{ color: '#60a5fa', fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.6 }}>Labs</div>
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
            gap: 20,
            background: 'rgba(8, 15, 35, 0.92)',
            borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
            boxShadow: '0 12px 25px -18px rgba(2, 6, 23, 0.8)',
            padding: '0 28px',
            height: 72,
            minHeight: 72,
            lineHeight: 'normal',
            flexWrap: 'nowrap',
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, height: '100%' }}>
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
                padding: '10px 16px',
                borderRadius: 18,
                border: '1px solid rgba(96, 165, 250, 0.32)',
                background: 'linear-gradient(135deg, rgba(37, 99, 235, 0.28), rgba(59, 130, 246, 0.38))',
                boxShadow: '0 24px 58px -32px rgba(59, 130, 246, 0.65)',
                minWidth: 200,
                display: 'grid',
                gridAutoRows: 'max-content',
                rowGap: 4,
                alignContent: 'center',
              }}
            >
              <div style={{ fontSize: 11, color: 'rgba(226, 232, 240, 0.78)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
                {balanceSubtitle}
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#f8fafc', lineHeight: 1 }}>{formattedBalance}</div>
              <div style={{ fontSize: 12, color: 'rgba(226, 232, 240, 0.7)' }}>
                {freeSubtitle}: {formattedFree}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ background: 'rgba(8, 15, 35, 0.78)', borderRadius: 14, padding: '8px 12px', minWidth: 100, display: 'grid', rowGap: 2 }}>
                <div style={{ color: 'rgba(148, 163, 184, 0.78)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                  ROI (realized)
                </div>
                <div style={{ color: roiValue >= 0 ? '#34d399' : '#f87171', fontWeight: 600, fontSize: 15, lineHeight: 1.1 }}>
                  {roiValue >= 0 ? '+' : '-'}{Math.abs(roiValue).toFixed(1)}%
                </div>
                {showNetRoi && (
                  <div style={{ color: netRoiValue >= 0 ? '#0ea5e9' : '#f87171', fontSize: 11, fontWeight: 500 }}>
                    Net {netRoiValue >= 0 ? '+' : '-'}{Math.abs(netRoiValue).toFixed(1)}%
                  </div>
                )}
              </div>
              <div style={{ background: 'rgba(8, 15, 35, 0.78)', borderRadius: 14, padding: '8px 12px', minWidth: 100, display: 'grid', rowGap: 2 }}>
                <div style={{ color: 'rgba(148, 163, 184, 0.78)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                  PnL
                </div>
                <div style={{ color: pnlValue >= 0 ? '#60a5fa' : '#f87171', fontWeight: 600, fontSize: 15, lineHeight: 1.1 }}>
                  {pnlValue >= 0 ? '+' : '-'}${Math.abs(pnlValue).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </div>
              </div>
              <div style={{ background: 'rgba(8, 15, 35, 0.78)', borderRadius: 14, padding: '8px 12px', minWidth: 80, display: 'grid', rowGap: 2 }}>
                <div style={{ color: 'rgba(148, 163, 184, 0.78)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                  Active
                </div>
                <div style={{ color: '#f8fafc', fontWeight: 600, fontSize: 15, lineHeight: 1.1 }}>{activeAgents}</div>
              </div>
          
            </div>
          </div>
          <Space size={18} align='center'>
            <Segmented
              size='small'
              value={mode}
              options={[
                { label: <span style={{ fontWeight: 600, color: mode === 'paper' ? '#60a5fa' : '#cbd5f5' }}>Paper</span>, value: 'paper' },
                { label: <span style={{ fontWeight: 600, color: mode === 'live' ? '#f87171' : '#cbd5f5' }}>Live</span>, value: 'live' },
              ]}
              onChange={(val) => setMode(val as 'live' | 'paper')}
              style={{ background: 'rgba(15, 23, 42, 0.85)', color: '#e2e8f0', borderRadius: 999, padding: 2 }}
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
            <Route path='/agents/:sessionId' element={<MonitorPageNew />} />
            {/* <Route path='/agents/:sessionId/old' element={<MonitorPageRefactored />} /> */}
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
        color: '#60a5fa' 
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

  return <AuthenticatedApp />;
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
