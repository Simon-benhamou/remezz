import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 4_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(dirname(dirname(__dirname)));
const defaultScript = join(projectRoot, 'python', 'predict_service.py');

// The Python process is a stateless bridge: each invocation loads the XGBoost
// artefacts from python/ and returns `{ "prediction": 0|1 }`. Keeping the
// implementation out-of-process ensures Node stays dependency-light.

function getScriptPath(): string {
  return process.env.PYTHON_PREDICT_SCRIPT ?? defaultScript;
}

export async function getPrediction(features: Record<string, number>): Promise<number> {
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

  const scriptPath = getScriptPath();
  const payload = JSON.stringify(sanitized);

  return new Promise<number>((resolve, reject) => {
    const child = spawn('python3', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    const timeoutMs = Number(process.env.PYTHON_PREDICT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
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
      reject(new Error(`python spawn failed: ${error.message}`));
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const details = stderr || stdout || '';
        reject(new Error(`python exited with code ${code}: ${details}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        const value = parsed?.prediction;
        if (value !== 0 && value !== 1) {
          throw new Error(`unexpected prediction payload: ${stdout}`);
        }
        resolve(value);
      } catch (error) {
        reject(new Error(`failed to parse python output: ${(error as Error).message}`));
      }
    });

    try {
      child.stdin.write(payload);
      child.stdin.end();
    } catch (error) {
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error(`failed to send payload: ${(error as Error).message}`));
    }
  });
}
