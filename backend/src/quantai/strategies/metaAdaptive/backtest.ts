import { getQuantAIConfig } from '../../config.js';
import { PositionSizer, type PositionSizingResult } from '../../risk/positionSizing.js';
import type {
  BacktestMetrics,
  BacktestResult,
  Candle,
  EntrySignal,
  TradeLog,
} from '../intradayDual/types.js';
import { aggregateCandles } from '../intradayDual/backtest.js';
import { computeInitialBracket, maybeAdjustOrExit, type ExitDirective } from './exitManager.js';
import {
  evaluateRecognizedStrategies,
  type RecognizedStrategySignal,
} from './recognizedStrategies.js';
import { PreciseDecimal } from './metaAdaptiveAgent.js';
import type { TechnicalSnapshot } from '../../../ai/tech.js';
import { StrategyHealth } from '../../services/strategyHealth.js';
import { calculateExecutionCosts } from '../../executionCosts.js';

export type MetaAdaptiveBacktestOptions = {
  symbol: string;
  equityUsd: number;
  slippageBps?: number;
  makerFeeBps?: number;
  takerFeeBps?: number;
  fundingAnnualPct?: number;
  latencyMs?: number;
  impactBpsPerMillion?: number;
};

type SimulationArtifacts = {
  metrics: BacktestMetrics;
  trades: TradeLog[];
  signals: EntrySignal[];
};

type ActivePosition = {
  side: 'long' | 'short';
  qty: PreciseDecimal;
  entryPrice: number;
  stop: number;
  targets: number[];
  riskPerUnit: number;
  openedAt: number;
  entryAtr: number;
  entryAtrPct: number;
  initialStopDistance: number;
  hitTargets: Set<number>;
  signal: RecognizedStrategySignal;
  sizing: PositionSizingResult;
  cumulativePnl: PreciseDecimal;
};

type MultiTfBias = 'bullish' | 'bearish' | 'neutral';

const DEFAULT_MIN_HISTORY = 240;
const MIN_BARS_FOR_INDICATORS = 20;
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function sumVolumes(candles: Candle[], bars: number): number {
  const look = Math.min(Math.max(bars, 1), candles.length);
  let total = 0;
  for (let i = candles.length - look; i < candles.length; i += 1) {
    total += candles[i].volume ?? 0;
  }
  return total;
}

function minLow(candles: Candle[], lookback: number): number {
  if (!candles.length) return 0;
  const start = Math.max(0, candles.length - lookback);
  let min = Number.POSITIVE_INFINITY;
  for (let i = start; i < candles.length; i += 1) {
    if (candles[i].low < min) min = candles[i].low;
  }
  return Number.isFinite(min) ? min : candles[candles.length - 1].low;
}

function maxHigh(candles: Candle[], lookback: number): number {
  if (!candles.length) return 0;
  const start = Math.max(0, candles.length - lookback);
  let max = Number.NEGATIVE_INFINITY;
  for (let i = start; i < candles.length; i += 1) {
    if (candles[i].high > max) max = candles[i].high;
  }
  return Number.isFinite(max) ? max : candles[candles.length - 1].high;
}

function deriveSrBias(price: number, support: number, resistance: number): TechnicalSnapshot['srBias'] {
  if (!(price > 0) || !(support > 0) || !(resistance > 0)) return 'neutral';
  const nearThreshold = 0.006; // 0.6%
  if (Math.abs(price - support) / support <= nearThreshold) return 'nearSupport';
  if (Math.abs(price - resistance) / resistance <= nearThreshold) return 'nearResistance';
  return 'neutral';
}

function deriveStrategyEntryType(signal: RecognizedStrategySignal): { regime: EntrySignal['regime']; entryType: EntrySignal['entryType'] } {
  if (signal.id === 'bollinger_mean_reversion') {
    return { regime: 'MR', entryType: 'mean-reversion' };
  }
  if (signal.id === 'breakout_retest') {
    return { regime: 'BOM', entryType: 'breakout' };
  }
  if (signal.id === 'momentum_scanner_focus') {
    return { regime: 'BOM', entryType: 'breakout' };
  }
  return { regime: 'BOM', entryType: 'breakout' };
}

function selectSignal(signals: RecognizedStrategySignal[]): RecognizedStrategySignal | null {
  const eligible = signals
    .filter((signal) => signal.confidenceGatePassed && signal.entryEligibilityGatePassed && !signal.blockedReason);
  if (!eligible.length) return null;
  const sorted = eligible.sort((a, b) => b.confidence - a.confidence);
  return sorted[0] ?? null;
}

function resolveTradeSide(signal: RecognizedStrategySignal, snap: TechnicalSnapshot): 'long' | 'short' | null {
  if (signal.bias === 'long') return 'long';
  if (signal.bias === 'short') return 'short';
  if (signal.bias === 'both') {
    if (snap.trendBias === 'bearish') return 'short';
    if (snap.trendBias === 'bullish') return 'long';
    return 'long';
  }
  return null;
}

function computeAtrPct(atrValue: number, price: number): number {
  if (!(atrValue > 0) || !(price > 0)) return 0;
  return (atrValue / price) * 100;
}

function buildSnapshotFromHistory(params: {
  symbol: string;
  history15m: Candle[];
}): TechnicalSnapshot | null {
  const { symbol, history15m } = params;
  if (history15m.length < MIN_BARS_FOR_INDICATORS) return null;

  const lastCandle = history15m[history15m.length - 1];
  const firstWindowCandle = history15m[Math.max(0, history15m.length - 120)];
  const midIndex = Math.max(0, Math.floor(history15m.length / 2));
  const midCandle = history15m[midIndex];
  const last = lastCandle.close;
  const startPrice = firstWindowCandle.close;
  const midPrice = midCandle.close;
  const priceChange = (last - startPrice) / Math.max(startPrice, 1e-9);
  const midChange = (last - midPrice) / Math.max(midPrice, 1e-9);

  const avgVolume = history15m.slice(-120).reduce((sum, candle) => sum + candle.volume, 0) / 120;
  const lastVolume = lastCandle.volume;
  const volumeRatio = avgVolume > 0 ? lastVolume / avgVolume : 1;

  type Profile = 'trend_up' | 'trend_down' | 'momentum' | 'range';
  let profile: Profile = 'range';
  if (priceChange > 0.045 && midChange > 0.02) profile = 'trend_up';
  else if (priceChange < -0.045 && midChange < -0.02) profile = 'trend_down';
  else if (Math.abs(priceChange) > 0.025 && volumeRatio > 1.4) profile = 'momentum';

  const biasMap: Record<Profile, MultiTfBias> = {
    trend_up: 'bullish',
    trend_down: 'bearish',
    momentum: priceChange >= 0 ? 'bullish' : 'bearish',
    range: 'neutral',
  };

  const baseAtrPct = profile === 'range' ? 0.6 : 1.2 + Math.abs(priceChange) * 8;
  const cmf = profile === 'trend_down'
    ? -0.25 - Math.min(0.2, Math.abs(priceChange))
    : profile === 'range'
      ? 0.02
      : 0.28 + Math.min(0.2, priceChange);
  const adx = profile === 'range' ? 14 + Math.abs(priceChange) * 20 : 26 + Math.abs(priceChange) * 30;

  const atr14 = last * (baseAtrPct / 100);
  const atr1h = atr14 * 1.2;
  const atr4h = atr14 * 1.6;

  const emaBias = profile === 'trend_down'
    ? -0.006 - Math.abs(priceChange) * 0.6
    : profile === 'trend_up'
      ? 0.008 + priceChange * 0.6
      : 0.001;

  const ema50Bias = emaBias / 2;
  const ema100Bias = emaBias / 3;
  const ema200Bias = emaBias / 4;

  const support = last * (profile === 'trend_down' ? 1.02 : 0.97);
  const resistance = last * (profile === 'trend_up' ? 0.98 : 1.03);
  const srBias: TechnicalSnapshot['srBias'] = profile === 'trend_down'
    ? 'nearResistance'
    : profile === 'trend_up'
      ? 'nearSupport'
      : 'neutral';

  const trendStrength = profile === 'range'
    ? 0.3
    : 0.7 + Math.min(0.6, Math.abs(priceChange) * 4);

  const tfBias = biasMap[profile];
  const altBias = tfBias === 'bullish' ? 'bearish' : 'bullish';
  const tf4hBias = profile === 'range' ? 'neutral' : tfBias;
  const tf1hBias = profile === 'range' ? (priceChange >= 0 ? 'bullish' : 'bearish') : tfBias;
  const tf15Bias = profile === 'range' ? (Math.abs(midChange) > 0.01 ? (midChange > 0 ? 'bullish' : 'bearish') : 'neutral') : tfBias;

  const tf4h = {
    tf: '4h',
    bias: tf4hBias,
    momentumPct: priceChange * 500,
    rsi: tf4hBias === 'bullish' ? 58 : tf4hBias === 'bearish' ? 42 : 50,
  } as const;
  const tf1h = {
    tf: '1h',
    bias: tf1hBias,
    momentumPct: midChange * 350,
    rsi: tf1hBias === 'bullish' ? 56 : tf1hBias === 'bearish' ? 44 : 50,
  } as const;
  const tf15 = {
    tf: '15m',
    bias: tf15Bias,
    momentumPct: midChange * 250,
    rsi: tf15Bias === 'bullish' ? 55 : tf15Bias === 'bearish' ? 45 : 50,
  } as const;

  const agreementScore = [tf4h.bias, tf1h.bias, tf15.bias].filter((bias) => bias === tfBias).length;
  const divergenceScore = tfBias === 'neutral' ? 1 : Math.max(0, 3 - agreementScore);

  const volume24h = history15m.slice(-96).reduce((sum, candle) => sum + candle.volume, 0);
  const cmfClamped = clamp(cmf, -0.45, 0.45);

  if (process.env.META_ADAPTIVE_BT_DEBUG === 'true') {
    // eslint-disable-next-line no-console
    console.log('[meta-adaptive-backtest] snapshot_profile', {
      ts: new Date(lastCandle.timestamp).toISOString(),
      profile,
      priceChange: Number(priceChange.toFixed(4)),
      midChange: Number(midChange.toFixed(4)),
      volumeRatio: Number(volumeRatio.toFixed(3)),
      adx: clamp(adx, 8, 48).toFixed(2),
      cmf: cmfClamped.toFixed(3),
    });
  }

  return {
    symbol,
    last,
    ema20: last * (1 + emaBias),
    ema50: last * (1 + ema50Bias),
    ema100: last * (1 + ema100Bias),
    ema200: last * (1 + ema200Bias),
    rsi14: tf15.rsi,
    atr14,
    atr14_1h: atr1h,
    atr14_4h: atr4h,
    atrPct: baseAtrPct,
    adx14: clamp(adx, 8, 48),
    ema20Slope: last * emaBias * 0.4,
    support,
    resistance,
    supports: [{ price: support, label: 'S1', touches: 2, strength: 2 }],
    resistances: [{ price: resistance, label: 'R1', touches: 2, strength: 2 }],
    pivots: {
      P: last,
      S1: last * 0.99,
      S2: last * 0.98,
      R1: last * 1.01,
      R2: last * 1.02,
      refDay: new Date(lastCandle.timestamp - 86_400_000).toISOString().slice(0, 10),
    },
    trend: trendStrength,
    srBias,
    meta: { tf: '15m', windowBars: history15m.length, recentBarsFor24h: Math.min(history15m.length, 96) },
    realizedVol: clamp(baseAtrPct * 1.2, 0.4, 3.5),
    hurst: clamp(0.52 + priceChange * 0.6, 0.2, 0.8),
    adxSlope: priceChange * 15,
    trendStrength,
    trendBias: tfBias === 'neutral' ? (priceChange >= 0 ? 'bullish' : 'bearish') : (tfBias as TechnicalSnapshot['trendBias']),
    volume: lastVolume,
    volumeMA: avgVolume,
    volume24h,
    cmf20: cmfClamped,
    multiTimeframe: {
      timeframes: {
        '4h': tf4h,
        '1h': tf1h,
        '15m': tf15,
      },
      agreementScore,
      divergenceScore,
    },
  };
}

function simulateSegment(candles: Candle[], options: MetaAdaptiveBacktestOptions): SimulationArtifacts {
  if (!candles.length) {
    return {
      metrics: {
        totalReturnPct: 0,
        cagr: 0,
        sharpe: 0,
        maxDrawdownPct: 0,
        hitRate: 0,
        profitFactor: 0,
        avgWin: 0,
        avgLoss: 0,
        pnlSeries: [],
      },
      trades: [],
      signals: [],
    };
  }

  const quantConfig = getQuantAIConfig();
  const baseExitConfig = quantConfig.exits;
  const positionSizer = new PositionSizer(quantConfig.risk.baseRiskPerTradePct);

  const candles15m = aggregateCandles(candles, 15);

  const makerFeeBps = options.makerFeeBps ?? 1.8;
  const takerFeeBps = options.takerFeeBps ?? 5;
  const slippageBpsDefault = options.slippageBps ?? 4;
  const fundingAnnualPct = options.fundingAnnualPct ?? 0;
  const latencyMs = options.latencyMs ?? 0;
  const impactBpsPerMillion = options.impactBpsPerMillion ?? 0;
  const feeModel = { makerFeeBps, takerFeeBps };

  const startEquity = new PreciseDecimal(options.equityUsd);
  let equity = startEquity;
  let runtimeSlippage = slippageBpsDefault;
  let attemptedEntries = 0;
  let filledEntries = 0;

  const runtimeFillRate = (): number => (attemptedEntries ? filledEntries / attemptedEntries : 1);

  const tradeLogs: TradeLog[] = [];
  const entrySignals: EntrySignal[] = [];
  const pnlSeries: number[] = [];

  let position: ActivePosition | null = null;

  let idx15 = 0;
  // Aggregated indices retained for future extensions
  const strategyHealth = new StrategyHealth({ window: 20, minTradesForGuard: 6, refreshCooldownMs: 20 * 60 * 1000 });
  let healthCooldownUntil = 0;
  let healthSnapshot = strategyHealth.snapshot();
  const unitTestMode = process.env.UNIT_TEST_MODE === 'true';
  const silentBenchmark = process.env.META_ADAPTIVE_BENCHMARK_SILENT === 'true';
  let lastRiskLogSignature: string | null = null;
  let lastGuardLogSignature: string | null = null;

  for (let i = DEFAULT_MIN_HISTORY; i < candles.length; i += 1) {
    const candle = candles[i];
    const prevCandle = candles[Math.max(i - 1, 0)];

    while (idx15 < candles15m.length && candles15m[idx15].timestamp <= candle.timestamp) idx15 += 1;
    const history15m = candles15m.slice(0, idx15);

    const snapshot = buildSnapshotFromHistory({
      symbol: options.symbol,
      history15m,
    });

    if (!snapshot) continue;

    if (position) {
      const side = position.side;
      const stopTriggered = side === 'long'
        ? candle.low <= position.stop
        : candle.high >= position.stop;

      const targetIndex = (() => {
        for (let t = 0; t < position.targets.length; t += 1) {
          if (position.hitTargets.has(t)) continue;
          const target = position.targets[t];
          if (side === 'long' ? candle.high >= target : candle.low <= target) {
            return t;
          }
        }
        return -1;
      })();

      const elapsedMinutes = (candle.timestamp - position.openedAt) / 60000;
      const directive: ExitDirective = maybeAdjustOrExit({
        side,
        entryPrice: position.entryPrice,
        stop: position.stop,
        targets: position.targets,
        lastPrice: candle.close,
        atr: snapshot.atr14,
        entryAtr: position.entryAtr,
        entryAtrPct: position.entryAtrPct,
        initialStopDistance: position.initialStopDistance,
        adx: snapshot.adx14,
        cmf: snapshot.cmf20 ?? null,
        cfg: baseExitConfig,
        alreadyTriggeredTargets: position.hitTargets,
        archetype: 'impulse',
        minutesOpen: elapsedMinutes,
      });

      if (directive.action === 'move_sl' && Number.isFinite(directive.stop)) {
        position.stop = directive.stop;
      }

      let exitReason: TradeLog['reason'] | null = null;
      let exitPrice: number | null = null;

      if (stopTriggered) {
        exitReason = 'stop';
        exitPrice = position.stop;
      } else if (targetIndex >= 0) {
        position.hitTargets.add(targetIndex);
        exitReason = targetIndex === 0 ? 'tp1' : 'tp2';
        exitPrice = position.targets[targetIndex];
      } else if (directive.action === 'exit') {
        exitReason = 'runner';
        exitPrice = candle.close;
      }

      if (exitReason && exitPrice != null) {
        const priceDelta = side === 'long'
          ? exitPrice - position.entryPrice
          : position.entryPrice - exitPrice;
        const pnl = new PreciseDecimal(priceDelta * position.qty.toNumber());
        position.cumulativePnl = pnl;
        equity = equity.plus(pnl);
        const pnlR = position.riskPerUnit > 0 ? priceDelta / position.riskPerUnit : 0;
        strategyHealth.recordTrade({ pnlR, timestamp: candle.timestamp, regime: position.signal.id });
        healthSnapshot = strategyHealth.snapshot();
        const guard = healthSnapshot.guardrail;
        if (guard) {
          const cooldownEnd = guard.cooldownMs ? candle.timestamp + guard.cooldownMs : candle.timestamp;
          healthCooldownUntil = Math.max(healthCooldownUntil, cooldownEnd);
          if (healthSnapshot.guardrailChanged) {
            const guardSignature = `${guard.reason}:${Math.round(guard.cooldownMs ?? 0)}`;
            const winratePct = (healthSnapshot.winRate * 100).toFixed(2);
            const expectancyStr = healthSnapshot.expectancy.toFixed(4);
            if (!silentBenchmark && (!unitTestMode || guardSignature !== lastGuardLogSignature)) {
              console.log(`[StrategyHealth] cooldown applied (${guard.reason}) for ${(guard.cooldownMs ?? 0) / 60000} minutes (winrate20=${winratePct}%, exp20=${expectancyStr})`);
            }
            lastGuardLogSignature = guardSignature;
          }
        } else if (healthSnapshot.guardrailChanged) {
          if (!silentBenchmark && (!unitTestMode || lastGuardLogSignature !== 'cleared')) {
            const winratePct = (healthSnapshot.winRate * 100).toFixed(2);
            const expectancyStr = healthSnapshot.expectancy.toFixed(4);
            console.log(`[StrategyHealth] cooldown cleared (winrate20=${winratePct}%, exp20=${expectancyStr})`);
          }
          lastGuardLogSignature = 'cleared';
        }

        const holdMs = Math.max(0, candle.timestamp - position.openedAt);
        const exitCosts = calculateExecutionCosts({
          price: exitPrice,
          qty: position.qty.toNumber(),
          side: side === 'long' ? 'sell' : 'buy',
          liquidity: 'taker',
          fees: feeModel,
          impactBpsPerMillion,
          fundingAnnualPct,
          holdMs,
          latencyMs,
          atr: snapshot.atr14,
          lastPrice: prevCandle.close,
        });
        equity = equity.minus(new PreciseDecimal(exitCosts.totalUsd));

        pnlSeries.push(equity.toNumber());

        const trade: TradeLog = {
          timestamp: candle.timestamp,
          side,
          quantity: position.qty,
          price: new PreciseDecimal(exitPrice),
          cumulativePnl: pnl,
          reason: exitReason,
          executionMode: 'taker',
          holdDurationMs: candle.timestamp - position.openedAt,
          entryAtrPct: position.entryAtrPct,
          exitAtrPct: snapshot.atrPct,
        };
        tradeLogs.push(trade);
        position = null;
      } else if (directive.action === 'take_partial') {
        position.hitTargets.add(directive.tpHitIndex ?? 0);
      }
    }

    if (position) {
      continue;
    }

    if (candle.timestamp < healthCooldownUntil) {
      continue;
    }

    const directionalBias: 'long' | 'short' | 'none' = snapshot.trendBias === 'bullish'
      ? 'long'
      : snapshot.trendBias === 'bearish'
        ? 'short'
        : 'none';

    const microContext = {
      spreadBps: 6,
      depthUsd: 1_500_000,
      slippageBps: runtimeSlippage,
      fillRatio: runtimeFillRate(),
    };

    const rawVolume24h = Number((snapshot as any)?.volume24h);
    const volume24hUsd = Number.isFinite(rawVolume24h)
      ? rawVolume24h * snapshot.last
      : null;

    const healthRiskMultiplier = Number.isFinite(healthSnapshot.riskMultiplier)
      ? Number(healthSnapshot.riskMultiplier)
      : 1;
    const signals = evaluateRecognizedStrategies(snapshot, {
      symbol: options.symbol,
      bias: directionalBias,
      regime: snapshot.trendStrength > 0 ? 'trend_following' : 'range',
      allowMomentumOverride: true,
      favorMeanReversion: snapshot.srBias === 'nearResistance' || snapshot.srBias === 'nearSupport',
      multiTimeframe: snapshot.multiTimeframe ?? null,
      atr1h: snapshot.atr14_1h ?? null,
      atr4h: snapshot.atr14_4h ?? null,
      micro: microContext,
      volume24hUsd,
    });

    if (process.env.META_ADAPTIVE_BT_DEBUG === 'true' && signals.length) {
      // eslint-disable-next-line no-console
      console.log('[meta-adaptive-backtest] signals', {
        ts: new Date(candle.timestamp).toISOString(),
        confidence: signals.map((signal) => signal.confidence.toFixed(3)),
        gate: signals.map((signal) => ({
          id: signal.id,
          conf: signal.confidenceGatePassed,
          entry: signal.entryEligibilityGatePassed,
          reason: signal.blockedReason,
        })),
      });
    }

    const chosen = selectSignal(signals);
    if (!chosen) continue;

    const side = resolveTradeSide(chosen, snapshot);
    if (!side) continue;

    if (!(snapshot.atr14 > 0)) continue;

    const bracket = computeInitialBracket(candle.close, snapshot.atr14, side, baseExitConfig, 'impulse');
    const qtyResult = positionSizer.computeSize({
      equityUsd: equity.toNumber(),
      entryPrice: candle.close,
      stopDistanceAbs: bracket.riskPerUnit,
      currentAtrPct: snapshot.atrPct,
      minRiskPct: quantConfig.risk.baseRiskPerTradePct * 0.4,
      maxRiskPct: quantConfig.risk.baseRiskPerTradePct * 1.6,
    });

    if (!(qtyResult.qty > 0)) continue;

    const adjustedQty = qtyResult.qty * healthRiskMultiplier;
    if (!(adjustedQty > 0)) continue;
    const sizingSnapshot: PositionSizingResult = {
      ...qtyResult,
      qty: adjustedQty,
      riskUsd: qtyResult.riskUsd * healthRiskMultiplier,
      notionalUsd: qtyResult.notionalUsd * healthRiskMultiplier,
      rawQty: qtyResult.rawQty * healthRiskMultiplier,
      rawNotionalUsd: qtyResult.rawNotionalUsd * healthRiskMultiplier,
    };

    if (Math.abs(healthRiskMultiplier - 1) > 1e-3 && healthSnapshot.riskMultiplierChanged) {
      const reason = healthSnapshot.riskMultiplierReason ?? 'adjustment';
      const signature = `${reason}:${healthRiskMultiplier.toFixed(4)}`;
      const winratePct = (healthSnapshot.winRate * 100).toFixed(2);
      const expectancyStr = healthSnapshot.expectancy.toFixed(4);
      if (!silentBenchmark && (!unitTestMode || signature !== lastRiskLogSignature)) {
        console.log(`risk scaled by StrategyHealth x${healthRiskMultiplier.toFixed(2)} (reason=${reason}, winrate20=${winratePct}%, exp20=${expectancyStr})`);
      }
      lastRiskLogSignature = signature;
      healthSnapshot = { ...healthSnapshot, riskMultiplierChanged: false };
    }

    attemptedEntries += 1;
    filledEntries += 1;
    runtimeSlippage = slippageBpsDefault;

    const qtyDecimal = new PreciseDecimal(adjustedQty);
    const entryCosts = calculateExecutionCosts({
      price: candle.close,
      qty: adjustedQty,
      side: side === 'long' ? 'buy' : 'sell',
      liquidity: 'taker',
      fees: feeModel,
      impactBpsPerMillion,
      fundingAnnualPct: 0,
      holdMs: 0,
      latencyMs,
      atr: snapshot.atr14,
      lastPrice: prevCandle.close,
    });
    equity = equity.minus(new PreciseDecimal(entryCosts.totalUsd));

    const entryAtrPct = snapshot.atrPct;
    position = {
      side,
      qty: qtyDecimal,
      entryPrice: candle.close,
      stop: bracket.stop,
      targets: bracket.targets,
      riskPerUnit: bracket.riskPerUnit,
      openedAt: candle.timestamp,
      entryAtr: snapshot.atr14,
      entryAtrPct,
      initialStopDistance: bracket.riskPerUnit,
      hitTargets: new Set<number>(),
      signal: chosen,
      sizing: sizingSnapshot,
      cumulativePnl: new PreciseDecimal(0),
    };

    const { regime, entryType } = deriveStrategyEntryType(chosen);

    const entrySignal: EntrySignal = {
      regime,
      side,
      entryType,
      triggerPrice: new PreciseDecimal(candle.close),
      stopLossPrice: new PreciseDecimal(bracket.stop),
      takeProfit1: new PreciseDecimal(bracket.targets[0] ?? candle.close),
      takeProfit2: new PreciseDecimal(bracket.targets[1] ?? bracket.targets[0] ?? candle.close),
      runnerTrailAtrMult: baseExitConfig.trailAtrMult,
      size: qtyDecimal,
      riskUsd: new PreciseDecimal(sizingSnapshot.riskUsd),
      leverage: sizingSnapshot.notionalUsd / Math.max(options.equityUsd, 1e-9),
      confidence: chosen.confidence,
      rationale: chosen.reasons,
      execution: {
        mode: 'taker',
        maxSlippageBps: takerFeeBps,
      },
      entryAtrPct,
    };
    entrySignals.push(entrySignal);
  }

  const totalReturn = equity.minus(startEquity).dividedBy(startEquity).toNumber();
  const durationMs = candles[candles.length - 1].timestamp - candles[0].timestamp;
  const days = durationMs / (1000 * 60 * 60 * 24);
  const cagr = days > 0 ? (1 + totalReturn) ** (365 / days) - 1 : 0;

  const sortedTrades = tradeLogs.slice().sort((a, b) => a.timestamp - b.timestamp);
  const returns: number[] = [];
  let runningEquity = options.equityUsd;
  for (const trade of sortedTrades) {
    const pnl = trade.cumulativePnl.toNumber();
    const ret = runningEquity !== 0 ? pnl / runningEquity : 0;
    runningEquity += pnl;
    returns.push(ret);
  }

  const avgReturn = returns.length ? returns.reduce((acc, value) => acc + value, 0) / returns.length : 0;
  const variance = returns.length
    ? returns.reduce((acc, value) => acc + (value - avgReturn) ** 2, 0) / (returns.length || 1)
    : 0;
  const sharpe = variance > 0 ? (avgReturn / Math.sqrt(variance)) * Math.sqrt(252) : 0;

  let peakEquity = options.equityUsd;
  let maxDrawdown = 0;
  let equityPath = options.equityUsd;
  for (const trade of sortedTrades) {
    equityPath += trade.cumulativePnl.toNumber();
    if (equityPath > peakEquity) peakEquity = equityPath;
    const drawdown = peakEquity > 0 ? (peakEquity - equityPath) / peakEquity : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const wins = tradeLogs.filter((trade) => trade.cumulativePnl.raw > 0n).length;
  const losses = tradeLogs.filter((trade) => trade.cumulativePnl.raw < 0n).length;
  const hitRate = tradeLogs.length ? wins / tradeLogs.length : 0;
  const totalWin = tradeLogs
    .filter((trade) => trade.cumulativePnl.raw > 0n)
    .reduce((acc, trade) => acc + trade.cumulativePnl.toNumber(), 0);
  const totalLoss = tradeLogs
    .filter((trade) => trade.cumulativePnl.raw < 0n)
    .reduce((acc, trade) => acc + Math.abs(trade.cumulativePnl.toNumber()), 0);
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : 0;
  const avgWin = wins ? totalWin / wins : 0;
  const avgLoss = losses ? -(totalLoss / losses) : 0;

  if ([totalReturn, cagr, sharpe, maxDrawdown, hitRate, profitFactor, avgWin, avgLoss].some((value) => Number.isNaN(value))) {
    throw new Error('Meta-Adaptive backtest metrics contain NaN values');
  }

  const metrics: BacktestMetrics = {
    totalReturnPct: totalReturn * 100,
    cagr,
    sharpe,
    maxDrawdownPct: maxDrawdown * 100,
    hitRate,
    profitFactor,
    avgWin,
    avgLoss,
    pnlSeries,
  };

  return { metrics, trades: tradeLogs, signals: entrySignals };
}

function buildWalkForward(candles: Candle[], options: MetaAdaptiveBacktestOptions): { start: number; end: number; metrics: BacktestMetrics }[] {
  const groups = new Map<string, Candle[]>();
  for (const candle of candles) {
    const date = new Date(candle.timestamp);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(candle);
  }

  const segments = Array.from(groups.values()).filter((segment) => segment.length >= DEFAULT_MIN_HISTORY);
  segments.sort((a, b) => a[0].timestamp - b[0].timestamp);

  return segments.map((segment) => {
    const result = simulateSegment(segment, options);
    return {
      start: segment[0].timestamp,
      end: segment[segment.length - 1].timestamp,
      metrics: result.metrics,
    };
  });
}

export function buildMetaAdaptiveSyntheticCandles(opts?: { minutes?: number }): Candle[] {
  const candles: Candle[] = [];

  let price = 1_900;
  const minutes = Math.max(1, Math.floor(opts?.minutes ?? 60 * 24 * 10));
  for (let i = 0; i < minutes; i += 1) {
    const timestamp = 1_700_700_000_000 + i * 60_000;
    const drift = Math.sin(i / 96) * 0.18 + Math.sin(i * 0.37) * 0.04;
    price = Math.max(50, price * (1 + drift * 0.0015));
    const high = price * (1 + Math.abs(drift) * 0.012);
    const low = price * (1 - Math.abs(drift) * 0.014);
    const volume = 1_000_000 * (0.85 + 0.2 * (1 + Math.sin(i * 0.41)));
    candles.push({
      timestamp,
      open: price * (1 - drift * 0.0008),
      high,
      low,
      close: price,
      volume,
    });
  }

  const injectTrend = (start: number, length: number, pct: number, volumeBoost: number) => {
    if (start >= candles.length) return;
    let localPrice = candles[start]?.close ?? price;
    for (let i = start; i < Math.min(candles.length, start + length); i += 1) {
      localPrice *= 1 + pct / 100;
      candles[i].open = localPrice * 0.996;
      candles[i].close = localPrice;
      candles[i].high = localPrice * 1.012;
      candles[i].low = localPrice * 0.985;
      candles[i].volume *= volumeBoost;
    }
  };

  injectTrend(120, 140, 0.35, 2.8);
  injectTrend(340, 120, -0.28, 2.4);
  injectTrend(520, 160, 0.42, 2.6);
  injectTrend(760, 110, -0.32, 2.1);
  return candles;
}

export function runMetaAdaptiveBacktest(candles: Candle[], options: MetaAdaptiveBacktestOptions): BacktestResult {
  const overall = simulateSegment(candles, options);
  const walkForward = buildWalkForward(candles, options);
  return { ...overall, walkForward };
}
