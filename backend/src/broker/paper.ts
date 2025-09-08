import { Broker, NewOrder, PlacedOrder } from './types.js';
import { getTicker } from '../data/market.js';

// Simple paper broker with committed balance and slippage modelling.
export class PaperBroker implements Broker {
  mode: 'paper'|'live' = 'paper';
  private balanceUsd = 10000; // updated on session start
  private committedUsd = 0;
  private feesBps = 5; // 0.05%
  private slippageToSpread = 0.8; // 0.8 * spread

  constructor(startUsd?: number) {
    if (startUsd && startUsd > 0) this.balanceUsd = startUsd;
  }

  async balance() {
    return { freeUsd: Math.max(0, this.balanceUsd - this.committedUsd), equityUsd: this.balanceUsd, committedUsd: this.committedUsd };
  }

  async place(o: NewOrder): Promise<PlacedOrder> {
    const t = await getTicker(o.symbol).catch(()=>null as any);
    const mid = t && t.last ? t.last : (o.price || 0);
    const bid = t?.bid ?? mid * 0.999;
    const ask = t?.ask ?? mid * 1.001;
    const spread = Math.max(1e-8, ask - bid);
    const slip = this.slippageToSpread * spread;

    const px = o.type === 'market' ? (o.side === 'buy' ? ask + slip : bid - slip) : (o.price!);
    const notional = px * o.qty;
    const fee = (this.feesBps / 10000) * notional;

    this.committedUsd += notional; // reserve as if real

    const id = `paper_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const out: PlacedOrder = {
      ...o, id,
      status: 'filled',
      avgPrice: px,
      filledQty: o.qty,
      ts: Date.now(),
    };

    // Simplified PnL handling will be done by agent engine on exit
    this.balanceUsd -= fee; // fees paid
    return out;
  }

  async cancel(_id: string) { /* no-op for filled instantly */ }
}

