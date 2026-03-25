# Momentum Breakout Strategy (ARCHIVED)

**Versions:** V5.0 — V5.153 (Jan 2025 — Mar 2026)
**Status:** Abandoned — curve-fitted to 2025 market conditions

## What it did
- Momentum breakout on 15m candles with 25+ entry filters
- BTC SMA200 regime filter, NFS trailing exits, ATR-scaled trailing
- 9 altcoin symbols (AVAX, FET, WIF, DOT, IMX, STX, ADA, RENDER, XRP)

## Results
- 2025 backtest: 510 trades, 65.5% WR, +$6,826, Sharpe 2.31 (looked great)
- 2024 backtest: 428 trades, 51.4% WR, -$1,866, Sharpe -3.81 (reality check)
- Live (Mar 2026): 14 trades, 50% WR, -$58 on $414 capital

## Why it failed
1. Over-optimized on 2025 data across 153 versions
2. sma200_skip_zone paralyzed agents when BTC oscillated near SMA200
3. Too many filters = strategy couldn't trade in indecisive regimes
4. Post-filter analysis overestimated improvements 5 times (V5.143-152)
5. Only worked on volatile alts, not stable pairs

## Key lessons
- ALWAYS test on 2024 AND 2025 (cross-regime)
- Test stable symbols first (BTC/ETH/SOL/XRP)
- Post-filter PnL simulation ≠ engine backtest
- >5 filters = fragility, not robustness
- Don't re-optimize after each losing trade
