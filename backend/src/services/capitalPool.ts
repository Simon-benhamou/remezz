import { PreciseDecimal } from '../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { CapitalManager } from '../core/capital/CapitalManager.js';
import { PaperBalanceProvider } from '../core/capital/PaperBalanceProvider.js';
import { LiveBalanceProvider } from '../core/capital/LiveBalanceProvider.js';
import { capitalConfig } from '../config/capital.js';
import { BalanceSnapshot, Reservation, ZERO_USD, toUSD } from '../core/capital/types.js';
import { prisma } from '../db/client.js';

const defaultPaperBalance = () => ({
  totalUSD: new PreciseDecimal('1000'),
  freeUSD: new PreciseDecimal('1000'),
  reservedUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
  inPositionsUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
  ts: Date.now(),
});

const paperStore = { snapshot: defaultPaperBalance() };
const paperProvider = new PaperBalanceProvider(paperStore);
let paperManualBase = paperStore.snapshot.totalUSD;
let paperManualFree = paperStore.snapshot.freeUSD;

const liveStore = {
  snapshot: {
    totalUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
    freeUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
    reservedUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
    inPositionsUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
    ts: Date.now(),
  },
};

let liveExchangeSnapshot: { totalUSD: PreciseDecimal; freeUSD: PreciseDecimal; ts: number } | null = null;

const liveProvider = new LiveBalanceProvider(
  {
    getUsdBalance: async () => {
      if (liveExchangeSnapshot) {
        return { total: liveExchangeSnapshot.totalUSD, free: liveExchangeSnapshot.freeUSD };
      }
      return { total: ZERO_USD, free: ZERO_USD };
    },
  },
  liveStore,
);

const paperManager = new CapitalManager(paperProvider, capitalConfig, {
  reservations: new Map<string, Reservation>(),
  symbolExposure: new Map<string, PreciseDecimal>(),
});

const liveManager = new CapitalManager(liveProvider, capitalConfig, {
  reservations: new Map<string, Reservation>(),
  symbolExposure: new Map<string, PreciseDecimal>(),
});

const RECONCILE_INTERVAL_MS = 10_000;
let lastPaperReconcile = 0;
let lastLiveReconcile = 0;

async function reconcilePaperCapitalFromDb(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastPaperReconcile < RECONCILE_INTERVAL_MS) return;
  lastPaperReconcile = now;

  const baseTotal = paperManualBase.toNumber();
  const baseFree = paperManualFree.toNumber();

  try {
    const sessions = await prisma.agentSession.findMany({
      where: { mode: 'paper', stoppedAt: null },
      select: {
        startBalanceUsd: true,
        positions: {
          select: { symbol: true, qty: true, entryPrice: true },
        },
        kpi: {
          select: { realizedPnlUsd: true, unrealizedPnlUsd: true },
        },
      },
    });

    if (!sessions.length) {
      const snapshot: BalanceSnapshot = {
        totalUSD: paperManualBase,
        freeUSD: paperManualFree,
        reservedUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
        inPositionsUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
        ts: now,
      };
      await paperManager.reseedLedger({ snapshot, exposures: [] });
      return;
    }

    let realizedSum = 0;
    let unrealizedSum = 0;
    const exposureMap = new Map<string, number>();
    let inPositionsTotal = 0;

    for (const session of sessions) {
      realizedSum += Number(session.kpi?.realizedPnlUsd ?? 0);
      unrealizedSum += Number(session.kpi?.unrealizedPnlUsd ?? 0);
      for (const position of session.positions) {
        const qty = Math.abs(Number(position.qty ?? 0));
        const entryPrice = Math.abs(Number(position.entryPrice ?? 0));
        if (!(qty > 0) || !(entryPrice > 0)) continue;
        const notional = qty * entryPrice;
        inPositionsTotal += notional;
        exposureMap.set(
          position.symbol,
          (exposureMap.get(position.symbol) ?? 0) + notional,
        );
      }
    }

    let totalValue = Math.max(0, baseTotal + realizedSum + unrealizedSum);
    if (totalValue < inPositionsTotal) {
      totalValue = inPositionsTotal;
    }
    let freeValue = Math.max(0, totalValue - inPositionsTotal);
    if (!Number.isFinite(freeValue)) {
      freeValue = 0;
    }
    if (freeValue === 0 && totalValue === 0) {
      freeValue = baseFree;
      totalValue = baseFree;
    }

    const snapshot: BalanceSnapshot = {
      totalUSD: toUSD(totalValue),
      freeUSD: toUSD(freeValue),
      reservedUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
      inPositionsUSD: toUSD(inPositionsTotal),
      ts: now,
    };

    const exposures = Array.from(exposureMap.entries()).map(([symbol, value]) => ({
      symbol,
      exposure: toUSD(Math.max(0, value)),
    }));

    await paperManager.reseedLedger({ snapshot, exposures });
  } catch (error) {
    console.warn('⚠️ Failed to reconcile paper capital pool from DB:', error);
  }
}

async function reconcileLiveCapitalFromDb(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastLiveReconcile < RECONCILE_INTERVAL_MS) return;
  lastLiveReconcile = now;

  try {
    const sessions = await prisma.agentSession.findMany({
      where: { mode: 'live', stoppedAt: null },
      select: {
        startBalanceUsd: true,
        positions: {
          select: { symbol: true, qty: true, entryPrice: true },
        },
        kpi: {
          select: { realizedPnlUsd: true, unrealizedPnlUsd: true },
        },
      },
    });

    if (!sessions.length) {
      const totalValue = liveExchangeSnapshot ? liveExchangeSnapshot.totalUSD.toNumber() : 0;
      const freeValue = liveExchangeSnapshot ? liveExchangeSnapshot.freeUSD.toNumber() : totalValue;
      await liveManager.reseedLedger({
        snapshot: {
          totalUSD: toUSD(totalValue),
          freeUSD: toUSD(Math.max(0, Math.min(freeValue, totalValue))),
          reservedUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
          inPositionsUSD: toUSD(0),
          ts: now,
        },
        exposures: [],
      });
      return;
    }

    let startSum = 0;
    let realizedSum = 0;
    let unrealizedSum = 0;
    const exposureMap = new Map<string, number>();
    let inPositionsTotal = 0;

    for (const session of sessions) {
      startSum += Number(session.startBalanceUsd ?? 0);
      realizedSum += Number(session.kpi?.realizedPnlUsd ?? 0);
      unrealizedSum += Number(session.kpi?.unrealizedPnlUsd ?? 0);
      for (const position of session.positions) {
        const qty = Math.abs(Number(position.qty ?? 0));
        const entryPrice = Math.abs(Number(position.entryPrice ?? 0));
        if (!(qty > 0) || !(entryPrice > 0)) continue;
        const notional = qty * entryPrice;
        inPositionsTotal += notional;
        exposureMap.set(
          position.symbol,
          (exposureMap.get(position.symbol) ?? 0) + notional,
        );
      }
    }

    let totalValue = liveExchangeSnapshot
      ? liveExchangeSnapshot.totalUSD.toNumber()
      : Math.max(0, startSum + realizedSum + unrealizedSum);

    if (totalValue < inPositionsTotal) {
      totalValue = inPositionsTotal;
    }

    let freeValue = liveExchangeSnapshot
      ? Math.max(0, Math.min(liveExchangeSnapshot.freeUSD.toNumber(), totalValue))
      : Math.max(0, totalValue - inPositionsTotal);

    const inPositionsValue = Math.min(totalValue, inPositionsTotal);
    if (freeValue + inPositionsValue > totalValue) {
      freeValue = Math.max(0, totalValue - inPositionsValue);
    }

    const snapshot: BalanceSnapshot = {
      totalUSD: toUSD(totalValue),
      freeUSD: toUSD(freeValue),
      reservedUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
      inPositionsUSD: toUSD(inPositionsValue),
      ts: now,
    };

    const exposures = Array.from(exposureMap.entries()).map(([symbol, value]) => ({
      symbol,
      exposure: toUSD(Math.max(0, value)),
    }));

    await liveManager.reseedLedger({ snapshot, exposures });
  } catch (error) {
    console.warn('⚠️ Failed to reconcile live capital pool from DB:', error);
  }
}

export function getCapitalManager(mode: 'paper' | 'live'): CapitalManager {
  return mode === 'paper' ? paperManager : liveManager;
}

export async function getBalanceSnapshot(mode: 'paper' | 'live'): Promise<BalanceSnapshot> {
  if (mode === 'paper') {
    await reconcilePaperCapitalFromDb();
    return paperProvider.getSnapshot();
  }
  await reconcileLiveCapitalFromDb();
  return liveProvider.getSnapshot();
}

export function listReservations(mode: 'paper' | 'live'): Reservation[] {
  const manager = mode === 'paper' ? paperManager : liveManager;
  return manager.listReservations();
}

export async function setPaperBalance(amount: string | number | PreciseDecimal): Promise<BalanceSnapshot> {
  const nextRaw = toUSD(amount);
  const normalized = nextRaw.raw >= ZERO_USD.raw ? nextRaw : ZERO_USD;
  const next = PreciseDecimal.fromRaw(normalized.raw);
  const snapshot: BalanceSnapshot = {
    totalUSD: PreciseDecimal.fromRaw(next.raw),
    freeUSD: PreciseDecimal.fromRaw(next.raw),
    reservedUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
    inPositionsUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
    ts: Date.now(),
  };
  paperStore.snapshot = snapshot;
  paperManualBase = snapshot.totalUSD;
  paperManualFree = snapshot.freeUSD;
  await paperManager.clearLedger();
  lastPaperReconcile = 0;
  return snapshot;
}

export function updateLiveExchangeBalance(params: { totalUsd: number; freeUsd: number; timestamp?: number }): void {
  const totalUsd = Math.max(0, Number(params.totalUsd ?? 0));
  const freeUsd = Math.max(0, Number(params.freeUsd ?? 0));
  if (!Number.isFinite(totalUsd) || !Number.isFinite(freeUsd)) return;

  liveExchangeSnapshot = {
    totalUSD: toUSD(totalUsd),
    freeUSD: toUSD(Math.min(totalUsd, freeUsd)),
    ts: params.timestamp ?? Date.now(),
  };
  lastLiveReconcile = 0;
}
