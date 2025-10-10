#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendRoot, '..');
const outputDir = path.join(repoRoot, 'docs', 'strategies');

const agentArg = process.argv.find(arg => arg.startsWith('--agents='));
const agents = agentArg
  ? agentArg.split('=')[1].split(',').map(id => id.trim()).filter(Boolean)
  : ['A0', 'A3', 'A8'];

const timestamp = new Date().toISOString();

async function ensureOutputDir() {
  await fs.mkdir(outputDir, { recursive: true });
}

async function loadPrisma() {
  try {
    const module = await import('../dist/src/db/client.js');
    if (!module?.prisma) {
      throw new Error('Prisma client not found in dist/src/db/client.js – run `npm run build` first.');
    }
    return module.prisma;
  } catch (err) {
    throw new Error(`Failed to load Prisma client from dist: ${err?.message || err}`);
  }
}

async function snapshotAgentPlan(prisma, agentId) {
  const session = await prisma.agentSession.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      symbol: true,
      mode: true,
      startedAt: true,
      stoppedAt: true,
      planJson: true,
    },
  });

  const output = {
    agentId,
    snapshotAt: timestamp,
    found: !!session,
    symbol: session?.symbol ?? null,
    mode: session?.mode ?? null,
    startedAt: session?.startedAt ?? null,
    stoppedAt: session?.stoppedAt ?? null,
    plan: session?.planJson ?? null,
    warning: !session ? 'Agent session not found – ensure DATABASE_URL points to the production database.' : undefined,
  };

  const filePath = path.join(outputDir, `${agentId}-plan.json`);
  await fs.writeFile(filePath, JSON.stringify(output, null, 2));
  return { filePath, found: output.found };
}

async function main() {
  await ensureOutputDir();
  const prisma = await loadPrisma();
  try {
    const results = [];
    for (const agentId of agents) {
      const res = await snapshotAgentPlan(prisma, agentId);
      results.push(res);
      if (!res.found) {
        console.warn(`⚠️  Agent ${agentId} not found – wrote placeholder snapshot to ${res.filePath}`);
      } else {
        console.log(`✅ Snapshot saved for agent ${agentId} → ${res.filePath}`);
      }
    }
    await prisma.$disconnect?.();
    return results;
  } catch (err) {
    await prisma.$disconnect?.().catch(() => {});
    throw err;
  }
}

main().catch(err => {
  console.error('Failed to snapshot agent plans:', err);
  process.exit(1);
});
