const SMALL_BALANCE_RATIO = 2 / 3;
const DEFAULT_SIZING_FLOOR_USD = 30;

export interface MinTradeNotionalParams {
  configMinNotionalUsd: number;
  equityUsd: number;
  sizingFloorUsd?: number;
}

/**
 * Compute the minimum tradable notional for a position sizing decision.
 *
 * Large accounts keep the legacy behaviour driven by a fixed dynamic floor.
 * When the account equity is tiny, the floor becomes proportional to equity
 * so the agent can participate instead of being blocked by an oversized
 * minimum.
 */
export function resolveMinTradeNotional(params: MinTradeNotionalParams): number {
  const sizingFloorUsd = Number.isFinite(params.sizingFloorUsd)
    ? Math.max(params.sizingFloorUsd ?? DEFAULT_SIZING_FLOOR_USD, 0)
    : DEFAULT_SIZING_FLOOR_USD;
  const configFloor = Number.isFinite(params.configMinNotionalUsd)
    ? Math.max(params.configMinNotionalUsd, 0)
    : 0;
  const safeEquity = Number.isFinite(params.equityUsd) ? Math.max(params.equityUsd, 0) : 0;
  const legacyDynamicFloor = Math.max(500, safeEquity * 0.005);

  if (safeEquity === 0) {
    return Math.max(sizingFloorUsd, configFloor);
  }

  if (safeEquity > 0 && safeEquity <= legacyDynamicFloor) {
    const proportionalFloor = Math.max(sizingFloorUsd, safeEquity * SMALL_BALANCE_RATIO);
    const cappedFloor = Math.min(legacyDynamicFloor, proportionalFloor);
    const relaxedConfigFloor = Math.min(configFloor, proportionalFloor);
    return Math.max(sizingFloorUsd, Math.max(relaxedConfigFloor, cappedFloor));
  }

  return Math.max(configFloor, legacyDynamicFloor);
}
