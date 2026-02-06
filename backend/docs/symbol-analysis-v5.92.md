# Symbol Analysis — V5.92 (Jan-Dec 2025)

**Date:** 2026-02-06
**Config:** V5.92 optimized (STAG=60, TRAIL_ACT=1.0, TRAIL_DIST=0.4)
**Capital:** $2,000 | **Leverage:** 4.5x | **Period:** Jan 1 - Dec 31, 2025

Each symbol tested individually (single-symbol backtest).

---

## Results Table (sorted by PnL)

| Rank | Symbol | Trades | WR | PnL | ROI | MaxDD | Sharpe | Avg Trade | Verdict |
|------|--------|--------|----|-----|-----|-------|--------|-----------|---------|
| 1 | **IMX** | 104 | 70.2% | $5,289 | +264% | 26.9% | 2.74 | $50.9 | STRONG |
| 2 | **AVAX** | 76 | 69.7% | $3,108 | +155% | 10.3% | 2.61 | $40.9 | STRONG |
| 3 | **SEI** | 95 | 61.1% | $1,963 | +98% | 30.7% | 1.61 | $20.7 | STRONG |
| 4 | **ADA** | 90 | 61.1% | $1,832 | +92% | 14.4% | 1.58 | $20.4 | STRONG |
| 5 | **DOT** | 77 | 55.8% | $996 | +50% | 17.5% | 1.23 | $12.9 | STRONG |
| 6 | SUI | 88 | 54.5% | $665 | +33% | 17.6% | 0.79 | $7.6 | OK |
| 7 | **DOGE** | 105 | 58.1% | $657 | +33% | 19.9% | 0.88 | $6.3 | STRONG |
| 8 | **OP** | 101 | 57.4% | $602 | +30% | 40.4% | 0.76 | $6.0 | STRONG |
| 9 | **BTC** | 35 | 71.4% | $569 | +29% | 10.6% | 1.58 | $16.3 | STRONG |
| 10 | **APT** | 91 | 59.3% | $547 | +27% | 31.3% | 0.80 | $6.0 | STRONG |
| 11 | SOL | 88 | 59.1% | $497 | +25% | 32.7% | 0.77 | $5.6 | OK |
| 12 | NEAR | 111 | 56.8% | $384 | +19% | 29.6% | 0.63 | $3.5 | OK |
| 13 | ATOM | 63 | 54.0% | $323 | +16% | 22.5% | 0.62 | $5.1 | OK |
| 14 | XRP | 70 | 58.6% | $235 | +12% | 20.4% | 0.55 | $3.4 | OK |
| 15 | LINK | 77 | 50.6% | $141 | +7% | 29.8% | 0.36 | $1.8 | OK |
| 16 | ETH | 77 | 49.4% | $52 | +3% | 16.6% | 0.23 | $0.7 | MARGINAL |
| 17 | FTM | 1 | 100% | $52 | +3% | 0.0% | 1.00 | $51.6 | N/A (1 trade) |
| 18 | ARB | 93 | 49.5% | -$59 | -3% | 37.1% | 0.17 | -$0.6 | MARGINAL |

---

## Classification

### STRONG — Recommended for live trading
High PnL, good WR (>55%), acceptable DD, Sharpe > 0.7

| Symbol | Why it works |
|--------|-------------|
| **IMX** | Best overall. 70% WR, highest PnL, excellent Sharpe 2.74. Mid-cap volatility = big momentum moves. |
| **AVAX** | Hidden gem. 70% WR, lowest DD (10.3%), Sharpe 2.61. Very clean momentum signals. |
| **SEI** | Strong runner. 61% WR, $20/trade avg. Good momentum characteristics. |
| **ADA** | Consistent. 61% WR, very low DD (14.4%), Sharpe 1.58. Safe and profitable. |
| **DOT** | Solid performer. 56% WR but $13/trade avg, low DD (17.5%). |
| **DOGE** | High trade count (105), 58% WR. Most liquid alt, reliable signals. |
| **OP** | Good WR (57.4%), 101 trades. Warning: high DD (40.4%). |
| **BTC** | Highest WR (71.4%), lowest DD (10.6%). Few trades (35) but very accurate. |
| **APT** | Good WR (59.3%), 91 trades. Moderate DD (31.3%). |

### OK — Can use but lower priority
Profitable but lower edge. Include if you need more diversification.

| Symbol | Notes |
|--------|-------|
| SUI | Low WR (54.5%) but profitable. Good DD (17.6%). |
| SOL | 59% WR but high DD (32.7%). Edge is there but volatile. |
| NEAR | Many trades (111) but tiny avg trade ($3.5). Lots of noise. |
| ATOM | Few trades (63), 54% WR. Small edge. |
| XRP | 58.6% WR, OK. But only $3.4/trade average. |
| LINK | Barely profitable. 50.6% WR = coin flip territory. |

### MARGINAL/AVOID — Do NOT use for live trading

| Symbol | Why |
|--------|-----|
| **ETH** | 49.4% WR = worse than coin flip. Only $0.7/trade avg. Major that doesn't suit momentum. |
| **ARB** | 49.5% WR, negative PnL (-$59). High DD (37.1%). No edge. |
| **FTM** | Only 1 trade in 12 months. Insufficient data / dead market. |

---

## Recommended Symbol Sets

### Aggressive (9 symbols) — Maximum opportunity
IMX, AVAX, SEI, ADA, DOT, DOGE, OP, BTC, APT
- Expected: highest total PnL but more DD

### Balanced (7 symbols) — Best risk/reward
IMX, AVAX, SEI, ADA, DOT, DOGE, BTC
- Removes OP (high DD) and APT (moderate DD)

### Conservative (5 symbols) — Current default
DOGE, IMX, SEI, SUI, XRP
- Current V5.92 default (optimized from Phase C)

### Ultra-safe (4 symbols) — Lowest drawdown
IMX, AVAX, ADA, BTC
- All have DD < 27%, Sharpe > 1.5

---

## Action Items for Tomorrow

1. **Remove from frontend:** ETH, ARB, FTM (marginal/avoid symbols)
2. **Add to frontend:** AVAX, ADA, DOT, OP, APT (strong performers not currently in default)
3. **Update defaultSymbols** to the balanced set: IMX, AVAX, SEI, ADA, DOT, DOGE, BTC
4. **Consider:** Running a combined backtest with the "Aggressive 9" to see total portfolio performance
