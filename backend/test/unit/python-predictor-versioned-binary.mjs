import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  __resetPythonExecutableCacheForTests,
  __getPythonExecutableCacheForTests,
  isPythonPredictorAvailable,
} = await import('../../dist/src/quantai/pythonPredictor.js');

const originalPath = process.env.PATH;
const originalPythonExecutable = process.env.PYTHON_PREDICT_EXECUTABLE;
const originalPythonEnv = process.env.PYTHON;

const tmpDir = mkdtempSync(join(tmpdir(), 'quantai-python-bin-'));
const stubBinaryName = 'python3.11';
const stubBinaryPath = join(tmpDir, stubBinaryName);

try {
  writeFileSync(
    stubBinaryPath,
    '#!/bin/sh\n' +
      "if [ \"$1\" = '--version' ]; then\n" +
      "  echo 'Python 3.11.9';\n" +
      '  exit 0;\n' +
      'fi\n' +
      "echo 'stub predictor python';\n" +
      'exit 0;\n',
    { mode: 0o755 },
  );
  chmodSync(stubBinaryPath, 0o755);

  process.env.PATH = tmpDir;
  delete process.env.PYTHON_PREDICT_EXECUTABLE;
  delete process.env.PYTHON;

  __resetPythonExecutableCacheForTests();

  assert.strictEqual(
    isPythonPredictorAvailable(),
    true,
    'versioned python binary should be detected as available',
  );

  assert.strictEqual(
    __getPythonExecutableCacheForTests(),
    stubBinaryName,
    'detected python executable should match the versioned binary name',
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

console.log('✅ python predictor detects versioned python3 binaries on PATH');
