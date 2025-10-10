import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const { computeAtrRiskParams, generateStrategy } = await import('../../dist/src/ai/orchestrator.js');
const { computeAdaptiveRisk } = await import('../../dist/src/risk/adaptive.js');
const { prisma } = await import('../../dist/src/db/client.js');

function makeSnapshot(symbol, atrPct, overrides = {}) {
  const last = overrides.last ?? 100;
  const support = overrides.support ?? last * 0.98;
  const resistance = overrides.resistance ?? last * 1.02;
  const base = {
    symbol,
    last,
    ema20: overrides.ema20 ?? last * 0.999,
    ema50: overrides.ema50 ?? last * 0.995,
    ema100: overrides.ema100 ?? last * 0.99,
    ema200: overrides.ema200 ?? last * 0.985,
    rsi14: overrides.rsi14 ?? 52,
    atr14: overrides.atr14 ?? (last * atrPct) / 100,
    atrPct,
    adx14: overrides.adx14 ?? 18,
    ema20Slope: overrides.ema20Slope ?? 0,
    support,
    resistance,
    supports: overrides.supports ?? [{ price: support, label: 'mock-support', touches: 3, strength: 2 }],
    resistances: overrides.resistances ?? [{ price: resistance, label: 'mock-resistance', touches: 2, strength: 2 }],
    pivots: overrides.pivots ?? {
      P: last,
      S1: last * 0.99,
      S2: last * 0.98,
      R1: last * 1.01,
      R2: last * 1.02,
      refDay: new Date().toISOString().slice(0, 10)
    },
    trend: overrides.trend ?? 0.6,
    srBias: overrides.srBias ?? 'nearSupport',
    meta: overrides.meta ?? { tf: '15m', windowBars: 300, recentBarsFor24h: 96 },
    realizedVol: overrides.realizedVol ?? 65,
    hurst: overrides.hurst ?? 0.52,
    adxSlope: overrides.adxSlope ?? 0,
    trendStrength: overrides.trendStrength ?? 0.5,
    trendBias: overrides.trendBias ?? 'bullish',
    regime: overrides.regime ?? undefined,
    volume: overrides.volume ?? 1_000_000,
    volumeMA: overrides.volumeMA ?? 900_000,
    volumeAvg: overrides.volumeAvg ?? 950_000,
    volume24h: overrides.volume24h ?? 50_000_000,
    volume24hChangePct: overrides.volume24hChangePct ?? 4.2,
    cmf20: overrides.cmf20 ?? 0.15,
  };
  return base;
}

function buildLLMResponse(symbol, trigger, stop, target) {
  return JSON.stringify({
    strategyId: `${trigger}:${Date.now()}`,
    symbol,
    bias: 'long',
    confidence: 0.82,
    entry: {
      type: 'limit',
      price: 100,
      zone: { min: 99, max: 101 },
      confirmations: ['stub']
    },
    risk: {
      stop: { type: 'percent', value: stop },
      target: { type: 'percent', value: target },
      risk_pct_balance: 1.0,
      max_leverage: 5
    },
    validity: { from: new Date().toISOString(), to: null },
    rationale: 'stub rationale',
    trigger
  });
}

async function resetDb() {
  if (typeof prisma.$reset === 'function') {
    await prisma.$reset();
  } else {
    await prisma.fill.deleteMany();
    await prisma.order.deleteMany();
    await prisma.agentSession.deleteMany();
  }
}

async function createSession(sessionId, symbol) {
  await prisma.agentSession.create({
    data: {
      id: sessionId,
      symbol,
      mode: 'paper',
      profileJson: { riskPerTradePct: 1 },
    },
  });
}

async function seedExitOrders(sessionId, symbol, pctChanges) {
  const now = Date.now();
  let idx = 0;
  for (const pct of pctChanges) {
    const ts = new Date(now - idx * 60_000);
    await prisma.order.create({
      data: {
        clientOrderId: `${sessionId}-${symbol}-${idx}.exit`,
        sessionId,
        symbol,
        side: pct >= 0 ? 'sell' : 'buy',
        type: 'market',
        qty: 1,
        price: 1,
        pctChange: pct,
        leverage: 1,
        status: 'filled',
        createdAt: ts,
        updatedAt: ts,
      },
    });
    idx += 1;
  }
}

// --- LLM path should clamp risk into ATR-derived bounds --- //
const llmSnapshot = makeSnapshot('BTC/USDT', 1.4, { trend: 0.9, srBias: 'nearSupport' });
const llmParams = computeAtrRiskParams(llmSnapshot.symbol, llmSnapshot.atrPct);
const llmRaw = buildLLMResponse(llmSnapshot.symbol, 'llm-case', llmParams.stopBounds.min / 4, llmParams.targetBounds.max * 2);
const llmStub = async () => llmRaw;
const llmStrategy = await generateStrategy(llmSnapshot.symbol, 'llm-case', { llm: llmStub, snapshot: llmSnapshot });

assert.equal(llmStrategy.risk.stop.type, 'percent');
assert.equal(llmStrategy.risk.target.type, 'percent');
assert(llmStrategy.risk.stop.value >= llmParams.stopBounds.min - 1e-9 && llmStrategy.risk.stop.value <= llmParams.stopBounds.max + 1e-9,
  `Stop ${llmStrategy.risk.stop.value} should lie within ATR bounds ${JSON.stringify(llmParams.stopBounds)}`);
assert(llmStrategy.risk.target.value >= llmParams.targetBounds.min - 1e-9 && llmStrategy.risk.target.value <= llmParams.targetBounds.max + 1e-9,
  `Target ${llmStrategy.risk.target.value} should lie within ATR bounds ${JSON.stringify(llmParams.targetBounds)}`);
assert(llmStrategy.risk.target.value > llmStrategy.risk.stop.value, 'Target must exceed stop after normalization');

// --- Fallback rule-based generation should derive ATR anchored risk --- //
const fallbackSnapshot = makeSnapshot('DOGE/USDT', 2.7, {
  trend: -0.4,
  srBias: 'nearResistance',
  support: 0.095,
  resistance: 0.105,
  supports: [{ price: 0.094, label: 'support', touches: 2, strength: 2 }],
  resistances: [{ price: 0.105, label: 'resistance', touches: 3, strength: 3 }],
  trendBias: 'bearish'
});
const fallbackParams = computeAtrRiskParams(fallbackSnapshot.symbol, fallbackSnapshot.atrPct);
const failingLLM = async () => { throw new Error('LLM offline'); };
const fallbackStrategy = await generateStrategy(fallbackSnapshot.symbol, 'fallback-case', { llm: failingLLM, snapshot: fallbackSnapshot });

assert.equal(fallbackStrategy.risk.stop.type, 'percent');
assert.equal(fallbackStrategy.risk.target.type, 'percent');
assert(Math.abs(fallbackStrategy.risk.stop.value - fallbackParams.stopPct) < 1e-6,
  `Fallback stop ${fallbackStrategy.risk.stop.value} should match recommended ${fallbackParams.stopPct}`);
assert(fallbackStrategy.risk.target.value >= fallbackParams.targetBounds.min - 1e-9 && fallbackStrategy.risk.target.value <= fallbackParams.targetBounds.max + 1e-9,
  `Fallback target ${fallbackStrategy.risk.target.value} should lie within ATR bounds ${JSON.stringify(fallbackParams.targetBounds)}`);
assert(fallbackStrategy.risk.target.value > fallbackStrategy.risk.stop.value, 'Fallback target must exceed stop');

// --- Adaptive risk engine --- //
await resetDb();
const goodSessionId = 'session-good';
await createSession(goodSessionId, 'AGIXUSDT');
await seedExitOrders(goodSessionId, 'AGIXUSDT', [1.4, 1.1, 1.2, 1.3, 1.0, 1.05, 1.25]);
await seedExitOrders(goodSessionId, 'ETCUSDT', [0.9, 1.0, 0.95, 1.1, 0.85]);
await seedExitOrders(goodSessionId, 'BADUSDT', [0.2, -0.3, 0.1, -0.1]);

const adaptivePositive = await computeAdaptiveRisk(goodSessionId, 1);
assert(adaptivePositive.appliedSymbolMultiplier > 1, 'Top symbol should earn a multiplier above 1');
assert(adaptivePositive.riskPct > 1, 'Adaptive risk should increase sizing for strong Sharpe/low drawdown');
assert(adaptivePositive.symbolMultipliers.AGIXUSDT.multiplier >= adaptivePositive.appliedSymbolMultiplier,
  'Dominant symbol multiplier should match applied boost');

await resetDb();
const flatSessionId = 'session-flat';
await createSession(flatSessionId, 'BTCUSDT');
await seedExitOrders(flatSessionId, 'BTCUSDT', [0.5, -0.5, 0.4, -0.4, 0.3, -0.3, 0.2, -0.2]);

const adaptiveFlat = await computeAdaptiveRisk(flatSessionId, 1);
assert.equal(adaptiveFlat.appliedSymbolMultiplier, 1, 'No multiplier should be applied when performance is mixed');
assert.equal(adaptiveFlat.riskPct, 1, 'Baseline risk should remain unchanged for underperforming stats');

console.log('✅ strategy-atr-risk.mjs passed');
