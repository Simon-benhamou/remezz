import { BrokerMarginSnapshot, BrokerPositionMargin, BrokerCorrelatedExposure } from '../broker/types.js';

export type MarginGuardThresholds = {
  utilisationWarnPct: number;
  utilisationCriticalPct: number;
  minLiquidationDistancePct: number;
  concentrationWarnPct: number;
};

export type MarginGuardSeverity = 'ok' | 'warn' | 'critical';

export type MarginGuardBreach = {
  kind: 'utilisation' | 'liquidation' | 'concentration';
  severity: Exclude<MarginGuardSeverity, 'ok'>;
  detail: string;
  value?: number;
  reference?: string;
};

export type MarginGuardAction = {
  label: string;
  severity: MarginGuardSeverity;
  rationale: string;
  relatedSymbols?: string[];
};

export type MarginGuardResult = {
  status: MarginGuardSeverity;
  utilisationPct: number;
  marginRatio?: number;
  maintenanceMarginUsd?: number;
  worstLiquidationDistancePct?: number;
  liquidationDistances: Array<{
    symbol: string;
    side: 'long' | 'short';
    distancePct?: number;
    liquidationPrice?: number;
    markPrice?: number;
  }>;
  concentration: Array<BrokerCorrelatedExposure & { concentrationPct?: number }>;
  breaches: MarginGuardBreach[];
  actions: MarginGuardAction[];
};

export const defaultMarginGuardThresholds: MarginGuardThresholds = {
  utilisationWarnPct: 55,
  utilisationCriticalPct: 75,
  minLiquidationDistancePct: 12,
  concentrationWarnPct: 35,
};

export function mergeMarginThresholds(partial?: Partial<MarginGuardThresholds>): MarginGuardThresholds {
  return {
    utilisationWarnPct: partial?.utilisationWarnPct ?? defaultMarginGuardThresholds.utilisationWarnPct,
    utilisationCriticalPct: partial?.utilisationCriticalPct ?? defaultMarginGuardThresholds.utilisationCriticalPct,
    minLiquidationDistancePct: partial?.minLiquidationDistancePct ?? defaultMarginGuardThresholds.minLiquidationDistancePct,
    concentrationWarnPct: partial?.concentrationWarnPct ?? defaultMarginGuardThresholds.concentrationWarnPct,
  };
}

function computeLiquidationDistance(position: BrokerPositionMargin): number | undefined {
  const mark = Number(position.markPrice);
  const liquidation = Number(position.liquidationPrice);
  if (!Number.isFinite(mark) || !Number.isFinite(liquidation) || mark <= 0 || liquidation <= 0) return undefined;
  if (position.side === 'long') {
    const distance = ((mark - liquidation) / mark) * 100;
    return Number.isFinite(distance) ? Math.max(0, distance) : undefined;
  }
  const distance = ((liquidation - mark) / liquidation) * 100;
  return Number.isFinite(distance) ? Math.max(0, distance) : undefined;
}

function toCorrelatedArray(map?: Record<string, BrokerCorrelatedExposure>): Array<BrokerCorrelatedExposure & { concentrationPct?: number }> {
  if (!map) return [];
  const values = Object.values(map);
  if (!values.length) return [];
  const total = values.reduce((acc, item) => acc + (Number(item.totalNotionalUsd) || 0), 0);
  return values
    .map((value) => {
      const notional = Number(value.totalNotionalUsd) || 0;
      const concentrationPct = total > 0 ? (notional / total) * 100 : value.concentrationPct;
      return { ...value, concentrationPct: Number.isFinite(concentrationPct) ? concentrationPct : undefined };
    })
    .sort((a, b) => (Number(b.concentrationPct || 0) - Number(a.concentrationPct || 0)));
}

export function evaluateMarginSnapshot(
  snapshot: BrokerMarginSnapshot,
  opts?: { thresholds?: Partial<MarginGuardThresholds>; symbol?: string }
): MarginGuardResult {
  const thresholds = mergeMarginThresholds(opts?.thresholds);
  const equity = Number(snapshot.equityUsd) || 0;
  const committed = Number(snapshot.committedUsd) || 0;
  const utilisationPct = equity > 0 ? (committed / equity) * 100 : committed > 0 ? 100 : 0;

  const breaches: MarginGuardBreach[] = [];
  const actions: MarginGuardAction[] = [];

  if (utilisationPct >= thresholds.utilisationCriticalPct) {
    breaches.push({
      kind: 'utilisation',
      severity: 'critical',
      detail: `Utilisation ${utilisationPct.toFixed(1)}% exceeds critical ${thresholds.utilisationCriticalPct}%`,
      value: utilisationPct,
      reference: opts?.symbol,
    });
    actions.push({
      label: 'Reduce leverage immediately',
      severity: 'critical',
      rationale: `Committed capital exceeds ${thresholds.utilisationCriticalPct}% of equity. Decrease position sizes to free margin.`,
      relatedSymbols: snapshot.positions?.map((p) => p.symbol).filter(Boolean),
    });
  } else if (utilisationPct >= thresholds.utilisationWarnPct) {
    breaches.push({
      kind: 'utilisation',
      severity: 'warn',
      detail: `Utilisation ${utilisationPct.toFixed(1)}% above warning ${thresholds.utilisationWarnPct}%`,
      value: utilisationPct,
      reference: opts?.symbol,
    });
    actions.push({
      label: 'Trim exposure to free margin',
      severity: 'warn',
      rationale: `Utilisation is trending high (${utilisationPct.toFixed(1)}%). Scale back active positions before volatility spikes.`,
      relatedSymbols: snapshot.positions?.map((p) => p.symbol).filter(Boolean),
    });
  }

  const liquidationDistances = (snapshot.positions || []).map((position) => ({
    symbol: position.symbol,
    side: position.side,
    distancePct: computeLiquidationDistance(position),
    liquidationPrice: position.liquidationPrice,
    markPrice: position.markPrice,
  }));

  const weakestPositions = liquidationDistances
    .filter((entry) => entry.distancePct !== undefined)
    .sort((a, b) => Number(a.distancePct) - Number(b.distancePct))
    .slice(0, 3);

  const worstLiquidationDistancePct = weakestPositions.length ? weakestPositions[0].distancePct : undefined;

  if (
    worstLiquidationDistancePct !== undefined &&
    worstLiquidationDistancePct < thresholds.minLiquidationDistancePct
  ) {
    breaches.push({
      kind: 'liquidation',
      severity: worstLiquidationDistancePct < thresholds.minLiquidationDistancePct / 2 ? 'critical' : 'warn',
      detail: `Weakest liquidation buffer ${worstLiquidationDistancePct.toFixed(2)}% below ${thresholds.minLiquidationDistancePct}% target`,
      value: worstLiquidationDistancePct,
      reference: weakestPositions[0]?.symbol,
    });
    const target = weakestPositions[0];
    if (target) {
      actions.push({
        label: `Close or hedge ${target.symbol} ${target.side === 'long' ? 'long' : 'short'} leg`,
        severity: worstLiquidationDistancePct < thresholds.minLiquidationDistancePct / 2 ? 'critical' : 'warn',
        rationale: `Liquidation buffer is ${worstLiquidationDistancePct.toFixed(2)}%. Reduce position or add protection to avoid forced exit.`,
        relatedSymbols: [target.symbol],
      });
    }
  }

  const concentration = toCorrelatedArray(snapshot.correlatedExposure);
  const heavyConcentration = concentration.filter(
    (entry) => Number(entry.concentrationPct || 0) >= thresholds.concentrationWarnPct
  );

  for (const entry of heavyConcentration) {
    breaches.push({
      kind: 'concentration',
      severity: 'warn',
      detail: `Exposure on ${entry.key} is ${(entry.concentrationPct || 0).toFixed(1)}% of portfolio`,
      value: entry.concentrationPct,
      reference: entry.key,
    });
    actions.push({
      label: `Scale down ${entry.key} exposure`,
      severity: 'warn',
      rationale: `Notional ${Number(entry.totalNotionalUsd || 0).toFixed(2)} concentrates ${(entry.concentrationPct || 0).toFixed(1)}% of margin. Diversify positions.`,
      relatedSymbols: entry.positions,
    });
  }

  const status: MarginGuardSeverity = breaches.some((b) => b.severity === 'critical')
    ? 'critical'
    : breaches.some((b) => b.severity === 'warn')
    ? 'warn'
    : 'ok';

  return {
    status,
    utilisationPct,
    marginRatio: snapshot.marginRatio,
    maintenanceMarginUsd: snapshot.maintenanceMarginUsd,
    worstLiquidationDistancePct,
    liquidationDistances,
    concentration,
    breaches,
    actions,
  };
}
