import { QuantAIEntryFilterConfig } from '../config.js';

export type EntryFacts = {
  price?: number;
  atr?: number;
  adx?: number;
  spreadBps?: number;
  dollarVolume?: number;
  rrToTp1?: number;
  modelConfidence?: number;
};

export type EntryEvaluation = {
  ok: boolean;
  reasons: Record<string, string>;
};

export class EntryFilters {
  constructor(private readonly cfg: QuantAIEntryFilterConfig) {}

  evaluateEntry(facts: EntryFacts): EntryEvaluation {
    const reasons: Record<string, string> = {};
    let ok = true;

    const adx = facts.adx;
    if (adx == null || adx < this.cfg.minAdx) {
      ok = false;
      reasons.momentumOk = `FAIL (ADX=${adx ?? 'n/a'})`;
    } else {
      reasons.momentumOk = `OK (ADX=${adx})`;
    }

    const atr = facts.atr;
    const price = facts.price;
    if (atr != null && price != null && price > 0) {
      const atrPct = (atr / price) * 100;
      if (atrPct < this.cfg.minAtrPct) {
        ok = false;
        reasons.volatilityOk = `FAIL (ATR%=${atrPct.toFixed(2)} < ${this.cfg.minAtrPct})`;
      } else {
        reasons.volatilityOk = `OK (ATR%=${atrPct.toFixed(2)})`;
      }
    } else {
      reasons.volatilityOk = 'UNKNOWN';
    }

    const spread = facts.spreadBps;
    if (spread != null && spread > this.cfg.maxSpreadBps) {
      ok = false;
      reasons.spreadOk = `FAIL (${spread}bps > ${this.cfg.maxSpreadBps})`;
    } else {
      reasons.spreadOk = 'OK';
    }

    const dv = facts.dollarVolume;
    if (dv != null && dv < this.cfg.minDollarVolume) {
      ok = false;
      reasons.volumeOk = `FAIL ($${dv.toFixed(0)} < ${this.cfg.minDollarVolume})`;
    } else {
      reasons.volumeOk = 'OK';
    }

    const rr = facts.rrToTp1;
    if (rr != null && rr < this.cfg.minRr) {
      ok = false;
      reasons.profitOk = `FAIL (RR=${rr.toFixed(2)} < ${this.cfg.minRr})`;
    } else {
      reasons.profitOk = 'OK';
    }

    if (this.cfg.useConfidenceFilter) {
      const confidence = facts.modelConfidence;
      if (confidence != null && confidence < this.cfg.confidenceThreshold) {
        ok = false;
        reasons.confidenceOk = `FAIL (p=${confidence.toFixed(2)} < ${this.cfg.confidenceThreshold})`;
      } else {
        reasons.confidenceOk = 'OK';
      }
    }

    reasons.summary = ok ? 'OK' : 'BLOCKED';

    return { ok, reasons };
  }
}
