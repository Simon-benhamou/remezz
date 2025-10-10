import { QuantAIRegimeConfig } from '../config.js';

export type MarketRegime = 'bull' | 'bear' | 'range';
export type RegimeMode = 'conservative' | 'aggressive';

export function classifyRegime(
  emaFast: number | null | undefined,
  emaSlow: number | null | undefined,
  adx: number | null | undefined,
  cfg: QuantAIRegimeConfig,
): MarketRegime {
  if (adx != null && adx < cfg.adxTrendMin) {
    return 'range';
  }
  if (emaFast == null || emaSlow == null) return 'range';
  if (emaFast > emaSlow) return 'bull';
  if (emaFast < emaSlow) return 'bear';
  return 'range';
}

export function selectMode(regime: MarketRegime): RegimeMode {
  return regime === 'range' ? 'conservative' : 'aggressive';
}
