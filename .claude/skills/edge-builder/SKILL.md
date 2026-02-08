---
name: edge-builder
description: Discovers, implements, and validates real trading edges that make money in crypto futures. Covers 8 proven edge categories - funding rate signals, open interest divergence, liquidation cascade detection, order flow imbalance, correlation breakdown, execution optimization, advanced risk management, and multi-data confluence scoring. Each edge includes Binance API data sources, implementation code, backtest integration, and expected Sharpe ratios from real quant fund benchmarks. Use when adding new data-driven edges to the strategy, improving signal quality beyond technical indicators, reducing execution costs, or building a multi-factor alpha system.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(python:*), Bash(node:*), Bash(npm:*), Bash(curl:*)
---

# Edge Builder

Systematically discovers, implements, and validates real trading edges that generate consistent alpha in crypto futures markets. Built on research from quant fund benchmarks (1Token Strategy Index: 11 teams, $4B+ AUM) and academic literature.

## Reality Check: What Actually Makes Money

**Proven strategies with real track records (2024-2025)**:
- Funding rate arbitrage: Sharpe > 2.0 (most consistent)
- Market-neutral long/short: Sharpe 1.5-2.5
- CTA/trend-following: Sharpe 1.0-2.0 (regime-dependent)
- High-frequency market making: 22% annual returns

**Your current system**: Momentum breakout (BB + ROC + volume) with adaptive exits. This is a CTA-style trend-following approach. Good foundation, but currently uses ONLY price + volume data. There's a massive untapped data advantage available.

**What's missing**: Your system doesn't use funding rates, open interest, liquidation data, order book depth, on-chain flows, or cross-asset correlation signals. These are FREE data from Binance API that professional quant funds use daily.

---

## Edge Categories (Ranked by Impact + Feasibility)

| # | Edge | Expected Impact | Complexity | Data Source |
|---|------|----------------|------------|-------------|
| 1 | Funding Rate Signals | +15-25% filter accuracy | Low | Binance API (free) |
| 2 | Open Interest Divergence | +10-20% exit timing | Low | Binance API (free) |
| 3 | Liquidation Cascade Detection | +5-15% entry timing | Medium | Binance API (free) |
| 4 | Execution Optimization (Maker fees) | +3-8% cost savings | Low | Already available |
| 5 | Correlation Regime Filter | +5-10% regime accuracy | Medium | Computed from existing data |
| 6 | Kelly Criterion Position Sizing | +10-20% risk-adjusted returns | Low | Computed from trade history |
| 7 | Order Flow Imbalance (CVD) | +10-15% signal quality | High | Binance WebSocket |
| 8 | Multi-Factor Confluence Scoring | +15-30% overall edge | High | Combines all above |

---

## Instructions

When building trading edges, follow this systematic process for each edge. Always implement one edge at a time, backtest it, validate out-of-sample, then move to the next.

### EDGE 1: Funding Rate Signals

**Why it works**: Funding rate reflects market positioning. Extremely positive funding = crowded longs = mean reversion risk. Extremely negative = crowded shorts = short squeeze risk. This is the single highest-Sharpe edge in crypto (>2.0 at quant funds).

**Data source**: Binance Futures API (free, no authentication needed for public data)

#### Step 1: Create Funding Rate Data Collector

Create `backend/src/services/fundingRateService.ts`:

```typescript
import { Exchange } from '../types/exchange.js';

interface FundingSnapshot {
  symbol: string;
  fundingRate: number;       // Current funding rate (e.g., 0.0001 = 0.01%)
  nextFundingTime: number;   // Timestamp of next funding
  markPrice: number;
  indexPrice: number;
  timestamp: number;
}

interface FundingSignal {
  symbol: string;
  rate: number;
  annualizedRate: number;    // rate * 3 * 365 (3 payments/day)
  regime: 'EXTREME_LONG' | 'CROWDED_LONG' | 'NEUTRAL' | 'CROWDED_SHORT' | 'EXTREME_SHORT';
  signal: 'AVOID_LONG' | 'FAVOR_SHORT' | 'NEUTRAL' | 'FAVOR_LONG' | 'AVOID_SHORT';
  confidence: number;        // 0-100
}

// Thresholds calibrated from 2024-2025 data
const FUNDING_THRESHOLDS = {
  EXTREME_LONG: 0.0005,     // 0.05% per 8h = 54.75% annualized (very crowded)
  CROWDED_LONG: 0.0002,     // 0.02% per 8h = 21.9% annualized
  NEUTRAL_LOW: -0.0001,
  NEUTRAL_HIGH: 0.0001,
  CROWDED_SHORT: -0.0002,
  EXTREME_SHORT: -0.0005,
};

export class FundingRateService {
  private cache: Map<string, FundingSnapshot> = new Map();
  private cacheTtlMs = 60_000; // 1 minute (funding changes every 8h)
  private lastFetch = 0;

  /**
   * Fetch current funding rates for all symbols
   * Binance endpoint: GET /fapi/v1/premiumIndex (0 weight for single, 1 for all)
   */
  async fetchFundingRates(exchange: Exchange): Promise<Map<string, FundingSnapshot>> {
    const now = Date.now();
    if (now - this.lastFetch < this.cacheTtlMs) return this.cache;

    try {
      // CCXT method - works with your existing exchange instance
      const tickers = await exchange.fetchFundingRates();

      for (const [symbol, data] of Object.entries(tickers)) {
        this.cache.set(symbol, {
          symbol,
          fundingRate: (data as any).fundingRate || 0,
          nextFundingTime: (data as any).fundingTimestamp || 0,
          markPrice: (data as any).markPrice || 0,
          indexPrice: (data as any).indexPrice || 0,
          timestamp: now,
        });
      }
      this.lastFetch = now;
    } catch (error) {
      console.warn('[FundingRate] Failed to fetch:', error);
    }

    return this.cache;
  }

  /**
   * Get trading signal from funding rate for a specific symbol
   */
  analyzeFunding(symbol: string): FundingSignal | null {
    const snapshot = this.cache.get(symbol);
    if (!snapshot) return null;

    const rate = snapshot.fundingRate;
    const annualized = rate * 3 * 365; // 3 payments per day

    let regime: FundingSignal['regime'];
    let signal: FundingSignal['signal'];
    let confidence: number;

    if (rate >= FUNDING_THRESHOLDS.EXTREME_LONG) {
      regime = 'EXTREME_LONG';
      signal = 'AVOID_LONG';  // Market is extremely crowded long
      confidence = Math.min(100, (rate / FUNDING_THRESHOLDS.EXTREME_LONG) * 70);
    } else if (rate >= FUNDING_THRESHOLDS.CROWDED_LONG) {
      regime = 'CROWDED_LONG';
      signal = 'FAVOR_SHORT';
      confidence = 50 + (rate / FUNDING_THRESHOLDS.EXTREME_LONG) * 30;
    } else if (rate <= FUNDING_THRESHOLDS.EXTREME_SHORT) {
      regime = 'EXTREME_SHORT';
      signal = 'AVOID_SHORT';  // Market is extremely crowded short
      confidence = Math.min(100, (Math.abs(rate) / Math.abs(FUNDING_THRESHOLDS.EXTREME_SHORT)) * 70);
    } else if (rate <= FUNDING_THRESHOLDS.CROWDED_SHORT) {
      regime = 'CROWDED_SHORT';
      signal = 'FAVOR_LONG';
      confidence = 50 + (Math.abs(rate) / Math.abs(FUNDING_THRESHOLDS.EXTREME_SHORT)) * 30;
    } else {
      regime = 'NEUTRAL';
      signal = 'NEUTRAL';
      confidence = 30;
    }

    return { symbol, rate, annualizedRate: annualized, regime, signal, confidence };
  }
}
```

#### Step 2: Integrate into Signal Filter

Add funding rate check in `positionOpener.ts` or `momentumSimple.ts` entry conditions:

```typescript
// In checkMomentumSignal() or openPosition pre-checks:
const fundingSignal = fundingService.analyzeFunding(symbol);

if (fundingSignal) {
  // BLOCK entries against extreme funding
  if (side === 'long' && fundingSignal.signal === 'AVOID_LONG') {
    logger.info(`[${symbol}] SKIP LONG: Extreme funding ${(fundingSignal.rate * 100).toFixed(4)}% (crowded longs)`);
    return null; // Skip this signal
  }
  if (side === 'short' && fundingSignal.signal === 'AVOID_SHORT') {
    logger.info(`[${symbol}] SKIP SHORT: Extreme negative funding (crowded shorts)`);
    return null;
  }

  // BOOST score for signals aligned with funding
  if (side === 'long' && fundingSignal.signal === 'FAVOR_LONG') {
    signalScore += 1.5; // Bonus: short squeeze potential
  }
  if (side === 'short' && fundingSignal.signal === 'FAVOR_SHORT') {
    signalScore += 1.5; // Bonus: long liquidation cascade potential
  }
}
```

#### Step 3: Backtest with Funding Data

For backtesting, fetch historical funding rates:

```typescript
// Binance endpoint: GET /fapi/v1/fundingRate
// Parameters: symbol, startTime, endTime, limit (max 1000)
// Returns: { symbol, fundingRate, fundingTime, markPrice }

async function fetchHistoricalFunding(symbol: string, startTime: number, endTime: number): Promise<FundingSnapshot[]> {
  const results: FundingSnapshot[] = [];
  let cursor = startTime;

  while (cursor < endTime) {
    const response = await fetch(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol.replace('/', '')}&startTime=${cursor}&limit=1000`
    );
    const data = await response.json();
    if (!data.length) break;

    for (const item of data) {
      results.push({
        symbol,
        fundingRate: parseFloat(item.fundingRate),
        nextFundingTime: item.fundingTime,
        markPrice: parseFloat(item.markPrice || '0'),
        indexPrice: 0,
        timestamp: item.fundingTime,
      });
    }
    cursor = data[data.length - 1].fundingTime + 1;
  }

  return results;
}
```

#### Validation Criteria
- Run 12-month backtest WITH and WITHOUT funding filter
- Expected: -10-20% trades (more selective), +5-10pp win rate, better Sharpe
- If win rate improvement < 3pp, the edge is too weak for your timeframe

---

### EDGE 2: Open Interest Divergence

**Why it works**: When price goes up but open interest goes down, it means traders are closing positions (taking profits), not opening new ones. Rallies without new money are weak. When price drops but OI rises, new shorts are entering = potential squeeze if price reverses.

**Data source**: Binance API `GET /fapi/v1/openInterest` (free)

#### Step 1: Create Open Interest Service

Create `backend/src/services/openInterestService.ts`:

```typescript
interface OISnapshot {
  symbol: string;
  openInterest: number;      // Total open interest in contracts
  openInterestValue: number;  // Total OI in USDT
  timestamp: number;
}

interface OIDivergence {
  symbol: string;
  priceChange5m: number;     // % price change over 5 minutes
  oiChange5m: number;        // % OI change over 5 minutes
  divergenceType: 'BULLISH_DIV' | 'BEARISH_DIV' | 'CONFIRMING' | 'NEUTRAL';
  strength: number;          // 0-100
}

export class OpenInterestService {
  private history: Map<string, OISnapshot[]> = new Map();
  private maxHistory = 30; // Keep 30 snapshots (~2.5h at 5min intervals)

  /**
   * Fetch current open interest
   * Binance: GET /fapi/v1/openInterest (weight: 1)
   */
  async fetchOI(exchange: Exchange, symbol: string): Promise<OISnapshot | null> {
    try {
      // Direct Binance API call (CCXT doesn't always expose OI well)
      const binanceSymbol = symbol.replace('/', '').replace(':USDT', '');
      const response = await fetch(
        `https://fapi.binance.com/fapi/v1/openInterest?symbol=${binanceSymbol}USDT`
      );
      const data = await response.json();

      const snapshot: OISnapshot = {
        symbol,
        openInterest: parseFloat(data.openInterest),
        openInterestValue: parseFloat(data.openInterest) * parseFloat(data.openInterest), // Approximate
        timestamp: Date.now(),
      };

      // Add to history
      const hist = this.history.get(symbol) || [];
      hist.push(snapshot);
      if (hist.length > this.maxHistory) hist.shift();
      this.history.set(symbol, hist);

      return snapshot;
    } catch {
      return null;
    }
  }

  /**
   * Detect OI-price divergence
   * BULLISH_DIV: Price down + OI down = weak selling, potential reversal
   * BEARISH_DIV: Price up + OI down = weak rally, profit-taking
   */
  detectDivergence(symbol: string, currentPrice: number, priceNMinAgo: number): OIDivergence | null {
    const hist = this.history.get(symbol);
    if (!hist || hist.length < 2) return null;

    const latest = hist[hist.length - 1];
    const earlier = hist[0]; // ~N snapshots ago

    const priceChangePct = ((currentPrice - priceNMinAgo) / priceNMinAgo) * 100;
    const oiChangePct = ((latest.openInterest - earlier.openInterest) / earlier.openInterest) * 100;

    let divergenceType: OIDivergence['divergenceType'];
    let strength: number;

    if (priceChangePct > 0.5 && oiChangePct < -1) {
      // Price up, OI down = BEARISH divergence (weak rally)
      divergenceType = 'BEARISH_DIV';
      strength = Math.min(100, Math.abs(oiChangePct) * 20);
    } else if (priceChangePct < -0.5 && oiChangePct < -1) {
      // Price down, OI down = BULLISH divergence (shorts closing, could reverse)
      divergenceType = 'BULLISH_DIV';
      strength = Math.min(100, Math.abs(oiChangePct) * 20);
    } else if (Math.sign(priceChangePct) === Math.sign(oiChangePct)) {
      // Same direction = confirming move
      divergenceType = 'CONFIRMING';
      strength = Math.min(100, Math.abs(oiChangePct) * 10);
    } else {
      divergenceType = 'NEUTRAL';
      strength = 0;
    }

    return { symbol, priceChange5m: priceChangePct, oiChange5m: oiChangePct, divergenceType, strength };
  }
}
```

#### Step 2: Integrate into Exit Logic

OI divergence is most powerful for exits (detecting weakening trends):

```typescript
// In shouldExitPosition() or 15m exit logic:
const oiDiv = oiService.detectDivergence(symbol, currentPrice, priceAtEntry);

if (oiDiv && position.side === 'long' && oiDiv.divergenceType === 'BEARISH_DIV' && oiDiv.strength > 60) {
  // Rally weakening - tighten trailing stop
  trailingDistance *= 0.7; // 30% tighter trailing
  logger.info(`[${symbol}] OI BEARISH DIV: Tightening trailing (OI: ${oiDiv.oiChange5m.toFixed(1)}%)`);
}

if (oiDiv && position.side === 'short' && oiDiv.divergenceType === 'BULLISH_DIV' && oiDiv.strength > 60) {
  // Sell-off weakening - tighten trailing
  trailingDistance *= 0.7;
}
```

#### Validation Criteria
- Compare exit timing with vs without OI divergence tightening
- Expected: Better exit prices on 15-25% of trades, +0.5-1% average PnL improvement

---

### EDGE 3: Liquidation Cascade Detection

**Why it works**: Crypto futures have cascading liquidations. When price drops 3%, leveraged longs get liquidated, their forced sells push price further, triggering more liquidations. Detecting the START of a cascade lets you either: (a) avoid entering during cascades, or (b) enter AFTER the cascade exhausts (mean reversion).

**Data source**: Binance `GET /fapi/v1/forceOrders` (forced liquidation orders)

#### Step 1: Create Liquidation Monitor

```typescript
interface LiquidationEvent {
  symbol: string;
  side: 'BUY' | 'SELL'; // BUY = short liquidation, SELL = long liquidation
  price: number;
  qty: number;
  quoteQty: number; // USD value
  time: number;
}

interface LiquidationState {
  symbol: string;
  longLiquidations1h: number;   // Total long liquidation value (USD) in last hour
  shortLiquidations1h: number;
  cascadeActive: boolean;       // Is a cascade happening NOW?
  cascadeDirection: 'LONG_CASCADE' | 'SHORT_CASCADE' | null;
  intensity: number;            // 0-100 (based on liquidation volume vs avg)
}

// Thresholds (calibrate from your symbols' typical liquidation volumes)
const CASCADE_THRESHOLDS = {
  MIN_USD_1H: 500_000,        // $500K liquidated in 1h = noteworthy
  CASCADE_USD_1H: 2_000_000,  // $2M = cascade territory
  EXTREME_USD_1H: 10_000_000, // $10M = extreme cascade
};

export class LiquidationMonitor {
  private events: Map<string, LiquidationEvent[]> = new Map();

  /**
   * Fetch recent forced liquidation orders
   * Binance: GET /fapi/v1/forceOrders (weight: 20)
   * Rate limit: Call every 5 minutes max
   */
  async fetchLiquidations(symbol?: string): Promise<void> {
    try {
      const url = symbol
        ? `https://fapi.binance.com/fapi/v1/forceOrders?symbol=${symbol}&limit=100`
        : `https://fapi.binance.com/fapi/v1/forceOrders?limit=100`;
      const response = await fetch(url);
      const data = await response.json();

      for (const order of data) {
        const sym = order.symbol;
        const event: LiquidationEvent = {
          symbol: sym,
          side: order.side,
          price: parseFloat(order.price),
          qty: parseFloat(order.origQty),
          quoteQty: parseFloat(order.price) * parseFloat(order.origQty),
          time: order.time,
        };

        const events = this.events.get(sym) || [];
        events.push(event);
        // Keep only last 1h of events
        const cutoff = Date.now() - 3600_000;
        this.events.set(sym, events.filter(e => e.time > cutoff));
      }
    } catch {
      // Silent fail - liquidation data is supplementary
    }
  }

  /**
   * Analyze liquidation state for a symbol
   */
  getState(symbol: string): LiquidationState {
    const events = this.events.get(symbol) || [];
    const now = Date.now();
    const cutoff1h = now - 3600_000;

    const recent = events.filter(e => e.time > cutoff1h);
    const longLiqs = recent.filter(e => e.side === 'SELL'); // Long liquidation = forced SELL
    const shortLiqs = recent.filter(e => e.side === 'BUY'); // Short liquidation = forced BUY

    const longLiqValue = longLiqs.reduce((sum, e) => sum + e.quoteQty, 0);
    const shortLiqValue = shortLiqs.reduce((sum, e) => sum + e.quoteQty, 0);

    const maxLiq = Math.max(longLiqValue, shortLiqValue);
    const cascadeActive = maxLiq >= CASCADE_THRESHOLDS.CASCADE_USD_1H;
    const cascadeDirection = cascadeActive
      ? (longLiqValue > shortLiqValue ? 'LONG_CASCADE' : 'SHORT_CASCADE')
      : null;
    const intensity = Math.min(100, (maxLiq / CASCADE_THRESHOLDS.EXTREME_USD_1H) * 100);

    return {
      symbol,
      longLiquidations1h: longLiqValue,
      shortLiquidations1h: shortLiqValue,
      cascadeActive,
      cascadeDirection,
      intensity,
    };
  }
}
```

#### Step 2: Integration

```typescript
// PRE-ENTRY CHECK: Don't enter during active cascades
const liqState = liqMonitor.getState(symbol);

if (liqState.cascadeActive) {
  if (side === 'long' && liqState.cascadeDirection === 'LONG_CASCADE') {
    logger.info(`[${symbol}] SKIP: Active long liquidation cascade ($${(liqState.longLiquidations1h/1e6).toFixed(1)}M)`);
    return null; // Don't catch falling knives
  }
  if (side === 'short' && liqState.cascadeDirection === 'SHORT_CASCADE') {
    logger.info(`[${symbol}] SKIP: Active short squeeze ($${(liqState.shortLiquidations1h/1e6).toFixed(1)}M)`);
    return null;
  }
}

// POST-CASCADE ENTRY: Mean reversion after cascade exhaustion
// (cascade was active 15-30 min ago but has stopped = potential reversal)
```

---

### EDGE 4: Execution Optimization

**Why it works**: Your system already uses NFS limit orders, but there's still room. At 7bps round-trip, with 1000+ trades, even 2bps savings = significant. Maker fees are typically 0.02% vs taker 0.04% on Binance Futures.

#### Step 1: Always-Maker Entry Orders

```typescript
// Current: Market orders for entry
// Improved: Post-only limit orders at best bid/ask

async function placeSmartEntry(
  exchange: Exchange,
  symbol: string,
  side: 'buy' | 'sell',
  amount: number,
  timeoutMs = 5000
): Promise<Order | null> {
  // Get current order book
  const ticker = await exchange.fetchTicker(symbol);

  // Place limit at best bid (for buy) or best ask (for sell)
  // Post-only = guaranteed maker fee (0.02% vs 0.04%)
  const price = side === 'buy' ? ticker.bid : ticker.ask;

  const order = await exchange.createOrder(symbol, 'limit', side, amount, price, {
    postOnly: true,  // Ensures maker fee
    timeInForce: 'GTX', // Post-only on Binance Futures
  });

  // Wait for fill with timeout
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await exchange.fetchOrder(order.id, symbol);
    if (status.status === 'closed') return status;
    if (status.status === 'canceled') break;
    await sleep(500);
  }

  // Timeout: Cancel and use market order as fallback
  await exchange.cancelOrder(order.id, symbol);
  return exchange.createOrder(symbol, 'market', side, amount);
}
```

#### Fee Impact Analysis
```
Current: 100% taker entries = 0.04% per entry
Improved: 70% maker entries = 0.70 * 0.02% + 0.30 * 0.04% = 0.026% per entry
Savings per entry: 0.014%
With 5x leverage: 0.07% per trade
With 1000 trades/year: 70% cost reduction on entries = ~$700 per $100K capital
```

---

### EDGE 5: Correlation Regime Filter

**Why it works**: When BTC-altcoin correlation breaks down, it signals either an altseason (alts outperform) or a flight to BTC (alts crash harder). Your system already tracks BTC macro but doesn't measure correlation dynamics.

#### Step 1: Rolling Correlation Calculator

```typescript
function calculateRollingCorrelation(
  btcReturns: number[],
  altReturns: number[],
  window = 20
): number {
  if (btcReturns.length < window || altReturns.length < window) return 1;

  const btcSlice = btcReturns.slice(-window);
  const altSlice = altReturns.slice(-window);

  const btcMean = btcSlice.reduce((a, b) => a + b, 0) / window;
  const altMean = altSlice.reduce((a, b) => a + b, 0) / window;

  let covariance = 0;
  let btcVar = 0;
  let altVar = 0;

  for (let i = 0; i < window; i++) {
    const btcDev = btcSlice[i] - btcMean;
    const altDev = altSlice[i] - altMean;
    covariance += btcDev * altDev;
    btcVar += btcDev * btcDev;
    altVar += altDev * altDev;
  }

  const denom = Math.sqrt(btcVar * altVar);
  return denom > 0 ? covariance / denom : 0;
}

// Usage: Compute on each 15m candle close
const correlation = calculateRollingCorrelation(btcReturns15m, altReturns15m, 20);

// Correlation regime interpretation:
// > 0.85: High correlation (normal market, safe to trade alts)
// 0.5-0.85: Moderate (normal range)
// < 0.5: Decorrelation (altseason starting OR alts crashing)
// < 0.2: Extreme decorrelation (strong regime shift)

if (correlation < 0.3 && btcChange > 0) {
  // BTC up but alt not following = alt weakness, avoid long
  signalScore -= 2;
}
if (correlation < 0.3 && btcChange < 0 && altChange > 0) {
  // Alt rising while BTC falls = alt strength, strong long signal
  signalScore += 2;
}
```

---

### EDGE 6: Kelly Criterion Position Sizing

**Why it works**: Your system uses fixed 1.5% risk per trade. Kelly criterion optimizes bet size based on your actual win rate and average win/loss ratio. Proven mathematically to maximize long-term growth rate.

```typescript
interface KellyResult {
  fullKelly: number;      // Optimal fraction (often too aggressive)
  halfKelly: number;      // Recommended: half-Kelly (better risk-adjusted)
  quarterKelly: number;   // Conservative
  currentRisk: number;    // Your current RISK_PCT_PER_TRADE
  recommendation: string;
}

function calculateKelly(
  winRate: number,          // e.g., 0.60 (60%)
  avgWinPct: number,        // e.g., 3.5 (average winning trade %)
  avgLossPct: number,       // e.g., 2.0 (average losing trade %, positive number)
  currentRisk = 0.015
): KellyResult {
  // Kelly formula: f* = (p * b - q) / b
  // where p = win probability, q = loss probability, b = win/loss ratio
  const p = winRate;
  const q = 1 - winRate;
  const b = avgWinPct / avgLossPct; // Payoff ratio

  const fullKelly = (p * b - q) / b;
  const halfKelly = fullKelly / 2;
  const quarterKelly = fullKelly / 4;

  let recommendation: string;
  if (currentRisk > fullKelly) {
    recommendation = `OVER-BETTING: Current risk ${(currentRisk * 100).toFixed(1)}% > Kelly ${(fullKelly * 100).toFixed(1)}%. Reduce to half-Kelly: ${(halfKelly * 100).toFixed(2)}%`;
  } else if (currentRisk < quarterKelly) {
    recommendation = `UNDER-BETTING: Current risk ${(currentRisk * 100).toFixed(1)}% < quarter-Kelly. Could increase to half-Kelly: ${(halfKelly * 100).toFixed(2)}%`;
  } else {
    recommendation = `OPTIMAL RANGE: Current risk ${(currentRisk * 100).toFixed(1)}% is between quarter and full Kelly. Good.`;
  }

  return { fullKelly, halfKelly, quarterKelly, currentRisk, recommendation };
}

// After each backtest or after N live trades, recalculate:
// const kelly = calculateKelly(0.60, 3.5, 2.0);
// If halfKelly suggests 2.1% and you're using 1.5%, consider increasing
```

**Dynamic Kelly**: Recalculate every 50 trades using rolling window. Adjust RISK_PCT_PER_TRADE based on recent performance. When in drawdown, use quarter-Kelly. When in profit, use half-Kelly.

---

### EDGE 7: Order Flow Imbalance (CVD)

**Why it works**: Cumulative Volume Delta measures the imbalance between market buy and market sell orders. Persistent buy imbalance = bullish. This requires WebSocket trade stream data.

**Complexity**: HIGH - requires processing raw trade data in real-time.

#### Step 1: CVD Calculator

```typescript
interface CVDState {
  symbol: string;
  cvd1m: number;          // 1-minute CVD
  cvd5m: number;          // 5-minute CVD
  cvd15m: number;         // 15-minute CVD
  buyVolume: number;      // Total buy volume in window
  sellVolume: number;     // Total sell volume in window
  imbalance: number;      // buy/(buy+sell) - 0.5 ... positive = buy pressure
}

// Subscribe to Binance aggTrade stream
// wss://fstream.binance.com/ws/{symbol}@aggTrade
// Each trade has: { m: true/false } where m=true means buyer is maker (= market SELL)

class CVDTracker {
  private trades: Map<string, Array<{ time: number; qty: number; isBuyerMaker: boolean }>> = new Map();

  processTrade(symbol: string, qty: number, isBuyerMaker: boolean): void {
    const trades = this.trades.get(symbol) || [];
    trades.push({ time: Date.now(), qty, isBuyerMaker });

    // Keep only 15 minutes of trades
    const cutoff = Date.now() - 900_000;
    this.trades.set(symbol, trades.filter(t => t.time > cutoff));
  }

  getCVD(symbol: string): CVDState | null {
    const trades = this.trades.get(symbol);
    if (!trades || trades.length === 0) return null;

    const now = Date.now();
    let buyVol = 0, sellVol = 0;
    let buyVol1m = 0, sellVol1m = 0;
    let buyVol5m = 0, sellVol5m = 0;

    for (const t of trades) {
      const age = now - t.time;
      if (t.isBuyerMaker) {
        sellVol += t.qty; // buyer is maker = market sell
        if (age < 60_000) sellVol1m += t.qty;
        if (age < 300_000) sellVol5m += t.qty;
      } else {
        buyVol += t.qty;  // seller is maker = market buy
        if (age < 60_000) buyVol1m += t.qty;
        if (age < 300_000) buyVol5m += t.qty;
      }
    }

    const totalVol = buyVol + sellVol;
    return {
      symbol,
      cvd1m: buyVol1m - sellVol1m,
      cvd5m: buyVol5m - sellVol5m,
      cvd15m: buyVol - sellVol,
      buyVolume: buyVol,
      sellVolume: sellVol,
      imbalance: totalVol > 0 ? (buyVol / totalVol) - 0.5 : 0,
    };
  }
}
```

#### Step 2: Integration as Signal Boost

```typescript
// In checkMomentumSignal(), add CVD confirmation:
const cvd = cvdTracker.getCVD(symbol);
if (cvd) {
  // Strong buy imbalance confirms long signal
  if (side === 'long' && cvd.imbalance > 0.1) {
    signalScore += 1.0; // 10%+ buy imbalance
  }
  // Strong sell imbalance confirms short signal
  if (side === 'short' && cvd.imbalance < -0.1) {
    signalScore += 1.0;
  }
  // Divergence: Price up but sell pressure = warning
  if (side === 'long' && cvd.imbalance < -0.05 && cvd.cvd5m < 0) {
    signalScore -= 1.5; // Price rising on sell pressure = weak
  }
}
```

---

### EDGE 8: Multi-Factor Confluence Scoring

**The Meta-Edge**: Combine all individual edges into a single composite score. This is where the real alpha lives - individual edges are 55-60% accurate, but multiple confirming edges together can reach 65-75%.

```typescript
interface EdgeScores {
  momentum: number;      // Existing: BB, ROC, volume (0-10)
  funding: number;       // Edge 1: Funding rate alignment (0-10)
  oiDivergence: number;  // Edge 2: OI divergence (0-10)
  liquidation: number;   // Edge 3: No active cascade (0-10)
  correlation: number;   // Edge 5: BTC correlation regime (0-10)
  cvd: number;           // Edge 7: Order flow alignment (0-10)
}

function calculateCompositeScore(edges: EdgeScores): {
  score: number;          // 0-100
  confidence: string;     // 'HIGH' | 'MEDIUM' | 'LOW'
  confirming: number;     // How many edges agree
  conflicting: number;    // How many edges disagree
} {
  // Weights based on edge reliability (sum = 1.0)
  const weights = {
    momentum: 0.30,       // Core signal (most tested)
    funding: 0.20,        // Strong edge (highest Sharpe in industry)
    oiDivergence: 0.15,   // Good confirming signal
    cvd: 0.15,            // Real-time order flow
    correlation: 0.10,    // Regime filter
    liquidation: 0.10,    // Safety filter
  };

  const weighted =
    edges.momentum * weights.momentum +
    edges.funding * weights.funding +
    edges.oiDivergence * weights.oiDivergence +
    edges.cvd * weights.cvd +
    edges.correlation * weights.correlation +
    edges.liquidation * weights.liquidation;

  const score = weighted * 10; // Scale to 0-100

  // Count confirming/conflicting edges (> 5 = confirming, < 3 = conflicting)
  const edgeValues = Object.values(edges);
  const confirming = edgeValues.filter(v => v > 5).length;
  const conflicting = edgeValues.filter(v => v < 3).length;

  let confidence: string;
  if (confirming >= 5 && conflicting === 0) confidence = 'HIGH';
  else if (confirming >= 3 && conflicting <= 1) confidence = 'MEDIUM';
  else confidence = 'LOW';

  return { score, confidence, confirming, conflicting };
}

// ENTRY RULE: Only enter when score > 60 AND confidence >= 'MEDIUM'
// EXIT RULE: Tighten trailing when score drops below 40
```

---

## Implementation Order

Follow this exact sequence to avoid overwhelming the system:

### Phase 1: Low-Hanging Fruit (Week 1-2)
1. **Funding Rate Service** - Create service, integrate as entry filter
2. **Kelly Criterion** - Calculate from backtest data, adjust RISK_PCT_PER_TRADE
3. **Maker Fee Optimization** - Switch entries to post-only limit orders

### Phase 2: Data Enrichment (Week 3-4)
4. **Open Interest Service** - Create service, integrate into exit logic
5. **Correlation Regime** - Add to existing BTC macro filter
6. **Liquidation Monitor** - Create service, use as safety filter

### Phase 3: Advanced (Week 5-8)
7. **CVD/Order Flow** - WebSocket integration for trade stream
8. **Multi-Factor Scoring** - Combine all edges into composite system

### Phase 4: Validation (Ongoing)
- Backtest each edge in isolation (12 months minimum)
- Walk-forward test combined edges
- Paper trade for 2-4 weeks before live deployment
- Monitor Sharpe ratio improvement vs baseline

---

## Validation Framework

For EVERY edge implemented, run this validation:

```bash
# 1. Baseline backtest (without new edge)
npm run test:backtest -- --config baseline_v5_91

# 2. Edge backtest (with new edge enabled)
npm run test:backtest -- --config edge_funding_v1

# 3. Compare metrics
# Required improvements to keep edge:
# - Win rate: +3pp minimum (e.g., 60% → 63%)
# - Sharpe ratio: +0.1 minimum (e.g., 1.5 → 1.6)
# - Max drawdown: no worse than +5% (e.g., 25% → max 30%)
# - Trade count: no less than 70% of baseline (selectivity is OK, but not below 70%)

# 4. Walk-forward validation
POST /api/backtest/walk-forward
{
  "startDate": "2024-01-01",
  "endDate": "2025-12-31",
  "trainMonths": 6,
  "testMonths": 3,
  "overrides": { "FUNDING_FILTER_ENABLED": true }
}

# 5. Out-of-sample test performance must be > 80% of in-sample
# If not: OVERFITTED, disable the edge
```

---

## Config Integration

Add new edge config to `MomentumConfig` in `momentumSimple.ts`:

```typescript
// Add to MomentumConfig:
EDGE: {
  // Funding Rate Filter
  FUNDING_FILTER_ENABLED: false,           // Start disabled, enable after validation
  FUNDING_EXTREME_THRESHOLD: 0.0005,       // 0.05% per 8h
  FUNDING_CROWDED_THRESHOLD: 0.0002,       // 0.02% per 8h
  FUNDING_SIGNAL_BOOST: 1.5,              // Score boost for aligned funding

  // Open Interest Divergence
  OI_DIVERGENCE_ENABLED: false,
  OI_TIGHTEN_FACTOR: 0.7,                // Trailing tightening on divergence
  OI_MIN_STRENGTH: 60,                    // Minimum divergence strength (0-100)

  // Liquidation Cascade
  LIQ_CASCADE_FILTER_ENABLED: false,
  LIQ_CASCADE_USD_THRESHOLD: 2_000_000,   // $2M liquidated in 1h
  LIQ_CASCADE_SKIP_ENTRY: true,           // Skip entries during cascades

  // Execution
  MAKER_ENTRY_ENABLED: false,
  MAKER_ENTRY_TIMEOUT_MS: 5000,
  MAKER_FALLBACK_TO_MARKET: true,

  // Correlation
  CORRELATION_FILTER_ENABLED: false,
  CORRELATION_WINDOW: 20,                 // 20 candles rolling
  CORRELATION_LOW_THRESHOLD: 0.3,         // Below this = decorrelation

  // Kelly Sizing
  KELLY_ENABLED: false,
  KELLY_FRACTION: 0.5,                    // Half-Kelly (recommended)
  KELLY_RECALC_TRADES: 50,               // Recalculate every N trades

  // CVD/Order Flow
  CVD_ENABLED: false,
  CVD_IMBALANCE_THRESHOLD: 0.1,          // 10% imbalance for signal boost
  CVD_BOOST: 1.0,                         // Score boost on confirmation

  // Multi-Factor
  COMPOSITE_SCORE_ENABLED: false,
  COMPOSITE_MIN_SCORE: 60,               // Minimum score to enter
  COMPOSITE_MIN_CONFIDENCE: 'MEDIUM',    // Minimum confidence level
},
```

---

## Key Principles

1. **One edge at a time**: Don't implement all 8 at once. Add one, validate, then add the next.
2. **Always start disabled**: Every edge starts with `ENABLED: false`. Only enable after passing validation.
3. **Data before code**: Collect historical data first, analyze it, THEN decide if the edge is worth coding.
4. **Backtest is necessary but not sufficient**: Always paper trade after backtest validation.
5. **Monitor degradation**: Edges decay over time as markets adapt. Review monthly.
6. **Don't over-optimize**: If your Sharpe goes from 1.5 to 1.6, that's good. If it goes to 3.0, you're overfitting.
7. **Execution costs are real**: Every edge must beat its execution cost. An edge that generates 5bps alpha but costs 7bps in additional API calls or slippage is negative EV.
8. **Correlation between edges**: If funding and OI both say "avoid", that's stronger than one alone. But if they always agree, you're double-counting the same information.
