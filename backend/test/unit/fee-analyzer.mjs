import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

const { computeFeeSummary } = await import('../../dist/src/analytics/feeAnalyzer.js');
const { PreciseDecimal } = await import('../../dist/src/quantai/strategy/metaAdaptiveAgent.js');

const dataPath = path.resolve(process.cwd(), 'data/order-history/oct18-19-agent-orders.json');
const payload = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

const orders = Array.isArray(payload.orders) ? payload.orders : [];
assert(orders.length > 0, 'Sample order history should not be empty');

const summary = computeFeeSummary(orders, '4');

assert.equal(summary.ordersEvaluated, orders.length, 'All orders should be evaluated');
assert(summary.totalNotionalUsd.gt(0), 'Total notional must be positive');
assert(summary.totalFeeUsd.gt(0), 'Total fees must be positive');

const expectedFee = new PreciseDecimal('53.126912');
assert.equal(summary.totalFeeUsd.toFixed(6), expectedFee.toFixed(6), 'Fee total should match expected benchmark');

const expectedAvgFee = expectedFee.dividedBy(new PreciseDecimal(orders.length.toString()));
assert.equal(summary.avgFeePerOrderUsd.toFixed(6), expectedAvgFee.toFixed(6), 'Average fee mismatch');

console.log('✅ fee analyzer unit test passed');
