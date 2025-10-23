import { PreciseDecimal } from '../metaAdaptive/metaAdaptiveAgent.js';
import { loadIntradayConfig } from './config/index.js';
import { FeaturePipeline } from './features.js';
import { StrategyRouter } from './router.js';
import { ExecutionPlanner } from './execution.js';
import { GuardrailMonitor, VolatilitySizer, DirectionalPressure, computeSidePenalty } from './risk.js';
import { History } from './history.js';
import { computeQualityScore, chooseEV } from '../../qs/qualityScore.js';
import { getIntradayRuntimeConfig } from '../../../config/intraday.js';
import type {
  TickInput,
  RegimeSignal,
  EntrySignal,
  ExitDirective,
  RegimeLabel,
  TickFeatures,
  TradeLog,
} from './types.js';
import { createLogger } from '../../../utils/logger.js';

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

type StopContext = { regime: 'BOM' | 'MR'; side: 'long' | 'short' };
type AdaptiveParams = {
  recheckActive: boolean;
  staleBias: boolean;
  lastStop: StopContext | null;
  qValues: { qL: number; qS: number };
  guardRiskReduction: number;
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
  private readonly logger = createLogger('strategy:intraday-dual');
  private readonly cfg = loadIntradayConfig();
  private readonly pipeline = new FeaturePipeline();
  private readonly router = new StrategyRouter();
  private readonly execution = new ExecutionPlanner();
  private readonly sizer = new VolatilitySizer();
  private readonly guardrails = new GuardrailMonitor();
  private readonly history = new History({ lambda: 0.97, costsBps: 5 });
  private readonly dirPressure = new DirectionalPressure();
  private runtimeCfg = getIntradayRuntimeConfig();
  private readonly positions = new Map<string, ActivePosition[]>();
  private readonly tradeLogs: TradeLog[] = [];
  private readonly lastMrEntry = new Map<string, number>();
  private readonly postStopRecheck = new Map<string, number>();
  private readonly lastStopContext = new Map<string, StopContext>();

  evaluateTick(input: TickInput, ctx: EvaluateContext): {
    regime: RegimeSignal;
    entries: EntrySignal[];
    exits: ExitDirective[];
    trades: TradeLog[];
  } {
    this.runtimeCfg = getIntradayRuntimeConfig();
    this.execution.ingest(ctx.runtimeMetrics);
    if (input.aggression) {
      this.pipeline.updateAggression({
        timestamp: input.aggression.timestamp,
        takerBuy: input.aggression.takerBuy,
        takerSell: input.aggression.takerSell,
      });
    }

    const features = this.computeFeatures(input);
    const regime = this.router.classify(input.symbol, features);
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
        result[tf] = this.pipeline.compute(tf, candles, input.orderBook, input.price, input.symbol);
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
    const now = input.timestamp;
    const recheckUntil = this.postStopRecheck.get(input.symbol) ?? 0;
    const recheckActive = recheckUntil > now;
    const lastStop = this.lastStopContext.get(input.symbol) ?? null;
    const staleBias = (regime.biasAgeMs ?? 0) > 15 * 60_000 || regime.confidence < 0.7;
    const qValues = this.history.qValues();
    this.logger.debug('intraday.bias-state', {
      symbol: input.symbol,
      regime: regime.label,
      confidence: regime.confidence,
      biasAgeMs: regime.biasAgeMs ?? 0,
      recheckActive,
      staleBias,
      lastStop,
    });
    const adaptive: AdaptiveParams = { recheckActive, staleBias, lastStop, qValues, guardRiskReduction: riskReduction };
    if (regime.label === 'BOM') {
      return this.evaluateBreakoutEntry(input, features, ctx, adaptive, regime);
    }
    if (regime.label === 'MR' && !input.newsSpike) {
      const lastEntry = this.lastMrEntry.get(input.symbol) ?? 0;
      if (input.timestamp - lastEntry < this.cfg.entry.mr.cooldownMs) {
        return null;
      }
      return this.evaluateMeanReversionEntry(input, features, ctx, adaptive, regime);
    }
    return null;
  }

  private evaluateBreakoutEntry(
    input: TickInput,
    features: Record<'1m' | '5m' | '15m', TickFeatures>,
    ctx: EvaluateContext,
    adaptiveOrRisk: AdaptiveParams | number,
    regime: RegimeSignal,
  ): EntrySignal | null {
    const adaptive: AdaptiveParams = typeof adaptiveOrRisk === 'number'
      ? {
        recheckActive: false,
        staleBias: false,
        lastStop: null,
        qValues: this.history.qValues(),
        guardRiskReduction: adaptiveOrRisk,
      }
      : adaptiveOrRisk;
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

    const pressure = this.dirPressure.recentPressure(input.symbol, 'BOM', side, input.timestamp);
    const sidePenalty = computeSidePenalty(pressure);
    const guardReduction = adaptive.guardRiskReduction ?? 1;
    const effectiveRiskReduction = Math.max(0, guardReduction) * sidePenalty;
    let volumeThreshold = this.cfg.entry.bom.volumeZMin;
    let aggressionThreshold = this.cfg.entry.bom.aggressionMin;
    if (adaptive.recheckActive && adaptive.staleBias && adaptive.lastStop?.regime === 'BOM') {
      if (adaptive.lastStop.side === side) {
        volumeThreshold *= 1.1;
        aggressionThreshold *= 1.1;
      } else {
        volumeThreshold *= 0.95;
        aggressionThreshold *= 0.95;
      }
    }
    volumeThreshold = Math.max(0, volumeThreshold);
    aggressionThreshold = Math.max(0, aggressionThreshold);
    this.logger.debug('intraday.directional-pressure', {
      symbol: input.symbol,
      regime: 'BOM',
      side,
      pressure,
      sidePenalty,
      effectiveRiskReduction,
    });

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
    const aggressionOk = f1.orderBook.aggressionRatio >= aggressionThreshold;
    const volumeOk = f1.volume.zScore >= volumeThreshold;
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

    const baseStopPct = computeStopPct('BOM', f1.volatility.atrPct, this.cfg);
    const tpFirstPctBase = Math.max(1e-6, this.cfg.stops.tp.firstPct);
    const tpSecondPctBase = Math.max(tpFirstPctBase * 1.1, this.cfg.stops.tp.secondPct);
    const weightFirst = Math.max(0, this.cfg.stops.tp.firstSize);
    const weightSecond = Math.max(0, this.cfg.stops.tp.secondSize);
    const weightSum = weightFirst + weightSecond > 0 ? weightFirst + weightSecond : 1;
    const expectedTpPctBase = (weightFirst * tpFirstPctBase + weightSecond * tpSecondPctBase) / weightSum;
    const payoffRatio = baseStopPct > 0 ? expectedTpPctBase / baseStopPct : 1;
    const trendAlignment = emaSlow === 0 ? 0 : (emaFast - emaSlow) / Math.max(Math.abs(emaSlow), 1e-8);
    const candleRangePct = signalCandle.close === 0
      ? 0
      : Math.abs(signalCandle.high - signalCandle.low) / Math.max(Math.abs(signalCandle.close), 1e-8);
    const historyExpectancy = side === 'long' ? adaptive.qValues.qL : adaptive.qValues.qS;
    const quality = computeQualityScore({
      regime: 'BOM',
      confidence: regime.confidence,
      trendAlignment,
      volumeZScore: f1.volume.zScore,
      aggressionRatio: f1.orderBook.aggressionRatio,
      atrPct: f1.volatility.atrPct,
      priceZScore: f1.volatility.bandZScore,
      imbalance: f1.orderBook.imbalance,
      wickPct: candleRangePct,
      payoffRatio,
      historyExpectancy,
    }, this.runtimeCfg.qs);

    const evCfg = this.runtimeCfg.ev;
    const baseStopBps = Math.max(5, Math.round(baseStopPct * 10_000));
    const defaultTpBps = Math.max(10, Math.round(tpFirstPctBase * 10_000));
    const totalCostBps = Math.max(0, ctx.slippageBps) + evCfg.feesBps;
    let evChoice = {
      stopBps: baseStopBps,
      takeProfitBps: defaultTpBps,
      evBps: quality.pWin * Math.max(0, defaultTpBps - totalCostBps)
        - (1 - quality.pWin) * (baseStopBps + totalCostBps),
    };
    if (evCfg.enabled) {
      const slMin = Math.min(evCfg.slMinBps, baseStopBps);
      const slMax = Math.max(evCfg.slMaxBps, baseStopBps);
      const tpGrid = Array.from(new Set([...evCfg.tpGridBps, defaultTpBps]));
      evChoice = chooseEV(quality.pWin, {
        predictedSlippageBps: ctx.slippageBps,
        feesBps: evCfg.feesBps,
        tpGridBps: tpGrid,
        slMinBps: slMin,
        slMaxBps: slMax,
      });
    }
    const strategyMinStopBps = Math.round(this.cfg.stops.bom.minPct * 10_000);
    const evStopBps = Math.round(evChoice.stopBps);
    const evTpBps = Math.round(evChoice.takeProfitBps);
    const stopBps = Math.max(strategyMinStopBps, evCfg.enabled ? Math.max(evCfg.slMinBps, Math.min(evCfg.slMaxBps, evStopBps)) : baseStopBps);
    const tpBaseBps = Math.max(stopBps + 5, evCfg.enabled ? Math.max(10, evTpBps) : defaultTpBps);
    const stopPct = stopBps / 10_000;
    const tpBasePct = tpBaseBps / 10_000;
    const tpMultiplier = tpFirstPctBase > 0 ? tpSecondPctBase / tpFirstPctBase : 2;
    const tpSecondPct = tpBasePct * tpMultiplier;

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
      riskReduction: effectiveRiskReduction * pyramidScale,
      riskScale: quality.riskScale,
      baseRiskPct: this.runtimeCfg.qs.baseRiskPct,
    });
    if (sized.size.raw === 0n) return null;

    const bufferPct = (this.cfg.entry.bom.stopBufferBps ?? 0) / 10_000;
    const bufferDecimal = new PreciseDecimal(bufferPct.toString());
    const signedBuffer = side === 'long' ? bufferDecimal : new PreciseDecimal((-bufferPct).toString());
    const signalExtreme = side === 'long' ? signalCandle.high : signalCandle.low;
    const signalExtremeDecimal = new PreciseDecimal(signalExtreme);
    const triggerPrice = signalExtremeDecimal.plus(signalExtremeDecimal.times(signedBuffer));
    const stopPrice = pctToPrice(triggerPrice, stopPct, side, 'sl');
    const tp1 = pctToPrice(triggerPrice, tpBasePct, side, 'tp');
    const tp2 = pctToPrice(triggerPrice, tpSecondPct, side, 'tp');

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

    let confidence = regime.confidence;
    if (adaptive.recheckActive && adaptive.staleBias && adaptive.lastStop?.regime === 'BOM' && adaptive.lastStop.side === side) {
      confidence = Math.max(0, confidence * 0.95);
    }
    const adjustedConfidence = this.adjustConfidenceWithHistory(confidence, side, adaptive.qValues);
    this.logger.debug('intraday.history-bias', {
      symbol: input.symbol,
      regime: 'BOM',
      side,
      qL: adaptive.qValues.qL,
      qS: adaptive.qValues.qS,
      adjustedConfidence,
    });

    const rationale = [
      'BOM breakout confirmed',
      `volumeZ=${f1.volume.zScore.toFixed(2)}`,
      `aggr=${f1.orderBook.aggressionRatio.toFixed(2)}`,
      isPyramidAdd ? 'pyramid-add' : 'base-entry',
    ];
    if (adaptive.recheckActive && adaptive.staleBias && adaptive.lastStop) {
      rationale.push(adaptive.lastStop.side === side ? 'adaptive-tighten' : 'adaptive-relax');
    }

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
      confidence: adjustedConfidence,
      rationale,
      execution,
      entryAtrPct: f1.volatility.atrPct,
      pyramidAdd: isPyramidAdd,
      stopGrace,
      telemetry: {
        pWin: quality.pWin,
        qs: quality.qs,
        riskScale: quality.riskScale,
        slBps: stopBps,
        tpBps: Math.round(tpBasePct * 10_000),
        evBps: evChoice.evBps,
        predictedSlippageBps: ctx.slippageBps,
      },
    };
  }

  private evaluateMeanReversionEntry(
    input: TickInput,
    features: Record<'1m' | '5m' | '15m', TickFeatures>,
    ctx: EvaluateContext,
    adaptiveOrRisk: AdaptiveParams | number,
    regime: RegimeSignal,
  ): EntrySignal | null {
    const adaptive: AdaptiveParams = typeof adaptiveOrRisk === 'number'
      ? {
        recheckActive: false,
        staleBias: false,
        lastStop: null,
        qValues: this.history.qValues(),
        guardRiskReduction: adaptiveOrRisk,
      }
      : adaptiveOrRisk;
    const f1 = features['1m'];
    const atrOk = f1.volatility.atrPct <= this.cfg.entry.mr.atrMaxPct;
    if (!atrOk) return null;

    const guardReduction = adaptive.guardRiskReduction ?? 1;
    const lastStop = adaptive.lastStop;
    const baseThreshold = this.cfg.entry.mr.priceZScore;
    let thresholdLong = baseThreshold;
    let thresholdShort = baseThreshold;
    let obiDeltaLong = this.cfg.entry.mr.obiDeltaMin;
    let obiDeltaShort = this.cfg.entry.mr.obiDeltaMin;
    let wickLong = this.cfg.entry.mr.wickMinPct;
    let wickShort = this.cfg.entry.mr.wickMinPct;
    if (adaptive.recheckActive && adaptive.staleBias && lastStop?.regime === 'MR') {
      if (lastStop.side === 'long') {
        thresholdLong *= 1.05;
        obiDeltaLong *= 1.1;
        wickLong *= 1.05;
        thresholdShort *= 0.95;
        obiDeltaShort *= 0.9;
        wickShort *= 0.95;
      } else {
        thresholdShort *= 1.05;
        obiDeltaShort *= 1.1;
        wickShort *= 1.05;
        thresholdLong *= 0.95;
        obiDeltaLong *= 0.9;
        wickLong *= 0.95;
      }
    }

    const priceZ = f1.volatility.bandZScore;
    const side: 'long' | 'short' | null = priceZ <= -thresholdLong
      ? 'long'
      : priceZ >= thresholdShort
        ? 'short'
        : null;
    if (!side) return null;

    const obiDeltaMin = side === 'long' ? obiDeltaLong : obiDeltaShort;
    const wickMinPct = side === 'long' ? wickLong : wickShort;
    const sidePressure = this.dirPressure.recentPressure(input.symbol, 'MR', side, input.timestamp);
    const sidePenalty = computeSidePenalty(sidePressure);
    const effectiveRiskReduction = Math.max(0, guardReduction) * sidePenalty;
    this.logger.debug('intraday.directional-pressure', {
      symbol: input.symbol,
      regime: 'MR',
      side,
      pressure: sidePressure,
      sidePenalty,
      effectiveRiskReduction,
    });

    const wick = this.computeWickPct(input.candles['1m']);
    const imbalance = f1.orderBook.imbalance;
    const imbalanceExtreme = Math.abs(imbalance) >= this.cfg.entry.mr.obiExtreme;
    const imbalanceReversing = side === 'long'
      ? f1.orderBook.imbalanceDelta >= obiDeltaMin
      : f1.orderBook.imbalanceDelta <= -obiDeltaMin;
    if (!imbalanceExtreme || !imbalanceReversing) return null;

    const momentumDiv = (f1.momentum.roc['1'] ?? 0) * (features['5m'].momentum.roc['3'] ?? 0) < 0;
    if (!momentumDiv) return null;

    const wickOk = side === 'long' ? wick.lower >= wickMinPct : wick.upper >= wickMinPct;
    if (!wickOk) return null;

    const baseStopPct = computeStopPct('MR', f1.volatility.atrPct, this.cfg);
    const tpFirstPctBase = Math.max(1e-6, this.cfg.stops.tp.firstPct * 0.8);
    const tpSecondPctBase = Math.max(tpFirstPctBase * 1.1, this.cfg.stops.tp.secondPct * 0.7);
    const weightFirst = Math.max(0, this.cfg.stops.tp.firstSize);
    const weightSecond = Math.max(0, this.cfg.stops.tp.secondSize);
    const weightSum = weightFirst + weightSecond > 0 ? weightFirst + weightSecond : 1;
    const expectedTpPctBase = (weightFirst * tpFirstPctBase + weightSecond * tpSecondPctBase) / weightSum;
    const payoffRatio = baseStopPct > 0 ? expectedTpPctBase / baseStopPct : 1;
    const wickPct = side === 'long' ? wick.lower : wick.upper;
    const historyExpectancy = side === 'long' ? adaptive.qValues.qL : adaptive.qValues.qS;
    const trendAlignment = -(Math.abs(features['5m'].momentum.roc['3'] ?? 0));
    const quality = computeQualityScore({
      regime: 'MR',
      confidence: Math.max(regime.confidence, 0.6),
      trendAlignment,
      volumeZScore: f1.volume.zScore,
      aggressionRatio: Math.abs(f1.orderBook.aggressionRatio - 0.5) * 2,
      atrPct: f1.volatility.atrPct,
      priceZScore: Math.abs(priceZ),
      imbalance: imbalance,
      wickPct,
      payoffRatio,
      historyExpectancy,
    }, this.runtimeCfg.qs);

    const evCfg = this.runtimeCfg.ev;
    const baseStopBps = Math.max(5, Math.round(baseStopPct * 10_000));
    const defaultTpBps = Math.max(10, Math.round(tpFirstPctBase * 10_000));
    const totalCostBps = Math.max(0, ctx.slippageBps) + evCfg.feesBps;
    let evChoice = {
      stopBps: baseStopBps,
      takeProfitBps: defaultTpBps,
      evBps: quality.pWin * Math.max(0, defaultTpBps - totalCostBps)
        - (1 - quality.pWin) * (baseStopBps + totalCostBps),
    };
    if (evCfg.enabled) {
      const slMin = Math.min(evCfg.slMinBps, baseStopBps);
      const slMax = Math.max(evCfg.slMaxBps, baseStopBps);
      const tpGrid = Array.from(new Set([...evCfg.tpGridBps, defaultTpBps]));
      evChoice = chooseEV(quality.pWin, {
        predictedSlippageBps: ctx.slippageBps,
        feesBps: evCfg.feesBps,
        tpGridBps: tpGrid,
        slMinBps: slMin,
        slMaxBps: slMax,
      });
    }
    const strategyMinStopBps = Math.round(this.cfg.stops.mr.minPct * 10_000);
    const evStopBps = Math.round(evChoice.stopBps);
    const evTpBps = Math.round(evChoice.takeProfitBps);
    const stopBps = Math.max(strategyMinStopBps, evCfg.enabled ? Math.max(evCfg.slMinBps, Math.min(evCfg.slMaxBps, evStopBps)) : baseStopBps);
    const tpBaseBps = Math.max(stopBps + 5, evCfg.enabled ? Math.max(10, evTpBps) : defaultTpBps);
    const stopPct = stopBps / 10_000;
    const tpBasePct = tpBaseBps / 10_000;
    const tpMultiplier = tpFirstPctBase > 0 ? tpSecondPctBase / tpFirstPctBase : 2;
    const tpSecondPct = tpBasePct * tpMultiplier;

    const sized = this.sizer.compute({
      equityUsd: ctx.equityUsd,
      stopLossPct: stopPct,
      regime: 'MR',
      price: new PreciseDecimal(input.price),
      maxLevInstrument: ctx.maxLevInstrument,
      maxLevGlobal: ctx.maxLevGlobal,
      exposureBudget: ctx.exposureBudget,
      slippageBps: ctx.slippageBps,
      riskReduction: effectiveRiskReduction,
      riskScale: quality.riskScale,
      baseRiskPct: this.runtimeCfg.qs.baseRiskPct,
    });
    if (sized.size.raw === 0n) return null;

    const entryPrice = new PreciseDecimal(input.price);
    const stopPrice = pctToPrice(entryPrice, stopPct, side, 'sl');
    const tp1 = pctToPrice(entryPrice, tpBasePct, side, 'tp');
    const tp2 = pctToPrice(entryPrice, tpSecondPct, side, 'tp');

    const execution = this.execution.plan({
      regime: 'MR',
      orderBook: input.orderBook,
      atrPct: f1.volatility.atrPct,
      sizeUsd: sized.size.toNumber(),
      slippageBps: ctx.slippageBps,
    });

    let confidence = Math.max(regime.confidence, 0.6);
    if (adaptive.recheckActive && adaptive.staleBias && lastStop?.regime === 'MR' && lastStop.side === side) {
      confidence = Math.max(0.5, confidence * 0.95);
    }
    if (adaptive.recheckActive && adaptive.staleBias && adaptive.lastStop?.regime === 'BOM') {
      confidence = Math.min(1, confidence * 1.05);
    }
    const adjustedConfidence = this.adjustConfidenceWithHistory(confidence, side, adaptive.qValues);
    this.logger.debug('intraday.history-bias', {
      symbol: input.symbol,
      regime: 'MR',
      side,
      qL: adaptive.qValues.qL,
      qS: adaptive.qValues.qS,
      adjustedConfidence,
    });

    const rationale = [
      'MR extreme detected',
      `z=${priceZ.toFixed(2)}`,
      `imb=${imbalance.toFixed(2)}`,
      `wick=${(side === 'long' ? wick.lower : wick.upper).toFixed(4)}`,
    ];
    if (adaptive.recheckActive && adaptive.staleBias && lastStop) {
      rationale.push(lastStop.side === side ? 'adaptive-tighten' : 'adaptive-relax');
    }

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
      confidence: adjustedConfidence,
      rationale,
      execution,
      entryAtrPct: f1.volatility.atrPct,
      pyramidAdd: false,
      telemetry: {
        pWin: quality.pWin,
        qs: quality.qs,
        riskScale: quality.riskScale,
        slBps: stopBps,
        tpBps: Math.round(tpBasePct * 10_000),
        evBps: evChoice.evBps,
        predictedSlippageBps: ctx.slippageBps,
      },
    };
  }

  private adjustConfidenceWithHistory(
    confidence: number,
    side: 'long' | 'short',
    qValues: { qL: number; qS: number },
  ): number {
    const delta = Math.max(-0.01, Math.min(0.01, qValues.qS - qValues.qL));
    const tilt = side === 'short' ? delta : -delta;
    const factor = 1 + 0.15 * (tilt / 0.01);
    const adjusted = confidence * factor;
    return Math.max(0, Math.min(1, adjusted));
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
    const priceDelta = price.minus(position.entryPrice);
    const normalizedDelta = priceDelta.dividedBy(position.entryPrice);
    const directionDecimal = new PreciseDecimal(direction.toString());
    const pctChange = normalizedDelta.times(directionDecimal);
    const pnl = notionalClosed.times(pctChange);
    const riskPortion = position.riskUsd.times(fractionDecimal);
    this.guardrails.recordTrade(symbol, pnl, riskPortion, position.equityAtEntry, timestamp);
    if (reason === 'stop' && (position.regime === 'BOM' || position.regime === 'MR')) {
      const expiresAt = timestamp + 10 * 60_000;
      this.postStopRecheck.set(symbol, expiresAt);
      const ctx: StopContext = { regime: position.regime, side: position.side };
      this.lastStopContext.set(symbol, ctx);
      this.dirPressure.recordStop(symbol, position.regime, position.side, timestamp);
      this.logger.debug('intraday.post-stop-recheck', {
        symbol,
        regime: position.regime,
        side: position.side,
        expiresAt,
      });
    }
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
    const counterDirectionDecimal = new PreciseDecimal((-direction).toString());
    const counterfactualPct = normalizedDelta.times(counterDirectionDecimal);
    const counterfactual = notionalClosed.times(counterfactualPct);
    const pnlNumber = pnl.toNumber();
    const counterNumber = counterfactual.toNumber();
    if (Number.isFinite(pnlNumber) && Number.isFinite(counterNumber)) {
      this.history.update(
        {
          side: position.side,
          pnl: pnlNumber,
          entryTs: position.entryTime,
          exitTs: timestamp,
          ctx: { reason, fraction: fractionDecimal.toNumber(), atrPct },
        },
        counterNumber,
      );
      const q = this.history.qValues();
      this.logger.debug('intraday.history-update', {
        symbol,
        side: position.side,
        pnl: pnlNumber,
        counterfactual: counterNumber,
        qL: q.qL,
        qS: q.qS,
      });
    }
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

  getAdaptiveState(symbol: string, now: number): {
    recheckUntil: number;
    lastStop: StopContext | null;
    pressure: Record<'BOM' | 'MR', { long: number; short: number }>;
  } {
    return {
      recheckUntil: this.postStopRecheck.get(symbol) ?? 0,
      lastStop: this.lastStopContext.get(symbol) ?? null,
      pressure: {
        BOM: {
          long: this.dirPressure.recentPressure(symbol, 'BOM', 'long', now),
          short: this.dirPressure.recentPressure(symbol, 'BOM', 'short', now),
        },
        MR: {
          long: this.dirPressure.recentPressure(symbol, 'MR', 'long', now),
          short: this.dirPressure.recentPressure(symbol, 'MR', 'short', now),
        },
      },
    };
  }
}
