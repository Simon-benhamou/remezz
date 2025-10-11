import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const base = path.resolve(process.cwd(), '../backend/test/e2e');
const candidates = [path.join(base, 'qa-ws-fault-injection.mjs')];
const files = candidates.filter((file) => {
  if (fs.existsSync(file)) {
    return true;
  }
  console.warn(`⚠️ E2E test missing: ${file}`);
  return false;
});

if (!files.length) {
  console.log('ℹ️ No end-to-end tests to run.');
  process.exit(0);
}

let code = 0;
for (const f of files) {
  console.log(`\n--- ${path.basename(f)} ---`);
  const res = spawnSync('node', [f], { stdio: 'inherit' });
  if (res.status) code = res.status;
}
process.exit(code);
