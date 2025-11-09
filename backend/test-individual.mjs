#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const testDir = './test/unit';
const files = readdirSync(testDir)
  .filter(f => f.endsWith('.mjs'))
  .sort();

console.log(`Found ${files.length} test files`);

let count = 0;
for (const file of files) {
  count++;
  const filePath = join(testDir, file);
  console.log(`\n[${count}/${files.length}] Testing: ${file}`);
  
  const child = spawn('node', [filePath], {
    stdio: 'inherit',
    timeout: 15000 // 15 second timeout per test
  });
  
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`TIMEOUT after 15s: ${file}`));
      }, 15000);
      
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          console.log(`  ⚠️  Failed with code ${code}`);
        } else {
          console.log(`  ✓ Passed`);
        }
        resolve();
      });
      
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } catch (err) {
    console.error(`\n❌ BLOCKED/FAILED: ${file}`);
    console.error(`   ${err.message}`);
    console.log('\nStopping at problematic test.');
    process.exit(1);
  }
}

console.log('\n✓ All tests completed!');
