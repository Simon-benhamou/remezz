import { PreciseDecimal } from '../strategy/metaAdaptiveAgent.js';
import { loadIntradayConfig } from './config/index.js';
import { FeaturePipeline } from './features.js';
import { StrategyRouter } from './router.js';
import { ExecutionPlanner } from './execution.js';
import { GuardrailMonitor, VolatilitySizer } from './risk.js';
import type {
  TickInput,
  RegimeSignal,
  EntrySignal,
  ExitDirective,
  RegimeLabel,
  TickFeatures,
  TradeLog,
} from './types.js';

type ActivePosition = {
  symbol: string;
  side: 'long' | 'short';
  sizeNotional: PreciseDecimal;
  remainingNotional: PreciseDecimal;
  entryPrice: PreciseDecimal;
  stopLoss: PreciseDecimal;
  takeProfit1: PreciseDecimal;
  takeProfit2: PreciseDecimal;
  runnerTrailMult: number;
  entryTime: number;
  regime: RegimeLabel;
  entryType: 'breakout' | 'mean-reversion';
  riskUsd: PreciseDecimal;
  tp1Executed: boolean;
  tp2Executed: boolean;
  rationale: string[];
  equityAtEntry: PreciseDecimal;
  entryAtrPct: number;
  pyramidAdd: boolean;
  baseStopLoss: PreciseDecimal;
  stopGraceUntil?: number;
  stopGracePrice?: PreciseDecimal;
  entryExecutionMode: EntrySignal['execution']['mode'];
};

type EvaluateContext = {
  equityUsd: PreciseDecimal;
  maxLevInstrument: number;
  maxLevGlobal: number;
  exposureBudget: number;
  slippageBps: number;
  runtimeMetrics?: { fillRate?: number; slippageBps?: number };
};

function pctToPrice(base: PreciseDecimal, pct: number, side: 'long' | 'short', direction: 'tp' | 'sl'): PreciseDecimal {
  const pctDecimal = new PreciseDecimal(pct.toString());
  const multiplier = direction === 'tp'
    ? (side === 'long' ? 1 : -1)
    : (side === 'long' ? -1 : 1);
  return base.plus(base.times(pctDecimal).times(new PreciseDecimal(multiplier.toString())));
}

function computeStopPct(regime: RegimeLabel, atrPct: number, cfg: ReturnType<typeof loadIntradayConfig>): number {
  if (regime === 'BOM') {
    return Math.max(cfg.stops.bom.atrMultiplier * atrPct, cfg.stops.bom.minPct);
  }
  return Math.max(cfg.stops.mr.atrMultiplier * atrPct, cfg.stops.mr.minPct);
}

export class IntradayDualStrategy {
  private readonly cfg = loadIntradayConfig();
  private readonly pipeline = new FeaturePipeline();
  private readonly router = new StrategyRouter();
  private readonly execution = new ExecutionPlanner();
  private readonly sizer = new VolatilitySizer();
  private readonly guardrails = new GuardrailMonitor();
  private readonly positions = new Map<string, ActivePosition[]>();
  private readonly tradeLogs: TradeLog[] = [];
  private readonly lastMrEntry = new Map<string, number>();

  evaluateTick(input: TickInput, ctx: EvaluateContext): {
    regime: RegimeSignal;
    entries: EntrySignal[];
    exits: ExitDirective[];
    trades: TradeLog[];
  } {
    this.execution.ingest(ctx.runtimeMetrics);
    if (input.aggression) {
      this.pipeline.updateAggression({
        timestamp: input.aggression.timestamp,
        takerBuy: input.aggression.takerBuy,
        takerSell: input.aggression.takerSell,
      });
    }

    const features = this.computeFeatures(input);
    const regime = this.router.classify(features);
    const entries: EntrySignal[] = [];
    const exits: ExitDirective[] = [];

    exits.push(...this.evaluateExits(input, features));

    if (regime.label !== 'NONE') {
      const guard = this.guardrails.canEnter(input.symbol, input.timestamp, regime.label);
      if (!guard.allowed) {
        // Guardrail triggered; no new entries
      } else {
        const entry = this.evaluateEntry(input, features, regime, ctx, guard.riskReduction ?? 1);
        if (entry) {
          entries.push(entry);
          this.registerPosition(input.symbol, entry, ctx.equityUsd, input.timestamp);
        }
      }
    }

    return { regime, entries, exits, trades: [...this.tradeLogs] };
  }

  private computeFeatures(input: TickInput): Record<'1m' | '5m' | '15m', TickFeatures> {
    const result: Partial<Record<'1m' | '5m' | '15m', TickFeatures>> = {};
    (['1m', '5m', '15m'] as const).forEach((tf) => {
      const candles = input.candles[tf];
      if (candles?.length) {
        result[tf] = this.pipeline.compute(tf, candles, input.orderBook, input.price);
      } else {
        throw new Error(`Missing candles for timeframe ${tf}`);
      }
    });
    return result as Record<'1m' | '5m' | '15m', TickFeatures>;
  }

  private evaluateEntry(
    input: TickInput,
    features: Record<'1m' | '5m' | '15m', TickFeatures>,
    regime: RegimeSignal,
    ctx: EvaluateContext,
    riskReduction: number,
  ): EntrySignal | null {
    const active = this.positions.get(input.symbol) ?? [];
    if (active.length >= this.cfg.risk.maxConcurrentPositions) {
      return null;
    }
    if (regime.label === 'BOM') {
      return this.evaluateBreakoutEntry(input, features, ctx, riskReduction, regime);
    }
    if (regime.label === 'MR' && !input.newsSpike) {
      const lastEntry = this.lastMrEntry.get(input.symbol) ?? 0;
      if (input.timestamp - lastEntry < this.cfg.entry.mr.cooldownMs) {
        return null;
      }
      return this.evaluateMeanReversionEntry(input, features, ctx, riskReduction, regime);
    }
    return null;
  }

  private evaluateBreakoutEntry(
    input: TickInput,
    features: Record<'1m' | '5m' | '15m', TickFeatures>,
    ctx: EvaluateContext,
    riskReduction: number,
    regime: RegimeSignal,
  ): EntrySignal | null {
    const f1 = features['1m'];
    const candles1m = input.candles['1m'];
    const signalCandle = candles1m[candles1m.length - 1];
    if (!signalCandle) return null;

    const side: 'long' | 'short' | null = f1.volatility.bollingerPercentB > 1
      ? 'long'
      : f1.volatility.bollingerPercentB < 0 ? 'short' : null;
    if (!side) return null;

    const emaFast = f1.momentum.emaValue['9'] ?? signalCandle.close;
    const emaSlow = f1.momentum.emaValue['20'] ?? signalCandle.close;
    const trendAligned = side === 'long' ? emaFast >= emaSlow : emaFast <= emaSlow;
    if (!trendAligned) {
      return null;
    }

    const confirmationBars = Math.max(0, this.cfg.entry.bom.confirmationBars);
    if (confirmationBars > 0) {
      const recent = candles1m.slice(-confirmationBars);
      const boundary = side === 'long' ? f1.volatility.bollingerUpper : f1.volatility.bollingerLower;
      const confirmed = recent.every((bar) => (side === 'long' ? bar.close >= boundary : bar.close <= boundary));
      if (!confirmed) {
        return null;
      }
    }

    const atrOk = f1.volatility.atrPct >= this.cfg.entry.bom.atrMinPct;
    const rsi = f1.momentum.rsi['7'] ?? 50;
    const rsiOk = side === 'long'
      ? rsi >= this.cfg.entry.bom.rsiMin
      : rsi <= (100 - this.cfg.entry.bom.rsiMin);
    const aggressionOk = f1.orderBook.aggressionRatio >= this.cfg.entry.bom.aggressionMin;
    const volumeOk = f1.volume.zScore >= this.cfg.entry.bom.volumeZMin;
    const obiAligned = side === 'long' ? f1.orderBook.imbalance > 0 : f1.orderBook.imbalance < 0;
    if (!(atrOk && rsiOk && aggressionOk && volumeOk && obiAligned)) {
      return null;
    }

    const active = this.positions.get(input.symbol) ?? [];
    const activeBom = active.filter((p) => p.regime === 'BOM');
    const pyramidMaxAdds = Math.max(0, this.cfg.entry.bom.pyramidMaxAdds ?? 0);
    const isPyramidAdd = activeBom.length > 0;
    if (isPyramidAdd) {
      if (activeBom.length >= pyramidMaxAdds + 1) {
        return null;
      }
      const existingSide = activeBom[0]?.side;
      if (existingSide && existingSide !== side) {
        return null;
      }
      const emaTrendAligned = side === 'long' ? emaFast > emaSlow : emaFast < emaSlow;
      if (!emaTrendAligned) {
        return null;
      }
      const ema9 = f1.momentum.emaValue['9'] ?? input.price;
      const pullbackThreshold = (this.cfg.entry.bom.pyramidPullbackBps ?? 0) / 10_000;
      if (pullbackThreshold > 0) {
        const pullbackPct = Math.abs(input.price - ema9) / Math.max(Math.abs(ema9), 1e-8);
        if (pullbackPct > pullbackThreshold) {
          return null;
        }
      }
    }

    const stopPct = computeStopPct('BOM', f1.volatility.atrPct, this.cfg);
    const pyramidScale = isPyramidAdd ? this.cfg.entry.bom.pyramidScale ?? 0.3 : 1;
    const sized = this.sizer.compute({
      equityUsd: ctx.equityUsd,
      stopLossPct: stopPct,
      regime: 'BOM',
      price: new PreciseDecimal(signalCandle.close),
      maxLevInstrument: ctx.maxLevInstrument,
      maxLevGlobal: ctx.maxLevGlobal,
      exposureBudget: ctx.exposureBudget,
      slippageBps: ctx.slippageBps,
      riskReduction: riskReduction * pyramidScale,
    });
    if (sized.size.raw === 0n) return null;

    const bufferPct = (this.cfg.entry.bom.stopBufferBps ?? 0) / 10_000;
    const bufferDecimal = new PreciseDecimal(bufferPct.toString());
    const signedBuffer = side === 'long' ? bufferDecimal : new PreciseDecimal((-bufferPct).toString());
    const signalExtreme = side === 'long' ? signalCandle.high : signalCandle.low;
    const signalExtremeDecimal = new PreciseDecimal(signalExtreme);
    const triggerPrice = signalExtremeDecimal.plus(signalExtremeDecimal.times(signedBuffer));
    const stopPrice = pctToPrice(triggerPrice, stopPct, side, 'sl');
    const tp1 = pctToPrice(triggerPrice, this.cfg.stops.tp.firstPct, side, 'tp');
    const tp2 = pctToPrice(triggerPrice, this.cfg.stops.tp.secondPct, side, 'tp');

    let stopGrace: EntrySignal['stopGrace'];
    if (!isPyramidAdd) {
      const graceMinutes = this.cfg.entry.bom.stopGraceMinutes ?? 0;
      const graceBps = this.cfg.entry.bom.stopGraceBps ?? 0;
      if (graceMinutes > 0 && graceBps > 0) {
        const gracePct = stopPct + graceBps / 10_000;
        const gracePrice = pctToPrice(triggerPrice, gracePct, side, 'sl');
        stopGrace = {
          price: gracePrice,
          expiresAt: input.timestamp + graceMinutes * 60_000,
        };
      }
    }

    const execution = this.execution.plan({
      regime: 'BOM',
      orderBook: input.orderBook,
      atrPct: f1.volatility.atrPct,
      sizeUsd: sized.size.toNumber(),
      slippageBps: ctx.slippageBps,
    });

    return {
      regime: 'BOM',
      side,
      entryType: 'breakout',
      triggerPrice,
      stopLossPrice: stopPrice,
      takeProfit1: tp1,
      takeProfit2: tp2,
      runnerTrailAtrMult: this.cfg.stops.tp.runner.atrMultiplier,
      size: sized.size,
      riskUsd: sized.riskUsd,
      leverage: sized.leverage,
      confidence: regime.confidence,
      rationale: [
        'BOM breakout confirmed',
        `volumeZ=${f1.volume.zScore.toFixed(2)}`,
        `aggr=${f1.orderBook.aggressionRatio.toFixed(2)}`,
        isPyramidAdd ? 'pyramid-add' : 'base-entry',
      ],
      execution,
      entryAtrPct: f1.volatility.atrPct,
      pyramidAdd: isPyramidAdd,
      stopGrace,
    };
  }

  private evaluateMeanReversionEntry(
    input: TickInput,
    features: Record<'1m' | '5m' | '15m', TickFeatures>,
    ctx: EvaluateContext,
    riskReduction: number,
    regime: RegimeSignal,
  ): EntrySignal | null {
    const f1 = features['1m'];
    const atrOk = f1.volatility.atrPct <= this.cfg.entry.mr.atrMaxPct;
    if (!atrOk) return null;

    const priceZ = f1.volatility.bandZScore;
    const threshold = this.cfg.entry.mr.priceZScore;
    const side: 'long' | 'short' | null = priceZ <= -threshold
      ? 'long'
      : priceZ >= threshold
        ? 'short'
        : null;
    if (!side) return null;

    const wick = this.computeWickPct(input.candles['1m']);
    const imbalance = f1.orderBook.imbalance;
    const imbalanceExtreme = Math.abs(imbalance) >= this.cfg.entry.mr.obiExtreme;
    const imbalanceReversing = side === 'long'
      ? f1.orderBook.imbalanceDelta >= this.cfg.entry.mr.obiDeltaMin
      : f1.orderBook.imbalanceDelta <= -this.cfg.entry.mr.obiDeltaMin;
    if (!imbalanceExtreme || !imbalanceReversing) return null;

    const momentumDiv = (f1.momentum.roc['1'] ?? 0) * (features['5m'].momentum.roc['3'] ?? 0) < 0;
    if (!momentumDiv) return null;

    const wickOk = side === 'long' ? wick.lower >= this.cfg.entry.mr.wickMinPct : wick.upper >= this.cfg.entry.mr.wickMinPct;
    if (!wickOk) return null;

    const stopPct = computeStopPct('MR', f1.volatility.atrPct, this.cfg);
    const sized = this.sizer.compute({
      equityUsd: ctx.equityUsd,
      stopLossPct: stopPct,
      regime: 'MR',
      price: new PreciseDecimal(input.price),
      maxLevInstrument: ctx.maxLevInstrument,
      maxLevGlobal: ctx.maxLevGlobal,
      exposureBudget: ctx.exposureBudget,
      slippageBps: ctx.slippageBps,
      riskReduction,
    });
    if (sized.size.raw === 0n) return null;

    const entryPrice = new PreciseDecimal(input.price);
    const stopPrice = pctToPrice(entryPrice, stopPct, side, 'sl');
    const tp1 = pctToPrice(entryPrice, this.cfg.stops.tp.firstPct * 0.8, side, 'tp');
    const tp2 = pctToPrice(entryPrice, this.cfg.stops.tp.secondPct * 0.7, side, 'tp');

    const execution = this.execution.plan({
      regime: 'MR',
      orderBook: input.orderBook,
      atrPct: f1.volatility.atrPct,
      sizeUsd: sized.size.toNumber(),
      slippageBps: ctx.slippageBps,
    });

    return {
      regime: 'MR',
      side,
      entryType: 'mean-reversion',
      triggerPrice: entryPrice,
      stopLossPrice: stopPrice,
      takeProfit1: tp1,
      takeProfit2: tp2,
      runnerTrailAtrMult: this.cfg.stops.tp.runner.atrMultiplier,
      size: sized.size,
      riskUsd: sized.riskUsd,
      leverage: sized.leverage,
      confidence: Math.max(regime.confidence, 0.6),
      rationale: [
        'MR extreme detected',
        `z=${priceZ.toFixed(2)}`,
        `imb=${imbalance.toFixed(2)}`,
        `wick=${(side === 'long' ? wick.lower : wick.upper).toFixed(4)}`,
      ],
      execution,
      entryAtrPct: f1.volatility.atrPct,
      pyramidAdd: false,
    };
  }

  private evaluateExits(input: TickInput, features: Record<'1m' | '5m' | '15m', TickFeatures>): ExitDirective[] {
    const exits: ExitDirective[] = [];
    const list = this.positions.get(input.symbol) ?? [];
    const f1 = features['1m'];
    const atrPct = f1.volatility.atrPct;
    const timeStopMs = this.cfg.stops.timeStopMinutes * 60_000;
    const price = new PreciseDecimal(input.price);

    for (const position of [...list]) {
      if (position.stopGraceUntil && input.timestamp >= position.stopGraceUntil) {
        const gracePrice = position.stopGracePrice;
        const graceActive = gracePrice ? position.stopLoss.equals(gracePrice) : false;
        position.stopGraceUntil = undefined;
        position.stopGracePrice = undefined;
        if (graceActive) {
          const base = position.baseStopLoss;
          if (position.side === 'long') {
            if (base.gt(position.stopLoss)) {
              position.stopLoss = base;
            }
          } else if (base.lt(position.stopLoss)) {
            position.stopLoss = base;
          }
        }
      }

      const elapsed = input.timestamp - position.entryTime;
      const hitStop = position.side === 'long'
        ? price.lt(position.stopLoss)
        : price.gt(position.stopLoss);
      if (hitStop) {
        const exit = this.realizeExit(input.symbol, position, 1, price, 'stop', input.timestamp, atrPct);
        if (exit) exits.push(exit.directive);
        continue;
      }

      if (!position.tp1Executed) {
        const hitTp1 = position.side === 'long' ? price.gt(position.takeProfit1) : price.lt(position.takeProfit1);
        if (hitTp1) {
          const exit = this.realizeExit(input.symbol, position, this.cfg.stops.tp.firstSize, position.takeProfit1, 'tp1', input.timestamp, atrPct);
          if (exit) exits.push(exit.directive);
          position.tp1Executed = true;
          position.stopLoss = position.entryPrice; // move to breakeven
        }
      }

      if (!position.tp2Executed) {
        const hitTp2 = position.side === 'long' ? price.gt(position.takeProfit2) : price.lt(position.takeProfit2);
        if (hitTp2) {
          const exit = this.realizeExit(input.symbol, position, this.cfg.stops.tp.secondSize, position.takeProfit2, 'tp2', input.timestamp, atrPct);
          if (exit) exits.push(exit.directive);
          position.tp2Executed = true;
        }
      }

      if (position.tp1Executed && position.tp2Executed) {
        let trailMult = position.runnerTrailMult;
        if (position.regime === 'BOM' && position.entryAtrPct > 0 && atrPct > 0) {
          const ratio = atrPct / position.entryAtrPct;
          if (ratio > 1.2) {
            trailMult = Math.max(trailMult * 0.8, this.cfg.stops.tp.runner.atrMultiplier * 0.7);
          } else if (ratio < 0.8) {
            trailMult = trailMult * 1.1;
          }
        }
        const minStop = position.regime === 'BOM' ? this.cfg.stops.bom.minPct : this.cfg.stops.mr.minPct;
        const trailPct = Math.max(trailMult * atrPct, minStop);
        const atrTrail = pctToPrice(price, trailPct, position.side, 'sl');
        let candidate = atrTrail;
        const donchianLookback = Math.max(0, this.cfg.stops.tp.runner.lookback ?? 0);
        if (donchianLookback > 1) {
          const source = input.candles['1m'];
          if (source.length >= donchianLookback) {
            const slice = source.slice(-donchianLookback);
            if (position.side === 'long') {
              const floor = Math.min(...slice.map((c) => c.low));
              candidate = candidate.gt(floor) ? candidate : new PreciseDecimal(floor);
            } else {
              const ceiling = Math.max(...slice.map((c) => c.high));
              candidate = candidate.lt(ceiling) ? candidate : new PreciseDecimal(ceiling);
            }
          }
        }
        if (position.side === 'long') {
          if (candidate.gt(position.stopLoss)) {
            position.stopLoss = candidate;
          }
        } else if (candidate.lt(position.stopLoss)) {
          position.stopLoss = candidate;
        }
        position.runnerTrailMult = trailMult;
      }

      if (elapsed >= timeStopMs) {
        const exit = this.realizeExit(input.symbol, position, 1, price, 'time', input.timestamp, atrPct);
        if (exit) exits.push(exit.directive);
      }
    }

    this.positions.set(input.symbol, list.filter((pos) => pos.remainingNotional.raw > 0));
    return exits;
  }

  private realizeExit(
    symbol: string,
    position: ActivePosition,
    fraction: number,
    price: PreciseDecimal,
    reason: ExitDirective['reason'],
    timestamp: number,
    atrPct: number,
  ): { log: TradeLog; directive: ExitDirective } | null {
    const fractionDecimal = new PreciseDecimal(Math.min(1, Math.max(0, fraction)).toString());
    if (fractionDecimal.raw === 0n || position.remainingNotional.raw === 0n) {
      return null;
    }
    const notionalClosed = position.remainingNotional.times(fractionDecimal);
    if (notionalClosed.raw === 0n) {
      return null;
    }
    const direction = position.side === 'long' ? 1 : -1;
    const pctChange = price.minus(position.entryPrice).dividedBy(position.entryPrice).times(new PreciseDecimal(direction.toString()));
    const pnl = notionalClosed.times(pctChange);
    const riskPortion = position.riskUsd.times(fractionDecimal);
    this.guardrails.recordTrade(symbol, pnl, riskPortion, position.equityAtEntry, timestamp);
    const log: TradeLog = {
      timestamp,
      side: position.side,
      quantity: notionalClosed,
      price,
      cumulativePnl: pnl,
      reason,
      executionMode: position.entryExecutionMode,
      holdDurationMs: timestamp - position.entryTime,
      entryAtrPct: position.entryAtrPct,
      exitAtrPct: atrPct,
    };
    this.tradeLogs.push(log);
    position.remainingNotional = position.remainingNotional.minus(notionalClosed);
    return { log, directive: { reason, exitPrice: price, timestamp } };
  }

  private registerPosition(symbol: string, entry: EntrySignal, equity: PreciseDecimal, timestamp: number): void {
    const list = this.positions.get(symbol) ?? [];
    const initialStop = entry.stopGrace?.price ?? entry.stopLossPrice;
    const position: ActivePosition = {
      symbol,
      side: entry.side,
      sizeNotional: entry.size,
      remainingNotional: entry.size,
      entryPrice: entry.triggerPrice,
      stopLoss: initialStop,
      takeProfit1: entry.takeProfit1,
      takeProfit2: entry.takeProfit2,
      runnerTrailMult: entry.runnerTrailAtrMult,
      entryTime: timestamp,
      regime: entry.regime,
      entryType: entry.entryType,
      riskUsd: entry.riskUsd,
      tp1Executed: false,
      tp2Executed: false,
      rationale: entry.rationale,
      equityAtEntry: equity,
      entryAtrPct: entry.entryAtrPct,
      pyramidAdd: entry.pyramidAdd ?? false,
      baseStopLoss: entry.stopLossPrice,
      stopGraceUntil: entry.stopGrace?.expiresAt,
      stopGracePrice: entry.stopGrace?.price,
      entryExecutionMode: entry.execution.mode,
    };
    list.push(position);
    this.positions.set(symbol, list);
    if (position.regime === 'MR') {
      this.lastMrEntry.set(symbol, timestamp);
    }
  }

  private computeWickPct(candles: TickInput['candles']['1m']): { lower: number; upper: number } {
    const last = candles[candles.length - 1];
    if (!last) return { lower: 0, upper: 0 };
    const bodyLow = Math.min(last.open, last.close);
    const bodyHigh = Math.max(last.open, last.close);
    const lowerWick = bodyLow - last.low;
    const upperWick = last.high - bodyHigh;
    const denom = Math.abs(last.close) || 1;
    return {
      lower: Math.max(0, lowerWick) / denom,
      upper: Math.max(0, upperWick) / denom,
    };
  }

  getTradeLogs(): TradeLog[] {
    return [...this.tradeLogs];
  }
}
