# Session Cockpit Page Redesign

## Overview

Complete redesign of the SessionCockpitPage to create a professional, context-dependent trading dashboard with real-time monitoring, historical analysis, and strategy validation capabilities.

**Design Philosophy:**
- Context-dependent density (IN_POSITION vs WATCHING states)
- PnL-focused header with hero numbers
- Full-width professional chart with indicators
- Conditional position banner with health status
- Smart defaults based on session state
- Dark trading theme with subtle mode indicators

---

## Phase 1: Backend Data Gaps

### 1.1 Trailing Stop State Enhancement

**Current:** Backend has trailing data but not fully exposed via API.

**File:** `backend/src/server.ts` (agent state endpoint)

**Changes needed:**
```typescript
// Enhance /api/agent/state response to include:
{
  pos: {
    // existing fields...
    trailingState: {
      active: boolean;
      activatedAt: number | null;      // timestamp when trailing activated
      updateCount: number;              // how many times trailing moved
      currentStopPrice: number;         // current trailing stop level
      peakPrice: number;                // highest price since entry (for long)
      distanceFromPeak: number;         // percentage drawdown from peak
    };
    healthStatus: 'progressing' | 'watching' | 'stagnant' | 'at_risk';
    healthReason: string;               // why this status
    holdDurationMs: number;             // time since entry
  }
}
```

**Implementation:**
- Extract trailing state from `simpleAgent.ts` position object
- Add health status calculation based on backend stagnant detection
- Expose via existing `/api/agent/state` endpoint

### 1.2 Parity Verification for Session

**Current:** Parity verification exists but not aggregated per session.

**File:** `backend/src/routes/perf.ts`

**New endpoint or enhance existing:**
```typescript
// GET /api/perf/parity?sessionId=xxx
{
  totalTrades: number;
  matchedTrades: number;
  matchRate: number;           // percentage
  mismatches: Array<{
    tradeId: string;
    liveExitReason: string;
    btExitReason: string;
    pnlDiff: number;
  }>;
  status: 'healthy' | 'warning' | 'critical';
}
```

### 1.3 Session Activity Feed Enhancement

**Current:** Feed logs exist but may not include all signal radar events.

**File:** `backend/src/server.ts` (agent logs endpoint)

**Changes needed:**
- Ensure Signal Radar events are included in session-filtered logs
- Include trailing stop updates as log events
- Include market condition changes relevant to session

### 1.4 WebSocket Event Enhancement

**File:** `backend/src/services/binanceWebSocket.ts` or WS handler

**New events to broadcast:**
```typescript
// Position health status change
{ type: 'position_health', data: { sessionId, status, reason } }

// Trailing stop update
{ type: 'trailing_update', data: { sessionId, oldStop, newStop, peak, updateCount } }
```

---

## Phase 2: Frontend Components

### 2.1 File Structure

```
frontend/src/
├── pages/
│   └── SessionCockpitPage.tsx          # Complete rewrite
├── components/
│   └── cockpit/
│       ├── CockpitHeader.tsx           # New - PnL hero + sparkline
│       ├── LiveMetricsBar.tsx          # Refactored from LiveMetrics
│       ├── TradingChart.tsx            # Enhanced ProfessionalChart
│       ├── PositionBanner.tsx          # New - conditional position strip
│       ├── HealthGauge.tsx             # New - visual price gauge
│       ├── OrdersTradesPanel.tsx       # New - tabbed with filters
│       ├── PerformanceSummary.tsx      # New - simplified + parity
│       └── ActivityFeed.tsx            # New - session signals
├── hooks/
│   ├── useSessionState.ts              # New - centralized session state
│   ├── usePositionHealth.ts            # New - health status logic
│   └── useTrailingStop.ts              # New - trailing state
└── types/
    └── cockpit.ts                      # New - type definitions
```

### 2.2 Component Specifications

#### CockpitHeader.tsx
```typescript
interface CockpitHeaderProps {
  symbol: string;
  netPnl: number;
  roiPct: number;
  mode: 'paper' | 'live';
  state: 'WATCHING' | 'IN_POSITION' | 'HALT';
  wsConnected: boolean;
  sparklineData: number[];  // last 20 prices
}
```
- Hero numbers: PnL + ROI, large font, green/red color
- Mini sparkline using lightweight canvas or SVG
- Subtle badges for mode, state, connection
- No action buttons (WebSocket handles updates)

#### LiveMetricsBar.tsx
```typescript
interface LiveMetricsBarProps {
  symbol: string;
  price: number;
  ticker: TickerData;
  status: 'loading' | 'live' | 'stale' | 'error';
}
```
- Improved dark theme styling
- Better spacing and typography
- Keep all current metrics (price, 24h, high/low, volume, bid/ask)

#### TradingChart.tsx
```typescript
interface TradingChartProps {
  symbol: string;
  sessionId: string;
  position: PositionInfo | null;
  closedTrades: Trade[];          // for markers when WATCHING
  sessionState: 'WATCHING' | 'IN_POSITION';
}
```
- Full width layout
- Timeframe buttons: 1m, 15m, 1h, 4h
- Indicator toggles: BB, Volume, Momentum
- Position levels: entry, stop, trailing (when IN_POSITION)
- Entry/exit markers (when WATCHING)
- Bollinger Bands overlay
- Volume panel below
- Momentum/ROC panel below (collapsible)

#### PositionBanner.tsx
```typescript
interface PositionBannerProps {
  position: {
    side: 'long' | 'short';
    entry: number;
    currentPrice: number;
    pnlUsd: number;
    pnlPct: number;
    rMultiple: number;
    stopPrice: number;
    stopDistancePct: number;
    trailingState: TrailingState;
    healthStatus: HealthStatus;
    healthReason: string;
    holdDurationMs: number;
    peakPrice: number;
    drawdownFromPeak: number;
  };
  onClose?: () => void;
}
```
- Horizontal banner layout
- Color-coded health status (border + badge)
- Visual gauge showing price between stop and peak
- Key metrics in columns
- Only renders when position exists

#### HealthGauge.tsx
```typescript
interface HealthGaugeProps {
  stopPrice: number;
  currentPrice: number;
  peakPrice: number;
  side: 'long' | 'short';
}
```
- Horizontal bar visualization
- Stop on left, Peak on right
- Current price marker
- Color gradient (red near stop, green near peak)

#### OrdersTradesPanel.tsx
```typescript
interface OrdersTradesPanelProps {
  orders: Order[];
  trades: Trade[];
  defaultTab: 'orders' | 'trades';  // based on session state
  filters: FilterState;
  onFilterChange: (filters: FilterState) => void;
}

interface FilterState {
  symbol?: string;
  side?: 'long' | 'short';
  result?: 'win' | 'loss' | 'breakeven';
  dateRange?: [Date, Date];
}
```
- Tabbed interface with improved styling
- Smart default tab based on session state
- Filter bar with dropdowns
- Sortable columns
- Dark theme table styling

#### PerformanceSummary.tsx
```typescript
interface PerformanceSummaryProps {
  winRate: number;
  expectancy: number;
  totalTrades: number;
  parity: {
    matchRate: number;
    matched: number;
    total: number;
    status: 'healthy' | 'warning' | 'critical';
  };
}
```
- Single horizontal row, compact
- Win rate with progress bar
- Expectancy per trade
- Parity match rate with status indicator

#### ActivityFeed.tsx
```typescript
interface ActivityFeedProps {
  sessionId: string;
  events: ActivityEvent[];
}

interface ActivityEvent {
  timestamp: string;
  type: 'entry' | 'exit' | 'trail' | 'signal' | 'info' | 'warn' | 'error';
  message: string;
  details?: string;
}
```
- Color-coded type badges
- Compact row layout
- Real-time updates via WebSocket
- Scrollable, last ~15 visible

### 2.3 Custom Hooks

#### useSessionState.ts
```typescript
function useSessionState(sessionId: string) {
  // Centralized state management for:
  // - Session status
  // - Position data
  // - Trailing state
  // - Health status
  // - WebSocket connection
  // - Real-time updates

  return {
    session,
    position,
    trailingState,
    healthStatus,
    wsConnected,
    refresh,
  };
}
```

#### usePositionHealth.ts
```typescript
function usePositionHealth(position: Position | null) {
  // Derives health status from backend state
  // Does NOT compute locally - mirrors backend

  return {
    status: 'progressing' | 'watching' | 'stagnant' | 'at_risk';
    reason: string;
    color: string;
  };
}
```

---

## Phase 3: Implementation Steps

### Step 1: Backend - Trailing State Enhancement
- [ ] Modify `/api/agent/state` to include full trailing state
- [ ] Add health status calculation to agent state
- [ ] Add WebSocket events for trailing updates
- [ ] Test with existing sessions

### Step 2: Backend - Parity Endpoint
- [ ] Create/enhance parity aggregation per session
- [ ] Add to `/api/perf` or create `/api/perf/parity`
- [ ] Test with sessions that have parity data

### Step 3: Backend - Activity Feed Enhancement
- [ ] Ensure Signal Radar events included in session logs
- [ ] Add trailing stop updates to log events
- [ ] Test log filtering by sessionId

### Step 4: Frontend - Types & Hooks
- [ ] Create `types/cockpit.ts` with all interfaces
- [ ] Implement `useSessionState` hook
- [ ] Implement `usePositionHealth` hook
- [ ] Implement `useTrailingStop` hook

### Step 5: Frontend - Core Components
- [ ] Create `CockpitHeader` with sparkline
- [ ] Refactor `LiveMetricsBar` with improved styling
- [ ] Create `PositionBanner` with health gauge
- [ ] Create `HealthGauge` visualization

### Step 6: Frontend - Chart Enhancement
- [ ] Enhance `TradingChart` with full-width layout
- [ ] Add Bollinger Bands indicator
- [ ] Add Volume panel
- [ ] Add Momentum panel (collapsible)
- [ ] Add indicator toggle buttons
- [ ] Context-dependent markers (position vs closed trades)

### Step 7: Frontend - Tables & Panels
- [ ] Create `OrdersTradesPanel` with tabs and filters
- [ ] Create `PerformanceSummary` with parity
- [ ] Create `ActivityFeed` with session signals

### Step 8: Frontend - Main Page Assembly
- [ ] Rewrite `SessionCockpitPage.tsx`
- [ ] Wire up all components
- [ ] Implement context-dependent rendering
- [ ] Connect WebSocket for real-time updates

### Step 9: Styling
- [ ] Create/update CSS for dark trading theme
- [ ] Ensure responsive layout
- [ ] Test on different screen sizes
- [ ] Verify color consistency

### Step 10: Testing
- [ ] Unit tests for hooks (health calculation, state derivation)
- [ ] Component tests for each new component
- [ ] Integration test for full page
- [ ] Manual testing: WATCHING state
- [ ] Manual testing: IN_POSITION state
- [ ] Manual testing: state transitions
- [ ] WebSocket real-time update testing

---

## Phase 4: Testing Plan

### Unit Tests

**Hooks:**
- `usePositionHealth`: Test all health status derivations
- `useSessionState`: Test state management and updates
- `useTrailingStop`: Test trailing state parsing

**Components:**
- `HealthGauge`: Test gauge rendering for different positions
- `PerformanceSummary`: Test parity status display
- `ActivityFeed`: Test event filtering and rendering

### Integration Tests

- Full page render with mock data
- WebSocket event handling
- State transitions (WATCHING → IN_POSITION → WATCHING)
- Filter functionality in OrdersTradesPanel

### Manual Testing Checklist

- [ ] Page loads correctly for paper session
- [ ] Page loads correctly for live session
- [ ] Position banner appears when IN_POSITION
- [ ] Position banner hides when WATCHING
- [ ] Health status updates in real-time
- [ ] Trailing stop updates reflected immediately
- [ ] Chart shows correct indicators
- [ ] Chart timeframe switching works
- [ ] Orders tab shows by default when IN_POSITION
- [ ] Trades tab shows by default when WATCHING
- [ ] Filters work correctly
- [ ] Performance shows accurate parity data
- [ ] Activity feed updates in real-time
- [ ] Sparkline updates with price changes
- [ ] Mobile responsive layout works

---

## Technical Notes

### Performance Considerations
- Memoize heavy components (chart, tables)
- Debounce rapid WebSocket updates
- Virtual scrolling for long trade lists
- Lazy load chart indicators

### WebSocket Events to Handle
- `tick` - price updates
- `price_update` - real-time price
- `agent_state` - position/health changes
- `trailing_update` - trailing stop moves (new)
- `position_health` - health status change (new)
- `orders` - order updates
- `alert` - activity feed events

### State Dependencies
```
SessionCockpitPage
├── useSessionState (central)
│   ├── session status
│   ├── position data
│   ├── trailing state
│   └── health status
├── ticker data (separate, high frequency)
├── orders/trades (separate, lower frequency)
└── performance/parity (separate, on-demand)
```

---

## Success Criteria

1. **Readability:** Information hierarchy clear at a glance
2. **Context-aware:** UI adapts to WATCHING vs IN_POSITION
3. **Real-time:** All critical data updates without manual refresh
4. **Professional:** Dark theme, clean typography, consistent spacing
5. **Complete:** All backend data utilized intelligently
6. **Performant:** No lag during rapid price updates
7. **Validated:** Parity verification visible for strategy confidence
