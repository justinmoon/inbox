import fs from 'node:fs/promises';
import path from 'node:path';

import { parseChangeUnitBundle, type ChangeUnitBundle } from '../shared/changeUnitBundle.ts';

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const nextPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return await walk(nextPath);
      if (entry.isFile() && entry.name === 'change-unit.json') return [nextPath];
      return [];
    }),
  );
  return files.flat().sort();
}

export async function discoverBundleFiles(rootDir: string): Promise<string[]> {
  try {
    return await walk(rootDir);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function loadBundleFromPath(bundlePath: string): Promise<ChangeUnitBundle> {
  const raw = await fs.readFile(bundlePath, 'utf8');
  return parseChangeUnitBundle(JSON.parse(raw));
}
