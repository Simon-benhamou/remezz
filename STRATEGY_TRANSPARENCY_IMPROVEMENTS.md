# Strategy Transparency & CMF Signal Improvements

## Summary

Based on the backtest results showing -11.6% overall return with poor win rates (CMF Accumulation: 21%, Squeeze Breakout: 40%, Trend: 45%), three key improvements were implemented:

---

## 1. Backend Diagnostics Enhancement ✅

### Changes
- **File**: `backend/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.ts`
  - Added `scoringBreakdown` to the `evaluate()` return type
  - Returns detailed scoring for each strategy (trend/breakout/mean/momentum)
  - Includes key components (ADX, CMF, volume ratio, trend strength, etc.)
  - Exposes detection signals (BTC correlation, flash events, rebound, reversal)
  - Lists entry blockers (why agent is not trading)

- **File**: `backend/src/quantai/strategies/metaAdaptive/recognizedStrategies.ts`
  - Added `ScoringBreakdown` type export
  - Added `getLastScoringBreakdown(symbol)` function to cache and retrieve scores
  - Cache valid for 60 seconds per symbol

- **File**: `backend/src/services/agentDiagnostics.ts`
  - Added `scoringBreakdown` field to `AgentDiagnosticInfo` type
  - All three return paths now include scoring breakdown

### New Data Structure
```typescript
scoringBreakdown: {
  scores: { trend, breakout, meanReversion, momentum },
  components: { adx, rsi, cmf, volumeRatio, trendStrength, compressionScore, alignmentScore, emaAlignment },
  detections: { btcCorrelation, flashEvent, rebound, reversal },
  entryBlockers: string[],
  winner: { family, score, confidence, bias } | null
}
```

---

## 2. Frontend Transparency ✅

### Changes
- **New File**: `frontend/src/components/ScoringBreakdownPanel.tsx`
  - Visual display of all 4 strategy scores with progress bars
  - Color-coded score indicators (green >70%, yellow 50-70%, orange 30-50%, red <30%)
  - Key market components display (ADX, CMF, Volume, Trend, Squeeze, EMA)
  - Detection signals (BTC Correlation, Flash Event, Rebound, Reversal)
  - Entry blockers warning alert
  - Winner strategy summary

- **File**: `frontend/src/pages/SessionCockpitPage.tsx`
  - Added import for `ScoringBreakdownPanel`
  - Added new section to display scoring breakdown

### UI Features
- Progress bars comparing all strategy scores
- Tooltips explaining each metric
- Color-coded tags for EMA alignment (bullish/bearish/mixed)
- Warning alerts for entry blockers
- Success alerts for active signals

---

## 3. Strategy Logic Improvements ✅

### CMF Momentum Strategy Fixes
**Problem**: CMF Accumulation had only 21% win rate in backtest

**Solution** (in `metaAdaptiveAgent.ts`):
1. **Added trend confirmation requirement for CMF boost**
   - `strongCmfBoost` now only applies when `ADX >= 20` OR `trendStrength >= 0.4`
   - Prevents CMF signals in ranging markets

2. **Added ranging market penalty for momentum strategy**
   - ADX < 18: -25% score penalty
   - ADX 18-22: -10% score penalty
   - Dramatically reduces false signals in choppy markets

### Breakout Strategy Fixes
**Problem**: Squeeze Breakout had 40% win rate in backtest

**Solution**:
1. **Added volume confirmation requirement**
   - Breakouts without `volumeRatio >= 1.3` get -15% score penalty
   - Prevents false breakout signals on low volume

---

## Expected Impact

### Before (Backtest Results)
- CMF Accumulation: 21% win rate (catastrophic)
- Squeeze Breakout: 40% win rate
- Trend Following: 45% win rate
- Overall: -11.6% return

### Expected After Improvements
- CMF signals filtered by trend confirmation → fewer false signals
- Breakout signals require volume confirmation → higher quality entries
- Ranging market detection → avoid choppy market losses
- Frontend transparency → better human oversight

### Key Filtering Logic
```typescript
// CMF Momentum: Only boost when trend is confirmed
const hasTrendConfirmation = adx >= 20 || trendStrength >= 0.4;
const strongCmfBoost = hasTrendConfirmation 
  ? (Math.abs(cmf) >= 0.20 ? 0.18 : Math.abs(cmf) >= 0.15 ? 0.10 : 0)
  : 0;

// Ranging market penalty
const rangingMarketPenalty = adx < 18 ? 0.25 : adx < 22 ? 0.10 : 0;
const scoreMomentum = clamp(scoreMomentumRaw - rangingMarketPenalty, 0, 1);

// Breakout volume filter
const hasBreakoutVolumeConfirmation = volumeRatio >= 1.3;
const breakoutVolumeFilter = hasBreakoutVolumeConfirmation ? 0 : -0.15;
```

---

## Files Modified

| File | Changes |
|------|---------|
| `backend/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.ts` | Added scoringBreakdown, CMF trend filter, ranging penalty, breakout volume filter |
| `backend/src/quantai/strategies/metaAdaptive/recognizedStrategies.ts` | Added ScoringBreakdown type, cache, getLastScoringBreakdown function |
| `backend/src/services/agentDiagnostics.ts` | Added scoringBreakdown to diagnostic info |
| `frontend/src/components/ScoringBreakdownPanel.tsx` | **NEW** - Visual scoring display |
| `frontend/src/pages/SessionCockpitPage.tsx` | Added ScoringBreakdownPanel import and rendering |

---

## Next Steps (Recommendations)

1. **Run new backtest** with the filtering improvements to measure impact
2. **Monitor live performance** with the new frontend transparency
3. **Consider additional filters**:
   - Add time-of-day filtering (avoid Asian session low liquidity)
   - Add correlation clustering (avoid entering same-direction on correlated assets)
   - Implement adaptive confidence thresholds based on recent win rate
