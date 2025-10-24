import { PreciseDecimal } from '../../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { BalanceProvider, BalanceSnapshot, LedgerDelta, ZERO_USD, toUSD } from './types.js';

type ExchangeBalanceReader = () => Promise<{ total: string | number | PreciseDecimal; free: string | number | PreciseDecimal }>;

export class LiveBalanceProvider implements BalanceProvider {
  constructor(private exchangeClient: { getUsdBalance?: ExchangeBalanceReader }) {}

  async getSnapshot(): Promise<BalanceSnapshot> {
    const { totalUSD, freeUSD } = await this.readFromExchange();
    return {
      totalUSD,
      freeUSD,
      reservedUSD: ZERO_USD,
      inPositionsUSD: ZERO_USD,
      ts: Date.now(),
    };
  }

  async applyLedgerDelta(_delta: LedgerDelta): Promise<void> {
    return;
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
