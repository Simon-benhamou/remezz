import { PreciseDecimal } from '../../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { BalanceProvider, BalanceSnapshot, LedgerDelta, ZERO_USD, toUSD, usdMax } from './types.js';

type ExchangeBalanceReader = () => Promise<{ total: string | number | PreciseDecimal; free: string | number | PreciseDecimal }>;

export class LiveBalanceProvider implements BalanceProvider {
  private snapshot: BalanceSnapshot | null = null;

  constructor(private exchangeClient: { getUsdBalance?: ExchangeBalanceReader }) {}

  async getSnapshot(): Promise<BalanceSnapshot> {
    await this.ensureSnapshot();
    const snap = this.snapshot!;
    const next: BalanceSnapshot = {
      totalUSD: snap.totalUSD,
      freeUSD: snap.freeUSD,
      reservedUSD: snap.reservedUSD,
      inPositionsUSD: snap.inPositionsUSD,
      ts: Date.now(),
    };
    this.snapshot = next;
    return next;
  }

  async applyLedgerDelta(delta: LedgerDelta): Promise<void> {
    await this.ensureSnapshot();
    const snap = this.snapshot!;
    const freeDelta = delta.freeUSD ?? ZERO_USD;
    const reservedDelta = delta.reservedUSD ?? ZERO_USD;
    const inPositionsDelta = delta.inPositionsUSD ?? ZERO_USD;

    const freeUSD = snap.freeUSD.plus(freeDelta);
    const reservedUSD = snap.reservedUSD.plus(reservedDelta);
    const inPositionsUSD = snap.inPositionsUSD.plus(inPositionsDelta);
    const totalUSD = freeUSD.plus(reservedUSD).plus(inPositionsUSD);

    this.snapshot = {
      totalUSD,
      freeUSD,
      reservedUSD,
      inPositionsUSD,
      ts: Date.now(),
    };
  }

  private async ensureSnapshot(): Promise<void> {
    if (this.snapshot) return;
    const base = await this.readFromExchange();
    const locked = base.totalUSD.minus(base.freeUSD);
    const inPositionsUSD = usdMax(locked, ZERO_USD);
    this.snapshot = {
      totalUSD: base.totalUSD,
      freeUSD: base.freeUSD,
      reservedUSD: ZERO_USD,
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
}
