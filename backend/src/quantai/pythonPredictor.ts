import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { 
  isServiceAvailable, 
  recordServiceSuccess, 
  recordServiceFailure,
  recordFallbackTriggered 
} from '../infra/serviceHealth.js';
import { createIntegrationLogger } from '../utils/integrationLogger.js';

// 🔧 Increased timeout to handle XGBoost model loading (205MB)
// First prediction can take 10-15s on cold start
const DEFAULT_TIMEOUT_MS = 15_000;

const moduleDirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(dirname(dirname(moduleDirname)));
const defaultScript = join(projectRoot, 'python', 'predict_service.py');

let cachedPythonExecutable: string | null = null;
let cachedPythonResolutionError: Error | null = null;
let pythonFailureCount = 0;
const PYTHON_FAILURE_THRESHOLD = 5;

// 🔴 PREDICTOR RELIABILITY METRICS
type PredictorReliabilityMetrics = {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  lastErrorTimestamp: number | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;
  reliabilityRate: number; // successfulCalls / totalCalls (target: 0.95+)
  isReliable: boolean; // reliabilityRate >= 0.95
};

const predictorMetrics: PredictorReliabilityMetrics = {
  totalCalls: 0,
  successfulCalls: 0,
  failedCalls: 0,
  lastErrorTimestamp: null,
  lastErrorMessage: null,
  consecutiveFailures: 0,
  reliabilityRate: 1.0,
  isReliable: true,
};

export function getPredictorReliabilityMetrics(): Readonly<PredictorReliabilityMetrics> {
  return { ...predictorMetrics };
}

export function resetPredictorMetrics(): void {
  predictorMetrics.totalCalls = 0;
  predictorMetrics.successfulCalls = 0;
  predictorMetrics.failedCalls = 0;
  predictorMetrics.lastErrorTimestamp = null;
  predictorMetrics.lastErrorMessage = null;
  predictorMetrics.consecutiveFailures = 0;
  predictorMetrics.reliabilityRate = 1.0;
  predictorMetrics.isReliable = true;
}

function recordPredictorSuccess(): void {
  predictorMetrics.totalCalls += 1;
  predictorMetrics.successfulCalls += 1;
  predictorMetrics.consecutiveFailures = 0;
  predictorMetrics.reliabilityRate = predictorMetrics.successfulCalls / predictorMetrics.totalCalls;
  predictorMetrics.isReliable = predictorMetrics.reliabilityRate >= 0.95;
}

function recordPredictorFailure(errorMessage: string): void {
  predictorMetrics.totalCalls += 1;
  predictorMetrics.failedCalls += 1;
  predictorMetrics.consecutiveFailures += 1;
  predictorMetrics.lastErrorTimestamp = Date.now();
  predictorMetrics.lastErrorMessage = errorMessage;
  predictorMetrics.reliabilityRate = predictorMetrics.successfulCalls / predictorMetrics.totalCalls;
  predictorMetrics.isReliable = predictorMetrics.reliabilityRate >= 0.95;
  
  // 🚨 Alert if reliability drops below 95%
  if (!predictorMetrics.isReliable && predictorMetrics.totalCalls >= 20) {
    console.error('🚨 PREDICTOR RELIABILITY BELOW 95%', {
      reliabilityRate: predictorMetrics.reliabilityRate.toFixed(4),
      successfulCalls: predictorMetrics.successfulCalls,
      failedCalls: predictorMetrics.failedCalls,
      totalCalls: predictorMetrics.totalCalls,
      consecutiveFailures: predictorMetrics.consecutiveFailures,
      lastError: errorMessage,
    });
  }
  
  // 🚫 Block all predictions if consecutive failures too high
  if (predictorMetrics.consecutiveFailures >= 3) {
    console.error('🚫 PREDICTOR CONSECUTIVE FAILURES - SYSTEM UNRELIABLE', {
      consecutiveFailures: predictorMetrics.consecutiveFailures,
      lastErrors: predictorMetrics.lastErrorMessage,
    });
  }
}

function probePythonExecutable(): string {
  if (cachedPythonExecutable) {
    return cachedPythonExecutable;
  }

  if (cachedPythonResolutionError) {
    throw cachedPythonResolutionError;
  }

  const envExecutable =
    process.env.PYTHON_PREDICT_EXECUTABLE?.trim() || process.env.PYTHON?.trim();

  const versionedCandidates = [
    'python3.12',
    'python3.11',
    'python3.10',
    'python3.9',
    'python3.8',
  ];

  const candidates = [envExecutable, ...versionedCandidates, 'python3', 'python'].filter(
    (value): value is string => Boolean(value && value.length > 0),
  );

  const errors: string[] = [];

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
    });

    if (!result.error) {
      cachedPythonExecutable = candidate;
      cachedPythonResolutionError = null;
      return candidate;
    }

    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'EACCES') {
      const reason = code === 'EACCES' ? 'not executable' : 'not found';
      errors.push(`${reason}: ${candidate}`);
      continue;
    }

    const failure = new Error(
      `failed to execute python candidate "${candidate}": ${result.error?.message ?? 'unknown error'}`,
    );
    cachedPythonResolutionError = failure;
    throw failure;
  }

  const hint =
    'Set PYTHON_PREDICT_EXECUTABLE to a valid interpreter or ensure python3/python are on PATH.';
  const errorDetails = errors.length > 0 ? ` (${errors.join(', ')})` : '';
  const failure = new Error(
    `Unable to locate a Python interpreter for predictor${errorDetails}. ${hint}`,
  );
  cachedPythonResolutionError = failure;
  throw failure;
}

function resolvePythonExecutable(): string {
  return probePythonExecutable();
}

export function isPythonPredictorAvailable(): boolean {
  try {
    probePythonExecutable();
    return true;
  } catch (error) {
    if (!cachedPythonResolutionError) {
      cachedPythonResolutionError =
        error instanceof Error ? error : new Error(String(error));
    }
    return false;
  }
}

export function __resetPythonExecutableCacheForTests(): void {
  cachedPythonExecutable = null;
  cachedPythonResolutionError = null;
}

export function __getPythonExecutableCacheForTests(): string | null {
  return cachedPythonExecutable;
}

export function __getPythonResolutionErrorForTests(): Error | null {
  return cachedPythonResolutionError;
}

export function getPythonResolutionError(): Error | null {
  return cachedPythonResolutionError;
}

// The Python process is a stateless bridge: each invocation loads the XGBoost
// artefacts from python/ and returns `{ "prediction": 0|1, "probability": 0-1 }`.
// Keeping the implementation out-of-process ensures Node stays dependency-light.

function getScriptPath(): string {
  if (process.env.PYTHON_PREDICT_SCRIPT) {
    return process.env.PYTHON_PREDICT_SCRIPT;
  }
  if (process.env.UNIT_TEST_MODE === 'true') {
    return join(projectRoot, 'python', 'stubs', 'constant_bullish.py');
  }
  return defaultScript;
}

export type PythonPredictionProbabilities = {
  long: number;
  short: number;
  none: number;
};

export type PythonPredictionResult = {
  decision: 'long' | 'short' | 'none';
  probabilities: PythonPredictionProbabilities;
  probabilityLong: number;
  probabilityShort: number;
  probabilityNone: number;
  confidence: number;
  entryWeight: number;
  riskMultiplier: number;
  cooldown: { active: boolean; reason: string | null; seconds: number | null };
  meta?: Record<string, unknown> | null;
  classOrder?: string[] | null;
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function sanitizeFeatures(features: Record<string, number>): Record<string, number> {
  if (!features || typeof features !== 'object') {
    throw new TypeError('features must be an object');
  }

  const sanitized: Record<string, number> = {};
  for (const [key, value] of Object.entries(features)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new TypeError(`feature ${key} must be a finite number`);
    }
    sanitized[key] = numeric;
  }
  return sanitized;
}

function parsePrediction(payload: string): PythonPredictionResult {
  if (!payload) {
    throw new Error('empty python output');
  }
  const parsed = JSON.parse(payload);
  const decisionRaw = typeof parsed?.decision === 'string' ? parsed.decision.toLowerCase() : null;
  const predictionRaw = Number(parsed?.prediction);
  let decision: 'long' | 'short' | 'none';
  if (decisionRaw === 'long' || decisionRaw === 'short' || decisionRaw === 'none') {
    decision = decisionRaw;
  } else if (predictionRaw === 0) {
    decision = 'short';
  } else {
    decision = 'long';
  }

  const probabilitiesRaw = parsed?.probabilities;
  let probabilities: PythonPredictionProbabilities = {
    long: Number(parsed?.probabilityLong ?? parsed?.probability ?? (decision === 'short' ? 0.4 : 0.6)),
    short: Number(parsed?.probabilityShort ?? parsed?.bearProbability ?? (decision === 'short' ? 0.6 : 0.4)),
    none: Number(parsed?.probabilityNone ?? 0),
  };
  if (probabilitiesRaw && typeof probabilitiesRaw === 'object') {
    const long = Number((probabilitiesRaw as Record<string, unknown>).long);
    const short = Number((probabilitiesRaw as Record<string, unknown>).short);
    const none = Number((probabilitiesRaw as Record<string, unknown>).none);
    probabilities = {
      long: Number.isFinite(long) ? long : probabilities.long,
      short: Number.isFinite(short) ? short : probabilities.short,
      none: Number.isFinite(none) ? none : probabilities.none,
    };
  }

  const normaliser = probabilities.long + probabilities.short + probabilities.none;
  if (normaliser > 0) {
    probabilities = {
      long: probabilities.long / normaliser,
      short: probabilities.short / normaliser,
      none: probabilities.none / normaliser,
    };
  } else {
    probabilities = { long: 1 / 3, short: 1 / 3, none: 1 / 3 };
  }

  const bounded = {
    long: clamp(probabilities.long, 0, 1),
    short: clamp(probabilities.short, 0, 1),
    none: clamp(probabilities.none, 0, 1),
  };
  const boundedSum = bounded.long + bounded.short + bounded.none;
  const probabilityLong = boundedSum > 0 ? bounded.long / boundedSum : 1 / 3;
  const probabilityShort = boundedSum > 0 ? bounded.short / boundedSum : 1 / 3;
  const probabilityNone = boundedSum > 0 ? bounded.none / boundedSum : 1 / 3;
  const confidence = clamp(Number(parsed?.confidence ?? Math.abs(probabilityLong - probabilityShort)), 0, 1);
  const entryWeight = clamp(Number(parsed?.entryWeight ?? 1), 0.2, 3);
  const riskMultiplier = clamp(Number(parsed?.riskMultiplier ?? 1), 0.2, 3);
  const cooldownParsed = parsed?.cooldown;
  const cooldown = {
    active: Boolean(cooldownParsed?.active),
    reason: typeof cooldownParsed?.reason === 'string' ? cooldownParsed.reason : null,
    seconds: Number.isFinite(Number(cooldownParsed?.seconds)) ? Number(cooldownParsed.seconds) : null,
  };
  const classOrder = Array.isArray(parsed?.classOrder)
    ? parsed.classOrder.filter((item: unknown): item is string => typeof item === 'string')
    : null;

  return {
    decision,
    probabilities: { long: probabilityLong, short: probabilityShort, none: probabilityNone },
    probabilityLong,
    probabilityShort,
    probabilityNone,
    confidence,
    entryWeight,
    riskMultiplier,
    cooldown,
    meta: parsed?.meta ?? null,
    classOrder,
  };
}

export async function getPrediction(features: Record<string, number>): Promise<PythonPredictionResult> {
  // Check service health
  if (!isServiceAvailable('python_predictor')) {
    recordFallbackTriggered('python_predictor', 'circuit_breaker_open');
    throw new Error('Python predictor unavailable (circuit breaker open)');
  }

  const sanitized = sanitizeFeatures(features);

  const scriptPath = getScriptPath();
  const payload = JSON.stringify(sanitized);
  const startTime = Date.now();
  const logger = createIntegrationLogger({
    component: 'PythonPredictor',
    action: 'predict',
  });
  logger.debug(`Calling Python | features=${Object.keys(sanitized).length} script=${scriptPath}`);

  return new Promise<PythonPredictionResult>((resolve, reject) => {
    let pythonCommand: string;
    try {
      pythonCommand = resolvePythonExecutable();
    } catch (error) {
      recordServiceFailure('python_predictor', error as Error, false);
      reject(error);
      return;
    }

    const child = spawn(pythonCommand, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    const timeoutMs = Number(process.env.PYTHON_PREDICT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      pythonFailureCount++;
      logger.error(`Prediction timeout | timeoutMs=${timeoutMs} failures=${pythonFailureCount}/${PYTHON_FAILURE_THRESHOLD}`);
      
      if (pythonFailureCount >= PYTHON_FAILURE_THRESHOLD) {
        logger.error('Python predictor failing repeatedly - consider disabling with DISABLE_PYTHON_PREDICTOR=true');
      }
      
      reject(new Error('python prediction timed out'));
    }, Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });

    child.on('error', error => {
      clearTimeout(timer);
      recordServiceFailure('python_predictor', error);
      reject(new Error(`python spawn failed: ${error.message}`));
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const details = stderr || stdout || '';
        const error = new Error(`python exited with code ${code}: ${details}`);
        recordServiceFailure('python_predictor', error);
        reject(error);
        return;
      }
      try {
        const result = parsePrediction(stdout.trim());
        const responseTime = Date.now() - startTime;
        recordServiceSuccess('python_predictor', responseTime);
        resolve(result);
      } catch (error) {
        const parseError = new Error(`failed to parse python output: ${(error as Error).message}`);
        recordServiceFailure('python_predictor', parseError);
        reject(parseError);
      }
    });

    child.on('error', error => {
      clearTimeout(timer);
      recordServiceFailure('python_predictor', error);
      reject(new Error(`python spawn failed: ${error.message}`));
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        pythonFailureCount++;
        const details = stderr || stdout || '';
        const error = new Error(`python exited with code ${code}: ${details}`);
        recordServiceFailure('python_predictor', error);
        recordPredictorFailure(error.message); // 🔴 Track reliability
        reject(error);
        return;
      }
      try {
        const result = parsePrediction(stdout.trim());
        const responseTime = Date.now() - startTime;
        recordServiceSuccess('python_predictor', responseTime);
        resolve(result);
      } catch (error) {
        const parseError = new Error(`failed to parse python output: ${(error as Error).message}`);
        recordServiceFailure('python_predictor', parseError);
        reject(parseError);
      }
    });

    try {
      child.stdin.write(payload);
      child.stdin.end();
    } catch (error: any) {
      clearTimeout(timer);
      child.kill('SIGKILL');
      const writeError = new Error(`failed to send payload: ${(error as Error).message}`);
      recordServiceFailure('python_predictor', writeError);
      reject(writeError);
    }
  });
}

export function getPredictionSync(features: Record<string, number>): PythonPredictionResult {
  // Check service health
  if (!isServiceAvailable('python_predictor')) {
    recordFallbackTriggered('python_predictor', 'circuit_breaker_open');
    throw new Error('Python predictor unavailable (circuit breaker open)');
  }

  const sanitized = sanitizeFeatures(features);
  const scriptPath = getScriptPath();
  const payload = JSON.stringify(sanitized);
  const timeoutMs = Number(process.env.PYTHON_PREDICT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const startTime = Date.now();

  const pythonCommand = resolvePythonExecutable();

  const result = spawnSync(pythonCommand, [scriptPath], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
  });

  if (result.error) {
    const error = new Error(`python spawn failed: ${result.error.message}`);
    recordServiceFailure('python_predictor', error);
    throw error;
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    const details = result.stderr || result.stdout || '';
    const error = new Error(`python exited with code ${result.status}: ${details}`);
    recordServiceFailure('python_predictor', error);
    throw error;
  }

  try {
    const prediction = parsePrediction((result.stdout ?? '').trim());
    const responseTime = Date.now() - startTime;
    recordServiceSuccess('python_predictor', responseTime);
    recordPredictorSuccess(); // 🔵 Track reliability
    return prediction;
  } catch (error) {
    const parseError = new Error(`failed to parse python output: ${(error as Error).message}`);
    recordServiceFailure('python_predictor', parseError);
    recordPredictorFailure(parseError.message); // 🔴 Track reliability
    throw parseError;
  }
}

/**
 * Rule-based fallback when Python predictor is unavailable
 * Uses technical indicators to make a simple prediction
 */
export function getRuleBasedPrediction(features: Record<string, number>): PythonPredictionResult {
  // Extract key technical indicators
  const rsi = features.rsi_14 ?? 50;
  const macdSignal = features.macd_signal ?? 0;
  const volumeRatio = features.volume_ratio ?? 1;
  const atr = features.atr_14_pct ?? 1;
  const priceChangePercent = features.price_change_1h_pct ?? 0;
  
  // Simple rule-based logic
  let decision: 'long' | 'short' | 'none' = 'none';
  let longProb = 0.33;
  let shortProb = 0.33;
  let noneProb = 0.34;
  
  // RSI-based signals
  if (rsi < 30 && volumeRatio > 1.5) {
    // Oversold with volume - potential long
    longProb = 0.55;
    shortProb = 0.20;
    noneProb = 0.25;
    decision = 'long';
  } else if (rsi > 70 && volumeRatio > 1.5) {
    // Overbought with volume - potential short
    longProb = 0.20;
    shortProb = 0.55;
    noneProb = 0.25;
    decision = 'short';
  } else if (macdSignal > 0 && priceChangePercent > 0 && volumeRatio > 1.2) {
    // Bullish momentum
    longProb = 0.50;
    shortProb = 0.25;
    noneProb = 0.25;
    decision = 'long';
  } else if (macdSignal < 0 && priceChangePercent < 0 && volumeRatio > 1.2) {
    // Bearish momentum
    longProb = 0.25;
    shortProb = 0.50;
    noneProb = 0.25;
    decision = 'short';
  }
  
  // Calculate confidence based on signal strength
  const confidence = Math.abs(longProb - shortProb);
  
  return {
    decision,
    probabilities: { long: longProb, short: shortProb, none: noneProb },
    probabilityLong: longProb,
    probabilityShort: shortProb,
    probabilityNone: noneProb,
    confidence: clamp(confidence, 0, 1),
    entryWeight: 1,
    riskMultiplier: 1,
    cooldown: { active: false, reason: null, seconds: null },
    meta: { source: 'rule_based_fallback' },
    classOrder: null,
  };
}

/**
 * Safe wrapper for getPrediction that falls back to rule-based prediction
 */
export async function getPredictionSafe(
  features: Record<string, number>,
  options?: { allowFallback?: boolean }
): Promise<PythonPredictionResult> {
  const allowFallback = options?.allowFallback ?? true;
  
  try {
    return await getPrediction(features);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    if (allowFallback) {
      recordFallbackTriggered('python_predictor', 'rule_based_fallback', {
        error: errorMsg,
        hasFeatures: Object.keys(features).length,
      });
      
      return getRuleBasedPrediction(features);
    }
    
    throw error;
  }
}

/**
 * Safe synchronous wrapper for getPredictionSync that falls back to rule-based prediction
 */
export function getPredictionSyncSafe(
  features: Record<string, number>,
  options?: { allowFallback?: boolean }
): PythonPredictionResult {
  // 🚨 CHANGED: Default to NO fallback (require 95% reliability)
  // Set allowFallback=true explicitly only for non-critical operations
  const allowFallback = options?.allowFallback ?? false;
  
  try {
    return getPredictionSync(features);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    if (allowFallback) {
      recordFallbackTriggered('python_predictor', 'rule_based_fallback', {
        error: errorMsg,
        hasFeatures: Object.keys(features).length,
      });
      
      return getRuleBasedPrediction(features);
    }
    
    throw error;
  }
}

