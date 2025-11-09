import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverTestFiles } from './utils/discover-tests.mjs';

process.env.UNIT_TEST_MODE = 'true';
process.env.TS_NODE_TRANSPILE_ONLY = process.env.TS_NODE_TRANSPILE_ONLY || 'true';

const NODE_BIN = process.env.NODE_BINARY || 'node';
const NODE_LOADER = process.env.TS_NODE_LOADER || 'ts-node/esm';

const enableRemote = (process.env.QA_ENABLE_REMOTE || 'false') === 'true';
const remoteOnlyFiles = new Set([
  'qa-agent-lifecycle.mjs',
  'qa-market-validation.mjs',
]);
const includeLegacyRoot = (process.env.RUN_LEGACY_TESTS || '').toLowerCase() === 'true';

const targets = [
  {
    path: 'test/integration',
    label: 'Integration tests directory',
    filter: (filePath) => enableRemote || !remoteOnlyFiles.has(path.basename(filePath)),
  },
  {
    path: 'test/api',
    label: 'API tests directory',
    recursive: true,
    optional: true,
  },
];

if (includeLegacyRoot) {
  targets.push({ path: 'test', label: 'Legacy root test directory', recursive: false, optional: true });
} else {
  console.log('ℹ️ Legacy root scripts skipped (set RUN_LEGACY_TESTS=true to include diagnostic scripts).');
}

if (enableRemote) {
  targets.push(
    {
      path: 'test/integration/qa-agent-lifecycle.mjs',
      label: 'Remote integration test (qa-agent-lifecycle)',
      optional: true,
    },
    {
      path: 'test/integration/qa-market-validation.mjs',
      label: 'Remote integration test (qa-market-validation)',
      optional: true,
    },
  );
} else {
  console.log('ℹ️ QA remote integration tests skipped (set QA_ENABLE_REMOTE=true to enable)');
}

const { files, missing } = discoverTestFiles({
  cwd: process.cwd(),
  targets,
  extensions: ['.mjs', '.ts'],
});

for (const entry of missing) {
  const label = entry.target?.label || 'Test target';
  console.warn(`⚠️ ${label} missing: ${entry.path}`);
}

if (!files.length) {
  console.log('ℹ️ No integration tests discovered.');
  process.exit(0);
}

let code = 0;
const baseArgs = NODE_LOADER ? ['--loader', NODE_LOADER] : [];
for (const file of files) {
  console.log(`\n--- ${path.relative(process.cwd(), file)} ---`);
  const res = spawnSync(NODE_BIN, [...baseArgs, file], { 
    stdio: 'inherit',
    timeout: 60000, // 60 second timeout per test
    killSignal: 'SIGKILL'
  });
  
  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') {
      console.error(`\n⚠️  Test timed out after 60s: ${path.basename(file)}`);
      code = 1;
    } else {
      console.error(`\n❌ Test error: ${res.error.message}`);
      code = 1;
    }
  } else if (res.status) {
    code = res.status;
  }
}

process.exit(code);
