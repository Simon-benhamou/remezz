/**
 * Trade Outcome Updater Worker
 * Periodically updates market outcomes for trade evaluations
 */

import { getEvaluationsPendingOutcome, updateTradeOutcome } from './tradeEvaluationLogger.js';
import { getOHLCV } from '../data/market.js';
import type { MarketOutcome } from './tradeEvaluationLogger.js';
import { trackOutcomeUpdate, checkOutcomeUpdaterLag } from '../monitoring/alerting.js';
import { isBinanceRestIpBanned, getBinanceIpBanExpiry } from '../services/binanceRest.js';

const WORKER_INTERVAL_MS = 5 * 60 * 1000; // Run every 5 minutes
const OUTCOME_WAIT_MS = 60 * 60 * 1000; // Wait 1 hour after evaluation
const OUTCOME_WINDOW_MINUTES = 70; // Fetch 70 minutes of data to ensure coverage

let workerTimer: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Calculate PnL and excursions from price data
 */
function calculateOutcome(
  entryPrice: number,
  prices: number[],
  timestamps: number[],
  evaluationTime: number,
): MarketOutcome {
  const outcome: MarketOutcome = {};

  // Find prices at 15m and 1h marks
  const fifteenMinMark = evaluationTime + 15 * 60 * 1000;
  const oneHourMark = evaluationTime + 60 * 60 * 1000;

  let price15m: number | null = null;
  let price1h: number | null = null;
  let maxPrice = entryPrice;
  let minPrice = entryPrice;

  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const price = prices[i];

    if (!price15m && ts >= fifteenMinMark) {
      price15m = price;
    }

    if (!price1h && ts >= oneHourMark) {
      price1h = price;
    }

    if (ts <= oneHourMark) {
      maxPrice = Math.max(maxPrice, price);
      minPrice = Math.min(minPrice, price);
    }
  }

  // Calculate PnL percentages
  if (price15m) {
    outcome.pnl_15m = (price15m - entryPrice) / entryPrice;
  }

  if (price1h) {
    outcome.pnl_1h = (price1h - entryPrice) / entryPrice;
  }

  // Calculate excursions
  outcome.max_favorable_excursion_1h = (maxPrice - entryPrice) / entryPrice;
  outcome.max_adverse_excursion_1h = (minPrice - entryPrice) / entryPrice;

  return outcome;
}

/**
 * Update outcomes for pending evaluations
 */
async function processOutcomeUpdates(): Promise<void> {
  if (isRunning) {
    console.log('⏳ Outcome updater already running, skipping...');
    return;
  }

  // Skip entirely if Binance REST is IP banned - prevents spam logs
  if (isBinanceRestIpBanned()) {
    const banExpiry = getBinanceIpBanExpiry();
    const remainingSeconds = Math.ceil((banExpiry - Date.now()) / 1000);
    // Log once per 5 minutes to avoid spam
    const now = Date.now();
    const lastLogKey = 'outcome_updater_ip_ban_log';
    const lastLog = (global as any)[lastLogKey] || 0;
    if (now - lastLog > 5 * 60 * 1000) {
      console.log(`⏸️  Outcome updater paused due to IP ban (${remainingSeconds}s remaining)`);
      (global as any)[lastLogKey] = now;
    }
    return;
  }

  isRunning = true;
  try {
    const pending = await getEvaluationsPendingOutcome(50);
    
    if (pending.length === 0) {
      return;
    }

    console.log(`📊 Processing ${pending.length} pending outcome updates...`);
    let updated = 0;
    let failed = 0;

    for (const evaluation of pending) {
      try {
        const evalTime = evaluation.timestamp.getTime();
        const now = Date.now();

        // Ensure we've waited long enough
        if (now - evalTime < OUTCOME_WAIT_MS) {
          continue;
        }

        // Fetch OHLCV data for the hour after evaluation
        // Note: We fetch recent data and filter by timestamp instead
        let candles;
        try {
          candles = await getOHLCV(evaluation.symbol, '1m', OUTCOME_WINDOW_MINUTES);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          // Skip silently during warmup or IP ban - will retry later
          if (errorMsg.includes('websocket_warmup_pending') || errorMsg.includes('binance_rest_ip_banned')) {
            continue; // Don't count as failed, just skip for now
          }
          console.warn(`⚠️ Error fetching data for ${evaluation.symbol}:`, errorMsg);
          failed++;
          continue;
        }

        if (!candles || candles.length < 15) {
          console.warn(`⚠️ Insufficient data for ${evaluation.symbol} at ${evaluation.timestamp}`);
          failed++;
          continue;
        }

        // Extract prices and timestamps from OHLCV format: [timestamp, open, high, low, close, volume]
        const prices = candles.map((c) => c[4]); // close price
        const timestamps = candles.map((c) => c[0]); // timestamp
        const entryPrice = candles[0][4]; // first close price

        // Calculate outcome metrics
        const outcome = calculateOutcome(entryPrice, prices, timestamps, evalTime);

        // Update the evaluation
        const success = await updateTradeOutcome(evaluation.id, outcome);
        if (success) {
          updated++;
        } else {
          failed++;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        
        // Don't fail evaluations due to temporary warmup issues
        if (errorMsg.includes('websocket_warmup_pending') || errorMsg.includes('Insufficient data')) {
          console.log(`⏳ Skipping evaluation ${evaluation.id} - data not ready yet (${errorMsg.split(':')[0]})`);
          // Don't increment failed counter - this is expected during warmup
          continue;
        }
        
        console.warn(`Failed to process outcome for evaluation ${evaluation.id}:`, error);
        failed++;
      }
    }

    console.log(`✅ Outcome updates: ${updated} updated, ${failed} failed`);
    
    // Track successful outcome update for alerting
    if (updated > 0) {
      trackOutcomeUpdate();
    }
  } catch (error) {
    console.error('Error in outcome updater worker:', error);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the outcome updater worker
 */
export function startOutcomeUpdater(): void {
  if (workerTimer) {
    console.log('⚠️ Outcome updater already running');
    return;
  }

  console.log('🚀 Starting trade outcome updater worker...');
  
  // Run immediately on start
  processOutcomeUpdates().catch((error) => {
    console.error('Initial outcome update failed:', error);
  });

  // Then run on interval
  workerTimer = setInterval(() => {
    // Check for lag before processing
    checkOutcomeUpdaterLag();
    
    processOutcomeUpdates().catch((error) => {
      console.error('Scheduled outcome update failed:', error);
    });
  }, WORKER_INTERVAL_MS);
}

/**
 * Stop the outcome updater worker
 */
export function stopOutcomeUpdater(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
    console.log('🛑 Outcome updater worker stopped');
  }
}

/**
 * Run outcome updater once (for testing/manual execution)
 */
export async function runOutcomeUpdaterOnce(): Promise<void> {
  await processOutcomeUpdates();
}
