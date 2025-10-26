import { BalanceProvider, BalanceSnapshot, LedgerDelta, ZERO_USD } from './types.js';

export class PaperBalanceProvider implements BalanceProvider {
  constructor(private store: { snapshot: BalanceSnapshot }) {}

  async getSnapshot(): Promise<BalanceSnapshot> {
    const snap = this.store.snapshot;
    return {
      totalUSD: snap.totalUSD,
      freeUSD: snap.freeUSD,
      reservedUSD: snap.reservedUSD,
      inPositionsUSD: snap.inPositionsUSD,
      ts: snap.ts,
    };
  }

  async applyLedgerDelta(delta: LedgerDelta): Promise<void> {
    const s = this.store.snapshot;
    const freeDelta = delta.freeUSD ?? ZERO_USD;
    const reservedDelta = delta.reservedUSD ?? ZERO_USD;
    const inPositionsDelta = delta.inPositionsUSD ?? ZERO_USD;

    const freeUSD = s.freeUSD.plus(freeDelta);
    const reservedUSD = s.reservedUSD.plus(reservedDelta);
    const inPositionsUSD = s.inPositionsUSD.plus(inPositionsDelta);
    const totalUSD = freeUSD.plus(reservedUSD).plus(inPositionsUSD);

    this.store.snapshot = {
      totalUSD,
      freeUSD,
      reservedUSD,
      inPositionsUSD,
      ts: Date.now(),
    };
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
