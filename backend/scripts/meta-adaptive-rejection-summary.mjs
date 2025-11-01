#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_PATH = path.resolve(__dirname, '../logs/ops_events.log');

async function main() {
  try {
    await fs.access(LOG_PATH);
  } catch {
    console.error('No ops_events.log found at', LOG_PATH);
    process.exit(1);
  }

  const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const reasonCounts = new Map();
  const checkCounts = new Map();
  let inspected = 0;
  let blockedTotal = 0;

  const rl = readline.createInterface({
    input: createReadStream(LOG_PATH, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line || !line.trim()) continue;
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }
    if (!payload || payload.message !== 'meta_entry_checklist') continue;
    const details = payload.details ?? {};
    const ts = typeof details.timestamp === 'number' ? details.timestamp : payload.ts;
    if (typeof ts !== 'number' || ts < sinceMs) continue;
    inspected += 1;
    if (details.decision !== 'blocked') continue;
    blockedTotal += 1;
    const blockedReason = typeof details.blockedReason === 'string' ? details.blockedReason : '';
    if (blockedReason) {
      blockedReason.split('|').filter(Boolean).forEach((reason) => {
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      });
    }
    const failedChecks = Array.isArray(details.failedChecks) ? details.failedChecks : [];
    failedChecks.forEach((check) => {
      checkCounts.set(check, (checkCounts.get(check) ?? 0) + 1);
    });
  }

  if (!inspected) {
    console.log('No checklist events found in the last 7 days.');
    process.exit(0);
  }

  console.log('Meta-Adaptive Rejections – last 7 days');
  console.log(`Events inspected: ${inspected}`);
  console.log(`Blocked trades: ${blockedTotal}`);

  const printTop = (title, map) => {
    console.log(`\n${title}`);
    if (!map.size) {
      console.log('  (none)');
      return;
    }
    const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [key, count] of sorted) {
      console.log(`  ${count.toString().padStart(4, ' ')}  ${key}`);
    }
  };

  printTop('Top blocked reasons', reasonCounts);
  printTop('Top failed checks', checkCounts);
}

main().catch((error) => {
  console.error('Failed to summarize rejections:', error);
  process.exit(1);
});
