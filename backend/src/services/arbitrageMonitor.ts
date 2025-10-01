import { getArbitrageSpreads, preloadArbitrageExchanges } from '../arbitrage/spreadScanner.js';
import { broadcast } from '../ws/hub.js';
import { getConfig } from '../utils/env.js';

let timer: NodeJS.Timeout | null = null;
let lastPayload: any = null;

export async function startArbitrageMonitor() {
  stopArbitrageMonitor();

  // Preload exchanges to avoid repeated loadMarkets calls
  try {
    await preloadArbitrageExchanges();
  } catch (error) {
    console.warn('Failed to preload arbitrage exchanges:', error);
  }

  runOnce().finally(() => schedule());
}

export function stopArbitrageMonitor() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export function getLastArbitrageSnapshot() {
  return lastPayload;
}

async function runOnce() {
  const cfg = getConfig();
  if (!cfg.ARBITRAGE_ENABLED) return;
  try {
    const spreads = await getArbitrageSpreads();
    const payload = {
      spreads,
      generatedAt: new Date().toISOString(),
    };
    lastPayload = payload;
    broadcast('arbitrage_spreads', payload);
  } catch (error) {
    console.warn('Arbitrage monitor error:', error);
  }
}

function schedule() {
  const cfg = getConfig();
  const interval = Math.max(30, cfg.ARBITRAGE_POLL_INTERVAL_SEC) * 1000;
  timer = setTimeout(() => {
    runOnce().finally(() => schedule());
  }, interval);
}
