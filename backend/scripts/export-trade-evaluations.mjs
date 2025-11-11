import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { prisma } from '../dist/src/db/client.js';

(async function() {
  try {
    const now = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = path.resolve(process.cwd(), 'data', 'backups');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `trade-evaluations-backup-${now}.json`);

    console.log('Exporting all TradeEvaluation records to', outPath);

    const all = await prisma.tradeEvaluation.findMany({});
    fs.writeFileSync(outPath, JSON.stringify(all, null, 2));

    console.log(`✅ Exported ${all.length} records to ${outPath}`);
  } catch (err) {
    console.error('❌ Export failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
