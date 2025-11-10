# 🤖 QuantAI Trading Agent v3

**An intelligent, meta-adaptive cryptocurrency trading system powered by hybrid AI strategies**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-18+-61DAFB.svg)](https://reactjs.org/)
[![License](https://img.shields.io/badge/license-Private-red.svg)]()

## 📋 Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Trading Strategy](#trading-strategy)
- [Execution Flow](#execution-flow)
- [Project Structure](#project-structure)
- [Installation & Setup](#installation--setup)
- [Configuration](#configuration)
- [Usage](#usage)
- [Performance Monitoring](#performance-monitoring)
- [API Documentation](#api-documentation)

---

## 🎯 Overview

QuantAI Trading Agent is a sophisticated algorithmic trading platform designed specifically for cryptocurrency markets. The system combines traditional technical analysis with modern machine learning techniques to execute intelligent trades across multiple cryptocurrency pairs.

### What Makes This System Unique?

- **Meta-Adaptive Strategy Engine**: Dynamically recognizes and adapts to multiple market patterns (trend-following, breakouts, mean-reversion, momentum)
- **Hybrid Intelligence**: Combines rule-based technical analysis with LLM-powered market sentiment analysis
- **Intelligent Symbol Selection**: Automatically identifies the best trading opportunities across 50+ cryptocurrencies
- **Multi-Timeframe Analysis**: Evaluates market conditions across 15m, 1h, and 4h timeframes for consensus
- **Real-time Risk Management**: Advanced position sizing, stop-loss management, and circuit breakers
- **Full-Stack Solution**: React frontend for monitoring + Node.js/TypeScript backend + WebSocket real-time updates

---

## ✨ Key Features

### 🧠 Intelligent Decision Making
- **Recognized Strategy Framework**: 8+ pre-programmed trading strategies (breakouts, reversals, trend continuations)
- **Confidence-Based Filtering**: Only executes trades above configurable confidence thresholds
- **Entry Eligibility Gates**: Multi-factor quality checks (momentum, volume, flow, ATR)
- **XGBoost Direction Predictor**: Machine learning model for directional bias validation

### 📊 Advanced Technical Analysis
- **30+ Technical Indicators**: EMA, RSI, ADX, ATR, CMF, Chaikin Money Flow, Volume analysis
- **Support/Resistance Detection**: Automatic identification of key price levels
- **Market Regime Classification**: Trend/ranging/volatile market detection
- **Multi-Timeframe Consensus**: Confirms signals across multiple timeframes

### ⚡ Smart Execution
- **Adaptive Order Routing**: Chooses between market, limit, and TWAP execution based on conditions
- **Liquidity-Aware Sizing**: Adjusts position size based on order book depth
- **Slippage Protection**: Real-time spread monitoring and rejection of poor fills
- **Execution Telemetry**: Tracks fill rates, latency, and execution quality

### 🛡️ Risk Management
- **Per-Trade Risk Control**: Configurable risk percentage per trade (0.5-3%)
- **Position Sizing**: Automatic calculation based on ATR-based stop distances
- **Circuit Breakers**: Automatic pause after consecutive losses or daily loss limits
- **Trailing Stops**: Dynamic stop-loss adjustment as trade becomes profitable
- **Partial Profit Taking**: Multi-level take-profit targets with ladder exits
- **Position Flipping**: Optional feature to reverse position direction on strong counter-signals (see [POSITION_FLIPPING_FEATURE.md](POSITION_FLIPPING_FEATURE.md))

### 📈 Performance Tracking
- **Real-Time KPIs**: Win rate, profit factor, expectancy, Sharpe ratio
- **Trade Analytics**: Detailed logging of every decision, entry, and exit
- **Session Management**: Track multiple agent instances simultaneously
- **Adaptive Learning**: System learns from past trades to refine parameters

---

## 🏗️ Architecture

The system is built as a monorepo with three main components:

```
trading-agent-ia-v3/
├── backend/          # Node.js/TypeScript trading engine
├── frontend/         # React dashboard
├── docs/             # Documentation
└── logs/             # Trade logs and analytics
```

### Technology Stack

**Backend:**
- **Runtime**: Node.js 20+ with TypeScript 5.4+
- **Exchange Integration**: CCXT (supports 100+ exchanges)
- **Database**: PostgreSQL with Prisma ORM
- **WebSocket**: Real-time market data and order updates
- **AI/ML**: OpenAI GPT-4 for sentiment, Python XGBoost for predictions

**Frontend:**
- **Framework**: React 18 with TypeScript
- **UI Library**: Ant Design
- **Charts**: Lightweight Charts by TradingView
- **State Management**: Zustand
- **Build Tool**: Vite

**Infrastructure:**
- **Containerization**: Docker & Docker Compose
- **Monitoring**: Console Ninja runtime logs
- **Version Control**: Git with GitKraken integration

### System Components

#### 1. **Agent Hub** (`backend/src/agent/hub.ts`)
Central registry for all active trading agents. Manages lifecycle, state, and communication.

#### 2. **Meta-Adaptive Engine** (`backend/src/quantai/strategies/metaAdaptive/`)
Core strategy evaluation engine that recognizes market patterns and generates signals.

#### 3. **Market Data Pipeline** (`backend/src/data/`)
Fetches, caches, and preprocesses market data (OHLCV, indicators, order books).

#### 4. **Execution Engine** (`backend/src/exec/`)
Handles order placement, execution monitoring, and fill management.

#### 5. **Risk Manager** (`backend/src/risk/`)
Enforces position limits, risk constraints, and circuit breakers.

#### 6. **Performance Analytics** (`backend/src/metrics/`)
Tracks and calculates trading performance metrics.

#### 7. **WebSocket Server** (`backend/src/ws/`)
Real-time updates to frontend clients (prices, positions, trades).

#### 8. **Intelligent Selector** (`backend/src/services/intelligentAgent/`)
Automatically selects optimal cryptocurrency to trade based on opportunity ranking.

---

## 📈 Trading Strategy

### Meta-Adaptive Strategy Philosophy

The trading system does not rely on a single fixed strategy. Instead, it employs a **meta-adaptive approach** that recognizes current market conditions and selects the most appropriate strategy from its toolkit.

### Recognized Strategies

The system evaluates **8 core strategy patterns** on every tick:

1. **Trend Following** (`trend_ma_cross`, `trend_ema_momentum`)
   - Detects strong directional moves
   - Requires ADX > 20, aligned EMAs, increasing momentum

2. **Breakout** (`breakout_consolidation`, `breakout_volatility`)
   - Identifies range breakouts and volatility expansions
   - Requires volume surge, ATR expansion, price beyond resistance

3. **Mean Reversion** (`mean_bollinger`, `mean_rsi_oversold`)
   - Trades oversold/overbought extremes
   - Requires RSI < 30 or > 70, price at Bollinger bands, reversal signals

4. **Momentum** (`momentum_surge`, `momentum_rsi_breakout`)
   - Captures strong momentum shifts
   - Requires RSI momentum divergence, volume confirmation, ADX rising

### Signal Generation Process

For each strategy, the system computes:

**1. Confidence Score (0-100)**
```typescript
confidence = (
  rawScore * 0.4 +           // Base technical score
  qualityMultiplier * 0.3 +  // Market quality factors
  calibrationBoost * 0.3     // Historical performance adjustment
)
```

**2. Entry Eligibility Score (0-100)**
```typescript
entryEligibility = average([
  momentumScore,    // ADX, RSI momentum
  flowScore,        // CMF, volume quality
  atrScore,         // Volatility appropriateness
  qualityScore      // Symbol quality, liquidity
])
```

**3. Risk/Reward Ratio**
```typescript
RR = (targetDistance / stopDistance)
// Must be >= 1.5 for entry consideration
```

### Entry Criteria (All Must Pass)

✅ **Confidence Gate**: `confidence >= 55%` (configurable)  
✅ **Entry Eligibility Gate**: `entryEligibility >= 40%` (configurable)  
✅ **Risk/Reward Gate**: `RR >= 1.5`  
✅ **Symbol Quality**: Minimum volume, liquidity, no anomalies  
✅ **Position Limits**: Max positions per symbol, total exposure  
✅ **XGBoost Confirmation**: ML model agrees with directional bias (optional)

### Position Sizing

```typescript
// ATR-based stop distance
stopDistance = ATR14 * stopMultiplier (default 2.0)

// Risk-based sizing
riskAmount = accountBalance * riskPercentage
positionSize = riskAmount / stopDistance

// Capped by liquidity
maxSize = orderBookDepth / 10  // Use max 10% of book depth
finalSize = min(positionSize, maxSize)
```

### Exit Management

The system uses **adaptive trailing stops** and **multi-level profit targets**:

**Initial Bracket:**
```typescript
stopLoss = entryPrice ± (ATR * 2.0)
takeProfit1 = entryPrice ± (ATR * 3.0)  // 1.5R
takeProfit2 = entryPrice ± (ATR * 4.5)  // 2.25R
takeProfit3 = entryPrice ± (ATR * 6.0)  // 3.0R
```

**Trailing Logic:**
- **Starts trailing** after reaching 1.2R profit
- **Trail distance**: 60% of initial stop distance
- **Tightens** if momentum fails (ADX < 15 or CMF < 0)
- **Breakeven move** at 1.2R to protect capital

**Early Exit Conditions:**
- Momentum failure before minimum hold time (5 minutes default)
- Opposite signal from higher-confidence strategy
- Adverse price movement > 1.5R before profit target
- Market regime change (trend → volatile)

### Aggressiveness Modes

The system supports three risk profiles:

**Conservative:**
- Only trades BTC/ETH and top-tier assets
- Volume requirement: $75M+
- Tighter filters, lower position sizes
- Target: 40-50% win rate, 1.3-1.5 profit factor

**Reactive (Default):**
- Trades top 20-30 cryptocurrencies
- Volume requirement: $50M+
- Balanced risk/reward
- Target: 38-45% win rate, 1.4-1.7 profit factor

**Aggressive:**
- Trades up to 50 opportunities
- Volume requirement: $35M+
- Looser filters, higher risk tolerance
- Target: 35-42% win rate, 1.5-2.0+ profit factor

---

## 🔄 Execution Flow

Here's a detailed breakdown of how the trading system operates from market data to order execution:

### 1. Market Data Ingestion (Every Tick)

```
WebSocket Stream (1s updates)
    ↓
Market Data Cache
    ↓
OHLCV Aggregation (15m, 1h, 4h)
    ↓
Technical Indicator Calculation
```

**Indicators Computed:**
- EMAs: 20, 50, 100, 200
- RSI: 14-period
- ADX: 14-period  
- ATR: 14-period
- CMF: 20-period
- Volume: Relative volume ratio
- Support/Resistance: Recent pivots

### 2. Strategy Evaluation (Every 15 seconds)

```
For each active session:
    ↓
1. Fetch latest technical snapshot
    ↓
2. Evaluate all 8 recognized strategies
    ↓
3. Calculate confidence + entry eligibility for each
    ↓
4. Filter: Keep only signals passing all gates
    ↓
5. Rank: Sort by confidence * entryEligibility
    ↓
6. Select: Choose highest-ranked signal
```

**Example Output:**
```json
{
  "strategyId": "breakout_volatility",
  "confidence": 68.5,
  "entryEligibility": 72.3,
  "bias": "long",
  "riskReward": 2.1,
  "entryPrice": 98432.50,
  "stopDistance": 985.20,
  "targets": [99910.45, 100895.70, 101880.95]
}
```

### 3. Entry Decision (If Signal Exists)

```
Signal Received
    ↓
Check Position Limits
    ↓
Calculate Position Size
    ↓
Choose Execution Mode (market/limit/twap)
    ↓
Register Trade Entry (DB + Memory)
    ↓
Place Order via Exchange
    ↓
Monitor Fill Status
    ↓
Update Agent Position State
```

**Position State:**
```typescript
{
  side: 'buy' | 'sell',
  qty: 0.15,
  entry: 98432.50,
  stop: 97447.30,
  targets: [99910.45, 100895.70, 101880.95],
  signal: {...},
  openedAt: 1699234567890,
  triggeredTargets: new Set()
}
```

### 4. Position Monitoring (Every Tick While In Position)

```
For each open position:
    ↓
Fetch current price
    ↓
Calculate current R-multiple
    ↓
Check exit conditions:
    ├─ Stop loss hit?
    ├─ Take profit hit?
    ├─ Momentum failure?
    ├─ Time-based exit?
    └─ Opposite signal?
    ↓
If exit triggered:
    ├─ Place exit order
    ├─ Calculate P&L
    ├─ Register outcome
    ├─ Update KPIs
    └─ Clear position state
Else if trailing conditions met:
    └─ Adjust stop loss upward
```

### 5. Performance Tracking (After Each Trade)

```
Trade Completed
    ↓
Calculate Metrics:
    ├─ P&L (USD)
    ├─ R-multiple
    ├─ Hold time
    ├─ Slippage
    ├─ Fee impact
    └─ Exit reason
    ↓
Update Session KPIs:
    ├─ Win rate
    ├─ Profit factor
    ├─ Expectancy
    ├─ Sharpe ratio
    └─ Max drawdown
    ↓
Adaptive Learning:
    ├─ Store trade features
    ├─ Update strategy weights
    └─ Adjust parameters
```

### 6. Intelligent Symbol Selection (Smart Agents Only)

```
Every 30 minutes (or on manual trigger):
    ↓
Scan Top 50 Cryptos by Volume
    ↓
For each symbol:
    ├─ Fetch technical snapshot
    ├─ Evaluate all strategies
    ├─ Calculate opportunity score
    └─ Check quality filters
    ↓
Rank by composite score:
    = confidence * entryEligibility * qualityMultiplier
    ↓
Select Top Opportunity
    ↓
If better than current symbol:
    ├─ Close existing position (if any)
    ├─ Switch to new symbol
    └─ Notify user
```

### 7. Risk Management (Continuous)

**Per-Trade:**
- Max risk per trade: 0.5-3% of account
- Position size capped by liquidity
- Stop loss always set on entry

**Per-Session:**
- Max daily trades: 7-15 (configurable)
- Max consecutive losses: 3 (circuit breaker)
- Daily loss limit: 5% of account

**Global:**
- Max concurrent positions: 5
- Max exposure per symbol: 20% of account
- Emergency stop on exchange errors

---

## 📁 Project Structure

```
trading-agent-ia-v3/
│
├── backend/
│   ├── src/
│   │   ├── agent/              # Agent lifecycle, hub, state management
│   │   │   ├── hub.ts          # Central agent registry
│   │   │   ├── state.ts        # Agent state machine
│   │   │   ├── validator.ts    # Plan validation
│   │   │   └── executionPlanner.ts  # Execution mode selection
│   │   │
│   │   ├── quantai/            # Meta-adaptive strategy engine
│   │   │   └── strategies/
│   │   │       └── metaAdaptive/
│   │   │           ├── metaAdaptiveAgent.ts      # Main agent class
│   │   │           ├── recognizedStrategies.ts   # 8 core strategies
│   │   │           ├── exitManager.ts            # Exit logic
│   │   │           └── backtest.ts               # Backtesting engine
│   │   │
│   │   ├── services/
│   │   │   ├── metaAdaptiveOrchestrator.ts  # Main execution loop
│   │   │   ├── intelligentAgent/            # Smart symbol selection
│   │   │   ├── agentCreationFlow.ts         # Agent initialization
│   │   │   └── positionSyncService.ts       # Position reconciliation
│   │   │
│   │   ├── data/               # Market data pipeline
│   │   │   ├── market.ts       # OHLCV fetching
│   │   │   ├── indicators.ts   # Technical indicators
│   │   │   └── cache.ts        # Data caching layer
│   │   │
│   │   ├── ai/                 # AI/ML components
│   │   │   ├── tech.ts         # Technical snapshot builder
│   │   │   ├── multiTimeframe.ts  # MTF analysis
│   │   │   └── planOrchestrator.ts  # LLM integration
│   │   │
│   │   ├── exec/               # Order execution
│   │   │   ├── broker.ts       # Exchange interface
│   │   │   └── orderManager.ts # Order lifecycle
│   │   │
│   │   ├── risk/               # Risk management
│   │   │   ├── manager.ts      # Risk limits enforcement
│   │   │   └── sizer.ts        # Position sizing
│   │   │
│   │   ├── metrics/            # Performance tracking
│   │   │   ├── kpi.ts          # KPI calculations
│   │   │   └── analytics.ts    # Trade analytics
│   │   │
│   │   ├── learning/           # Adaptive learning
│   │   │   ├── decisionMemory.ts  # Trade history
│   │   │   └── adaptiveWeights.ts # Parameter tuning
│   │   │
│   │   ├── routes/             # REST API endpoints
│   │   │   ├── agent.ts        # Agent control
│   │   │   ├── session.ts      # Session management
│   │   │   └── analytics.ts    # Performance queries
│   │   │
│   │   ├── ws/                 # WebSocket server
│   │   │   └── server.ts       # Real-time updates
│   │   │
│   │   ├── db/                 # Database
│   │   │   └── client.ts       # Prisma client
│   │   │
│   │   └── server.ts           # Express app entry point
│   │
│   ├── prisma/
│   │   └── schema.prisma       # Database schema
│   │
│   ├── python/                 # Python ML services
│   │   ├── ccxt_xgboost_module.py     # Direction predictor
│   │   ├── prediction_engine.py       # Prediction service
│   │   └── scheduled_training.py      # Model retraining
│   │
│   ├── scripts/                # Utility scripts
│   │   ├── multi-agent-pool-test.ts   # Multi-agent testing
│   │   ├── meta-adaptive-candle-backtest.ts  # Backtesting
│   │   └── agent-performance-analyzer.ts      # Analytics
│   │
│   ├── test/                   # Test suites
│   ├── logs/                   # Log files
│   └── data/                   # Cache & historical data
│
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx   # Main dashboard
│   │   │   ├── Trading.tsx     # Trading view
│   │   │   ├── Analytics.tsx   # Performance analytics
│   │   │   └── Settings.tsx    # Configuration
│   │   │
│   │   ├── components/
│   │   │   ├── AgentCard.tsx   # Agent status card
│   │   │   ├── TradingChart.tsx  # Price chart
│   │   │   ├── PositionTable.tsx  # Open positions
│   │   │   └── MetricsPanel.tsx   # KPI display
│   │   │
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts  # WS connection
│   │   │   └── useApi.ts        # API calls
│   │   │
│   │   ├── store.ts            # Zustand state
│   │   ├── api.ts              # API client
│   │   └── App.tsx             # Root component
│   │
│   └── package.json
│
├── docs/                       # Documentation
│   ├── META_ADAPTIVE_CRYPTO_SELECTION.md
│   ├── PHASE2_LEARNING_SYSTEM.md
│   └── ADAPTIVE_COOLDOWN_IMPLEMENTATION.md
│
└── README.md                   # This file
```

---

## 🚀 Installation & Setup

### Prerequisites

- **Node.js** 20+ and npm
- **Python** 3.9+ (for ML predictor)
- **PostgreSQL** 14+ (or Docker)
- **Exchange API Keys** (Binance recommended)
- **OpenAI API Key** (optional, for LLM sentiment)

### 1. Clone the Repository

```bash
git clone https://github.com/Simon-benhamou/trading-agent-ia-v3.git
cd trading-agent-ia-v3
```

### 2. Install Dependencies

**Backend:**
```bash
cd backend
npm install
```

**Frontend:**
```bash
cd frontend
npm install
```

**Python (ML predictor):**
```bash
cd backend/python
pip install -r ../requirements.txt
```

### 3. Database Setup

**Option A: Using Docker**
```bash
docker-compose up -d postgres
```

**Option B: Local PostgreSQL**
```bash
createdb trading_agent_ia_v3
```

**Run Migrations:**
```bash
cd backend
npx prisma migrate deploy
npx prisma generate
```

### 4. Environment Configuration

Create `.env` file in `backend/`:

```bash
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/trading_agent_ia_v3"

# Exchange (Binance example)
EXCHANGE_ID="binance"
EXCHANGE_API_KEY="your_api_key"
EXCHANGE_SECRET="your_secret"
EXCHANGE_TESTNET=true  # Start with testnet!

# AI/ML (optional)
OPENAI_API_KEY="your_openai_key"
GROK_API_KEY="your_grok_key"  # Alternative to OpenAI

# Risk Management
DEFAULT_RISK_PCT=1.0
MAX_TRADES_PER_DAY=10
MAX_CONSECUTIVE_LOSSES=3

# Strategy
CONFIDENCE_THRESHOLD=55
ENTRY_ELIGIBILITY_THRESHOLD=40
MIN_RISK_REWARD=1.5

# Server
PORT=3000
FRONTEND_URL="http://localhost:5173"
```

### 5. Start the Services

**Terminal 1 - Backend:**
```bash
cd backend
npm run dev
```

**Terminal 2 - Frontend:**
```bash
cd frontend
npm run dev
```

**Terminal 3 - Python Predictor (optional):**
```bash
cd backend/python
python3 predict_service.py
```

### 6. Access the Application

- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3000
- **API Docs**: http://localhost:3000/api/docs

---

## ⚙️ Configuration

### Agent Configuration

Create an agent via the frontend or API:

```typescript
// POST /api/agent/create
{
  "symbol": "BTC/USDT",  // Or null for intelligent selection
  "aggressiveness": "reactive",  // conservative | reactive | aggressive
  "accountBalanceUsd": 10000,
  "riskPercentage": 1.0,
  "usePredictor": true,  // Use XGBoost ML predictor
  "maxTradesPerDay": 10,
  "mode": "live"  // live | paper
}
```

### Strategy Tuning

Key parameters in `.env`:

```bash
# Entry Gates
CONFIDENCE_THRESHOLD=55          # 0-100, higher = stricter
ENTRY_ELIGIBILITY_THRESHOLD=40   # 0-100, higher = stricter
MIN_RISK_REWARD=1.5              # Minimum R:R ratio

# Exit Management
STOP_ATR_MULTIPLIER=2.0          # Stop distance in ATRs
TRAIL_AFTER_R=1.2                # Start trailing at 1.2R
TRAIL_DISTANCE_PCT=60            # Trail 60% of initial stop
BREAKEVEN_AT_R=1.2               # Move to breakeven at 1.2R

# Position Sizing
DEFAULT_RISK_PCT=1.0             # Risk 1% per trade
MAX_POSITION_SIZE_PCT=20         # Max 20% of account per position

# Symbol Selection (Intelligent Agents)
MIN_VOLUME_USD=50000000          # $50M minimum volume
MIN_LIQUIDITY_USD=15000          # $15K order book depth
RESCAN_INTERVAL_MIN=30           # Rescan every 30 minutes
```

---

## 💻 Usage

### Starting an Agent

**Via Frontend:**
1. Navigate to Dashboard
2. Click "Create New Agent"
3. Configure settings (symbol, risk, mode)
4. Click "Start Agent"

**Via API:**
```bash
curl -X POST http://localhost:3000/api/agent/create \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "ETH/USDT",
    "aggressiveness": "reactive",
    "accountBalanceUsd": 5000,
    "mode": "paper"
  }'
```

### Monitoring Performance

**Real-time Dashboard:**
- View open positions
- Track P&L
- Monitor win rate, profit factor
- See trade history

**API Queries:**
```bash
# Get session KPIs
GET /api/session/:sessionId/kpi

# Get recent trades
GET /api/session/:sessionId/trades?limit=50

# Get analytics
GET /api/analytics/performance?sessionId=xxx
```

### Backtesting

Run backtests on historical data:

```bash
cd backend
npm run backtest -- --symbol BTC/USDT --from 2024-01-01 --to 2024-12-31
```

Or use the meta-adaptive backtest script:

```bash
npx tsx scripts/meta-adaptive-candle-backtest.ts
```

### Multi-Agent Pool Testing

Test multiple agents simultaneously:

```bash
npx tsx scripts/multi-agent-pool-test.ts
```

---

## 📊 Performance Monitoring

### Key Metrics

**Win Rate**: Percentage of profitable trades
- Target: 38-50% depending on mode
- Formula: `wins / totalTrades * 100`

**Profit Factor**: Ratio of gross profit to gross loss
- Target: > 1.5
- Formula: `sumWins / sumLosses`

**Expectancy**: Average profit per trade
- Target: > 0
- Formula: `(winRate * avgWin) - (lossRate * avgLoss)`

**Sharpe Ratio**: Risk-adjusted returns
- Target: > 1.0
- Formula: `mean(returns) / stddev(returns)`

**Max Drawdown**: Largest peak-to-trough decline
- Target: < 10%
- Formula: `max((peak - trough) / peak)`

### Performance Analysis Tools

```bash
# Analyze agent performance
npm run analyze:performance

# Monitor fees impact
npm run analyze:fees

# Check rejection reasons
npm run analyze:rejection

# Continuous monitoring
npm run monitor:integrated
```

### Logging

Logs are stored in `backend/logs/`:

- `agent.log` - Agent lifecycle events
- `trades.log` - Trade execution details
- `ops_events.log` - Operational events
- `errors.log` - Error tracking

---

## 📡 API Documentation

### Agent Management

**Create Agent**
```http
POST /api/agent/create
Content-Type: application/json

{
  "symbol": "BTC/USDT",
  "aggressiveness": "reactive",
  "accountBalanceUsd": 10000,
  "mode": "paper"
}
```

**Start Agent**
```http
POST /api/agent/start/:sessionId
```

**Stop Agent**
```http
POST /api/agent/stop/:sessionId
```

**Get Agent Status**
```http
GET /api/agent/status/:sessionId
```

### Trading Operations

**Get Open Positions**
```http
GET /api/positions/:sessionId
```

**Force Exit Position**
```http
POST /api/positions/:sessionId/exit
Content-Type: application/json

{
  "reason": "manual_exit"
}
```

**Trigger Symbol Reselection**
```http
POST /api/agent/reselect/:sessionId
```

### Analytics

**Get Session KPIs**
```http
GET /api/session/:sessionId/kpi
```

**Get Trade History**
```http
GET /api/session/:sessionId/trades?limit=100&offset=0
```

**Get Performance Analytics**
```http
GET /api/analytics/performance?sessionId=xxx&from=2024-01-01&to=2024-12-31
```

### WebSocket Events

Subscribe to real-time updates:

```javascript
const ws = new WebSocket('ws://localhost:3000');

ws.on('message', (data) => {
  const event = JSON.parse(data);
  
  switch(event.type) {
    case 'price_update':
      // Handle price update
      break;
    case 'position_opened':
      // Handle new position
      break;
    case 'position_closed':
      // Handle position close
      break;
    case 'kpi_update':
      // Handle KPI update
      break;
  }
});
```

---

## 🧪 Testing

### Run Test Suites

```bash
cd backend

# Unit tests
npm run test:unit

# Integration tests
npm run test:integration

# End-to-end tests
npm run test:e2e

# All tests
npm test
```

### Frontend Tests

```bash
cd frontend

# Component tests
npm test

# E2E tests with Cypress
npm run test:e2e
```

---

## 🛠️ Troubleshooting

### Common Issues

**Agent not executing trades:**
1. Check if filters are too strict (lower `CONFIDENCE_THRESHOLD`)
2. Verify exchange API keys are valid
3. Check logs for rejection reasons: `grep "BLOCKED" logs/agent.log`

**High rejection rate:**
- Review rejection analysis: `npm run analyze:rejection`
- Adjust aggressiveness mode or lower thresholds
- Check if market conditions match strategy requirements

**Poor performance:**
- Run performance analysis: `npm run analyze:performance`
- Check win rate and profit factor
- Consider adjusting stop/target ratios
- Review backtest results before going live

**WebSocket disconnections:**
- Check network stability
- Verify firewall rules
- Increase reconnection timeout in configuration

---

## 📚 Additional Documentation

- [Meta-Adaptive Crypto Selection](docs/META_ADAPTIVE_CRYPTO_SELECTION.md)
- [Phase 2 Learning System](docs/PHASE2_LEARNING_SYSTEM.md)
- [Adaptive Cooldown Implementation](docs/ADAPTIVE_COOLDOWN_IMPLEMENTATION.md)
- [Per-Agent Daily Loss Limit](docs/PER_AGENT_DAILY_LOSS_LIMIT.md)

---

## 🤝 Contributing

This is a private project. For internal contributions:

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make changes and test thoroughly
3. Commit with clear messages: `git commit -m "Add feature X"`
4. Push and create a pull request

---

## ⚠️ Disclaimer

**This software is for educational and research purposes only.**

- Trading cryptocurrencies carries significant risk
- Past performance does not guarantee future results
- Only trade with capital you can afford to lose
- Always test on paper/testnet before going live
- The authors are not responsible for any financial losses

---

## 📞 Support

For questions or issues:
- Check documentation in `docs/`
- Review logs in `backend/logs/`
- Run diagnostic scripts: `npm run analyze:*`

---

## 📄 License

Private - All Rights Reserved

---

**Built with ❤️ by the QuantAI Team**

*Last Updated: November 2025*
