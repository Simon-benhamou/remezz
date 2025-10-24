import { PreciseDecimal } from '../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { CapitalManager } from '../core/capital/CapitalManager.js';
import { PaperBalanceProvider } from '../core/capital/PaperBalanceProvider.js';
import { LiveBalanceProvider } from '../core/capital/LiveBalanceProvider.js';
import { capitalConfig } from '../config/capital.js';
import { BalanceSnapshot, Reservation, ZERO_USD, toUSD } from '../core/capital/types.js';

const defaultPaperBalance = () => ({
  totalUSD: new PreciseDecimal('1000'),
  freeUSD: new PreciseDecimal('1000'),
  reservedUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
  inPositionsUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
  ts: Date.now(),
});

const paperStore = { snapshot: defaultPaperBalance() };

const paperProvider = new PaperBalanceProvider(paperStore);

const liveStore = {
  snapshot: {
    totalUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
    freeUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
    reservedUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
    inPositionsUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
    ts: Date.now(),
  },
};

const liveProvider = new LiveBalanceProvider({}, liveStore);

const paperManager = new CapitalManager(paperProvider, capitalConfig, {
  reservations: new Map<string, Reservation>(),
  symbolExposure: new Map<string, PreciseDecimal>(),
});

const liveManager = new CapitalManager(liveProvider, capitalConfig, {
  reservations: new Map<string, Reservation>(),
  symbolExposure: new Map<string, PreciseDecimal>(),
});

export function getCapitalManager(mode: 'paper' | 'live'): CapitalManager {
  return mode === 'paper' ? paperManager : liveManager;
}

export function getBalanceSnapshot(mode: 'paper' | 'live'): Promise<BalanceSnapshot> {
  return mode === 'paper' ? paperProvider.getSnapshot() : liveProvider.getSnapshot();
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
  await paperManager.clearLedger();
  return snapshot;
}
