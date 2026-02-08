# Frontend — QuantAILabs Trading Dashboard

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 18 + TypeScript |
| Build | Vite 5 + `@tailwindcss/vite` |
| Styling | Tailwind CSS v4 + CSS variables (HSL) |
| UI Components | shadcn/ui (Radix UI primitives + CVA) |
| State | Zustand (persisted) |
| Forms | React Hook Form + Zod |
| Tables | TanStack React Table (via DataTable shared component) |
| Charts | Recharts (area/bar/pie) + Lightweight Charts (candlestick) |
| Icons | Lucide React |
| Toasts | Sonner |
| Routing | React Router v6 |
| HTTP | Axios |
| Tests | Vitest + Testing Library |

## Commands

```bash
npm run dev        # Start dev server (Vite, port 5173)
npm run build      # TypeScript check + production build
npx vite build     # Production build (skip tsc — tsc may hang on Node v22)
npm test           # Run Vitest
npm run lint       # ESLint
npm run format     # Prettier check
```

**Known issues**: `tsc -b` can hang on Node v22.14.0. Use `npx vite build` directly when verifying builds.

## Project Structure

```
src/
├── api.ts                    # Axios API client (DO NOT MODIFY lightly)
├── store.ts                  # Zustand store: mode, theme, auth (DO NOT MODIFY lightly)
├── ws.ts                     # WebSocket client (DO NOT MODIFY)
├── App.tsx                   # Root: BrowserRouter, routes, Toaster, theme
├── main.tsx                  # Entry point
├── components/
│   ├── ui/                   # shadcn/ui primitives (26 files)
│   ├── shared/               # Reusable business components
│   │   ├── StatCard.tsx      # Metric display card
│   │   ├── PnlDisplay.tsx    # PnL with color + sign
│   │   ├── StatusBadge.tsx   # Status indicator badges
│   │   ├── PageHeader.tsx    # Page title + actions
│   │   ├── DataTable.tsx     # TanStack table wrapper
│   │   ├── EmptyState.tsx    # Empty data placeholder
│   │   ├── LoadingSkeleton.tsx
│   │   ├── ConfirmDialog.tsx # Confirmation modal
│   │   ├── RefreshIndicator.tsx
│   │   └── DateRangePicker.tsx
│   ├── layout/
│   │   └── AppShell.tsx      # Sidebar + header + content layout
│   ├── cockpit/              # Session cockpit sub-components
│   │   ├── CockpitHeader.tsx
│   │   ├── LiveMetricsBar.tsx
│   │   ├── PositionBanner.tsx
│   │   ├── OrdersTradesPanel.tsx
│   │   ├── PerformanceSummary.tsx
│   │   └── ActivityFeed.tsx
│   ├── charts/
│   │   └── ProfessionalChart.tsx  # Lightweight Charts candlestick
│   ├── AgentCreationModal.tsx
│   ├── PortfolioBalanceModal.tsx
│   ├── UserDropdown.tsx
│   └── NotificationBell.tsx
├── pages/
│   ├── DashboardPageCompact.tsx   # /operations — main dashboard
│   ├── SessionsPage.tsx           # /agents — agent list
│   ├── SessionCockpitPageNew.tsx  # /agents/:sessionId — agent cockpit
│   ├── ExecutionLedgerPageNew.tsx # /ledger — trade history
│   ├── ReportsPage.tsx            # /reports — daily reports + parity
│   ├── FeedPage.tsx               # /feed — live signal radar
│   ├── BacktestPage.tsx           # /backtest — backtesting
│   ├── SettingsPage.tsx           # /settings — profile, API keys, prefs
│   ├── LoginPage.tsx              # /login
│   └── RegisterPage.tsx           # /register
├── hooks/
│   ├── useAuth.ts            # Authentication state
│   ├── useDashboard.ts       # Dashboard overview data
│   ├── useDataCache.ts       # SWR-style single data cache
│   ├── useMultiDataCache.ts  # SWR-style multi-key data cache
│   ├── useSessionState.ts    # Per-session state (cockpit)
│   ├── useReportsCache.ts    # Reports data cache
│   ├── useSessionsCache.ts   # Sessions list cache
│   ├── useStopAllConfirmation.tsx  # Emergency stop all
│   └── useCacheNotifications.ts
├── providers/
│   └── TradeNotificationProvider.tsx  # WebSocket trade notifications
├── types/
│   ├── cockpit.ts            # Cockpit component prop types
│   ├── strategies.ts         # Strategy type definitions
│   └── ops.ts                # Operations types
├── styles/
│   ├── tailwind.css          # Tailwind entry + HSL theme variables
│   ├── global.css            # Legacy CSS variables + auth/agent styles
│   └── sessionMonitor.css    # Cockpit layout styles
└── lib/
    ├── utils.ts              # cn() helper (clsx + tailwind-merge)
    └── toast.ts              # Sonner toast wrapper
```

## Theming

- **Dark/light** toggle via `.dark` class on `<html>` (standard shadcn/ui)
- Theme state in Zustand store: `themeMode: 'dark' | 'light'`
- **Two CSS files define theme variables** (both use `.dark` class selector):
  - `src/styles/tailwind.css` — HSL variables for shadcn/ui (`--background`, `--card`, `--border`, etc.)
  - `src/styles/global.css` — Legacy hex/rgba variables for cockpit `<style>` blocks (`--bg-primary`, `--text-secondary`, etc.)
- `:root` in both files = **light** defaults; `.dark` block = **dark** overrides
- Dark background is `#0f172a` (slate-900, ~11% lightness) — not pure black
- **Prefer Tailwind semantic colors** (`text-foreground`, `bg-card`, `text-muted-foreground`, `text-success`, `text-destructive`) over legacy `var(--text-primary)` / `var(--bg-card)` in new code
- Use `hsl(var(--primary))` pattern in Tailwind config; legacy `var(--success)` only in existing cockpit inline styles
- `ProfessionalChart.tsx` reads `themeMode` from Zustand and recreates the chart on theme switch via `getChartColors(isDark)` helper

## Patterns & Conventions

### Styling
- Use Tailwind utility classes, not inline styles
- Use `cn()` from `@/lib/utils` for conditional classes
- **Badges**: `inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold w-fit` with `bg-{color}/15 text-{color}`
- **PnL coloring**: `text-success` (positive) / `text-destructive` (negative) — not raw `text-green-400`/`text-red-400`
- **Tables**: CSS Grid divs (not `<table>`), matching ExecutionLedgerPageNew pattern: `overflow-auto rounded-2xl border border-border bg-card` wrapper, `grid` rows with `hover:bg-muted/30`, `text-[11px]` cells
- Monospace for numbers: `font-mono`

### Components
- **Modals**: Use shadcn `Dialog` (not `window.confirm` for complex flows)
- **Toasts**: Use `toast` from `@/lib/toast` (wraps Sonner)
- **Tables**: Prefer CSS Grid div pattern (see ExecutionLedgerPageNew, SessionsPage) or `DataTable` shared component
- **Icons**: Import from `lucide-react` directly
- **Forms**: React Hook Form + Zod schemas for validation
- **Tooltips**: Always wrap in `TooltipProvider` when using multiple tooltips

### Data Flow
- Pages fetch data via hooks (`useDashboard`, `useMultiDataCache`, `useDataCache`, `useReportsCache`)
- Hooks call `api.*` methods (Axios)
- Paper/live mode from `useAppStore().mode` — triggers data refetch on switch
- WebSocket events via `ws.ts` for live feed and trade notifications
- All nullable API fields must use `?? 0` or `?.` guards — shadcn components don't auto-handle null like antd did

### Path Aliases
- `@/*` maps to `./src/*` (configured in `vite.config.ts` + `tsconfig.json`)

## Routes

| Path | Page | Description |
|------|------|-------------|
| `/operations` | DashboardPageCompact | Main operations dashboard |
| `/agents` | SessionsPage | Agent list (table + cards view) |
| `/agents/:sessionId` | SessionCockpitPageNew | Agent cockpit with live data |
| `/ledger` | ExecutionLedgerPageNew | Trade execution history |
| `/reports` | ReportsPage | Daily reports + parity verification |
| `/feed` | FeedPage | Live signal radar + activity |
| `/backtest` | BacktestPage | Backtesting interface |
| `/settings` | SettingsPage | Profile, API keys, preferences |
| `/login` | LoginPage | Authentication |
| `/register` | RegisterPage | Registration |

## Do NOT Modify

These files are critical infrastructure — change only with good reason:
- `api.ts` — API client used by all pages
- `store.ts` — Global Zustand store
- `ws.ts` — WebSocket connection manager
- `hooks/useDataCache.ts`, `hooks/useMultiDataCache.ts` — SWR-style cache layer
- `components/ui/*` — shadcn/ui primitives (standard, not custom)
