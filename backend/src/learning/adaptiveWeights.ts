import { prisma } from '../db/client.js';
import { classifySymbolFamily } from './symbolFamily.js';

type WeightRow = {
  momentumWeight: number;
  volumeWeight: number;
  volatilityWeight: number;
  confidence: number;
  sampleSize: number;
};

const weightCache = new Map<string, { value: WeightRow; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export function getAdaptiveWeightsCache() {
  return weightCache;
}

export async function refreshAdaptiveWeightsForFamily(family: string, force = false) {
  if (!force && weightCache.has(family)) return;
  try {
    const row = await prisma.adaptiveThreshold.findUnique({
      where: { family },
      select: {
        momentumWeight: true,
        volumeWeight: true,
        volatilityWeight: true,
        confidence: true,
        sampleSize: true,
      },
    });
    if (row) {
      weightCache.set(family, { value: row, ts: Date.now() });
    } else {
      weightCache.set(family, {
        value: {
          momentumWeight: 1,
          volumeWeight: 1,
          volatilityWeight: 1,
          confidence: 0,
          sampleSize: 0,
        },
        ts: Date.now(),
      });
    }
  } catch (error) {
    console.warn('Failed to refresh adaptive weights:', error);
  }
}

export async function getAdaptiveWeightsForSymbol(symbol: string) {
  const family = classifySymbolFamily(symbol);
  const cached = weightCache.get(family);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.value;
  }

  await refreshAdaptiveWeightsForFamily(family, true);
  return weightCache.get(family)?.value ?? {
    momentumWeight: 1,
    volumeWeight: 1,
    volatilityWeight: 1,
    confidence: 0,
    sampleSize: 0,
  };
}
