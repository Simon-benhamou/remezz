import { PreciseDecimal } from '../../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { BalanceProvider, BalanceSnapshot, LedgerDelta, ZERO_USD, toUSD } from './types.js';

type ExchangeBalanceReader = () => Promise<{ total: string | number | PreciseDecimal; free: string | number | PreciseDecimal }>;

export class LiveBalanceProvider implements BalanceProvider {
  private store: { snapshot: BalanceSnapshot };

  constructor(
    private exchangeClient: { getUsdBalance?: ExchangeBalanceReader },
    store?: { snapshot: BalanceSnapshot },
  ) {
    this.store =
      store ?? {
        snapshot: {
          totalUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
          freeUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
          reservedUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
          inPositionsUSD: PreciseDecimal.fromRaw(ZERO_USD.raw),
          ts: Date.now(),
        },
      };
  }

  async getSnapshot(): Promise<BalanceSnapshot> {
    const { totalUSD } = await this.readFromExchange();
    const current = this.store.snapshot;

    const ledgerTotal = current.freeUSD.plus(current.reservedUSD).plus(current.inPositionsUSD);
    const deltaTotal = totalUSD.minus(ledgerTotal);
    let nextFree = current.freeUSD.plus(deltaTotal);
    if (nextFree.raw < ZERO_USD.raw) {
      nextFree = PreciseDecimal.fromRaw(ZERO_USD.raw);
    }

    const snapshot: BalanceSnapshot = {
      totalUSD: nextFree.plus(current.reservedUSD).plus(current.inPositionsUSD),
      freeUSD: nextFree,
      reservedUSD: current.reservedUSD,
      inPositionsUSD: current.inPositionsUSD,
      ts: Date.now(),
    };
    this.store.snapshot = snapshot;
    return snapshot;
  }

  async applyLedgerDelta(_delta: LedgerDelta): Promise<void> {
    const delta = _delta ?? {};
    const freeDelta = delta.freeUSD ?? ZERO_USD;
    const reservedDelta = delta.reservedUSD ?? ZERO_USD;
    const inPositionsDelta = delta.inPositionsUSD ?? ZERO_USD;

    const current = this.store.snapshot;
    const freeUSD = current.freeUSD.plus(freeDelta);
    const reservedUSD = current.reservedUSD.plus(reservedDelta);
    const inPositionsUSD = current.inPositionsUSD.plus(inPositionsDelta);
    const totalUSD = freeUSD.plus(reservedUSD).plus(inPositionsUSD);

    this.store.snapshot = {
      totalUSD,
      freeUSD,
      reservedUSD,
      inPositionsUSD,
      ts: Date.now(),
    };
  }

  private async readFromExchange(): Promise<{ totalUSD: PreciseDecimal; freeUSD: PreciseDecimal }> {
    if (this.exchangeClient?.getUsdBalance) {
      try {
        const { total, free } = await this.exchangeClient.getUsdBalance();
        return { totalUSD: toUSD(total), freeUSD: toUSD(free) };
      } catch {
        // fall through to zero snapshot on failure
      }
    }
    return { totalUSD: ZERO_USD, freeUSD: ZERO_USD };
  }

  setSnapshot(snapshot: BalanceSnapshot): void {
    this.store.snapshot = {
      totalUSD: snapshot.totalUSD,
      freeUSD: snapshot.freeUSD,
      reservedUSD: snapshot.reservedUSD,
      inPositionsUSD: snapshot.inPositionsUSD,
      ts: snapshot.ts ?? Date.now(),
    };
  }
}
