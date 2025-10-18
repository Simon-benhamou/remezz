import type { ExecutionResult } from '../execution/executor.js';

export interface TelemetryEvent {
  symbol: string;
  regime: string;
  probability: number;
  evEstimate: number;
  outcome?: ExecutionResult;
}

export class Telemetry {
  private readonly events: TelemetryEvent[] = [];

  record(event: TelemetryEvent): void {
    this.events.push(event);
  }

  summary(): { trades: number; avgPnl: number } {
    const pnls = this.events.map(e => e.outcome?.pnlUsd.toNumber() ?? 0);
    const trades = pnls.filter(v => v !== 0).length;
    const avg = trades ? pnls.reduce((a, b) => a + b, 0) / trades : 0;
    return { trades, avgPnl: avg };
  }
}
