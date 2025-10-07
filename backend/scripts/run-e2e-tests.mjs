import { spawnSync } from 'node:child_process';
import path from 'node:path';

const base = path.resolve(process.cwd(), '../backend/test/e2e');
const files = [path.join(base, 'qa-ws-fault-injection.mjs')];

let code = 0;
for (const f of files) {
  console.log(`\n--- ${path.basename(f)} ---`);
  const res = spawnSync('node', [f], { stdio: 'inherit' });
  if (res.status) code = res.status;
}
process.exit(code);
