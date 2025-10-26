export type PerpetualMetrics = {
  fundingRate?: number | null;
  nextFundingHours?: number | null;
  openInterestUsd?: number | null;
  openInterestChangePct?: number | null;
  longShortRatio?: number | null;
  basisSpreadPct?: number | null;
  volumeUsd24h?: number | null;
};

export type OnChainMetrics = {
  exchangeNetflowUsd?: number | null;
  activeAddresses?: number | null;
  stablecoinInflowsUsd?: number | null;
  stablecoinOutflowsUsd?: number | null;
  stablecoinVelocity?: number | null;
};

export type SentimentSnapshot = {
  label: 'bullish' | 'bearish' | 'neutral';
  score: number;
  confidence?: number | null;
  source?: string | null;
  updatedAt: number;
  raw?: Record<string, unknown> | null;
};

export type WatchlistMeta = {
  isNew?: boolean;
  addedAt?: number | null;
  rankHint?: number | null;
  volumeSurgeHint?: number | null;
  firstSeenAt?: number | null;
};

export type MarketContextSnapshot = {
  derivatives?: PerpetualMetrics | null;
  onChain?: OnChainMetrics | null;
  sentiment?: SentimentSnapshot | null;
  watchlist?: WatchlistMeta | null;
  firstSeenAt: number;
  updatedAt: number;
};

export function getMarketContext(symbol: string): MarketContextSnapshot | null {
  void symbol;
  return null;
}
