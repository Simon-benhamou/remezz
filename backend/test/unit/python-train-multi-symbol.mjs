import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = dirname(dirname(__dirname));
const pythonDir = join(backendRoot, 'python');
const scriptPath = join(pythonDir, 'ccxt_xgboost_module.py');

const runPython = (args, options = {}) => new Promise((resolve, reject) => {
  execFile('python3', args, { cwd: pythonDir, ...options }, (error, stdout, stderr) => {
    if (error) {
      const details = stderr || stdout;
      reject(new Error(details));
      return;
    }
    resolve({ stdout, stderr });
  });
});

const { stdout: checkStdout } = await runPython([
  '-c',
  'import json, ccxt_xgboost_module as mod; print(json.dumps({"have_pandas": getattr(mod, "HAVE_PANDAS", False)}))',
]);

const havePandas = JSON.parse(checkStdout.trim()).have_pandas;

if (!havePandas) {
  console.log('⚠️ skipping multi-symbol training test (pandas/ta stack unavailable)');
} else {
  const env = {
    ...process.env,
    XGB_SYMBOLS: 'BTC/USDT,ETH/USDT',
    XGB_LOOKBACK_HOURS: '24',
    UNIT_TEST_MODE: 'true',
  };

  const { stdout } = await runPython([scriptPath], { env });
  const result = JSON.parse(stdout.trim());

  assert(result && typeof result === 'object', 'training output must be an object');
  assert(Array.isArray(result.features) && result.features.length >= 1, 'features list must not be empty');
  assert(result.metrics && Number.isFinite(result.metrics.accuracy), 'accuracy must be finite');
  assert(result.metrics && Number.isFinite(result.metrics.f1), 'f1 must be finite');

  console.log(`✅ python multi-symbol training accuracy=${result.metrics.accuracy.toFixed(4)} f1=${result.metrics.f1.toFixed(4)}`);
}
