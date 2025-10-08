import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const { ReboundRejectionAgent } = await import('../../dist/src/agent/state.js');

function createAgent() {
  const agent = new ReboundRejectionAgent();
  agent.profile = {
    mode: 'paper',
    symbol: 'SOL/USDT:USDT',
    maxLeverage: 3,
    riskPerTradePct: 1.5,
    dailyLossLimitPct: 3.5,
    startBalanceUsd: 5000,
  };

  agent.plan = {
    plan: {
      risk: {
        max_hold_hours: 36,
        tp: [{ value: 2 }],
      },
    },
    symbol: 'SOL/USDT:USDT',
    tf: '15m',
    bias: 'short',
    zone: { from: 229, to: 231, mid: 230 },
    atr: 1,
    atrPct: 0.5,
    stopDistance: 11,
    rPrices: [{ r: 2, price: 208 }],
    entryOkNow: true,
    sizing: { riskPct: 1.5, maxLev: 3, notionalUsd: 1500 },
    guards: { spreadOk: true, leverageOk: true, volumeOk: true },
  };

  agent.pos = {
    side: 'sell',
    entry: 221,
    qty: 1,
    stop: 232,
    tp: [218],
    openedAt: Date.now() - 60_000,
    extended: false,
    maeR: 0,
    mfeR: 0,
  };

  agent.state = 'MANAGE';

  return agent;
}

function makeSnap(price, overrides = {}) {
  return {
    symbol: 'SOL/USDT:USDT',
    last: price,
    ema20: overrides.ema20 ?? price + 1.2,
    ema50: overrides.ema50 ?? price - 1.2,
    rsi14: overrides.rsi14 ?? 58,
    adx14: overrides.adx14 ?? 22,
    volume24h: overrides.volume24h ?? 0,
    volumeMA: overrides.volumeMA ?? 0,
  };
}

const agent = createAgent();

const checkExit = (price, overrides) => agent['checkExitConditions'](price, makeSnap(price, overrides));

// 1. Small adverse bounce should NOT trigger immediate exit
let reason = checkExit(222, {});
assert.equal(reason, null, 'should buffer small adverse bounce');
assert.equal(agent['trendReversalContext']?.count, 1, 'should record buffered signal');

reason = checkExit(222, {});
assert.equal(reason, null, 'should keep buffering repeated small signals');
assert.equal(agent['trendReversalContext']?.count, 2, 'should increment buffer count');

reason = checkExit(222, {});
assert.equal(reason, null, 'should still buffer when adverse R below threshold');
assert.equal(agent['trendReversalContext']?.count, 3, 'buffer should continue counting');

// 2. Move back in favor should clear the buffer context
reason = checkExit(219, { ema20: 217, ema50: 223 });
assert.equal(reason, null, 'favorable move should not exit');
assert.equal(agent['trendReversalContext'], null, 'favorable move should reset buffer');

// 3. A decisive reversal beyond the adverse R threshold should exit immediately
reason = checkExit(225.5, {});
assert.equal(reason, 'trend_reversal_detected', 'decisive adverse move should exit');
assert.equal(agent['trendReversalContext'], null, 'context cleared after exit signal');

console.log('✅ trend-reversal-buffer.mjs passed');
