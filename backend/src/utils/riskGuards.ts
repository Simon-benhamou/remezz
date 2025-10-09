const HIGH_VOL_BASES = new Set([
  'DOGE',
  'SHIB',
  'PEPE',
  'AVNT',
  'WIF',
  'BONK',
  'ALICE',
  'ZEC',
]);

const LOW_VOL_BASES = new Set([
  'BTC',
  'BCH',
  'USDT',
  'USDC',
  'DAI',
]);

type RiskLevel = 'normal' | 'elevated' | 'extreme';

function escalateRisk(current: RiskLevel, next: RiskLevel): RiskLevel {
  const order: RiskLevel[] = ['normal', 'elevated', 'extreme'];
  return order[Math.max(order.indexOf(current), order.indexOf(next))];
}

function baseSymbol(symbol: string): string {
  if (!symbol) return '';
  const upper = symbol.toUpperCase();
  if (upper.includes('/')) return upper.split('/')[0] ?? upper;
  if (upper.includes(':')) return upper.split(':')[0] ?? upper;
  return upper.replace(/[^A-Z0-9]/g, '');
}

export function classifySymbolVolatility(symbol: string): 'HIGH' | 'MODERATE' | 'LOW' {
  const base = baseSymbol(symbol);
  if (!base) return 'MODERATE';
  if (HIGH_VOL_BASES.has(base)) return 'HIGH';
  if (LOW_VOL_BASES.has(base)) return 'LOW';
  return 'MODERATE';
}

export function computeLeverageGuardForSymbol(params: {
  symbol: string;
  atrPct?: number | null;
  volatilityTag?: string | null;
}): { cap: number | null; reason: string | null; riskLevel: RiskLevel } {
  const reasons: string[] = [];
  let cap: number | null = null;
  let riskLevel: RiskLevel = 'normal';

  const applyCap = (nextCap: number, reason: string, level: RiskLevel) => {
    cap = cap == null ? nextCap : Math.min(cap, nextCap);
    riskLevel = escalateRisk(riskLevel, level);
    reasons.push(reason);
  };

  const volClass = classifySymbolVolatility(params.symbol);
  if (volClass === 'HIGH') {
    applyCap(3, 'high_vol_symbol', 'elevated');
  }

  const atr = Number.isFinite(params.atrPct) ? Math.abs(Number(params.atrPct)) : null;
  if (atr != null) {
    if (atr >= 3.5) {
      applyCap(2, 'atr>=3.5%', 'extreme');
    } else if (atr >= 2.5) {
      applyCap(3, 'atr>=2.5%', 'elevated');
    } else if (atr >= 1.8) {
      applyCap(4, 'atr>=1.8%', 'normal');
    }
  }

  const volTag = typeof params.volatilityTag === 'string' ? params.volatilityTag.toLowerCase() : '';
  if (volTag) {
    if (['extreme', 'panic', 'critical'].some((marker) => volTag.includes(marker))) {
      applyCap(2, `regime_volatility:${volTag}`, 'extreme');
    } else if (['high', 'elevated', 'aggressive'].some((marker) => volTag.includes(marker))) {
      applyCap(3, `regime_volatility:${volTag}`, 'elevated');
    }
  }

  if (cap == null) {
    return { cap: null, reason: null, riskLevel: 'normal' };
  }

  const boundedCap = Math.max(1, Math.min(10, cap));
  const finalCap = Math.round(boundedCap * 100) / 100;
  const reason = reasons.length ? Array.from(new Set(reasons)).join('; ') : null;
  return { cap: finalCap, reason, riskLevel };
}
