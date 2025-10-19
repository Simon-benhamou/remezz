import fs from 'node:fs/promises';
import path from 'node:path';

import { computeFeeSummary, summarizeFeeImpact } from '../src/analytics/feeAnalyzer.js';

async function main() {
  const [, , inputPath, feeBpsArg] = process.argv;

  if (!inputPath) {
    console.error('Usage: tsx scripts/analyze-fees.ts <orders.json> [feeBps]');
    process.exit(1);
  }

  const resolvedPath = path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
  const raw = await fs.readFile(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw);

  const orders = Array.isArray(parsed) ? parsed : Array.isArray(parsed.orders) ? parsed.orders : [];
  if (!orders.length) {
    console.error('No orders found in input payload. Expecting an array or an object with an "orders" array.');
    process.exit(1);
  }

  const feeBps = feeBpsArg ?? '4';
  const summary = computeFeeSummary(orders, feeBps);
  const formatted = summarizeFeeImpact(summary);

  console.log('📊 Fee analysis summary');
  console.log(JSON.stringify(formatted, null, 2));
}

main().catch((error) => {
  console.error('Fee analysis failed:', error);
  process.exit(1);
});
