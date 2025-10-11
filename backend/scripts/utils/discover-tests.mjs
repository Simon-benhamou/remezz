import fs from 'node:fs';
import path from 'node:path';

function includeFile(filePath, ctx) {
  if (!ctx.extensions.includes(path.extname(filePath))) {
    return;
  }
  if (ctx.filter && !ctx.filter(filePath)) {
    return;
  }
  if (ctx.seen.has(filePath)) {
    return;
  }
  ctx.seen.add(filePath);
  ctx.files.push(filePath);
}

function collectFromDirectory(dir, options) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!options.recursive) {
        continue;
      }
      if (options.exclude?.includes(entry.name)) {
        continue;
      }
      collectFromDirectory(entryPath, options);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    includeFile(entryPath, options);
  }
}

export function discoverTestFiles({
  cwd = process.cwd(),
  targets = [],
  extensions = ['.mjs'],
} = {}) {
  const seen = new Set();
  const files = [];
  const missing = [];

  for (const target of targets) {
    if (!target?.path) {
      continue;
    }
    const resolvedPath = path.resolve(cwd, target.path);
    if (!fs.existsSync(resolvedPath)) {
      missing.push({ path: resolvedPath, target });
      continue;
    }

    const stats = fs.statSync(resolvedPath);
    const filter = target.filter ?? null;
    const recursive = target.recursive ?? false;
    const exclude = target.exclude ?? null;

    if (stats.isDirectory()) {
      collectFromDirectory(resolvedPath, {
        files,
        seen,
        extensions,
        filter,
        recursive,
        exclude,
      });
      continue;
    }

    if (stats.isFile()) {
      includeFile(resolvedPath, { files, seen, extensions, filter });
    }
  }

  files.sort();
  return { files, missing };
}
