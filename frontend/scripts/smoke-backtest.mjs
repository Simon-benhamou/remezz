const equitySeries = [
  { timestamp: "2024-10-01T00:00:00Z", equity: 10_000_000n },
  { timestamp: "2024-10-02T00:00:00Z", equity: 10_150_000n },
  { timestamp: "2024-10-03T00:00:00Z", equity: 10_080_000n },
  { timestamp: "2024-10-04T00:00:00Z", equity: 10_320_000n },
  { timestamp: "2024-10-05T00:00:00Z", equity: 10_450_000n },
];

if (equitySeries.length < 2) {
  throw new Error("Need at least two points for backtest");
}

const returns = [];
for (let index = 1; index < equitySeries.length; index += 1) {
  const prev = Number(equitySeries[index - 1].equity);
  const current = Number(equitySeries[index].equity);
  if (!Number.isFinite(prev) || prev <= 0) {
    throw new Error("Invalid equity value");
  }
  const diff = current - prev;
  returns.push(diff / prev);
}

const avgReturn = returns.reduce((acc, value) => acc + value, 0) / returns.length;
const variance =
  returns.reduce((acc, value) => acc + Math.pow(value - avgReturn, 2), 0) /
  (returns.length || 1);
const stdDev = Math.sqrt(variance);

const periodsPerYear = 365 / (equitySeries.length - 1);
const ending = Number(equitySeries[equitySeries.length - 1].equity);
const starting = Number(equitySeries[0].equity);
const cagr = Math.pow(ending / starting, periodsPerYear) - 1;

let peak = Number(equitySeries[0].equity);
let maxDrawdown = 0;
for (const point of equitySeries) {
  const equity = Number(point.equity);
  if (equity > peak) {
    peak = equity;
  }
  const drawdown = (peak - equity) / peak;
  if (drawdown > maxDrawdown) {
    maxDrawdown = drawdown;
  }
}

const sharpe = stdDev === 0 ? 0 : (avgReturn / stdDev) * Math.sqrt(252);

const formatPercent = (value) => `${(value * 100).toFixed(2)}%`;

console.log("Smoke backtest metrics");
console.log("CAGR", formatPercent(cagr));
console.log("Max Drawdown", formatPercent(maxDrawdown));
console.log("Sharpe", sharpe.toFixed(2));
