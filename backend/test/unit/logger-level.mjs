import assert from 'node:assert/strict';

const capturedStdout = [];
const capturedStderr = [];
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function capture(write, store) {
  return function patched(chunk, encoding, callback) {
    const value = typeof chunk === 'string' ? chunk : chunk.toString();
    store.push(value);
    return write(chunk, encoding, callback);
  };
}

process.stdout.write = capture(originalStdoutWrite, capturedStdout);
process.stderr.write = capture(originalStderrWrite, capturedStderr);

try {
  const { configureLogging, createLogger, setLogLevel } = await import('../../dist/src/utils/logger.js');

  configureLogging('warn');

  console.log('this info log should be suppressed');
  console.info('another info log that should not appear');

  assert.equal(capturedStdout.length, 0, 'info logs must be suppressed at warn level');

  const scoped = createLogger('unit:logger');
  scoped.warn('important warning');

  assert.equal(capturedStderr.length, 1, 'warning should be emitted');
  assert.match(capturedStderr[0], /\[WARN\] \[unit:logger\] important warning/);

  capturedStdout.length = 0;
  capturedStderr.length = 0;

  setLogLevel('debug');
  console.log('debug log now visible');

  assert.ok(
    capturedStdout.some((line) => line.includes('debug log now visible')),
    'debug log should appear when level is debug',
  );

  capturedStdout.length = 0;
  setLogLevel('info');
  console.log('[BATCH] promoted log');

  assert.equal(
    capturedStdout.length,
    1,
    'batch log should be promoted to info despite originating from console.log',
  );
  assert.match(capturedStdout[0], /\[INFO\] .*\[BATCH\] promoted log/);
} finally {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
}
