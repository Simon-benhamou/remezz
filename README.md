# 🤖 QuantAI Trading Agent V5.40

**An intelligent, momentum-based cryptocurrency trading system with regime-adaptive strategy and shared architecture design**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-18+-61DAFB.svg)](https://reactjs.org/)
[![License](https://img.shields.io/badge/license-Private-red.svg)]()

## ⚠️ CRITICAL ARCHITECTURE RULE
═══════════════════════════════════════════════════════════════

**ALL strategy logic MUST be implemented in shared files:**

- **Entry Logic**: `momentumSimple.ts` → `checkMomentumSignal()`
- **Exit Logic**: `momentumSimple.ts` → `shouldExitPosition()`
- **Signal Scoring**: `signalRanker.ts` → `calculateSignalScore()`
- **Configuration**: `momentumSimple.ts` → `MomentumConfig`

**NEVER duplicate logic in backtest or production.**
**NEVER hardcode thresholds.**
**ALWAYS import from shared files.**

⚠️ **Breaking this rule WILL cause backtest-production divergence.**

This architecture ensures that:
1. Backtest and production use identical strategy logic
2. Any strategy change automatically propagates to both environments
3. Configuration changes happen in one place (`MomentumConfig`)
4. Signal scoring is consistent across backtest and live trading

See [Architecture](#-architecture) section for detailed explanation.

═══════════════════════════════════════════════════════════════

## 📋 Table of Contents

- [Overview](#-overview)
- [Performance](#-performance)
- [Trading Strategy V5.40](#-trading-strategy-v540)
- [Entry Conditions](#-entry-conditions)
- [Exit Management](#-exit-management)
- [Capital Management](#-capital-management)
- [Risk Management](#️-risk-management)
- [Architecture](#️-architecture)
- [Installation & Setup](#-installation--setup)
- [Backtesting](#-backtesting)
- [Claude Code Skills](#-claude-code-skills)
- [API Documentation](#-api-documentation)
- [Contributing](#-contributing)

---

## 🎯 Overview

QuantAI Trading Agent is a sophisticated algorithmic trading platform for cryptocurrency futures markets. The system uses a **momentum breakout strategy** with **BTC regime filtering** and **intelligent exit management** to execute trades on Binance Futures.

### What Makes This System Unique?

- **Shared Architecture**: Backtest and production use identical code paths (near-perfect parity)
- **Regime-Adaptive Strategy**: LONG only in Bull markets (BTC > SMA200), SHORT only in Bear markets
- **Bollinger Band Breakouts**: Entry on volatility expansion with volume confirmation
- **Smart Stagnant Trade Detection**: V5.34 optimized exit for stuck positions (+31% improvement)
- **Momentum Exhaustion Protection**: V5.40 tightens trailing on successful but stagnating trades (NEW)
- **Adaptive Trailing Stop**: Volatility-based trailing distance (0.3-0.8%)
- **Enhanced Signal Ranking**: Multi-factor scoring when capital is limited
- **Shared Capital Pool**: Multiple agents share capital for efficient allocation
- **Real-time Execution**: WebSocket-based 1m candle confirmations for exits

---

## 📈 Performance

**Backtested over 24 months (Nov 2023 - Nov 2025):**

### V5.34 Optimized Results

| Metric | Value |
|--------|-------|
| **Total ROI** | +501% (after fees, slippage, funding) |
| **Win Rate** | 55.2% |
| **Total Trades** | 4,943 over 24 months |
| **Avg PnL per Trade** | +0.10% |
| **Max Drawdown** | ~38.5% |
| **Positive Months** | 21/24 (87.5%) |
| **Sharpe Ratio** | 1.85 |

### Key Improvements (V5.34 vs V5.31)

- **Total PnL**: +501% vs +383% (+31% improvement)
- **Stagnant Trade Logic**: Don't exit when profitable, just tighten SL and let it run
- **Recovery Threshold**: 0.6% (up from 0.4%) - better at detecting big moves forming
- **Observation Window**: 60min (down from 90min) - faster decision making

### Top Performing Assets (24-month backtest)

| Asset | ROI | Win Rate | Trades |
|-------|-----|----------|--------|
| 🏆 DOGE | +438% | 65.5% | 412 |
| 🏆 IMX | +344% | 67.9% | 398 |
| 🏆 SEI | +280% | 65.8% | 421 |
| 🏆 SUI | +266% | 65.4% | 387 |
| XRP | +185% | 65.0% | 445 |
| ETH | +173% | 67.8% | 456 |
| ADA | +173% | 65.8% | 402 |
| DOT | +173% | 64.8% | 389 |
| LINK | +143% | 65.9% | 378 |
| AVAX | +118% | 66.1% | 391 |
| SOL | +111% | 65.5% | 423 |
| BTC | +65% | 69.9% | 489 |

---

## 📊 Trading Strategy V5.40

### Strategy Evolution

- **V5.40**: **NEW** Momentum exhaustion protection for successful trades (tightens trailing when momentum fades)
- **V5.34**: Optimized stagnant trade detection (+31% total PnL improvement)
- **V5.33**: Breakout confirmation filter (DISABLED - reduced trades without WR improvement)
- **V5.32**: Anticipatory entry (DISABLED - underperformed classic breakout by 27x)

### Regime Filter: BTC vs SMA200

The strategy uses BTC's position relative to its 200-period SMA (on 15m candles = ~50 hours) to determine market regime:

```
BTC > SMA200  →  🟢 BULL MARKET  →  LONG trades only
BTC < SMA200  →  🔴 BEAR MARKET  →  SHORT trades only
```

This prevents:
- Going LONG in downtrends (catching falling knives)
- Going SHORT in uptrends (fighting the trend)

### Signal Ranking System (V5.22+)

When capital is limited and multiple signals appear, the system ranks them by quality score:

**Multi-Factor Scoring Formula** (`signalRanker.ts`):
1. **BB Position (30%)** - Buy low, sell high within bands
2. **ROC Momentum (25%)** - Strong directional movement
3. **Volume (20%)** - Confirmation strength (capped at 3x)
4. **ATR Filter (15%)** - Penalty for excessive volatility
5. **Trend Strength (10%)** - SMA50 alignment bonus

Only the **top N signals** (where N = available position slots) are executed.

---

## 🟢 Entry Conditions

### LONG Entry (Bull Regime: BTC > SMA200)

**All conditions must be TRUE:**

| # | Filter | Condition | Purpose |
|---|--------|-----------|---------|
| 1 | **Bullish Candle** | `close > open` | Confirms upward momentum |
| 2 | **BB Breakout** | `close > Bollinger Upper Band (20, 2σ)` | Confirmed breakout |
| 3 | **ROC10 ≥ 1.75%** | Price up 1.75%+ over 10 periods | Strong momentum (V5.13 optimized) |
| 4 | **Volume ≥ 1.15x** | Volume ≥ 1.15× 20-period average | Volume confirmation (V5.13) |
| 5 | **Consecutive Up ≤ 5** | Max 5 green candles in a row | Avoids buying tops (V5.12) |

### SHORT Entry (Bear Regime: BTC < SMA200)

**All conditions must be TRUE:**

| # | Filter | Condition | Purpose |
|---|--------|-----------|---------|
| 1 | **Bearish Candle** | `close < open` | Confirms downward momentum |
| 2 | **ROC5 ≤ -1.5%** | Price down 1.5%+ over 5 periods | Significant drop |
| 3 | **Volume ≥ 2x** | Volume ≥ 2× 20-period average | Panic selling confirmed |
| 4 | **Price < MA20** | Close under 20-period MA | Bearish trend |
| 5 | **BB Breakdown** | `close < Bollinger Lower Band` | Confirmed breakdown |
| 6 | **Consecutive Down ≤ 4** | Max 4 red candles in a row | Avoids oversold extremes |
| 7 | **StochRSI Filter** | StochRSI ≥ 15 OR Volume ≥ 4x | Skip oversold unless panic (V5.9) |

---

## 🚪 Exit Management

### Exit Priority (checked in order)

1. **Regime Change Exit** (V5.13 + V5.27 volume confirmation)
2. **Momentum Reversal** (ROC5 flips against position)
3. **Stop Loss** (Fixed 2.5% or stagnant-tightened 0.8%)
4. **Trailing Stop** (Adaptive 0.3-0.8% distance, with V5.40 momentum exhaustion tightening)
5. **Take Profit** (+3.0%)
6. **Max Hold Time** (48 hours)
7. **Smart Stagnant Trade** (V5.34 optimized)

### V5.40 Momentum Exhaustion (NEW)

**Problem**: Trade reaches significant profit (e.g., 15% ROI) with trailing active, but momentum exhausts and price stagnates without hitting the trailing stop yet.

**Solution**: Detect momentum exhaustion and tighten trailing stop:

```
When:
  ✓ Position has profit > 5% (successful trade)
  ✓ Trailing stop is already active
  ✓ ROC5 < 0.3% (short-term momentum weak)
  ✓ ROC10 < 0.5% (medium-term trend weakening)

Action:
  → Tighten trailing distance from 0.5-0.8% to 0.3%
  → Brings trailing stop closer to current price
  → Protects more profit while still giving trade a chance
```

**Example**: 
- Trade at 15% profit with trailing at 0.5% distance
- Trailing stop at ~14.5% (15% - 0.5%)
- Momentum exhausts → distance tightens to 0.3%
- New trailing stop at ~14.7% (15% - 0.3%)
- More profit protected, but trade can still continue if momentum resumes

**Key Insight**: This complements V5.34 stagnant trade logic. V5.34 handles EARLY stagnation (before trailing activates), while V5.40 handles LATE stagnation (on already successful trades).

### V5.34 Smart Stagnant Trade Detection

**Problem**: Positions that get stuck without momentum waste capital.

**Solution**: 3-phase observation system:

```
Phase 1: TRIGGER (at 45min)
  └─ If maxPnL < 0.8% → Enter observation mode

Phase 2: OBSERVE (45min to 105min total)
  ├─ Track peak PnL during window
  └─ If peak ≥ 0.6% → Big move forming, CANCEL stagnant status

Phase 3: CONFIRM (at 105min)
  ├─ If NOT cancelled → Tighten SL from 2.5% to 0.8%
  └─ Let position continue (don't exit immediately!)
```

**Key Insight**: Don't exit stagnant trades if they're in profit. Just tighten the stop loss and let them run - many recover into big winners.

**Performance**: +501% total PnL vs +383% for immediate exit (+31% improvement)

### Adaptive Trailing Stop (V5.14)

Trailing distance adapts to volatility:

| ATR Regime | Distance | Activation | Use Case |
|------------|----------|------------|----------|
| **Low Vol** (ATR < 2%) | 0.3% | +0.6% | Tight protection in calm markets |
| **Medium Vol** | 0.5% | +0.8% | Default balanced approach |
| **High Vol** (ATR > 3.5%) | 0.8% | +1.2% | Wide buffer in volatile markets |

**Smart Widening** (V5.12):
- Distance starts at 0.5% when profit reaches +0.8%
- Distance widens to 0.8% when profit reaches +2.0%
- Lets big winners run while protecting early gains

### Regime Change Exit (V5.27)

Exits position when BTC regime flips **WITH volume confirmation**:

```typescript
// Example: LONG position opened when BTC > SMA200
if (BTC crosses below SMA200 AND volume ≥ 1.5x average) {
  exit();  // Regime changed with conviction
}
```

**Volume confirmation prevents whipsaws** when BTC oscillates around SMA200 in choppy markets.

**Backtest validation**: +1.4% PnL, -0.5% MaxDD vs no confirmation

---

## 💰 Capital Management

### Shared Capital Pool Architecture

All agents share a single capital pool per mode (paper/live):

```
Total Capital: $10,000
├── Available: $6,000     (free for new positions)
├── Reserved: $0          (pre-order hold)
└── In Position: $4,000   (margin locked in open positions)
    ├── SEI: $2,600
    └── ETH: $1,400
```

**Flow**:
1. Agent detects signal → **Reserve** capital
2. Order placed successfully → **Commit** reserved capital to position
3. Position closed → **Release** capital back to pool (+ PnL in paper mode)

**Live Mode Sync**: Total capital syncs with real Binance balance every 30s via WebSocket

### Position Sizing (V5.18 Adaptive)

Dynamic sizing based on account capital:

```typescript
// Base Config
BASE_SIZE = 40%                  // Each trade uses 40% of available capital
BOOST_PER_5K = 3%                // +3% per $5k total capital
MAX_SIZE = 55%                   // Cap at 55%

// Example: $10k account
positionSize = min(40% + (10/5) * 3%, 55%) = min(46%, 55%) = 46%

// Example: $50k account
positionSize = min(40% + (50/5) * 3%, 55%) = min(70%, 55%) = 55% (capped)

// Position Calculation
Available: $6,000
Margin: 46% × $6,000 = $2,760
Leverage: 5x
Notional: $2,760 × 5 = $13,800 exposure
```

### Dynamic Max Positions (V5.18)

Number of concurrent positions scales with capital:

```typescript
maxPositions = min(
  BASE_POSITIONS + floor(capital / $1500) * 1,
  MAX_CAP
)

// Examples:
$500 account   → max(2 + 0, 2) = 2 positions
$3,000 account → max(2 + 2, 10) = 4 positions
$10,000 account → max(2 + 6, 10) = 8 positions
$20,000+ account → max(2 + 13+, 10) = 10 positions (capped)
```

**Rationale**: Larger accounts can diversify across more assets for better capital utilization and risk spreading.

### Liquidity Caps (V5.5)

Position size is capped based on asset liquidity tier to prevent slippage:

| Tier | Assets | Max Notional |
|------|--------|--------------|
| **HIGH** | BTC, ETH | $500,000 |
| **MEDIUM** | XRP, SOL, DOGE, ADA, AVAX, LINK, LTC, BCH, UNI | $100,000 |
| **LOW** | SEI, IMX, DOT, SUI, SONIC, APT | $25,000 |

**Example**: Even if position sizing formula says to open $200k position in SEI, it will be capped at $25k.

### Leverage (V5.8)

**Uniform 5x leverage** across all assets:

```typescript
LEVERAGE = 5x for all symbols
```

**Safety**: Max SL of 4.5% × 5x = 22.5% loss (far below 80% liquidation threshold)

**Backtest validation**: 24-month backtest with 5x leverage showed **zero liquidation events**.

---

## 🛡️ Risk Management

### Stop Loss Protection

**Fixed 2.5% Stop Loss**:
- Exchange emergency stop: 2.5% from entry (wide crash protection)
- App-side stops: Checked on 1m klines for faster reaction

**Stagnant Trade Tightening**:
- If position confirmed stagnant (stuck for 105min without movement)
- SL tightens from 2.5% → 0.8%
- Protects capital while allowing position to continue

### Realtime Exit Monitoring

**1m Kline Confirmations** (V5.14):
```typescript
// Config
KLINE_INTERVAL = '1m'
CONFIRM_CANDLES = 2  // Require 2 consecutive 1m closes below stop

// Example LONG position
Trailing stop: $100.50
├─ 1m close #1: $100.45 (below stop)
├─ 1m close #2: $100.40 (below stop again)
└─ EXIT confirmed (not just a wick)
```

**Prevents noise exits** from brief price spikes that don't close candles.

### Daily Loss Limit

Per-agent daily PnL is tracked. When daily loss reaches the configured limit, trading is paused with notification until next day.

**Configurable per agent** to prevent runaway losses during bad market conditions.

### Circuit Breaker

Cooldown periods after consecutive losses:

| Trigger | Cooldown |
|---------|----------|
| **3 consecutive losses** | 5-15 min |
| **4 consecutive losses** | 15-25 min |
| **5+ consecutive losses** | 30-45 min |

**Prevents revenge trading** during drawdown periods.

---

## 🏗️ Architecture

### System Overview

```
QuantAILabs/
├── backend/
│   ├── src/
│   │   ├── strategies/
│   │   │   ├── simpleAgent.ts          # Production agent (imports shared)
│   │   │   ├── momentumSimple.ts       # 🎯 SHARED strategy logic
│   │   │   └── signalRanker.ts         # 🎯 SHARED signal scoring
│   │   │
│   │   ├── services/
│   │   │   ├── backtestService.ts      # Backtest engine (imports shared)
│   │   │   ├── binanceWebSocket.ts     # Real-time market data
│   │   │   ├── capitalPool.ts          # Shared capital management
│   │   │   └── notificationService.ts  # WebSocket notifications
│   │   │
│   │   ├── exchange/
│   │   │   └── ccxtClient.js           # Binance CCXT wrapper
│   │   │
│   │   └── server.ts                   # Express API server
│   │
│   └── prisma/
│       └── schema.prisma               # Database schema
│
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx           # Main monitoring view
│   │   │   ├── BacktestPage.tsx        # Backtest runner UI
│   │   │   └── TradingPage.tsx         # Position management
│   │   │
│   │   └── components/
│   │       └── NotificationsPanel.tsx   # Real-time alerts
│   │
│   └── package.json
│
├── .claude/
│   └── skills/                          # Claude Code custom skills
│       ├── backtest-analyzer/           # Analyze backtest results
│       ├── strategy-optimizer/          # Optimize parameters
│       ├── code-consistency-checker/    # Verify backtest-prod parity
│       ├── pattern-researcher/          # Discover new patterns
│       └── ml-signal-scorer/            # ML signal enhancement
│
└── docs/
    ├── AGENT_STRATEGY_V534.md           # Detailed strategy docs
    └── CODE_CONSISTENCY_REPORT.md       # Latest parity analysis
```

### Shared Architecture (CRITICAL)

This system uses a **shared file design** that ensures backtest and production use **identical strategy logic**:

```typescript
// ═══════════════════════════════════════════════════════════
// 🎯 momentumSimple.ts - SHARED SOURCE OF TRUTH
// ═══════════════════════════════════════════════════════════

export const MomentumConfig = {
  ENTRY_LONG: {
    ROC_MIN: 0.0175,        // 1.75%
    VOL_MULTIPLIER: 1.15,   // 1.15x
    MAX_CONSEC_UP: 5,
  },
  EXIT: {
    STOP_LOSS_PCT: 2.5,
    TRAILING_ACTIVATION_PCT: 0.8,
    TRAILING_DISTANCE_PCT: 0.5,
    // ... all exit config
  },
  // ... all strategy config
};

export function checkMomentumSignal(symbol, candles, btcCandles) {
  // Entry logic implementation
  const roc10 = calcROC(closes, 10);
  if (roc10 >= MomentumConfig.ENTRY_LONG.ROC_MIN) {
    return { valid: true, side: 'long' };
  }
}

export function shouldExitPosition(position, currentPrice, candles, opts) {
  // Exit logic implementation
  if (pnlPct <= -MomentumConfig.EXIT.STOP_LOSS_PCT) {
    return { shouldExit: true, reason: 'stoploss' };
  }
  // ... trailing, regime change, stagnant trade logic
}
```

```typescript
// ═══════════════════════════════════════════════════════════
// 🎯 signalRanker.ts - SHARED SIGNAL SCORING
// ═══════════════════════════════════════════════════════════

export function calculateSignalScore(params: {
  roc5: number;
  volumeRatio: number;
  bbPosition: number;
  atrPct: number;
  trendStrength: number;
  side: 'long' | 'short';
}): number {
  // Multi-factor scoring formula
  const bbScore = (side === 'long' ? 1 - bbPosition : bbPosition) * 10 * 0.3;
  const rocScore = Math.abs(roc5) * 10 * 0.25;
  const volScore = Math.min(volumeRatio, 3) * 10 * 0.2;
  const atrScore = Math.max(0, 1 - (atrPct - 2) / 3) * 10 * 0.15;
  const trendScore = /* ... */ * 10 * 0.1;

  return bbScore + rocScore + volScore + atrScore + trendScore;
}
```

```typescript
// ═══════════════════════════════════════════════════════════
// 🔬 backtestService.ts - BACKTEST (imports shared)
// ═══════════════════════════════════════════════════════════

import { MomentumConfig } from '../strategies/momentumSimple.js';
import { calculateSignalScore } from '../strategies/signalRanker.js';

// Uses MomentumConfig directly
const CONFIG = {
  get EXIT() {
    return {
      STOP_LOSS_PCT: MomentumConfig.EXIT.STOP_LOSS_PCT,
      TRAILING_ACTIVATION_PCT: MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT,
      // ... reads all from MomentumConfig
    };
  },
};

// Uses shared signal scoring
const score = calculateSignalScore({
  roc5, volumeRatio, bbPosition, atrPct, trendStrength, side
});
```

```typescript
// ═══════════════════════════════════════════════════════════
// 🤖 simpleAgent.ts - PRODUCTION (imports shared)
// ═══════════════════════════════════════════════════════════

import {
  MomentumConfig,
  checkMomentumSignal,
  shouldExitPosition
} from './momentumSimple.js';
import { globalSignalRanker } from './signalRanker.js';

// Entry: calls shared function
const signal = checkMomentumSignal(symbol, candles, btcCandles);

// Exit: calls shared function
const exitSignal = shouldExitPosition(position, currentPrice, candles, {
  btcCandles,
  nowMs: Date.now(),
});

// Signal scoring: uses shared ranker
globalSignalRanker.addSignal({ symbol, score, ... });
```

### Why This Architecture Matters

**Problem**: Most trading systems have separate backtest and production code that **drift apart** over time:
- Developer updates backtest logic, forgets to update production
- Production adds optimizations, backtest doesn't match
- Result: Backtest shows +500% but production loses money

**Solution**: Shared files ensure **any change propagates automatically**:
- ✅ Change ROC threshold → Both backtest and production use new value immediately
- ✅ Add new exit condition → Both environments apply it identically
- ✅ Modify signal scoring → Ranking works the same in backtest and live

**Code Consistency Report**: Latest analysis (2026-01-01) shows **EXCELLENT** parity:
- Entry logic: ✓ MATCH
- Exit logic: ✓ MATCH
- Indicator calculations: ✓ MATCH
- Signal scoring: ✓ MATCH
- Position sizing: ✓ MATCH
- **Grade: A+ (Gold standard implementation)**

See [docs/CODE_CONSISTENCY_REPORT.md](docs/CODE_CONSISTENCY_REPORT.md) for full analysis.

### Technology Stack

**Backend:**
- Runtime: Node.js 20+ with TypeScript 5.4+
- Exchange: Binance Futures via CCXT + WebSocket
- Database: PostgreSQL with Prisma ORM
- Real-time: WebSocket for market data & notifications

**Frontend:**
- Framework: React 18 with TypeScript
- UI Library: Ant Design
- Charts: Lightweight Charts by TradingView
- Build Tool: Vite

**Development:**
- Claude Code: AI-assisted development with custom skills
- Backtest Engine: Historical simulation with realistic execution
- Code Consistency: Automated parity verification

---

## 🚀 Installation & Setup

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Binance Futures account with API keys (for live mode)

### 1. Clone & Install

```bash
git clone <repository-url>
cd QuantAILabs

# Install backend
cd backend && npm install

# Install frontend
cd ../frontend && npm install
```

### 2. Database Setup

```bash
# Create database
createdb quantailabs

# Run migrations
cd backend
npx prisma migrate deploy
npx prisma generate
```

### 3. Environment Configuration

Create `backend/.env`:

```bash
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/quantailabs"

# Binance Futures (required for live mode)
BINANCE_API_KEY="your_api_key"
BINANCE_SECRET="your_secret"

# JWT for authentication
JWT_SECRET="your_jwt_secret_here"

# Server
PORT=3000
FRONTEND_URL="http://localhost:5173"

# Optional: Notification service
NOTIFICATION_WEBHOOK_URL=""
```

### 4. Start Services

```bash
# Terminal 1 - Backend
cd backend && npm run dev

# Terminal 2 - Frontend
cd frontend && npm run dev
```

### 5. Access

- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3000
- **Database**: postgres://localhost:5432/quantailabs

### 6. First Run

1. Navigate to http://localhost:5173
2. Register/login with your account
3. Go to Trading page
4. Start agents in **PAPER mode** with initial capital (e.g., $10,000)
5. Monitor Dashboard for market conditions and signals
6. View Backtest page to run historical simulations

**⚠️ Important**: Always test thoroughly in paper mode before switching to live mode!

---

## 🧪 Backtesting

### Running Backtests

The system includes a comprehensive backtesting engine that uses the **same strategy code** as production.

**Via API:**
```bash
curl -X POST http://localhost:3000/api/backtest/run \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2024-01-01",
    "endDate": "2024-12-31",
    "initialCapital": 10000,
    "symbols": ["BTC/USDT:USDT", "ETH/USDT:USDT"],
    "leverage": 5
  }'
```

**Via Frontend:**
1. Navigate to Backtest page
2. Select date range, symbols, and capital
3. Click "Run Backtest"
4. View detailed results with equity curve, drawdown, and per-trade analysis

### Backtest Features

✅ **Realistic Execution**:
- Intrabar stop loss checking (uses candle wicks)
- Trading fees: 0.04% × 2 (entry + exit)
- Slippage: 0.05% × 2
- Funding rates: 0.01% per 8h

✅ **No Look-Ahead Bias**:
- Signals generated on closed candles only
- BTC regime uses prior candle for regime detection
- Realistic order fill assumptions

✅ **Consistent with Production**:
- Imports from `momentumSimple.ts` (shared config)
- Uses `calculateSignalScore()` from `signalRanker.ts`
- Applies same position sizing rules
- Simulates same exit conditions

### Backtest Validation

To verify backtest-production parity, use the `/code-consistency-checker` skill:

```bash
# In Claude Code
/code-consistency-checker
```

This will analyze and report any divergence between backtest and production implementations.

---

## 🤖 Claude Code Skills

This project includes **5 custom Claude Code skills** for AI-assisted development:

### 1. `/backtest-analyzer`

Analyzes backtest results and suggests improvements:
- Performance metrics breakdown (Sharpe, max DD, win rate, profit factor)
- Identifies trading patterns and seasonality
- Compares multiple backtest runs
- Evaluates exit strategy effectiveness

**Use when**: Analyzing backtest results, comparing parameter variations

### 2. `/strategy-optimizer`

Optimizes strategy parameters through systematic testing:
- Grid search over parameter ranges (ROC_MIN, VOL_MULTIPLIER, etc.)
- Parameter sensitivity analysis
- Walk-forward validation to prevent overfitting
- Suggests optimal parameter sets with confidence intervals

**Use when**: Fine-tuning strategy parameters, adapting to new market conditions

### 3. `/code-consistency-checker`

Validates backtest-production code parity:
- Compares entry/exit logic implementations
- Verifies indicator calculations match
- Checks signal scoring consistency
- Detects hardcoded values and look-ahead bias

**Use when**: Deploying to production, after strategy changes, debugging discrepancies

### 4. `/pattern-researcher`

Discovers and tests new trading patterns:
- Analyzes volume profiles and multi-timeframe confluence
- Tests custom pattern hypotheses
- Automatically implements pattern detection code
- Validates via backtesting with V5.XX versioning

**Use when**: Exploring new trading opportunities, researching market behavior

### 5. `/ml-signal-scorer`

Integrates machine learning for signal quality prediction:
- Exports historical trades with features
- Trains XGBoost/LightGBM models to predict win probability
- Integrates predictions into `signalRanker.ts`
- Automates monthly model retraining

**Use when**: Ready to enhance signal quality with ML (requires 1000+ trades)

### Getting Started with Skills

```bash
# 1. Install Claude Code CLI
npm install -g @anthropic/claude-code

# 2. Navigate to project directory
cd QuantAILabs

# 3. Run a skill
/backtest-analyzer

# Or with arguments
/strategy-optimizer --param ROC_MIN --range 0.015,0.025 --step 0.001
```

See [SKILLS_COMPLETE_SUMMARY.md](SKILLS_COMPLETE_SUMMARY.md) for detailed documentation.

---

## 📡 API Documentation

### Agent Management

**Start Agents**
```http
POST /api/agent/start
Content-Type: application/json

{
  "mode": "paper",        // "paper" or "live"
  "capitalUsd": 10000     // Starting capital (paper only)
}
```

**Stop Agents**
```http
POST /api/agent/stop
Content-Type: application/json

{
  "mode": "paper"
}
```

**Restart Agents**
```http
POST /api/agent/restart
Content-Type: application/json

{
  "mode": "paper",
  "capitalUsd": 10000
}
```

**Get Status**
```http
GET /api/agent/status?mode=paper
```

**Response:**
```json
{
  "running": true,
  "agentCount": 6,
  "positions": 2,
  "symbols": ["SEI/USDT:USDT", "ETH/USDT:USDT", "..."],
  "capitalPool": {
    "totalUsd": 10000,
    "availableUsd": 6000,
    "inPositionsUsd": 4000
  }
}
```

### Capital Management

**Get Capital Snapshot**
```http
GET /api/capital/:mode/snapshot
```

**Response:**
```json
{
  "totalUsd": 10000,
  "availableUsd": 6000,
  "reservedUsd": 0,
  "inPositionsUsd": 4000,
  "mode": "paper",
  "lastSync": 1704067200000,
  "byAgent": {
    "SEI/USDT:USDT": { "reserved": 0, "inPosition": 2600 },
    "ETH/USDT:USDT": { "reserved": 0, "inPosition": 1400 }
  }
}
```

**Set Paper Balance**
```http
POST /api/capital/paper/set-balance
Content-Type: application/json

{
  "balanceUsd": 15000
}
```

### Backtest API

**Run Backtest**
```http
POST /api/backtest/run
Content-Type: application/json

{
  "startDate": "2024-01-01",
  "endDate": "2024-12-31",
  "initialCapital": 10000,
  "symbols": ["BTC/USDT:USDT", "ETH/USDT:USDT"],
  "leverage": 5
}
```

**Response:**
```json
{
  "summary": {
    "totalTrades": 243,
    "wins": 145,
    "losses": 98,
    "winRate": 59.67,
    "totalPnlUsd": 5010,
    "totalPnlPct": 50.1,
    "maxDrawdownPct": 12.3,
    "sharpeRatio": 1.85,
    "profitFactor": 2.14
  },
  "trades": [...],
  "monthlyStats": [...],
  "equityCurve": [...],
  "drawdownCurve": [...]
}
```

### Market Data

**Get Market Conditions**
```http
GET /api/market-conditions
```

**Response:**
```json
{
  "isTradingDay": true,
  "btcTrend": "bullish",
  "btcAboveSma200": true,
  "overallStatus": "favorable_long",
  "reason": "BTC in bull regime (>SMA200)",
  "checkedAt": 1704067200000
}
```

**Get Liquidity Info**
```http
GET /api/liquidity-info?symbol=ETH/USDT:USDT
```

**Response:**
```json
{
  "symbol": "ETH/USDT:USDT",
  "tier": "HIGH",
  "maxNotionalUsd": 500000,
  "description": "High liquidity - suitable for large positions"
}
```

### WebSocket Events

Connect to `ws://localhost:3000` for real-time updates:

```javascript
const ws = new WebSocket('ws://localhost:3000');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch(data.type) {
    case 'tick':
      // Real-time price update
      console.log(`${data.symbol}: $${data.price}`);
      break;

    case 'notification':
      // Trade alerts
      if (data.notificationType === 'trade_entry') {
        console.log(`Entered ${data.side} on ${data.symbol}`);
      }
      break;

    case 'position_update':
      // Position PnL changes
      console.log(`Position PnL: ${data.pnlPct}%`);
      break;

    case 'agent_log':
      // Agent activity logs
      console.log(data.message);
      break;
  }
};
```

**Notification Types:**
- `trade_entry` - Position opened
- `trade_exit` - Position closed (with exit reason)
- `order_error` - Order placement failed
- `daily_loss_limit` - Daily loss limit hit
- `trailing_active` - Trailing stop activated
- `regime_change` - BTC crossed SMA200
- `high_volatility` - High volatility detected
- `signal_detected` - Entry signal found (before execution)
- `stagnant_trade` - Stagnant trade detection triggered
- `liquidation_warning` - Position approaching liquidation (emergency)

---

## 🤝 Contributing

### Development Workflow

1. **Create Feature Branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make Changes** following architecture rules:
   - Strategy logic → `momentumSimple.ts` (shared)
   - Signal scoring → `signalRanker.ts` (shared)
   - Configuration → `MomentumConfig` object
   - Never hardcode thresholds
   - Never duplicate logic

3. **Test Changes**
   ```bash
   # Run backtest to validate changes
   /backtest-analyzer

   # Verify backtest-production parity
   /code-consistency-checker

   # Test in paper mode
   npm run dev  # Start backend + frontend
   ```

4. **Update Version**
   - Increment version in `MomentumConfig` comments (e.g., V5.34 → V5.35)
   - Document changes in strategy docstring
   - Update README if needed

5. **Commit & Push**
   ```bash
   git add .
   git commit -m "feat: Add new exit condition for XYZ"
   git push origin feature/your-feature-name
   ```

6. **Create Pull Request**
   - Describe changes and rationale
   - Include backtest results before/after
   - Attach code consistency report

### Code Style

- TypeScript strict mode
- ESLint + Prettier for formatting
- Meaningful variable names (`rocMin` not `rm`)
- Comments for complex logic
- Version tags for strategy changes (e.g., `// V5.35: New feature`)

### Pre-Commit Checklist

- [ ] All changes in shared files (`momentumSimple.ts`, `signalRanker.ts`)
- [ ] No hardcoded thresholds (all read from `MomentumConfig`)
- [ ] Backtest validates changes (run before committing)
- [ ] Code consistency check passes (no backtest-prod divergence)
- [ ] Version incremented if strategy changed
- [ ] Tests pass (if applicable)

---

## ⚠️ Disclaimer

**This software is for educational and research purposes only.**

- Trading cryptocurrencies carries significant financial risk
- Past performance does not guarantee future results
- Only trade with capital you can afford to lose
- **Always test thoroughly in paper mode before going live**
- The authors are not responsible for any financial losses
- This is not financial advice

**Use at your own risk.**

---

## 📄 License

Private - All Rights Reserved

**Unauthorized copying, distribution, or use is prohibited.**

---

## 📚 Additional Resources

- [Detailed Strategy Documentation](docs/AGENT_STRATEGY_V534.md)
- [Code Consistency Report](docs/CODE_CONSISTENCY_REPORT.md)
- [Skills Implementation Guide](SKILLS_IMPLEMENTATION_SUMMARY.md)
- [Skills Complete Reference](SKILLS_COMPLETE_SUMMARY.md)

---

**Built with ❤️ using Claude Code**

*Last Updated: January 2026 - Strategy V5.34*

**Current Status**: Production-ready with A+ code consistency rating
