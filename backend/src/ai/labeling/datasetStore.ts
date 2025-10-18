import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { LabeledRow } from './tripleBarrier.js';

export interface DatasetStoreOptions {
  path: string;
}

export class DatasetStore {
  private readonly path: string;

  constructor(options: DatasetStoreOptions) {
    this.path = options.path;
  }

  async append(rows: LabeledRow[]): Promise<void> {
    if (!rows.length) return;
    const dir = dirname(this.path);
    await fs.mkdir(dir, { recursive: true });
    const lines = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    await fs.appendFile(this.path, lines, 'utf8');
  }

  async *read(): AsyncGenerator<LabeledRow> {
    try {
      const content = await fs.readFile(this.path, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        const parsed = JSON.parse(line) as LabeledRow;
        yield parsed;
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}
