import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { GuardrailMonitor } = await import('../../dist/src/quantai/strategies/intradayDual/risk.js');
const { loadIntradayConfig, overrideIntradayConfig } = await import('../../dist/src/quantai/strategies/intradayDual/config/index.js');
const { PreciseDecimal } = await import('../../dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');

const baseConfig = loadIntradayConfig();
const restoredConfig = JSON.parse(JSON.stringify(baseConfig));

const disabledCooldownConfig = JSON.parse(JSON.stringify(baseConfig));
disabledCooldownConfig.risk.cooldownLosses = 0;
disabledCooldownConfig.risk.cooldownMinutes = 0;

overrideIntradayConfig(disabledCooldownConfig);

try {
  const monitor = new GuardrailMonitor();
  const symbol = 'BTCUSDT';
  const now = Date.UTC(2024, 0, 1, 0, 0, 0);
  const loss = new PreciseDecimal('-1000');
  const risk = new PreciseDecimal('500');
  const equity = new PreciseDecimal('100000');

  monitor.recordTrade(symbol, loss, risk, equity, now);

  const decision = monitor.canEnter(symbol, now + 1, 'MR');

  assert.equal(decision.allowed, true, 'Cooldown disabled should allow entries after losses');
  assert.equal(decision.reason, undefined, 'Cooldown should not provide a rejection reason');

  console.log('✅ intraday-risk-cooldown-disable.mjs passed');
} finally {
  overrideIntradayConfig(restoredConfig);
}
