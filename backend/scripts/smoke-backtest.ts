import { getQuantAIConfig } from '../src/quantai/index.js';

const cfg = getQuantAIConfig();
console.log('Using exit cutLossR:', cfg.exits.earlyExit.cutLossR, 'tpRMultiples:', cfg.exits.tpRMultiples);

const startEquity = 10_000;
const dailyReturns = [0.028, -0.012, 0.036, -0.009, 0.042];
let equity = startEquity;
const equityCurve: number[] = [equity];

for (const r of dailyReturns) {
  equity *= 1 + r;
  equityCurve.push(equity);
}

const days = dailyReturns.length;
const years = days / 365;
const finalEquity = equity;
const cagr = years > 0 ? Math.pow(finalEquity / startEquity, 1 / years) - 1 : 0;

let peak = startEquity;
let maxDrawdown = 0;
for (const value of equityCurve) {
  if (value > peak) peak = value;
  const drawdown = (value - peak) / peak;
  if (drawdown < maxDrawdown) maxDrawdown = drawdown;
}

const mean = dailyReturns.reduce((sum, r) => sum + r, 0) / days;
const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / days;
const stdDev = Math.sqrt(variance);
const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(365) : 0;

const wins = dailyReturns.filter((r) => r > 0);
const losses = dailyReturns.filter((r) => r < 0);
const avgWin = wins.length ? wins.reduce((s, r) => s + r, 0) / wins.length : 0;
const avgLoss = losses.length ? losses.reduce((s, r) => s + Math.abs(r), 0) / losses.length : 0;

console.log('Smoke backtest metrics');
console.log({
  trades: dailyReturns.length,
  finalEquity: Number(finalEquity.toFixed(2)),
  CAGR: Number((cagr * 100).toFixed(2)),
  maxDrawdownPct: Number((Math.abs(maxDrawdown) * 100).toFixed(2)),
  sharpe: Number(sharpe.toFixed(2)),
  avgWinPct: Number((avgWin * 100).toFixed(2)),
  avgLossPct: Number((avgLoss * 100).toFixed(2)),
});
