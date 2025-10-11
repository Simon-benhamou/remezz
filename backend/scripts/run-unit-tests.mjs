import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverTestFiles } from './utils/discover-tests.mjs';

process.env.UNIT_TEST_MODE = 'true';

const { files, missing } = discoverTestFiles({
  cwd: process.cwd(),
  targets: [
    { path: 'test/unit' },
  ],
});

const missingRequired = missing.filter((entry) => !entry.target?.optional);
if (missingRequired.length) {
  for (const entry of missingRequired) {
    console.error('Unit tests directory not found:', entry.path);
  }
  process.exit(1);
}

if (!files.length) {
  console.log('ℹ️ No unit tests discovered.');
  process.exit(0);
}

console.log(`Running ${files.length} unit test files...`);
let code = 0;
for (const file of files) {
  console.log(`\n--- ${path.relative(process.cwd(), file)} ---`);
  const res = spawnSync('node', [file], { stdio: 'inherit' });
  if (res.status) code = res.status;
}

process.exit(code);
