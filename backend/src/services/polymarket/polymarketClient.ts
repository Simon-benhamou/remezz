import type { PolymarketOdds } from './polymarketTypes.js';

const BASE_URL = 'https://gamma-api.polymarket.com';

/**
 * Build a Polymarket slug for a 5-minute crypto up/down market.
 * unix_seconds is aligned to the nearest 5-minute boundary (floor).
 */
export function buildSlug(symbol: string, windowStartMs: number): string {
  const unixSeconds = Math.floor(windowStartMs / 1000 / 300) * 300;
  return `${symbol.toLowerCase()}-updown-5m-${unixSeconds}`;
}

/**
 * Fetch the actual resolution result from Polymarket's oracle.
 * Returns 'UP' or 'DOWN' when the market is resolved, null if still pending.
 * A market is resolved when one outcome price = 1.0 and the other = 0.0.
 */
export async function fetchPolymarketResult(slug: string): Promise<'UP' | 'DOWN' | null> {
  try {
    const res = await fetch(`${BASE_URL}/events?slug=${slug}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const events: unknown = await res.json();
    if (!Array.isArray(events) || events.length === 0) return null;

    const market = events[0]?.markets?.[0];
    if (!market) return null;

    const outcomes: string[] = JSON.parse(market.outcomes || '[]');
    const prices: string[] = JSON.parse(market.outcomePrices || '[]');

    // Resolved when one price rounds to 1.0 and the other to 0.0
    for (let i = 0; i < outcomes.length; i++) {
      const price = parseFloat(prices[i] ?? '0.5');
      if (price >= 0.99) {
        return outcomes[i].toLowerCase() === 'up' ? 'UP' : 'DOWN';
      }
    }

    return null; // still live / not yet resolved
  } catch {
    return null;
  }
}

/**
 * Fetch current odds from the Polymarket Gamma API for a given slug.
 * Returns neutral 50/50 odds on any error or missing data.
 */
export async function fetchPolymarketOdds(slug: string): Promise<PolymarketOdds> {
  const neutral: PolymarketOdds = { slug, upPrice: 0.5, downPrice: 0.5, upTokenId: null, downTokenId: null, found: false };

  try {
    const url = `${BASE_URL}/events?slug=${slug}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!res.ok) {
      console.warn(`[Polymarket] HTTP ${res.status} for slug=${slug}`);
      return neutral;
    }

    const events: unknown = await res.json();

    if (!Array.isArray(events) || events.length === 0) {
      console.warn(`[Polymarket] No events found for slug=${slug}`);
      return neutral;
    }

    const event = events[0];
    const markets = event?.markets;

    if (!Array.isArray(markets) || markets.length === 0) {
      console.warn(`[Polymarket] No markets in event for slug=${slug}`);
      return neutral;
    }

    const market = markets[0];
    const outcomes: string[] = JSON.parse(market.outcomes);
    const outcomePrices: string[] = JSON.parse(market.outcomePrices);
    // clobTokenIds maps 1:1 with outcomes
    const clobTokenIds: string[] = market.clobTokenIds
      ? JSON.parse(market.clobTokenIds)
      : [];

    let upPrice = 0.5;
    let downPrice = 0.5;
    let upTokenId: string | null = null;
    let downTokenId: string | null = null;

    for (let i = 0; i < outcomes.length; i++) {
      const label = outcomes[i].toLowerCase();
      const price = parseFloat(outcomePrices[i]);
      const tokenId = clobTokenIds[i] ?? null;

      if (label === 'up') {
        upPrice = price;
        upTokenId = tokenId;
      } else if (label === 'down') {
        downPrice = price;
        downTokenId = tokenId;
      }
    }

    return { slug, upPrice, downPrice, upTokenId, downTokenId, found: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[Polymarket] Error fetching odds for slug=${slug}: ${msg}`);
    return neutral;
  }
}

/**
 * Fetch the conditionId for a market from the Gamma API.
 * Required for on-chain CTF redemption after market resolution.
 * Returns null if the market is not found or has no conditionId.
 */
export async function fetchConditionId(slug: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE_URL}/events?slug=${slug}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const events: unknown = await res.json();
    if (!Array.isArray(events) || events.length === 0) return null;

    const market = events[0]?.markets?.[0];
    return market?.conditionId ?? null;
  } catch {
    return null;
  }
}
