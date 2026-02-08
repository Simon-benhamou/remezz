import React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import AppShell from '@/components/layout/AppShell';
import UserDropdown from '@/components/UserDropdown';
import PortfolioBalanceModal from '@/components/PortfolioBalanceModal';
import NotificationBell from '@/components/NotificationBell';
import { useAuth } from '@/hooks/useAuth';
import { useDashboard } from '@/hooks/useDashboard';
import ExecutionLedgerPageNew from '@/pages/ExecutionLedgerPageNew';
import LoginPage from '@/pages/LoginPage';
import OperationsDashboardPage from '@/pages/DashboardPageCompact';
import RegisterPage from '@/pages/RegisterPage';
import SessionsPage from '@/pages/SessionsPage';
import ReportsPage from '@/pages/ReportsPage';
import SessionCockpitPage from '@/pages/SessionCockpitPageNew';
import FeedPage from '@/pages/FeedPage';
import BacktestPage from '@/pages/BacktestPage';
import SettingsPage from '@/pages/SettingsPage';
import { useAppStore } from '@/store';
import { api } from '@/api';
import { TradeNotificationProvider } from '@/providers/TradeNotificationProvider';

function AuthenticatedApp() {
  const navigate = useNavigate();
  const { mode, setMode, themeMode, toggleTheme } = useAppStore();
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

  React.useEffect(() => {
    void loadCapital();
  }, [mode, overview?.updatedAt, loadCapital]);

  const balanceValue = mode === 'live'
    ? Number(liveCapital?.totalUSD ?? 0)
    : Number(paperCapital?.totalUSD ?? 0);

  // Today's PnL for header display (matches Binance's daily view)
  const todayPnlValue = Number(overview?.todayPnlUsd ?? 0);
  // Calculate today's ROI based on initial capital
  const initialCapital = Number(overview?.initialCapitalUsd ?? 0);
  const todayRoiValue = initialCapital > 0 ? (todayPnlValue / initialCapital) * 100 : 0;
  // Keep total PnL for tooltip/reference
  const totalPnlValue = Number(overview?.pnlUsd ?? 0);

  const handleBalanceUpdated = React.useCallback(() => {
    void loadOverview(true);
    void loadCapital();
  }, [loadOverview, loadCapital]);

  const handleBalanceClick = React.useCallback(() => {
    setBalanceModalOpen(true);
  }, []);

  return (
    <>
      <AppShell
        mode={mode}
        themeMode={themeMode}
        balanceValue={balanceValue}
        onBalanceClick={handleBalanceClick}
        todayPnlValue={todayPnlValue}
        todayRoiValue={todayRoiValue}
        totalPnlValue={totalPnlValue}
        onToggleTheme={toggleTheme}
        onModeChange={setMode}
        NotificationBell={<NotificationBell />}
        UserDropdown={<UserDropdown />}
      >
        <Routes>
          <Route path="/" element={<Navigate to="/operations" replace />} />
          <Route path="/operations" element={<OperationsDashboardPage />} />
          <Route path="/mission-control" element={<Navigate to="/operations" replace />} />
          <Route path="/agents/:sessionId" element={<SessionCockpitPage />} />
          <Route path="/agents" element={<SessionsPage />} />
          <Route path="/ledger" element={<ExecutionLedgerPageNew />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/feed" element={<FeedPage />} />
          <Route path="/backtest" element={<BacktestPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/operations" replace />} />
        </Routes>
      </AppShell>

      <PortfolioBalanceModal
        open={balanceModalOpen}
        mode={mode as 'live' | 'paper'}
        onClose={() => setBalanceModalOpen(false)}
        onUpdated={handleBalanceUpdated}
      />
    </>
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
      <div className="flex items-center justify-center h-screen text-primary">
        Loading...
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <TradeNotificationProvider>
      <AuthenticatedApp />
    </TradeNotificationProvider>
  );
}

export default function App() {
  const themeMode = useAppStore((s) => s.themeMode);

  React.useEffect(() => {
    const root = document.documentElement;
    if (themeMode === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [themeMode]);

  return (
    <BrowserRouter>
      <TooltipProvider>
        <AppInner />
        <Toaster
          theme={themeMode}
          position="top-right"
          richColors
          closeButton
        />
      </TooltipProvider>
    </BrowserRouter>
  );
}
