#!/usr/bin/env tsx

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlanJson } from '../src/agent/planSchema.js';

process.env.UNIT_TEST_MODE = 'true';
process.env.MARKET_TYPE = process.env.MARKET_TYPE || 'futures';
process.env.EXCHANGE_ID = process.env.EXCHANGE_ID || 'binanceusdm';

function seedRandom(seed: number) {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  Math.random = () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

seedRandom(20241010);

const { runQuickTest } = await import('../src/sim/quicktest.js');

const plans: Record<string, PlanJson> = {
  BTCUSDT: {
    name: 'BTC Momentum Breakout',
    symbol: 'BTCUSDT',
    timeframe: '15m',
    bias: 'long',
    zone: { type: 'support', price: null, from: 'auto_detect' },
    entry_rule: { type: 'rebound', confirm_close: false, max_distance_pct: 0.8 },
    risk: {
      stop: { type: 'atr', mult: 1.3 },
      tp: [
        { type: 'R', value: 1.8 },
        { type: 'R', value: 3.0 },
      ],
      max_hold_hours: 36,
    },
    position: {
      risk_fraction: 0.015,
      risk_fraction_range: { min: 0.01, max: 0.03, recommended: 0.015 },
      max_leverage: 4,
    },
    meta: { playbook: 'momentum_breakout', volatility: 'medium', regime: 'uptrend' },
  },
  WOOUSDT: {
    name: 'WOO Momentum Breakout',
    symbol: 'WOOUSDT',
    timeframe: '15m',
    bias: 'long',
    zone: { type: 'support', price: null, from: 'auto_detect' },
    entry_rule: { type: 'rebound', confirm_close: false, max_distance_pct: 1.6 },
    risk: {
      stop: { type: 'atr', mult: 1.55 },
      tp: [
        { type: 'R', value: 1.4 },
        { type: 'R', value: 2.2 },
      ],
      max_hold_hours: 36,
    },
    position: {
      risk_fraction: 0.018,
      risk_fraction_range: { min: 0.012, max: 0.032, recommended: 0.018 },
      max_leverage: 4,
    },
    meta: { playbook: 'momentum_breakout', volatility: 'high', regime: 'uptrend' },
  },
};

const replaySettings: Record<string, { hours: number; options: Parameters<typeof runQuickTest>[3] }> = {
  BTCUSDT: {
    hours: 96,
    options: {
      tf: '15m',
      targetR: 1.8,
      trailingATRmult: 1.0,
      exitPolicy: 'trend',
      feesBps: 5,
      slippagePct: 0.02,
    },
  },
  WOOUSDT: {
    hours: 168,
    options: {
      tf: '15m',
      targetR: 1.4,
      trailingATRmult: 0.9,
      exitPolicy: 'time',
      maxHoldHours: 48,
      feesBps: 6,
      slippagePct: 0.03,
    },
  },
};
const outputLines: string[] = [];
outputLines.push('# Loss Replay Summary');
outputLines.push('');
outputLines.push(`Generated ${new Date().toISOString()} using quicktest with deterministic synthetic data (UNIT_TEST_MODE).`);
outputLines.push('');

for (const symbol of Object.keys(plans)) {
  const plan = plans[symbol];
  const settings = replaySettings[symbol] ?? replaySettings.BTCUSDT;
  const result = await runQuickTest(symbol, settings.hours, plan, settings.options);

  const stats = result.stats;
  const totalTrades = stats.count;
  const expectancy = stats.avgR;
  const winRate = stats.winrate;
  const avgMAE = stats.avgMAE_R;
  const avgMFE = stats.avgMFE_R;

  outputLines.push(`## ${symbol}`);
  outputLines.push('');
  outputLines.push(`- Playbook: ${plan.meta?.playbook ?? 'n/a'}`);
  outputLines.push(`- Trades: ${totalTrades}`);
  outputLines.push(`- Win rate: ${winRate.toFixed(1)}%`);
  outputLines.push(`- Expectancy (net R): ${expectancy.toFixed(2)}`);
  outputLines.push(`- Avg MAE (R): ${avgMAE.toFixed(2)}`);
  outputLines.push(`- Avg MFE (R): ${avgMFE.toFixed(2)}`);
  outputLines.push('');
  outputLines.push('| Exit Reason | Count | Share |');
  outputLines.push('| --- | ---: | ---: |');

  const reasons = Object.entries(stats.reasonCounts)
    .sort((a, b) => (b[1] as number) - (a[1] as number));

  for (const [reason, count] of reasons) {
    const share = totalTrades > 0 ? ((count as number) / totalTrades) * 100 : 0;
    outputLines.push(`| ${reason} | ${count} | ${share.toFixed(1)}% |`);
  }

  outputLines.push('');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.resolve(__dirname, '../../docs/playbook-loss-summary.md');
fs.writeFileSync(outputPath, outputLines.join('\n'), 'utf8');
console.log(`📄 Wrote summary to ${outputPath}`);
