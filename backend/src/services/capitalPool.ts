import { PreciseDecimal } from '../quantai/strategies/metaAdaptive/preciseDecimal.js';
import { CapitalManager } from '../core/capital/CapitalManager.js';
import { PaperBalanceProvider } from '../core/capital/PaperBalanceProvider.js';
import { LiveBalanceProvider } from '../core/capital/LiveBalanceProvider.js';
import { capitalConfig } from '../config/capital.js';
import { BalanceSnapshot, Reservation, ZERO_USD, toUSD } from '../core/capital/types.js';
import { prisma } from '../db/client.js';

const paperBalanceOverride = (() => {
  const raw = process.env.META_ADAPTIVE_PAPER_BALANCE_USD ?? process.env.PAPER_BALANCE_USD;
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return new PreciseDecimal(parsed.toString());
})();

const resolvePaperBalanceBaseline = (): PreciseDecimal => {
  const baseline = paperBalanceOverride ?? new PreciseDecimal('10000');
  return PreciseDecimal.fromRaw(baseline.raw);
};

const defaultPaperBalance = () => ({
  totalUSD: resolvePaperBalanceBaseline(),
  freeUSD: resolvePaperBalanceBaseline(),
  reservedUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
  inPositionsUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
  ts: Date.now(),
});

// Load persisted paper balance from database on startup
async function loadPersistedPaperBalance(): Promise<PreciseDecimal> {
  try {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: 'paper_balance_usd' },
    });
    
    if (setting && setting.value) {
      const value = parseFloat(setting.value);
      if (Number.isFinite(value) && value > 0) {
        console.log(`📥 Loaded persisted paper balance from database: $${value}`);
        return new PreciseDecimal(value.toString());
      }
    }
  } catch (error) {
    console.warn('⚠️ Failed to load persisted paper balance from database:', error);
  }
  
  // Return default if not found or error
  const fallback = resolvePaperBalanceBaseline();
  console.log(`📥 Using default paper balance: $${fallback.toNumber()}`);
  return fallback;
}

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
  agentEquity: new Map(),
});

const liveManager = new CapitalManager(liveProvider, capitalConfig, {
  reservations: new Map<string, Reservation>(),
  symbolExposure: new Map<string, PreciseDecimal>(),
  agentEquity: new Map(),
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
        id: true,
        startBalanceUsd: true,
        positions: {
          select: { symbol: true, qty: true, entryPrice: true, leverage: true },
        },
        SessionKpi: {
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
    let totalPositionsCount = 0;

    for (const session of sessions) {
      realizedSum += Number(session.SessionKpi?.realizedPnlUsd ?? 0);
      unrealizedSum += Number(session.SessionKpi?.unrealizedPnlUsd ?? 0);
      totalPositionsCount += session.positions.length;
      for (const position of session.positions) {
        const qty = Math.abs(Number(position.qty ?? 0));
        const entryPrice = Math.abs(Number(position.entryPrice ?? 0));
        const leverage = Math.max(1, Number(position.leverage ?? 1));
        if (!(qty > 0) || !(entryPrice > 0)) continue;
        const notional = qty * entryPrice;
        // Track margin requirement (notional / leverage), not full notional
        const marginRequired = notional / leverage;
        inPositionsTotal += marginRequired;
        exposureMap.set(
          position.symbol,
          (exposureMap.get(position.symbol) ?? 0) + marginRequired,
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

    // DISCREPANCY WARNING: Check if there's a significant mismatch (>1 position)
    const previousSnapshot = await paperProvider.getSnapshot();
    const previousPositionsUsd = previousSnapshot.inPositionsUSD.toNumber();
    const positionsDifference = Math.abs(inPositionsTotal - previousPositionsUsd);
    
    // Detect discrepancy if difference is more than the equivalent of 1 position at $10 margin
    if (positionsDifference > 10 && totalPositionsCount > 0) {
      console.warn('⚠️ CAPITAL SYNC WARNING [Paper Mode]:');
      console.warn(`  Active Sessions: ${sessions.length}`);
      console.warn(`  Total Positions: ${totalPositionsCount}`);
      console.warn(`  Previous In-Position: $${previousPositionsUsd.toFixed(2)}`);
      console.warn(`  New In-Position: $${inPositionsTotal.toFixed(2)}`);
      console.warn(`  Difference: $${positionsDifference.toFixed(2)}`);
      console.warn(`  Free Capital: $${freeValue.toFixed(2)}`);
      console.warn('  ⚠️ Possible sync issue detected - verify order visibility in monitoring API');
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
        id: true,
        startBalanceUsd: true,
        positions: {
          select: { symbol: true, qty: true, entryPrice: true, leverage: true },
        },
        SessionKpi: {
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
    let totalPositionsCount = 0;

    for (const session of sessions) {
      startSum += Number(session.startBalanceUsd ?? 0);
      realizedSum += Number(session.SessionKpi?.realizedPnlUsd ?? 0);
      unrealizedSum += Number(session.SessionKpi?.unrealizedPnlUsd ?? 0);
      totalPositionsCount += session.positions.length;
      for (const position of session.positions) {
        const qty = Math.abs(Number(position.qty ?? 0));
        const entryPrice = Math.abs(Number(position.entryPrice ?? 0));
        const leverage = Math.max(1, Number(position.leverage ?? 1));
        if (!(qty > 0) || !(entryPrice > 0)) continue;
        const notional = qty * entryPrice;
        // Track margin requirement (notional / leverage), not full notional
        const marginRequired = notional / leverage;
        inPositionsTotal += marginRequired;
        exposureMap.set(
          position.symbol,
          (exposureMap.get(position.symbol) ?? 0) + marginRequired,
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

    // DISCREPANCY WARNING: Check if there's a significant mismatch (>1 position)
    const previousSnapshot = await liveProvider.getSnapshot();
    const previousPositionsUsd = previousSnapshot.inPositionsUSD.toNumber();
    const positionsDifference = Math.abs(inPositionsValue - previousPositionsUsd);
    
    // Detect discrepancy if difference is more than the equivalent of 1 position at $10 margin
    if (positionsDifference > 10 && totalPositionsCount > 0) {
      console.warn('⚠️ CAPITAL SYNC WARNING [Live Mode]:');
      console.warn(`  Active Sessions: ${sessions.length}`);
      console.warn(`  Total Positions: ${totalPositionsCount}`);
      console.warn(`  Previous In-Position: $${previousPositionsUsd.toFixed(2)}`);
      console.warn(`  New In-Position: $${inPositionsValue.toFixed(2)}`);
      console.warn(`  Difference: $${positionsDifference.toFixed(2)}`);
      console.warn(`  Free Capital: $${freeValue.toFixed(2)}`);
      console.warn('  ⚠️ Possible sync issue detected - verify order visibility in monitoring API');
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
  
  // Persist paper balance to database for restart resilience
  try {
    await prisma.systemSetting.upsert({
      where: { key: 'paper_balance_usd' },
      update: { 
        value: next.toNumber().toString(),
        updatedAt: new Date(),
      },
      create: {
        key: 'paper_balance_usd',
        value: next.toNumber().toString(),
      },
    });
    console.log(`💾 Paper balance persisted to database: $${next.toNumber()}`);
  } catch (error) {
    console.warn('⚠️ Failed to persist paper balance to database:', error);
  }
  
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

// Initialize paper balance from database (called on startup)
export async function initializePaperBalance(): Promise<void> {
  const persistedBalance = await loadPersistedPaperBalance();
  
  if (persistedBalance.toNumber() !== paperManualBase.toNumber()) {
    const snapshot: BalanceSnapshot = {
      totalUSD: persistedBalance,
      freeUSD: persistedBalance,
      reservedUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
      inPositionsUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
      ts: Date.now(),
    };
    
    paperStore.snapshot = snapshot;
    paperManualBase = persistedBalance;
    paperManualFree = persistedBalance;
    
    console.log(`✅ Paper balance initialized from database: $${persistedBalance.toNumber()}`);
  }
}
