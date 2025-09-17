import { Broker, NewOrder, PlacedOrder } from './types.js';
import { exchange, resolveSymbol } from '../exchange/ccxtClient.js';
import { emitAlert } from '../monitor/policy.js';
import { getConfig } from '../utils/env.js';
import { logImprovementAuto } from '../monitor/backlog.js';

// Minimal ccxt-backed live broker (spot or swap per env config)
export class LiveBroker implements Broker {
  mode: 'paper'|'live' = 'live';

  async balance() {
    const ex = await exchange();
    const b = await ex.fetchBalance();
    const raw = Array.isArray(b?.info?.result?.data) ? b.info.result.data[0] : undefined;

    const num = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    const avail = num(raw?.total_available_balance);
    const marginBal = num(raw?.total_margin_balance) ?? num(raw?.total_collateral_value);
    const positionCost = num(raw?.total_position_cost);

    // Fallbacks to legacy spot fields if derivatives-specific fields are absent.
    const fallbackTotal = (b?.total?.USDT ?? 0) + (b?.total?.USD ?? 0);
    const fallbackFree = (b?.free?.USDT ?? 0) + (b?.free?.USD ?? 0);

    const equityUsd = marginBal ?? fallbackTotal;
    const freeUsd = avail ?? fallbackFree;
    let committedUsd = positionCost ?? (Number.isFinite(equityUsd) && Number.isFinite(freeUsd)
      ? Math.max(0, equityUsd - freeUsd)
      : 0);
    if (!Number.isFinite(committedUsd)) committedUsd = 0;

    return {
      freeUsd: Number.isFinite(freeUsd) ? freeUsd : 0,
      equityUsd: Number.isFinite(equityUsd) ? equityUsd : 0,
      committedUsd,
    };
  }

  async place(o: NewOrder): Promise<PlacedOrder> {
    const ex = await exchange();
    const symbol = await resolveSymbol(o.symbol);
    const startTs = Date.now();

    // Try set leverage if available and provided
    if (o.leverage && typeof (ex as any).setLeverage === 'function') {
      try { await (ex as any).setLeverage(o.leverage, symbol); } catch {}
    }

    let order: any;
    const params: any = {};
    const tif = o.type === 'limit' ? (o.timeInForce || 'GTC') : o.timeInForce;
    if (o.reduceOnly) params.reduceOnly = true;
    if (o.postOnly) params.postOnly = true;
    if (o.timeInForce) params.timeInForce = o.timeInForce;
    const cfg = getConfig();
    const deadline = Date.now() + Math.max(1000, cfg.ORDER_FILL_TIMEOUT_SEC * 1000);
    const pollMs = Math.max(100, cfg.ORDER_FILL_POLL_MS);
    const maxRetry = Math.max(0, cfg.ORDER_RETRY_MAX);
    let attempts = 1;
    let cancelCount = 0;

    async function waitForFill(ordId: string) {
      while (Date.now() < deadline) {
        try {
          const fo = await ex.fetchOrder(ordId, symbol).catch(()=>null);
          const st = String(fo?.status || '').toLowerCase();
          if (st.includes('closed') || st.includes('filled')) return { filledQty: Number(fo?.filled||0), avgPrice: Number(fo?.average||fo?.price||0), status: 'filled' };
          if (st.includes('canceled') || st.includes('rejected')) return { filledQty: Number(fo?.filled||0), avgPrice: Number(fo?.average||fo?.price||0), status: 'rejected' };
        } catch {}
        await new Promise(r=> setTimeout(r, pollMs));
      }
      return { filledQty: undefined, avgPrice: undefined, status: 'open' } as any;
    }
    try {
      if (o.type === 'market') {
        order = await ex.createOrder(symbol, 'market', o.side, o.qty, undefined, params);
      } else {
        const limitParams: any = { ...params };
        if (tif) limitParams.timeInForce = tif;
        order = await ex.createOrder(symbol, 'limit', o.side, o.qty, o.price, limitParams);
      }
    } catch (e: any) {
      const details = { error: String(e?.message||e), symbol, side: o.side, qty: o.qty };
      try { await emitAlert({ kind:'capacity_breach' as any, severity:'med', details }); } catch {}
      await logImprovementAuto({
        title: 'Capacity breach when placing order',
        description: `Exchange rejected order ${o.side} ${o.qty} ${symbol}.`,
        severity: 'high',
        tags: ['execution', 'capacity'],
        context: details,
      });
      return { ...o, id: 'rejected', status: 'rejected', ts: Date.now() };
    }

    const filledQty = Number(order?.filled ?? 0) || undefined;
    const avgPrice = Number(order?.average ?? order?.price ?? o.price) || undefined;
    const status: PlacedOrder['status'] = (order?.status === 'closed' || order?.status === 'filled') ? 'filled'
      : (order?.status === 'canceled' ? 'canceled' : 'open');

    const id = String(order?.id || order?.clientOrderId || '');
    let placed: PlacedOrder = { ...o, id, status, filledQty, avgPrice, ts: Date.now() };

    // Ensure fill: poll and retry if needed
    if (placed.status !== 'filled') {
      const res = await waitForFill(id);
      if (res.status === 'filled') {
        placed = { ...placed, status: 'filled', filledQty: res.filledQty, avgPrice: res.avgPrice };
      } else if (res.status !== 'rejected') {
        try { await ex.cancelOrder(id, symbol).catch(()=>{}); cancelCount += 1; } catch {}
        let retry = 0;
        while (retry < maxRetry) {
          retry++;
          attempts = retry + 1;
          try {
            const re = await ex.createOrder(symbol, 'market', o.side, o.qty, undefined, params);
            const rid = String(re?.id || re?.clientOrderId || '');
            const rr = await waitForFill(rid);
            if (rr.status === 'filled') { placed = { ...placed, id: rid, status:'filled', filledQty: rr.filledQty, avgPrice: rr.avgPrice }; break; }
          } catch {}
        }
        if (placed.status !== 'filled') {
          try { await emitAlert({ kind:'order_unfilled' as any, severity:'high', details:{ symbol, side:o.side, qty:o.qty } }); } catch {}
          placed.status = 'rejected';
        }
      } else {
        placed.status = 'rejected';
      }
    }

    placed.latencyMs = Math.max(0, Date.now() - startTs);
    placed.attempts = attempts;
    placed.cancelCount = cancelCount;
    placed.requestedQty = o.qty;
    placed.requestedPrice = o.type === 'limit' ? o.price : undefined;

    // Best-effort: create protective SL/TP orders if provided
    try {
      if (placed.status==='filled' && placed.filledQty && placed.avgPrice && (o.stopLoss || o.takeProfit)) {
        const reduceSide = o.side === 'buy' ? 'sell' : 'buy';
        // Stop-loss as stop-market
        if (o.stopLoss) {
          try {
            const slParams: any = { reduceOnly: true, stopPrice: o.stopLoss, triggerPrice: o.stopLoss };
            // Vendor-guard for Crypto.com swaps: hint stop type when supported
            if (String(ex.id).toLowerCase() === 'cryptocom') slParams.type = 'stop_market';
            const slo = await ex.createOrder(symbol, 'market', reduceSide, placed.filledQty, undefined, slParams);
            placed.slOrderId = String(slo?.id || slo?.clientOrderId || '');
          } catch {}
        }
        // Take-profit as limit reduce-only
        if (o.takeProfit) {
          try {
            const tpParams: any = { reduceOnly: true, takeProfitPrice: o.takeProfit };
            if (String(ex.id).toLowerCase() === 'cryptocom') tpParams.type = 'take_profit_limit';
            const tpo = await ex.createOrder(symbol, 'limit', reduceSide, placed.filledQty, o.takeProfit, tpParams);
            placed.tpOrderId = String(tpo?.id || tpo?.clientOrderId || '');
          } catch {}
        }
      }
    } catch {}

    return placed;
  }

  async cancel(id: string) {
    const ex = await exchange();
    try { await ex.cancelOrder(id); } catch {}
  }

  async syncProtective(params: { symbol: string; side: 'buy'|'sell'; qty: number; stopLoss?: number; takeProfit?: number; slOrderId?: string|null; tpOrderId?: string|null }) {
    const ex = await exchange();
    const symbol = await resolveSymbol(params.symbol);
    const reduceSide = params.side === 'buy' ? 'sell' : 'buy';
    const result: { slOrderId?: string; tpOrderId?: string } = {};
    if (params.slOrderId) {
      try { await ex.cancelOrder(params.slOrderId, symbol).catch(()=>{}); } catch {}
    }
    if (params.tpOrderId) {
      try { await ex.cancelOrder(params.tpOrderId, symbol).catch(()=>{}); } catch {}
    }
    if (params.stopLoss) {
      try {
        const slParams: any = { reduceOnly: true, stopPrice: params.stopLoss, triggerPrice: params.stopLoss };
        if (String(ex.id).toLowerCase() === 'cryptocom') slParams.type = 'stop_market';
        const slo = await ex.createOrder(symbol, 'market', reduceSide, params.qty, undefined, slParams);
        result.slOrderId = String(slo?.id || slo?.clientOrderId || '');
      } catch {}
    }
    if (params.takeProfit) {
      try {
        const tpParams: any = { reduceOnly: true, takeProfitPrice: params.takeProfit };
        if (String(ex.id).toLowerCase() === 'cryptocom') tpParams.type = 'take_profit_limit';
        const tpo = await ex.createOrder(symbol, 'limit', reduceSide, params.qty, params.takeProfit, tpParams);
        result.tpOrderId = String(tpo?.id || tpo?.clientOrderId || '');
      } catch {}
    }
    return result;
  }
}

// Inspect current live exposure for a symbol.
// Returns null if no position or exchange doesn't support positions for current market type.
export async function inspectExposure(symbol: string): Promise<{ side: 'buy'|'sell'; qty: number; entry?: number } | null> {
  const ex = await exchange();
  const s = await resolveSymbol(symbol);
  try {
    // Try unified positions API (perps/swaps)
    if (typeof (ex as any).fetchPositions === 'function') {
      const positions = await (ex as any).fetchPositions([s]).catch(()=>[]);
      const p = Array.isArray(positions) ? positions.find((x:any)=> (x?.symbol === s) && Math.abs(Number(x?.contracts || x?.size || x?.positionAmt || 0)) > 0) : null;
      if (p) {
        const rawSize = Number(p.contracts || p.size || p.positionAmt || 0);
        const qty = Math.abs(rawSize);
        if (qty > 0) {
          const side: 'buy'|'sell' = rawSize > 0 ? 'buy' : 'sell';
          const entry = Number(p.entryPrice || p.avgEntryPrice || p.average || p.markPrice || 0) || undefined;
          return { side, qty, entry };
        }
      }
    }
  } catch {}

  // Fallback (spot): only infer from balances when explicitly trading spot pairs.
  // For swaps/perps the exchange may not report positions, but using spot balances would
  // create "ghost" exposures when residual tokens sit in the wallet. Guard with market type.
  try {
    const marketType = String(process.env.MARKET_TYPE || 'spot').toLowerCase();
    if (marketType === 'spot' && ex.markets && ex.markets[s]) {
      const base = ex.markets[s].base;
      const b = await ex.fetchBalance();
      const held = Number((b?.total?.[base] ?? b?.free?.[base] ?? 0));
      if (held > 0) return { side: 'buy', qty: held };
    }
  } catch {}

  return null;
}
