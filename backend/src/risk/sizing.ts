export function sizeUsd(balanceUsd: number, riskPct: number, stopPct: number) {
  const riskDollar = balanceUsd * (riskPct / 100);
  return stopPct > 0 ? riskDollar / (stopPct / 100) : 0;
}
