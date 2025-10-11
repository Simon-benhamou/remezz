import { promises as fs } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const distRoot = join(projectRoot, 'dist');

const LINK_TARGETS = [
  { from: join(distRoot, 'src', 'ai'), to: join(distRoot, 'ai') },
  { from: join(distRoot, 'src', 'agent'), to: join(distRoot, 'agent') },
  { from: join(distRoot, 'src', 'db'), to: join(distRoot, 'db') },
  { from: join(distRoot, 'src', 'monitor'), to: join(distRoot, 'monitor') },
  { from: join(distRoot, 'src', 'services'), to: join(distRoot, 'services') },
  { from: join(distRoot, 'src', 'utils'), to: join(distRoot, 'utils') },
  { from: join(distRoot, 'src', 'ws'), to: join(distRoot, 'ws') },
];

async function ensureLink(target, linkPath) {
  try {
    const stats = await fs.lstat(linkPath).catch(() => null);
    if (stats?.isSymbolicLink()) {
      const existingTarget = await fs.readlink(linkPath);
      if (existingTarget === target || relative(linkPath, existingTarget) === relative(linkPath, target)) {
        return;
      }
    } else if (stats) {
      if (stats.isDirectory() && linkPath === target) {
        return;
      }
      await fs.rm(linkPath, { recursive: true, force: true });
    }

    await fs.symlink(target, linkPath, 'dir');
  } catch (error) {
    console.warn(`⚠️ Unable to create compatibility link ${linkPath} -> ${target}:`, error.message);
  }
}

async function main() {
  const distExists = await fs
    .stat(distRoot)
    .then((stat) => stat.isDirectory())
    .catch(() => false);

  if (!distExists) {
    return;
  }

  await Promise.all(
    LINK_TARGETS.map(async ({ from, to }) => {
      const sourceExists = await fs
        .stat(from)
        .then((stat) => stat.isDirectory())
        .catch(() => false);

      if (!sourceExists) {
        return;
      }

      await ensureLink(from, to);
    }),
  );
}

await main();
