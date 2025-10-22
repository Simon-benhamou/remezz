export type Side = 'long' | 'short';

export type Trade = {
  side: Side;
  pnl: number; // net (signed)
  entryTs: number;
  exitTs: number;
  ctx?: Record<string, unknown>;
};

export class History {
  private aL = 1;
  private bL = 1;
  private aS = 1;
  private bS = 1;
  private avgWinL = 0;
  private avgLossL = 0;
  private avgWinS = 0;
  private avgLossS = 0;
  private readonly lambda: number;
  private readonly costs: number;
  private seed: number;

  constructor(opts: { lambda: number; costsBps: number; seed?: number }) {
    if (opts.lambda <= 0 || opts.lambda >= 1) {
      throw new Error('history_lambda_out_of_range');
    }
    this.lambda = opts.lambda;
    this.costs = opts.costsBps / 10_000;
    this.seed = (opts.seed ?? 0x9e3779b1) >>> 0;
  }

  update(t: Trade, cfOppositePnl: number): void {
    const win = t.pnl > 0;
    const upd = (winAvg: number, lossAvg: number, pnl: number) =>
      pnl > 0
        ? { winAvg: this.ema(winAvg, pnl), lossAvg }
        : { winAvg, lossAvg: this.ema(lossAvg, -pnl) };

    if (t.side === 'long') {
      this.aL = this.lambda * this.aL + (win ? 1 : 0);
      this.bL = this.lambda * this.bL + (win ? 0 : 1);
      ({ winAvg: this.avgWinL, lossAvg: this.avgLossL } = upd(this.avgWinL, this.avgLossL, t.pnl));
      if (cfOppositePnl > 0) {
        this.aS = this.lambda * this.aS + 1;
        this.avgWinS = this.ema(this.avgWinS, cfOppositePnl);
      } else {
        this.bS = this.lambda * this.bS + 1;
        this.avgLossS = this.ema(this.avgLossS, -cfOppositePnl);
      }
    } else {
      this.aS = this.lambda * this.aS + (win ? 1 : 0);
      this.bS = this.lambda * this.bS + (win ? 0 : 1);
      ({ winAvg: this.avgWinS, lossAvg: this.avgLossS } = upd(this.avgWinS, this.avgLossS, t.pnl));
      if (cfOppositePnl > 0) {
        this.aL = this.lambda * this.aL + 1;
        this.avgWinL = this.ema(this.avgWinL, cfOppositePnl);
      } else {
        this.bL = this.lambda * this.bL + 1;
        this.avgLossL = this.ema(this.avgLossL, -cfOppositePnl);
      }
    }
  }

  qValues(): { qL: number; qS: number } {
    const pL = this.sampleBeta(this.aL, this.bL);
    const pS = this.sampleBeta(this.aS, this.bS);
    const qL = pL * this.avgWinL - (1 - pL) * this.avgLossL - this.costs;
    const qS = pS * this.avgWinS - (1 - pS) * this.avgLossS - this.costs;
    return { qL, qS };
  }

  private ema(prev: number, x: number, alpha = 1 - this.lambda): number {
    if (!Number.isFinite(x)) {
      throw new Error('history_non_finite_input');
    }
    return prev === 0 ? x : alpha * x + (1 - alpha) * prev;
  }

  private sampleBeta(a: number, b: number): number {
    if (a <= 0 || b <= 0) {
      return 0.5;
    }
    const mean = a / (a + b);
    const variance = (a * b) / ((a + b) ** 2 * (a + b + 1));
    const eps = Math.max(-3, Math.min(3, this.randn())) * Math.sqrt(Math.max(variance, 1e-8));
    return Math.max(0.01, Math.min(0.99, mean + eps));
  }

  private rand(): number {
    this.seed = (1664525 * this.seed + 1013904223) >>> 0;
    return this.seed / 0xffffffff;
  }

  private randn(): number {
    const u = Math.max(this.rand(), Number.EPSILON);
    const v = Math.max(this.rand(), Number.EPSILON);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
