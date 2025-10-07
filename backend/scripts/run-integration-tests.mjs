import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

process.env.UNIT_TEST_MODE = 'true';
const base = path.resolve(process.cwd(), '../backend/test/integration');
const enableRemote = (process.env.QA_ENABLE_REMOTE || 'false') === 'true';
const files = [];

const prismaClientPath = path.resolve(process.cwd(), '../backend/dist/db/client.js');
if (fs.existsSync(prismaClientPath)) {
  files.push(path.join(base, 'agent-a2z.mjs'), path.join(base, 'dashboard-coherence.mjs'));
} else {
  console.warn('⚠️ Skipping agent-a2z/dashboard-coherence (dist/db/client.js missing)');
}

if (enableRemote) {
  files.push(
    path.join(base, 'qa-agent-lifecycle.mjs'),
    path.join(base, 'qa-market-validation.mjs'),
  );
} else {
  console.log('ℹ️ QA remote integration tests skipped (set QA_ENABLE_REMOTE=true to enable)');
}

let code = 0;
for (const f of files) {
  console.log(`\n--- ${path.basename(f)} ---`);
  const res = spawnSync('node', [f], { stdio: 'inherit' });
  if (res.status) code = res.status;
}
process.exit(code);
