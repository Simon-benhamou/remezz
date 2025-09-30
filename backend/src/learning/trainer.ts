import { recomputeAdaptiveWeightsForFamilies } from './decisionMemory.js';

let scheduler: NodeJS.Timeout | null = null;

export type TrainerOptions = {
  intervalMs?: number;
  familiesPerBatch?: number;
  runOnStart?: boolean;
};

async function runTrainingBatch(familiesPerBatch: number) {
  try {
    // Ensure we always refresh the most recent families
    await recomputeAdaptiveWeightsForFamilies(familiesPerBatch);
  } catch (error) {
    console.warn('Adaptive training batch failed:', error);
  }
}

export function startAdaptiveTrainingScheduler(opts: TrainerOptions = {}) {
  const intervalMs = opts.intervalMs ?? 15 * 60 * 1000; // default 15 minutes
  const familiesPerBatch = opts.familiesPerBatch ?? 10;

  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
  }

  const execute = () => runTrainingBatch(familiesPerBatch);

  if (opts.runOnStart !== false) {
    execute().catch(() => {});
  }

  scheduler = setInterval(() => {
    execute().catch(() => {});
  }, intervalMs);

  console.log(`🧠 Adaptive training scheduler started (interval=${intervalMs / 60000}m, batch=${familiesPerBatch})`);

  return function stopScheduler() {
    if (scheduler) {
      clearInterval(scheduler);
      scheduler = null;
      console.log('🧠 Adaptive training scheduler stopped');
    }
  };
}
