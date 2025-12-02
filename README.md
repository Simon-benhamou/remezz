# 🤖 QuantAI Trading Agent v5.7

**An intelligent, momentum-based cryptocurrency trading system with regime-adaptive strategy**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-18+-61DAFB.svg)](https://reactjs.org/)
[![License](https://img.shields.io/badge/license-Private-red.svg)]()

## 📋 Table of Contents

- [Overview](#overview)
- [Performance](#performance)
- [Trading Strategy V5.7](#trading-strategy-v57)
- [Entry Conditions](#entry-conditions)
- [Exit Management](#exit-management)
- [Capital Management](#capital-management)
- [Risk Management](#risk-management)
- [Architecture](#architecture)
- [Installation & Setup](#installation--setup)
- [API Documentation](#api-documentation)

---

## 🎯 Overview

QuantAI Trading Agent is a sophisticated algorithmic trading platform for cryptocurrency futures markets. The system uses a **momentum breakout strategy** with **BTC regime filtering** to execute trades on Binance Futures.

### What Makes This System Unique?

- **Regime-Adaptive Strategy**: LONG only in Bull markets (BTC > SMA200), SHORT only in Bear markets
- **Bollinger Band Breakouts**: Entry on volatility expansion with volume confirmation
- **Dynamic Stop Loss**: ATR-based stops that adapt to market volatility
- **Trailing Stop System**: Protects profits with intelligent trail activation
- **Shared Capital Pool**: Multiple agents share capital for efficient allocation
- **Real-time Notifications**: WebSocket alerts for all trading events

---

## 📈 Performance

**Backtested over 24 months (Nov 2023 - Nov 2025):**

| Metric | Value |
|--------|-------|
| **ROI** | +1990% (with fees, slippage, funding) |
| **Win Rate** | 68.7% |
| **Trades** | ~789 over 12 months (~2-3/day) |
| **Positive Months** | 10/12 |
| **Max Drawdown** | ~15% |

### Top Performing Assets (24-month backtest)

| Asset | ROI | Win Rate |
|-------|-----|----------|
| 🏆 DOGE | +438% | 65.5% |
| 🏆 IMX | +344% | 67.9% |
| 🏆 SEI | +280% | 65.8% |
| 🏆 SUI | +266% | 65.4% |
| XRP | +185% | 65.0% |
| ETH | +173% | 67.8% |

---

## 📊 Trading Strategy V5.7

### Regime Filter: BTC vs SMA200

The strategy uses BTC's position relative to its 200-period SMA (on 15m candles = ~50 hours) to determine market regime:

\`\`\`
BTC > SMA200  →  🟢 BULL MARKET  →  LONG trades only
BTC < SMA200  →  🔴 BEAR MARKET  →  SHORT trades only
\`\`\`

This prevents:
- Going LONG in downtrends (catching falling knives)
- Going SHORT in uptrends (fighting the trend)

---

## 🟢 Entry Conditions

### LONG Entry (Bull Regime: BTC > SMA200)

All 5 conditions must be TRUE:

| # | Filter | Condition | Purpose |
|---|--------|-----------|---------|
| 1 | **Bullish Candle** | \`close > open\` | Confirms upward momentum |
| 2 | **Consecutive Up ≤ 3** | Max 3 green candles in a row | Avoids buying tops |
| 3 | **BB Breakout** | \`close > Bollinger Upper Band (20, 2σ)\` | Confirmed breakout |
| 4 | **ROC10 ≥ 2.5%** | Price up 2.5%+ over 10 periods | Strong momentum |
| 5 | **Volume ≥ 2x** | Volume ≥ 2× 20-period average | Volume confirmation |

### SHORT Entry (Bear Regime: BTC < SMA200)

All 6 conditions must be TRUE:

| # | Filter | Condition | Purpose |
|---|--------|-----------|---------|
| 1 | **Bearish Candle** | \`close < open\` | Confirms downward momentum |
| 2 | **Consecutive Down ≤ 5** | Max 5 red candles in a row | Avoids shorting oversold |
| 3 | **ROC5 ≤ -1.5%** | Price down 1.5%+ over 5 periods | Significant drop |
| 4 | **Volume ≥ 2x** | Volume ≥ 2× 20-period average | Panic selling confirmed |
| 5 | **Price < MA20** | Close under 20-period MA | Bearish trend |
| 6 | **BB Breakdown** | \`close < Bollinger Lower Band\` | Confirmed breakdown |

---

## 🚪 Exit Management

### Exit Conditions (checked every tick)

| Condition | Threshold | Action |
|-----------|-----------|--------|
| **Stop Loss** | Dynamic (ATR × 2.0, min 0.8%, max 3.0%) | Immediate close |
| **Take Profit** | +3.0% | Immediate close |
| **Time Exit** | 48 hours (2880 min) | Close if still open |
| **Trailing Stop** | Activated at +1.0% | Trail at 0.4% distance |
| **Momentum Fade** | PnL > 1.5% AND ROC5 < 0.5% | Close (momentum lost) |
| **Volume Dry** | PnL > 0.5% AND Vol < 0.5× avg | Close (no follow-through) |

### Dynamic Stop Loss (V5.7)

Stop loss adapts to market volatility using ATR:

\`\`\`typescript
SL = ATR(14) × 2.0
// Clamped between 0.8% and 3.0%
\`\`\`

**Backtested improvement:** +370% PnL vs fixed stop, -20% stop hunts

### Trailing Stop Logic

\`\`\`
1. Position opened at \$100 (LONG)
2. Initial SL at \$98.50 (1.5%)

3. Price rises to \$101 (+1%) → Trailing ACTIVATED
   → New SL = \$101 × (1 - 0.4%) = \$100.60

4. Price rises to \$102 (+2%) → Trail tightens
   → New SL = \$102 × (1 - 0.4%) = \$101.59

5. Price drops to \$101.50
   → SL stays at \$101.59 (never moves down)
   → Price < SL → EXIT with +1.5% profit
\`\`\`

---

## 💰 Capital Management

### Shared Capital Pool

All agents share a single capital pool per mode (paper/live):

\`\`\`
Total: \$10,000
├── Available: \$6,000
├── Reserved: \$0 (pre-order hold)
└── In Position: \$4,000
    ├── SEI: \$2,600
    └── ETH: \$1,400
\`\`\`

### Position Sizing

\`\`\`typescript
// Config
POSITION_SIZE_PCT = 40%      // Each trade uses 40% of available capital
MAX_POSITIONS = 4            // Maximum 4 concurrent positions
LEVERAGE = 4.5x              // Uniform leverage across all assets

// Example
Available: \$6,000
Margin: 40% × \$6,000 = \$2,400
Notional: \$2,400 × 4.5 = \$10,800 exposure
\`\`\`

### Liquidity Caps (V5.5)

Position size is capped based on asset liquidity tier:

| Tier | Assets | Max Position |
|------|--------|--------------|
| HIGH | BTC, ETH | \$500,000 |
| MEDIUM | XRP, SOL, DOGE, AVAX, LINK, ADA | \$100,000 |
| LOW | SEI, IMX, DOT, SUI | \$25,000 |

---

## 🛡️ Risk Management

### Circuit Breaker

| Trigger | Action |
|---------|--------|
| **3 consecutive losses** | Cooldown 5-15 min |
| **4 consecutive losses** | Cooldown 15-25 min |
| **5+ consecutive losses** | Cooldown 30-45 min |
| **Daily loss limit hit** | Trading paused until next day |

### Daily Loss Limit

Per-agent daily PnL is tracked. When daily loss reaches the limit (configurable), trading is paused with notification.

### Dynamic Leverage (V5.6)

Leverage is reduced during high volatility:

\`\`\`typescript
if (ATR/price > 2%) {
  leverage = 3x  // Reduced from base 4.5x
}
\`\`\`

---

## 🏗️ Architecture

\`\`\`
QuantAILabs/
├── backend/
│   ├── src/
│   │   ├── strategies/
│   │   │   ├── simpleAgent.ts      # Main agent class
│   │   │   └── momentumSimple.ts   # Strategy config & signal logic
│   │   │
│   │   ├── quantai/
│   │   │   └── risk/
│   │   │       ├── circuitBreaker.ts   # Loss limits & cooldowns
│   │   │       └── config.ts           # Risk configuration
│   │   │
│   │   ├── services/
│   │   │   ├── binanceWebSocket.ts     # Real-time market data
│   │   │   └── notificationService.ts  # WebSocket notifications
│   │   │
│   │   └── server.ts              # Express API server
│   │
│   └── prisma/
│       └── schema.prisma          # Database schema
│
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx      # Main monitoring view
│   │   │   ├── FeedPage.tsx       # Activity feed with tick logs
│   │   │   └── TradingPage.tsx    # Position management
│   │   │
│   │   └── components/
│   │       └── NotificationsPanel.tsx  # Real-time alerts
│   │
│   └── package.json
│
└── docs/
    ├── AGENT_STRATEGY_V54.md      # Detailed strategy documentation
    └── PER_AGENT_DAILY_LOSS_LIMIT.md
\`\`\`

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

---

## 🚀 Installation & Setup

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Binance Futures account with API keys

### 1. Clone & Install

\`\`\`bash
git clone https://github.com/Simon-benhamou/trading-agent-ia-v3.git
cd trading-agent-ia-v3

# Install backend
cd backend && npm install

# Install frontend
cd ../frontend && npm install
\`\`\`

### 2. Database Setup

\`\`\`bash
# Create database
createdb quantailabs

# Run migrations
cd backend
npx prisma migrate deploy
npx prisma generate
\`\`\`

### 3. Environment Configuration

Create \`backend/.env\`:

\`\`\`bash
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/quantailabs"

# Binance Futures
BINANCE_API_KEY="your_api_key"
BINANCE_SECRET="your_secret"

# JWT for authentication
JWT_SECRET="your_jwt_secret"

# Server
PORT=3000
FRONTEND_URL="http://localhost:5173"
\`\`\`

### 4. Start Services

\`\`\`bash
# Terminal 1 - Backend
cd backend && npm run dev

# Terminal 2 - Frontend
cd frontend && npm run dev
\`\`\`

### 5. Access

- Frontend: http://localhost:5173
- Backend API: http://localhost:3000

---

## 📡 API Documentation

### Agent Management

**Start Agents**
\`\`\`http
POST /api/agent/start
Content-Type: application/json

{
  "mode": "paper",        // "paper" or "live"
  "capitalUsd": 10000     // Starting capital (paper only)
}
\`\`\`

**Stop Agents**
\`\`\`http
POST /api/agent/stop
Content-Type: application/json

{
  "mode": "paper"
}
\`\`\`

**Restart Agents**
\`\`\`http
POST /api/agent/restart
Content-Type: application/json

{
  "mode": "paper",
  "capitalUsd": 10000
}
\`\`\`

**Get Status**
\`\`\`http
GET /api/agent/status?mode=paper
\`\`\`

### Capital Management

**Get Capital Snapshot**
\`\`\`http
GET /api/capital/:mode/snapshot
\`\`\`

**Set Paper Balance**
\`\`\`http
POST /api/capital/paper/set-balance
Content-Type: application/json

{
  "balanceUsd": 15000
}
\`\`\`

### Market Data

**Get Market Conditions**
\`\`\`http
GET /api/market-conditions
\`\`\`

**Get Liquidity Info**
\`\`\`http
GET /api/liquidity-info?symbol=ETH/USDT:USDT
\`\`\`

### WebSocket Events

Connect to \`ws://localhost:3000\` for real-time updates:

\`\`\`javascript
// Events received:
{
  type: 'tick',           // Price tick
  type: 'notification',   // Trade alerts
  type: 'agent_log',      // Agent activity logs
  type: 'position_update' // Position changes
}

// Notification types:
- trade_entry      // Position opened
- trade_exit       // Position closed
- order_error      // Order failed
- daily_loss_limit // Loss limit hit
- trailing_active  // Trailing stop activated
- regime_change    // BTC crossed SMA200
- high_volatility  // Leverage reduced
- signal_detected  // Signal found (before entry)
\`\`\`

---

## 🧪 Testing

### Run Backtest

\`\`\`bash
cd backend
node backtest-combined-v54.mjs
\`\`\`

### Unit Tests

\`\`\`bash
npm test
\`\`\`

---

## ⚠️ Disclaimer

**This software is for educational and research purposes only.**

- Trading cryptocurrencies carries significant risk
- Past performance does not guarantee future results
- Only trade with capital you can afford to lose
- Always test on paper mode before going live
- The authors are not responsible for any financial losses

---

## 📄 License

Private - All Rights Reserved

---

**Built with ❤️ by the QuantAI Team**

*Last Updated: December 2025 - Strategy V5.7*
