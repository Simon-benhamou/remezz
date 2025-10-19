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

type InternalEntry = {
  firstSeenAt: number;
  updatedAt: number;
  derivatives?: PerpetualMetrics | null;
  onChain?: OnChainMetrics | null;
  sentiment?: SentimentSnapshot | null;
  watchlist?: WatchlistMeta | null;
};

type UpdatePatch = {
  derivatives?: PerpetualMetrics | null;
  onChain?: OnChainMetrics | null;
  sentiment?: SentimentSnapshot | null;
  watchlist?: WatchlistMeta | null;
  timestamp?: number;
};

const store = new Map<string, InternalEntry>();

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function clonePerp(perp: PerpetualMetrics | null | undefined): PerpetualMetrics | null {
  if (!perp) return perp ?? null;
  return { ...perp };
}

function cloneOnChain(onChain: OnChainMetrics | null | undefined): OnChainMetrics | null {
  if (!onChain) return onChain ?? null;
  return { ...onChain };
}

function cloneSentiment(sentiment: SentimentSnapshot | null | undefined): SentimentSnapshot | null {
  if (!sentiment) return sentiment ?? null;
  return { ...sentiment, raw: sentiment.raw ? { ...sentiment.raw } : sentiment.raw ?? null };
}

function cloneWatchlist(meta: WatchlistMeta | null | undefined): WatchlistMeta | null {
  if (!meta) return meta ?? null;
  return { ...meta };
}

function toSnapshot(entry: InternalEntry): MarketContextSnapshot {
  return {
    derivatives: clonePerp(entry.derivatives ?? null),
    onChain: cloneOnChain(entry.onChain ?? null),
    sentiment: cloneSentiment(entry.sentiment ?? null),
    watchlist: cloneWatchlist(entry.watchlist ?? null),
    firstSeenAt: entry.firstSeenAt,
    updatedAt: entry.updatedAt,
  };
}

export function updateMarketContext(symbol: string, patch: UpdatePatch): MarketContextSnapshot {
  const key = normalizeSymbol(symbol);
  const now = Number.isFinite(patch.timestamp ?? NaN) ? Number(patch.timestamp) : Date.now();
  const existing = store.get(key);
  const entry: InternalEntry = existing
    ? { ...existing }
    : { firstSeenAt: now, updatedAt: now };

  if (!existing) {
    store.set(key, entry);
  }

  entry.updatedAt = now;

  if (patch.watchlist) {
    const incoming = cloneWatchlist(patch.watchlist);
    if (incoming) {
      if (incoming.addedAt != null && Number.isFinite(incoming.addedAt)) {
        entry.firstSeenAt = Math.min(entry.firstSeenAt, incoming.addedAt!);
      }
      if (incoming.firstSeenAt != null && Number.isFinite(incoming.firstSeenAt)) {
        entry.firstSeenAt = Math.min(entry.firstSeenAt, incoming.firstSeenAt!);
      }
      entry.watchlist = { ...entry.watchlist, ...incoming };
    }
  }

  if (patch.derivatives !== undefined) {
    entry.derivatives = clonePerp(patch.derivatives ?? null);
  }
  if (patch.onChain !== undefined) {
    entry.onChain = cloneOnChain(patch.onChain ?? null);
  }
  if (patch.sentiment !== undefined) {
    entry.sentiment = cloneSentiment(patch.sentiment ?? null);
  }

  entry.updatedAt = now;

  return toSnapshot(entry);
}

export function getMarketContext(symbol: string): MarketContextSnapshot | null {
  const key = normalizeSymbol(symbol);
  const entry = store.get(key);
  if (!entry) return null;
  return toSnapshot(entry);
}

export function clearMarketContext(symbol?: string): void {
  if (!symbol) {
    store.clear();
    return;
  }
  const key = normalizeSymbol(symbol);
  store.delete(key);
}
