import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(scriptDir, '..');
const cwd = process.cwd();
const candidateDirs = [
  path.resolve(cwd, 'test/e2e'),
  path.resolve(backendDir, 'test/e2e'),
];

const files = [];
const seen = new Set();

for (const dir of candidateDirs) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    continue;
  }

  const discovered = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => path.join(dir, f))
    .sort();

  for (const file of discovered) {
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }
}

if (!files.length) {
  console.warn('ℹ️ No E2E test scripts found.');
  process.exit(0);
}

let code = 0;
for (const f of files) {
  console.log(`\n--- ${path.basename(f)} ---`);
  if (!fs.existsSync(f)) {
    console.error(`❌ E2E script missing: ${f}`);
    if (code === 0) code = 1;
    continue;
  }

  const res = spawnSync('node', [f], { stdio: 'inherit' });
  if (typeof res.status === 'number' && res.status !== 0) {
    code = res.status;
  }
}

process.exit(code);
