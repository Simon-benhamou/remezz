/**
 * Backtest Worker Thread
 *
 * Runs backtest computation on a dedicated thread to avoid blocking the main
 * event loop (which handles WebSocket connections and live/paper agent ticks).
 *
 * Receives pre-loaded candle data from the main thread, runs the pure
 * simulation, and sends back the result.
 */

import { parentPort } from 'node:worker_threads';
import { runBacktestComputation, type BacktestComputationInput } from './backtestService.js';

if (!parentPort) {
  throw new Error('backtestWorker must be run as a worker thread');
}

parentPort.on('message', async (input: BacktestComputationInput) => {
  try {
    // Reconstruct Date objects (structured clone preserves them, but be safe)
    if (typeof input.params.startDate === 'string') {
      input.params.startDate = new Date(input.params.startDate);
    }
    if (typeof input.params.endDate === 'string') {
      input.params.endDate = new Date(input.params.endDate);
    }
    if (input.params.dataStartDate && typeof input.params.dataStartDate === 'string') {
      input.params.dataStartDate = new Date(input.params.dataStartDate);
    }

    const result = await runBacktestComputation(input);
    parentPort!.postMessage({ success: true, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({ success: false, error: message });
  }
});
