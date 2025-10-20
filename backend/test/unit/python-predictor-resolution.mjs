import assert from 'node:assert/strict';

const {
  __resetPythonExecutableCacheForTests,
  __getPythonExecutableCacheForTests,
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

  let threw = false;
  try {
    getPredictionSync(sampleFeatures);
  } catch (error) {
    threw = true;
    assert.match(
      error instanceof Error ? error.message : String(error),
      /Unable to locate a Python interpreter/,
      'should surface a helpful python missing error',
    );
  }

  assert(threw, 'python resolution must throw when interpreter missing');
  assert.strictEqual(
    __getPythonExecutableCacheForTests(),
    null,
    'python executable should remain unresolved after failure',
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
