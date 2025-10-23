export interface MicroInputs {
  side: 'long' | 'short';
  lookbackSec: number;
  entryNudgeBps: number;
  lastPrice: number;
  spreadBps: number;
  top3BidSizeDelta: number;
  top3AskSizeDelta: number;
  priceDeltaBps: number;
}

export function computeEntryNudge(mi: MicroInputs): number {
  const { side, entryNudgeBps, priceDeltaBps, top3AskSizeDelta, top3BidSizeDelta } = mi;
  const nudge = Math.max(0, entryNudgeBps);
  if (nudge === 0) return 0;
  const priceTrendFavoring = side === 'long' ? priceDeltaBps > 0 : priceDeltaBps < 0;
  if (!priceTrendFavoring) return 0;
  if (side === 'long') {
    const askDepletion = top3AskSizeDelta < 0;
    const bidReplenishment = top3BidSizeDelta > 0;
    return askDepletion || bidReplenishment ? nudge : 0;
  }
  const bidDepletion = top3BidSizeDelta < 0;
  const askReplenishment = top3AskSizeDelta > 0;
  return bidDepletion || askReplenishment ? nudge : 0;
}
