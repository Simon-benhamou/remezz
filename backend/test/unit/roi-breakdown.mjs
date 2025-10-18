import assert from 'node:assert/strict';
const { computeRoiBreakdown } = await import('../../dist/src/metrics/kpi.js');
{
  const { realizedPct, netPct } = computeRoiBreakdown(1000, 120, -20);
  assert.equal(Number(realizedPct.toFixed(2)), 12.00);
  assert.equal(Number(netPct.toFixed(2)), 10.00);
}
{
  const { realizedPct, netPct } = computeRoiBreakdown(0, 42, 10);
  assert.equal(realizedPct, 0);
  assert.equal(netPct, 0);
}
console.log('roi-breakdown ✅');
