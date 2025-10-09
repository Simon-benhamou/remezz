import type { LeverageConstraint } from '@prisma/client';
import { prisma } from '../db/client.js';
import { getConfig } from '../utils/env.js';
import { classifySymbolFamily } from '../learning/symbolFamily.js';
import { getTicker, getOHLCV } from '../data/market.js';
import { atr } from '../data/indicators.js';

export type LeverageCapSource = 'symbol' | 'category' | 'global' | 'fallback';

export type ResolvedLeverageCap = {
  symbol: string;
  category: string;
  requested: number;
  resolved: number;
  modeCap: number;
  categoryCap: number;
  constraintCap: number | null;
  constraintTarget: number | null;
  constraintSource: LeverageCapSource;
  trimmed: boolean;
  constraint?: LeverageConstraint | null;
};

type ConstraintCache = {
  lastLoaded: number;
  bySymbol: Map<string, LeverageConstraint>;
  byCategory: Map<string, LeverageConstraint>;
  global?: LeverageConstraint | null;
};

const CACHE_TTL_MS = 60_000;
const cache: ConstraintCache = {
  lastLoaded: 0,
  bySymbol: new Map(),
  byCategory: new Map(),
  global: null,
};

let pendingLoad: Promise<void> | null = null;

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function normalizeCategory(category?: string | null): string {
  return (category || '').trim().toLowerCase();
}

async function loadConstraints(force = false) {
  const now = Date.now();
  if (!force && now - cache.lastLoaded < CACHE_TTL_MS && cache.bySymbol.size > 0) {
    return;
  }
  if (!pendingLoad) {
    pendingLoad = (async () => {
      const records = await prisma.leverageConstraint.findMany();
      cache.bySymbol.clear();
      cache.byCategory.clear();
      cache.global = null;
      for (const record of records) {
        const symKey = normalizeSymbol(record.symbol);
        const catKey = normalizeCategory(record.category);
        if (symKey === '*' || symKey === 'ALL') {
          if (catKey) {
            cache.byCategory.set(catKey, record);
          } else {
            cache.global = record;
          }
        } else {
          cache.bySymbol.set(symKey, record);
          if (catKey) {
            cache.byCategory.set(`${symKey}::${catKey}`, record);
          }
        }
      }
      cache.lastLoaded = Date.now();
    })().finally(() => {
      pendingLoad = null;
    });
  }
  await pendingLoad;
}

function pickConstraint(symbol: string, category: string): { constraint: LeverageConstraint | null; source: LeverageCapSource } {
  const symKey = normalizeSymbol(symbol);
  const catKey = normalizeCategory(category);
  const exact = cache.bySymbol.get(symKey) || cache.byCategory.get(`${symKey}::${catKey}`);
  if (exact) {
    return { constraint: exact, source: 'symbol' };
  }
  if (catKey) {
    const catConstraint = cache.byCategory.get(catKey);
    if (catConstraint) {
      return { constraint: catConstraint, source: 'category' };
    }
  }
  if (cache.global) {
    return { constraint: cache.global, source: 'global' };
  }
  return { constraint: null, source: 'fallback' };
}

function resolveCategoryCap(category: string): number {
  const cfg = getConfig();
  switch (category) {
    case 'major':
      return Math.max(1, cfg.LEVERAGE_CAP_MAJOR);
    case 'meme':
      return Math.max(1, cfg.LEVERAGE_CAP_MEME);
    case 'alt':
    case 'altcoin':
      return Math.max(1, cfg.LEVERAGE_CAP_ALT);
    default:
      return Math.max(1, cfg.LEVERAGE_CAP_DEFAULT);
  }
}

function resolveModeCap(mode?: 'paper' | 'live'): number {
  const cfg = getConfig();
  const cap = cfg.DEFAULT_MAX_LEVERAGE;
  // Provide an escape hatch for future live vs paper overrides by keeping the arg.
  return Math.max(1, cap);
}

function constraintCapValue(constraint: LeverageConstraint | null): number | null {
  if (!constraint) return null;
  const caps: number[] = [];
  const hard = Number(constraint.hardCap);
  if (Number.isFinite(hard) && hard > 0) caps.push(hard);
  const target = Number(constraint.targetLeverage);
  if (Number.isFinite(target) && target > 0) caps.push(target);
  if (!caps.length) return null;
  return Math.min(...caps);
}

export async function resolveLeverageCap(params: {
  symbol: string;
  requestedMaxLeverage: number;
  category?: string;
  mode?: 'paper' | 'live';
}): Promise<ResolvedLeverageCap> {
  const symbol = params.symbol;
  await loadConstraints(false);
  const requested = Math.max(1, Number(params.requestedMaxLeverage || 1));
  const inferredCategory = normalizeCategory(params.category || classifySymbolFamily(symbol));
  const { constraint, source } = pickConstraint(symbol, inferredCategory);
  const modeCap = resolveModeCap(params.mode);
  const categoryCap = resolveCategoryCap(inferredCategory);
  const constraintCap = constraintCapValue(constraint);
  const resolved = Math.max(
    1,
    Math.min(
      requested,
      modeCap,
      categoryCap,
      constraintCap != null ? constraintCap : Number.POSITIVE_INFINITY,
    ),
  );
  const trimmed = resolved + 1e-9 < requested;
  return {
    symbol,
    category: inferredCategory,
    requested,
    resolved,
    modeCap,
    categoryCap,
    constraintCap,
    constraintTarget: constraint?.targetLeverage ?? null,
    constraintSource: source,
    trimmed,
    constraint: constraint ?? undefined,
  };
}

export function clearLeverageCapCache() {
  cache.bySymbol.clear();
  cache.byCategory.clear();
  cache.global = null;
  cache.lastLoaded = 0;
}

export async function refreshLeverageConstraintInputs(options: { symbols?: string[]; force?: boolean } = {}) {
  if (process.env.UNIT_TEST_MODE === 'true') {
    await loadConstraints(options.force ?? false);
    return;
  }
  const where: any = {
    symbol: { notIn: ['*', 'ALL'] },
  };
  if (options.symbols && options.symbols.length) {
    where.symbol.in = options.symbols;
  }
  const constraints = await prisma.leverageConstraint.findMany({ where });
  for (const constraint of constraints) {
    const symbol = constraint.symbol;
    try {
      const [ticker, ohlcv] = await Promise.all([
        getTicker(symbol).catch((error) => {
          console.warn(`Failed to refresh liquidity for ${symbol}:`, error);
          return null;
        }),
        getOHLCV(symbol, '1h', 120).catch((error) => {
          console.warn(`Failed to refresh ATR for ${symbol}:`, error);
          return [] as number[][];
        }),
      ]);
      const liquidityUsd = ticker ? Number(ticker.quoteVolume ?? ticker.info?.quoteVolume ?? ticker.baseVolume ?? 0) : null;
      let atrPct: number | null = null;
      if (ohlcv && ohlcv.length) {
        const series = atr(ohlcv, 14);
        const lastAtr = series.at(-1);
        const close = ohlcv.at(-1)?.[4];
        if (Number.isFinite(lastAtr) && Number.isFinite(close) && close) {
          atrPct = (Number(lastAtr) / Number(close)) * 100;
        }
      }
      await prisma.leverageConstraint.update({
        where: { id: constraint.id },
        data: {
          liquidityUsd: liquidityUsd != null ? liquidityUsd : constraint.liquidityUsd,
          liquiditySampledAt: liquidityUsd != null ? new Date() : constraint.liquiditySampledAt,
          atrPct: atrPct != null ? atrPct : constraint.atrPct,
          atrSampledAt: atrPct != null ? new Date() : constraint.atrSampledAt,
        },
      });
    } catch (error) {
      console.warn(`Leverage constraint refresh failed for ${symbol}:`, error);
    }
  }
  await loadConstraints(true);
}
