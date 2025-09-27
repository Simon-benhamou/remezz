import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(process.cwd());
const testsDir = path.resolve(root, '../backend/test/unit');

if (!fs.existsSync(testsDir)) {
  console.error('Unit tests directory not found:', testsDir);
  process.exit(1);
}

const files = fs.readdirSync(testsDir)
  .filter(f => f.endsWith('.mjs'))
  .sort();

console.log(`Running ${files.length} unit test files...`);
let code = 0;
for (const f of files) {
  console.log(`\n--- ${f} ---`);
  const res = spawnSync('node', [path.join(testsDir, f)], { stdio: 'inherit' });
  if (res.status) code = res.status;
}

process.exit(code);

