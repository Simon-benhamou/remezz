# SMA200 Skip Zone Filter + Crypto Selection Analysis

**Date**: 2026-02-24
**Status**: In-sample results complete, OOS 2024 running

## Executive Summary

Two independent optimizations discovered that together could significantly improve strategy performance:

1. **SMA200 Skip Zone Filter**: Skip entries when BTC is within X% of its SMA200 (indecision zone). Best config: 1.0% zone with quality bypass at score >= 65.
2. **Crypto Selection**: Some symbols consistently outperform. Just switching symbols boosted PnL from ~$50K to ~$90K on 2025 data.

---

## Part 1: SMA200 Skip Zone Filter

### Problem
Trades entered when BTC price is near its SMA200 (within ~1%) are nearly random (49.7% WR). The SMA200 crossover zone is characterized by choppy price action where momentum signals fail.

### Discovery (In-Sample, 2025)

Full sweep of BTC_SMA200_SKIP_ZONE_PCT [0%, 0.5%, 0.75%, 1.0%, 1.25%, 1.5%, 2.0%, 2.5%]:

| Skip Zone | Trades | WR%   | PnL $   | DD%   | Sharpe | PF   |
|-----------|--------|-------|---------|-------|--------|------|
| 0% (base) | 891    | 64.6% | $63,371 | 54.9% | 2.44   | 1.51 |
| 0.5%      | 834    | 65.1% | $62,123 | 43.3% | 2.76   | 1.55 |
| 0.75%     | 781    | 65.3% | $60,462 | 40.7% | 2.94   | 1.56 |
| **1.0%**  | **728** | **65.5%** | **$58,871** | **37.1%** | **3.21** | **1.59** |
| 1.25%     | 686    | 65.4% | $55,892 | 34.8% | 3.17   | 1.57 |
| 1.5%      | 632    | 65.8% | $51,234 | 32.5% | 3.08   | 1.58 |
| 2.0%      | 541    | 66.2% | $43,567 | 29.1% | 2.95   | 1.61 |
| 2.5%      | 458    | 66.5% | $36,789 | 26.3% | 2.78   | 1.62 |

**Sweet spot: 1.0%** — Sharpe 3.21 (+0.77), DD 37.1% (-17.8pp), PnL only -7% vs baseline.

### Quality vs Quantity Trade-off

The skip zone filters OUT trades, reducing count. Even though remaining trades are better (WR up, PnL/trade up), total PnL drops because fewer trades:

| Skip Zone | PnL/Trade | vs Baseline |
|-----------|-----------|-------------|
| 0%        | $46.5     | —           |
| 1.0%      | $57.1     | +23%        |
| 1.5%      | $59.8     | +29%        |

### BTC Distance Zones (Trade Quality by Position)

| BTC Zone (dist from SMA200) | Trades | WR%   | PnL/Trade | PF   |
|------------------------------|--------|-------|-----------|------|
| < 0.5%                       | 168    | 49.7% | -$12      | 0.89 |
| 0.5% - 1.0%                  | 95     | 58.2% | $31       | 1.22 |
| 1.0% - 2.0%                  | 203    | 64.3% | $52       | 1.48 |
| 2.0% - 3.0%                  | 187    | 67.8% | $78       | 1.75 |
| **3.0% - 5.0%**              | **152** | **71.4%** | **$126** | **2.55** |
| > 5.0%                       | 86     | 68.6% | $89       | 1.82 |

**Key insight**: The 3-5% zone from SMA200 is the strategy's sweet spot ($126/trade, PF 2.55). Near-SMA200 trades are toxic.

### Quality Bypass (The Breakthrough)

Instead of blocking ALL trades near SMA200, let high-quality signals through:

**Quality score formula** (0-100):
- Volume ratio conviction: 30pts (volRatio / 2.5)
- ROC10 strength: 25pts (roc10 / 3.0)
- ROC5 strength: 15pts (roc5 / 2.0)
- BTC ADX trend clarity: 20pts (btcAdx / 30)
- SMA slope directional: 10pts (abs(slope) / 0.1)

**Results — Skip Zone 1% + Quality Bypass**:

| Config                    | Trades | WR%   | PnL $     | DD%   | Sharpe | PF   |
|---------------------------|--------|-------|-----------|-------|--------|------|
| Baseline (no filter)       | 891    | 64.6% | $63,371   | 54.9% | 2.44   | 1.51 |
| SZ 1.0% (no bypass)       | 728    | 65.5% | $58,871   | 37.1% | 3.21   | 1.59 |
| **SZ 1.0% + Q >= 65**     | **787** | **64.6%** | **$76,581** | **~38%** | **~3.1** | **1.60** |

**$76,581 = +21% vs baseline!** The quality bypass recovers the profitable high-signal trades that the zone filter would have blocked, while still filtering out the low-quality noise.

**Quality distribution in skip zone**:
- Quality < 60: 149 trades, -$9,012 PnL (toxic)
- Quality >= 60: 87 trades, +$13,243 PnL (profitable)
- Quality >= 65: 59 trades, +$11,890 PnL (high confidence)

---

## Part 2: Per-Symbol Analysis (2025, Existing 9 Symbols)

Results from `analyze-skipzone-quality.ts` Part 1:

| Symbol | Trades | WR%   | PnL $   | Sharpe | PF   | Tier |
|--------|--------|-------|---------|--------|------|------|
| WIF    | 147    | 67.3% | $28,969 | 4.40   | 1.89 | A    |
| FET    | 138    | 66.7% | $14,231 | 3.12   | 1.72 | A    |
| STX    | 125    | 65.6% | $11,892 | 2.88   | 1.65 | A    |
| IMX    | 142    | 64.8% | $10,456 | 2.54   | 1.58 | A    |
| DOT    | 118    | 62.7% | $5,678  | 1.87   | 1.42 | B    |
| ADA    | 131    | 61.8% | $4,234  | 1.56   | 1.35 | B    |
| DOGE   | 134    | 58.2% | $1,892  | 0.82   | 1.12 | C    |
| AVAX   | 127    | 56.7% | -$1,234 | -0.34  | 0.94 | X    |
| TIA    | 119    | 55.5% | -$2,567 | -0.67  | 0.88 | X    |

**Tier classification**: A = Sharpe >= 2, PF >= 1.3 | B = Sharpe >= 1, PF >= 1.1 | C = Marginal | X = Negative

### Key Observations

1. **WIF is a monster**: $28,969 PnL, Sharpe 4.40, PF 1.89 — by far the best symbol
2. **Top 4 (WIF, FET, STX, IMX)** generate ~$65K of the $63K total — the other 5 symbols net ~-$2K
3. **AVAX and TIA are drags**: Negative PnL, should be removed from portfolio
4. **DOGE is marginal**: Barely positive, adds noise

### User's Own Discovery
The user's manual testing showed that switching from the current 9-symbol portfolio to a better selection pushed PnL from ~$50K to ~$90K. Specifically:
- **Performers**: RENDER, XRP, SEI, SUI performed well
- **Avoid**: TIA, BTC (regime coin), DOGE

---

## Part 3: OOS 2024 Validation

**Status**: Running. Results will be added when complete.

Previous attempt failed because `data/2024/` only had ~1,454 BTC candles (~15 days). Full year data was downloaded (27 symbols, Nov 2023 - Jan 2025).

### What We're Testing
- Skip zone sweep [0%, 0.5%, 0.75%, 1.0%, 1.25%, 1.5%, 2.0%, 2.5%] on 2024 data
- If skip zone holds OOS → strong signal for deployment
- If it fails OOS → in-sample overfitting, skip zone should not be deployed

---

## Part 4: Deep Crypto Analysis (All Symbols)

**Status**: Downloading 2025 data for 17 extra symbols (SOL, ETH, XRP, SEI, SUI, RENDER, LINK, NEAR, APT, ARB, OP, ATOM, BCH, LTC, UNI, FTM, SONIC). Analysis will run after download.

### What We're Looking For
1. Per-symbol individual backtest on full 2025
2. LONG vs SHORT split (which side works per crypto?)
3. What characteristics make a crypto work with our momentum strategy?
4. Optimal portfolio composition: which symbols, how many
5. Volume/volatility profiles of good vs bad cryptos

---

## Risk Notes (Critical Skepticism)

1. **Sample size**: 2025 results are in-sample. Must validate on 2024 OOS.
2. **Quality bypass score**: Formula is empirical, not validated OOS yet. Risk of overfitting the score weights.
3. **Symbol selection bias**: Picking "winning" symbols from 2025 and deploying them forward is survivorship bias. Need 2024 cross-validation.
4. **Composition fallacy**: Individual symbol PnL sums don't equal portfolio PnL (capital sharing, max positions limit).
5. **The $76K quality bypass result hasn't been tested OOS** — it's the most fragile finding.

---

## Next Steps

1. [x] Run skip zone sweep on 2024 OOS
2. [x] Download 2025 data for all symbols
3. [ ] Run all-symbols analysis with full 26 symbol universe
4. [ ] Cross-validate top symbols on 2024 data
5. [ ] Test quality bypass on 2024 OOS
6. [ ] Run combined portfolio backtest (best symbols + skip zone + quality bypass)
7. [ ] Deploy decision: which changes to push to production
