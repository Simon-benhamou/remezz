import { PreciseDecimal } from '../../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { BalanceProvider, BalanceSnapshot, LedgerDelta, ZERO_USD, toUSD } from './types.js';

type ExchangeBalanceReader = () => Promise<{ total: string | number | PreciseDecimal; free: string | number | PreciseDecimal }>;

export class LiveBalanceProvider implements BalanceProvider {
  private reservedUSD = ZERO_USD;
  private inPositionsUSD = ZERO_USD;

  constructor(private exchangeClient: { getUsdBalance?: ExchangeBalanceReader }) {}

  async getSnapshot(): Promise<BalanceSnapshot> {
    const { totalUSD, freeUSD: exchangeFreeUSD } = await this.readFromExchange();
    const reservedUSD = this.reservedUSD.raw > ZERO_USD.raw ? this.reservedUSD : ZERO_USD;
    const inPositionsUSD = this.inPositionsUSD.raw > ZERO_USD.raw ? this.inPositionsUSD : ZERO_USD;

    const adjustedFreeCandidate = exchangeFreeUSD.minus(reservedUSD);
    const freeUSD = adjustedFreeCandidate.raw >= ZERO_USD.raw ? adjustedFreeCandidate : ZERO_USD;

    return {
      totalUSD,
      freeUSD,
      reservedUSD,
      inPositionsUSD,
      ts: Date.now(),
    };
  }

  async applyLedgerDelta(delta: LedgerDelta): Promise<void> {
    if (delta.reservedUSD) {
      this.reservedUSD = this.reservedUSD.plus(delta.reservedUSD);
      if (this.reservedUSD.raw < ZERO_USD.raw) {
        this.reservedUSD = ZERO_USD;
      }
    }

    if (delta.inPositionsUSD) {
      this.inPositionsUSD = this.inPositionsUSD.plus(delta.inPositionsUSD);
      if (this.inPositionsUSD.raw < ZERO_USD.raw) {
        this.inPositionsUSD = ZERO_USD;
      }
    }
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
