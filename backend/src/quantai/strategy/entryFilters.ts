import { QuantAIEntryFilterConfig } from '../config.js';

export type EntryFacts = {
  price?: number;
  atr?: number;
  atrPct?: number;
  atrBaselinePct?: number;
  adx?: number;
  spreadBps?: number;
  dollarVolume?: number;
  rrToTp1?: number;
  modelConfidence?: number;
  notionalUsd?: number;
};

export type EntryEvaluation = {
  ok: boolean;
  reasons: Record<string, string>;
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
    } = {},
  ): EntryEvaluation {
    const reasons: Record<string, string> = {};
    let ok = true;

    const tier = opts.tier ?? null;
    const volatilityProfile = opts.volatilityProfile ? opts.volatilityProfile.toUpperCase() : null;
    const volatilityCandidates: string[] = [];

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
    if (adx == null || adx < minAdx) {
      ok = false;
      reasons.momentumOk = `FAIL (ADX=${adx ?? 'n/a'} < ${minAdx.toFixed(2)})`;
    } else {
      reasons.momentumOk = `OK (ADX=${adx.toFixed(2)} >= ${minAdx.toFixed(2)})`;
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
      let spreadReason = `OK (${spread.toFixed(2)}bps <= ${maxSpreadBps.toFixed(2)}bps)`;
      if (spread > maxSpreadBps) {
        ok = false;
        spreadReason = `FAIL (${spread.toFixed(2)}bps > ${maxSpreadBps.toFixed(2)}bps)`;
      }
      if (spreadAtrRatioLimit != null && spreadAtrRatioLimit > 0 && atrPct != null && atrPct > 0) {
        const spreadPct = spread / 100;
        const ratio = spreadPct / atrPct;
        const ratioPct = ratio * 100;
        const limitPct = spreadAtrRatioLimit * 100;
        if (ratio > spreadAtrRatioLimit) {
          ok = false;
          spreadReason = `FAIL (spread ${spreadPct.toFixed(3)}% = ${ratioPct.toFixed(1)}% of ATR, limit ${limitPct.toFixed(0)}%)`;
        } else if (!spreadReason.startsWith('FAIL')) {
          spreadReason = `OK (${spreadPct.toFixed(3)}% spread = ${ratioPct.toFixed(1)}% of ATR, limit ${limitPct.toFixed(0)}%)`;
        } else {
          spreadReason += ` | ratio ${ratioPct.toFixed(1)}% (limit ${limitPct.toFixed(0)}%)`;
        }
      }
      reasons.spreadOk = spreadReason;
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

    const rr = facts.rrToTp1;
    const rrThreshold = minRr ?? baseMinRr;
    const summarySuffix = opts.rrSummary ? ` | ${opts.rrSummary}` : '';
    if (rr != null && rrThreshold != null && rr < rrThreshold) {
      ok = false;
      reasons.profitOk = `FAIL (RR=${rr.toFixed(2)} < ${rrThreshold.toFixed(2)})${summarySuffix}`;
    } else {
      reasons.profitOk = summarySuffix ? `OK${summarySuffix}` : 'OK';
    }

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

    return { ok, reasons };
  }
}
