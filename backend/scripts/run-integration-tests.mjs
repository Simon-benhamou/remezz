import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

process.env.UNIT_TEST_MODE = 'true';
const base = path.resolve(process.cwd(), 'test/integration');
const enableRemote = (process.env.QA_ENABLE_REMOTE || 'false') === 'true';
const files = [];

if (fs.existsSync(base)) {
  const discovered = fs
    .readdirSync(base)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => path.join(base, f))
    .sort();
  files.push(...discovered);
} else {
  console.warn(`⚠️ Integration tests directory missing: ${base}`);
}

if (enableRemote) {
  const remoteFiles = [
    path.join(base, 'qa-agent-lifecycle.mjs'),
    path.join(base, 'qa-market-validation.mjs'),
  ];
  for (const remote of remoteFiles) {
    if (fs.existsSync(remote)) {
      files.push(remote);
    } else {
      console.warn(`⚠️ Remote integration test missing: ${remote}`);
    }
  }
} else {
  console.log('ℹ️ QA remote integration tests skipped (set QA_ENABLE_REMOTE=true to enable)');
}

if (!files.length) {
  console.log('ℹ️ No integration tests discovered.');
  process.exit(0);
}

let code = 0;
for (const f of files) {
  console.log(`\n--- ${path.basename(f)} ---`);
  const res = spawnSync('node', [f], { stdio: 'inherit' });
  if (res.status) code = res.status;
}
process.exit(code);
