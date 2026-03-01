/**
 * AppShell - Main application layout
 *
 * Sidebar navigation, header bar, content area, and footer.
 * Pure Tailwind + native HTML. No Ant Design dependencies.
 */

import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  BarChart,
  Bot,
  ChevronLeft,
  ChevronRight,
  LineChart,
  ListChecks,
  Menu as MenuIcon,
  Moon,
  Radio,
  Settings,
  Sun,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { AppMode } from '@/store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppShellProps {
  children: React.ReactNode;

  /** Current trading mode */
  mode: AppMode;
  /** Theme mode for logo filter */
  themeMode: 'dark' | 'light';

  /** Equity balance value (number) */
  balanceValue: number;
  /** Callback when the equity chip is clicked */
  onBalanceClick?: () => void;

  /** Today's PnL in USD */
  todayPnlValue: number;
  /** Today's ROI percentage */
  todayRoiValue: number;
  /** Total (all-time) PnL in USD -- shown in tooltip */
  totalPnlValue: number;

  /** Toggle between dark / light theme */
  onToggleTheme?: () => void;
  /** Switch trading mode */
  onModeChange?: (mode: AppMode) => void;

  /** Notification bell component (rendered as-is) */
  NotificationBell?: React.ReactNode;
  /** User dropdown component (rendered as-is) */
  UserDropdown?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Nav items definition
// ---------------------------------------------------------------------------

interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { path: '/operations', label: 'Control', icon: Activity },
  { path: '/agents', label: 'Agents', icon: Bot },
  { path: '/ledger', label: 'Execution', icon: ListChecks },
  { path: '/reports', label: 'Reports', icon: BarChart },
  { path: '/feed', label: 'Activity', icon: Radio },
  { path: '/backtest', label: 'Simulator', icon: LineChart },
];

const SETTINGS_ITEM: NavItem = { path: '/settings', label: 'Settings', icon: Settings };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveActiveKey(pathname: string): string {
  if (pathname.startsWith('/operations') || pathname.startsWith('/mission-control')) return '/operations';
  if (pathname.startsWith('/agents')) return '/agents';
  if (pathname.startsWith('/ledger')) return '/ledger';
  if (pathname.startsWith('/reports')) return '/reports';
  if (pathname.startsWith('/feed')) return '/feed';
  if (pathname.startsWith('/backtest')) return '/backtest';
  if (pathname.startsWith('/settings')) return '/settings';
  return '/operations';
}

function formatCurrency(value: number): string {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatPnl(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}$`;
}

function formatPct(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// useIsMobile hook (SSR-safe)
// ---------------------------------------------------------------------------

function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < breakpoint;
  });

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [breakpoint]);

  return isMobile;
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  activeKey: string;
  onNavigate: (path: string) => void;
  themeMode: 'dark' | 'light';
}

function Sidebar({ collapsed, onToggle, activeKey, onNavigate, themeMode }: SidebarProps) {
  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-40 flex flex-col border-r border-border bg-card transition-[width] duration-200',
        collapsed ? 'w-[72px]' : 'w-[220px]',
      )}
    >
      {/* Logo */}
      <div
        className={cn(
          'flex h-[72px] shrink-0 items-center border-b border-border',
          collapsed ? 'justify-center px-0' : 'px-4',
        )}
      >
        {collapsed ? (
          <img
            src="/favicon.svg"
            alt="Remezz"
            className="h-7 w-7"
          />
        ) : (
          <img
            src={themeMode === 'light' ? '/remezz-logo-light.svg' : '/remezz-logo.svg'}
            alt="Remezz"
            className="h-8"
          />
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <TooltipProvider delayDuration={0}>
          <ul className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeKey === item.path;
              const btn = (
                <button
                  onClick={() => onNavigate(item.path)}
                  className={cn(
                    'group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors cursor-pointer',
                    'hover:bg-primary/10 hover:text-primary',
                    isActive
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground',
                    collapsed && 'justify-center px-0',
                  )}
                >
                  <span className="shrink-0">
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </button>
              );

              if (collapsed) {
                return (
                  <li key={item.path}>
                    <Tooltip>
                      <TooltipTrigger asChild>{btn}</TooltipTrigger>
                      <TooltipContent side="right" sideOffset={8}>
                        {item.label}
                      </TooltipContent>
                    </Tooltip>
                  </li>
                );
              }

              return <li key={item.path}>{btn}</li>;
            })}
          </ul>
        </TooltipProvider>
      </nav>

      {/* Settings pinned at bottom */}
      <div className="px-2 pb-1">
        <TooltipProvider delayDuration={0}>
          {(() => {
            const Icon = SETTINGS_ITEM.icon;
            const isActive = activeKey === SETTINGS_ITEM.path;
            const btn = (
              <button
                onClick={() => onNavigate(SETTINGS_ITEM.path)}
                className={cn(
                  'group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors cursor-pointer',
                  'hover:bg-primary/10 hover:text-primary',
                  isActive
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground',
                  collapsed && 'justify-center px-0',
                )}
              >
                <span className="shrink-0">
                  <Icon className="h-[18px] w-[18px]" />
                </span>
                {!collapsed && <span className="truncate">{SETTINGS_ITEM.label}</span>}
              </button>
            );

            if (collapsed) {
              return (
                <Tooltip>
                  <TooltipTrigger asChild>{btn}</TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {SETTINGS_ITEM.label}
                  </TooltipContent>
                </Tooltip>
              );
            }

            return btn;
          })()}
        </TooltipProvider>
      </div>

      {/* Collapse toggle */}
      <button
        onClick={onToggle}
        className="flex items-center justify-center border-t border-border py-3 text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <ChevronRight className="h-[18px] w-[18px]" /> : <ChevronLeft className="h-[18px] w-[18px]" />}
      </button>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Mobile nav (drawer)
// ---------------------------------------------------------------------------

interface MobileNavProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeKey: string;
  onNavigate: (path: string) => void;
  themeMode: 'dark' | 'light';
}

function MobileNav({ open, onOpenChange, activeKey, onNavigate, themeMode }: MobileNavProps) {
  const handleNav = (path: string) => {
    onNavigate(path);
    onOpenChange(false);
  };

  // Prevent body scroll when open
  React.useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-[200] bg-black/50 transition-opacity"
          onClick={() => onOpenChange(false)}
        />
      )}

      {/* Drawer */}
      <aside
        className={cn(
          'fixed top-0 left-0 z-[201] flex h-full w-[280px] flex-col border-r border-border bg-card shadow-2xl transition-transform duration-300',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Header */}
        <div className="flex h-[72px] items-center justify-between border-b border-border bg-card px-5">
          <img
            src={themeMode === 'light' ? '/remezz-logo-light.svg' : '/remezz-logo.svg'}
            alt="Remezz"
            className="h-7"
          />
          <button
            onClick={() => onOpenChange(false)}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted cursor-pointer"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 px-3 py-4">
          <ul className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeKey === item.path;
              return (
                <li key={item.path}>
                  <button
                    onClick={() => handleNav(item.path)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors cursor-pointer',
                      'hover:bg-primary/10 hover:text-primary',
                      isActive
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground',
                    )}
                  >
                    <span className="shrink-0">
                      <Icon className="h-[18px] w-[18px]" />
                    </span>
                    <span>{item.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Settings pinned at bottom */}
        <div className="border-t border-border px-3 py-3">
          {(() => {
            const Icon = SETTINGS_ITEM.icon;
            const isActive = activeKey === SETTINGS_ITEM.path;
            return (
              <button
                onClick={() => handleNav(SETTINGS_ITEM.path)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors cursor-pointer',
                  'hover:bg-primary/10 hover:text-primary',
                  isActive
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground',
                )}
              >
                <span className="shrink-0">
                  <Icon className="h-[18px] w-[18px]" />
                </span>
                <span>{SETTINGS_ITEM.label}</span>
              </button>
            );
          })()}
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// AppShell
// ---------------------------------------------------------------------------

export default function AppShell({
  children,
  mode,
  themeMode,
  balanceValue,
  onBalanceClick,
  todayPnlValue,
  todayRoiValue,
  totalPnlValue,
  onToggleTheme,
  onModeChange,
  NotificationBell: NotificationBellSlot,
  UserDropdown: UserDropdownSlot,
}: AppShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const activeKey = resolveActiveKey(location.pathname);

  // Sidebar collapsed state (persisted)
  const [siderCollapsed, setSiderCollapsed] = React.useState<boolean>(() => {
    try {
      return localStorage.getItem('siderCollapsed') === 'true';
    } catch {
      return false;
    }
  });

  const [mobileDrawerOpen, setMobileDrawerOpen] = React.useState(false);

  // Persist collapsed state
  React.useEffect(() => {
    try {
      localStorage.setItem('siderCollapsed', String(siderCollapsed));
    } catch {
      // ignore storage errors
    }
  }, [siderCollapsed]);

  // Auto-close mobile drawer on route change
  React.useEffect(() => {
    setMobileDrawerOpen(false);
  }, [location.pathname]);

  const toggleCollapsed = React.useCallback(() => {
    setSiderCollapsed((prev) => !prev);
  }, []);

  const pnlIsPositive = todayPnlValue >= 0;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop Sidebar */}
      {!isMobile && (
        <Sidebar
          collapsed={siderCollapsed}
          onToggle={toggleCollapsed}
          activeKey={activeKey}
          onNavigate={navigate}
          themeMode={themeMode}
        />
      )}

      {/* Mobile Nav */}
      {isMobile && (
        <MobileNav
          open={mobileDrawerOpen}
          onOpenChange={setMobileDrawerOpen}
          activeKey={activeKey}
          onNavigate={navigate}
          themeMode={themeMode}
        />
      )}

      {/* Main area */}
      <div
        className={cn(
          'flex flex-1 flex-col transition-[margin-left] duration-200',
          !isMobile && (siderCollapsed ? 'ml-[72px]' : 'ml-[220px]'),
        )}
      >
        {/* Header */}
        <header className="flex h-[72px] shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-4 md:px-7">
          {/* Left section */}
          <div className="flex items-center gap-3 overflow-hidden md:gap-4">
            {/* Mobile hamburger */}
            {isMobile && (
              <button
                className="shrink-0 flex items-center justify-center h-9 w-9 rounded-md hover:bg-muted text-foreground cursor-pointer"
                onClick={() => setMobileDrawerOpen(true)}
                title="Open menu"
              >
                <MenuIcon className="h-5 w-5" />
              </button>
            )}

            {/* Equity chip */}
            <button
              onClick={onBalanceClick}
              className="flex shrink-0 items-center gap-2 rounded-xl border border-border bg-primary/10 px-3.5 py-1.5 transition-colors hover:bg-primary/20 cursor-pointer"
            >
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {mode === 'live' ? 'LIVE' : 'PAPER'}
              </span>
              <span className="text-base font-bold text-foreground">
                {formatCurrency(balanceValue)}
              </span>
            </button>

            {/* Today's PnL */}
            <div
              className="hidden items-baseline gap-1 sm:flex"
              title={`Total: ${totalPnlValue >= 0 ? '+' : ''}$${totalPnlValue.toFixed(2)}`}
            >
              <span className="mr-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                TODAY
              </span>
              <span
                className={cn(
                  'font-mono text-[15px] font-semibold',
                  pnlIsPositive ? 'text-success' : 'text-destructive',
                )}
              >
                {formatPnl(todayPnlValue)}
              </span>
              <span
                className={cn(
                  'text-[13px] font-medium',
                  pnlIsPositive ? 'text-success' : 'text-destructive',
                )}
              >
                ({formatPct(todayRoiValue)})
              </span>
            </div>
          </div>

          {/* Right section */}
          <div className="flex items-center gap-2 md:gap-4">
            {/* Theme toggle */}
            <button
              onClick={onToggleTheme}
              title={themeMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="flex items-center justify-center h-9 w-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer transition-colors"
            >
              {themeMode === 'dark' ? (
                <Sun className="h-[18px] w-[18px]" />
              ) : (
                <Moon className="h-[18px] w-[18px]" />
              )}
            </button>

            {/* Notification bell */}
            {NotificationBellSlot}

            {/* Mode toggle (Paper / Live) */}
            <div className="flex items-center rounded-full border border-border bg-muted p-0.5">
              <button
                onClick={() => onModeChange?.('paper')}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-semibold transition-colors cursor-pointer',
                  mode === 'paper'
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Paper
              </button>
              <button
                onClick={() => onModeChange?.('live')}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-semibold transition-colors cursor-pointer',
                  mode === 'live'
                    ? 'bg-destructive text-destructive-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Live
              </button>
            </div>

            {/* LIVE badge */}
            {mode === 'live' && (
              <span className="hidden md:inline-flex rounded-full bg-destructive/15 text-destructive border border-destructive/30 px-2.5 py-1 text-[10px] font-bold">
                LIVE
              </span>
            )}

            {/* Separator */}
            <div className="hidden md:block h-8 w-px bg-border" />

            {/* User dropdown */}
            {UserDropdownSlot}
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-auto p-6 md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
