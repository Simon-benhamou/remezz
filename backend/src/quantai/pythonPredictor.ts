import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIntegrationLogger } from '../utils/integrationLogger.js';

const DEFAULT_TIMEOUT_MS = 4_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(dirname(dirname(__dirname)));
const defaultScript = join(projectRoot, 'python', 'predict_service.py');

let cachedPythonExecutable: string | null = null;
let cachedPythonResolutionError: Error | null = null;
let pythonFailureCount = 0;
const PYTHON_FAILURE_THRESHOLD = 5;

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
  const logger = createIntegrationLogger({
    component: 'PythonPredictor',
    action: 'predict',
  });

  const sanitized = sanitizeFeatures(features);

  const scriptPath = getScriptPath();
  const payload = JSON.stringify(sanitized);

  logger.debug(`Calling Python | features=${Object.keys(sanitized).length} script=${scriptPath}`);

  return new Promise<PythonPredictionResult>((resolve, reject) => {
    let pythonCommand: string;
    try {
      pythonCommand = resolvePythonExecutable();
      // Log Python executable once on first successful resolution
      if (pythonFailureCount === 0 && !cachedPythonExecutable) {
        logger.info(`Resolved Python executable: ${pythonCommand}`);
      }
    } catch (error: any) {
      logger.error('Failed to resolve Python executable', error);
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
      pythonFailureCount++;
      logger.error(`Spawn failed | failures=${pythonFailureCount}/${PYTHON_FAILURE_THRESHOLD}`, error);
      
      if (pythonFailureCount >= PYTHON_FAILURE_THRESHOLD) {
        logger.error('Python predictor failing repeatedly - system should disable predictor');
      }
      
      reject(new Error(`python spawn failed: ${error.message}`));
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        pythonFailureCount++;
        const details = stderr || stdout || '';
        logger.error(`Exit code ${code} | failures=${pythonFailureCount}/${PYTHON_FAILURE_THRESHOLD}`, {
          stderr: details.slice(0, 200),
        });
        reject(new Error(`python exited with code ${code}: ${details}`));
        return;
      }
      try {
        const result = parsePrediction(stdout.trim());
        // Reset failure count on success
        pythonFailureCount = 0;
        
        logger.success('Prediction result', undefined, {
          decision: result.decision,
          confidence: result.confidence.toFixed(3),
          probLong: result.probabilityLong.toFixed(3),
          probShort: result.probabilityShort.toFixed(3),
          entryWeight: result.entryWeight.toFixed(2),
          riskMultiplier: result.riskMultiplier.toFixed(2),
        });
        
        resolve(result);
      } catch (error: any) {
        pythonFailureCount++;
        logger.error(`Parse failed | failures=${pythonFailureCount}/${PYTHON_FAILURE_THRESHOLD}`, error, {
          stdout: stdout.slice(0, 200),
        });
        reject(new Error(`failed to parse python output: ${error.message}`));
      }
    });

    try {
      child.stdin.write(payload);
      child.stdin.end();
    } catch (error: any) {
      clearTimeout(timer);
      child.kill('SIGKILL');
      pythonFailureCount++;
      logger.error(`Failed to send payload | failures=${pythonFailureCount}/${PYTHON_FAILURE_THRESHOLD}`, error);
      reject(new Error(`failed to send payload: ${error.message}`));
    }
  });
}

export function getPredictionSync(features: Record<string, number>): PythonPredictionResult {
  const sanitized = sanitizeFeatures(features);
  const scriptPath = getScriptPath();
  const payload = JSON.stringify(sanitized);
  const timeoutMs = Number(process.env.PYTHON_PREDICT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  const pythonCommand = resolvePythonExecutable();

  const result = spawnSync(pythonCommand, [scriptPath], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
  });

  if (result.error) {
    throw new Error(`python spawn failed: ${result.error.message}`);
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    const details = result.stderr || result.stdout || '';
    throw new Error(`python exited with code ${result.status}: ${details}`);
  }

  try {
    return parsePrediction((result.stdout ?? '').trim());
  } catch (error) {
    throw new Error(`failed to parse python output: ${(error as Error).message}`);
  }
}
