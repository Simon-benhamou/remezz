import { classifySymbolFamily } from '../../learning/symbolFamily.js';

type LiquidityGuardrailOptions = {
  aggressiveness?: 'conservative' | 'reactive' | 'aggressive';
};

type SymbolQualityContext = {
  symbol: string;
  base: string;
  sanitizedBase: string;
  family: string;
  isBlueChip: boolean;
  isMeme: boolean;
  isComplexName: boolean;
};

const QUALITY_BLUE_CHIP_BASES = new Set([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'DOT', 'MATIC', 'LTC', 'LINK', 'UNI', 'ATOM',
  'NEAR', 'FIL', 'TRX', 'XLM', 'BCH', 'ETC', 'ICP', 'AAVE', 'INJ', 'RNDR', 'TIA', 'SEI', 'APT',
  'SUI', 'OP', 'ARB', 'TON', 'HBAR', 'ALGO', 'MKR', 'IMX', 'DYDX', 'JUP', 'PYTH', 'STX', 'FTM',
  'AR', 'FLOW', 'SAND', 'MANA',
]);

const QUALITY_MEME_BASES = new Set([
  'DOGE', 'SHIB', 'PEPE', 'FLOKI', 'BONK', 'WIF', 'BOME', 'MEME', 'POPCAT', 'MEW', 'TURBO', 'DOGS',
  '1000BONK',
]);

function sanitizeBaseSymbol(base: string): string {
  const cleaned = base.toUpperCase().replace(/[^A-Z]/g, '');
  return cleaned || base.toUpperCase();
}

function buildSymbolQualityContext(symbolOrBase: string): SymbolQualityContext {
  const normalized = symbolOrBase.includes('/') ? symbolOrBase : `${symbolOrBase}/USDT`;
  const base = normalized.split('/')[0]?.toUpperCase() || normalized.toUpperCase();
  const sanitizedBase = sanitizeBaseSymbol(base);
  const family = classifySymbolFamily(normalized);
  const isBlueChip = QUALITY_BLUE_CHIP_BASES.has(base) || QUALITY_BLUE_CHIP_BASES.has(sanitizedBase);
  const isMeme = QUALITY_MEME_BASES.has(base) || QUALITY_MEME_BASES.has(sanitizedBase) || family === 'meme';
  const isComplexName = base.length >= 6 || /[0-9]/.test(base);
  return { symbol: normalized, base, sanitizedBase, family, isBlueChip, isMeme, isComplexName };
}

function evaluateSymbolLiquidityGuardrails(
  symbolOrBase: string,
  volumeUsd: number,
  price?: number,
  options: LiquidityGuardrailOptions = {},
): { ok: boolean; reason?: string; minRequired?: number } {
  const context = buildSymbolQualityContext(symbolOrBase);
  const px = Number(price || 0);
  const aggressiveness = options.aggressiveness || 'reactive';
  const aggressivenessMultiplier = aggressiveness === 'conservative' ? 1.2 : aggressiveness === 'aggressive' ? 0.9 : 1.0;

  let minVolume = context.isBlueChip ? 15_000_000 : context.family === 'major' ? 20_000_000 : 30_000_000;
  if (context.isComplexName && !context.isBlueChip) {
    minVolume = Math.max(minVolume, 35_000_000);
  }
  if (context.isMeme) {
    minVolume = Math.max(minVolume, 50_000_000);
  }
  if (px > 0 && px < 0.1) {
    minVolume = Math.max(minVolume, 40_000_000);
  }
  if (px > 0 && px < 0.01) {
    minVolume = Math.max(minVolume, 75_000_000);
  }

  minVolume = Math.round(minVolume * aggressivenessMultiplier);

  if (volumeUsd < minVolume) {
    return { ok: false, reason: 'quality_volume_floor', minRequired: minVolume };
  }

  return { ok: true };
}

function symbolQualityRank(symbol: string): number {
  const context = buildSymbolQualityContext(symbol);
  if (context.isBlueChip) return 0;
  if (context.family === 'major') return 1;
  if (context.isMeme) return 5;
  let rank = 2;
  if (context.isComplexName) rank += 1;
  if (/[0-9]/.test(context.base)) rank += 0.5;
  return rank;
}

export {
  LiquidityGuardrailOptions,
  SymbolQualityContext,
  buildSymbolQualityContext,
  evaluateSymbolLiquidityGuardrails,
  symbolQualityRank,
  sanitizeBaseSymbol,
  QUALITY_BLUE_CHIP_BASES,
  QUALITY_MEME_BASES,
};
