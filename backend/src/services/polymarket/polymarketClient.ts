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
 * Fetch current odds from the Polymarket Gamma API for a given slug.
 * Returns neutral 50/50 odds on any error or missing data.
 */
export async function fetchPolymarketOdds(slug: string): Promise<PolymarketOdds> {
  const neutral: PolymarketOdds = { slug, upPrice: 0.5, downPrice: 0.5, found: false };

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

    let upPrice = 0.5;
    let downPrice = 0.5;

    for (let i = 0; i < outcomes.length; i++) {
      const label = outcomes[i].toLowerCase();
      const price = parseFloat(outcomePrices[i]);

      if (label === 'up') upPrice = price;
      else if (label === 'down') downPrice = price;
    }

    return { slug, upPrice, downPrice, found: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[Polymarket] Error fetching odds for slug=${slug}: ${msg}`);
    return neutral;
  }
}
