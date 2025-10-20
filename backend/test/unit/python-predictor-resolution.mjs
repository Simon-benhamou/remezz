import assert from 'node:assert/strict';

const {
  __resetPythonExecutableCacheForTests,
  __getPythonExecutableCacheForTests,
  __getPythonResolutionErrorForTests,
  isPythonPredictorAvailable,
  getPredictionSync,
} = await import('../../dist/src/quantai/pythonPredictor.js');

const sampleFeatures = { ema20: 1, ema50: 2 };

const originalPath = process.env.PATH;
const originalPythonExecutable = process.env.PYTHON_PREDICT_EXECUTABLE;
const originalPythonEnv = process.env.PYTHON;

try {
  process.env.PATH = '';
  delete process.env.PYTHON_PREDICT_EXECUTABLE;
  delete process.env.PYTHON;

  __resetPythonExecutableCacheForTests();

  assert.strictEqual(
    isPythonPredictorAvailable(),
    false,
    'availability probe should return false when interpreter is missing',
  );

  const firstResolutionError = __getPythonResolutionErrorForTests();
  assert(firstResolutionError, 'resolution error should be cached after availability probe');
  assert.match(
    firstResolutionError.message,
    /Unable to locate a Python interpreter/,
    'cached error should mention missing python interpreter',
  );

  let threw = false;
  try {
    getPredictionSync(sampleFeatures);
  } catch (error) {
    threw = true;
    assert.strictEqual(
      error instanceof Error ? error.message : String(error),
      firstResolutionError.message,
      'prediction call should reuse cached resolution error',
    );
  }

  assert(threw, 'python resolution must throw when interpreter missing');
  assert.strictEqual(
    __getPythonExecutableCacheForTests(),
    null,
    'python executable should remain unresolved after failure',
  );
  const postCallResolutionError = __getPythonResolutionErrorForTests();
  assert(postCallResolutionError, 'resolution error should stay cached after failure');
  assert.strictEqual(
    postCallResolutionError?.message,
    firstResolutionError.message,
    'cached resolution error message must remain stable',
  );

  assert.strictEqual(
    isPythonPredictorAvailable(),
    false,
    'subsequent availability probes should stay false without reattempts',
  );
} finally {
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }

  if (originalPythonExecutable === undefined) {
    delete process.env.PYTHON_PREDICT_EXECUTABLE;
  } else {
    process.env.PYTHON_PREDICT_EXECUTABLE = originalPythonExecutable;
  }

  if (originalPythonEnv === undefined) {
    delete process.env.PYTHON;
  } else {
    process.env.PYTHON = originalPythonEnv;
  }

  __resetPythonExecutableCacheForTests();
}

console.log('✅ python predictor reports missing interpreter cleanly when python is absent');
