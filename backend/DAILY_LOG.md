# Daily Log

## 2026-03-25
### What was done
- Full platform audit: live trades analysis, backtest comparison 2024 vs 2025
- Decision: abandon momentum breakout strategy (curve-fitted to 2025)
- Design: strategy-agnostic architecture with IStrategy interface
- Memory system created for persistent learnings

### Decisions made
- Momentum strategy archived (153 versions, 2024 Sharpe -3.81, live -$58)
- New approach: pluggable strategies, test on stable symbols first (BTC/ETH/SOL/XRP)
- Strategies to test: Grid Trading, Mean Reversion, Funding Rate Arbitrage

### What was built
- IStrategy interface + registry (pluggable architecture)
- Backtest engine refactored to accept any IStrategy
- 5 strategies implemented with full test suites
- ETH + SOL 15m data downloaded (2024-2026)
- Universal test runner: `npx tsx scripts/test-strategy.ts`

### Strategy test results (BTC/ETH/SOL/XRP, $2000, 2024+2025)

| Strategy | 2024 Sharpe | 2025 Sharpe | Combined PnL | Verdict |
|----------|-------------|-------------|-------------|---------|
| Grid (15m) | -6.61 | -2.17 | -$424 | Fees kill all edge. W/L ratio 0.31 |
| Mean Reversion (15m) | -1.70 | +0.02 | -$30 | Too few trades. SL dominates losses |
| Pullback Trend (15m) | -2.02 | -1.99 | -$231 | 95% exits by trend reversal |
| Mean Reversion (4h) | -2.48 | -1.61 | -$400 | 4h reduces noise but no edge |
| Funding Rate proxy | -2.28 | -3.63 | -$572 | Momentum proxy not valid |

**All 5 strategies are unprofitable across all configurations tested (50+ configs total).**

### Root cause analysis
1. 15m is too noisy for directional prediction on crypto
2. 4h reduces noise but also reduces tradeable signals
3. Fees (0.04% + slippage) eat small gains — need moves >0.2% to break even
4. Funding rate needs real data, not momentum proxy
5. Mean reversion exits are profitable, but SL exits destroy all gains
6. Grid W/L ratio structurally broken (wins 3x smaller than losses)

### Key insight
The ONLY profitable exit types across all strategies are TRAILING_STOP and MEAN_REVERSION_EXIT. Stop losses are 100% of the losses. The entry signals are partially correct — when the trade works, it works. The problem is risk management on the trades that don't work.

### Next steps
- Investigate if longer timeframes (daily) change the picture
- Consider abandoning directional crypto trading altogether
- Evaluate if the platform has value for other use cases
