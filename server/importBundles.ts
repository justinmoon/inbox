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

export async function loadBundlesFromRoots(rootDirs: string[]): Promise<ChangeUnitBundle[]> {
  const bundlesById = new Map<string, ChangeUnitBundle>();

  for (const rootDir of rootDirs) {
    for (const bundlePath of await discoverBundleFiles(rootDir)) {
      const bundle = await loadBundleFromPath(bundlePath);
      bundlesById.set(bundle.change_unit.id, bundle);
    }
  }

  return [...bundlesById.values()];
}

export async function persistImportedBundle(
  bundlePath: string,
  importedRoot: string,
): Promise<{ bundle: ChangeUnitBundle; targetPath: string }> {
  const bundle = await loadBundleFromPath(bundlePath);
  const targetDir = path.join(importedRoot, bundle.change_unit.id);
  const targetPath = path.join(targetDir, 'change-unit.json');

  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

  return { bundle, targetPath };
}

export async function clearImportedBundles(importedRoot: string) {
  await fs.rm(importedRoot, { recursive: true, force: true });
}
