export class RollingWindow {
  private readonly size: number;
  private values: number[] = [];

  constructor(size: number) {
    this.size = Math.max(1, size);
  }

  push(value: number): void {
    this.values.push(Number.isFinite(value) ? value : 0);
    if (this.values.length > this.size) {
      this.values.shift();
    }
  }

  mean(): number {
    if (!this.values.length) return 0;
    const sum = this.values.reduce((acc, val) => acc + val, 0);
    return sum / this.values.length;
  }

  std(): number {
    if (this.values.length < 2) return 0;
    const m = this.mean();
    const variance = this.values.reduce((acc, val) => acc + (val - m) ** 2, 0) / this.values.length;
    return Math.sqrt(variance);
  }

  percentile(pct: number): number {
    if (!this.values.length) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * pct)));
    return sorted[rank];
  }

  last(): number {
    return this.values[this.values.length - 1] ?? 0;
  }

  length(): number {
    return this.values.length;
  }
}

export class RollingAggression {
  private readonly lookbackMs: number;
  private samples: { timestamp: number; takerBuy: number; takerSell: number }[] = [];

  constructor(lookbackMs: number) {
    this.lookbackMs = Math.max(1, lookbackMs);
  }

  push(sample: { timestamp: number; takerBuy: number; takerSell: number }): void {
    this.samples.push(sample);
    const cutoff = sample.timestamp - this.lookbackMs;
    this.samples = this.samples.filter((item) => item.timestamp >= cutoff);
  }

  ratio(): number {
    if (!this.samples.length) return 0.5;
    const totals = this.samples.reduce(
      (acc, item) => {
        acc.buy += item.takerBuy;
        acc.sell += item.takerSell;
        return acc;
      },
      { buy: 0, sell: 0 },
    );
    const denom = totals.buy + totals.sell;
    if (denom <= 0) return 0.5;
    return totals.buy / denom;
  }
}
