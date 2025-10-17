import assert from 'node:assert/strict';
const { aggregateFillsToLedgerTrades } = await import('../../dist/src/services/performance/tradeLedger.js');

function buildFill({ ts, side, qty, price, fee = 0, realizedPnl = 0, orderId, leverage = null, symbol = 'SUI/USDT', sessionId = 'session-1' }) {
  return { ts: new Date(ts), side, qty, price, fee, realizedPnl, orderId, leverage, symbol, sessionId };
}

{
  const fills = [
    buildFill({ ts: '2024-01-01T00:00:00Z', side: 'buy', qty: 2, price: 10, fee: 0.08, orderId: 'entry-1', leverage: 2 }),
    buildFill({ ts: '2024-01-01T00:05:00Z', side: 'sell', qty: 1, price: 12, fee: 0.04, realizedPnl: 2, orderId: 'exit-1' }),
    buildFill({ ts: '2024-01-01T00:10:00Z', side: 'sell', qty: 1, price: 13, fee: 0.04, realizedPnl: 3, orderId: 'exit-2' }),
  ];

  const trades = aggregateFillsToLedgerTrades(fills);
  assert.equal(trades.length, 1, 'expected aggregated trade');
  const trade = trades[0];
  assert.equal(trade.positionSide, 'long');
  assert.equal(trade.qty.toFixed(8), '2.00000000');
  assert.equal(Number(trade.realizedPnlUsd.toFixed(8)), 5);
  assert.equal(Number(trade.feesUsd.toFixed(8)), 0.16);
  assert.equal(Number(trade.roiPct?.toFixed(2)), 25);
  assert.equal(trade.orderCount, 3);
  assert.deepEqual(new Set(trade.exitOrderIds), new Set(['exit-1', 'exit-2']));
}

{
  const fills = [
    buildFill({ ts: '2024-02-01T00:00:00Z', side: 'buy', qty: 1, price: 100, fee: 0.05, orderId: 'long-entry', leverage: 3 }),
    buildFill({ ts: '2024-02-01T00:05:00Z', side: 'sell', qty: 2, price: 110, fee: 0.06, realizedPnl: 10, orderId: 'flip-exit' }),
    buildFill({ ts: '2024-02-01T00:15:00Z', side: 'buy', qty: 1, price: 105, fee: 0.05, realizedPnl: 5, orderId: 'short-exit' }),
  ];

  const trades = aggregateFillsToLedgerTrades(fills);
  assert.equal(trades.length, 2, 'expected two trades from flip order');
  const [longTrade, shortTrade] = trades;

  assert.equal(longTrade.positionSide, 'long');
  assert.equal(Number(longTrade.realizedPnlUsd.toFixed(2)), 10);
  assert.equal(Number(longTrade.roiPct?.toFixed(2)), 10);
  assert.equal(longTrade.orderCount, 2);

  assert.equal(shortTrade.positionSide, 'short');
  assert.equal(Number(shortTrade.realizedPnlUsd.toFixed(2)), 5);
  assert.equal(Number(shortTrade.roiPct?.toFixed(2)), 4.55);
  assert.equal(shortTrade.orderCount, 2);
}

console.log('trade-ledger-aggregation ✅');
