import fs from 'node:fs/promises';
import path from 'node:path';

import { parseChangeUnitBundle, type ChangeUnitBundle } from '../shared/changeUnitBundle.ts';

export type LoadedBundle = {
  bundle: ChangeUnitBundle;
  bundlePath: string;
};

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

export async function loadBundleFromPath(bundlePath: string): Promise<LoadedBundle> {
  const raw = await fs.readFile(bundlePath, 'utf8');
  return {
    bundle: parseChangeUnitBundle(JSON.parse(raw)),
    bundlePath,
  };
}

export async function loadBundlesFromRoots(rootDirs: string[]): Promise<LoadedBundle[]> {
  const bundlesById = new Map<string, LoadedBundle>();

  for (const rootDir of rootDirs) {
    for (const bundlePath of await discoverBundleFiles(rootDir)) {
      const bundle = await loadBundleFromPath(bundlePath);
      bundlesById.set(bundle.bundle.change_unit.id, bundle);
    }
  }

  return [...bundlesById.values()];
}

async function copySessionCaptureFiles(bundle: ChangeUnitBundle, sourceBundlePath: string, targetDir: string) {
  const sourceDir = path.dirname(sourceBundlePath);

  for (const session of bundle.agent_sessions) {
    if (session.thread_capture?.kind !== 'rollout_path') continue;
    if (path.isAbsolute(session.thread_capture.path)) continue;

    const sourcePath = path.resolve(sourceDir, session.thread_capture.path);
    const targetPath = path.resolve(targetDir, session.thread_capture.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
}

export async function persistImportedBundle(
  bundlePath: string,
  importedRoot: string,
): Promise<{ bundle: ChangeUnitBundle; targetPath: string }> {
  const loaded = await loadBundleFromPath(bundlePath);
  const bundle = loaded.bundle;
  const targetDir = path.join(importedRoot, bundle.change_unit.id);
  const targetPath = path.join(targetDir, 'change-unit.json');

  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  await copySessionCaptureFiles(bundle, loaded.bundlePath, targetDir);
  await fs.writeFile(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

  return { bundle, targetPath };
}

export async function clearImportedBundles(importedRoot: string) {
  await fs.rm(importedRoot, { recursive: true, force: true });
}
