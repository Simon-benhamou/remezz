import { BrokerMarginSnapshot } from '../broker/types.js';

const EPSILON = 1e-9;

type MarginAdvisor = {
  utilisationPct(): number;
  utilisationPctIf(notionalUsd: number, leverage: number): number;
  marginCapacityUsd(): number;
  maxAdditionalNotionalAt(leverage: number): number;
  marginRequiredFor(notionalUsd: number, leverage: number): number;
  notionalToReduceTo(targetUtilPct: number, leverageHint?: number): number;
  equityUsd(): number;
  committedUsd(): number;
};

function normalizeNumber(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return num;
}

export function createMarginAdvisor(snapshot: BrokerMarginSnapshot): MarginAdvisor {
  const equity = Math.max(0, normalizeNumber(snapshot?.equityUsd));
  const committed = Math.max(0, normalizeNumber(snapshot?.committedUsd));

  const marginRequiredFor = (notionalUsd: number, leverage: number): number => {
    const lev = Math.max(1, Number.isFinite(leverage) && leverage > 0 ? leverage : 1);
    const notional = Math.max(0, Number(isFinite(notionalUsd) ? notionalUsd : 0));
    return notional / lev;
  };

  const utilisationPct = (): number => {
    if (equity <= EPSILON) {
      return committed > EPSILON ? 100 : 0;
    }
    return (committed / equity) * 100;
  };

  const utilisationPctIf = (notionalUsd: number, leverage: number): number => {
    const requiredMargin = marginRequiredFor(notionalUsd, leverage);
    const nextCommitted = committed + requiredMargin;
    if (equity <= EPSILON) {
      return nextCommitted > EPSILON ? 100 : 0;
    }
    return (nextCommitted / equity) * 100;
  };

  const marginCapacityUsd = (): number => {
    if (equity <= EPSILON) return 0;
    return Math.max(0, equity - committed);
  };

  const maxAdditionalNotionalAt = (leverage: number): number => {
    const availableMargin = marginCapacityUsd();
    if (availableMargin <= EPSILON) return 0;
    const lev = Math.max(1, Number.isFinite(leverage) && leverage > 0 ? leverage : 1);
    return availableMargin * lev;
  };

  const notionalToReduceTo = (targetUtilPct: number, leverageHint?: number): number => {
    if (equity <= EPSILON) return 0;
    const targetPct = Math.max(0, targetUtilPct);
    const targetMargin = (targetPct / 100) * equity;
    if (committed <= targetMargin + EPSILON) return 0;
    const excessMargin = committed - targetMargin;
    const lev = Math.max(1, Number.isFinite(leverageHint) && (leverageHint ?? 0) > 0 ? leverageHint! : 1);
    return excessMargin * lev;
  };

  return {
    utilisationPct,
    utilisationPctIf,
    marginCapacityUsd,
    maxAdditionalNotionalAt,
    marginRequiredFor,
    notionalToReduceTo,
    equityUsd: () => equity,
    committedUsd: () => committed,
  };
}

export type { MarginAdvisor };
