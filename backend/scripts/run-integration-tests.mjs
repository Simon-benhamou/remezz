import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverTestFiles } from './utils/discover-tests.mjs';

process.env.UNIT_TEST_MODE = 'true';

const enableRemote = (process.env.QA_ENABLE_REMOTE || 'false') === 'true';
const remoteOnlyFiles = new Set([
  'qa-agent-lifecycle.mjs',
  'qa-market-validation.mjs',
]);
const targets = [
  {
    path: 'test/integration',
    label: 'Integration tests directory',
    filter: (filePath) => enableRemote || !remoteOnlyFiles.has(path.basename(filePath)),
  },
  { path: 'test', label: 'Root test directory', recursive: false },
];

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
for (const file of files) {
  console.log(`\n--- ${path.relative(process.cwd(), file)} ---`);
  const res = spawnSync('node', [file], { stdio: 'inherit' });
  if (res.status) code = res.status;
}

process.exit(code);
