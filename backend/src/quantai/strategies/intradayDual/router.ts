import { loadIntradayConfig } from './config/index.js';
import type { TickFeatures, RegimeSignal, RegimeLabel } from './types.js';

type RouterState = {
  lastSqueeze: number;
  lastSqueezeState: 'range' | 'expansion' | 'neutral';
  lastBreakoutDir: 'long' | 'short' | 'none';
  lastTimestamp: number;
};

function countSatisfied(flags: boolean[]): number {
  return flags.reduce((acc, flag) => acc + (flag ? 1 : 0), 0);
}

export class StrategyRouter {
  private readonly cfg = loadIntradayConfig();
  private state: RouterState = {
    lastSqueeze: 1,
    lastSqueezeState: 'neutral',
    lastBreakoutDir: 'none',
    lastTimestamp: 0,
  };

  classify(features: Record<'1m' | '5m' | '15m', TickFeatures>): RegimeSignal {
    const f1 = features['1m'];
    const f5 = features['5m'];
    const f15 = features['15m'];

    const squeezeNow = f1.volatility.squeezeRatio;
    const squeezePrev = this.state.lastSqueeze;
    const prevState = this.state.lastSqueezeState;
    const squeezeState = f1.volatility.squeezeState;
    this.state.lastSqueeze = squeezeNow;
    this.state.lastSqueezeState = squeezeState;
    this.state.lastTimestamp = f1.timestamp;

    const squeezeExpansion = (prevState === 'range' || squeezePrev < this.cfg.volatility.squeezeLow) && squeezeState === 'expansion';
    const squeezeActive = squeezeState === 'range';

    const ema9 = f1.momentum.emaValue['9'] ?? 0;
    const ema20 = f1.momentum.emaValue['20'] ?? 0;
    const emaTrendOk = ema9 > ema20 && (f5.momentum.emaValue['9'] ?? 0) > (f5.momentum.emaValue['20'] ?? 0);
    const emaTrendShortOk = ema9 < ema20 && (f5.momentum.emaValue['9'] ?? 0) < (f5.momentum.emaValue['20'] ?? 0);

    const breakoutUp = f1.volatility.bollingerPercentB > 1 && emaTrendOk;
    const breakoutDown = f1.volatility.bollingerPercentB < 0 && emaTrendShortOk;
    const breakoutConfirmed = breakoutUp || breakoutDown;
    const breakoutDir: 'long' | 'short' | 'none' = breakoutUp ? 'long' : breakoutDown ? 'short' : 'none';

    if (breakoutConfirmed) this.state.lastBreakoutDir = breakoutDir;

    const volumeStrong = f1.volume.zScore >= this.cfg.entry.bom.volumeZMin;
    const aggressionSupportive = f1.orderBook.aggressionRatio >= this.cfg.entry.bom.aggressionMin;
    const obiAligned = breakoutDir === 'long'
      ? f1.orderBook.imbalance > 0
      : breakoutDir === 'short'
        ? f1.orderBook.imbalance < 0
        : false;

    const bomConditions = [squeezeExpansion, breakoutConfirmed, volumeStrong, aggressionSupportive, obiAligned];
    const bomScore = bomConditions.length ? countSatisfied(bomConditions) / bomConditions.length : 0;

    const priceStretch = Math.abs(f1.volatility.bandZScore) >= this.cfg.entry.mr.priceZScore;
    const obiExtreme = Math.abs(f1.orderBook.imbalance) >= this.cfg.entry.mr.obiExtreme;
    const obiReversion = f1.orderBook.imbalance < 0
      ? f1.orderBook.imbalanceDelta >= this.cfg.entry.mr.obiDeltaMin
      : f1.orderBook.imbalance > 0
        ? f1.orderBook.imbalanceDelta <= -this.cfg.entry.mr.obiDeltaMin
        : false;
    const mrMomentumDiv = (f1.momentum.roc['1'] ?? 0) * (f5.momentum.roc['3'] ?? 0) < 0;
    const mrConditions = [squeezeActive, priceStretch, obiExtreme, obiReversion, mrMomentumDiv];
    const mrScore = mrConditions.length ? countSatisfied(mrConditions) / mrConditions.length : 0;

    let label: RegimeLabel = 'NONE';
    let confidence = 0;
    let reason = 'Neutral regime';

    if (bomScore >= mrScore && bomScore > 0.6) {
      label = 'BOM';
      confidence = bomScore;
      reason = 'Breakout-momentum: squeeze expansion with supportive volume';
    } else if (mrScore > bomScore && mrScore > 0.6) {
      label = 'MR';
      confidence = mrScore;
      reason = 'Mean-reversion: squeeze range with order-book reversal';
    }

    return { label, confidence, reason };
  }
}
