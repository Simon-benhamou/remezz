import { spawnSync } from 'node:child_process';
import path from 'node:path';

process.env.UNIT_TEST_MODE = 'true';
const base = path.resolve(process.cwd(), '../backend/test/integration');
const files = [
  path.join(base, 'agent-a2z.mjs'),
  path.join(base, 'dashboard-coherence.mjs'),
];

let code = 0;
for (const f of files) {
  console.log(`\n--- ${path.basename(f)} ---`);
  const res = spawnSync('node', [f], { stdio: 'inherit' });
  if (res.status) code = res.status;
}
process.exit(code);

