import { QuantAIEntryFilterConfig } from '../../config.js';

export type EntryFacts = {
  price?: number;
  atr?: number;
  atrPct?: number;
  atrBaselinePct?: number;
  adx?: number;
  rsi?: number;
  spreadBps?: number;
  dollarVolume?: number;
  rrToTp1?: number;
  rrWeighted?: number;
  tpWeightedPct?: number;
  stopDistance?: number;
  qualityPassHint?: boolean;
  volumeRatio?: number;
  modelConfidence?: number;
  notionalUsd?: number;
  slopeDirectionalPct?: number;
  slopeAbsPct?: number;
  cmf?: number;
  adxSlope?: number;
  diPlus?: number;
  diMinus?: number;
};

export type EntryEvaluation = {
  ok: boolean;
  reasons: Record<string, string>;
  modifiers?: { sizeMultiplier?: number };
  meta?: {
    minRrUsed?: number | null;
    baseMinRr?: number | null;
    rrEffective?: number | null;
    rrToTp1?: number | null;
    strongFlow?: boolean;
    rrNearThreshold?: boolean;
    fastTrackApplied?: boolean;
    nearFactor?: number | null;
    qualityHint?: boolean | null;
    spread?: {
      spreadBps?: number | null;
      maxSpreadBps?: number | null;
      spreadAtrRatio?: number | null;
      spreadAtrRatioLimit?: number | null;
      absFail: boolean;
      relFail: boolean;
      penaltyApplied?: number | null;
    };
    minRrFloor?: number | null;
    flowSlope?: number | null;
    flowCmf?: number | null;
    adxSlope?: number | null;
    directionalDelta?: number | null;
    directionalBias?: 'long' | 'short' | 'none' | null;
    rsi?: number | null;
  };
};

export type EntryRelaxation = {
  minAdxDelta?: number;
  minRrDelta?: number;
  confidenceDelta?: number;
  minAtrPctDelta?: number;
};

export class EntryFilters {
  constructor(private readonly cfg: QuantAIEntryFilterConfig) {}

  evaluateEntry(
    facts: EntryFacts,
    opts: {
      minRr?: number | null;
      rrSummary?: string;
      tier?: string | null;
      symbol?: string | null;
      aggressiveness?: string | null;
      atrBaselinePct?: number | null;
      volatilityProfile?: string | null;
      relaxation?: EntryRelaxation | null;
      bias?: 'long' | 'short' | 'none' | null;
    } = {},
  ): EntryEvaluation {
    const reasons: Record<string, string> = {};
    const modifiers: { sizeMultiplier?: number } = {};
    const meta: EntryEvaluation['meta'] = {};
    let ok = true;

    const bias = opts.bias ?? null;
    const tier = opts.tier ?? null;
    const volatilityProfile = opts.volatilityProfile ? opts.volatilityProfile.toUpperCase() : null;
    const volatilityCandidates: string[] = [];

    const rsiVal = typeof facts.rsi === 'number' && Number.isFinite(facts.rsi) ? facts.rsi : undefined;
    const diPlusVal = typeof facts.diPlus === 'number' && Number.isFinite(facts.diPlus) ? facts.diPlus : undefined;
    const diMinusVal = typeof facts.diMinus === 'number' && Number.isFinite(facts.diMinus) ? facts.diMinus : undefined;
    const directionalCfg = this.cfg.dynamic?.directionalFilter;

    const baseMinRr = opts.minRr ?? this.cfg.minRr;
    let minAdx = this.cfg.minAdx;
    let minDollarVolume = this.cfg.minDollarVolume;
    let minRr = baseMinRr;
    let minAtrPct = this.cfg.minAtrPct;
    let maxSpreadBps = this.cfg.maxSpreadBps;
    let confidenceThreshold = this.cfg.confidenceThreshold;
    let useConfidenceFilter = this.cfg.useConfidenceFilter;
    let maxAtrPct = this.cfg.maxAtrPct ?? Number.POSITIVE_INFINITY;
    let spreadAtrRatioLimit = this.cfg.dynamic?.spreadAtrRatioLimit;
    const relaxation = opts.relaxation ?? null;
    let deferredMinAdxDelta: number | null = null;

    const tierOverride = tier ? this.cfg.tierOverrides?.[tier] : undefined;
    if (tierOverride) {
      if (tierOverride.minAdx != null) minAdx = tierOverride.minAdx;
      if (tierOverride.minDollarVolume != null) minDollarVolume = tierOverride.minDollarVolume;
      if (tierOverride.minRr != null) minRr = Math.max(minRr ?? tierOverride.minRr, tierOverride.minRr);
      if (tierOverride.minAtrPct != null) minAtrPct = tierOverride.minAtrPct;
      if (tierOverride.maxSpreadBps != null) maxSpreadBps = tierOverride.maxSpreadBps;
      if (tierOverride.confidenceThreshold != null) confidenceThreshold = tierOverride.confidenceThreshold;
      if (tierOverride.useConfidenceFilter != null) useConfidenceFilter = tierOverride.useConfidenceFilter;
      if (tierOverride.maxAtrPct != null) maxAtrPct = Math.min(maxAtrPct, tierOverride.maxAtrPct);
      if (tierOverride.minRrDelta != null && minRr != null) {
        minRr = Math.max(minRr, baseMinRr + tierOverride.minRrDelta);
      }
      if (tierOverride.confidenceThresholdDelta != null) {
        confidenceThreshold = Math.max(
          confidenceThreshold,
          this.cfg.confidenceThreshold + tierOverride.confidenceThresholdDelta,
        );
      }
      if (tierOverride.minAtrPctMultiplier != null) {
        const baseline = facts.atrBaselinePct ?? opts.atrBaselinePct ?? null;
        if (baseline != null && baseline > 0) {
          minAtrPct = Math.max(minAtrPct, baseline * tierOverride.minAtrPctMultiplier);
        }
      }
      if (tierOverride.spreadAtrRatioLimit != null) {
        spreadAtrRatioLimit = tierOverride.spreadAtrRatioLimit;
      }
    }

    let profileOverride;
    if (volatilityProfile) {
      const candidates = new Set<string>([volatilityProfile]);
      if (volatilityProfile.endsWith('_VOLATILITY')) {
        candidates.add(volatilityProfile.replace(/_VOLATILITY$/, ''));
      } else {
        candidates.add(`${volatilityProfile}_VOLATILITY`);
      }
      const candidateList = Array.from(candidates);
      volatilityCandidates.push(...candidateList);
      for (const key of candidateList) {
        const override = this.cfg.volatilityProfileOverrides?.[key];
        if (override) {
          profileOverride = override;
          break;
        }
      }
    }

    if (profileOverride) {
      if (profileOverride.minDollarVolume != null) {
        minDollarVolume = profileOverride.minDollarVolume;
      }
      if (profileOverride.minAtrPct != null) {
        minAtrPct = profileOverride.minAtrPct;
      }
      if (profileOverride.maxAtrPct != null) {
        maxAtrPct = Math.min(maxAtrPct, profileOverride.maxAtrPct);
      }
      if (profileOverride.minAdx != null) {
        minAdx = Math.max(0, profileOverride.minAdx);
      }
      if (profileOverride.spreadAtrRatioLimit != null) {
        spreadAtrRatioLimit = profileOverride.spreadAtrRatioLimit;
      }
    }

    const symbol = opts.symbol ? opts.symbol.toUpperCase() : null;
    const baseSymbol = symbol ? symbol.split(/[/:]/)[0] : null;
    const symbolOverride = baseSymbol
      ? this.cfg.symbolOverrides?.[baseSymbol] ?? (symbol ? this.cfg.symbolOverrides?.[symbol] : undefined)
      : symbol
        ? this.cfg.symbolOverrides?.[symbol]
        : undefined;

    if (symbolOverride) {
      if (symbolOverride.minAdx != null) {
        minAdx = symbolOverride.minAdx;
      }
      if (symbolOverride.minDollarVolume != null) {
        minDollarVolume = symbolOverride.minDollarVolume;
      }
      if (symbolOverride.minRr != null) {
        minRr = Math.max(minRr ?? symbolOverride.minRr, symbolOverride.minRr);
      }
      if (symbolOverride.minAtrPct != null) {
        minAtrPct = symbolOverride.minAtrPct;
      }
      if (symbolOverride.maxSpreadBps != null) {
        maxSpreadBps = symbolOverride.maxSpreadBps;
      }
      if (symbolOverride.confidenceThreshold != null) {
        confidenceThreshold = symbolOverride.confidenceThreshold;
      }
      if (symbolOverride.useConfidenceFilter != null) {
        useConfidenceFilter = symbolOverride.useConfidenceFilter;
      }
      if (symbolOverride.maxAtrPct != null) {
        maxAtrPct = Math.min(maxAtrPct, symbolOverride.maxAtrPct);
      }
      if (symbolOverride.spreadAtrRatioLimit != null) {
        spreadAtrRatioLimit = symbolOverride.spreadAtrRatioLimit;
      }
    }

    if (
      symbolOverride?.volatilityProfileOverrides &&
      volatilityCandidates.length > 0
    ) {
      for (const key of volatilityCandidates) {
        const override = symbolOverride.volatilityProfileOverrides[key];
        if (!override) continue;
        if (override.minDollarVolume != null) {
          minDollarVolume = override.minDollarVolume;
        }
        if (override.minAtrPct != null) {
          minAtrPct = override.minAtrPct;
        }
        if (override.maxAtrPct != null) {
          maxAtrPct = Math.min(maxAtrPct, override.maxAtrPct);
        }
        if (override.minAdx != null) {
          minAdx = Math.max(0, override.minAdx);
        }
        if (override.spreadAtrRatioLimit != null) {
          spreadAtrRatioLimit = override.spreadAtrRatioLimit;
        }
        break;
      }
    }

    const aggressiveness = opts.aggressiveness ?? null;
    if (aggressiveness && this.cfg.dynamic?.aggressivenessAdjustments) {
      const adj = this.cfg.dynamic.aggressivenessAdjustments[aggressiveness];
      if (adj) {
        if (adj.minRrDelta != null && minRr != null) {
          minRr = Math.max(0, minRr + adj.minRrDelta);
        }
        if (adj.minAdxDelta != null) {
          minAdx = Math.max(0, minAdx + adj.minAdxDelta);
        }
        if (adj.confidenceDelta != null) {
          confidenceThreshold = Math.max(0, confidenceThreshold + adj.confidenceDelta);
        }
        if (adj.minAtrPctDelta != null) {
          minAtrPct = Math.max(0, minAtrPct + adj.minAtrPctDelta);
        }
      }
    }

    if (relaxation) {
      const relaxationNotes: string[] = [];
      if (relaxation.minAdxDelta != null && relaxation.minAdxDelta !== 0) {
        deferredMinAdxDelta = (deferredMinAdxDelta ?? 0) + relaxation.minAdxDelta;
        relaxationNotes.push(`minAdx${relaxation.minAdxDelta >= 0 ? '+' : ''}${relaxation.minAdxDelta.toFixed(2)}`);
      }
      if (relaxation.minRrDelta != null && relaxation.minRrDelta !== 0) {
        if (minRr != null) {
          minRr = Math.max(0, minRr + relaxation.minRrDelta);
        } else if (baseMinRr != null) {
          minRr = Math.max(0, baseMinRr + relaxation.minRrDelta);
        }
        relaxationNotes.push(`minRr${relaxation.minRrDelta >= 0 ? '+' : ''}${relaxation.minRrDelta.toFixed(2)}`);
      }
      if (relaxation.confidenceDelta != null && relaxation.confidenceDelta !== 0) {
        confidenceThreshold = Math.max(0, confidenceThreshold + relaxation.confidenceDelta);
        relaxationNotes.push(`confidence${relaxation.confidenceDelta >= 0 ? '+' : ''}${relaxation.confidenceDelta.toFixed(2)}`);
      }
      if (relaxation.minAtrPctDelta != null && relaxation.minAtrPctDelta !== 0) {
        minAtrPct = Math.max(0, minAtrPct + relaxation.minAtrPctDelta);
        relaxationNotes.push(`minAtrPct${relaxation.minAtrPctDelta >= 0 ? '+' : ''}${relaxation.minAtrPctDelta.toFixed(2)}`);
      }
      if (relaxationNotes.length > 0) {
        reasons.relaxation = `APPLIED (${relaxationNotes.join(', ')})`;
      }
    }

    const atrBaseline = facts.atrBaselinePct ?? opts.atrBaselinePct ?? null;
    if (atrBaseline != null && atrBaseline > 0 && this.cfg.dynamic?.baselineAtrMultiplier != null) {
      minAtrPct = Math.max(
        minAtrPct,
        atrBaseline * this.cfg.dynamic.baselineAtrMultiplier,
      );
    }

    const atr = facts.atr;
    const price = facts.price;
    const atrPct = facts.atrPct != null
      ? facts.atrPct
      : atr != null && price != null && price > 0
        ? (atr / price) * 100
        : undefined;

    if (atrPct != null) {
      if (
        this.cfg.dynamic?.atrHighVolThresholdPct != null &&
        atrPct >= this.cfg.dynamic.atrHighVolThresholdPct
      ) {
        if (this.cfg.dynamic.atrHighVolMinAdx != null) {
          minAdx = Math.max(minAdx, this.cfg.dynamic.atrHighVolMinAdx);
        }
      }
      if (
        this.cfg.dynamic?.atrExtremeVolThresholdPct != null &&
        atrPct >= this.cfg.dynamic.atrExtremeVolThresholdPct
      ) {
        if (this.cfg.dynamic.atrExtremeVolMinAdx != null) {
          minAdx = Math.max(minAdx, this.cfg.dynamic.atrExtremeVolMinAdx);
        }
        if (this.cfg.dynamic.atrExtremeVolMinRr != null && minRr != null) {
          minRr = Math.max(minRr, this.cfg.dynamic.atrExtremeVolMinRr);
        }
      }

      if (this.cfg.dynamic?.atrMaxPct != null) {
        maxAtrPct = Math.min(maxAtrPct, this.cfg.dynamic.atrMaxPct);
      }
      const tierMax = tier ? this.cfg.dynamic?.atrMaxPctByTier?.[tier] : undefined;
      if (typeof tierMax === 'number') {
        maxAtrPct = Math.min(maxAtrPct, tierMax);
      }
    }

    if (tier && this.cfg.dynamic?.rrTierAdjustments?.[tier] != null && minRr != null) {
      minRr = Math.max(minRr, baseMinRr + this.cfg.dynamic.rrTierAdjustments[tier]!);
    }
    if (tier && this.cfg.dynamic?.confidenceTierAdjustments?.[tier] != null) {
      confidenceThreshold = Math.max(
        confidenceThreshold,
        this.cfg.confidenceThreshold + this.cfg.dynamic.confidenceTierAdjustments[tier]!,
      );
    }

    if (deferredMinAdxDelta != null && deferredMinAdxDelta !== 0) {
      minAdx = Math.max(0, minAdx + deferredMinAdxDelta);
    }

    const adx = facts.adx;
    const volumeRatioVal = typeof facts.volumeRatio === 'number' && Number.isFinite(facts.volumeRatio)
      ? facts.volumeRatio
      : undefined;
    const slopeDirectional = typeof facts.slopeDirectionalPct === 'number' && Number.isFinite(facts.slopeDirectionalPct)
      ? facts.slopeDirectionalPct
      : undefined;
    const adxSlopeVal = typeof facts.adxSlope === 'number' && Number.isFinite(facts.adxSlope)
      ? facts.adxSlope
      : undefined;
    const cmfVal = typeof facts.cmf === 'number' && Number.isFinite(facts.cmf) ? facts.cmf : undefined;
    if (adx == null || adx < minAdx) {
      ok = false;
      reasons.momentumOk = `FAIL (ADX=${adx ?? 'n/a'} < ${minAdx.toFixed(2)})`;
    } else {
      reasons.momentumOk = `OK (ADX=${adx.toFixed(2)} >= ${minAdx.toFixed(2)})`;
    }

    if ((directionalCfg?.enabled ?? true) && bias && bias !== 'none') {
      const delta = diPlusVal != null && diMinusVal != null
        ? (bias === 'long' ? diPlusVal - diMinusVal : diMinusVal - diPlusVal)
        : null;
      const adxVal = typeof adx === 'number' && Number.isFinite(adx) ? adx : null;
      const trendAdx = directionalCfg?.trendAdx ?? Math.max(minAdx, 20);
      const rangeAdx = directionalCfg?.rangeAdx ?? Math.max(12, Math.min(minAdx, 18));
      const inRangeRegime = adxVal != null && adxVal <= rangeAdx;
      const strongTrend = adxVal != null && adxVal >= trendAdx;
      const minTrendDelta = directionalCfg?.minDiTrend ?? 3;
      const minRangeDelta = directionalCfg?.minDiRange ?? 1.5;
      const strongTrendDelta = directionalCfg?.minDiStrong ?? (minTrendDelta + 1);
      const baseMinDelta = strongTrend ? strongTrendDelta : inRangeRegime ? minRangeDelta : minTrendDelta;
      const minDeltaFloor = 0.75;

      let minDelta = baseMinDelta;
      if (adxSlopeVal != null) {
        const slopeClamp = Math.max(-1.5, Math.min(1.5, adxSlopeVal));
        const slopeAdjustment = slopeClamp * 0.45;
        minDelta -= slopeAdjustment;
      }

      if (atrPct != null) {
        const atrReference = atrBaseline ?? opts.atrBaselinePct ?? 0.35;
        if (atrReference > 0) {
          const atrRatio = Math.max(0, Math.min(2.5, atrPct / atrReference));
          if (atrRatio >= 1) {
            const atrAdjustment = Math.min(0.9, (atrRatio - 1) * 0.6);
            minDelta -= atrAdjustment;
          }
        }
      }

      if (minDelta < minDeltaFloor) {
        minDelta = minDeltaFloor;
      }
      const adaptiveDeltaOffset = minDelta - baseMinDelta;
      const nearNeutralBand = directionalCfg?.rangeNeutralBand ?? 9;
      const minRsiTrend = directionalCfg?.minRsiTrend ?? 54;
      const maxRsiTrend = directionalCfg?.maxRsiTrend ?? (100 - minRsiTrend);

      let directionalPass = true;
      const detail: string[] = [];

      if (delta != null) {
        detail.push(`ΔDI=${delta.toFixed(2)}>=${minDelta.toFixed(2)}`);
        if (Math.abs(adaptiveDeltaOffset) > 1e-6) {
          detail.push(`adaptiveΔ=${adaptiveDeltaOffset >= 0 ? '+' : ''}${adaptiveDeltaOffset.toFixed(2)}`);
        }
        if (delta < minDelta) directionalPass = false;
      } else if (directionalCfg?.requireDiSignal !== false) {
        directionalPass = false;
        detail.push('ΔDI=missing');
      } else {
        detail.push('ΔDI=n/a');
      }

      if (directionalPass && rsiVal != null) {
        if (inRangeRegime) {
          const deviation = Math.abs(rsiVal - 50);
          detail.push(`|RSI-50|=${deviation.toFixed(1)}<=${nearNeutralBand.toFixed(1)}`);
          if (deviation > nearNeutralBand) directionalPass = false;
        } else if (bias === 'long') {
          detail.push(`RSI=${rsiVal.toFixed(1)}>=${minRsiTrend.toFixed(1)}`);
          if (rsiVal < minRsiTrend) directionalPass = false;
        } else {
          detail.push(`RSI=${rsiVal.toFixed(1)}<=${maxRsiTrend.toFixed(1)}`);
          if (rsiVal > maxRsiTrend) directionalPass = false;
        }
      } else if (rsiVal == null) {
        detail.push('RSI=n/a');
      }

      meta.directionalDelta = delta ?? null;
      meta.directionalBias = bias;
      meta.rsi = rsiVal ?? null;

      if (!directionalPass) {
        ok = false;
        reasons.directionalOk = `FAIL (${detail.join(', ')})`;
      } else {
        reasons.directionalOk = `OK (${detail.join(', ')})`;
      }
    } else {
      if (bias && bias !== 'none') {
        meta.directionalBias = bias;
      } else {
        meta.directionalBias = bias ?? null;
      }
      meta.directionalDelta = diPlusVal != null && diMinusVal != null ? diPlusVal - diMinusVal : null;
      meta.rsi = rsiVal ?? null;
      reasons.directionalOk = directionalCfg?.enabled === false ? 'DISABLED' : 'SKIP';
    }

    if (atrPct != null) {
      const atrReason: string[] = [];
      atrReason.push(`ATR%=${atrPct.toFixed(2)}`);
      atrReason.push(`min>=${minAtrPct.toFixed(2)}`);
      if (maxAtrPct != null && Number.isFinite(maxAtrPct)) {
        atrReason.push(`max<=${maxAtrPct.toFixed(2)}`);
      }
      if (atrPct < minAtrPct) {
        ok = false;
        reasons.volatilityOk = `FAIL (${atrReason.join(', ')} | below minimum)`;
      } else if (maxAtrPct != null && Number.isFinite(maxAtrPct) && atrPct > maxAtrPct) {
        ok = false;
        reasons.volatilityOk = `FAIL (${atrReason.join(', ')} | above maximum)`;
      } else {
        reasons.volatilityOk = `OK (${atrReason.join(', ')})`;
      }
    } else {
      reasons.volatilityOk = 'UNKNOWN';
    }

    const spread = facts.spreadBps;
    if (spread != null) {
      const spreadPct = spread / 100;
      const absFail = spread > maxSpreadBps;
      let spreadRatio: number | null = null;
      let relFail = false;
      if (spreadAtrRatioLimit != null && spreadAtrRatioLimit > 0 && atrPct != null && atrPct > 0) {
        spreadRatio = spreadPct / atrPct;
        relFail = spreadRatio > spreadAtrRatioLimit;
      }
      const ratioPct = spreadRatio != null ? spreadRatio * 100 : null;
      const limitPct = spreadAtrRatioLimit != null ? spreadAtrRatioLimit * 100 : null;
      const absComparator = absFail ? '>' : '<=';
      const absText = `${spread.toFixed(2)}bps${absComparator}${maxSpreadBps.toFixed(2)}bps`;
      const ratioText = ratioPct != null && limitPct != null
        ? `ratio=${ratioPct.toFixed(1)}% (limit ${limitPct.toFixed(0)}%)`
        : ratioPct != null
          ? `ratio=${ratioPct.toFixed(1)}%`
          : undefined;
      let spreadStatus: 'OK' | 'WARN' | 'FAIL' = 'OK';
      if (relFail) {
        spreadStatus = 'FAIL';
        ok = false;
      } else if (absFail) {
        spreadStatus = 'WARN';
      }
      const spreadParts = [absText];
      if (ratioText) spreadParts.push(ratioText);
      reasons.spreadOk = `${spreadStatus} (${spreadParts.join(', ')})`;
      let penaltyApplied: number | null = null;
      if (absFail && !relFail && spreadStatus !== 'FAIL') {
        const configuredPenalty = this.cfg.dynamic?.spreadSoftPenalty;
        const penalty = Number.isFinite(configuredPenalty)
          ? Math.max(0.5, Math.min(1, configuredPenalty!))
          : 0.85;
        modifiers.sizeMultiplier = penalty;
        penaltyApplied = penalty;
      }
      meta.spread = {
        spreadBps: spread,
        maxSpreadBps,
        spreadAtrRatio: spreadRatio,
        spreadAtrRatioLimit,
        absFail,
        relFail,
        penaltyApplied,
      };
    } else {
      reasons.spreadOk = 'UNKNOWN';
    }

    const dv = facts.dollarVolume;
    if (dv != null && dv < minDollarVolume) {
      ok = false;
      reasons.volumeOk = `FAIL ($${dv.toFixed(0)} < ${minDollarVolume})`;
    } else {
      reasons.volumeOk = dv != null
        ? `OK ($${dv.toFixed(0)} >= ${minDollarVolume})`
        : 'UNKNOWN';
    }

    const clampNearFactor = (value: number) => Math.max(0.5, Math.min(0.99, value));
    const fastTrackCfg = this.cfg.dynamic?.momentumFastTrack;
    const fastTrackEnabled = fastTrackCfg?.enabled !== false;
    let nearFactor = 0.9;
    if (this.cfg.dynamic?.rrNearThresholdFactor != null && Number.isFinite(this.cfg.dynamic.rrNearThresholdFactor)) {
      nearFactor = clampNearFactor(this.cfg.dynamic.rrNearThresholdFactor!);
    }
    if (fastTrackCfg?.nearThresholdFactor != null && Number.isFinite(fastTrackCfg.nearThresholdFactor)) {
      nearFactor = clampNearFactor(fastTrackCfg.nearThresholdFactor);
    }
    const rrTp1 = typeof facts.rrToTp1 === 'number' && Number.isFinite(facts.rrToTp1) ? facts.rrToTp1 : undefined;
    const rrWeighted = typeof facts.rrWeighted === 'number' && Number.isFinite(facts.rrWeighted) ? facts.rrWeighted : undefined;
    const rrEff = rrWeighted ?? rrTp1;
    const baseRrThreshold = minRr ?? baseMinRr;
    let rrThreshold = baseRrThreshold;
    const qualityHint = facts.qualityPassHint === undefined ? undefined : Boolean(facts.qualityPassHint);
    const adxVal = adx;
    const slopeRequirement = fastTrackCfg?.minSlopePct ?? 0.2;
    const cmfRequirement = fastTrackCfg?.minCmf ?? 0;
    const slopePass = slopeDirectional != null && slopeDirectional >= slopeRequirement;
    const cmfPass = cmfVal == null ? true : cmfVal >= cmfRequirement;
    const strongFlow = fastTrackEnabled
      && adxVal != null && adxVal >= (fastTrackCfg?.minAdx ?? 35)
      && volumeRatioVal != null && volumeRatioVal >= (fastTrackCfg?.minVolumeRatio ?? 1.2)
      && slopePass
      && cmfPass;
    const minWeightedRr = fastTrackCfg?.minWeightedRr ?? 0.9;
    const rrForFastTrack = rrWeighted ?? rrTp1;
    const rrFloor = fastTrackCfg?.rrFloor ?? 1.0;
    let fastTrackApplied = false;
    if (strongFlow && rrThreshold != null && rrForFastTrack != null && rrForFastTrack >= minWeightedRr) {
      const fastTrackMin = Math.max(rrFloor, fastTrackCfg?.minRr ?? rrFloor);
      const adjusted = Math.min(rrThreshold, fastTrackMin);
      fastTrackApplied = baseRrThreshold != null ? adjusted < baseRrThreshold : adjusted < rrThreshold;
      rrThreshold = adjusted;
    }
    if (rrThreshold != null) {
      rrThreshold = Math.max(rrThreshold, rrFloor);
    }
    const rrNearThreshold = rrThreshold != null ? rrThreshold * nearFactor : null;
    const rrUsed = rrEff;
    const near = rrUsed != null && rrNearThreshold != null ? rrUsed >= rrNearThreshold : false;
    let profitPass = true;
    let softPass = false;
    if (rrUsed != null && rrThreshold != null && rrUsed < rrThreshold) {
      if (near && qualityHint === true) {
        softPass = true;
      } else {
        profitPass = false;
        ok = false;
      }
    }
    const rrDetailParts: string[] = [];
    if (rrUsed != null && rrThreshold != null) {
      const comparator = rrUsed >= rrThreshold ? '>=' : '<';
      rrDetailParts.push(`RR_eff=${rrUsed.toFixed(2)} ${comparator} ${rrThreshold.toFixed(2)}`);
    } else if (rrUsed != null) {
      rrDetailParts.push(`RR_eff=${rrUsed.toFixed(2)}`);
    }
    if (rrTp1 != null && (rrWeighted == null || Math.abs(rrTp1 - (rrUsed ?? rrTp1)) > 1e-3)) {
      rrDetailParts.push(`RR_TP1=${rrTp1.toFixed(2)}`);
    }
    if (typeof facts.tpWeightedPct === 'number' && Number.isFinite(facts.tpWeightedPct)) {
      rrDetailParts.push(`TPw%=${facts.tpWeightedPct.toFixed(2)}%`);
    }
    if (rrThreshold != null) rrDetailParts.push(`min>=${rrThreshold.toFixed(2)}`);
    if (rrFloor != null) rrDetailParts.push(`floor=${rrFloor.toFixed(2)}`);
    rrDetailParts.push(`strongFlow=${strongFlow ? 'yes' : 'no'}`);
    if (fastTrackApplied) rrDetailParts.push('fastTrack');
    if (near && rrThreshold != null) rrDetailParts.push(`near>=${(nearFactor * 100).toFixed(0)}%`);
    if (qualityHint === true) rrDetailParts.push('quality=pass');
    else if (qualityHint === false) rrDetailParts.push('quality=fail');
    const rrDetail = rrDetailParts.join(', ');
    const summarySegments: string[] = [];
    if (rrDetail) summarySegments.push(rrDetail);
    if (opts.rrSummary) summarySegments.push(opts.rrSummary);
    const summarySuffix = summarySegments.length ? ` | ${summarySegments.join(' | ')}` : '';
    if (rrUsed != null && rrThreshold != null) {
      if (!profitPass) {
        reasons.profitOk = `FAIL${summarySuffix}`;
      } else if (softPass) {
        reasons.profitOk = `SOFT_PASS${summarySuffix}`;
      } else {
        reasons.profitOk = `OK${summarySuffix}`;
      }
    } else {
      reasons.profitOk = summarySuffix ? `OK${summarySuffix}` : 'OK';
    }
    meta.minRrUsed = rrThreshold ?? null;
    meta.baseMinRr = baseRrThreshold ?? null;
    meta.rrEffective = rrUsed ?? null;
    meta.rrToTp1 = rrTp1 ?? null;
    meta.strongFlow = strongFlow;
    meta.rrNearThreshold = near;
    meta.fastTrackApplied = fastTrackApplied;
    meta.nearFactor = nearFactor;
    meta.qualityHint = qualityHint ?? null;
    meta.minRrFloor = rrFloor;
    meta.flowSlope = slopeDirectional ?? null;
    meta.flowCmf = cmfVal ?? null;
    meta.adxSlope = adxSlopeVal ?? null;

    if (useConfidenceFilter) {
      const confidence = facts.modelConfidence;
      if (confidence != null && confidence < confidenceThreshold) {
        ok = false;
        reasons.confidenceOk = `FAIL (p=${confidence.toFixed(2)} < ${confidenceThreshold.toFixed(2)})`;
      } else {
        reasons.confidenceOk = confidence != null
          ? `OK (p=${confidence.toFixed(2)} >= ${confidenceThreshold.toFixed(2)})`
          : 'UNKNOWN';
      }
    } else {
      reasons.confidenceOk = 'DISABLED';
    }

    reasons.summary = ok ? 'OK' : 'BLOCKED';

    return {
      ok,
      reasons,
      modifiers: Object.keys(modifiers).length ? modifiers : undefined,
      meta,
    };
  }
}
